// ======================================================
// gen/ports — host port contract + validation (ADR ORCHESTRATION_V2 §5)
// ======================================================
// The core knows nothing about books, ComfyUI or file naming. The host
// (backend) supplies these functions at initialisation; validatePorts()
// rejects a missing or malformed port before anything runs.
//
//   planUnits(book, scope, layer)  → Promise<Unit[]>
//        book  = {bookId, workspaceId, userId}
//        scope = {level, chapter_id?, scene_id?, unit_id?, scene_ids?}  (level 'scenes' → scene_ids, book order)
//        Unit  = {chapter_id, scene_id, kind, unit_key, build_id, input, scene_hash?}
//        build_id = the book build at command time (gen_jobs.build_id, §4.2)
//   buildPayload(job)              → Promise<object>  ComfyUI params etc. (claim, §8.1)
//   artifactPath(job)              → string           absolute final path (accept, §7 п.3)
//   validateResult(job, tmpPath)   → Promise<{ok, reason?}>  (§7 п.1; default: validate-media)
//   runLocal(job)                  → Promise<{path}>  executor='local' (merge); a file to accept
//   laneFor(workspaceId, workerType) → Promise<{kind, workspace_id?, policy_id?}>
//                                     (logic of gpu-dispatcher.js:213–222; default: makeLaneFor)
//   timeoutFor(kind)               → ms               (deadline = claimed_at + timeout, §4.2)
//   retryPolicy(kind, error_class, attempt, {previousErrorClass}) → {retry, delay_ms}
//                                     (values of gpu-retry-policy.cjs:50–53)
// Optional:
//   maxAttemptsFor(kind)           → int ≥ 1          (default: 1 + max retries of the policy)
//   isLayerEnabled(bookId, layer)  → Promise<boolean> (§6.3 «только если слой включён»; default true)
//   onArtifactPlaced(job, finalPath) → called inside the acceptance transaction right after the
//                                     rename (§7 п.3), e.g. to drop a placeholder sidecar marker

'use strict';

const { GenError, KINDS } = require('./util');

const REQUIRED = Object.freeze([
    'planUnits', 'buildPayload', 'artifactPath', 'validateResult',
    'runLocal', 'laneFor', 'timeoutFor', 'retryPolicy',
]);
const OPTIONAL = Object.freeze(['maxAttemptsFor', 'isLayerEnabled', 'onArtifactPlaced']);

// ── default retry policy: gpu-retry-policy.cjs:50–53 ─────────────────────
const RETRY_POLICY = Object.freeze({
    deterministic: Object.freeze({ retries: 0, pausesMs: Object.freeze([]) }),
    transient: Object.freeze({ retries: 2, pausesMs: Object.freeze([30_000, 120_000]) }),
    oom: Object.freeze({ retries: 1, pausesMs: Object.freeze([60_000]) }),
    unknown: Object.freeze({ retries: 0, pausesMs: Object.freeze([]) }),
    // ADR §7 / §13.4 (редакция 06.11): silence / broken file — one retry, then failed
    invalid_result: Object.freeze({ retries: 1, pausesMs: Object.freeze([30_000]) }),
});
/** v2 error classes produced by the core itself → policy class. */
const CLASS_ALIASES = Object.freeze({
    timeout: 'transient',          // sweeper: deadline passed (§9 п.1)
    worker_offline: 'transient',   // sweeper: worker silent > 60 s (§9 п.2)
});

function policyClass(errorClass) {
    const c = CLASS_ALIASES[errorClass] || errorClass;
    return RETRY_POLICY[c] ? c : 'unknown';
}

/**
 * @param {string} _kind
 * @param {string} errorClass
 * @param {number} attempt the attempt that just failed (1-based)
 * @param {{previousErrorClass?:string|null}} [ctx] error class of the attempt before
 */
function defaultRetryPolicy(_kind, errorClass, attempt, ctx = {}) {
    const cls = policyClass(errorClass);
    const p = RETRY_POLICY[cls];
    // invalid_result: ONE retry per job (counted by class, not by attempt number —
    // an earlier timeout must not eat it); a second invalid result → failed
    if (cls === 'invalid_result') {
        return ctx.previousErrorClass === 'invalid_result' ? { retry: false, delay_ms: 0 } : { retry: true, delay_ms: p.pausesMs[0] };
    }
    const idx = Math.max(0, (Number(attempt) || 1) - 1);
    if (idx < p.retries) return { retry: true, delay_ms: p.pausesMs[idx] ?? p.pausesMs[p.pausesMs.length - 1] ?? 0 };
    return { retry: false, delay_ms: 0 };
}

