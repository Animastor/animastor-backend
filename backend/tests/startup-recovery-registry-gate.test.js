// ======================================================
// Stage 63 — Startup recovery registry gate
// ======================================================
// recoverAllBooksFromDisk (host startup path) must not resurrect a deleted
// book whose book.json / output mp3s survive on disk. The scan is now gated
// on the same host-side isBookRegistered port as the Stage-59 read-time
// gates: unregistered books are skipped entirely (no chunk keys, no chunks
// set, no asset-state hashes, no book-scenes window counters), and the
// gate fails CLOSED when the lookup throws or the port is not injected.
// Registered books keep the pre-Stage-63 recovery behaviour unchanged.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';

const config = require('../src/config/runtime-config');
const redisHelpersFactory = require('../src/helpers/redis-helpers.cjs');

class FakeRedis {
    constructor() { this.store = new Map(); this.sets = new Map(); }
    async get(k) { return this.store.has(k) ? this.store.get(k) : null; }
    async set(k, v) { this.store.set(k, String(v)); return 'OK'; }
    async del(k) { this.store.delete(k); this.sets.delete(k); return 1; }
    async sadd(k, v) {
        if (!this.sets.has(k)) this.sets.set(k, new Set());
        this.sets.get(k).add(v);
        return 1;
    }
    async smembers(k) { return this.sets.has(k) ? [...this.sets.get(k)] : []; }
    async mget(keys) { return keys.map(k => (this.store.has(k) ? this.store.get(k) : null)); }
    async hset(k, fieldOrObj, value) {
        let obj = {};
        const raw = this.store.get(k);
        if (raw) { try { obj = JSON.parse(raw); } catch (_) { obj = {}; } }
        if (typeof fieldOrObj === 'object' && fieldOrObj !== null && value === undefined) {
            Object.assign(obj, fieldOrObj);
        } else {
            obj[fieldOrObj] = value;
        }
        this.store.set(k, JSON.stringify(obj));
        return 1;
    }
    async hgetall(k) {
        const raw = this.store.get(k);
        if (!raw) return {};
        try { return JSON.parse(raw); } catch (_) { return {}; }
    }
}

const KEEP_BOOK = 'keepbook1';
const DELETED_BOOK = 'deletedbook1';

function bookStub() {
    return {
        loadBook: (id) => (id === KEEP_BOOK || id === DELETED_BOOK ? { chapters: [] } : null),
        collectScenes: () => [{ chapter_id: 'ch1', scene_id: 'sc1', scene_order: 0, scene_type: 'narration' }],
    };
}

