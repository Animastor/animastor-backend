// ======================================================
// Book Generation Routes — layer-config, cancel-worker
// ======================================================
// 2026-11-28 (ORCHESTRATION_V2 §11.3, шаг 5 разведки): /generate-next,
// /cancel-generation and /regenerate are removed together with their v2
// branches — the generate API v2 (/generate, /generate/stop, /generate/progress,
// /generate/stream; orchestration-v2/routes.js) replaces them. cancel-worker
// stays until task H (VBook / cover stop).

const sceneAssetsRepo = require('../../storage/postgres/repositories/scene-assets-repo');
const generationProgress = require('../../services/generation-progress');
const dispatchEngine = require('@animastor/orchestration').runtime.dispatch;
const taskRepo = require('../../storage/postgres/repositories/task-repo');
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

// Task-registry statuses of a command that stopped without finishing
// (generation-progress: blockSceneStage / failSceneStage / interruptActiveTasks).
const STOPPED_TASK_STATUSES = new Set(['blocked', 'interrupted', 'failed']);

module.exports = function(app, redis, deps) {
    const { config, runtime, layerConfig, utils, agentSessionControl } = deps;
    const { log } = utils;

    const sessionControl = agentSessionControl || createAgentSessionControl();

    // Orchestration v2 (books.orchestration='v2'): handlers arrive through deps
    // (composition root). Legacy books never reach them; without deps.orchV2
    // (tests) every book is legacy.
    const orchV2 = deps.orchV2 || null;
    const isV2 = async (bookId) => !!(orchV2 && await orchV2.isV2Book(bookId));

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
    // LAYER CONFIG (read / write) — defaults for initial/bulk generation
    // ======================================================
    app.get('/api/v1/book/:bookId/layer-config', async (req, res) => {
        try {
            const { bookId } = req.params;
            const cfg = await layerConfig.get(bookId);
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
            const cfg = await layerConfig.set(bookId, {
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
            if (await isV2(bookId)) {
                const off = ['audio', 'image', 'video'].filter((stage) =>
                    (req.body || {})[`${stage}_enabled`] === false && cfg[`${stage}_enabled`] === false);
                cancelledStages.push(...await orchV2.onLayersDisabled(bookId, off));
            } else for (const stage of mediaRegistry.listMediaTypes()) {
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
            if (await isV2(bookId)) {
                const handled = await orchV2.cancelWorker(req, res);
                if (handled !== false) return undefined;          // vbook / cover → legacy branch below
            }

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
            let stoppedTask = null;
            if (taskId) {
                const task = await generationProgress.getTask(redis, bookId, taskId);
                if (!task) return res.status(404).json({ error: 'Generation task not found' });
                resolvedType = task.type;
                // 2026-11-05 (задача K, «■ Снять» on a stopped row): a repeat
                // cancel of an already cancelled task is idempotent — same
                // answer, nothing touched again.
                if (task.status === 'cancelled') {
                    log(`[CANCEL-WORKER] ${bookId}: task=${taskId} already cancelled (idempotent)`);
                    return res.json({
                        ok: true, book_id: bookId, cancelled: [resolvedType], task_ids: [task.task_id || taskId],
                    });
                }
                if (task.status === 'active') {
                    tasks = [task];
                } else if (STOPPED_TASK_STATUSES.has(task.status)) {
                    // blocked / interrupted / failed: the command stopped
                    // without finishing and stays visible until superseded or
                    // removed by the user. «Снять» cancels ONLY this task
                    // (registry + PG rows) and releases its leftovers through
                    // the same task-scoped path as an active row — never a
                    // book-wide flag / tombstone, never other tasks.
                    tasks = [task];
                    stoppedTask = task;
                }
                // completed: nothing to cancel, left untouched.
            } else if (cancelValidTypes.includes(type) && type !== 'cover' && type !== 'vbook') {
                tasks = await generationProgress.getActiveTasksByType(redis, bookId, type);
            }

            log(`[CANCEL-WORKER] ${bookId}: cancelling type=${resolvedType} task=${taskId || 'all'}${stoppedTask ? ` (stopped: ${stoppedTask.status})` : ''}`);

            if (stoppedTask && !mediaRegistry.listMediaTypes().includes(resolvedType)) {
                // A stopped non-media task (cover / vbook): registry + PG row
                // only. The vbook / cover branches below act book-wide.
                await generationProgress.markCancelled(redis, bookId, stoppedTask.task_id);
                try {
                    await taskRepo.updateTaskStatus(stoppedTask.task_id, 'cancelled', `cancel-worker:task:${taskId}`);
                } catch (pgErr) {
                    console.warn(`[CANCEL-WORKER] Failed to persist cancellation for ${stoppedTask.task_id}: ${pgErr.message}`);
                }
            } else if (resolvedType === 'vbook') {
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

};
