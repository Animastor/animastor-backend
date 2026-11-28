// ======================================================
// REDIS KEYSPACE OWNERSHIP REGISTRY (Phase 1 guardrail)
// ======================================================
// Single source of truth for "who owns which animastor:* Redis key family".
// Enforced by tests/architecture/redis-ownership.test.js.
// Docs: docs/architecture/PHASE_1_GUARDRAILS.md §Redis ownership.
//
// Fields per family:
//   pattern     — key pattern (':' segments, '*' matches any tail)
//   owner       — component that is the AUTHOR of the family
//   readers     — components that may read (owner included implicitly)
//   writers     — components that may write
//   crossModule — true if some writer is not the owner (recorded debt;
//                 Phase 1 documents it, fixes come in later phases)
//   note        — short rationale / debt pointer
//
// Components: 'backend' | 'gpu-hub' | 'worker' | 'ai-connector'
// (frontends never touch Redis directly).
//
// NOTE: more-specific patterns must sort AFTER the generic ones in the
// registry (the test picks the most specific match).

// 2026-11-28 (ORCHESTRATION_V2 §12 этап 4, шаг 7): the registry is reduced to
// the families still named by code — 55 legacy-orchestration / hub protocol-2
// families (active-scenes, asset-state, audio/video-orch, idempotency/intent/
// fence, iu-in-flight/progress, circuit, retry-budget, result/error/job, …)
// are gone with their writers; scripts/purge-legacy-redis.cjs deletes their
// leftover keys once. These remaining entries are LEGACY families whose
// literals survive only as data or in dead paths of shared modules this task
// keeps untouched (no live writer): runtime:*, runtime:active, dispatch-lease:*,
// dispatch-meta:*, iu-registry:*, audio-scene-lock:*, video-lock:*,
// scene-transition-lock:* (config/runtime-config REDIS constants), gen-scope:*
// (services/gen-scope.js), audio-merge-lock:* (audio/pipeline.js),
// video-merge-lock:* (video/video-merge.js), scene-video:* (video/video-service.js);
// queue:* / queue:*:policy:* (routes/worker-routes.cjs policy-lane drain — hub
// transport). The purge script deletes their keys too.
const REDIS_OWNERSHIP = [
    // ── GPU Hub job transport (hub-owned) ─────────────────────────────
    {
        pattern: 'animastor:queue:*',
        owner: 'gpu-hub',
        readers: ['gpu-hub'],
        writers: ['gpu-hub'],
        crossModule: true,
        note: 'Job lanes (system queue:{type} + derived ws/policy lanes). Hub enqueues on /task and rpoplpush into animastor:processing on /task/next. DEBT (Phase 5): backend worker-routes.cjs drainPolicyLane() RPOPLPUSHes between hub lanes and mutates task bodies.',
    },
    {
        pattern: 'animastor:queue:*:policy:*',
        owner: 'gpu-hub',
        readers: ['gpu-hub'],
        writers: ['gpu-hub'],
        crossModule: true,
        note: 'SH-2 users-policy lanes (queue:{type}:policy:{policy_id}). DEBT (Phase 5): backend worker-routes.cjs drainPolicyLane() mutates these hub-owned lanes on policy revoke/stop.',
    },
    {
        pattern: 'animastor:gpu-hub:workers',
        owner: 'gpu-hub',
        readers: ['backend'],
        writers: ['gpu-hub'],
        crossModule: true,
        note: 'Hub workers registry (hash, TTL 15min). DEBT (Phase 5): backend worker-routes.cjs purge does hdel() on this hub-owned registry.',
    },

    // ── Worker auth mirror (backend-owned) ───────────────────────────
    {
        pattern: 'animastor:worker-auth',
        owner: 'backend',
        readers: ['gpu-hub'],
        writers: ['backend'],
        crossModule: false,
        note: 'Token hash → worker identity mirror (services/worker-auth.js; PG is source of truth, mirror rebuilt on startup + every 5min). Hub READS for its hot path (gpu-hub.js WORKER_AUTH_MIRROR_KEY — SYNC pair). Only worker-auth.js may write it.',
    },

    // ── Worker heartbeat (hub-owned, backend reads) ──────────────────
    {
        pattern: 'animastor:worker:heartbeat:*',
        owner: 'gpu-hub',
        readers: ['backend'],
        writers: ['gpu-hub'],
        crossModule: true,
        note: 'Heartbeat keys (heartbeat:{type}:{worker_id}, TTL 30s, scope fields authored by the hub on beacon/claim/result). Backend worker-health.js READS them. DEBT: backend worker-routes.cjs purge DELs the key and worker-health.reportHeartbeat() is a legacy write path (kept for completeness); Phase 5 routes these through the hub API.',
    },

    // ── Backend runtime / orchestration (backend-owned) ──────────────
    {
        pattern: 'animastor:runtime:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Runtime state family: active counters, last-dispatch, metrics (current/history), persistence, quotas, renewal, recovery:actions, retry counters, scheduler history/lock/snapshot, stuck, total. Backend-internal (config.REDIS in runtime-config.js).',
    },
    {
        pattern: 'animastor:runtime:active',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Derived active counters (not source of truth) — dispatch-engine.',
    },
    {
        pattern: 'animastor:dispatch-lease:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Dispatch leases (lease-manager).',
    },
    {
        pattern: 'animastor:dispatch-meta:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Dispatch metadata (dispatch-engine).',
    },
    {
        pattern: 'animastor:iu-registry:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'IU registry (config REDIS.IU_REGISTRY_PREFIX; entity-cleanup purge).',
    },
    {
        pattern: 'animastor:cancelled-workers:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Cancellation audience markers (vbook / agent pipelines, generation routes).',
    },
    // animastor:layer-config:* — retired 2026-11-27: per-book layer config is
    // PG-only (book_layer_config, ORCHESTRATION_V2 §11.1); nothing reads or
    // writes the family any more.
    {
        pattern: 'animastor:gen-scope:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Gen-scope cache (services/gen-scope, redis-helpers).',
    },
    {
        pattern: 'animastor:prompt-profiles',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Prompt profile overrides (services/profile-override).',
    },
    {
        pattern: 'animastor:audio-merge-lock:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Audio merge lock per scene (audio pipeline, reconciliation-engine).',
    },
    {
        pattern: 'animastor:video-merge-lock:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Video merge lock per scene (video/video-merge).',
    },
    {
        pattern: 'animastor:video-book-merge-lock:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Book-level video merge lock (video/video-merge).',
    },
    {
        pattern: 'animastor:bootstrap-lock:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Per-book bootstrap lock (services/bootstrap-lock.js): one bootstrap / next-window run per book, NX EX 900 + heartbeat, owner-only release.',
    },
    {
        pattern: 'animastor:audio-scene-lock:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Audio scene lock (config REDIS.AUDIO_SCENE_LOCK_PREFIX family).',
    },
    {
        pattern: 'animastor:video-lock:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Video scene lock (config REDIS.VIDEO_SCENE_LOCK_PREFIX family).',
    },
    {
        pattern: 'animastor:scene-transition-lock:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Scene transition lock (config REDIS.SCENE_TRANSITION_LOCK_PREFIX).',
    },
    {
        pattern: 'animastor:scene-video:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Scene video registry (config REDIS.SCENE_VIDEO_PREFIX).',
    },
    {
        pattern: 'animastor:book-scenes:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Scene cursor per book (total / next-index).',
    },
    {
        pattern: 'animastor:pending-purge',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Pending purge queue (services/entity-cleanup).',
    },
    {
        pattern: 'animastor:pending-purge-attempts',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Purge attempt counters (services/entity-cleanup).',
    },
    {
        pattern: 'animastor:cleanup-lock',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Cleanup lock (config REDIS.CLEANUP_LOCK; cleanup-service, reconciliation-engine).',
    },

    // ── Book / content caches (backend-owned) ────────────────────────
    {
        pattern: 'animastor:chunk:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Book text chunk cache (redis-helpers).',
    },
    {
        pattern: 'animastor:chunks:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Chunk index sets (redis-helpers).',
    },
    {
        pattern: 'animastor:progress:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Generation progress markers.',
    },
    {
        pattern: 'animastor:vbook-scene-idx:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Agent-pipeline scene cursor per book (agent-routes, pipeline-runner).',
    },
    {
        pattern: 'animastor:ai-connector:hb:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Local AI Connector liveness mirrors on the backend (ai-connector-routes; TTL 45s). LAC itself talks WS, not Redis.',
    },
    {
        // Stage 114 — GPU queue idempotency identity. The claim keeps ONE
        // pending lane entry per logical task (workspace, job, build,
        // canonical params, generation epoch) so a re-dispatch with a new
        // dispatch_id cannot append a second copy. The done marker records a
        // REAL accepted result (a queue entry is never proof of completion).
        // The epoch counters make a justified retry / explicit regeneration
        // distinguishable from an ordinary re-dispatch.
        pattern: 'animastor:idempotency:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'GPU queue idempotency state: claim (one pending entry per logical task), done (accepted result), ref (job_id → identity, the ownership index of the done marker), job-epoch (per-task pinned intent epoch), stage-epoch (per-stage generation epoch).',
    },
    {
        // Stage 127 — durable current-intent fence (result fencing phase 1,
        // contract 126 §1). One record per LOGICAL task:
        // { fence, state, epoch, supersedes, updated_at }. The fence is the
        // existing idem_key; the record is the authority for WHICH fence is
        // current and survives restart (durable TTL outlives the claim).
        pattern: 'animastor:intent:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Durable current-intent fence per logical task (Stage 127): { fence, state: active|superseded|cancelled, epoch, supersedes, updated_at } — written/refreshed atomically with the dispatch receipt before the hub POST.',
    },
    {
        // Stage 127 — immutable dispatch receipt: the callback-side mapping
        // (dispatch_id, job_id) → fence. SET NX ONLY: a receipt is never
        // rewritten (a conflicting write is a terminal receipt_conflict).
        pattern: 'animastor:dispatch-intent:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Immutable dispatch→fence receipt (Stage 127): dispatch_id + job_id → fence, written atomically BEFORE the hub POST, SET NX only, 48 h TTL (covers hub result retention + claim backstop + outage).',
    },
    {
        // Stage 127 — fallback lock of ensureIntentAndReceipt for Redis
        // doubles without a working EVAL (production ioredis runs the atomic
        // Lua script and never touches this key). Short-lived (5 s).
        pattern: 'animastor:intent-lock:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Short-lived NX lock of the intent/receipt fallback path (Stage 127) — only used by Redis doubles without EVAL; production takes the Lua script.',
    },
    {
        // Stage 131 — durable publication manifest (contract 126 §3.4). The
        // authority for "what is currently published" for one logical task.
        // Written ONLY inside the atomic fenced commit, never before it, and
        // never from the existence of a file. Durable (no TTL): it is the
        // restart-recovery pointer that lets a committed-but-unrenamed
        // publication be replayed idempotently.
        pattern: 'animastor:artifact-manifest:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Durable publication manifest per logical task (Stage 131): { published_fence, path, build_id, bytes, published_at } — written atomically by the fenced commit, authority for "what to read"; a restart replays the staged→canonical rename from it, never from a bare file.',
    },
    {
        // Stage 131 — idempotent commit journal of one (task, fence). Replay
        // / operator-audit evidence that this exact fence was committed. TTL
        // mirrors the completion marker (7 d).
        pattern: 'animastor:fence-journal:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Idempotent fenced-commit journal per (task, fence) (Stage 131): the same manifest payload, TTL 7 d — restart replay / audit evidence that a fence was committed; never a sole publication authority.',
    },
    {
        // Stage 135 (audit 134 B6) — per-task publication marker. Records the
        // LAST publication attempt of the task: { fence, stage:'renaming' }
        // written durably BEFORE the staged→canonical rename, { fence,
        // stage:'published' } after it. It is the only proof that the shared
        // canonical path belongs to THIS fence (done/manifest only prove the
        // commit); a marker is never written for a rejected fence.
        pattern: 'animastor:fence-publish:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Per-task publication marker (Stage 135): fence + stage (renaming|published), TTL mirrors the done marker (7 d). Distinguishes "this fence is in canonical" from "an older generation leaves a file there"; drives retry/resume and the ready-metadata chain.',
    },
    {
        // GPU E2E 2026-11-02 (§6.2) — terminal record of a committed fence
        // whose canonical bytes diverged from the manifest with no staged
        // copy left. Stops the 60-second resume loop; bound to the fence.
        pattern: 'animastor:fence-unrecoverable:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'Per-task unrecoverable-publication record: { fence, reason, at, job_id, expected_sha256, expected_bytes }, no TTL. resumePendingPublications skips a fence that carries it (one warn when marked); a NEW fence is never skipped and a successful publication clears it.',
    },
    {
        // GPU retry policy (owner decision 2026-11-02, services/gpu-retry-policy.cjs).
        pattern: 'animastor:gpu-retry:*',
        owner: 'backend',
        readers: ['backend'],
        writers: ['backend'],
        crossModule: false,
        note: 'attempts:<book>:<task>:<ch>:<sc>:<stage> — attempt counter per (registry task × scene × stage) { failures, retries, history[≤10] }, EX 24 h. pending:<book>:<ch>:<sc>:<stage> — a scheduled retry { task_id, retry_no, due_at, boot_id, error_class, … }, EX 1 h; claimed by DEL when the pause ends, dropped (journaled interrupted) at backend start.',
    },
];

module.exports = { REDIS_OWNERSHIP };
