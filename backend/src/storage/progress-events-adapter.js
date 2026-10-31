// ======================================================
// HOST ADAPTER: ProgressEventsAdapter — O-5 ProgressEventsPort impl
// ======================================================
// Host-side implementation of the O-5 ProgressEventsPort
// (runtime/progress-events-port.js). Owns every concrete progress detail
// the runtime/orchestration tiers must not know: the Redis pub/sub
// channel (`animastor:progress:<bookId>`) inside services/progress-pubsub
// and the generation task-registry hash namespace
// (`animastor:generation-progress:<bookId>`) inside
// services/generation-progress.
//
//   runtime/progress-events-port    (tier-owned contract)
//       ↑ wired by backend.cjs (composition root)
//   storage/progress-events-adapter ← THIS FILE (host impl)
//
// Lazy call-time resolvers — never capture the module instance at load
// time. This keeps require.cache-based test stubbing working exactly as
// before (the O-2/O-3/O-4 adapter discipline): a harness that stubs
// `../src/services/generation-progress` (image-orphan-generating-repair
// P.genProgress purge + reload, scope-slide direct requires) or relies
// on module-reload re-resolution (worklist-rebuild MOCKED_PATHS) keeps
// intercepting these ops through this adapter.
//
// Behavior contract: every method is a 1:1 delegation to the pre-O-5
// call — identical modules, identical arguments, identical return values
// (including the best-effort never-throw semantics of publishProgress
// and the { managed, activeTypes } task-state shape) and identical
// error/catch semantics. No progress behavior changed.
//
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §32.7 (O-P4, O-5)
// ======================================================

// Lazy call-time resolvers — the host service channels every pre-O-5
// harness stubs (`require.resolve('../src/services/generation-progress')`,
// the progress-pubsub module the SSE routes also consume).
const progressPubsub = () => require('../services/progress-pubsub.cjs');
const generationProgress = () => require('../services/generation-progress');

function publishProgress(redis, bookId, event) {
    return progressPubsub().publishProgress(redis, bookId, event);
}

function getSceneTaskState(redis, bookId, chapterId, sceneId) {
    return generationProgress().getSceneTaskState(redis, bookId, chapterId, sceneId);
}

function hasActiveTasks(redis, bookId) {
    return generationProgress().hasActiveTasks(redis, bookId);
}

function reconcileCompletedTasks(redis, bookId, getAssetStates) {
    return generationProgress().reconcileCompletedTasks(redis, bookId, getAssetStates);
}

// Command-only generation (2026-10-31): the tier reports "no live worker of
// this type" for a scene×stage; the host blocks the command in every store
// it owns — task registry (blocked, reason «нет воркера <type>»), PG
// generation_tasks (blocked) and the PG scene_assets row the dispatch stamp
// left `pending` (→ failed with the reason; ready rows untouched). PG legs are
// best-effort: the registry write alone already revokes the authorization.
async function blockSceneStage(redis, bookId, chapterId, sceneId, type, reason) {
    const result = await generationProgress().blockSceneStage(redis, bookId, chapterId, sceneId, type, reason);
    const taskRepo = require('./postgres/repositories/task-repo');
    for (const task of result.tasks || []) {
        try {
            await taskRepo.updateTaskStatus(task.task_id, 'blocked', reason);
        } catch (err) {
            console.warn(`[PROGRESS-EVENTS] PG block of task ${task.task_id} failed: ${err.message}`);
        }
    }
    try {
        const sceneAssetsRepo = require('./postgres/repositories/scene-assets-repo');
        result.assetRows = await sceneAssetsRepo.markPendingAssetsFailed(
            bookId, [type], [{ chapter_id: chapterId, scene_id: sceneId }], `blocked:${reason}`);
    } catch (err) {
        console.warn(`[PROGRESS-EVENTS] PG scene_assets block for ${bookId}/${chapterId}/${sceneId}:${type} failed: ${err.message}`);
    }
    return result;
}

module.exports = {
    publishProgress,
    getSceneTaskState,
    hasActiveTasks,
    reconcileCompletedTasks,
    blockSceneStage,
};
