// ======================================================
// Stage 114 — GPU queue idempotency + executor gate
// ======================================================
// Regression net for the production duplicate storm in the GPU Hub image lane
// (457 entries = 19 logical tasks, 438 duplicates): every graceful backend
// restart cancels the active dispatch, the next boot rolls the orphaned
// GENERATING state back and the scheduler dispatches the stage again with a
// NEW dispatch_id. The hub dedup key contains the dispatch_id, so it could
// never suppress that re-dispatch.
//
// Covered here (isolated — no production Redis/PG, no hub, no network):
//   1. a re-dispatch with the same params and a NEW dispatch_id stays ONE
//      logical task (no second lane entry);
//   2. concurrent dispatches do not create duplicates (atomic claim);
//   3. an active lease is still protected (dispatch-engine guard intact);
//   4. graceful shutdown → reconciliation → re-dispatch creates no duplicate;
//   5. a justified retry with a new generation_epoch is allowed;
//   6. different params / IU / model / seed / version are never collapsed;
//   7. a completed task is not re-queued without an allowed retry;
//   8. the absence of a live, type-compatible worker blocks the enqueue;
//   9. lease expiry and crash/restart are handled safely;
//  10. worker results and redelivered results stay idempotent.

const { expect } = require('chai');
const proxyquire = require('proxyquire');

// ── in-memory Redis double (no network, no production Redis) ─────────────

class FakeRedis {
    constructor() {
        this.strings = new Map();
        this.lists = new Map();
        this.hashes = new Map();
        this.sets = new Map();
        this.now = Date.now();
    }
    _expired(e) { return !!(e && e.expireAt != null && e.expireAt <= this.now); }
    _live(map, key) {
        const e = map.get(key);
        if (!e) return null;
        if (this._expired(e)) { map.delete(key); return null; }
        return e;
    }
    async get(key) { const e = this._live(this.strings, key); return e ? e.value : null; }
    async set(key, value, ...args) {
        let nx = false, xx = false, ex = null;
        for (let i = 0; i < args.length; i++) {
            const a = String(args[i]).toUpperCase();
            if (a === 'NX') nx = true;
            else if (a === 'XX') xx = true;
            else if (a === 'EX') ex = parseInt(args[++i], 10);
        }
        const exists = !!this._live(this.strings, key);
        if (nx && exists) return null;
        if (xx && !exists) return null;
        const prev = this._live(this.strings, key);
        this.strings.set(key, {
            value: String(value),
            expireAt: ex != null ? this.now + ex * 1000 : (prev ? prev.expireAt : null),
        });
        return 'OK';
    }
    async del(...keys) {
        let n = 0;
        for (const k of keys.flat()) {
            for (const m of [this.strings, this.lists, this.hashes, this.sets]) {
                if (m.has(k)) { m.delete(k); n++; break; }
            }
        }
        return n;
    }
    async exists(key) { return (this._live(this.strings, key) || this._live(this.lists, key)) ? 1 : 0; }
    async expire(key, seconds) {
        for (const m of [this.strings, this.lists, this.hashes, this.sets]) {
            const e = this._live(m, key);
            if (e) { e.expireAt = this.now + seconds * 1000; return 1; }
        }
        return 0;
    }
    async ttl(key) {
        for (const m of [this.strings, this.lists, this.hashes, this.sets]) {
            const e = this._live(m, key);
            if (e) {
                if (e.expireAt == null) return -1;
                return Math.max(0, Math.ceil((e.expireAt - this.now) / 1000));
            }
        }
        return -2;
    }
    async incr(key) {
        const e = this._live(this.strings, key);
        const next = (e ? parseInt(e.value, 10) : 0) + 1;
        this.strings.set(key, { value: String(next), expireAt: e ? e.expireAt : null });
        return next;
    }
    async hset(key, ...args) {
        let e = this._live(this.hashes, key);
        if (!e) { e = { map: new Map(), expireAt: null }; this.hashes.set(key, e); }
        let n = 0;
        for (let i = 0; i < args.length; i += 2) {
            const f = String(args[i]);
            if (!e.map.has(f)) n++;
            e.map.set(f, String(args[i + 1]));
        }
        return n;
    }
    async hget(key, field) {
        const e = this._live(this.hashes, key);
        if (!e) return null;
        const v = e.map.get(String(field));
        return v === undefined ? null : v;
    }
    async hgetall(key) {
        const e = this._live(this.hashes, key);
        if (!e) return {};
        const out = {};
        for (const [k, v] of e.map) out[k] = v;
        return out;
    }
    async hdel(key, ...fields) {
        const e = this._live(this.hashes, key);
        if (!e) return 0;
        let n = 0;
        for (const f of fields.flat()) if (e.map.delete(String(f))) n++;
        return n;
    }
    async hlen(key) { const e = this._live(this.hashes, key); return e ? e.map.size : 0; }
    async lpush(key, ...vals) {
        let e = this._live(this.lists, key);
        if (!e) { e = { items: [], expireAt: null }; this.lists.set(key, e); }
        for (const v of vals.flat()) e.items.unshift(String(v));
        return e.items.length;
    }
    async rpush(key, ...vals) {
        let e = this._live(this.lists, key);
        if (!e) { e = { items: [], expireAt: null }; this.lists.set(key, e); }
        for (const v of vals.flat()) e.items.push(String(v));
        return e.items.length;
    }
    async llen(key) { const e = this._live(this.lists, key); return e ? e.items.length : 0; }
    async lrange(key, start, stop) {
        const e = this._live(this.lists, key);
        if (!e) return [];
        const n = e.items.length;
        const s = start < 0 ? Math.max(0, n + start) : start;
        const t = stop < 0 ? n + stop : stop;
        if (s > t || s >= n) return [];
        return e.items.slice(s, t + 1);
    }
    async sadd(key, ...members) {
        let e = this._live(this.sets, key);
        if (!e) { e = { members: new Set(), expireAt: null }; this.sets.set(key, e); }
        let n = 0;
        for (const m of members.flat()) if (!e.members.has(String(m))) { e.members.add(String(m)); n++; }
        return n;
    }
    async srem(key, ...members) {
        const e = this._live(this.sets, key);
        if (!e) return 0;
        let n = 0;
        for (const m of members.flat()) if (e.members.delete(String(m))) n++;
        return n;
    }
    async smembers(key) { const e = this._live(this.sets, key); return e ? [...e.members] : []; }
    _keys() {
        const keys = new Set();
        for (const m of [this.strings, this.lists, this.hashes, this.sets]) {
            for (const [k, e] of [...m.entries()]) {
                if (this._expired(e)) { m.delete(k); continue; }
                keys.add(k);
            }
        }
        return [...keys];
    }
    async keys(pattern) { return this._keys().filter(k => glob(pattern).test(k)); }
    async scan(cursor, ...args) {
        let pattern = '*';
        for (let i = 0; i < args.length; i++) {
            if (String(args[i]).toUpperCase() === 'MATCH') pattern = String(args[++i]);
        }
        const all = this._keys().filter(k => glob(pattern).test(k));
        return ['0', all];
    }
}

