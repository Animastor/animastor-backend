// ======================================================
// ANIMASTOR BACKEND — GENERATION ROUTES
// ======================================================
// Generation / worker contours ONLY:
//   /api/v1/worker/counts, /api/v1/book/:id/progress-stream (until task H).
// POST /gpu/task/result and /gpu/task/error (protocol-2 GPU Hub callbacks)
// were removed 2026-11-28 (ORCHESTRATION_V2 §12 этап 4; hub v0.4.0 has no
// protocol 2): results reach the backend through /internal/gen/* (v2).
// POST /api/v1/generate (legacy multipart import + generation) and
// GET /api/v1/worker/status were removed 2026-11-28 (ORCHESTRATION_V2 §11.3);
// import is POST /api/v1/book/import, generation is POST /book/:id/generate.
//
// The playback (Player) HTTP contour — scene/chunk media serving, scene
// data, iu/preview, playback queue — was split out (4d1f6f0e) and then
// physically extracted to packages/animastor-player (@animastor/player,
// registered by backend.cjs through the package entrypoint; see
// docs/architecture/PLAYER_ROUTE_SPLIT_CHECKLIST.md). No playback handlers
// remain here (guarded by tests/architecture/player-route-split.test.js).
//
// Usage:
//   require('./routes/generation-routes.cjs')(app, redis, deps);

