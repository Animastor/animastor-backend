// ======================================================
// Book Generation Routes — Regenerate, Cancel, Generate Next
// ======================================================

const path = require('path');
const fs = require('fs');
const sceneAssetsRepo = require('../../storage/postgres/repositories/scene-assets-repo');
const generationProgress = require('../../services/generation-progress');
const dispatchEngine = require('@animastor/orchestration').runtime.dispatch;
const taskRepo = require('../../storage/postgres/repositories/task-repo');
const bookRepo = require('../../storage/postgres/repositories/book-repo');
const generationCancelRepo = require('../../storage/postgres/repositories/generation-cancel-repo');
// S-1 (Generation extraction seam): the ONLY VBook leg allowed in this
// generation route layer is the narrow AgentSessionControl port
// (VBook-owned — see services/agent-session-control.js). Raw
// agent_sessions/book_generation_sessions SQL must not live here.
const { createAgentSessionControl } = require('../../services/agent-session-control');
// S-2: media registry for worker-type validation
const mediaRegistry = require('@animastor/generation').mediaRegistry;
// Command-only generation: the gate (task registry ∧ layer ∧ no cancel) and
// the shared "stop this stage" routine (registry, leases, hub, index, PG).
// The shared stage-cancellation routine arrives through deps
// (deps.stageCancellation, composition root) — contour-route requires are frozen.
const commandGate = require('@animastor/orchestration').runtime.commandGate;

