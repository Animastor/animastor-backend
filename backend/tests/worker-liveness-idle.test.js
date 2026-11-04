// ======================================================
// Idle worker counts as an executor (stall report 2026-11-04 §9.3 check)
// ======================================================
// Claim under test (reports/2026-11-04/gpu-generation-stall.md §9.3): the
// dispatch gate hasLiveExecutorForLane reads only
// animastor:worker:heartbeat:* (TTL 30 s) and an IDLE worker may have no such
// key → a new command would be blocked with no_worker_available.
//
// Verdict (reports/2026-11-04/regenerate-sweep-fix.md §4): NOT confirmed by
// code — the hub writes the heartbeat on EVERY /beacon (gpu-hub.js, EX 30),
// and the worker beacons every BEACON_INTERVAL_MS = 10 s whether it is busy
// or idle (worker.cjs workerLoop → setInterval(sendBeacon)). The hub side is
// pinned by animastor-gpu-hub tests/stale-dispatch-409.cjs («idle worker:
// /beacon alone writes the heartbeat»); this suite pins the backend side:
// the payload of an idle beacon (no current_job_id) is a live executor for
// its lane, and a heartbeat older than the TTL is not.

'use strict';

const { expect } = require('chai');
const { createMockRedis } = require('./mocks/redis-mock');
const qidem = require('../src/helpers/queue-idempotency.cjs');
const config = require('../src/config/runtime-config');

/** The exact /beacon heartbeat payload of hub v0.2.8/0.2.9 (no job fields). */
function beaconPayload({ workerId, type, mode, workspaceId, ts }) {
    return {
        type, worker_id: workerId, ts,
        workspace_id: workspaceId || null, mode,
        version: '2.3.0', image_tag: null, protocol_version: 2,
    };
}

describe('worker liveness — an IDLE worker (beacon only) is an executor', () => {
    it('private idle worker (heartbeat from /beacon, no current job) → live executor of its workspace lane', async () => {
        const redis = createMockRedis();
        const id = '26bd5d7f-652f-460d-a4bd-284436f76840';
        await redis.set(config.WORKER_HEARTBEAT_KEY('image', id),
            JSON.stringify(beaconPayload({ workerId: id, type: 'image', mode: 'private', workspaceId: 'ws-3317e019', ts: Date.now() })), 'EX', 30);

        const alive = await qidem.listAliveWorkers(redis, 'image');
        expect(alive.map(w => w.worker_id)).to.deep.equal([id]);
        expect(alive[0].current_job_id, 'idle').to.equal(undefined);
        expect(await qidem.hasLiveExecutorForLane(redis, 'image', { kind: 'private', workspaceId: 'ws-3317e019' })).to.equal(true);
        // another workspace / the system pool are not served by it
        expect(await qidem.hasLiveExecutorForLane(redis, 'image', { kind: 'private', workspaceId: 'ws-other' })).to.equal(false);
        expect(await qidem.hasLiveExecutorForLane(redis, 'image', { kind: 'system' })).to.equal(false);
    });

    it('system idle worker → live executor of the system pool', async () => {
        const redis = createMockRedis();
        await redis.set(config.WORKER_HEARTBEAT_KEY('audio', 'w-sys'),
            JSON.stringify(beaconPayload({ workerId: 'w-sys', type: 'audio', mode: 'system', ts: Date.now() })), 'EX', 30);
        expect(await qidem.hasLiveExecutorForLane(redis, 'audio', { kind: 'system' })).to.equal(true);
    });

    it('beacon cadence keeps the key alive: interval 10 s < TTL 30 s (3 beacons per TTL)', () => {
        expect(config.WORKER_HEARTBEAT_TTL).to.equal(30);
        const BEACON_INTERVAL_MS = 10000; // worker.cjs default (BEACON_INTERVAL_MS)
        expect(BEACON_INTERVAL_MS * 3).to.be.at.most(config.WORKER_HEARTBEAT_TTL * 1000);
    });

    it('a heartbeat older than the TTL is not an executor (stopped worker)', async () => {
        const redis = createMockRedis();
        await redis.set(config.WORKER_HEARTBEAT_KEY('image', 'w-old'),
            JSON.stringify(beaconPayload({ workerId: 'w-old', type: 'image', mode: 'system', ts: Date.now() - 31000 })));
        expect(await qidem.hasLiveExecutorForLane(redis, 'image', { kind: 'system' })).to.equal(false);
    });
});
