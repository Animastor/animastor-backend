const { lazyHostBinding } = require('../host/host-bindings');
// §32.30: former host requires ('../state', '../audio', '../image', '../video')
// resolve lazily through the composition-root host-bindings seam — usage
// below stays verbatim.
const state = lazyHostBinding('state');
const media = lazyHostBinding('media');
const audio = lazyHostBinding('media.audio');
const image = lazyHostBinding('media.image');
const video = lazyHostBinding('media.video');
const segments = lazyHostBinding('media.audio.segments');
const chunks = lazyHostBinding('media.audio.chunks');
// S-3: Generation → GPU transport rides the provider seam only. The
// orchestrator never requires gpu-dispatcher or the workflow connector.
const provider = require('@animastor/generation').comfyuiProvider;
const runtimeScheduler = require('../runtime/runtime-scheduler');
// Stage 118 (M3): the shared outcome taxonomy — the dispatch engine (runtime
// tier) and the stage executors (orchestration tier) must classify a
// "nothing was enqueued" outcome IDENTICALLY.
const { classifyNotSentReasons } = require('../runtime/dispatch-outcomes');
// O-2: persistence arrives ONLY through the PersistencePort (host adapter:
// storage/runtime-persistence-adapter) — the scene-assets repository left
// this file. SQL lives host-side.
const persist = require('../runtime/persistence-port').persist;
const isPersistencePortWired = require('../runtime/persistence-port').isPersistencePortWired;
// O-3: scene content arrives ONLY through the SceneDataPort (host adapter:
// storage/scene-data-adapter) — the Book Model facade (../book →
// @animastor/vbook-runtime) left this file. Aliased `sceneDataPort` because
// the per-stage legs bind their result to a local `sceneData` variable.
const sceneDataPort = require('../runtime/scene-data-port').sceneDataOp;
// O-7: the audio scene FSM is driven ONLY through the AudioFsmPort (host
// adapter: storage/audio-fsm-adapter) — the audio-orchestrator host
// service left this file. The video FSM remains on its host service until
// its own seam step.
const audioFsmOp = require('../runtime/audio-fsm-port').audioFsmOp;
const audioFsmPhases = require('../runtime/audio-fsm-port').audioFsmPhases;
// O-10: per-book layer config arrives ONLY through the LayerConfigPort
// (host adapter: storage/layer-config-adapter) — the layer-config host
// service (../services/layer-config) left this file.
const layerConfigOp = require('../runtime/layer-config-port').layerConfigOp;
const { log, warn, logEvent } = require('./scene-utils');
const { handleAudioCompleted, handleImageCompleted, handleVideoCompleted } = require('./scene-callbacks');
const { restoreSceneChunkStatus } = require('./scene-restoration');
// §32.30: setScenePending/setSceneGenerating are LAZY getters on the facade
// (stateOps host binding) — destructure at call time, not at load time.
const orchestratorModule = require('./orchestrator');
const completeStage = (...a) => orchestratorModule.completeStage(...a);
const failStage = (...a) => orchestratorModule.failStage(...a);
const setScenePending = (...a) => orchestratorModule.setScenePending(...a);
const setSceneGenerating = (...a) => orchestratorModule.setSceneGenerating(...a);
// Полный модуль нужен для fast-track video-orch (completeGroup принимает
// deps.orchestrator) — деструктуризация выше не покрывает этот кейс.
const orchestrator = require('./orchestrator');
// S-2: media registry for executor dispatch
const mediaRegistry = require('@animastor/generation').mediaRegistry;

// ======================================================
// SCENE ORCHESTRATOR
// ======================================================
// Pure dispatch execution: no linear state machine, no stage decisions.
// The dispatch-engine passes overrideStage — the orchestrator just executes.
// Per-asset states (AssetState) are the source of truth.

// S-2: Executor dispatch map — derived from registry + concrete executors.
// This replaces the hardcoded if/else chain in dispatchStage().
const EXECUTORS = {
    audio: executeAudioDispatch,
    image: executeImageDispatch,
    video: executeVideoDispatch,
};

async function startScene(redis, scene, loadedBook, buildId) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    log(`START SCENE: ${bookId}/${chapterId}/${sceneId}`);

    await logEvent(redis, scene, 'SCENE_STARTED', 'audio_pending', {
        buildId, bookId, chapterId, sceneId
    });

    // T7: через фасад — единый владелец PENDING
    await setScenePending(redis, bookId, chapterId, sceneId, 'audio', buildId);
    await runtimeScheduler.addSceneToActiveIndex(redis, bookId, chapterId, sceneId);
    log(`ADDED TO ACTIVE: ${bookId}/${chapterId}/${sceneId}`);

    return { success: true };
}