module.exports = function(app, redis, deps) {
    // Stage 116 (D4): queue-idempotency port (injected by the composition root
    // — the contour-route require sets are frozen).
    const { queueIdempotency } = deps;
    const {
        config, state, audio, image, video, book, orchestrator, storage,
        runtime,
        txtImporter, lazyBook, genSessionRepo, bookSourceRepo,
        placeholderAudio, layerConfig, activeScenes,
        utils, saveChunk, getChunk, getAllChunks, getBookWindowStatus,
        detectAvailableMode, recoverChunksFromDisk, recoverAllBooksFromDisk,
        cleanupService, bookDiff, taskHandler, windowGenerator,
        iuRepo, cleanBookRedisKeys,
        agentSessionControl,
    } = deps;
    const { log } = utils;

    const sessionControl = agentSessionControl || createAgentSessionControl();

    const cancelStage = (params) => {
        const impl = deps.stageCancellation;
        if (!impl || typeof impl.cancelStage !== 'function') {
            throw new Error('generation-routes: deps.stageCancellation is not wired (composition root)');
        }
        return impl.cancelStage(params);
    };
    const stageCancelDeps = () => ({
        generationProgress, taskRepo, sceneAssetsRepo, dispatchEngine,
        scheduler: runtime.scheduler, commandGate, config, log,
    });

    // ======================================================
    // GENERATE NEXT (slide window)
    // ======================================================
    app.post('/api/v1/book/:bookId/generate-next', async (req, res) => {
        try {
            const bookId = req.params.bookId;
            const loadedBook = book.loadBook(bookId);
            if (!loadedBook) return res.status(404).json({ error: 'book not found' });

            const ids = await getAllChunks(bookId);
            let buildId = loadedBook.manifest?.build_id || 'default';
            if (ids.length > 0) {
                const firstChunk = await getChunk(ids[0]);
                if (firstChunk?.build_id) buildId = firstChunk.build_id;
            }
            const result = await runtime.sceneWindow.slideWindow(redis, bookId, loadedBook, buildId);
            const newIds = await getAllChunks(bookId);
            res.json({ started: result.started, remaining: result.remaining, chunk_ids: newIds });
        } catch (err) {
            console.error('❌ GENERATE-NEXT ERROR:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // LAYER CONFIG (read / write) — defaults for initial/bulk generation
    // ======================================================
    app.get('/api/v1/book/:bookId/layer-config', async (req, res) => {
        try {
            const { bookId } = req.params;
            const cfg = await layerConfig.get(redis, bookId);
            res.json({
                book_id: bookId,
                audio_enabled: cfg.audio_enabled,
                image_enabled: cfg.image_enabled,
                video_enabled: cfg.video_enabled,
                chunk_size: cfg.chunk_size,
                audio_timeout_minutes: cfg.audio_timeout_minutes,
                image_timeout_minutes: cfg.image_timeout_minutes,
                video_timeout_minutes: cfg.video_timeout_minutes,
                // Parallel / Subagent AI Analysis (Milestone #1) — wire contract
                // must round-trip these so the Android (f661a922 web parity) /
                // web client can read back what it wrote and survive an
                // app-restart round-trip. Without this, the layer-config service
                // stores the value but the client always sees null and falls
                // back to sequential/default, so the chosen mode looks "lost"
                // after a process restart.
                analysis_mode: cfg.analysis_mode,
                analysis_parallelism: cfg.analysis_parallelism,
            });
        } catch (err) {
            console.error('[LAYER-CONFIG] GET error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    app.put('/api/v1/book/:bookId/layer-config', async (req, res) => {
        try {
            const { bookId } = req.params;
            const { audio_enabled, image_enabled, video_enabled, chunk_size, audio_timeout_minutes, image_timeout_minutes, video_timeout_minutes, analysis_mode, analysis_parallelism } = req.body || {};
            const cfg = await layerConfig.set(redis, bookId, {
                audio_enabled, image_enabled, video_enabled,
                chunk_size, audio_timeout_minutes, image_timeout_minutes, video_timeout_minutes,
                analysis_mode, analysis_parallelism,
            });
            log(`[LAYER-CONFIG] book=${bookId} → a=${cfg.audio_enabled} i=${cfg.image_enabled} v=${cfg.video_enabled} cs=${cfg.chunk_size} ato=${cfg.audio_timeout_minutes} ito=${cfg.image_timeout_minutes} vto=${cfg.video_timeout_minutes} am=${cfg.analysis_mode} ap=${cfg.analysis_parallelism}`);

            // Command-only generation: switching a layer OFF stops that stage
            // for the whole book — tasks, leases, hub copies, active index and
            // PG pending rows (a disabled layer must not keep running, incident
            // 2026-10-30 BA). Idempotent: repeating it is harmless.
            const cancelledStages = [];
            for (const stage of mediaRegistry.listMediaTypes()) {
                if ((req.body || {})[`${stage}_enabled`] !== false || cfg[`${stage}_enabled`] !== false) continue;
                try {
                    await cancelStage({
                        redis, bookId, stage, tasks: null, wholeBook: true,
                        reason: `layer_disabled:${stage}`, context: 'LAYER-CONFIG',
                        deps: stageCancelDeps(),
                    });
                    cancelledStages.push(stage);
                } catch (cancelErr) {
                    console.error(`[LAYER-CONFIG] ${bookId}: cancelling disabled stage ${stage} failed: ${cancelErr.message}`);
                }
            }

            res.json({
                book_id: bookId,
                audio_enabled: cfg.audio_enabled,
                image_enabled: cfg.image_enabled,
                video_enabled: cfg.video_enabled,
                chunk_size: cfg.chunk_size,
                audio_timeout_minutes: cfg.audio_timeout_minutes,
                image_timeout_minutes: cfg.image_timeout_minutes,
                video_timeout_minutes: cfg.video_timeout_minutes,
                analysis_mode: cfg.analysis_mode,
                analysis_parallelism: cfg.analysis_parallelism,
                cancelled_stages: cancelledStages,
            });
        } catch (err) {
            console.error('[LAYER-CONFIG] PUT error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // CANCEL WORKER (task-aware; type remains as bulk fallback)
    // ======================================================
    // A row-level stop sends task_id and cancels only that task's stage/scene
    // targets. A section-level stop sends type and cancels every active task of
    // that type. Other task ids, including the same worker type, stay intact.
    app.post('/api/v1/book/:bookId/cancel-worker', async (req, res) => {
        try {
            const { bookId } = req.params;
            const { type, task_id: taskId } = req.body || {};

            // S-2: valid cancel types derived from registry with fallback
            // S-2 COMPLETION: valid types always from registry (no hardcoded fallback)
            const cancelValidTypes = [...mediaRegistry.listMediaTypes(), 'cover', 'vbook'];
            if (!taskId && (!type || !cancelValidTypes.includes(type))) {
                return res.status(400).json({
                    error: 'Provide task_id or a worker type: audio, image, video, cover, vbook',
                });
            }

            let resolvedType = type;
            let tasks = [];
            if (taskId) {
                const task = await generationProgress.getTask(redis, bookId, taskId);
                if (!task) return res.status(404).json({ error: 'Generation task not found' });
                resolvedType = task.type;
                tasks = task.status === 'active' ? [task] : [];
            } else if (cancelValidTypes.includes(type) && type !== 'cover' && type !== 'vbook') {
                tasks = await generationProgress.getActiveTasksByType(redis, bookId, type);
            }

            log(`[CANCEL-WORKER] ${bookId}: cancelling type=${resolvedType} task=${taskId || 'all'}`);

            if (resolvedType === 'vbook') {
                // Cancel VBook/AI agent: VBook session cancellation goes
                // through the AgentSessionControl port (S-1) — the
                // agent_sessions status grammar stays VBook-owned.
                await redis.sadd(`animastor:cancelled-workers:${bookId}`, 'vbook');
                await redis.expire(`animastor:cancelled-workers:${bookId}`, 3600);
                try {
                    await sessionControl.cancelSessions(bookId);
                    log(`[CANCEL-WORKER] ${bookId}: VBook agent sessions cancelled`);
                } catch (pgErr) {
                    console.warn(`[CANCEL-WORKER] Failed to cancel VBook session: ${pgErr.message}`);
                }
                // Cathedral Recon #3 §5.4 option 1: also persist the cancellation
                // tombstone. startup-resume (C5) reads only book_generation_sessions,
                // which cancel-worker does NOT update — without the tombstone a
                // cancelled VBook would be auto-resumed after Redis loss.
                try {
                    await generationCancelRepo.setCancelled(bookId, { reason: 'user_cancelled', createdBy: 'cancel-worker:vbook' });
                    log(`[CANCEL-WORKER] ${bookId}: cancellation tombstone persisted (vbook)`);
                } catch (tombErr) {
                    console.warn(`[CANCEL-WORKER] Failed to persist cancellation tombstone for ${bookId}: ${tombErr.message}`);
                }
            } else if (resolvedType === 'cover') {
                // Cover uses both audio + image stages — cancel both
                await dispatchEngine.clearLeasesForBookByStage(redis, bookId, 'audio');
                await dispatchEngine.clearLeasesForBookByStage(redis, bookId, 'image');
                log(`[CANCEL-WORKER] ${bookId}: cover (audio+image) leases cleared`);
            } else {
                // Command-only generation: one routine stops the stage —
                // registry tasks, leases, hub copies, GENERATING ghosts,
                // active index and PG `pending` rows (→ cancelled). A row
                // stop (task_id) touches only that task's targets; a section
                // stop (type) stops the stage for the whole book.
                await cancelStage({
                    redis, bookId, stage: resolvedType,
                    tasks,
                    wholeBook: !taskId,
                    reason: taskId ? `cancel-worker:task:${taskId}` : `cancel-worker:${resolvedType}`,
                    context: 'CANCEL-WORKER',
                    deps: stageCancelDeps(),
                });
            }

            log(`[CANCEL-WORKER] ${bookId}: type=${resolvedType} cancelled successfully`);
            res.json({
                ok: true,
                book_id: bookId,
                cancelled: [resolvedType],
                task_ids: tasks.map(task => task.task_id),
            });
        } catch (err) {
            console.error('[CANCEL-WORKER] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // CANCEL GENERATION (global — stops everything)
    // ======================================================
    app.post('/api/v1/book/:bookId/cancel-generation', async (req, res) => {
        try {
            const { bookId } = req.params;
            log(`[CANCEL-GENERATION] ${bookId}: cancelling generation`);

            await runtime.sceneWindow.setCancelFlag(redis, bookId);

            // Cathedral Recon #3 §5.4 option 1: persistent cancellation tombstone.
            // Survives Redis loss so startup-resume / future work-list rebuild can
            // never resurrect an explicitly cancelled generation. Best-effort: a PG
            // failure must not block the Redis-side cancellation itself.
            try {
                await generationCancelRepo.setCancelled(bookId, { reason: 'user_cancelled', createdBy: 'cancel-generation' });
                log(`[CANCEL-GENERATION] ${bookId}: cancellation tombstone persisted`);
            } catch (tombErr) {
                console.warn(`[CANCEL-GENERATION] Failed to persist cancellation tombstone for ${bookId}: ${tombErr.message}`);
            }

            await runtime.scheduler.clearBookFromActiveIndex(redis, bookId);

            await redis.del('animastor:runtime:active-audio');
            await redis.del('animastor:runtime:active-image');
            await redis.del('animastor:runtime:active-video');

            await dispatchEngine.clearAllLeasesForBook(redis, bookId);

            // Orphan GENERATING sweep (audit d9d67a3): clearAllLeasesForBook
            // rolls back only lease-backed dispatches. A GENERATING state
            // whose dispatch/lease already died (crash/restart/TTL expiry)
            // would otherwise survive Stop All forever and keep synthesizing
            // a ghost progress row. Roll such orphans back through the
            // FSM-safe path GENERATING → DIRTY → PENDING. Live stages (lease/
            // dispatch-meta/in-flight marker present) are never touched.
            try {
                // Command-only generation: release to DIRTY, never PENDING —
                // a cancelled book keeps no queued work.
                const orphanRepair = await dispatchEngine.repairOrphanGeneratingStates(redis, bookId, {
                    reason: 'stop_all_orphan_repair',
                    target: 'dirty',
                });
                if (orphanRepair.repaired.length > 0) {
                    log(`[CANCEL-GENERATION] ${bookId}: ${orphanRepair.repaired.length} orphan GENERATING state(s) released (GENERATING → DIRTY)`);
                }
            } catch (orphanErr) {
                console.warn(`[CANCEL-GENERATION] Orphan GENERATING sweep failed for ${bookId}: ${orphanErr.message}`);
            }

            // Clear per-worker cancel tracking (if any was set)
            await redis.del(`animastor:cancelled-workers:${bookId}`);
            await generationProgress.clear(redis, bookId);
            await commandGate.clearForceStages(redis, bookId);

            // Command-only generation: no `pending` scene_assets row survives
            // Stop All (incident 2026-10-30: image/pending rows outlived the
            // cancel and were a resurrection mine). ready/placeholder untouched.
            try {
                const cancelledRows = await sceneAssetsRepo.cancelPendingAssets(
                    bookId, mediaRegistry.listMediaTypes(), null, 'cancel-generation');
                if (cancelledRows > 0) {
                    log(`[CANCEL-GENERATION] ${bookId}: ${cancelledRows} pending scene_assets row(s) → cancelled`);
                }
            } catch (pgErr) {
                console.warn(`[CANCEL-GENERATION] Failed to cancel pending scene_assets rows: ${pgErr.message}`);
            }

            // Persist terminal state for GPU tasks.
            try {
                const cancelledTasks = await taskRepo.cancelActiveTasksForBook(bookId);
                if (cancelledTasks > 0) {
                    log(`[CANCEL-GENERATION] ${bookId}: ${cancelledTasks} generation task row(s) cancelled`);
                }
            } catch (pgErr) {
                console.warn(`[CANCEL-GENERATION] Failed to cancel generation task rows: ${pgErr.message}`);
            }

            // Cancel VBook/AI agent sessions too — through the
            // AgentSessionControl port (S-1: no agent_sessions SQL here).
            try {
                await sessionControl.cancelSessions(bookId);
                log(`[CANCEL-GENERATION] ${bookId}: VBook agent sessions cancelled`);
            } catch (pgErr) {
                console.warn(`[CANCEL-GENERATION] Failed to cancel VBook session: ${pgErr.message}`);
            }

            // Also clear GPU hub stale jobs via HTTP endpoint (T4: владелец ключей — gpu-hub)
            try {
                const hubUrl = `${config.HUB_URL}/queue/clear?book_id=${bookId}`;
                const hubOptions = { method: 'DELETE', headers: {} };
                if (config.GPU_HUB_API_KEY) {
                    hubOptions.headers['x-api-key'] = config.GPU_HUB_API_KEY;
                }
                const hubRes = await fetch(hubUrl, hubOptions);
                if (!hubRes.ok) {
                    throw new Error(`GPU hub queue clear returned ${hubRes.status}`);
                }
                log(`[CANCEL-GENERATION] GPU hub queues cleared via HTTP for ${bookId}`);

                // Stage 116 (D4) / Stage 118 (B4): the hub clears the LANE
                // entries; the backend-side pending claims of the same jobs
                // must go with them, otherwise the next run of this book would
                // be suppressed as a duplicate until the claim TTL expires.
                //
                // Stage 118 (B4) — ORDER: the lane is cleared FIRST and the
                // claims are released ONLY after the hub confirmed. The
                // Stage 116 order (release → clear) opened a duplicate
                // window: when the hub call failed, the claims were already
                // free while the lane entries survived ⇒ the next dispatch
                // enqueued a SECOND copy of a task that was still queued.
                // On a hub failure the claims are kept — the safe direction.
                try {
                    const qidem = queueIdempotency;
                    if (qidem) {
                        const released = await qidem.releaseClaimsForBook(redis, bookId);
                        log(`[CANCEL-GENERATION] ${bookId}: released ${released.released} idempotency claim(s), ${released.done} completion marker(s)`);
                    }
                    // The capacity backoff must not survive an explicit
                    // cancel — the user asked for the work to run again.
                    await dispatchEngine.clearDeferralsForBook(redis, bookId);
                } catch (claimErr) {
                    console.warn(`[CANCEL-GENERATION] Failed to release idempotency claims for ${bookId}: ${claimErr.message}`);
                }
                // Stage 120 (M-b): sweep the lane AGAIN after the release — a
                // dispatch landing between the clear above and the release
                // would leave an ORPHAN lane entry whose claim was just
                // deleted (the next run would enqueue a second copy).
                try {
                    const sweepRes = await fetch(hubUrl, hubOptions);
                    if (!sweepRes.ok) {
                        console.warn(`[CANCEL-GENERATION] Post-release lane sweep failed for ${bookId} (status ${sweepRes.status}) — an orphan entry may survive (bounded by claim TTL)`);
                    }
                } catch (sweepErr) {
                    console.warn(`[CANCEL-GENERATION] Post-release lane sweep failed for ${bookId}: ${sweepErr.message}`);
                }
            } catch (hubErr) {
                throw new Error(`GPU hub cleanup failed: ${hubErr.message}`);
            }

            log(`[CANCEL-GENERATION] ${bookId}: generation cancelled, counters + leases reset`);
            res.json({ ok: true, book_id: bookId });
        } catch (err) {
            console.error('[CANCEL-GENERATION] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // SELECTIVE REGENERATION
    // ======================================================
    app.post('/api/v1/book/:bookId/regenerate', async (req, res) => {
        const REGENERATE_LOCK_PREFIX = 'animastor:regenerate-lock';
        const LOCK_TTL = 120;
        const lockKey = `${REGENERATE_LOCK_PREFIX}:${req.params.bookId}`;
        const lockToken = `lock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const lockAcquired = await redis.set(lockKey, lockToken, 'NX', 'EX', LOCK_TTL);
        if (!lockAcquired) {
            log(`[REGENERATE] 🔒 Lock held for ${req.params.bookId} — rejecting duplicate`);
            return res.status(429).json({
                error: 'Regeneration already in progress for this book',
                retry_after_seconds: LOCK_TTL,
            });
        }

        const releaseRegenerateLock = async () => {
            try {
                const current = await redis.get(lockKey);
                if (current === lockToken) await redis.del(lockKey);
            } catch (_) { /* best-effort */ }
        };

        try {
            const { bookId } = req.params;
            const {
                scope,
                chapter_id,
                scene_id,
                worker_types: workerTypes,
                rebuild_all,
            } = req.body || {};

            const loadedBook = book.loadBook(bookId);
            if (!loadedBook) return res.status(404).json({ error: 'book not found' });

            const buildId = loadedBook.manifest?.build_id || 'default';

            // force-dispatch is owned by orchestrator.resetScenes().

            const effectiveScope = scope || 'whole_book';
            const persistedLayerCfg = await layerConfig.get(redis, bookId);
            // S-2: validWorkerTypes derived from media registry (with fallback
            // for test isolation where registry may not be initialized)
            const _registryTypes = mediaRegistry.resolveValidWorkerTypes();
            const validWorkerTypes = _registryTypes.size > 0
                ? _registryTypes
                : new Set(['audio', 'image', 'video']);
            let requestedWorkerTypes;
            if (workerTypes !== undefined) {
                if (!Array.isArray(workerTypes) || workerTypes.length === 0 ||
                    workerTypes.some(type => !validWorkerTypes.has(type))) {
                    return res.status(400).json({
                        error: 'worker_types must be a non-empty array containing audio, image, or video',
                    });
                }
                requestedWorkerTypes = [...new Set(workerTypes)];
            } else {
                requestedWorkerTypes = mediaRegistry.listMediaTypes().filter(
                    type => persistedLayerCfg[`${type}_enabled`] !== false
                );
            }
            // Command-only generation: tasks only for ENABLED layers. A
            // disabled layer in an explicit worker_types list is dropped; if
            // nothing is left the command is refused (no task, no work).
            const skippedWorkerTypes = requestedWorkerTypes.filter(
                type => persistedLayerCfg[`${type}_enabled`] === false
            );
            requestedWorkerTypes = requestedWorkerTypes.filter(
                type => persistedLayerCfg[`${type}_enabled`] !== false
            );
            if (requestedWorkerTypes.length === 0) {
                log(`[REGENERATE] ${bookId}: refused — every requested layer is disabled (${skippedWorkerTypes.join(',') || 'none enabled'})`);
                return res.status(409).json({
                    error: 'layer_disabled',
                    message: 'All requested layers are disabled in layer-config',
                    disabled_worker_types: skippedWorkerTypes,
                });
            }
            if (skippedWorkerTypes.length > 0) {
                log(`[REGENERATE] ${bookId}: disabled layer(s) dropped from the command: ${skippedWorkerTypes.join(',')}`);
            }
            const requestedTypeSet = new Set(requestedWorkerTypes);
            // An explicit, accepted command clears the cancel flag and the
            // cancellation tombstone (a refused command above leaves both) —
            // the command gate then authorizes the new tasks.
            await runtime.sceneWindow.clearCancelFlag(redis, bookId);
            try {
                await generationCancelRepo.clear(bookId);
                log(`[REGENERATE] ${bookId}: cancellation tombstone cleared`);
            } catch (tombErr) {
                console.warn(`[REGENERATE] Failed to clear cancellation tombstone for ${bookId}: ${tombErr.message}`);
            }

            // S-2: layer config fields derived from registry
            const requestLayerCfg = {};
            for (const t of mediaRegistry.listMediaTypes()) {
                requestLayerCfg[`${t}_enabled`] = requestedTypeSet.has(t);
            }

            const allScenes = book.collectScenes(loadedBook);
            let filteredDirty;

            if (rebuild_all) {
                const allDirty = allScenes.map(s => ({
                    chapter_id: s.chapter_id, scene_id: s.scene_id,
                    reason: 'rebuild', dirty_layers: requestedWorkerTypes,
                }));
                filteredDirty = bookDiff.filterDirtyScenesByScope(allDirty, effectiveScope, chapter_id, scene_id, allScenes);
                log(`[REGENERATE] ${bookId}: full rebuild — ${filteredDirty.length} scenes marked dirty`);
            } else if (chapter_id && scene_id) {
                const targetScene = allScenes.find(s => s.chapter_id === chapter_id && s.scene_id === scene_id);
                if (!targetScene) {
                    filteredDirty = [];
                } else {
                    const scenePayload = targetScene.payload || targetScene;
                    const changedUnitIds = [];
                    if (req.body.unit_id) {
                        changedUnitIds.push(req.body.unit_id);
                    } else {
                        const allUnits = [...(scenePayload.units || [])];
                        for (const db of (scenePayload.dialogue_blocks || [])) {
                            if (db.units) allUnits.push(...db.units);
                        }
                        for (const u of allUnits) {
                            if (u.id) changedUnitIds.push(String(u.id));
                        }
                    }
                    filteredDirty = [{
                        chapter_id, scene_id, reason: 'explicit_regen',
                        dirty_layers: requestedWorkerTypes,
                        changes: changedUnitIds.length > 0 ? { units: { unit_ids: changedUnitIds } } : null,
                    }];
                    log(`[REGENERATE] ${bookId}: primary path — created dirty entry for ${chapter_id}/${scene_id} (${changedUnitIds.length} units)`);
                    filteredDirty = bookDiff.filterDirtyScenesByScope(filteredDirty, effectiveScope, chapter_id, scene_id, allScenes);
                }
            } else {
                const existingBook = book.loadBook(bookId);
                const diff = bookDiff.computeBookDiff(existingBook, loadedBook);
                log(`[REGENERATE] ${bookId}: fallback diff — ${diff.changes.added} added, ${diff.changes.removed} removed, ${diff.changes.modified} modified`);
                filteredDirty = bookDiff.filterDirtyScenesByScope(diff.dirty_scenes, effectiveScope, chapter_id, scene_id, allScenes);

                if (filteredDirty.length === 0) {
                    log(`[REGENERATE] ${bookId}: diff empty — querying PG for dirty scenes`);
                    try {
                        const pgRows = await sceneAssetsRepo.getFlaggedDirtyScenes(bookId);
                        if (pgRows.length > 0) {
                            filteredDirty = pgRows.map(row => ({
                                chapter_id: row.chapter_id, scene_id: row.scene_id,
                                reason: row.is_dirty ? 'version_stale' : 'dirty_units',
                                dirty_layers: ['image'],
                                changes: row.dirty_unit_ids && row.dirty_unit_ids.length > 0 ? { units: { unit_ids: row.dirty_unit_ids } } : null,
                            }));
                            filteredDirty = bookDiff.filterDirtyScenesByScope(filteredDirty, effectiveScope, chapter_id, scene_id, allScenes);
                            log(`[REGENERATE] ${bookId}: PG fallback found ${filteredDirty.length} dirty scene(s)`);
                        } else {
                            log(`[REGENERATE] ${bookId}: PG fallback also empty`);
                        }
                    } catch (pgErr) {
                        console.warn(`[REGENERATE] PG fallback query failed: ${pgErr.message}`);
                    }
                }
            }

            filteredDirty = filteredDirty
                .map(ds => ({
                    ...ds,
                    dirty_layers: (ds.dirty_layers || requestedWorkerTypes)
                        .filter(type => requestedTypeSet.has(type)),
                }))
                .filter(ds => ds.dirty_layers.length > 0);

            // ── Cover check — ensure cover scene is included in generation ──
            // Whole-book scope ONLY. For scoped requests (current_scene etc.) the
            // cover must NOT be dragged in as a second target of the same task:
            // the progress-panel then emits TWO rows sharing one task_id, and the
            // frontend's per-task completion tracking — armed when the cover's
            // fast 1/1 row finishes — expires the real scene's 5/5 row before it
            // can render (the "4/5 → drop, final green 100% never shows" bug).
            // collectScenes() already includes the cover for whole_book, so this
            // prepend is only meaningful as a safety net when the cover is not
            // among the whole-book dirty scenes.
            const coverCh = (loadedBook.chapters || []).find(ch => ch.type === 'cover');
            if (effectiveScope === 'whole_book' && coverCh && coverCh.scenes && coverCh.scenes.length > 0 && requestedTypeSet.has('image')) {
                const coverScene = coverCh.scenes[0];
                // Legacy chapters (parse.js) carry the id in `chapter`; modern
                // lazy-book chapters (chapter-utils.js) use `chapter_id`. Reading
                // only `chapter` made coverChapterId undefined for modern books →
                // the cover never reached createTasks (targetsForType skips scenes
                // without chapter_id) and was silently dropped from generation.
                const coverChapterId = coverCh.chapter_id ?? coverCh.chapter;
                const coverSceneId = coverScene.scene_id;
                const alreadyDirty = filteredDirty.some(d => d.chapter_id === coverChapterId && d.scene_id === coverSceneId);
                if (!alreadyDirty && filteredDirty.length > 0) {
                    const buildDir = path.join(config.OUTPUT_DIR, buildId);
                    let coverHasImages = false;
                    try {
                        if (fs.existsSync(buildDir)) {
                            const iuPrefix = `${bookId}_${coverChapterId}_${coverSceneId}_iu`;
                            const files = fs.readdirSync(buildDir).filter(f => f.startsWith(iuPrefix) && f.endsWith('.png'));
                            const iuCount = (coverScene.units || []).length +
                                (coverScene.dialogue_blocks || []).reduce((sum, db) => sum + (db.units || []).length, 0);
                            coverHasImages = files.length >= iuCount && iuCount > 0;
                        }
                    } catch (_) {}
                    if (!coverHasImages) {
                        const coverLayers = ['image'];
                        if (requestedTypeSet.has('audio')) coverLayers.push('audio');
                        if (requestedTypeSet.has('video')) coverLayers.push('video');
                        filteredDirty.unshift({
                            chapter_id: coverChapterId, scene_id: coverSceneId,
                            reason: 'cover', dirty_layers: coverLayers,
                        });
                        log(`[REGENERATE] ${bookId}: Cover prepended to dirty scenes (ch=${coverChapterId} sc=${coverSceneId})`);
                    }
                }
            }

            // ── Materialize `scenes` rows for every scene this run touches ──
            // `scenes` is lazily populated (editor-save reconcile /
            // ensureSceneRow on unit-dirty). Import and /regenerate never create
            // it, and a derived-state cleanup can delete it while the canonical
            // bundle + scene_assets survive — the book then disappears from
            // listBooks (`SELECT DISTINCT book_id FROM scenes`) and C8/recovery
            // can never pick it up again (production case
            // import_1786345731767_1786345734345, 2026-08-10…08-13).
            // INSERT … ON CONFLICT DO NOTHING: idempotent, no version bump.
            // ALL materialization attempts complete BEFORE resetScenes — state
            // is never reset for a scene whose row attempt has not finished.
            // Fail-open per scene: an unavailable repo must not block
            // generation, but every failure is logged (per-scene + summary).
            const scenesRowsFailed = [];
            for (const ds of filteredDirty) {
                try {
                    if (typeof sceneAssetsRepo.ensureSceneRow === 'function') {
                        await sceneAssetsRepo.ensureSceneRow(bookId, ds.chapter_id, ds.scene_id);
                    }
                } catch (pgErr) {
                    scenesRowsFailed.push(`${ds.chapter_id}/${ds.scene_id}`);
                    console.warn(
                        `[REGENERATE] Failed to ensure scenes row for ` +
                        `${ds.chapter_id}/${ds.scene_id}: ${pgErr.message}`
                    );
                }
            }
            if (scenesRowsFailed.length > 0) {
                console.warn(
                    `[REGENERATE] ${bookId}: scenes-row materialization FAILED for ` +
                    `${scenesRowsFailed.length}/${filteredDirty.length} scene(s): ` +
                    `${scenesRowsFailed.join(', ')} — those scenes stay invisible to ` +
                    `listBooks until a later successful materialization`
                );
            } else if (filteredDirty.length > 0) {
                log(`[REGENERATE] ${bookId}: materialized scenes rows for ${filteredDirty.length} scene(s)`);
            }

            // ── State management через единую команду фасада ──
            // T4 консолидации: resetScenes заменяет ручной ритуал очистки
            // force-dispatch, gen-scope, active index, lease, GPU queues,
            // iu-progress/in-flight, markDirty, re-add to active index.
            // Собираем мапу unit_id для pre-delete stale PNG.
            const cleanPngUnitIds = {};
            for (const ds of filteredDirty) {
                if (!ds.dirty_layers.includes('image')) continue;
                const unitIds = ds.changes?.units?.unit_ids;
                if (unitIds && Array.isArray(unitIds) && unitIds.length > 0) {
                    cleanPngUnitIds[`${ds.chapter_id}_${ds.scene_id}`] = unitIds;
                }
            }

            const marked = await orchestrator.resetScenes(redis, bookId, buildId, filteredDirty, requestLayerCfg, {
                scope: effectiveScope,
                chapterId: chapter_id || null,
                sceneId: scene_id || null,
                bookDiff,
                cleanPngUnitIds: Object.keys(cleanPngUnitIds).length > 0 ? cleanPngUnitIds : null,
                readdToActiveIndex: false,
            });

            // Stage 116 (D4) / Stage 118 (B1/B4): resetScenes cleared the hub
            // lane entries of the cancelled dispatches; the backend-side
            // pending claims of the SAME jobs must be released too, otherwise
            // the regeneration would be suppressed as a duplicate (the claim
            // outlives the lane entry it protected). Ownership-scoped per
            // dirty scene.
            //
            // Stage 118: the release now also frees the COMPLETION MARKERS
            // of the regenerated scene (B1) — the user explicitly asked for
            // the work to run again, so the previous "already completed" no
            // longer applies. The capacity backoff of the scene is dropped
            // as well (M2): the regeneration is an explicit intent.
            try {
                const qidem = queueIdempotency;
                let releasedClaims = 0;
                let releasedDone = 0;
                if (!qidem) throw new Error('queue idempotency port not wired');
                for (const ds of filteredDirty) {
                    const released = await qidem.releaseClaimsForScene(
                        redis, bookId, ds.chapter_id, ds.scene_id
                    );
                    releasedClaims += released.released;
                    releasedDone += released.done;
                    await dispatchEngine.clearDeferralsForScene(redis, bookId, ds.chapter_id, ds.scene_id);
                }
                if (releasedClaims > 0 || releasedDone > 0) {
                    log(`[REGENERATE] ${bookId}: released ${releasedClaims} idempotency claim(s) and ${releasedDone} completion marker(s) for the regenerated scenes`);
                }
                // Stage 120 (M-b): resetScenes cleared the hub lane BEFORE
                // this release. A dispatch landing between that clear and the
                // release above would leave an ORPHAN lane entry whose claim
                // was just deleted (the next run would enqueue a second copy).
                // Sweep the lane AGAIN for the regenerated scenes to remove it.
                //
                // Stage 122 (N1, audit 121): the previous call passed an EMPTY
                // dispatch-id list with { book_id } but clearHubDispatches only
                // honoured the per-id form — it issued ZERO hub requests (a
                // silent no-op). clearHubDispatches now resolves the empty
                // list + book_id into ONE book-scoped `?book_id=` sweep. A
                // failed sweep only warns (the claims were already released,
                // the orphan is bounded by claim TTL) — it is never reported
                // as a success.
                try {
                    const hubPort = require('@animastor/orchestration').ports.hubCancel;
                    if (hubPort && typeof hubPort.isHubCancelPortWired === 'function' && hubPort.isHubCancelPortWired()) {
                        const sweep = await hubPort.hubCancelOp('clearHubDispatches')([], { book_id: bookId, context: 'REGENERATE' });
                        if (sweep && sweep.failed > 0) {
                            console.warn(`[REGENERATE] Post-release lane sweep for ${bookId} incomplete (requested=${sweep.requested}, cleared=${sweep.cleared}, failed=${sweep.failed}) — an orphan entry may survive (bounded by claim TTL)`);
                        }
                    }
                } catch (sweepErr) {
                    console.warn(`[REGENERATE] Post-release lane sweep failed for ${bookId}: ${sweepErr.message}`);
                }
            } catch (claimErr) {
                console.warn(`[REGENERATE] Failed to release idempotency claims for ${bookId}: ${claimErr.message}`);
            }

            // /regenerate is an execution command, not a content change. The
            // runtime reset above already marks the requested layers pending.
            // Running book-sync here would invalidate unrelated parallel tasks
            // for the same scene and bump content versions without an edit.
            for (const ds of filteredDirty) {
                if (!ds.dirty_layers.includes('image')) continue;
                const unitIds = ds.changes?.units?.unit_ids;
                if (!unitIds || !Array.isArray(unitIds) || unitIds.length === 0) continue;
                try {
                    await sceneAssetsRepo.setDirtyUnitIds(
                        bookId,
                        ds.chapter_id,
                        ds.scene_id,
                        unitIds
                    );
                } catch (pgErr) {
                    console.warn(
                        `[REGENERATE] Failed to persist dirty image units for ` +
                        `${ds.chapter_id}/${ds.scene_id}: ${pgErr.message}`
                    );
                }
            }

            // A new command supersedes blocked/interrupted tasks of the same
            // types on the same scenes (the panel shows only the new command).
            try {
                const superseded = await generationProgress.removeSupersededTasks(
                    redis, bookId, requestedWorkerTypes, filteredDirty);
                if (superseded.length > 0) {
                    log(`[REGENERATE] ${bookId}: superseded ${superseded.length} blocked/interrupted task(s)`);
                }
            } catch (supErr) {
                console.warn(`[REGENERATE] superseding old tasks failed for ${bookId}: ${supErr.message}`);
            }

            const generationTasks = await generationProgress.createTasks(
                redis,
                bookId,
                requestedWorkerTypes,
                {
                    scope: effectiveScope,
                    chapterId: chapter_id || null,
                    sceneId: scene_id || null,
                },
                filteredDirty
            );

            // PW-2: server-derived workspace ownership for persisted tasks.
            // Resolved from book → books.workspace_id (never client-supplied);
            // null keeps the task in the system-pool lane.
            let taskWorkspaceId = null;
            try {
                taskWorkspaceId = await bookRepo.getWorkspaceId(bookId);
            } catch (wsErr) {
                console.warn(`[REGENERATE] workspace resolution failed for ${bookId}: ${wsErr.message}`);
            }

            for (const task of generationTasks) {
                for (const target of task.targets || []) {
                    try {
                        await taskRepo.createTask(
                            task.task_id,
                            bookId,
                            target.chapter_id,
                            target.scene_id,
                            task.type,
                            {
                                scope: task.scope,
                                chapter_id: task.chapter_id,
                                scene_id: task.scene_id,
                            },
                            taskWorkspaceId
                        );
                        await taskRepo.updateTaskStatus(task.task_id, 'running');
                    } catch (pgErr) {
                        console.warn(`[REGENERATE] Failed to persist task ${task.task_id}: ${pgErr.message}`);
                        break;
                    }
                }
            }

            // The scene stays outside the active index until task metadata is
            // complete. Missing an intermediate scheduler tick is harmless; the
            // next tick sees the fully registered command after this re-add.
            for (const ds of filteredDirty) {
                await runtime.scheduler.addSceneToActiveIndex(
                    redis,
                    bookId,
                    ds.chapter_id,
                    ds.scene_id
                );
            }

            res.json({
                book_id: bookId,
                scope: effectiveScope,
                dirty_scenes: filteredDirty,
                marked: marked.marked,
                skipped_worker_types: skippedWorkerTypes,
                tasks: generationTasks.map(task => ({
                    task_id: task.task_id,
                    type: task.type,
                    target_count: task.targets.length,
                })),
            });
        } catch (err) {
            console.error('[REGENERATE] Error:', err.message);
            res.status(500).json({ error: err.message });
        } finally {
            await releaseRegenerateLock();
        }
    });
};