describe('startup recovery registry gate (stage 63)', () => {
    let tmpRoot, outDir, buildDir, redis, savedOutDir, logs, origLog, origBookExports;

    const bookModulePath = require.resolve('../src/book/index.js');

    function keysFor(bookId) {
        return [...redis.store.keys(), ...redis.sets.keys()].filter(k => k.includes(bookId));
    }

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reorg-63-'));
        outDir = path.join(tmpRoot, 'output');
        buildDir = path.join(outDir, 'build1');
        fs.mkdirSync(buildDir, { recursive: true });
        // On-disk leftovers for BOTH books — the gate, not disk presence,
        // decides whether Redis is written.
        for (const id of [KEEP_BOOK, DELETED_BOOK]) {
            fs.writeFileSync(path.join(buildDir, `${id}_ch1_sc1.mp3`), 'x');
        }
        savedOutDir = config.OUTPUT_DIR;
        config.OUTPUT_DIR = outDir;

        // Swap the book module exports for a deterministic stub; redis-helpers
        // lazily requires '../book' inside the recovery path, so the cache
        // swap is picked up at call time and restored in afterEach.
        require(bookModulePath); // ensure the cache entry exists
        origBookExports = require.cache[bookModulePath].exports;
        require.cache[bookModulePath].exports = bookStub();

        redis = new FakeRedis();
        logs = [];
        origLog = console.log;
        console.log = (...args) => { logs.push(args.join(' ')); };
    });

    afterEach(() => {
        console.log = origLog;
        require.cache[bookModulePath].exports = origBookExports;
        config.OUTPUT_DIR = savedOutDir;
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    });

    it('registered book — recovery runs and writes chunk/chunks/asset-state/window keys', async () => {
        const helpers = redisHelpersFactory(redis, {
            isBookRegistered: async (id) => id === KEEP_BOOK,
        });
        await helpers.recoverAllBooksFromDisk();

        expect(redis.store.get('animastor:chunk:keepbook1_ch1_sc1_0001')).to.be.a('string');
        expect([...redis.sets.get('animastor:chunks:keepbook1')]).to.deep.equal(['keepbook1_ch1_sc1_0001']);
        expect(redis.store.get('animastor:book-scenes:keepbook1:total')).to.equal('1');
        expect(redis.store.get('animastor:book-scenes:keepbook1:next-index')).to.equal('1');
        const asset = JSON.parse(redis.store.get('animastor:asset-state:keepbook1:ch1:sc1'));
        expect(asset).to.deep.equal({ audio: 'ready', image: 'ready', video: 'ready' });
    });

    it('unregistered book — zero Redis writes despite book.json + mp3 on disk', async () => {
        const helpers = redisHelpersFactory(redis, {
            isBookRegistered: async () => false,
        });
        await helpers.recoverAllBooksFromDisk();

        expect(keysFor(DELETED_BOOK)).to.deep.equal([]);
        expect(redis.store.size).to.equal(0);
        expect(logs.join('\n')).to.match(/Skipping recovery for deletedbook1 — book not registered/);
    });

    it('registry lookup error — recovery skipped (fail-closed), no writes', async () => {
        const helpers = redisHelpersFactory(redis, {
            isBookRegistered: async (id) => {
                if (id === DELETED_BOOK) throw new Error('pg down');
                return true;
            },
        });
        await helpers.recoverAllBooksFromDisk();

        expect(keysFor(DELETED_BOOK)).to.deep.equal([]);
        expect(logs.join('\n')).to.match(/registry check failed for deletedbook1 .*fail-closed/);
        // registered sibling still recovers
        expect(redis.store.get('animastor:chunk:keepbook1_ch1_sc1_0001')).to.be.a('string');
    });

    it('missing isBookRegistered port — recovery skipped entirely (fail-closed)', async () => {
        const helpers = redisHelpersFactory(redis);
        await helpers.recoverAllBooksFromDisk();

        expect(redis.store.size).to.equal(0);
        expect(redis.sets.size).to.equal(0);
        expect(logs.join('\n')).to.match(/no isBookRegistered gate injected/);
    });

    it('existing saved books untouched: pre-seeded chunks preserved, deleted book adds nothing', async () => {
        // Pre-existing live state for the keep book (as in production).
        const seeded = JSON.stringify({
            build_id: 'build1', book_id: KEEP_BOOK, chapter_id: 'ch1', scene_id: 'sc1',
            chunk_index: '0001', audio: true, image: false, video: false,
        });
        redis.store.set('animastor:chunk:keepbook1_ch1_sc1_0001', seeded);
        redis.sets.set('animastor:chunks:keepbook1', new Set(['keepbook1_ch1_sc1_0001']));

        const helpers = redisHelpersFactory(redis, {
            isBookRegistered: async (id) => id === KEEP_BOOK,
        });
        await helpers.recoverAllBooksFromDisk();

        // Keep book: chunks already exist → skip path, bytes unchanged, no
        // asset-state / window counters materialised behind its back.
        expect(redis.store.get('animastor:chunk:keepbook1_ch1_sc1_0001')).to.equal(seeded);
        expect([...redis.sets.get('animastor:chunks:keepbook1')]).to.deep.equal(['keepbook1_ch1_sc1_0001']);
        expect(redis.store.has('animastor:asset-state:keepbook1:ch1:sc1')).to.equal(false);
        expect(redis.store.has('animastor:book-scenes:keepbook1:total')).to.equal(false);
        expect(logs.join('\n')).to.match(/Chunks already exist in Redis for keepbook1/);

        // Deleted book: nothing at all.
        expect(keysFor(DELETED_BOOK)).to.deep.equal([]);
    });
});