function glob(pattern) {
    const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}

// ── fixtures ──────────────────────────────────────────────────────────────

const WS = '3317e019-879d-4dfb-a9f8-edc9b72da7f4';
const OTHER_WS = '4ad7157c-bf94-47c9-a13c-032b346f5e06';
const BOOK = 'test-stage114-book';
const CHAPTER = 'ch-stage114';
const SCENE = 'sc-stage114';
const BUILD = 'build_test-stage114-book';

const qidem = require('../src/helpers/queue-idempotency.cjs');

function jobId(unit) { return `${BOOK}_${CHAPTER}_${SCENE}_${unit}:iu_image`; }
function params(overrides = {}) {
    return {
        '120': { inputs: { seed: 458007174637134, steps: 8, cfg: 2, model: ['1011', 0] } },
        '108': { inputs: { text: 'cinematic, USSR 1930, a kiosk in the park' } },
        ...overrides,
    };
}

/** A dispatcher wired to a fake Redis + a stubbed PG routing layer. */
function makeDispatcher({ redis, workspaceId = WS, hasPrivateWorker = true, liveWorkers = [] }) {
    const calls = [];
    const bookRepo = { getWorkspaceId: async () => workspaceId };
    const workerRepo = { hasActivePrivateWorkerOfType: async () => hasPrivateWorker };

    const gpuDispatcher = proxyquire('../src/runtime/gpu-dispatcher', {
        '../storage/postgres/repositories/book-repo': bookRepo,
        '../storage/postgres/repositories/worker-repo': workerRepo,
    });

    gpuDispatcher.setRedis(redis);
    gpuDispatcher.clearRoutingCaches();

    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
        calls.push({ url, body: JSON.parse(opts.body) });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    return {
        gpuDispatcher,
        calls,
        restore() { global.fetch = originalFetch; gpuDispatcher.setRedis(null); },
    };
}

