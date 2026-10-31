const mediaRegistry = require('@animastor/generation').mediaRegistry;
// ======================================================
// Runtime Scheduler - v1.0.0
// ======================================================
// The ONLY authority for scene lifecycle progression.
// Decides WHEN to start stages, NOT HOW.
// Callbacks only register results - scheduler owns progression.

const { lazyHostBinding } = require('../host/host-bindings');
// §32.30: former host requires resolve lazily through the host-bindings seam.
const state = lazyHostBinding('state');
const dispatchEngine = require('./dispatch-engine');
// S-5: orchestration-owned behavior reaches runtime only via the injected seams
const orchestrationSeams = lazyHostBinding('seams');
// O-5: progress events (selective-task reads + completion reconciliation)
// arrive ONLY through the ProgressEventsPort (host adapter:
// storage/progress-events-adapter) — the Redis task-registry host service
// (../services/generation-progress) left this file.
const progressEventsOp = require('./progress-events-port').progressEventsOp;
// O-2: persistence arrives ONLY through the PersistencePort (host adapter:
// storage/runtime-persistence-adapter) — no PG repository or database
// handles in the runtime tier.
const persist = require('./persistence-port').persist;
// Generation only by explicit command: the single authority for "which
// scene×stage may be scheduled" (task registry ∧ layer enabled ∧ not cancelled).
const commandGate = require('./command-gate');

const logPrefix = '[SCHEDULER]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`);
}

function error(msg) {
    console.error(`${logPrefix} ❌ ${msg}`);
}

// ======================================================
// HELPERS
// ======================================================

/**
 * Read layer config for a book (owned by ./command-gate, re-exported here).
 */
async function getLayerConfig(redis, bookId) {
    return commandGate.getLayerConfig(redis, bookId);
}

/**
 * Check if scene chunks have images marked as ready on disk.
 * Used when image worker is disabled but video needs to verify images exist.
 */
