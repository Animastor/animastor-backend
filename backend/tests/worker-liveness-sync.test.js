// ======================================================
// Worker liveness → PG mirror (GPU E2E 2026-11-02 §8 п.6)
// ======================================================
// Moved out of gpu-e2e-2026-11-02-fixes.test.js on 2026-11-28 (ORCHESTRATION_V2
// этап 4): the rest of that file tested the legacy protocol-2 result path; the
// liveness mirror stays (services/worker-liveness-sync.cjs — the composition
// root runs it every 60 s since the legacy runtime loop is gone).

'use strict';

const { expect } = require('chai');
const { createMockRedis } = require('./mocks/redis-mock');

describe('worker liveness → PG mirror', () => {
    let redis;
    beforeEach(() => { redis = createMockRedis(); });

    describe('P2-6: workers.last_seen seconds + heartbeat liveness', () => {
        const workerRepo = require('../src/storage/postgres/repositories/worker-repo');

        it('lastSeenMs converts seconds to ms and passes a legacy ms value through', () => {
            expect(workerRepo.lastSeenMs({ last_seen: 1793622717 })).to.equal(1793622717000);
            expect(workerRepo.lastSeenMs({ last_seen: '1793622717' })).to.equal(1793622717000);
            expect(workerRepo.lastSeenMs({ last_seen: 1793622717060 })).to.equal(1793622717060);
            expect(workerRepo.lastSeenMs({ last_seen: null })).to.equal(null);
        });

        it('syncWorkerLiveness collects live heartbeats (latest ts, version) for the repo', async () => {
            const { syncWorkerLiveness } = require('../src/services/worker-liveness-sync.cjs');
            const config = require('../src/config/runtime-config');
            const id = 'f7dcbda1-31d1-419d-af73-37048352bc88';
            await redis.set(config.WORKER_HEARTBEAT_KEY('audio', id), JSON.stringify({ ts: 1793623416449, version: '2.2.1' }));
            let got = null;
            const res = await syncWorkerLiveness(redis, {
                workerRepo: { syncLivenessFromHeartbeats: async (live) => { got = live; return { online: 1, offline: 0 }; } },
            });
            expect(res).to.include({ ok: true, live: 1, online: 1, offline: 0 });
            expect(got).to.deep.equal([{ workerId: id, tsMs: 1793623416449, version: '2.2.1' }]);
        });

        it('syncWorkerLiveness never throws (repo error → ok:false)', async () => {
            const { syncWorkerLiveness } = require('../src/services/worker-liveness-sync.cjs');
            const res = await syncWorkerLiveness(redis, {
                workerRepo: { syncLivenessFromHeartbeats: async () => { throw new Error('pg down'); } },
            });
            expect(res).to.deep.equal({ ok: false, error: 'pg down' });
        });
    });
});