function defaultMaxAttemptsFor(_kind) {
    return 1 + Math.max(...Object.values(RETRY_POLICY).map((p) => p.retries));   // 3 (TRANSIENT)
}

// ── default timeouts: media-registry jobMs (generation default-registrations) ──
const TIMEOUT_MS = Object.freeze({
    audio_chunk: 30 * 60_000,
    iu_image: 30 * 60_000,
    video_group: 60 * 60_000,
    audio_merge: 10 * 60_000,
    video_merge: 20 * 60_000,
});
function defaultTimeoutFor(kind) { return TIMEOUT_MS[kind]; }

/**
 * Lane decision of gpu-dispatcher.js:213–222 over two host lookups:
 * book workspace has an active private worker of the type → private lane;
 * else a users-share grant policy → policy lane; else the system pool.
 * @param {{hasActivePrivateWorker:(ws,type)=>Promise<boolean>, grantPolicyLane:(ws,type)=>Promise<{policy_id}|null>}} lookups
 */
function makeLaneFor({ hasActivePrivateWorker, grantPolicyLane }) {
    if (typeof hasActivePrivateWorker !== 'function' || typeof grantPolicyLane !== 'function') {
        throw new GenError('bad_ports', 500, 'makeLaneFor needs hasActivePrivateWorker and grantPolicyLane');
    }
    return async function laneFor(workspaceId, workerType) {
        if (workspaceId && await hasActivePrivateWorker(workspaceId, workerType)) {
            return { kind: 'private', workspace_id: workspaceId };
        }
        if (workspaceId) {
            const lane = await grantPolicyLane(workspaceId, workerType);
            if (lane && lane.policy_id) return { kind: 'policy', policy_id: lane.policy_id };
        }
        return { kind: 'system' };
    };
}

/** Validate a lane object produced by laneFor. */
function checkLane(lane) {
    if (!lane || typeof lane !== 'object') return false;
    if (lane.kind === 'private') return typeof lane.workspace_id === 'string' && lane.workspace_id.length > 0;
    if (lane.kind === 'policy') return typeof lane.policy_id === 'string' && lane.policy_id.length > 0;
    return lane.kind === 'system';
}

/**
 * Validate the host ports at initialisation. Throws GenError('bad_ports').
 * @returns {object} frozen, normalised ports (optional ones defaulted)
 */
function validatePorts(ports) {
    if (!ports || typeof ports !== 'object') throw new GenError('bad_ports', 500, 'ports object required');
    const missing = REQUIRED.filter((n) => typeof ports[n] !== 'function');
    const badOptional = OPTIONAL.filter((n) => ports[n] !== undefined && typeof ports[n] !== 'function');
    if (missing.length || badOptional.length) {
        throw new GenError('bad_ports', 500,
            `ports: missing/invalid ${[...missing, ...badOptional].join(', ')}`);
    }
    const out = { ...ports };
    if (!out.maxAttemptsFor) out.maxAttemptsFor = defaultMaxAttemptsFor;
    if (!out.isLayerEnabled) out.isLayerEnabled = async () => true;
    for (const kind of KINDS) {
        const t = out.timeoutFor(kind);
        if (!Number.isFinite(t) || t <= 0) throw new GenError('bad_ports', 500, `timeoutFor(${kind}) must be > 0 ms, got ${t}`);
        const m = out.maxAttemptsFor(kind);
        if (!Number.isInteger(m) || m < 1) throw new GenError('bad_ports', 500, `maxAttemptsFor(${kind}) must be an integer >= 1`);
    }
    const probe = out.retryPolicy('audio_chunk', 'transient', 1);
    if (!probe || typeof probe.retry !== 'boolean' || !Number.isFinite(probe.delay_ms) || probe.delay_ms < 0) {
        throw new GenError('bad_ports', 500, 'retryPolicy must return {retry:boolean, delay_ms:number>=0}');
    }
    return Object.freeze(out);
}

module.exports = {
    REQUIRED_PORTS: REQUIRED,
    OPTIONAL_PORTS: OPTIONAL,
    RETRY_POLICY,
    TIMEOUT_MS,
    validatePorts,
    checkLane,
    policyClass,
    defaults: Object.freeze({
        retryPolicy: defaultRetryPolicy,
        maxAttemptsFor: defaultMaxAttemptsFor,
        timeoutFor: defaultTimeoutFor,
        makeLaneFor,
    }),
};