module.exports = function(app, redis, deps) {
    const { config, utils, agentSessionControl } = deps;
    const { log } = utils;

    // S-1 (Generation extraction seam): VBook agent-session state crosses
    // this boundary ONLY through the narrow AgentSessionControl port
    // (services/agent-session-control.js — VBook-owned). This route layer
    // must not know the agent_sessions/book_generation_sessions tables.
    const { createAgentSessionControl } = require('../services/agent-session-control');
    const sessionControl = agentSessionControl || createAgentSessionControl();

    // ======================================================
    // WORKER HEARTBEAT
    // ======================================================
    // NOTE: the legacy POST /api/v1/worker/heartbeat endpoint was REMOVED
    // (Experimental Beta — Private Worker Phase 1). It was unauthenticated,
    // unused by real workers (the GPU hub writes heartbeats itself), and —
    // worse — every anonymous POST auto-provisioned a guest + temporary
    // workspace via authContext, making it a DB row-churn vector. Worker
    // liveness now flows through the token-authenticated hub path; the
    // read-only counts endpoint below remains.

    // GET /api/v1/worker/status was removed 2026-11-28 (no callers in web /
    // Android; ORCHESTRATION_V2 §11.3). worker/counts stays.
    // VISIBILITY: global operational view — SYSTEM/shared pool only. Private
    // workers of any workspace never appear in these numbers (worker-health
    // classifies heartbeats by the hub-authored scope fields).
    app.get('/api/v1/worker/counts', async (req, res) => {
        try {
            // 2026-11-28 (этап 4, шаг 4): host module — no orchestration package.
            const workerHealth = require('../runtime/worker-health');

            // VISIBILITY: availability = liveness ∧ scope. The global fields
            // carry the SYSTEM/shared pool ONLY; the caller's OWN private
            // workers are reported separately (private_*) and are never mixed
            // into the global numbers. Guests/anonymous get zeros — workers
            // can only be created by registered users.
            const workspaceId = (req.user && req.workspace && req.workspace.id)
                ? req.workspace.id
                : null;
            const avail = await workerHealth.getAvailability(redis, workspaceId);

            // active_scenes: the legacy scheduler index (animastor:active-scenes)
            // is gone with the legacy orchestration (2026-11-28); the field stays
            // in the contract (web models.ts, Android WorkerCounts.kt) as 0.
            const activeCount = 0;

            // Only pulse when worker reports actual busy status via heartbeat (current_job_id).
            // Dispatch-lease keys are NOT a proxy for active work — they exist from dispatch
            // to completion (up to 30 min for video) and do NOT indicate worker activity.
            // Using leases would cause false toggle pulse whenever a heartbeat expires
            // during a long-running GPU job (heartbeat TTL=30s, image gen can be 15 min).
            // GPU hub refreshes heartbeat every 10s for running tasks, keeping busy accurate.
            const activeAudio = avail.system.audio > 0 ? avail.system_busy.audio : 0;
            const activeImage = avail.system.image > 0 ? avail.system_busy.image : 0;
            const activeVideo = avail.system.video > 0 ? avail.system_busy.video : 0;

            // VBook agent: check if the AI API is alive (key set + responds).
            // vbook = number of available AI agents (1 if alive, 0 if not).
            // active_vbook = 1 when a VBook agent session is actually running.
            // Health is workspace-aware: an authenticated workspace provider
            // (Experimental Beta) can be alive while the global env key is not
            // (and vice versa) — cache is keyed per provider inside ai-service.
            // S-1: the "is a VBook session running" leg goes through the
            // VBook-owned AgentSessionControl port (no agent_sessions SQL
            // in this generation route layer).
            const aiService = require('../services/ai-service');
            let workspaceProvider = null;
            if (req.workspace && req.workspace.id) {
                try {
                    const workspaceAi = require('../services/workspace-ai-provider');
                    workspaceProvider = await workspaceAi.resolveAIForWorkspace(req.workspace.id);
                } catch (_) { /* global fallback below */ }
            }
            const vbookCount = await aiService.checkAIHealth(config, workspaceProvider);
            let activeVBook = 0;
            try {
                activeVBook = await sessionControl.getActiveSessionCount();
            } catch (pgErr) {
                console.warn('[WORKER-COUNTS] Failed to query agent sessions:', pgErr.message);
            }

            res.json({
                // SYSTEM/shared pool — what every caller may use. A foreign
                // workspace's private worker is never part of these numbers.
                audio: avail.system.audio || 0,
                image: avail.system.image || 0,
                video: avail.system.video || 0,
                vbook: vbookCount,
                active_audio: activeAudio,
                active_image: activeImage,
                active_video: activeVideo,
                active_vbook: activeVBook,
                active_scenes: activeCount || 0,
                // The caller's OWN private workers (registered users only).
                private_audio: avail.private.audio || 0,
                private_image: avail.private.image || 0,
                private_video: avail.private.video || 0,
                private_active_audio: avail.private_busy.audio || 0,
                private_active_image: avail.private_busy.image || 0,
                private_active_video: avail.private_busy.video || 0,
                // PHYSICAL union for UI counters: system pool ∪ own private
                // workers, each PHYSICAL worker counted ONCE (dedup by
                // worker_id). Never sum audio+private_audio: per D3 a
                // policy-active private worker is in BOTH capacity buckets
                // but is ONE physical unit. Sharing grants access to an
                // existing worker — it does not create a new one.
                available_audio: avail.available.audio || 0,
                available_image: avail.available.image || 0,
                available_video: avail.available.video || 0,
                available_active_audio: avail.available_busy.audio || 0,
                available_active_image: avail.available_busy.image || 0,
                available_active_video: avail.available_busy.video || 0,
            });
        } catch (err) {
            // Do not hide the failure: the client still gets zeros, but the
            // reason is in the log (reports/2026-11-05/release-J.md §6.6).
            console.warn('[WORKER-COUNTS] failed: ' + (err && err.message));
            res.json({
                audio: 0, image: 0, video: 0,
                active_audio: 0, active_image: 0, active_video: 0,
                vbook: 0, active_vbook: 0,
                private_audio: 0, private_image: 0, private_video: 0,
                private_active_audio: 0, private_active_image: 0, private_active_video: 0,
                available_audio: 0, available_image: 0, available_video: 0,
                available_active_audio: 0, available_active_image: 0, available_active_video: 0,
            });
        }
    });

    // ======================================================
    // PROGRESS STREAM (SSE) — real-time GPU generation progress
    // ======================================================
    // Pushes per-layer increment events as the GPU confirms work, so the
    // frontend advances immediately instead of waiting for the next poll.
    // Polling /assets-state remains the source of truth / reconcile path;
    // these events are advisory hints. Mirrors the Assistant SSE pattern.
    const { channel: progressChannel } = require('../services/progress-pubsub.cjs');
    app.get('/api/v1/book/:bookId/progress-stream', async (req, res) => {
        const { bookId } = req.params;

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
        res.flushHeaders?.();

        // Tell the client we're connected (also primes proxies).
        res.write(`event: open\ndata: ${JSON.stringify({ book_id: bookId })}\n\n`);

        // Orchestration v2 (ADR §9, 2026-11-27; every book since 2026-11-28):
        // generation progress comes from the in-process hub fed by PG LISTEN
        // gen_progress — the old event shapes, no Redis. Stays until task H.
        let offV2 = null;
        try {
            if (deps.orchV2 && typeof deps.orchV2.subscribeLegacyProgress === 'function') {
                offV2 = deps.orchV2.subscribeLegacyProgress(bookId, (payload) => {
                    try { res.write(`data: ${JSON.stringify({ type: 'progress', ...payload })}\n\n`); } catch (_) {}
                });
            }
        } catch (err) {
            console.warn('[PROGRESS-STREAM] v2 subscribe failed:', err.message);
        }

        // Heartbeat comment keeps the connection alive through idle periods and
        // proxy timeouts. SSE comments (lines starting with ':') are ignored by
        // the client's event parser.
        const heartbeat = setInterval(() => {
            try { res.write(`: ping\n\n`); } catch (_) {}
        }, 15_000);

        // Redis pub/sub stays for what is NOT orchestration v2: VBook / import
        // events (pipeline-runner, bootstrap; until task H). Best effort: a Redis
        // outage never closes the stream while the v2 leg is subscribed
        // (subscribe is not awaited, a failure only drops the Redis leg).
        let sub = null;
        const ch = progressChannel(bookId);
        const onMessage = (chan, message) => {
            if (chan !== ch) return;
            try { res.write(`data: ${message}\n\n`); } catch (_) {}
        };
        let closed = false;
        const cleanup = () => {
            if (closed) return;
            closed = true;
            clearInterval(heartbeat);
            if (offV2) { try { offV2(); } catch (_) {} offV2 = null; }
            if (sub) {
                try { sub.removeListener('message', onMessage); } catch (_) {}
                try { sub.unsubscribe(ch).catch(() => {}); } catch (_) {}
                try { sub.disconnect(); } catch (_) {}
            }
        };
        req.on('close', cleanup);
        res.on('error', cleanup);

        // Dedicated subscriber connection — a SUBSCRIBE-mode client cannot run
        // normal commands, so we duplicate rather than reuse the shared client.
        let subscribed;
        try {
            sub = redis.duplicate();
            sub.on('message', onMessage);
            sub.on('error', (err) => {
                console.warn('[PROGRESS-STREAM] subscriber error:', err.message);
            });
            subscribed = Promise.resolve().then(() => sub.subscribe(ch));
        } catch (err) {
            subscribed = Promise.reject(err);
        }
        if (offV2) {
            subscribed.catch((err) => console.warn('[PROGRESS-STREAM] Redis subscribe failed (v2 events continue):', err.message));
        } else {
            try {
                await subscribed;
            } catch (err) {
                console.warn('[PROGRESS-STREAM] subscribe failed:', err.message);
                cleanup();
                try { res.end(); } catch (_) {}
            }
        }
    });

    log('[ROUTES] Generation routes loaded');
};