async function checkChunksHaveImages(redis, bookId, chapterId, sceneId) {
    const chunkPrefix = `animastor:chunk:${bookId}_${chapterId}_${sceneId}_`;
    let cursor = '0';
    let hasImages = false;
    do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${chunkPrefix}*`, 'COUNT', 50);
        cursor = nextCursor;
        for (const key of keys) {
            const raw = await redis.get(key);
            if (raw) {
                try {
                    const ch = JSON.parse(raw);
                    if (ch.image === true && ch.image_status === 'ready') {
                        hasImages = true;
                        break;
                    }
                } catch (_) {}
            }
        }
    } while (cursor !== '0' && !hasImages);
    return hasImages;
}

// ======================================================
// CONFIGURATION
// ======================================================

const SCHEDULER_TICK_MS = 5000; // 5 seconds

// ======================================================
// ACTIVE SCENE INDEX — T8: де-дубликация
// ======================================================
// T8: runtime-scheduler больше НЕ владеет своим API active-scenes.
// Все операции делегируются в active-scenes-index.js — единственный command API.
// addSceneToActiveIndex/removeSceneToActiveIndex оставлены как обёртки для
// обратной совместимости. Новый код должен использовать activeScenes API напрямую.

const activeScenes = require('./active-scenes-index');
const ACTIVE_SCENES_KEY = activeScenes.ACTIVE_SCENES_KEY;

/**
 * Add scene to active index. T8: делегирует в active-scenes-index.js, which
 * is command-gated: without an authorized stage the scene is NOT added.
 */
async function addSceneToActiveIndex(redis, bookId, chapterId, sceneId) {
    const result = await activeScenes.addActiveScene(redis, bookId, chapterId, sceneId);
    if (result.added) {
        log(`+ ACTIVE: ${result.sceneKey} added to active index`);
    }
    return result;
}

/**
 * Remove scene from active index. T8: делегирует в active-scenes-index.js.
 */
async function removeSceneFromActiveIndex(redis, bookId, chapterId, sceneId) {
    const result = await activeScenes.removeActiveScene(redis, bookId, chapterId, sceneId);
    if (result.removed) {
        log(`- ACTIVE: ${result.sceneKey} removed from active index`);
    }
    return result;
}

// M4 (Н.9): removed dead concurrent counter functions — dispatchEngine owns quotas

// ======================================================
// STATE TO STAGE MAPPING
// ======================================================

// Re-export SceneState for convenience
// S-2: stage mappings derived from registry (lazy getters — resolved on
// first access so module load order can never observe an empty registry)
const STATE_TO_STAGE = new Proxy({}, {
    get(_, key) { return mediaRegistry.getMediaType(String(key).replace(/_pending$/, '')) ? String(key).replace(/_pending$/, '') : undefined; },
    ownKeys() { return mediaRegistry.listMediaTypes().map(t => `${t}_pending`); },
});

const STAGE_TO_STATE = new Proxy({}, {
    get(_, stage) { return mediaRegistry.hasMediaType(String(stage)) ? `${stage}_pending` : undefined; },
    ownKeys() { return mediaRegistry.listMediaTypes(); },
});

// ======================================================
// SCHEDULER API
// ======================================================

/**
 * Get list of all active scenes from the index.
 */
async function getActiveSceneKeys(redis) {
    return await redis.smembers(ACTIVE_SCENES_KEY);
}

/**
 * Remove all active scenes belonging to a specific book.
 * Used when cancelling generation for a book.
 */
async function clearBookFromActiveIndex(redis, bookId) {
    const activeKeys = await getActiveSceneKeys(redis);
    let removed = 0;
    for (const sceneKey of activeKeys) {
        if (sceneKey.startsWith(`${bookId}:`)) {
            await redis.srem(ACTIVE_SCENES_KEY, sceneKey);
            removed++;
        }
    }
    if (removed > 0) {
        log(`CANCEL: removed ${removed} active scenes for book ${bookId}`);
    }
    return removed;
}

/**
 * Remove specific scenes from the active index.
 * Used by regenerate to only remove dirty scenes, preserving other scenes'
 * active index entries so the scheduler continues processing them.
 *
 * @param {Array<{chapter_id:string,scene_id:string}>} scenes - scenes to remove
 */
async function removeScenesFromActiveIndex(redis, bookId, scenes) {
    if (!scenes || scenes.length === 0) return 0;
    let removed = 0;
    for (const s of scenes) {
        const sceneKey = `${bookId}:${s.chapter_id}:${s.scene_id}`;
        const result = await redis.srem(ACTIVE_SCENES_KEY, sceneKey);
        if (result > 0) removed++;
    }
    if (removed > 0) {
        log(`REMOVED: removed ${removed} specific scenes from active index for book ${bookId}`);
    }
    return removed;
}

/**
 * Parse scene key to extract bookId, chapterId, sceneId.
 */
function parseSceneKey(sceneKey) {
    const parts = sceneKey.split(':');
    if (parts.length !== 3) {
        return null;
    }
    return {
        bookId: parts[0],
        chapterId: parts[1],
        sceneId: parts[2]
    };
}

/**
 * Determine which asset stages need scheduling for a scene.
 * Uses per-asset states as source of truth.
 * Each worker is independent:
 *   - Audio: dispatches if enabled and not ready
 *   - Image: dispatches if enabled and not ready (independent of audio)
 *   - Video: dispatches if enabled, not ready, and image=ready
 *
 * Returns { stages: string[], allDone: boolean }
 */
/**
 * Д.2: Detect PG version-staleness — PURE READ, no writes.
 *
 * R4.2: If asset_version < scene_version in PG, the scene needs regeneration
 * even if Redis per-asset states show it as 'ready' (e.g. Redis was flushed or
 * the version bump happened while Redis was offline). PG is the source of truth
 * for dirty detection; Redis per-asset states are only a runtime cache.
 *
 * @returns {Promise<boolean>} true if any 'ready' asset row is version-stale
 */
async function detectVersionStale(redis, bookId, chapterId, sceneId) {
    try {
        // O-2: scenes-table version read via the PersistencePort (host SQL:
        // storage/runtime-persistence-adapter.getAudioConfigVersions — the
        // pre-O-2 raw query moved there verbatim).
        const verResult = await persist('sceneVersions.getAudioConfigVersions')(bookId, chapterId, sceneId);

        for (const row of verResult) {
            if (row.asset_status === 'ready') {
                if (row.scene_content_version != null && row.content_version != null &&
                    row.scene_content_version < row.content_version) {
                    log(`[VERSION-DIRTY] ${bookId}/${chapterId}/${sceneId}: content_version stale (asset=${row.scene_content_version} < scene=${row.content_version})`);
                    return true;
                }
                if (row.scene_audio_config_version != null && row.audio_config_version != null &&
                    row.scene_audio_config_version < row.audio_config_version) {
                    log(`[VERSION-DIRTY] ${bookId}/${chapterId}/${sceneId}: audio_config_version stale (asset=${row.scene_audio_config_version} < scene=${row.audio_config_version})`);
                    return true;
                }
            }
        }
    } catch (err) {
        // PG query failed — fall back to Redis-only detection (no stale signal)
        warn(`[VERSION-DIRTY] PG version check failed for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
    }
    return false;
}

