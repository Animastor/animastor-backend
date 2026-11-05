// ======================================================
// COUNTER RECONCILIATION - CORRECT LEAKED COUNTERS
// ======================================================
// Compares active leases (source of truth) with counters.
// Automatically corrects counter drift.
//
// LEASES = source of truth
// COUNTERS = derived runtime optimization

const logPrefix = '[DRIFT]';

// S-2: registered stage list resolved from media registry
const mediaRegistry = require('@animastor/generation').mediaRegistry;

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
// CONFIGURATION
// ======================================================

const COUNTER_PREFIX = 'animastor:runtime:active';
const LEASE_PREFIX = 'animastor:dispatch-lease';

// ======================================================
// KEY GENERATORS
// ======================================================

function getCounterKey(stage) {
    return `${COUNTER_PREFIX}-${stage}`;
}

function getLeaseKeyPattern(stage) {
    return `${LEASE_PREFIX}:*:${stage}`;
}

// ======================================================
// COUNTER RECONCILIATION
// ======================================================

/**
 * Count active leases for a stage.
 */
async function countActiveLeasesByStage(redis, stage) {
    const pattern = getLeaseKeyPattern(stage);
    let cursor = 0;
    let count = 0;

    do {
        const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = parseInt(result[0], 10);
        count += result[1].length;
    } while (cursor !== 0 && count < 10000);

    return count;
}

/**
 * Get current counter value.
 */
async function getCurrentCounter(redis, stage) {
    const key = getCounterKey(stage);
    const val = await redis.get(key);
    return parseInt(val || '0', 10);
}

/**
 * Set counter value.
 */
async function setCounter(redis, stage, value) {
    const key = getCounterKey(stage);
    await redis.set(key, String(value));
    return { set: true, key, value };
}

/**
 * Atomically correct counter using Lua script.
 */
async function correctCounterWithLua(redis, stage, targetValue) {
    const key = getCounterKey(stage);
    const target = String(targetValue);

    // NOTE: no "expected" guard here — ioredis serializes null args to ""
    // which is truthy in Lua, so a guard would always fire and skip the SET.
    const luaScript = `
        local key = KEYS[1]
        local newval = ARGV[1]

        local current = redis.call('GET', key)

        redis.call('SET', key, newval)

        return {tostring(true), 'corrected', current, newval}
    `;

    const result = await redis.eval(luaScript, 1, key, target);

    return {
        success: result[0] === 'true',
        action: result[1],
        old: result[2],
        new: result[3],
        key
    };
}

/**
 * Get current counter with drift check.
 */
async function getCounterWithDriftCheck(redis, stage) {
    const leaseCount = await countActiveLeasesByStage(redis, stage);
    const counterValue = await getCurrentCounter(redis, stage);

    return {
        stage,
        leaseCount,
        counterValue,
        drift: counterValue - leaseCount,
        correct: counterValue === leaseCount
    };
}

// ======================================================
// PHANTOM DISPATCH SWEEP (reconcile-quota-leak, 2026-11-05)
// ======================================================
// The former check compared the counter with the NUMBER OF LEASES. On BA the
// counter leaked together with its leases: 8 dispatches that ended without
// jobs kept lease + metadata (status=dispatched, quota_owned=true), so
// counter 8 == leases 8 → "0 drift" while nothing ran on the GPU.
//
// A dispatch is LIVE when its lease is held by the metadata token AND one of:
//   • the dispatch really enqueued jobs (meta.jobs_enqueued, set by
//     dispatch-engine after dispatched:true) — result handling is in flight;
//   • the hub holds a job of this dispatch (animastor:running or any
//     animastor:queue:* lane) — legacy metadata without the flag;
//   • it is younger than PHANTOM_GRACE_MS (the executor is still running).
// Otherwise it is a PHANTOM candidate. A candidate seen on two consecutive
// sweeps (marker with TTL) is cancelled through the canonical path
// (dispatch-engine.cancelActiveDispatch: meta + lease + OWNED quota in one
// claim). A lease without metadata keeps the historic semantics (counted,
// ownership unknown). The counter is then corrected to the live leases.

const META_PREFIX = 'animastor:dispatch-meta';
const PHANTOM_GRACE_MS = 2 * 60 * 1000;
const PHANTOM_SUSPECT_PREFIX = 'animastor:dispatch-phantom-suspect:';
const PHANTOM_SUSPECT_TTL_S = 15 * 60;

