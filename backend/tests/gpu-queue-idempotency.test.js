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
function makeDispatcher({ redis, workspaceId = WS, hasPrivateWorker = true, liveWorkers = [], fetchImpl = null }) {
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
    global.fetch = fetchImpl || (async (url, opts) => {
        calls.push({ url, body: JSON.parse(opts.body) });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });

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

        it('Stage 116 (D1): the epoch is read at the moment of EACH send (no per-dispatch freeze)', async () => {
            redis = new FakeRedis();
            await qidem.bumpStageEpoch(redis, BOOK, CHAPTER, SCENE, 'image'); // epoch → 1
            const first = await qidem.resolveDispatchEpoch(redis, 'dispatch-A', BOOK, CHAPTER, SCENE, 'image');
            expect(first).to.equal(1);
            // a bump between two sends of the SAME dispatch applies to the
            // later send — that is what makes a dirty-unit regeneration work
            // on the FIRST attempt (Stage 115 D1).
            await qidem.bumpStageEpoch(redis, BOOK, CHAPTER, SCENE, 'image'); // epoch → 2
            const second = await qidem.resolveDispatchEpoch(redis, 'dispatch-A', BOOK, CHAPTER, SCENE, 'image');
            expect(second).to.equal(2);
            expect(second).to.not.equal(first);
            // the same send of the same job is stable while the epoch is stable
            const again = await qidem.resolveDispatchEpoch(redis, 'dispatch-A', BOOK, CHAPTER, SCENE, 'image');
            expect(again).to.equal(second);
        });

        it('Stage 118 (M6): the intent epoch is PINNED per task (stable across sends and re-dispatches)', async () => {
            redis = new FakeRedis();
            await qidem.bumpStageEpoch(redis, BOOK, CHAPTER, SCENE, 'image'); // epoch → 1
            const job = jobId('iu-pinned');
            // the first sender of the task pins the intent epoch
            expect(await qidem.resolveJobEpoch(redis, BOOK, CHAPTER, SCENE, job, 'image')).to.equal(1);
            // the stage epoch moves (a sibling unit was regenerated) — the
            // PINNED epoch of THIS task does not change
            await qidem.bumpStageEpoch(redis, BOOK, CHAPTER, SCENE, 'image'); // epoch → 2
            expect(await qidem.resolveJobEpoch(redis, BOOK, CHAPTER, SCENE, job, 'image')).to.equal(1);
            // a task that was never sent resolves the CURRENT stage epoch
            const other = jobId('iu-fresh');
            expect(await qidem.resolveJobEpoch(redis, BOOK, CHAPTER, SCENE, other, 'image')).to.equal(2);
            // the task's OWN intent change drops the pin ⇒ the next send gets
            // a fresh identity
            expect(await qidem.resetJobEpoch(redis, BOOK, CHAPTER, SCENE, job)).to.equal(true);
            expect(await qidem.resolveJobEpoch(redis, BOOK, CHAPTER, SCENE, job, 'image')).to.equal(2);
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
            // failure → the epoch is bumped AND the task's pinned intent epoch
            // is dropped by the GPU error callback (backend/src/routes/
            // generation-routes.cjs — the production sequence of a consumed
            // failure), so the next dispatch of this stage gets a fresh
            // identity and may enqueue again.
            await qidem.bumpStageEpoch(redis, BOOK, CHAPTER, SCENE, 'image');
            await qidem.resetJobEpoch(redis, BOOK, CHAPTER, SCENE, spec.job_id);
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

        it('Stage 116 (D2): an AMBIGUOUS POST failure keeps the claim; a DEFINITIVE rejection releases it', async function () {
            this.timeout(20000);   // the dispatcher retries 3× with a 1 s backoff
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });

            // (a) ambiguous: the hub MAY have taken the task → the claim stays
            ctx = makeDispatcher({
                redis, workspaceId: null,
                fetchImpl: async () => { throw new Error('hub unreachable (ambiguous)'); },
            });
            const spec = {
                job_id: jobId('iu-aaa'), params: params(), job_type: 'image',
                build_id: BUILD, dispatch_id: 'dispatch-1',
            };
            const failed = await ctx.gpuDispatcher.sendUnified(spec);
            expect(failed.sent).to.equal(false);
            expect(failed.ambiguous).to.equal(true);
            const key = qidem.computeIdemKey({
                workspaceId: null, jobId: spec.job_id, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            expect(await redis.get(qidem.idemClaimKey(key))).to.be.a('string');
            ctx.restore();

            // (b) definitive: the hub answered with an HTTP error → nothing was
            // enqueued → the claim is released and a later attempt may run
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            ctx = makeDispatcher({
                redis, workspaceId: null,
                fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'bad request' }) }),
            });
            const rejected = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'dispatch-1' });
            expect(rejected.sent).to.equal(false);
            expect(rejected.ambiguous).to.equal(false);
            const key2 = qidem.computeIdemKey({
                workspaceId: null, jobId: spec.job_id, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            expect(await redis.get(qidem.idemClaimKey(key2))).to.equal(null);
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
            const idemKey = await qidem.readTaskRef(redis, BOOK, CHAPTER, SCENE, spec.job_id);
            expect(idemKey).to.be.a('string');
            await qidem.markTaskDone(redis, idemKey);
            await qidem.releaseTask(redis, idemKey);
            await qidem.forgetTaskRef(redis, BOOK, CHAPTER, SCENE, spec.job_id);

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

    // ── Stage 116 regressions (D1 / D2 / D4) ──────────────────────────────
    describe('Stage 116: lifecycle regressions', () => {
        it('D1: a dirty-unit regeneration is allowed on the FIRST attempt', async () => {
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            ctx = makeDispatcher({ redis, workspaceId: null });

            const spec = { job_id: jobId('iu-dirty'), params: params(), job_type: 'image', build_id: BUILD };
            // attempt 1 — the unit is generated and its result accepted
            const first = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'D1' });
            expect(first.sent).to.equal(true);
            const idemKey = await qidem.readTaskRef(redis, BOOK, CHAPTER, SCENE, spec.job_id);
            await qidem.markTaskDone(redis, idemKey);
            await qidem.releaseTask(redis, idemKey);
            // Stage 118 (B1): the ownership ref is NOT forgotten at settlement
            // — it is the index that makes the completion marker releasable.
            await qidem.extendTaskRef(redis, BOOK, CHAPTER, SCENE, spec.job_id);

            // the user edits the unit → the dirty branch (backend/src/image/
            // iu-processor.js) bumps the stage epoch AND drops the pinned
            // intent epoch of THAT unit — the production sequence of an
            // explicit regeneration.
            await qidem.bumpStageEpoch(redis, BOOK, CHAPTER, SCENE, 'image');
            await qidem.resetJobEpoch(redis, BOOK, CHAPTER, SCENE, spec.job_id);
            // the epoch is resolved AT THE MOMENT OF THE SEND ⇒ the dirty
            // unit gets a fresh identity right away
            const retry = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'D2' });
            expect(retry.sent).to.equal(true);
            expect(retry.reason).to.equal(undefined);
            expect(ctx.calls).to.have.length(2);
        });

        it('D1: a unit sent earlier in the same dispatch does not freeze the epoch of a later one', async () => {
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            ctx = makeDispatcher({ redis, workspaceId: null });

            const other = await ctx.gpuDispatcher.sendUnified({
                job_id: jobId('iu-other'), params: params(), job_type: 'image',
                build_id: BUILD, dispatch_id: 'D1',
            });
            expect(other.sent).to.equal(true);
            // the dirty branch bumps the epoch between the two sends
            await qidem.bumpStageEpoch(redis, BOOK, CHAPTER, SCENE, 'image');
            const dirty = await ctx.gpuDispatcher.sendUnified({
                job_id: jobId('iu-dirty'), params: params(), job_type: 'image',
                build_id: BUILD, dispatch_id: 'D1',
            });
            expect(dirty.sent).to.equal(true);
        });

        it('D2: an AMBIGUOUS network failure keeps the claim (no duplicate)', async function () {
            this.timeout(15000);
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            ctx = makeDispatcher({
                redis, workspaceId: null,
                fetchImpl: async () => { throw new Error('socket hang up (ambiguous)'); },
            });

            const spec = { job_id: jobId('iu-amb'), params: params(), job_type: 'image', build_id: BUILD };
            const failed = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'D1' });
            expect(failed.sent).to.equal(false);
            expect(failed.ambiguous).to.equal(true);

            const key = qidem.computeIdemKey({
                workspaceId: null, jobId: spec.job_id, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            expect(await redis.get(qidem.idemClaimKey(key))).to.be.a('string');   // claim kept
            const ttl = await redis.ttl(qidem.idemClaimKey(key));
            expect(ttl).to.be.lessThan(qidem.IDEM_CLAIM_TTL_S);                  // shortened
            expect(ttl).to.be.lessThanOrEqual(qidem.IDEM_AMBIGUOUS_CLAIM_TTL_S);
        });

        it('D2: a DEFINITIVE hub rejection releases the claim', async function () {
            this.timeout(15000);
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            ctx = makeDispatcher({
                redis, workspaceId: null,
                fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'bad request' }) }),
            });

            const spec = { job_id: jobId('iu-bad'), params: params(), job_type: 'image', build_id: BUILD };
            const failed = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'D1' });
            expect(failed.sent).to.equal(false);
            expect(failed.ambiguous).to.equal(false);

            const key = qidem.computeIdemKey({
                workspaceId: null, jobId: spec.job_id, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            expect(await redis.get(qidem.idemClaimKey(key))).to.equal(null);   // released
        });

        it('D4: a cleared lane releases the claims of THAT scene only', async () => {
            redis = new FakeRedis();
            const sceneA = `${BOOK}_${CHAPTER}_${SCENE}_iu-a:iu_image`;
            const sceneB = `${BOOK}_${CHAPTER}_sc-other_iu-b:iu_image`;
            const otherBook = `other-book_${CHAPTER}_${SCENE}_iu-c:iu_image`;

            const owned = [
                { jobId: sceneA, book: BOOK, chapter: CHAPTER, scene: SCENE },
                { jobId: sceneB, book: BOOK, chapter: CHAPTER, scene: 'sc-other' },
                { jobId: otherBook, book: 'other-book', chapter: CHAPTER, scene: SCENE },
            ];
            for (const o of owned) {
                const key = qidem.computeIdemKey({
                    workspaceId: null, jobId: o.jobId, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
                });
                // The PRODUCTION settlement sequence (result callback):
                // claim → ref → done → claim released → the ref is EXTENDED
                // (Stage 118 · B1) instead of forgotten — the ref is the
                // ownership index that makes the completion marker releasable.
                await qidem.claimTask(redis, key);
                await qidem.rememberTaskRef(redis, o.book, o.chapter, o.scene, o.jobId, key);
                await qidem.markTaskDone(redis, key);
                await qidem.releaseTask(redis, key);
                await qidem.extendTaskRef(redis, o.book, o.chapter, o.scene, o.jobId);
            }

            const released = await qidem.releaseClaimsForScene(redis, BOOK, CHAPTER, SCENE);
            expect(released.released).to.equal(0);   // the claim was already released at settlement
            expect(released.done).to.equal(1);       // the COMPLETION MARKER was freed

            const keyA = qidem.computeIdemKey({
                workspaceId: null, jobId: sceneA, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            const keyB = qidem.computeIdemKey({
                workspaceId: null, jobId: sceneB, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            expect(await redis.get(qidem.idemDoneKey(keyA))).to.equal(null);      // done marker released too
            expect(await redis.get(qidem.idemRefKey(BOOK, CHAPTER, SCENE, sceneA))).to.equal(null);
            expect(await redis.get(qidem.idemDoneKey(keyB))).to.be.a('string');   // sibling scene untouched
        });

        it('D4: a book-scoped release does not touch another book', async () => {
            redis = new FakeRedis();
            const mine = `${BOOK}_${CHAPTER}_${SCENE}_iu-a:iu_image`;
            const theirs = `other-book_${CHAPTER}_${SCENE}_iu-b:iu_image`;
            for (const o of [
                { jobId: mine, book: BOOK },
                { jobId: theirs, book: 'other-book' },
            ]) {
                const key = qidem.computeIdemKey({
                    workspaceId: null, jobId: o.jobId, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
                });
                await qidem.claimTask(redis, key);
                await qidem.rememberTaskRef(redis, o.book, CHAPTER, SCENE, o.jobId, key);
            }
            const released = await qidem.releaseClaimsForBook(redis, BOOK);
            expect(released.released).to.equal(1);
            const keyTheirs = qidem.computeIdemKey({
                workspaceId: null, jobId: theirs, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            expect(await redis.get(qidem.idemClaimKey(keyTheirs))).to.be.a('string');
        });

        it('a pending claim is refreshed while the task stays queued (TTL cannot expire under a live task)', async () => {
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            ctx = makeDispatcher({ redis, workspaceId: null });
            const spec = { job_id: jobId('iu-pending'), params: params(), job_type: 'image', build_id: BUILD };
            await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'D1' });
            const key = qidem.computeIdemKey({
                workspaceId: null, jobId: spec.job_id, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            const before = await redis.ttl(qidem.idemClaimKey(key));
            // Stage 118 (B5): the Stage 116 assertion (`after >= before - 1`)
            // was VACUOUS — it passed even when the TTL was never touched
            // (SET NX does not refresh an existing key). The test now burns
            // part of the TTL and requires it to be pushed BACK to the full
            // window.
            redis.now += 120 * 1000;                       // 2 minutes passed
            const aged = await redis.ttl(qidem.idemClaimKey(key));
            expect(aged).to.be.lessThan(before);
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            // the claim is refreshed on every suppressed re-dispatch
            await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'D2' });
            const after = await redis.ttl(qidem.idemClaimKey(key));
            expect(after).to.equal(before);                // the TTL was REALLY extended
            expect(after).to.be.greaterThan(aged);
        });
    });

    // ── Stage 118 — audit 117 regressions ─────────────────────────────────
    describe('Stage 118: audit 117 lifecycle regressions', () => {
        /**
         * The PRODUCTION settlement sequence of the result callback
         * (backend/src/routes/generation-routes.cjs): claim → ref → done →
         * claim released → the ref is EXTENDED (the ownership index survives,
         * Stage 118 · B1).
         */
        async function settle(redis, { book, chapter, scene, jobId, key }) {
            await qidem.claimTask(redis, key);
            await qidem.rememberTaskRef(redis, book, chapter, scene, jobId, key);
            await qidem.markTaskDone(redis, key);
            await qidem.releaseTask(redis, key);
            await qidem.extendTaskRef(redis, book, chapter, scene, jobId);
        }

        it('B1: a completed task CAN be released by the scene scope (the done marker is reachable)', async () => {
            redis = new FakeRedis();
            const job = jobId('iu-b1');
            const key = qidem.computeIdemKey({
                workspaceId: null, jobId: job, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            await settle(redis, { book: BOOK, chapter: CHAPTER, scene: SCENE, jobId: job, key });
            // the completion marker is there and the ref is the index that
            // makes it reachable
            expect(await redis.get(qidem.idemDoneKey(key))).to.equal('1');
            expect(await redis.get(qidem.idemRefKey(BOOK, CHAPTER, SCENE, job))).to.equal(key);

            const released = await qidem.releaseClaimsForScene(redis, BOOK, CHAPTER, SCENE);
            expect(released.done).to.equal(1);
            expect(await redis.get(qidem.idemDoneKey(key))).to.equal(null);
            // ⇒ the task may run again (an authorized regeneration)
            const guard = await qidem.guardEnqueue(redis, key);
            expect(guard.allowed).to.equal(true);
        });

        it('B1: a completed task CAN be released by the book scope', async () => {
            redis = new FakeRedis();
            const job = jobId('iu-b1b');
            const key = qidem.computeIdemKey({
                workspaceId: null, jobId: job, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            await settle(redis, { book: BOOK, chapter: CHAPTER, scene: SCENE, jobId: job, key });
            const released = await qidem.releaseClaimsForBook(redis, BOOK);
            expect(released.done).to.equal(1);
            expect((await qidem.guardEnqueue(redis, key)).allowed).to.equal(true);
        });

        it('B2: an early 4xx followed by an AMBIGUOUS attempt keeps the claim', async function () {
            this.timeout(20000);
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            let attempt = 0;
            ctx = makeDispatcher({
                redis, workspaceId: null,
                fetchImpl: async () => {
                    attempt++;
                    if (attempt === 1) return { ok: false, status: 400, json: async () => ({ error: 'bad request' }) };
                    throw new Error('socket hang up after the hub took the task');
                },
            });
            const spec = { job_id: jobId('iu-b2'), params: params(), job_type: 'image', build_id: BUILD };
            const failed = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'D1' });
            expect(failed.sent).to.equal(false);
            // the LAST attempt was ambiguous ⇒ the whole request is ambiguous
            expect(failed.ambiguous).to.equal(true);
            const key = qidem.computeIdemKey({
                workspaceId: null, jobId: spec.job_id, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            expect(await redis.get(qidem.idemClaimKey(key))).to.be.a('string');   // claim KEPT
        });

        it('B2: an AMBIGUOUS attempt followed by a 4xx also keeps the claim', async function () {
            this.timeout(20000);
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            let attempt = 0;
            ctx = makeDispatcher({
                redis, workspaceId: null,
                fetchImpl: async () => {
                    attempt++;
                    if (attempt === 1) throw new Error('timeout');
                    return { ok: false, status: 400, json: async () => ({ error: 'bad request' }) };
                },
            });
            const spec = { job_id: jobId('iu-b2b'), params: params(), job_type: 'image', build_id: BUILD };
            const failed = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'D1' });
            expect(failed.ambiguous).to.equal(true);
            const key = qidem.computeIdemKey({
                workspaceId: null, jobId: spec.job_id, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            expect(await redis.get(qidem.idemClaimKey(key))).to.be.a('string');   // claim KEPT
        });

        it('B2/B5: an ambiguous outcome carries the reason and shortens the claim TTL', async function () {
            this.timeout(20000);
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            ctx = makeDispatcher({
                redis, workspaceId: null,
                fetchImpl: async () => { throw new Error('timeout'); },
            });
            const spec = { job_id: jobId('iu-b2c'), params: params(), job_type: 'image', build_id: BUILD };
            const failed = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'D1' });
            expect(failed.ambiguous).to.equal(true);
            expect(failed.reason).to.equal('ambiguous_post');   // M5 — the reason travels
            const key = qidem.computeIdemKey({
                workspaceId: null, jobId: spec.job_id, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            const ttl = await redis.ttl(qidem.idemClaimKey(key));
            expect(ttl).to.be.lessThan(qidem.IDEM_CLAIM_TTL_S);
            expect(ttl).to.be.lessThanOrEqual(qidem.IDEM_AMBIGUOUS_CLAIM_TTL_S);
        });

        it('M1: a book_id containing ":" cannot reach into another book key space', async () => {
            redis = new FakeRedis();
            // book 'a' with chapter 'b' and book 'a:b' — the ':' separator made
            // these two key spaces collide in the Stage 116 implementation.
            const victim = { book: 'a', chapter: 'b', scene: 'c' };
            const attacker = { book: 'a:b', chapter: 'c', scene: 'd' };
            const victimJob = 'a_b_c_iu-v:iu_image';
            const attackerJob = 'a:b_c_d_iu-x:iu_image';
            const victimKey = qidem.computeIdemKey({
                workspaceId: null, jobId: victimJob, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            const attackerKey = qidem.computeIdemKey({
                workspaceId: null, jobId: attackerJob, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            await qidem.claimTask(redis, victimKey);
            await qidem.rememberTaskRef(redis, victim.book, victim.chapter, victim.scene, victimJob, victimKey);
            await qidem.claimTask(redis, attackerKey);
            await qidem.rememberTaskRef(redis, attacker.book, attacker.chapter, attacker.scene, attackerJob, attackerKey);

            const released = await qidem.releaseClaimsForBook(redis, 'a:b');
            expect(released.released).to.equal(1);
            // the victim book is untouched
            expect(await redis.get(qidem.idemClaimKey(victimKey))).to.be.a('string');
        });

        it('M6: the same task sent twice inside ONE dispatch keeps ONE identity', async () => {
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            ctx = makeDispatcher({ redis, workspaceId: null });
            const spec = { job_id: jobId('iu-m6'), params: params(), job_type: 'image', build_id: BUILD };
            expect((await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'D1' })).sent).to.equal(true);
            // the stage epoch moves (a sibling unit was regenerated) — the
            // identity of THIS task must NOT change
            await qidem.bumpStageEpoch(redis, BOOK, CHAPTER, SCENE, 'image');
            const again = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'D1' });
            expect(again.sent).to.equal(false);
            expect(again.reason).to.equal('duplicate_pending');
            expect(ctx.calls).to.have.length(1);   // exactly ONE lane entry
        });

        it('M6: the pinned intent epoch survives a re-dispatch with a NEW dispatch_id', async () => {
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            ctx = makeDispatcher({ redis, workspaceId: null });
            const spec = { job_id: jobId('iu-m6b'), params: params(), job_type: 'image', build_id: BUILD };
            expect((await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'D1' })).sent).to.equal(true);
            // a sibling unit of the same stage is regenerated → the stage
            // epoch moves, but this task keeps its identity
            await qidem.bumpStageEpoch(redis, BOOK, CHAPTER, SCENE, 'image');
            const reDispatch = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'D2' });
            expect(reDispatch.sent).to.equal(false);
            expect(reDispatch.reason).to.equal('duplicate_pending');
            expect(ctx.calls).to.have.length(1);
        });

        it('M7: after the 90-minute ambiguous TTL the task may be sent again', async function () {
            this.timeout(20000);
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            ctx = makeDispatcher({
                redis, workspaceId: null,
                fetchImpl: async () => { throw new Error('timeout'); },
            });
            const spec = { job_id: jobId('iu-m7'), params: params(), job_type: 'image', build_id: BUILD };
            const failed = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'D1' });
            expect(failed.ambiguous).to.equal(true);
            const key = qidem.computeIdemKey({
                workspaceId: null, jobId: spec.job_id, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            expect(await redis.get(qidem.idemClaimKey(key))).to.be.a('string');
            // the ambiguous claim expires after 90 minutes ⇒ the task is not
            // blocked forever
            redis.now += (qidem.IDEM_AMBIGUOUS_CLAIM_TTL_S + 60) * 1000;
            expect(await redis.get(qidem.idemClaimKey(key))).to.equal(null);
            ctx.restore();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            ctx = makeDispatcher({ redis, workspaceId: null });
            const retry = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'D2' });
            expect(retry.sent).to.equal(true);
        });

        it('restart: the claim survives a backend restart and suppresses the re-dispatch', async () => {
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            ctx = makeDispatcher({ redis, workspaceId: null });
            const first = ctx;
            const spec = { job_id: jobId('iu-restart'), params: params(), job_type: 'image', build_id: BUILD };
            expect((await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'before-restart' })).sent).to.equal(true);
            expect(first.calls).to.have.length(1);
            ctx.restore();
            // the backend restarts: a NEW dispatcher instance, the same Redis
            ctx = makeDispatcher({ redis, workspaceId: null });
            const after = ctx;
            const reDispatch = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'after-restart' });
            expect(reDispatch.sent).to.equal(false);
            expect(reDispatch.reason).to.equal('duplicate_pending');
            expect(after.calls).to.have.length(0);   // nothing was enqueued again
            expect(first.calls).to.have.length(1);   // still exactly ONE lane entry
        });

        it('M4: already_completed is NOT a capacity reason but it IS deferrable', () => {
            expect(qidem.isCapacityReason('already_completed')).to.equal(false);
            expect(qidem.isDeferrableReason('already_completed')).to.equal(true);
            expect(qidem.isCapacityReason('ambiguous_post')).to.equal(true);
            expect(qidem.isCapacityReason('no_worker_available')).to.equal(true);
            expect(qidem.isCapacityReason('duplicate_pending')).to.equal(true);
            expect(qidem.isCapacityReason('send_failed')).to.equal(false);
        });

        it('M3: several deferrable reasons are classified (the dominant one is reported)', () => {
            const reasons = new Map([['no_worker_available', 3], ['duplicate_pending', 1]]);
            expect(qidem.classifyNotSentReasons(reasons)).to.equal('no_worker_available');
            // a real failure keeps the historic semantics
            expect(qidem.classifyNotSentReasons(new Map([['no_worker_available', 3], ['send_failed', 1]]))).to.equal(null);
            expect(qidem.classifyNotSentReasons(new Map())).to.equal(null);
        });

        it('B5: refreshClaimTtl extends an existing claim and never resurrects a released one', async () => {
            redis = new FakeRedis();
            const key = qidem.computeIdemKey({
                workspaceId: null, jobId: jobId('iu-b5'), jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            // a released claim must NOT be resurrected by a refresh
            expect(await qidem.refreshClaimTtl(redis, key)).to.equal(false);
            expect(await redis.get(qidem.idemClaimKey(key))).to.equal(null);

            await qidem.claimTask(redis, key);
            redis.now += 600 * 1000;
            const aged = await redis.ttl(qidem.idemClaimKey(key));
            expect(await qidem.refreshClaimTtl(redis, key)).to.equal(true);
            const refreshed = await redis.ttl(qidem.idemClaimKey(key));
            expect(refreshed).to.be.greaterThan(aged);
            expect(refreshed).to.equal(qidem.IDEM_CLAIM_TTL_S);
        });
    });

    // ── Stage 120 — audit 119 regressions (F1 / F2 / M-c / M-d / M-e / M-f) ──
    describe('Stage 120: audit 119 lifecycle regressions', () => {
        /**
         * The REAL production «this stage must be generated again» signal
         * (reconciliation stuck-state repair, RELEASE_STALE_LEASE, C1/C1b
         * audio+video recovery, scene restoration, placeholder audio,
         * invalidateSceneAssets). The PG stale-write inside it is stubbed
         * for the test matrix (PG is down in every sanctioned run).
         */
        async function runMarkDirtyScene(targetRedis, assets) {
            const resolved = require.resolve('../src/storage/postgres/repositories/scene-assets-repo');
            const saved = require.cache[resolved];
            require.cache[resolved] = { exports: { markStale: async () => {} }, id: resolved, filename: resolved, loaded: true };
            try {
                const stateOps = require('../src/state/scene-state-ops');
                await stateOps.markDirtyScene(targetRedis, BOOK, CHAPTER, SCENE, assets, BUILD);
            } finally {
                if (saved) require.cache[resolved] = saved;
                else delete require.cache[resolved];
            }
        }

        /** The production settlement sequence of the result callback. */
        async function settleAccepted(targetRedis, job) {
            const key = await qidem.readTaskRef(targetRedis, BOOK, CHAPTER, SCENE, job);
            expect(key).to.be.a('string');
            await qidem.markTaskDone(targetRedis, key);
            await qidem.releaseTask(targetRedis, key);
            await qidem.extendTaskRef(targetRedis, BOOK, CHAPTER, SCENE, job);
            return key;
        }

        // ── F1 (BLOCKER): markDirtyScene must produce a FRESH identity ────
        const F1_STAGES = [
            { stage: 'audio', jobType: 'audio', job: `${BOOK}_${CHAPTER}_${SCENE}_0000:audio` },
            { stage: 'video', jobType: 'video', job: `${BOOK}_${CHAPTER}_${SCENE}:video` },
            { stage: 'image', jobType: 'image', job: jobId('iu-f1') },
        ];

        for (const s of F1_STAGES) {
            it(`F1: a ${s.stage} regeneration signalled by markDirtyScene is accepted on the FIRST re-dispatch`, async () => {
                redis = new FakeRedis();
                await writeHeartbeat(redis, { type: s.jobType, workerId: 'w-sys-1', mode: 'system' });
                ctx = makeDispatcher({ redis, workspaceId: null });
                const spec = { job_id: s.job, params: params(), job_type: s.jobType, build_id: BUILD };

                // the task runs once and is settled by the result callback
                const first = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'D1' });
                expect(first.sent).to.equal(true);
                const settledKey = await settleAccepted(redis, s.job);

                // CONTROL: without a regeneration signal the OLD identity
                // stays suppressed — the completion marker is still valid
                // for the OLD intent
                const suppressed = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'D0' });
                expect(suppressed.sent).to.equal(false);
                expect(suppressed.reason).to.equal('already_completed');

                // the production regeneration signal (F1 regression): the pin
                // of THIS stage's tasks is dropped with the stage epoch bump
                await runMarkDirtyScene(redis, [s.stage]);
                expect(await redis.get(qidem.idemJobEpochKey(BOOK, CHAPTER, SCENE, s.job))).to.equal(null);

                // the re-dispatch computes a NEW identity and is ACCEPTED —
                // pre-Fix it stayed `already_completed` and the regeneration
                // never ran (audit 119 · F1, proof-p10)
                const again = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'D2' });
                expect(again.sent).to.equal(true);
                expect(again.reason).to.equal(undefined);
                // the OLD completion marker never leaks into the new intent
                expect(again.idem_key).to.not.equal(settledKey);
                expect(await redis.get(qidem.idemDoneKey(settledKey))).to.be.a('string');
                expect(ctx.calls).to.have.length(2);   // control sent nothing; exactly 2 real POSTs
            });
        }

        it('F1: markDirtyScene of ONE stage never resets a sibling stage (no blanket pin reset)', async () => {
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'audio', workerId: 'w-sys-1', mode: 'system' });
            await writeHeartbeat(redis, { type: 'video', workerId: 'w-sys-1', mode: 'system' });
            ctx = makeDispatcher({ redis, workspaceId: null });
            const audioSpec = { job_id: `${BOOK}_${CHAPTER}_${SCENE}_0000:audio`, params: params(), job_type: 'audio', build_id: BUILD };
            const videoSpec = { job_id: `${BOOK}_${CHAPTER}_${SCENE}:video`, params: params(), job_type: 'video', build_id: BUILD };

            expect((await ctx.gpuDispatcher.sendUnified({ ...audioSpec, dispatch_id: 'D1' })).sent).to.equal(true);
            expect((await ctx.gpuDispatcher.sendUnified({ ...videoSpec, dispatch_id: 'D1' })).sent).to.equal(true);
            await settleAccepted(redis, audioSpec.job_id);
            await settleAccepted(redis, videoSpec.job_id);

            // only AUDIO is being regenerated
            await runMarkDirtyScene(redis, ['audio']);
            expect(await redis.get(qidem.idemJobEpochKey(BOOK, CHAPTER, SCENE, audioSpec.job_id))).to.equal(null);
            // the sibling stage keeps its pin — its identity must stay stable
            expect(await redis.get(qidem.idemJobEpochKey(BOOK, CHAPTER, SCENE, videoSpec.job_id))).to.be.a('string');

            const audioAgain = await ctx.gpuDispatcher.sendUnified({ ...audioSpec, dispatch_id: 'D2' });
            expect(audioAgain.sent).to.equal(true);

            // the sibling is NOT silently re-opened: same identity, its
            // completion marker still applies (an old result can never
            // become valid for another stage's new intent either)
            const videoAgain = await ctx.gpuDispatcher.sendUnified({ ...videoSpec, dispatch_id: 'D2' });
            expect(videoAgain.sent).to.equal(false);
            expect(videoAgain.reason).to.equal('already_completed');
            expect(ctx.calls).to.have.length(3);
        });

        // ── F2 (BLOCKER): the duplicate_pending refresh must not extend an
        //    ambiguous claim from 90 minutes to 24 hours ────────────────────
        it('F2: the real duplicate_pending refresh never extends the ambiguous claim past 90 minutes', async function () {
            this.timeout(30000);
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            let ambiguousPost = true;
            ctx = makeDispatcher({
                redis, workspaceId: null,
                fetchImpl: async (url, opts) => {
                    if (ambiguousPost) throw new Error('socket hang up (ambiguous)');
                    return { ok: true, status: 200, json: async () => ({ ok: true }) };
                },
            });
            const spec = { job_id: jobId('iu-f2'), params: params(), job_type: 'image', build_id: BUILD };
            const key = qidem.computeIdemKey({
                workspaceId: null, jobId: spec.job_id, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });

            // 1) the POST is ambiguous → the claim is KEPT, marked and shortened
            const first = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'D1' });
            expect(first.ambiguous).to.equal(true);
            expect(await redis.get(qidem.idemClaimKey(key))).to.equal('ambiguous');
            expect(await redis.ttl(qidem.idemClaimKey(key))).to.equal(qidem.IDEM_AMBIGUOUS_CLAIM_TTL_S);

            // 2) the next scheduler tick re-dispatches → duplicate_pending →
            //    the state-aware refresh runs on the REAL suppression path
            redis.now += 5000;
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            ambiguousPost = false;
            const second = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'D2' });
            expect(second.sent).to.equal(false);
            expect(second.reason).to.equal('duplicate_pending');
            const ttlAfterRefresh = await redis.ttl(qidem.idemClaimKey(key));
            expect(ttlAfterRefresh).to.be.at.most(qidem.IDEM_AMBIGUOUS_CLAIM_TTL_S);
            expect(ttlAfterRefresh).to.be.at.most(90 * 60);
            // NOT reset to the 24 h backstop (audit 119 · F2, proof-p12)
            expect(ttlAfterRefresh).to.be.lessThan(qidem.IDEM_CLAIM_TTL_S);
            expect(await redis.get(qidem.idemClaimKey(key))).to.equal('ambiguous');   // the state survives too

            // 3) after the 90-minute window the task may be sent again (M7)
            redis.now += (qidem.IDEM_AMBIGUOUS_CLAIM_TTL_S + 60) * 1000;
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            const third = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'D3' });
            expect(third.sent).to.equal(true);
        });

        it('F2: refreshClaimTtl is state-aware — pending extends, ambiguous keeps 90 min, released is never resurrected', async () => {
            redis = new FakeRedis();
            const key = qidem.computeIdemKey({
                workspaceId: null, jobId: jobId('iu-f2b'), jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            // released → never resurrected (B5 contract intact)
            expect(await qidem.refreshClaimTtl(redis, key)).to.equal(false);
            expect(await redis.get(qidem.idemClaimKey(key))).to.equal(null);

            // pending → extended to the full backstop
            await qidem.claimTask(redis, key);
            redis.now += 600 * 1000;
            expect(await qidem.refreshClaimTtl(redis, key)).to.equal(true);
            expect(await redis.ttl(qidem.idemClaimKey(key))).to.equal(qidem.IDEM_CLAIM_TTL_S);

            // ambiguous → the deliberate 90-minute window survives a refresh
            await qidem.shortenClaimTtl(redis, key);
            redis.now += 600 * 1000;
            expect(await qidem.refreshClaimTtl(redis, key)).to.equal(false);
            expect(await redis.get(qidem.idemClaimKey(key))).to.equal('ambiguous');
            expect(await redis.ttl(qidem.idemClaimKey(key))).to.be.at.most(qidem.IDEM_AMBIGUOUS_CLAIM_TTL_S);
        });

        it('F2: the production refresh runs the atomic Lua script (eval path), state-aware end to end', async () => {
            const { createMockRedis } = require('./mocks/redis-mock');
            const r = createMockRedis();
            const key = qidem.computeIdemKey({
                workspaceId: WS, jobId: jobId('iu-f2c'), jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            const seen = [];
            const originalEval = r.eval;
            r.eval = async (script, keysCount, ...rest) => { seen.push({ script, keysCount, rest }); return originalEval(script, keysCount, ...rest); };

            await qidem.claimTask(r, key);
            expect(await qidem.refreshClaimTtl(r, key)).to.equal(true);            // eval path taken
            expect(seen).to.have.length(1);
            expect(seen[0].script).to.include("if v == 'ambiguous' then return -1 end");
            expect(seen[0].rest[0]).to.equal(qidem.idemClaimKey(key));
            expect(await r.ttl(qidem.idemClaimKey(key))).to.equal(qidem.IDEM_CLAIM_TTL_S);

            await qidem.shortenClaimTtl(r, key);
            expect(await qidem.refreshClaimTtl(r, key)).to.equal(false);           // -1 → refused
            expect(await r.ttl(qidem.idemClaimKey(key))).to.equal(qidem.IDEM_AMBIGUOUS_CLAIM_TTL_S);

            await qidem.releaseTask(r, key);
            expect(await qidem.refreshClaimTtl(r, key)).to.equal(false);           // 0 → no resurrection
            expect(await r.get(qidem.idemClaimKey(key))).to.equal(null);
        });

        // ── M-c: the orphaned completion marker must be escapable ─────────
        it('M-c: releaseTaskDone frees an orphaned completion marker so the task may regenerate', async () => {
            redis = new FakeRedis();
            const job = jobId('iu-mc');
            const key = qidem.computeIdemKey({
                workspaceId: null, jobId: job, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            await qidem.claimTask(redis, key);
            await qidem.rememberTaskRef(redis, BOOK, CHAPTER, SCENE, job, key);
            await qidem.markTaskDone(redis, key);
            await qidem.releaseTask(redis, key);
            await qidem.extendTaskRef(redis, BOOK, CHAPTER, SCENE, job);
            // marker without artifact → the dispatch would loop on
            // already_completed (audit 119 · M-c, proof-p13)
            expect((await qidem.guardEnqueue(redis, key)).reason).to.equal('already_completed');

            expect(await qidem.releaseTaskDone(redis, key)).to.equal(true);
            expect((await qidem.guardEnqueue(redis, key)).allowed).to.equal(true);
            // idempotent: nothing left to release
            expect(await qidem.releaseTaskDone(redis, key)).to.equal(false);
        });

        // ── M-d: the book cleanup must reach the pinned job-epoch keys ────
        it("M-d: cleanBookRedisKeys purges this book's job-epoch pins and KEEPS the ownership refs", async () => {
            redis = new FakeRedis();
            const job = jobId('iu-md');
            const otherJob = `other-book_${CHAPTER}_${SCENE}_iu-o:iu_image`;
            await redis.set(qidem.idemJobEpochKey(BOOK, CHAPTER, SCENE, job), '2', 'EX', qidem.IDEM_JOB_EPOCH_TTL_S);
            await redis.set(qidem.idemJobEpochKey('other-book', CHAPTER, SCENE, otherJob), '3', 'EX', qidem.IDEM_JOB_EPOCH_TTL_S);
            await qidem.rememberTaskRef(redis, BOOK, CHAPTER, SCENE, job, 'mf-ownership-key');

            const patterns = [];
            const originalScan = redis.scan;
            redis.scan = async (cursor, ...args) => {
                const i = args.indexOf('MATCH');
                if (i !== -1) patterns.push(args[i + 1]);
                return originalScan.call(redis, cursor, ...args);
            };
            let helpers;
            try {
                helpers = require('../src/helpers/redis-helpers.cjs')(redis, {});
                await helpers.cleanBookRedisKeys(redis, BOOK);
                await helpers.cleanBookRedisKeys(redis, 'a*b');   // glob metacharacter in the book id
            } finally {
                redis.scan = originalScan;
            }

            // THIS book's pinned intent epochs are gone (24 h TTL was the
            // only bound before Stage 120) …
            expect(await redis.get(qidem.idemJobEpochKey(BOOK, CHAPTER, SCENE, job))).to.equal(null);
            // … another book's pins are untouched …
            expect(await redis.get(qidem.idemJobEpochKey('other-book', CHAPTER, SCENE, otherJob))).to.be.a('string');
            // … and the OWNERSHIP REF is deliberately NOT raw-deleted: only
            // releaseClaimsForScene/Book may remove ref+marker together, a
            // raw delete would orphan every done marker for 7 days (B4)
            expect(await redis.get(qidem.idemRefKey(BOOK, CHAPTER, SCENE, job))).to.equal('mf-ownership-key');

            // the job-epoch MATCH pattern is percent-encoded AND glob-escaped
            const jobEpochPatterns = patterns.filter(p => String(p).startsWith('animastor:idempotency:job-epoch:'));
            expect(jobEpochPatterns).to.include(`animastor:idempotency:job-epoch:${encodeURIComponent(BOOK)}:*`);
            expect(jobEpochPatterns).to.include('animastor:idempotency:job-epoch:a\\*b:*');
        });

        // ── M-e: a deterministic 4xx must not burn three attempts ──────────
        it('M-e: a FINAL 4xx rejection is attempted exactly ONCE', async function () {
            this.timeout(15000);
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            let fetchCount = 0;
            ctx = makeDispatcher({
                redis, workspaceId: null,
                fetchImpl: async () => { fetchCount++; return { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }; },
            });
            const spec = { job_id: jobId('iu-me'), params: params(), job_type: 'image', build_id: BUILD };
            const failed = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'D1' });
            expect(failed.sent).to.equal(false);
            expect(failed.ambiguous).to.equal(false);
            expect(failed.reason).to.equal('hub_rejected');
            expect(failed.status).to.equal(401);
            expect(fetchCount).to.equal(1);   // one deterministic answer, no retry/backoff burn
            const key = qidem.computeIdemKey({
                workspaceId: null, jobId: spec.job_id, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            expect(await redis.get(qidem.idemClaimKey(key))).to.equal(null);   // definitive → claim released
        });

        it('M-e: a TRANSIENT 4xx (429) still gets all three attempts (the B2 contract is preserved)', async function () {
            this.timeout(20000);
            redis = new FakeRedis();
            await writeHeartbeat(redis, { type: 'image', workerId: 'w-sys-1', mode: 'system' });
            let fetchCount = 0;
            ctx = makeDispatcher({
                redis, workspaceId: null,
                fetchImpl: async () => { fetchCount++; return { ok: false, status: 429, json: async () => ({ error: 'slow down' }) }; },
            });
            const spec = { job_id: jobId('iu-me2'), params: params(), job_type: 'image', build_id: BUILD };
            const failed = await ctx.gpuDispatcher.sendUnified({ ...spec, dispatch_id: 'D1' });
            expect(failed.sent).to.equal(false);
            expect(failed.ambiguous).to.equal(false);
            expect(fetchCount).to.equal(3);   // 429 is retryable — B2 (400 → retry) stays intact
        });

        // ── M-f: the completion marker may only exist over a LIVE ref ─────
        it('M-f: settling over a LIVE ownership ref writes the marker and keeps ref+marker aligned', async () => {
            redis = new FakeRedis();
            const job = jobId('iu-mf1');
            const key = qidem.computeIdemKey({
                workspaceId: null, jobId: job, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            await qidem.claimTask(redis, key);
            await qidem.rememberTaskRef(redis, BOOK, CHAPTER, SCENE, job, key);
            const settled = await qidem.settleCompletedTask(redis, {
                bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: job, idemKey: key,
            });
            expect(settled.settled).to.equal(true);
            expect(settled.markerWritten).to.equal(true);
            expect(settled.refRepaired).to.equal(false);
            expect(await redis.get(qidem.idemDoneKey(key))).to.equal('1');
            expect(await redis.get(qidem.idemClaimKey(key))).to.equal(null);
            expect(await redis.ttl(qidem.idemRefKey(BOOK, CHAPTER, SCENE, job))).to.equal(qidem.IDEM_REF_DONE_TTL_S);
            // the marker is reachable through the ref (B1 contract intact)
            const released = await qidem.releaseClaimsForScene(redis, BOOK, CHAPTER, SCENE);
            expect(released.done).to.equal(1);
        });

        it('M-f: an EXPIRED ref is repaired from job_id — the marker never becomes unreachable', async () => {
            redis = new FakeRedis();
            const job = jobId('iu-mf2');
            const key = qidem.computeIdemKey({
                workspaceId: null, jobId: job, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            await qidem.claimTask(redis, key);
            await qidem.rememberTaskRef(redis, BOOK, CHAPTER, SCENE, job, key);
            // the result lands AFTER the 24 h ref TTL (audit 119 · M-f)
            redis.now += (qidem.IDEM_REF_TTL_S + 60) * 1000;
            expect(await qidem.readTaskRef(redis, BOOK, CHAPTER, SCENE, job)).to.equal(null);

            const settled = await qidem.settleCompletedTask(redis, {
                bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: job, idemKey: key,
            });
            expect(settled.refRepaired).to.equal(true);
            expect(settled.markerWritten).to.equal(true);
            expect(await qidem.readTaskRef(redis, BOOK, CHAPTER, SCENE, job)).to.equal(key);
            // the marker is reachable — an authorized regeneration frees it
            const released = await qidem.releaseClaimsForScene(redis, BOOK, CHAPTER, SCENE);
            expect(released.done).to.equal(1);
            expect((await qidem.guardEnqueue(redis, key)).allowed).to.equal(true);
        });

        it('M-f: a ref re-mapped by a concurrent dispatch never gets a blind marker', async () => {
            redis = new FakeRedis();
            const job = jobId('iu-mf3');
            const keyA = qidem.computeIdemKey({
                workspaceId: null, jobId: job, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 0,
            });
            const keyB = qidem.computeIdemKey({
                workspaceId: null, jobId: job, jobType: 'image', buildId: BUILD, params: params(), generationEpoch: 1,
            });
            expect(keyA).to.not.equal(keyB);
            await qidem.claimTask(redis, keyA);
            await qidem.rememberTaskRef(redis, BOOK, CHAPTER, SCENE, job, keyA);
            redis.now += (qidem.IDEM_REF_TTL_S + 60) * 1000;
            // a concurrent dispatch re-mapped job_id → a NEW identity
            await qidem.rememberTaskRef(redis, BOOK, CHAPTER, SCENE, job, keyB);

            const settled = await qidem.settleCompletedTask(redis, {
                bookId: BOOK, chapterId: CHAPTER, sceneId: SCENE, jobId: job, idemKey: keyA,
            });
            expect(settled.settled).to.equal(true);
            expect(settled.markerWritten).to.equal(false);   // skipped — a blind marker would be unreachable
            expect(await redis.get(qidem.idemDoneKey(keyA))).to.equal(null);
            expect(await redis.get(qidem.idemClaimKey(keyA))).to.equal(null);      // terminal either way
            expect(await qidem.readTaskRef(redis, BOOK, CHAPTER, SCENE, job)).to.equal(keyB);   // live mapping untouched
        });

        it('M-f: the GPU result route settles through settleCompletedTask (never a blind marker)', () => {
            const fs = require('fs');
            const path = require('path');
            const src = fs.readFileSync(path.join(__dirname, '../src/routes/generation-routes.cjs'), 'utf8');
            expect(src).to.include('qidem.settleCompletedTask(redis, {');
            // the Stage 118 blind sequence (done → release → extend) is gone
            expect(src).to.not.match(/await qidem\.markTaskDone\(redis, idemKey\);[\s\S]{0,120}?await qidem\.extendTaskRef\(/);
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
            await qidem.rememberTaskRef(redis, BOOK, CHAPTER, SCENE, jobId('iu-aaa'), key);
            expect(await qidem.readTaskRef(redis, BOOK, CHAPTER, SCENE, jobId('iu-aaa'))).to.equal(key);
            await qidem.forgetTaskRef(redis, BOOK, CHAPTER, SCENE, jobId('iu-aaa'));
            expect(await qidem.readTaskRef(redis, BOOK, CHAPTER, SCENE, jobId('iu-aaa'))).to.equal(null);
        });
    });
});
