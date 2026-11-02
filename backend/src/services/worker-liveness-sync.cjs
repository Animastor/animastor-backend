// ======================================================
// Worker liveness → PG mirror (GPU E2E 2026-11-02 §8 п.6)
// ======================================================
// The GPU hub writes `animastor:worker:heartbeat:<type>:<worker_id>` (EX 30 s)
// on every beacon. The API already derives ONLINE/OFFLINE from that key on
// read, but PG `workers.status/last_seen/version` were only touched by
// /worker/verify — PG said `offline` for a worker that was online 12:22–12:43.
//
// Once per reconcile cycle (60 s) this mirrors the live heartbeat keys into
// PG: live → status='online', last_seen (seconds) and version from the
// beacon; every other non-revoked worker → status='offline'. Best effort:
// a Redis/PG error is returned, never thrown.
// ======================================================

'use strict';

const config = require('../config/runtime-config');

async function collectLiveHeartbeats(redis) {
    const live = new Map();
    for (const type of config.WORKER_HEARTBEAT_TYPES) {
        let cursor = '0';
        do {
            const [next, keys] = await redis.scan(cursor, 'MATCH', config.WORKER_HEARTBEAT_TYPE_PATTERN(type), 'COUNT', 200);
            cursor = String(next);
            for (const key of keys || []) {
                const workerId = key.slice(`${config.WORKER_HEARTBEAT_PREFIX}:${type}:`.length);
                if (!workerId) continue;
                let payload = null;
                try { payload = JSON.parse(await redis.get(key)); } catch (_) { payload = null; }
                if (!payload) continue;
                const tsMs = Number(payload.ts) || Date.now();
                const prev = live.get(workerId);
                if (!prev || prev.tsMs < tsMs) {
                    live.set(workerId, { workerId, tsMs, version: payload.version || null });
                }
            }
        } while (cursor !== '0');
    }
    return [...live.values()];
}

async function syncWorkerLiveness(redis, deps = {}) {
    const workerRepo = deps.workerRepo || require('../storage/postgres/repositories/worker-repo');
    try {
        if (!redis || typeof redis.scan !== 'function') return { ok: false, error: 'no_redis' };
        const live = await collectLiveHeartbeats(redis);
        const res = await workerRepo.syncLivenessFromHeartbeats(live);
        return { ok: true, live: live.length, ...res };
    } catch (err) {
        return { ok: false, error: String((err && err.message) || err).slice(0, 200) };
    }
}

module.exports = { syncWorkerLiveness, collectLiveHeartbeats };
