// ======================================================
// scripts/purge-legacy-redis.cjs — classification and apply (mock Redis)
// ======================================================

'use strict';

const { expect } = require('chai');
const path = require('path');
const { createMockRedis } = require('./mocks/redis-mock');
const purge = require(path.resolve(__dirname, '..', '..', 'scripts', 'purge-legacy-redis.cjs'));

describe('scripts/purge-legacy-redis.cjs', () => {
    async function seeded() {
        const redis = createMockRedis();
        const keys = {
            // legacy (deleted)
            'animastor:active-scenes': 'x', 'animastor:asset-state:b:ch:sc': 'x', 'animastor:audio-orch:b:ch:sc': 'x',
            'animastor:runtime:active-audio': 'x', 'animastor:circuit:audio': 'x', 'animastor:event-journal:b:ch:sc': 'x',
            'animastor:idempotency:done:k': 'x', 'animastor:layer-config:b': 'x', 'animastor:generation-progress:b': 'x',
            'animastor:iu-progress:b:ch:sc:image': 'x', 'animastor:gen-scope:b': 'x',
            // hub protocol 2 (only with --include-hub-v2)
            'animastor:queue:audio': 'x', 'animastor:job:d:j': 'x',
            // kept
            'animastor:worker-auth': 'x', 'animastor:worker:heartbeat:audio:w1': 'x', 'animastor:gpu-hub:workers': 'x',
            'animastor:chunk:b_ch_sc_0001': 'x', 'animastor:chunks:b': 'x', 'animastor:book-scenes:b:total': 'x',
            'animastor:cancelled-workers:b': 'x', 'animastor:bootstrap-lock:b': 'x', 'animastor:pending-purge': 'x',
            'animastor:prompt-profiles': 'x', 'animastor:video-book-merge-lock:b': 'x', 'animastor:ai-connector:hb:c': 'x',
            // unknown family → kept, reported
            'animastor:vbook-scene-idx:b': 'x', 'animastor:sess:abc': 'x',
        };
        for (const [k, v] of Object.entries(keys)) await redis.set(k, v);
        return { redis, keys };
    }

    it('dry-run classification: legacy families to delete, live ones kept, unknown kept', async () => {
        const { redis } = await seeded();
        const r = await purge.classify(redis);
        expect(r.toDelete.sort()).to.deep.equal([
            'animastor:active-scenes', 'animastor:asset-state:b:ch:sc', 'animastor:audio-orch:b:ch:sc',
            'animastor:circuit:audio', 'animastor:event-journal:b:ch:sc', 'animastor:gen-scope:b',
            'animastor:generation-progress:b', 'animastor:idempotency:done:k', 'animastor:iu-progress:b:ch:sc:image',
            'animastor:layer-config:b', 'animastor:runtime:active-audio',
        ].sort());
        expect(r.counts.keep.get('animastor:chunk:*')).to.equal(1);
        expect(r.counts.keep.get('animastor:cancelled-workers:*')).to.equal(1);
        expect(r.counts.other.get('animastor:vbook-scene-idx')).to.equal(1);
        expect(r.counts.other.get('animastor:queue')).to.equal(1, 'hub transport is kept without --include-hub-v2');
    });

    it('--include-hub-v2 adds the protocol-2 hub transport', async () => {
        const { redis } = await seeded();
        const r = await purge.classify(redis, { includeHubV2: true });
        expect(r.toDelete).to.include.members(['animastor:queue:audio', 'animastor:job:d:j']);
    });

    it('apply deletes exactly the classified keys; kept and unknown families survive', async () => {
        const { redis, keys } = await seeded();
        const r = await purge.classify(redis);
        const n = await purge.purgeKeys(redis, r.toDelete);
        expect(n).to.equal(r.toDelete.length);
        for (const k of Object.keys(keys)) {
            const shouldGo = r.toDelete.includes(k);
            expect(await redis.get(k), k).to.equal(shouldGo ? null : 'x');
        }
        expect((await purge.classify(redis)).toDelete).to.deep.equal([], 'second run finds nothing');
    });

    it('a kept family wins over a purge glob; --apply needs --confirm; unknown flags are refused', () => {
        expect(purge.familyOf('animastor:worker:heartbeat:audio:w', purge.KEEP.map(([g]) => g))).to.equal('animastor:worker:heartbeat:*');
        expect(purge.parseArgs(['--apply'])).to.include({ apply: true, confirm: null });
        expect(purge.parseArgs(['--apply', '--confirm=h:1/0'])).to.include({ confirm: 'h:1/0' });
        expect(() => purge.parseArgs(['--force'])).to.throw(/unknown argument/);
        for (const [g] of purge.KEEP) expect(purge.PURGE).to.not.include(g);
    });
});