/**
 * Д.2: Apply the version-stale reset — the explicit WRITE pass.
 *
 * Resets enabled READY assets to DIRTY so the dispatch engine picks them up.
 * Separated from detection so shouldScheduleAssets stays pure (P3 in the
 * state-writers map). Returns the number of assets reset.
 */
async function markVersionStaleDirty(redis, bookId, chapterId, sceneId) {
    // Command-only generation: this pass only MARKS stale assets (READY →
    // DIRTY + PG stale via markDirtyScene). It never queues work and never
    // touches the active index — whether a DIRTY stage is dispatched is
    // decided solely by the command gate in shouldScheduleAssets. Disabled
    // layers are left untouched.
    const layerCfg = await getLayerConfig(redis, bookId);
    const assetStates = await state.getAssetStates(redis, bookId, chapterId, sceneId);

    log(`[VERSION-DIRTY] ${bookId}/${chapterId}/${sceneId}: PG version mismatch — marking READY assets stale (no scheduling)`);
    // T8: через фасад — единый владелец DIRTY
    // S-5: asset-state writer via the injected orchestration seam
    const markDirtyScene = orchestrationSeams.getOrchestrationSeam('markDirtyScene');
    const dirtyAssets = mediaRegistry.listMediaTypes().filter(stage =>
        commandGate.isLayerEnabled(layerCfg, stage) &&
        assetStates[stage] === state.AssetState.READY
    );
    if (dirtyAssets.length > 0) {
        await markDirtyScene(redis, bookId, chapterId, sceneId, dirtyAssets);
    }
    return dirtyAssets.length;
}

async function shouldScheduleAssets(redis, bookId, chapterId, sceneId, gateCache = null) {
    // Д.2: This function is now PURE — it only reads per-asset states and layer
    // config and computes { stages, allDone }. It performs NO writes. The former
    // version-stale READY→DIRTY reset is an explicit pre-pass in attemptDispatch
    // (detectVersionStale + markVersionStaleDirty), so the decision is separated
    // from the mutation (single arbiter — see docs/STATE_WRITERS_MAP.md P3).
    const assetStates = await state.getAssetStates(redis, bookId, chapterId, sceneId);

    // Generation only by explicit command (command-gate): a stage is
    // schedulable ONLY when an active task-registry task of that stage targets
    // this scene, its layer is enabled and the book is not cancelled. There is
    // NO fallback to book-wide layer preferences and NO in-flight override
    // (formerly PENDING/GENERATING kept a disabled layer dispatching —
    // incident 2026-10-30 BA). A scene without any authorized stage reports
    // allDone and leaves the active index.
    const auth = await commandGate.getAuthorizedStages(redis, bookId, chapterId, sceneId, gateCache);
    const audioEnabled = auth.stages.has('audio');
    const imageEnabled = auth.stages.has('image');
    const videoEnabled = auth.stages.has('video');
    if (auth.stages.size === 0) {
        log(`GATE: ${bookId}:${chapterId}:${sceneId} has no command-authorized stage (${commandGate.describeDenied(auth.denied)})`);
    }

    // Check if all enabled assets are in terminal states
    // (after potential version-stale reset above)
    const allDone = (
        (!audioEnabled || assetStates.audio === state.AssetState.READY || assetStates.audio === state.AssetState.FAILED) &&
        (!imageEnabled || assetStates.image === state.AssetState.READY || assetStates.image === state.AssetState.FAILED) &&
        (!videoEnabled || assetStates.video === state.AssetState.READY || assetStates.video === state.AssetState.FAILED)
    );
    if (allDone) return { stages: [], allDone: true };

    const stages = [];

    // Audio: independent — dispatch if not ready and not already generating
    if (audioEnabled &&
        assetStates.audio !== state.AssetState.READY &&
        assetStates.audio !== state.AssetState.FAILED &&
        assetStates.audio !== state.AssetState.GENERATING &&
        assetStates.audio !== state.AssetState.PLACEHOLDER) {
        stages.push('audio');
    }

    // Image: independent of audio — dispatch if not ready and not already generating
    if (imageEnabled &&
        assetStates.image !== state.AssetState.READY &&
        assetStates.image !== state.AssetState.FAILED &&
        assetStates.image !== state.AssetState.GENERATING) {
        stages.push('image');
    }

    // Video: requires image=ready — if images aren't ready, skip silently
    if (videoEnabled &&
        assetStates.video !== state.AssetState.READY &&
        assetStates.video !== state.AssetState.FAILED &&
        assetStates.video !== state.AssetState.GENERATING) {
        let imageReady = assetStates.image === state.AssetState.READY;
        if (!imageReady && !imageEnabled) {
            imageReady = await checkChunksHaveImages(redis, bookId, chapterId, sceneId);
        }
        if (imageReady) {
            stages.push('video');
        }
    }

    return { stages, allDone };
}