async function scanKeys(redis, pattern, limit = 10000) {
    const keys = [];
    let cursor = 0;
    do {
        const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = parseInt(result[0], 10);
        keys.push(...result[1]);
    } while (cursor !== 0 && keys.length < limit);
    return keys;
}

function collectDispatchId(set, raw) {
    if (!raw || typeof raw !== 'string') return;
    try {
        const v = JSON.parse(raw);
        if (v && typeof v.dispatch_id === 'string') set.add(v.dispatch_id);
    } catch (_) {
        const m = raw.match(/"dispatch_id"\s*:\s*"([^"]+)"/);
        if (m) set.add(m[1]);
    }
}

/** dispatch_ids that have a job in the hub (running or queued, any lane). */
async function collectHubDispatchIds(redis) {
    const ids = new Set();
    try {
        const running = await redis.hgetall('animastor:running');
        for (const v of Object.values(running || {})) collectDispatchId(ids, v);
    } catch (_) { /* hash may not exist */ }
    for (const qk of await scanKeys(redis, 'animastor:queue:*')) {
        try {
            const items = await redis.lrange(qk, 0, -1);
            for (const v of items || []) collectDispatchId(ids, v);
        } catch (_) { /* not a list (lane bookkeeping key) */ }
    }
    return ids;
}

/**
 * Find and cancel phantom dispatches of `stage`.
 * @returns {Promise<{scanned:number, suspects:number, cancelled:string[]}>}
 */
async function sweepPhantomDispatches(redis, stage, now = Date.now()) {
    const out = { scanned: 0, suspects: 0, cancelled: [] };
    const leaseKeys = await scanKeys(redis, getLeaseKeyPattern(stage));
    if (leaseKeys.length === 0) return out;
    let hubIds = null;
    for (const leaseKey of leaseKeys) {
        const parts = leaseKey.split(':');
        // animastor:dispatch-lease:<book>:<chapter>:<scene>:<stage>
        if (parts.length !== 6 || parts[5] !== stage) continue;
        const [, , bookId, chapterId, sceneId] = parts;
        out.scanned++;
        const metaRaw = await redis.get(`${META_PREFIX}:${bookId}:${chapterId}:${sceneId}:${stage}`);
        if (!metaRaw) continue;
        let meta;
        try { meta = JSON.parse(metaRaw); } catch (_) { continue; }
        const leaseToken = await redis.get(leaseKey);
        if (!meta || !meta.dispatch_id || !leaseToken || meta.lease_token !== leaseToken) continue;
        if (meta.jobs_enqueued === true) continue;
        if (typeof meta.started_at === 'number' && now - meta.started_at < PHANTOM_GRACE_MS) continue;
        if (hubIds === null) hubIds = await collectHubDispatchIds(redis);
        if (hubIds.has(meta.dispatch_id)) continue;

        out.suspects++;
        const suspectKey = `${PHANTOM_SUSPECT_PREFIX}${meta.dispatch_id}`;
        const seen = await redis.get(suspectKey);
        if (!seen) {
            await redis.set(suspectKey, String(now), 'EX', PHANTOM_SUSPECT_TTL_S);
            continue;
        }
        const dispatchEngine = require('./dispatch-engine');
        const res = await dispatchEngine.cancelActiveDispatch(redis, bookId, chapterId, sceneId, stage, 'phantom_dispatch');
        await redis.del(suspectKey);
        if (res && res.cancelled) {
            out.cancelled.push(`${bookId}/${chapterId}/${sceneId}`);
            warn(`PHANTOM_DISPATCH_CANCELLED: ${bookId}/${chapterId}/${sceneId}:${stage} dispatch=${String(meta.dispatch_id).slice(0, 24)}... (no jobs, no hub job, quota_owned=${meta.quota_owned === true}, quotaReleased=${res.quotaReleased === true})`);
        }
    }
    return out;
}

/**
 * Reconcile all counters.
 * Returns reconciliation report.
 */