// ── STAGE DISPATCH LIFECYCLE GUARD ───────────────────
// Fix: docs/runtime-audits/video-retry-targeted-investigation-2026-08-26.md
// Частичный SCENE_RESET может оставить ассет в NEW при готовых остальных
// (image=READY, video=NEW): startScene() пропускается (не все три NEW),
// после чего setSceneGenerating(new→generating) отклоняется state-машиной,
// rejection проглатывался — и job уходил в GPU Hub из невалидного состояния.
// Успешный результат затем отклонялся handleVideoCompleted
// ('invalid_asset_state'), превращался в FAILURE, сжигал retry budget и
// открывал circuit breaker.
//
// Контракт: перед отправкой любого GPU job ассет обязан пройти
//   NEW|DIRTY → PENDING (здесь) → GENERATING (сразу ниже),
// либо уже находиться в состоянии, из которого GENERATING достижим.
// Если переход невозможен — dispatch ПРЕРЫВАЕТСЯ ДО отправки job.
//
// Stage 50: DIRTY включён в нормализацию. DIRTY → GENERATING запрещён FSM
// (scene-state.js: DIRTY → [PENDING, PLACEHOLDER]), поэтому до этого фикса
// dirty-ассет (version-stale pre-pass, C1/C1b recovery, RELEASE_STALE_LEASE,
// markDirtyScene) не мог перегенерироваться через планировщик вообще: guard
// отклонял setSceneGenerating(dirty), rejection проглатывался в
// attemptDispatch — ровно тот `INVALID state=dirty attempted=generating`
// из journal (Case A, stage 49). Комментарий теста stage-dispatch-lifecycle
// («scheduler's version-stale pre-pass owns DIRTY→PENDING») описывал
// нормализацию, которой не существовало. PENDING-хоп здесь — это и есть
// недостающая половина контракта.
async function ensureStageDispatchable(redis, bookId, chapterId, sceneId, stage) {
    const states = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    if (states?.[stage] === state.AssetState.NEW || states?.[stage] === state.AssetState.DIRTY) {
        const init = await setScenePending(redis, bookId, chapterId, sceneId, stage);
        if (!init.changed) {
            return { ok: false, reason: `pending_init_failed:${init.reason}` };
        }
        log(`STAGE_INIT: ${bookId}/${chapterId}/${sceneId} ${stage}: ${states[stage]} → PENDING`);
    }
    const gen = await setSceneGenerating(redis, bookId, chapterId, sceneId, stage);
    if (!gen.changed) {
        return { ok: false, reason: `generating_transition_failed:${gen.reason}` };
    }
    return { ok: true };
}