/**
 * Process all active scenes.
 * Returns summary of operations.
 */
async function tick(redis, loadedBooks = {}) {
    log('=== RUNTIME SCHEDULER TICK ===');

    // Acquire tick lock for single-flight protection
    const tickLock = await dispatchEngine.acquireSchedulerTickLock(redis);
    if (!tickLock.acquired) {
        log('TICK_SKIPPED: Another tick is still running');
        return {
            skipped: true,
            reason: 'tick_running',
            timestamp: new Date().toISOString()
        };
    }

    // T6.5: Все тело tick обёрнуто в try/finally для гарантированного
    // освобождения lock даже при исключении (не только в per-scene catch).
    try {
        const activeKeys = await getActiveSceneKeys(redis);
        const summary = {
            totalActive: activeKeys.length,
            processed: 0,
            dispatched: 0,
            throttled: 0,
            skipped: 0,
            completed: 0,
            deferred: 0,
            errors: []
        };

        const activeBookIds = new Set();
        for (const sceneKey of activeKeys) {
            const parsed = parseSceneKey(sceneKey);
            if (parsed) activeBookIds.add(parsed.bookId);
        }
        for (const bookId of activeBookIds) {
            const completedTasks = await progressEventsOp('reconcileCompletedTasks')(
                redis,
                bookId,
                state.getAssetStates
            );
            for (const task of completedTasks) {
                try {
                    await persist('tasks.updateTaskStatus')(task.task_id, 'completed');
                } catch (pgErr) {
                    warn(`TASK_COMPLETE_PERSIST_FAILED: ${task.task_id}: ${pgErr.message}`);
                }
            }
        }

        // Force set per book: ONLY the scene×stage pairs reset by an explicit
        // regeneration (command-gate force set) — never the whole book.
        const forceCache = new Map();
        // One command-gate memo per tick (layer config / cancellation per book).
        const gateCache = commandGate.createGateCache();
        // Cache loaded books per tick to avoid redundant disk reads
        const bookCache = new Map();

        for (const sceneKey of activeKeys) {
            const parsed = parseSceneKey(sceneKey);
            if (!parsed) {
                summary.errors.push(`Invalid scene key: ${sceneKey}`);
                continue;
            }

            const { bookId, chapterId, sceneId } = parsed;

            // Force applies only to the scene×stage pairs of the command.
            let bookForce = forceCache.get(bookId);
            if (!bookForce) {
                bookForce = await commandGate.getForceStages(redis, bookId);
                forceCache.set(bookId, bookForce);
            }
            const force = commandGate.forcedStagesForScene(bookForce, chapterId, sceneId);

            // Resolve loaded book from cache or load it
            let sceneLoadedBook = loadedBooks[bookId];
            if (!sceneLoadedBook) {
                if (bookCache.has(bookId)) {
                    sceneLoadedBook = bookCache.get(bookId);
                } else {
                    try {
                        // O-3: scene content via the SceneDataPort (host
                        // adapter: storage/scene-data-adapter) — the Book
                        // Model facade require left the scheduler.
                        sceneLoadedBook = require('./scene-data-port').sceneDataOp('loadBook')(bookId);
                        bookCache.set(bookId, sceneLoadedBook);
                    } catch (_) {
                        sceneLoadedBook = null;
                    }
                }
            }

            try {
                const result = await attemptDispatch(redis, bookId, chapterId, sceneId, sceneLoadedBook, force, gateCache);
                summary.processed++;

                if (result.completed) {
                    summary.completed++;
                } else if (result.dispatched && result.dispatched > 0) {
                    summary.dispatched += result.dispatched;
                    if (result.throttled > 0) summary.throttled += result.throttled;
                } else if (result.skip) {
                    summary.skipped++;
                } else if (result.throttled > 0) {
                    summary.throttled += result.throttled;
                } else if (result.deferred > 0) {
                    // Stage 118 (M9): a bounded deferral is a normal, quiet
                    // state — it must not pollute the tick error list.
                    summary.deferred += result.deferred;
                } else if (result.reason === 'backpressure' || result.reason === 'throttled') {
                    summary.throttled++;
                } else if (result.success) {
                    // No action needed
                } else {
                    summary.errors.push(`${result.reason} for ${sceneKey}`);
                }
            } catch (err) {
                summary.errors.push(`Error processing ${sceneKey}: ${err.message}`);
                error(`Tick error for ${sceneKey}: ${err.message}`);
            }
        }

        log(`=== TICK COMPLETE ===`);
        log(`Active: ${summary.totalActive}, Dispatched: ${summary.dispatched}, Skipped: ${summary.skipped}, Throttled: ${summary.throttled}, Completed: ${summary.completed}, Deferred: ${summary.deferred}`);

        if (summary.errors.length > 0) {
            log(`Errors: ${summary.errors.length}`);
            summary.errors.slice(0, 5).forEach(e => log(`  - ${e}`));
        }

        return summary;
    } finally {
        // T6.5: Гарантированное освобождение lock в finally.
        // Если исключение вылетело за пределы per-scene catch (напр. getActiveSceneKeys),
        // lock должен быть отпущен, чтобы scheduler не завис навсегда.
        try {
            await dispatchEngine.releaseSchedulerTickLock(redis, tickLock.token);
        } catch (lockErr) {
            error(`TICK_LOCK_RELEASE_FAILED: ${lockErr.message}`);
        }
    }
}

