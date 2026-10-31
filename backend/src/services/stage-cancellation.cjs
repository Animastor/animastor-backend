// ======================================================
// Stage cancellation — one host routine for every "stop this stage" command
// ======================================================
// Command-only generation (2026-10-31, animastor-docs
// architecture/COMMAND_ONLY_GENERATION.md). A cancelled stage must leave NO
// trace another path could pick up as queued work:
//
//   • task registry  — active tasks of the stage → cancelled (Redis + PG rows);
//   • dispatch leases of the stage → cancelled (quota released);
//   • GPU hub lane copies of those dispatches → cleared;
//   • GENERATING states left without a lease → DIRTY (never PENDING);
//   • active index   — scenes with no command-authorized stage left → removed;
//   • PG scene_assets — `pending` rows of the stage → `cancelled`
//                       (`ready`/`placeholder`/`stale` untouched).
//
// Used by POST /cancel-worker (type or task_id), PUT /layer-config
// (X_enabled=false) and, for the PG leg, POST /cancel-generation.
// ======================================================

'use strict';

/**
 * @param {object} p
 * @param {object} p.redis
 * @param {string} p.bookId
 * @param {string} p.stage            — 'audio' | 'image' | 'video'
 * @param {object[]|null} p.tasks     — the registry tasks to cancel; null =
 *                                      every ACTIVE task of the stage
 * @param {boolean} p.wholeBook       — true: leases/assets of the stage for the
 *                                      whole book; false: only task targets
 * @param {string} p.reason           — journal/PG reason
 * @param {string} p.context          — log context (CANCEL-WORKER / LAYER-CONFIG)
 * @param {object} p.deps             — { generationProgress, taskRepo,
 *        sceneAssetsRepo, dispatchEngine, scheduler, commandGate, config, log }
 */
async function cancelStage(p) {
    const { redis, bookId, stage, wholeBook, reason, context, deps } = p;
    const {
        generationProgress, taskRepo, sceneAssetsRepo, dispatchEngine,
        scheduler, commandGate, config,
    } = deps;
    const log = deps.log || (msg => console.log(msg));
    const summary = { stage, tasks: [], scenes: 0, leases: 0, released: 0, removedFromIndex: 0, assetRows: 0 };

    // 1. Task registry + PG task rows
    const tasks = p.tasks || await generationProgress.getActiveTasksByType(redis, bookId, stage);
    for (const task of tasks) {
        await generationProgress.markCancelled(redis, bookId, task.task_id);
        summary.tasks.push(task.task_id);
        try {
            await taskRepo.updateTaskStatus(task.task_id, 'cancelled', reason);
        } catch (pgErr) {
            console.warn(`[${context}] Failed to persist cancellation for ${task.task_id}: ${pgErr.message}`);
        }
    }
    if (wholeBook && typeof taskRepo.cancelActiveTasksForBookByType === 'function') {
        try {
            await taskRepo.cancelActiveTasksForBookByType(bookId, stage, reason);
        } catch (pgErr) {
            console.warn(`[${context}] Failed to cancel ${stage} task rows for ${bookId}: ${pgErr.message}`);
        }
    }

    // Scenes whose stage is cancelled. Task-scoped cancels skip scenes still
    // covered by ANOTHER active task of the same type.
    let scenes = null; // null = whole book
    if (!wholeBook) {
        scenes = [];
        const seen = new Set();
        for (const task of tasks) {
            for (const target of task.targets || []) {
                const remaining = await generationProgress.getSceneTaskState(
                    redis, bookId, target.chapter_id, target.scene_id);
                if (remaining.activeTypes.has(stage)) continue;
                const k = `${target.chapter_id}:${target.scene_id}`;
                if (seen.has(k)) continue;
                seen.add(k);
                scenes.push({ chapter_id: target.chapter_id, scene_id: target.scene_id, stages: [stage] });
            }
        }
    }

    // 2. Leases + 3. hub lane copies
    let cancellation = { dispatchIds: [] };
    if (scenes === null) {
        cancellation = await dispatchEngine.clearLeasesForBookByStage(redis, bookId, stage);
    } else if (scenes.length > 0) {
        cancellation = await dispatchEngine.clearLeasesForScenes(redis, bookId, scenes);
    }
    summary.leases = (cancellation.dispatchIds || []).length;
    await dispatchEngine.clearHubDispatches(cancellation.dispatchIds || [], {
        hubUrl: config.HUB_URL,
        apiKey: config.GPU_HUB_API_KEY,
        context,
        warn: message => console.warn(message),
    });

    // 4. GENERATING without a live dispatch → DIRTY, and 5. active index.
    const bookPrefix = `${bookId}:`;
    const activeKeys = (await scheduler.getActiveSceneKeys(redis)).filter(k => k.startsWith(bookPrefix));
    const candidates = new Map();
    for (const k of activeKeys) {
        const parsed = scheduler.parseSceneKey(k);
        if (parsed) candidates.set(`${parsed.chapterId}:${parsed.sceneId}`, parsed);
    }
    for (const s of scenes || []) {
        candidates.set(`${s.chapter_id}:${s.scene_id}`, { bookId, chapterId: s.chapter_id, sceneId: s.scene_id });
    }
    const wanted = scenes === null ? null : new Set(scenes.map(s => `${s.chapter_id}:${s.scene_id}`));
    for (const [k, c] of candidates) {
        if (wanted && !wanted.has(k)) continue;
        summary.scenes++;
        const evidence = await dispatchEngine.getDispatchEvidence(redis, bookId, c.chapterId, c.sceneId, stage);
        if (!evidence.alive) {
            const rb = await commandGate.rollbackGeneratingToDirty(
                redis, bookId, c.chapterId, c.sceneId, stage, `${context.toLowerCase()}_cancel`);
            if (rb.changed) summary.released++;
        }
        const auth = await commandGate.getAuthorizedStages(redis, bookId, c.chapterId, c.sceneId);
        if (auth.stages.size === 0) {
            const r = await scheduler.removeSceneFromActiveIndex(redis, bookId, c.chapterId, c.sceneId);
            if (r && r.removed) summary.removedFromIndex++;
        }
    }

    // 6. PG scene_assets pending → cancelled
    try {
        summary.assetRows = await sceneAssetsRepo.cancelPendingAssets(
            bookId, [stage], scenes === null ? null : scenes, reason);
    } catch (pgErr) {
        console.warn(`[${context}] Failed to cancel pending ${stage} scene_assets for ${bookId}: ${pgErr.message}`);
    }

    log(`[${context}] ${bookId}: ${stage} cancelled — tasks=${summary.tasks.length} scenes=${scenes === null ? 'book' : scenes.length} leases=${summary.leases} released=${summary.released} index-=${summary.removedFromIndex} pg_pending→cancelled=${summary.assetRows}`);
    return summary;
}

module.exports = { cancelStage };