// ── Stage 50: terminal audio-orch record vs requested regeneration ──
// DONE — терминальная фаза (VALID_TRANSITIONS[DONE] = []), но per-asset DIRTY
// поверх неё — явный запрос на перегенерацию (version-stale pre-pass, C1/C1b
// recovery, RELEASE_STALE_LEASE, completeStage version-gate stale). Без сброса
// записи dispatch навсегда упирается в DONE guard (already_done) — состояние
// DONE+DIRTY зависает навсегда (2 сцены в production, stage 49). Хил:
// терминальная запись удаляется, дальше ensureStageDispatchable проводит
// DIRTY → PENDING → GENERATING, а no_state-лега переинициализирует FSM.
// Не-DONE записи (WAITING_CHUNKS/MERGING/FAILED) НЕ трогаются — их ведут
// штатные recovery-леги (Фаза 4: чистится только DONE).
async function clearTerminalAudioOrchForDirty(redis, bookId, chapterId, sceneId) {
    let orchState;
    try {
        orchState = await audioFsmOp('getState')(redis, bookId, chapterId, sceneId);
    } catch (err) {
        warn(`AUDIO_DONE_DIRTY_HEAL: getState failed for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
        return false;
    }
    if (!orchState || orchState.phase !== audioFsmPhases().DONE) return false;

    const states = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    if (states?.audio !== state.AssetState.DIRTY) return false;

    log(`AUDIO_DONE_DIRTY_HEAL: ${bookId}/${chapterId}/${sceneId} — regeneration requested over terminal DONE record — clearing audio-orch state for re-dispatch`);
    await audioFsmOp('deleteState')(redis, bookId, chapterId, sceneId);
    return true;
}

// T3: Каждый executor возвращает { dispatched: true/false, jobs, reason }
async function executeAudioDispatch(redis, scene, loadedBook, buildId, dispatchId) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;
    const dbgStart = Date.now();

    log(`AUDIO_DISPATCH: ${bookId}/${chapterId}/${sceneId}`);

    await logEvent(redis, scene, 'AUDIO_DISPATCHED', 'audio_generating', {
        buildId, dispatchType: 'orchestrator'
    });

    // Stage 50: heal the DONE×DIRTY deadlock BEFORE the lifecycle guard —
    // a DIRTY request over a terminal DONE record must regenerate, not skip.
    await clearTerminalAudioOrchForDirty(redis, bookId, chapterId, sceneId);

    // T7: через фасад — единый владелец GENERATING (audio)
    // Lifecycle guard: abort BEFORE any GPU job if the transition chain fails.
    const dispatchable = await ensureStageDispatchable(redis, bookId, chapterId, sceneId, 'audio');
    if (!dispatchable.ok) {
        warn(`AUDIO_DISPATCH: ${bookId}/${chapterId}/${sceneId}: state not dispatchable (${dispatchable.reason}) — aborting before any GPU job`);
        return { dispatched: false, jobs: 0, reason: dispatchable.reason };
    }

    // Fallback to disk load when runtime doesn't pass loadedBook
    const bookData = loadedBook || sceneDataPort('loadBook')(bookId);
    const sceneData = sceneDataPort('findSceneRuntimeData')(bookData, chapterId, sceneId);

    if (!sceneData) {
        warn(`AUDIO_DISPATCH: sceneData not found for ${bookId}/${chapterId}/${sceneId}`);
        // scene_not_found: remove from active index so scheduler stops retrying.
        // Lease will expire on its own TTL — no need for active cleanup.
        try {
            await runtimeScheduler.removeSceneFromActiveIndex(redis, bookId, chapterId, sceneId);
        } catch (cleanupErr) {
            warn(`AUDIO_DISPATCH: cleanup error for ${bookId}/${chapterId}/${sceneId}: ${cleanupErr.message}`);
        }
        return { dispatched: false, jobs: 0, completed: true, reason: 'scene_not_found' };
    }

    // 🔧 AUDIO-ORCH: Transition PLACEHOLDER_READY → GENERATING
    // O-7: через AudioFsmPort (host adapter: storage/audio-fsm-adapter).

    // ── PHASE CHECK: DONE → skip, иначе продолжаем ──
    // WAITING_CHUNKS/MERGING guard удалён (см. AUDIO_ORCH_ARCHITECTURAL_FIXES.md §3):
    // dispatch-engine.acquireStageLease + A2 timeout formula гарантируют, что
    // LEASE_TTL (≈31 мин при GPU_TIMEOUT=10мин) > STALL (30 мин) > GPU_TIMEOUT (10 мин).
    // Если сцена в WAITING_CHUNKS, lease ещё активен → dispatch-engine не допустит
    // re-dispatch. Если lease истёк → STALL уже перевёл сцену в FAILED.
    const orchState = await audioFsmOp('getState')(redis, bookId, chapterId, sceneId);
    if (orchState) {
        if (orchState.phase === audioFsmPhases().DONE) {
            log(`AUDIO_ALREADY_DONE: ${bookId}/${chapterId}/${sceneId} — skipping dispatch`);
            return { dispatched: false, jobs: 0, completed: true, reason: 'already_done' };
        }
    }

    let transResult = await audioFsmOp('setGenerating')(redis, bookId, chapterId, sceneId);

    // 🔧 FIX: Если стейт не существует (no_state), инициализируем PLACEHOLDER_READY
    // и повторяем переход.
    if (!transResult.success && transResult.reason === 'no_state') {
        log(`  🔧 AUDIO_ORCH: state missing for ${bookId}/${chapterId}/${sceneId} — initializing PLACEHOLDER_READY first`);
        const segList = segments.buildSegments(sceneData);
        await audioFsmOp('initPlaceholderReady')(redis, bookId, chapterId, sceneId, buildId, segList.length);
        log(`  🔧 AUDIO_ORCH: initialized PLACEHOLDER_READY with ${segList.length} expected segments`);
        transResult = await audioFsmOp('setGenerating')(redis, bookId, chapterId, sceneId);
    }

    // 🔧 FIX: Stale phase recovery — DONE и WAITING_CHUNKS/MERGING уже отсечены выше.
    // FAILED → можно переинициализировать, GENERATING → race condition (быстрый completeChunk)
    if (!transResult.success && transResult.reason === 'invalid_transition') {
        const stalePhase = transResult.from;
        // DONE — дополнительный safety net (выше уже должен был отсечься)
        if (stalePhase === audioFsmPhases().DONE) {
            warn(`AUDIO_ORCH: DONE guard prevented stale reset for ${bookId}/${chapterId}/${sceneId}`);
            return { dispatched: false, jobs: 0, completed: true, reason: 'already_done' };
        }
        // WAITING_CHUNKS / MERGING (stale recovery): с A2 timeout formula lease
        // переживает watchdog — если дошли до stale recovery, значит lease истёк
        // и watchdog уже перевёл сцену в FAILED. WAITING_CHUNKS/MERGING в stale
        // recovery больше не возникает (бывший phase guard удалён).
        // Проверка оставлена как assertion-style safety net для логирования.
        if (stalePhase === audioFsmPhases().WAITING_CHUNKS || stalePhase === audioFsmPhases().MERGING) {
            log(`  🔧 AUDIO_ORCH: unexpected WAITING_CHUNKS/MERGING in stale recovery — lease outpaced watchdog (phase=${stalePhase})`);
            // 🔧 FIX: Прежде чем reset'ить, проверяем — есть ли чанки на диске?
            // Если все чанки на месте, зовём completeChunk для завершения merge.
            const chunksUtil = chunks;
            const presentChunks = chunksUtil.findExistingSceneChunks(bookId, chapterId, sceneId, buildId, null);
            if (presentChunks.length > 0) {
                log(`  🔧 AUDIO_ORCH: ${presentChunks.length} chunks on disk for ${bookId}/${chapterId}/${sceneId} — calling completeChunk instead of reset`);
                try {
                    await audioFsmOp('completeChunk')(redis, bookId, chapterId, sceneId, 'recovery', buildId, {
                        audio,
                        orchestrator: require('./orchestrator'),
                        dispatchId: 'stale-recovery',
                    });
                    return { dispatched: false, jobs: 0, completed: true, reason: 'recovered_via_completeChunk' };
                } catch (recoverErr) {
                    warn(`  🔧 AUDIO_ORCH: completeChunk recovery failed: ${recoverErr.message} — falling through to reset`);
                }
            }
        }
        log(`  🔧 AUDIO_ORCH: stale phase ${stalePhase} for ${bookId}/${chapterId}/${sceneId} — resetting to PLACEHOLDER_READY`);
        await audioFsmOp('deleteState')(redis, bookId, chapterId, sceneId);
        const segList = segments.buildSegments(sceneData);
        await audioFsmOp('initPlaceholderReady')(redis, bookId, chapterId, sceneId, buildId, segList.length);
        log(`  🔧 AUDIO_ORCH: reset stale phase, initialized PLACEHOLDER_READY with ${segList.length} expected segments`);
        transResult = await audioFsmOp('setGenerating')(redis, bookId, chapterId, sceneId);
    }

    if (!transResult.success) {
        warn(`AUDIO_ORCH: cannot set GENERATING for ${bookId}/${chapterId}/${sceneId}: ${transResult.reason}`);
        // T3: transition rejected — считаем что dispatch не выполнен
        return { dispatched: false, jobs: 0, reason: transResult.reason || 'phase_transition_rejected' };
    }

    // 🔧 FIX (race condition): WAITING_CHUNKS должна быть установлена ДО отправки
    // jobs, иначе первый чанк может вернуться быстрее чем setWaitingChunks выполнится,
    // и completeChunk увидит фазу GENERATING → early return → чанк на диске есть,
    // но merge не запускается → retry exhausting → failStage → re-dispatch → цикл.
    await audioFsmOp('setWaitingChunks')(redis, bookId, chapterId, sceneId);

    const result = await audio.generateSceneAudio(redis, sceneData, bookData, buildId, bookId, dispatchId);

    log(`AUDIO_DISPATCH generateSceneAudio: ${bookId}/${chapterId}/${sceneId} generated=${result?.generated} chunks=${result?.chunks}`);

    if (result && result.generated) {
        log(`AUDIO_DISPATCHED: ${bookId}/${chapterId}/${sceneId} (${result.chunks || 0} chunks sent)`);
        return { dispatched: true, jobs: result.chunks || 1, reason: null };
    } else if (result && result.reason === 'already_ready') {
        // Audio already on disk — fast-track WAITING_CHUNKS→MERGING→DONE
        await audioFsmOp('setMerging')(redis, bookId, chapterId, sceneId);
        await audioFsmOp('setDone')(redis, bookId, chapterId, sceneId);
        log(`AUDIO_DISPATCH: ${bookId}/${chapterId}/${sceneId} — already ready`);
        const completion = await completeStage(redis, bookId, chapterId, sceneId, 'audio', buildId, dispatchId);
        return { dispatched: false, jobs: 0, completed: completion.completed, reason: 'already_ready' };
    } else if (result && result.expectedChunkCount === 0) {
        // 0 segments = nothing to generate (scene has no TTS content).
        // Fast-track WAITING_CHUNKS→MERGING→DONE to break the infinite
        // dispatch→pending→re-dispatch loop that occurs when buildSegments
        // returns 0 (invalid units, missing audio data, etc).
        log(`AUDIO_DISPATCH: ${bookId}/${chapterId}/${sceneId} — 0 segments, nothing to generate, marking DONE`);
        await audioFsmOp('setMerging')(redis, bookId, chapterId, sceneId);
        await audioFsmOp('setDone')(redis, bookId, chapterId, sceneId);
        const completion = await completeStage(redis, bookId, chapterId, sceneId, 'audio', buildId, dispatchId);
        return { dispatched: false, jobs: 0, completed: completion.completed, reason: 'no_segments' };
    } else {
        // Stage 116 (D3) / Stage 118 (B3, M3): nothing was enqueued — carry
        // the precise reason (no live worker / everything already queued /
        // ambiguous POST) so the dispatch engine can apply a BOUNDED deferral
        // instead of a fatal cancel.
        //
        // Stage 118 (B3): the merged (pure-dialogue) path and the per-segment
        // path must produce the SAME classification — the merged branch used
        // to leave the reason empty, so a pure-dialogue scene kept the
        // 5-second retry loop. `deferReason` is computed by the host (audio
        // generation) for EVERY path; the fallback below keeps the historic
        // 'no_jobs_generated' semantics when the host could not classify it.
        const deferReason = (result && result.reason === 'no_jobs_accepted' && result.deferReason)
            ? result.deferReason
            : 'no_jobs_generated';
        warn(`AUDIO_DISPATCH: generateSceneAudio did not send jobs for ${bookId}/${chapterId}/${sceneId} (${deferReason})`);
        return { dispatched: false, jobs: 0, reason: deferReason, retryable: true };
    }
}

async function executeImageDispatch(redis, scene, loadedBook, buildId, dispatchId) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    log(`IMAGE_DISPATCH: ${bookId}/${chapterId}/${sceneId}`);

    await logEvent(redis, scene, 'IMAGE_DISPATCHED', 'image_generating', {
        buildId, dispatchType: 'orchestrator'
    });

    // T8: через фасад — единый владелец GENERATING
    // Lifecycle guard: abort BEFORE any GPU job if the transition chain fails.
    const dispatchable = await ensureStageDispatchable(redis, bookId, chapterId, sceneId, 'image');
    if (!dispatchable.ok) {
        warn(`IMAGE_DISPATCH: ${bookId}/${chapterId}/${sceneId}: state not dispatchable (${dispatchable.reason}) — aborting before any GPU job`);
        return { dispatched: false, jobs: 0, reason: dispatchable.reason };
    }

    const bookData = loadedBook || sceneDataPort('loadBook')(bookId);
    const sceneData = sceneDataPort('findSceneRuntimeData')(bookData, chapterId, sceneId);

    if (!sceneData) {
        warn(`IMAGE_DISPATCH: sceneData not found for ${bookId}/${chapterId}/${sceneId}`);
        // scene_not_found: remove from active index so scheduler stops retrying.
        try {
            await runtimeScheduler.removeSceneFromActiveIndex(redis, bookId, chapterId, sceneId);
        } catch (cleanupErr) {
            warn(`IMAGE_DISPATCH: cleanup error for ${bookId}/${chapterId}/${sceneId}: ${cleanupErr.message}`);
        }
        return { dispatched: false, jobs: 0, completed: true, reason: 'scene_not_found' };
    }

    // Read dirty unit IDs from PG (O-2: via PersistencePort)
    let dirtyUnitIds = new Set();
    try {
        const ids = await persist('sceneAssets.getDirtyUnitIds')(bookId, chapterId, sceneId);
        if (ids && ids.length > 0) {
            dirtyUnitIds = new Set(ids);
            log(`[DIRTY-UNITS] ${bookId}/${chapterId}/${sceneId}: ${ids.length} dirty unit(s) from PG`);
        }
    } catch (err) {
        warn(`[DIRTY-UNITS] PG read failed for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
    }

    // T3: generateSceneIUImages возвращает количество отправленных jobs
    let jobsSent = 0;
    // Stage 116 (D3): the result is needed AFTER the try/catch (the deferral
    // reason) — it must be visible outside the block.
    let genResult = null;
    try {
        genResult = await image.generateSceneIUImages(
            redis,
            sceneData,
            bookData,
            buildId,
            bookId,
            dirtyUnitIds,
            dispatchId
        );
        jobsSent = (genResult && genResult.sentCount) || 0;
        if (jobsSent === 0 && genResult.total > 0 && genResult.cachedCount === genResult.total) {
            const completion = await completeStage(redis, bookId, chapterId, sceneId, 'image', buildId, dispatchId);
            return { dispatched: false, jobs: 0, completed: completion.completed, reason: 'cache_hit' };
        }
    } catch (genErr) {
        warn(`IMAGE_DISPATCH: generateSceneIUImages error for ${bookId}/${chapterId}/${sceneId}: ${genErr.message}`);
        return { dispatched: false, jobs: 0, reason: 'generation_error' };
    }

    if (jobsSent > 0) {
        log(`IMAGE_DISPATCHED: ${bookId}/${chapterId}/${sceneId} (${jobsSent} IU job(s) sent)`);
        return { dispatched: true, jobs: jobsSent, reason: null };
    }

    // Stage 116 (D3) / Stage 118 (M3): the executor sent NOTHING. That is
    // not a lost task and not a fatal cancellation — it is a bounded
    // deferral. The precise reason (no live worker / everything already
    // queued / ambiguous POST) is carried through so the deferral can be
    // classified by the shared taxonomy (runtime/dispatch-outcomes).
    if (genResult && genResult.deferReason) {
        warn(`IMAGE_DISPATCH: ${bookId}/${chapterId}/${sceneId} — nothing enqueued (${genResult.deferReason}); deferring`);
        return { dispatched: false, jobs: 0, reason: genResult.deferReason, retryable: true };
    }

    log(`IMAGE_DISPATCH: ${bookId}/${chapterId}/${sceneId} — no jobs sent (cache hit or empty units)`);
    return { dispatched: false, jobs: 0, reason: 'no_jobs_sent' };
}

async function executeVideoDispatch(redis, scene, loadedBook, buildId, dispatchId) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    log(`VIDEO_DISPATCH: ${bookId}/${chapterId}/${sceneId}`);

    await logEvent(redis, scene, 'VIDEO_DISPATCHED', 'video_generating', {
        buildId, dispatchType: 'orchestrator'
    });

    // T8: через фасад — единый владелец GENERATING
    // Lifecycle guard: abort BEFORE any GPU job if the transition chain fails
    // (root cause of the 2026-08-26 video re-dispatch incident).
    const dispatchable = await ensureStageDispatchable(redis, bookId, chapterId, sceneId, 'video');
    if (!dispatchable.ok) {
        warn(`VIDEO_DISPATCH: ${bookId}/${chapterId}/${sceneId}: state not dispatchable (${dispatchable.reason}) — aborting before any GPU job`);
        return { dispatched: false, jobs: 0, reason: dispatchable.reason };
    }

    const bookData = loadedBook || sceneDataPort('loadBook')(bookId);
    const sceneData = sceneDataPort('findSceneRuntimeData')(bookData, chapterId, sceneId);

    if (!sceneData) {
        warn(`VIDEO_DISPATCH: sceneData not found for ${bookId}/${chapterId}/${sceneId}`);
        // scene_not_found: remove from active index so scheduler stops retrying.
        try {
            await runtimeScheduler.removeSceneFromActiveIndex(redis, bookId, chapterId, sceneId);
        } catch (cleanupErr) {
            warn(`VIDEO_DISPATCH: cleanup error for ${bookId}/${chapterId}/${sceneId}: ${cleanupErr.message}`);
        }
        return { dispatched: false, jobs: 0, completed: true, reason: 'scene_not_found' };
    }

    // Read per-type timeout from layer-config
    // O-10: through the LayerConfigPort (host adapter:
    // storage/layer-config-adapter). The leg's pre-O-10 try/catch
    // tolerance is preserved exactly — the port call replaces the
    // direct service call inside the same `try { … } catch (_) {}`.
    let videoTimeoutMs;
    try {
        const cfg = await layerConfigOp('get')(redis, bookId);
        if (cfg && cfg.video_timeout_minutes > 0) {
            videoTimeoutMs = cfg.video_timeout_minutes * 60 * 1000;
            log(`VIDEO_DISPATCH: ${bookId}/${chapterId}/${sceneId}: using timeout=${cfg.video_timeout_minutes} min from layer-config`);
        }
    } catch (_) {}

    const videoResult = await video.generateVideoAnimation(sceneData, bookData, buildId, provider.listWorkflows(), dispatchId);

    if (!videoResult.success) {
        warn(`VIDEO_GENERATION: ${bookId}/${chapterId}/${sceneId} failed: ${videoResult.reason || 'unknown'}`);
        return { dispatched: false, jobs: 0, reason: videoResult.reason || 'generation_failed' };
    }

    const jobSpecs = videoResult.jobSpecs || [];
    if (jobSpecs.length === 0) {
        warn(`VIDEO_GENERATION: ${bookId}/${chapterId}/${sceneId}: no jobSpecs returned`);
        return { dispatched: false, jobs: 0, reason: 'no_job_specs' };
    }

    // ── VIDEO-ORCH: init state machine с группами (suffix + unit_ids) ──
    // Группа → { suffix: '_gN', unit_ids: [...] }. Маппинг юнитов на группу
    // хранится в state для точечной dirty-регенерации: при повторном
    // dispatch перегенерируются только группы, содержащие dirty-юниты.
    // O-8: через VideoFsmPort (host adapter: storage/video-fsm-adapter).
    const videoOrch = require('../runtime/video-fsm-port').videoFsm();
    const jobSchema = require('@animastor/contracts').jobProtocolV2;
    const groups = jobSpecs.map(js => {
        const parsed = jobSchema.parseJobId(js.job_id);
        return {
            suffix: parsed?.groupSuffix || '',
            unit_ids: Array.isArray(js.unit_ids) ? js.unit_ids : [],
        };
    });
    log(`VIDEO_DISPATCH: ${bookId}/${chapterId}/${sceneId} groups=[${groups.map(g => `'${g.suffix || '(base)'}'(${g.unit_ids.length}u)`).join(', ')}]`);

    // ── OLD-STATE SNAPSHOT ДО initState ──
    // initState перезаписывает state, поэтому состав групп прошлого диспатча
    // нужно запомнить ДО него. Используется для валидации cache-hit: группа
    // считается готовой только если её unit_ids ТОЧНО совпадают с прошлой
    // группой того же суффикса (границы групп могут сдвинуться при изменении
    // длительностей юнитов — тогда старый файл устарел, даже если нет dirty).
    const prevState = await videoOrch.getState(redis, bookId, chapterId, sceneId);
    const prevGroupsBySuffix = new Map();
    if (prevState && Array.isArray(prevState.groups)) {
        for (const g of prevState.groups) {
            prevGroupsBySuffix.set(g.suffix || '', g);
        }
    }
    await videoOrch.initState(redis, bookId, chapterId, sceneId, buildId, groups);

    // ── DIRTY-UNITS: читаем из PG (как в executeImageDispatch) — O-2: via PersistencePort ──
    let dirtyUnitIds = new Set();
    try {
        const ids = await persist('sceneAssets.getDirtyUnitIds')(bookId, chapterId, sceneId);
        if (ids && ids.length > 0) {
            dirtyUnitIds = new Set(ids);
            log(`[DIRTY-UNITS] video ${bookId}/${chapterId}/${sceneId}: ${ids.length} dirty unit(s) from PG`);
        }
    } catch (err) {
        warn(`[DIRTY-UNITS] video PG read failed for ${bookId}/${chapterId}/${sceneId}: ${err.message}`);
    }

    // ── ЧАСТИЧНЫЙ RE-DISPATCH: пропускаем группы, чьи файлы уже готовы ──
    // Группа считается готовой (cache-hit), если:
    //   1. её файл валиден на диске, И
    //   2. ни один unit группы не dirty (dirty → перегенерация группы).
    // Пропущенные группы сразу помечаем done в video-orch state.
    const jobsToSend = [];
    let cachedGroups = 0;
    for (let i = 0; i < jobSpecs.length; i++) {
        const js = jobSpecs[i];
        const grp = groups[i];
        const hasDirty = grp.unit_ids.some(u => dirtyUnitIds.has(u));
        const fileOk = videoOrch.isGroupFileValid(buildId, bookId, chapterId, sceneId, grp.suffix);
        // Cache-hit только при ТОЧНОМ совпадении unit_ids с прошлой группой того
        // же суффикса: если границы групп сдвинулись (длительности изменились),
        // старый файл содержит другие юниты → перегенерируем, даже без dirty.
        const prev = prevGroupsBySuffix.get(grp.suffix || '');
        const sameComposition = !!(prev && Array.isArray(prev.unit_ids)
            && prev.unit_ids.length === grp.unit_ids.length
            && grp.unit_ids.every(u => prev.unit_ids.includes(u)));
        if (!hasDirty && fileOk && sameComposition) {
            await videoOrch.markGroupDone(redis, bookId, chapterId, sceneId, grp.suffix);
            cachedGroups++;
            log(`VIDEO_DISPATCH: ${bookId}/${chapterId}/${sceneId} group '${grp.suffix || '(base)'}' cached on disk — skipped`);
        } else {
            // Группа перегенерируется: старый файл удаляем, чтобы при
            // сбое re-dispatch не остался stale-чанк, посчитанный валидным.
            if (fileOk) {
                try {
                    const stalePath = videoOrch.groupFilePath(buildId, bookId, chapterId, sceneId, grp.suffix);
                    require('fs').unlinkSync(stalePath);
                    log(`VIDEO_DISPATCH: removed stale group file ${grp.suffix || '(base)'} for re-generation`);
                } catch (_) {}
            }
            jobsToSend.push(js);
        }
    }

    // ── ВСЕ ГРУППЫ УЖЕ ГОТОВЫ (полный cache-hit) → fast-track ──
    if (jobsToSend.length === 0 && cachedGroups > 0) {
        log(`VIDEO_DISPATCH: ${bookId}/${chapterId}/${sceneId} — all ${cachedGroups} group(s) cached, fast-track merge`);
        const result = await videoOrch.completeGroup(redis, bookId, chapterId, sceneId, '', buildId, {
            orchestrator,
            dispatchId,
        });
        if (result && result.completed) {
            return { dispatched: false, jobs: 0, completed: true, reason: 'cache_hit' };
        }
        // Провал fast-track склейки (в т.ч. merge in progress): job'ы не
        // отправлялись и отправлять нечего. Не возвращаем send_failed —
        // scheduler передиспатчит сцену, а merge-ретрай сделает completeGroup.
        warn(`VIDEO_DISPATCH: fast-track merge did not complete for ${bookId}/${chapterId}/${sceneId} (${result?.reason || 'unknown'}) — returning merge_retry`);
        return { dispatched: false, jobs: 0, reason: result?.reason === 'merging' ? 'merge_in_progress' : 'merge_retry' };
    }

    // Add per-type timeout to each job spec
    for (const jobSpec of jobsToSend) {
        if (videoTimeoutMs) {
            jobSpec.timeout_ms = videoTimeoutMs;
        }
    }

    // ── WAITING_CHUNKS ставится ДО отправки job'ов (race condition,
    // аналогично аудио): первый результат не должен попасть в GENERATING.
    await videoOrch.setWaitingChunks(redis, bookId, chapterId, sceneId);

    let sentCount = 0;
    // Stage 116 (D3) / Stage 118 (M3): collect WHY a job was not sent — the
    // dominant reason becomes the deferral reason (bounded backoff) instead
    // of the generic 'send_failed'.
    const notSentReasons = new Map();
    for (const jobSpec of jobsToSend) {
        try {
            let sendResult = await provider.generate(jobSpec);
            // Stage 122 (N2): the group file was probed absent above (a cached
            // group never reaches this loop), so an `already_completed` verdict
            // is by construction an ORPHANED completion marker. Free it and
            // retry ONCE so the video regenerates instead of looping on a
            // 900 s deferral with the scene stuck in the active index (audit
            // 121 · N2). The release rides the persistence port — the
            // orchestration tier cannot require the backend helper directly.
            // Skipped when the port is unwired (harnesses that don't exercise
            // orphan cleanup); production always wires it in backend.cjs.
            if (isPersistencePortWired()) {
                let released = false;
                try {
                    released = await persist('idem.releaseTaskDoneIfOrphan')(redis, sendResult);
                } catch (_) { released = false; }
                if (released) {
                    log(`VIDEO_DISPATCH: orphaned completion marker released for ${jobSpec.job_id} — regenerating`);
                    sendResult = await provider.generate(jobSpec);
                }
            }
            if (sendResult.sent) {
                sentCount++;
            } else {
                const reason = sendResult.reason || 'send_failed';
                notSentReasons.set(reason, (notSentReasons.get(reason) || 0) + 1);
                warn(`VIDEO_DISPATCH: Hub rejected job ${jobSpec.job_id}: ${sendResult.error || reason}`);
            }
        } catch (sendErr) {
            notSentReasons.set('send_failed', (notSentReasons.get('send_failed') || 0) + 1);
            warn(`VIDEO_DISPATCH: provider generate failed for job ${jobSpec.job_id}: ${sendErr.message}`);
        }
    }

    if (sentCount > 0) {
        log(`VIDEO_DISPATCHED: ${bookId}/${chapterId}/${sceneId} (${sentCount}/${jobsToSend.length} job(s) sent, ${cachedGroups} cached)`);
        return { dispatched: true, jobs: sentCount, reason: null };
    }

    // Stage 116 (D3) / Stage 118 (M3): the shared taxonomy decides whether
    // the outcome is a bounded deferral. EVERY reason must be deferrable —
    // a single real failure (send_failed) keeps the historic 'send_failed'
    // semantics (an immediate retry on the next tick).
    const deferReason = classifyNotSentReasons(notSentReasons) || 'send_failed';
    warn(`VIDEO_DISPATCH: ${bookId}/${chapterId}/${sceneId}: nothing enqueued (${deferReason})`);
    return { dispatched: false, jobs: 0, reason: deferReason, retryable: true };
}