/**
 * Get runtime metrics for debugging.
 */
async function getMetrics(redis) {
    const activeCount = await redis.scard(ACTIVE_SCENES_KEY);
    
    // M4 (Н.9): quotas are owned by dispatchEngine — delegate to getQuotaStatus
    let quotaStatus = { audio: { current: 0, max: 0 }, image: { current: 0, max: 0 }, video: { current: 0, max: 0 } };
    try {
        quotaStatus = await dispatchEngine.getQuotaStatus(redis);
    } catch (e) {
        warn(`getMetrics: dispatchEngine.getQuotaStatus failed: ${e.message}`);
    }

    return {
        activeScenes: activeCount,
        concurrent: {
            audio: quotaStatus.audio.current,
            image: quotaStatus.image.current,
            video: quotaStatus.video.current
        },
        limits: {
            audio: quotaStatus.audio.max,
            image: quotaStatus.image.max,
            video: quotaStatus.video.max
        }
    };
}

// ======================================================
// ATTEMPT DISPATCH (NEW: Uses dispatch engine)
// ======================================================

/**
 * Attempt to dispatch scene stages using per-asset states.
 * Supports independent workers: dispatches ALL eligible stages in one tick.
 *
 * `force` — the stages of THIS scene whose existing lease is cleared before
 * dispatch: a Set/Array of stage names (the scheduler passes the command's
 * force set for the scene) or a boolean (true = every scheduled stage of this
 * one scene). Force never widens to other scenes or stages.
 *
 * A stage that reports `no_worker_available` is BLOCKED (command-gate
 * blockStageNoWorker): its task is marked blocked with «нет воркера <type>»
 * and it is never retried automatically.
 *
 * Returns { dispatched: number, completed: boolean, reason: string }
 */
