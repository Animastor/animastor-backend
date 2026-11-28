// ======================================================
// Book Generation Routes — layer-config, cancel-worker
// ======================================================
// 2026-11-28 (ORCHESTRATION_V2 §11.3, шаг 5 разведки): /generate-next,
// /cancel-generation and /regenerate are removed together with their v2
// branches — the generate API v2 (/generate, /generate/stop, /generate/progress,
// /generate/stream; orchestration-v2/routes.js) replaces them. cancel-worker
// stays until task H (VBook / cover stop).
// 2026-11-28 (этап 4, шаги 4/7): every book is on orchestration v2 — the
// legacy halves of PUT layer-config and cancel-worker (stage cancellation,
// legacy leases, the Redis task registry) are removed; what is not
// orchestration work (VBook) keeps its own branch.

const generationCancelRepo = require('../../storage/postgres/repositories/generation-cancel-repo');
// S-1 (Generation extraction seam): the ONLY VBook leg allowed in this
// generation route layer is the narrow AgentSessionControl port
// (VBook-owned — see services/agent-session-control.js). Raw
// agent_sessions/book_generation_sessions SQL must not live here.
const { createAgentSessionControl } = require('../../services/agent-session-control');

module.exports = function(app, redis, deps) {
    const { layerConfig, utils, agentSessionControl } = deps;
    const { log } = utils;

    const sessionControl = agentSessionControl || createAgentSessionControl();

    // Orchestration v2 handlers arrive through deps (composition root).
    const orchV2 = deps.orchV2 || null;
    const requireOrchV2 = () => {
        if (!orchV2) throw new Error('generation-routes: deps.orchV2 is not wired (composition root)');
        return orchV2;
    };

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
            const off = ['audio', 'image', 'video'].filter((stage) =>
                (req.body || {})[`${stage}_enabled`] === false && cfg[`${stage}_enabled`] === false);
            const cancelledStages = await requireOrchV2().onLayersDisabled(bookId, off);

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
    // CANCEL WORKER — until task H
    // ======================================================
    // Orchestration v2 handles a command (task_id = command_id), a layer
    // (type audio / image / video) and cover (nothing to stop). What is left
    // is the VBook agent (type vbook): it is not orchestration work.
    app.post('/api/v1/book/:bookId/cancel-worker', async (req, res) => {
        try {
            const { bookId } = req.params;
            const { type } = req.body || {};
            const handled = await requireOrchV2().cancelWorker(req, res);
            if (handled !== false) return undefined;
            if (type !== 'vbook') {
                return res.status(400).json({
                    error: 'Provide task_id (command id) or a worker type: audio, image, video, cover, vbook',
                });
            }

            log(`[CANCEL-WORKER] ${bookId}: cancelling type=vbook`);
            // VBook/AI agent: the live VBook paths (bootstrap, pipeline-runner,
            // import windows) read this flag until task H.
            await redis.sadd(`animastor:cancelled-workers:${bookId}`, 'vbook');
            await redis.expire(`animastor:cancelled-workers:${bookId}`, 3600);
            try {
                await sessionControl.cancelSessions(bookId);
                log(`[CANCEL-WORKER] ${bookId}: VBook agent sessions cancelled`);
            } catch (pgErr) {
                console.warn(`[CANCEL-WORKER] Failed to cancel VBook session: ${pgErr.message}`);
            }
            try {
                await generationCancelRepo.setCancelled(bookId, { reason: 'user_cancelled', createdBy: 'cancel-worker:vbook' });
            } catch (tombErr) {
                console.warn(`[CANCEL-WORKER] Failed to persist cancellation tombstone for ${bookId}: ${tombErr.message}`);
            }
            res.json({ ok: true, book_id: bookId, cancelled: ['vbook'], task_ids: [] });
        } catch (err) {
            console.error('[CANCEL-WORKER] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

};