// T4: dispatchStage принимает dispatchId (из dispatch-engine) и передаёт executors
async function dispatchStage(redis, scene, loadedBook, buildId, overrideStage, dispatchId) {
    const bookId = scene.book_id;
    const chapterId = scene.chapter_id;
    const sceneId = scene.scene_id;

    log(`DISPATCH: ${bookId}/${chapterId}/${sceneId} (stage=${overrideStage}, dispatch=${dispatchId ? dispatchId.slice(0, 20) : 'none'}...)`);

    const assetStates = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    const isNewScene = !assetStates || (
        assetStates.audio === state.AssetState.NEW &&
        assetStates.image === state.AssetState.NEW &&
        assetStates.video === state.AssetState.NEW
    );
    if (isNewScene) {
        log(`NEW SCENE: ${bookId}/${chapterId}/${sceneId} (asset-state)`);
        await startScene(redis, scene, loadedBook, buildId);
    }

    if (!overrideStage) {
        log(`DECISION: ${bookId}/${chapterId}/${sceneId} -> skip (no override stage)`);
        return { dispatched: false, reason: 'no_override' };
    }

    // S-2: dispatch through registry-driven executor map
    const executor = EXECUTORS[overrideStage];
    if (!executor) {
        if (!mediaRegistry.hasMediaType(overrideStage)) {
            warn(`DISPATCH: Unknown stage ${overrideStage} for ${bookId}/${chapterId}/${sceneId}`);
        } else {
            warn(`DISPATCH: No executor registered for stage ${overrideStage} for ${bookId}/${chapterId}/${sceneId}`);
        }
        return { dispatched: false, reason: 'unknown_stage' };
    }
    result = await executor(redis, scene, loadedBook, buildId, dispatchId);

    result = result || { dispatched: false, reason: 'no_result', jobs: 0 };
    if (!result.dispatched && !result.completed) {
        // FSM-валидный rollback (GENERATING → DIRTY → PENDING). Прямой
        // generating→pending запрещён FSM; раньше здесь вызывался setScenePending,
        // rejection молча проглатывался — и сцена навсегда оставалась в GENERATING
        // (ghost, forensic audit 6929ba5: no_jobs_sent → cancelled → вечный skip).
        const rollback = await orchestrator.rollbackStageToPending(
            redis, bookId, chapterId, sceneId, overrideStage, buildId,
            result.reason || 'dispatch_cancelled'
        );
        if (!rollback.changed && !rollback.alreadyPending && rollback.reason !== 'already_ready') {
            // Ошибка rollback не глотается: явный лог + флаг в результате
            // (метрику/journal пишет сам rollbackStageToPending).
            warn(`DISPATCH_ROLLBACK_FAILED: ${bookId}/${chapterId}/${sceneId} ${overrideStage}: ${rollback.reason} — stage may be stuck in GENERATING`);
            result.rollbackFailed = true;
            result.rollbackReason = rollback.reason;
        }
    }
    result.dispatchId = dispatchId; // T4: привязываем dispatchId к результату
    log(`DISPATCH_RESULT: ${bookId}/${chapterId}/${sceneId} ${overrideStage}: dispatched=${result.dispatched}, jobs=${result.jobs}, reason=${result.reason || 'ok'}`);
    return result;
}

module.exports = {
    ensureStageDispatchable,
    clearTerminalAudioOrchForDirty,
    dispatchStage,
    restoreSceneChunkStatus,
    handleAudioCompleted,
    handleImageCompleted,
    handleVideoCompleted,
    completeStage,
    failStage,
};