async function attemptDispatch(redis, bookId, chapterId, sceneId, loadedBook, force = false, gateCache = null) {
    const sceneKey = `${bookId}:${chapterId}:${sceneId}`;

    // Resolve build_id from manifest (passed from tick with book cache) or null
    const buildId = loadedBook?.manifest?.build_id || null;

    // Д.2: Version-stale pre-pass — detect (pure read) then reset (explicit write)
    // BEFORE planning, so a stale 'ready' scene is re-dispatched in the SAME tick.
    // Keeps shouldScheduleAssets pure (decision separated from mutation).
    if (await detectVersionStale(redis, bookId, chapterId, sceneId)) {
        await markVersionStaleDirty(redis, bookId, chapterId, sceneId);
    }

    // Determine which asset stages need scheduling (from per-asset states)
    const { stages, allDone } = await shouldScheduleAssets(redis, bookId, chapterId, sceneId, gateCache);

    if (allDone) {
        await removeSceneFromActiveIndex(redis, bookId, chapterId, sceneId);
        log(`COMPLETE: ${sceneKey} (all assets ready) - removed from active index`);
        return { completed: true, reason: 'all_assets_ready' };
    }

    if (stages.length === 0) {
        // Assets are in non-dispatchable states (e.g., generating, placeholder)
        // or video skipped because images not ready
        return { success: true, skip: true, reason: 'no_dispatchable_stages' };
    }

    const forcedStages = force === true
        ? new Set(stages)
        : new Set(force instanceof Set ? force : (Array.isArray(force) ? force : []));
    const forcedList = stages.filter(s => forcedStages.has(s));
    log(`ATTEMPT_DISPATCH: ${sceneKey} -> stages=[${stages.join(', ')}]${forcedList.length ? ` (force=[${forcedList.join(', ')}])` : ''}`);

    let dispatched = 0;
    let throttled = 0;
    let anyCompleted = false;
    // Stage 118 (M9): bounded deferrals are counted separately — they are
    // neither a dispatch nor an error.
    let deferred = 0;
    const failures = [];

    // Dispatch ALL eligible stages in this tick.
    // Concurrency limits per stage type are handled by dispatch engine.
    for (const stage of stages) {
        const result = await dispatchEngine.dispatchStage(
            redis,
            bookId,
            chapterId,
            sceneId,
            stage,
            loadedBook,
            buildId,
            { force: forcedStages.has(stage) }
        );
        if (!result.dispatched && result.reason === 'no_worker_available') {
            // No live worker of this type: the command is blocked, the stage
            // loses its authorization — no retry on the next tick.
            await commandGate.blockStageNoWorker(redis, bookId, chapterId, sceneId, stage);
            failures.push(`${stage}:blocked_no_worker`);
            continue;
        }
        if (result.dispatched) {
            dispatched++;
        } else if (result.reason === 'backpressure' || result.reason === 'throttled') {
            throttled++;
        } else if (result.completed) {
            // Stage finished inside the executor (already_done / cache_hit /
            // no_segments) — not a failure, nothing to dispatch.
            anyCompleted = true;
        } else if (result.deferred) {
            // Stage 118 (M9): a bounded deferral is NOT an error — nothing
            // happened, the stage is waiting for capacity (or is already
            // idempotently complete). Reporting it as a failure filled the
            // tick summary with "errors" 12 times per minute per scene.
            deferred++;
        } else {
            // Stage 50: раньше per-stage отказ (circuit_open, retry budget,
            // lease, generating_transition_failed, …) молча проглатывался и
            // tick писал «undefined for <scene>» — ошибки исчезали из
            // observability. Теперь причина всплывает в tick-сводку.
            failures.push(`${stage}:${result.reason || 'unknown'}`);
        }
    }

    if (dispatched > 0) {
        return { dispatched, throttled, stages: stages.length };
    }
    if (deferred > 0 && failures.length === 0) {
        return { dispatched: 0, throttled, deferred, stages: stages.length, success: true, reason: 'deferred' };
    }
    if (failures.length > 0) {
        return { dispatched: 0, throttled, stages: stages.length, success: false, reason: failures.join(', ') };
    }
    if (anyCompleted) {
        return { dispatched: 0, throttled, completed: true, reason: 'stage_completed' };
    }
    return { dispatched: 0, throttled, stages: stages.length, success: true, reason: 'no_dispatch' };
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    // Configuration
    SCHEDULER_TICK_MS,

    // Active scene index
    ACTIVE_SCENES_KEY,
    addSceneToActiveIndex,
    removeSceneFromActiveIndex,
    clearBookFromActiveIndex,
    removeScenesFromActiveIndex,
    getActiveSceneKeys,
    parseSceneKey,

    // Scheduling
    shouldScheduleAssets,
    detectVersionStale,
    attemptDispatch,
    markVersionStaleDirty,
    getLayerConfig,
    checkChunksHaveImages,
    tick,
    getMetrics,

    // Re-exports
    get AssetState() { return state.AssetState; },
    STATE_TO_STAGE,
    STAGE_TO_STATE,

};