async function reconcileCounters(redis) {
    const stages = mediaRegistry.listMediaTypes();
    const report = {
        timestamp: new Date().toISOString(),
        stages: {},
        summary: {
            totalDrift: 0,
            correctedCount: 0,
            errors: []
        }
    };

    for (const stage of stages) {
        try {
            try {
                const sweep = await sweepPhantomDispatches(redis, stage);
                if (sweep.cancelled.length > 0) {
                    report.summary.phantomsCancelled = (report.summary.phantomsCancelled || 0) + sweep.cancelled.length;
                }
            } catch (sweepErr) {
                warn(`PHANTOM_SWEEP failed for ${stage}: ${sweepErr.message}`);
            }
            const data = await getCounterWithDriftCheck(redis, stage);

            if (!data.correct) {
                warn(`COUNTER_DRIFT: ${stage}: counter=${data.counterValue}, leases=${data.leaseCount}, drift=${data.drift}`);

                // Correct the counter
                const correction = await correctCounterWithLua(redis, stage, data.leaseCount);

                if (correction.success && correction.action === 'corrected') {
                    log(`COUNTER_RECONCILED: ${stage}: ${correction.old} -> ${correction.new}`);
                    report.stages[stage] = {
                        leaseCount: data.leaseCount,
                        counterValue: data.counterValue,
                        drift: data.drift,
                        corrected: true,
                        correction: correction
                    };
                    report.summary.correctedCount++;
                    report.summary.totalDrift += Math.abs(data.drift);
                } else {
                    error(`COUNTER_CORRECTION_FAILED: ${stage}: ${correction ? correction.key : 'unknown'}`);
                    report.stages[stage] = {
                        leaseCount: data.leaseCount,
                        counterValue: data.counterValue,
                        drift: data.drift,
                        corrected: false,
                        correction
                    };
                    report.summary.errors.push(`Failed to correct ${stage}: ${correction?.key}`);
                }
            } else {
                report.stages[stage] = {
                    leaseCount: data.leaseCount,
                    counterValue: data.counterValue,
                    drift: 0,
                    corrected: false
                };
            }
        } catch (err) {
            error(`Counter reconciliation error for ${stage}: ${err.message}`);
            report.stages[stage] = {
                error: err.message,
                corrected: false
            };
            report.summary.errors.push(`Error reconciling ${stage}`);
        }
    }

    log(`COUNTER_RECONCILIATION_COMPLETE: ${report.summary.correctedCount} corrected, ${report.summary.totalDrift} total drift${report.summary.phantomsCancelled ? `, ${report.summary.phantomsCancelled} phantom dispatch(es) cancelled` : ''}`);

    return report;
}

/**
 * Get current counter status.
 */
async function getCountersStatus(redis) {
    const stages = mediaRegistry.listMediaTypes();
    const status = {};

    for (const stage of stages) {
        status[stage] = await getCounterWithDriftCheck(redis, stage);
    }

    return status;
}

/**
 * Get reconciliation metrics.
 */
async function getReconciliationMetrics(redis) {
    const status = await getCountersStatus(redis);
    const totalLeases = status.audio.leaseCount + status.image.leaseCount + status.video.leaseCount;

    return {
        timestamp: new Date().toISOString(),
        counters: status,
        totalActiveLeases: totalLeases,
        driftStatus: Object.fromEntries(
            mediaRegistry.listMediaTypes().map(t => [t, status[t] && status[t].drift !== 0])
        )
    };
}

/**
 * Quick check for problematic drift.
 * Returns { hasDrift: boolean, issues: [] }
 */
async function checkForDrift(redis) {
    const status = await getCountersStatus(redis);
    const issues = [];

    for (const stage of Object.keys(status)) {
        if (status[stage].drift !== 0) {
            issues.push({
                stage,
                counter: status[stage].counterValue,
                leases: status[stage].leaseCount,
                drift: status[stage].drift
            });
        }
    }

    return {
        hasDrift: issues.length > 0,
        issues
    };
}

/**
 * Manual counter correction.
 * Use only when you know the target value.
 */
async function manualCounterCorrection(redis, stage, value) {
    const result = await correctCounterWithLua(redis, stage, String(value));
    return {
        stage,
        value,
        ...result
    };
}

/**
 * Increment counter atomically.
 */
async function incrementCounter(redis, stage) {
    const key = getCounterKey(stage);
    const newVal = await redis.incr(key);
    return { stage, key, value: newVal };
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    PHANTOM_GRACE_MS,
    sweepPhantomDispatches,
    collectHubDispatchIds,
    // Configuration
    COUNTER_PREFIX,
    LEASE_PREFIX,

    // Key generators
    getCounterKey,
    getLeaseKeyPattern,

    // Core reconciliation
    countActiveLeasesByStage,
    getCurrentCounter,
    setCounter,
    correctCounterWithLua,
    getCounterWithDriftCheck,
    reconcileCounters,
    getCountersStatus,
    getReconciliationMetrics,
    checkForDrift,
    manualCounterCorrection,

    // Counter manipulation
    incrementCounter
};