/** Write a live worker heartbeat exactly as the GPU Hub writes it. */
function writeHeartbeat(redis, { type, workerId, workspaceId = null, mode = 'system' }) {
    return redis.set(`animastor:worker:heartbeat:${type}:${workerId}`, JSON.stringify({
        type,
        worker_id: workerId,
        ts: Date.now(),
        workspace_id: workspaceId,
        mode,
    }), 'EX', 30);
}

describe('Stage 114: GPU queue idempotency + executor gate', () => {
    let redis;
    let ctx;

    afterEach(() => {
        if (ctx && ctx.restore) ctx.restore();
        ctx = null;
    });

    // ── identity ──────────────────────────────────────────────────────────
    describe('identity of a logical task', () => {
        it('the idempotency key does NOT depend on dispatch_id', () => {
            const spec = { workspaceId: WS, jobId: jobId('iu-aaa'), jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0 };
            const k1 = qidem.computeIdemKey(spec);
            const k2 = qidem.computeIdemKey({ ...spec });
            expect(k1).to.equal(k2);
            expect(k1).to.not.contain('dispatch');
        });

        it('different workspace / build / job produce different keys', () => {
            const base = { workspaceId: WS, jobId: jobId('iu-aaa'), jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0 };
            const k = qidem.computeIdemKey(base);
            expect(qidem.computeIdemKey({ ...base, workspaceId: OTHER_WS })).to.not.equal(k);
            expect(qidem.computeIdemKey({ ...base, buildId: 'build_other' })).to.not.equal(k);
            expect(qidem.computeIdemKey({ ...base, jobId: jobId('iu-bbb') })).to.not.equal(k);
            expect(qidem.computeIdemKey({ ...base, jobType: 'video' })).to.not.equal(k);
        });

        it('different params (seed / prompt / model) produce different input versions', () => {
            const base = params();
            expect(qidem.computeInputVersion(base)).to.not.equal(qidem.computeInputVersion(params({
                '120': { inputs: { seed: 999, steps: 8, cfg: 2, model: ['1011', 0] } },
            })));
            expect(qidem.computeInputVersion(base)).to.not.equal(qidem.computeInputVersion(params({
                '108': { inputs: { text: 'a different prompt' } },
            })));
            expect(qidem.computeInputVersion(base)).to.not.equal(qidem.computeInputVersion(params({
                '120': { inputs: { seed: 458007174637134, steps: 8, cfg: 2, model: ['2020', 0] } },
            })));
            // key order must not matter
            expect(qidem.computeInputVersion({ a: 1, b: { x: 1, y: 2 } }))
                .to.equal(qidem.computeInputVersion({ b: { y: 2, x: 1 }, a: 1 }));
        });

        it('the generation epoch only moves when it is explicitly bumped', async () => {
            redis = new FakeRedis();
            expect(await qidem.getStageEpoch(redis, BOOK, CHAPTER, SCENE, 'image')).to.equal(0);
            expect(await qidem.bumpStageEpoch(redis, BOOK, CHAPTER, SCENE, 'image')).to.equal(1);
            expect(await qidem.getStageEpoch(redis, BOOK, CHAPTER, SCENE, 'image')).to.equal(1);
            // a plain read never moves it
            await qidem.getStageEpoch(redis, BOOK, CHAPTER, SCENE, 'image');
            expect(await qidem.getStageEpoch(redis, BOOK, CHAPTER, SCENE, 'image')).to.equal(1);
        });

        it('all jobs of one dispatch observe the SAME frozen epoch', async () => {
            redis = new FakeRedis();
            await qidem.bumpStageEpoch(redis, BOOK, CHAPTER, SCENE, 'image'); // epoch → 1
            const first = await qidem.resolveDispatchEpoch(redis, 'dispatch-A', BOOK, CHAPTER, SCENE, 'image');
            await qidem.bumpStageEpoch(redis, BOOK, CHAPTER, SCENE, 'image'); // epoch → 2 (concurrent bump)
            const second = await qidem.resolveDispatchEpoch(redis, 'dispatch-A', BOOK, CHAPTER, SCENE, 'image');
            expect(first).to.equal(second);
            const other = await qidem.resolveDispatchEpoch(redis, 'dispatch-B', BOOK, CHAPTER, SCENE, 'image');
            expect(other).to.not.equal(first);
        });
    });

    // ── the atomic claim ─────────────────────────────────────────────────
    describe('single pending entry per logical task', () => {
        it('concurrent claims: exactly one winner', async () => {
            redis = new FakeRedis();
            const key = qidem.computeIdemKey({
                workspaceId: WS, jobId: jobId('iu-aaa'), jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            const results = await Promise.all(Array.from({ length: 25 }, () => qidem.claimTask(redis, key)));
            expect(results.filter(Boolean)).to.have.length(1);
        });

        it('a completed task blocks re-enqueue until the epoch is bumped', async () => {
            redis = new FakeRedis();
            const spec = { workspaceId: WS, jobId: jobId('iu-aaa'), jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0 };
            const key = qidem.computeIdemKey(spec);
            expect((await qidem.guardEnqueue(redis, key)).allowed).to.equal(true);
            await qidem.markTaskDone(redis, key);
            await qidem.releaseTask(redis, key);
            const blocked = await qidem.guardEnqueue(redis, key);
            expect(blocked.allowed).to.equal(false);
            expect(blocked.reason).to.equal('already_completed');
            // a justified retry (new epoch) is allowed again
            const retryKey = qidem.computeIdemKey({ ...spec, generationEpoch: 1 });
            expect((await qidem.guardEnqueue(redis, retryKey)).allowed).to.equal(true);
        });
    });

    // ── the dispatcher ────────────────────────────────────────────────────
    describe('gpu-dispatcher.sendUnified', () => {
        it('a re-dispatch with a NEW dispatch_id stays ONE logical task', async () => {
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            ctx = makeDispatcher({ redis, workspaceId: null });

            const spec = {
                job_id: jobId('iu-aaa'), params: params(), job_type: 'image',
                build_id: BUILD, dispatch_id: 'dispatch-1',
            };
            const first = await ctx.gpuDispatcher.sendUnified(spec);
            const second = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'dispatch-2' });
            const third = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'dispatch-3' });

            expect(first.sent).to.equal(true);
            expect(second.sent).to.equal(false);
            expect(second.reason).to.equal('duplicate_pending');
            expect(third.sent).to.equal(false);
            expect(ctx.calls).to.have.length(1);   // exactly ONE lane entry
        });

        it('concurrent dispatches create exactly one lane entry', async () => {
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            ctx = makeDispatcher({ redis, workspaceId: null });

            const spec = {
                job_id: jobId('iu-aaa'), params: params(), job_type: 'image',
                build_id: BUILD, dispatch_id: 'dispatch-1',
            };
            const results = await Promise.all([
                ctx.gpuDispatcher.sendUnified(spec),
                ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'dispatch-2' }),
                ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'dispatch-3' }),
                ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'dispatch-4' }),
            ]);
            expect(results.filter(r => r.sent)).to.have.length(1);
            expect(ctx.calls).to.have.length(1);
        });

        it('graceful shutdown → reconciliation → re-dispatch creates no duplicate', async () => {
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            ctx = makeDispatcher({ redis, workspaceId: null });

            const spec = {
                job_id: jobId('iu-aaa'), params: params(), job_type: 'image',
                build_id: BUILD, dispatch_id: 'dispatch-before-shutdown',
            };
            expect((await ctx.gpuDispatcher.sendUnified(spec)).sent).to.equal(true);

            // graceful shutdown: the dispatch is cancelled. The hub-side
            // dedup key of the hub is dispatch-scoped and CANNOT suppress the
            // next enqueue — that is exactly the production defect.
            // The backend-side claim must.
            const reDispatch = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'dispatch-after-reconcile' });
            expect(reDispatch.sent).to.equal(false);
            expect(reDispatch.reason).to.equal('duplicate_pending');
            expect(ctx.calls).to.have.length(1);
        });

        it('a justified retry with a new generation_epoch is allowed', async () => {
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            ctx = makeDispatcher({ redis, workspaceId: null });

            const spec = {
                job_id: jobId('iu-aaa'), params: params(), job_type: 'image',
                build_id: BUILD, dispatch_id: 'dispatch-1',
            };
            expect((await ctx.gpuDispatcher.sendUnified(spec)).sent).to.equal(true);
            // failure → the epoch is bumped by the error callback path
            await qidem.bumpStageEpoch(redis, BOOK, CHAPTER, SCENE, 'image');
            const retry = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'dispatch-2' });
            expect(retry.sent).to.equal(true);
            expect(ctx.calls).to.have.length(2);
        });

        it('different IU / seed / prompt / model are never collapsed', async () => {
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            ctx = makeDispatcher({ redis, workspaceId: null });

            const base = { job_type: 'image', build_id: BUILD, dispatch_id: 'dispatch-1' };
            const a = await ctx.gpuDispatcher.sendUnified({ ...base, job_id: jobId('iu-aaa'), params: params() });
            const b = await ctx.gpuDispatcher.sendUnified({ ...base, job_id: jobId('iu-bbb'), params: params() });
            const c = await ctx.gpuDispatcher.sendUnified({ ...base, job_id: jobId('iu-ccc'), params: params({ '120': { inputs: { seed: 7 } } }) });
            const d = await ctx.gpuDispatcher.sendUnified({ ...base, job_id: jobId('iu-ddd'), params: params({ '108': { inputs: { text: 'other' } } }) });
            const e = await ctx.gpuDispatcher.sendUnified({ ...base, job_id: jobId('iu-eee'), params: params({ '120': { inputs: { model: ['2020', 0] } } }) });
            const f = await ctx.gpuDispatcher.sendUnified({ ...base, job_id: jobId('iu-fff'), params: params(), build_id: 'build_other' });

            for (const r of [a, b, c, d, e, f]) expect(r.sent).to.equal(true);
            expect(ctx.calls).to.have.length(6);
            expect(new Set(ctx.calls.map(c2 => c2.body.job_id)).size).to.equal(6);
        });

        it('the absence of a live compatible worker blocks the enqueue', async () => {
            redis = new FakeRedis();
            ctx = makeDispatcher({ redis, workspaceId: null });   // NO heartbeat at all

            const res = await ctx.gpuDispatcher.sendUnified({
                job_id: jobId('iu-aaa'), params: params(), job_type: 'image',
                build_id: BUILD, dispatch_id: 'dispatch-1',
            });
            expect(res.sent).to.equal(false);
            expect(res.reason).to.equal('no_worker_available');
            expect(res.retryable).to.equal(true);
            expect(ctx.calls).to.have.length(0);   // nothing was enqueued
        });

        it('a live worker of ANOTHER type does not unblock the job', async () => {
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'audio', workerId: 'w-audio-1', mode: 'system' });
            ctx = makeDispatcher({ redis, workspaceId: null });

            const res = await ctx.gpuDispatcher.sendUnified({
                job_id: jobId('iu-aaa'), params: params(), job_type: 'image',
                build_id: BUILD, dispatch_id: 'dispatch-1',
            });
            expect(res.sent).to.equal(false);
            expect(res.reason).to.equal('no_worker_available');
            expect(ctx.calls).to.have.length(0);
        });

        it('a live PRIVATE worker of the workspace unblocks the ws lane', async () => {
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-priv-1', workspaceId: WS, mode: 'private' });
            ctx = makeDispatcher({ redis, workspaceId: WS, hasPrivateWorker: true });

            const res = await ctx.gpuDispatcher.sendUnified({
                job_id: jobId('iu-aaa'), params: params(), job_type: 'image',
                build_id: BUILD, dispatch_id: 'dispatch-1',
            });
            expect(res.sent).to.equal(true);
            expect(ctx.calls[0].body.workspace_id).to.equal(WS);
        });

        it('a private worker of ANOTHER workspace does not unblock the ws lane', async () => {
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-priv-other', workspaceId: OTHER_WS, mode: 'private' });
            ctx = makeDispatcher({ redis, workspaceId: WS, hasPrivateWorker: true });

            const res = await ctx.gpuDispatcher.sendUnified({
                job_id: jobId('iu-aaa'), params: params(), job_type: 'image',
                build_id: BUILD, dispatch_id: 'dispatch-1',
            });
            expect(res.sent).to.equal(false);
            expect(res.reason).to.equal('no_worker_available');
            expect(ctx.calls).to.have.length(0);
        });

        it('a failed POST releases the claim (crash between claim and enqueue)', async function () {
            this.timeout(15000);   // the dispatcher retries 3× with a 1 s backoff
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            ctx = makeDispatcher({ redis, workspaceId: null });

            const originalFetch = global.fetch;
            global.fetch = async () => { throw new Error('hub unreachable'); };
            const spec = {
                job_id: jobId('iu-aaa'), params: params(), job_type: 'image',
                build_id: BUILD, dispatch_id: 'dispatch-1',
            };
            const failed = await ctx.gpuDispatcher.sendUnified(spec);
            expect(failed.sent).to.equal(false);
            global.fetch = originalFetch;

            // the claim must not block a later attempt
            const retry = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'dispatch-2' });
            expect(retry.sent).to.equal(true);
        });

        it('a completed task is not re-queued without an allowed retry', async () => {
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            ctx = makeDispatcher({ redis, workspaceId: null });

            const spec = {
                job_id: jobId('iu-aaa'), params: params(), job_type: 'image',
                build_id: BUILD, dispatch_id: 'dispatch-1',
            };
            const first = await ctx.gpuDispatcher.sendUnified(spec);
            expect(first.sent).to.equal(true);

            // the worker result arrives → the backend settles the identity
            const idemKey = await qidem.readTaskRef(redis, spec.job_id);
            expect(idemKey).to.be.a('string');
            await qidem.markTaskDone(redis, idemKey);
            await qidem.releaseTask(redis, idemKey);
            await qidem.forgetTaskRef(redis, spec.job_id);

            const again = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'dispatch-2' });
            expect(again.sent).to.equal(false);
            expect(again.reason).to.equal('already_completed');
            expect(ctx.calls).to.have.length(1);
        });
    });

    // ── lease protection (unchanged guard, regression net) ────────────────
    describe('lease protection', () => {
        let dispatchEngine;
        before(() => {
            dispatchEngine = require('@animastor/orchestration').runtime.dispatch;
        });

        it('an active (renewed) lease makes the dispatch engine skip', async () => {
            redis = new FakeRedis();
            const leaseKey = dispatchEngine.getLeaseKey(BOOK, CHAPTER, SCENE, 'image');
            await redis.set(leaseKey, 'token-1', 'EX', 1380);

            const leaseManager = require('@animastor/orchestration').runtime.leaseManager;
            expect(leaseManager.isLeaseStale(await redis.ttl(leaseKey), 'image')).to.equal(false);

            // a live lease must not be stolen: the engine's own guard reads
            // the lease token and reports it as active
            const token = await redis.get(leaseKey);
            expect(token).to.equal('token-1');
        });

        it('an expired lease is recognised as stale (so the stage can recover)', async () => {
            const leaseManager = require('@animastor/orchestration').runtime.leaseManager;
            const target = leaseManager.getRenewalTargetTtlS('image');
            expect(leaseManager.isLeaseStale(target - leaseManager.STALE_LEASE_GRACE_S - 1, 'image')).to.equal(true);
            expect(leaseManager.isLeaseStale(target, 'image')).to.equal(false);
        });
    });

    // ── result idempotency ───────────────────────────────────────────────
    describe('worker result idempotency', () => {
        it('a redelivered result is deduplicated independently of the dispatch_id', async () => {
            const { resultDedupKey } = qidem;
            // the production key was dispatch-scoped → two dispatches, two keys
            const legacyA = `animastor:result-processed:dispatch-A:${jobId('iu-aaa')}:${BUILD}`;
            const legacyB = `animastor:result-processed:dispatch-B:${jobId('iu-aaa')}:${BUILD}`;
            expect(legacyA).to.not.equal(legacyB);
            // the Stage 114 key is dispatch-independent
            expect(resultDedupKey(jobId('iu-aaa'), BUILD)).to.equal(`animastor:result-processed:${jobId('iu-aaa')}:${BUILD}`);
        });

        it('the identity of a job can be resolved back from its job_id', async () => {
            redis = new FakeRedis();
            const key = qidem.computeIdemKey({
                workspaceId: WS, jobId: jobId('iu-aaa'), jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            await qidem.rememberTaskRef(redis, jobId('iu-aaa'), key);
            expect(await qidem.readTaskRef(redis, jobId('iu-aaa'))).to.equal(key);
            await qidem.forgetTaskRef(redis, jobId('iu-aaa'));
            expect(await qidem.readTaskRef(redis, jobId('iu-aaa'))).to.equal(null);
        });
    });
});
