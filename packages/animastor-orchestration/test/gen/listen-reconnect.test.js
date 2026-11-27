'use strict';
// 1.4.3 — LISTEN gen_progress survives a lost PG connection (ADR §9 «Доставка»).
// Real PG of the animastor-test stack: the listener's backend is killed with
// pg_terminate_backend; the process stays alive (no unhandled 'error'), the
// listener reconnects after the pause, calls onReconnect, and NOTIFY reaches
// it again. close() during the pause stops the loop and leaks no client.

const assert = require('node:assert/strict');
const gen = require('../../src/gen');
const { DEFAULT_RELISTEN_DELAYS_MS } = require('../../src/gen/progress');
const { setupDb, makePorts, SECRET } = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 5000, label = 'condition') {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await pred()) return; await sleep(20); }
    throw new Error(`timeout waiting for ${label}`);
}

describe('gen v2 — LISTEN gen_progress reconnects after a lost connection (1.4.3)', function () {
    this.timeout(30000);
    let ctx; let o; let sub;
    const uncaught = [];
    const onUncaught = (err) => { uncaught.push(err); };

    beforeEach(async () => {
        ctx = await setupDb();
        o = gen.createOrchestration({ pool: ctx.pool, ports: makePorts(ctx, { ch: { s1: 1 } }).ports, uploadSecret: SECRET, outputDir: ctx.outputDir });
        uncaught.length = 0;
        process.on('uncaughtException', onUncaught);
    });
    afterEach(async () => {
        process.removeListener('uncaughtException', onUncaught);
        if (sub) { await sub.close(); sub = null; }
        o.stop();
        await ctx.teardown();
    });

    const notify = (bookId) => ctx.admin.query('SELECT pg_notify($1, $2)', ['gen_progress', JSON.stringify({ book_id: bookId, command_id: null })]);
    const kill = (pid) => ctx.admin.query('SELECT pg_terminate_backend($1) AS ok', [pid]).then((r) => r.rows[0].ok);
    const checkedOut = () => ctx.pool.totalCount - ctx.pool.idleCount;

    it('default pauses are 1 → 2 → 5 → 10 → 30 s', () => {
        assert.deepEqual([...DEFAULT_RELISTEN_DELAYS_MS], [1000, 2000, 5000, 10000, 30000]);
    });

    it('pg_terminate_backend → process alive → re-LISTEN → onReconnect → NOTIFY arrives again', async () => {
        const events = [];
        const log = [];
        sub = await o.listenProgress((e) => events.push(e.book_id), {
            delaysMs: [50, 100],
            onDisconnect: (err) => log.push(['down', err && err.message]),
            onReconnect: () => log.push(['up']),
        });
        await notify('before');
        await until(() => events.includes('before'), 5000, 'NOTIFY before the drop');
        const pid1 = sub.pid();
        assert.ok(pid1 > 0);

        assert.equal(await kill(pid1), true);
        await until(() => log.some((l) => l[0] === 'down'), 5000, 'onDisconnect');
        await until(() => log.some((l) => l[0] === 'up'), 5000, 'onReconnect');
        assert.equal(log.filter((l) => l[0] === 'down').length, 1, 'one disconnect line per drop');
        assert.equal(log.filter((l) => l[0] === 'up').length, 1, 'one reconnect line');
        assert.equal(sub.connected(), true);
        const pid2 = sub.pid();
        assert.ok(pid2 > 0 && pid2 !== pid1, 'a new backend connection');

        await notify('after');
        await until(() => events.includes('after'), 5000, 'NOTIFY after the reconnect');
        assert.deepEqual(uncaught, [], 'no uncaught exception (the error handler is in place)');
        assert.equal(checkedOut(), 1, 'exactly the listener is checked out');
    });

    it('two drops in a row: each is one onDisconnect + one onReconnect', async () => {
        const log = [];
        sub = await o.listenProgress(() => {}, { delaysMs: [30], onDisconnect: () => log.push('down'), onReconnect: () => log.push('up') });
        for (let i = 0; i < 2; i += 1) {
            assert.equal(await kill(sub.pid()), true);
            await until(() => log.filter((x) => x === 'up').length === i + 1, 5000, `reconnect #${i + 1}`);
        }
        assert.deepEqual(log, ['down', 'up', 'down', 'up']);
        assert.deepEqual(uncaught, []);
    });

    it('a failing reconnect (pool.connect throws twice) keeps retrying; onDisconnect / onReconnect once each', async () => {
        const log = [];
        sub = await o.listenProgress(() => {}, { delaysMs: [30, 60], onDisconnect: () => log.push('down'), onReconnect: () => log.push('up') });
        const realConnect = ctx.pool.connect.bind(ctx.pool);
        let fails = 2; let tries = 0;
        ctx.pool.connect = (...a) => { tries += 1; if (fails > 0) { fails -= 1; return Promise.reject(new Error('ECONNREFUSED (test)')); } return realConnect(...a); };
        try {
            assert.equal(await kill(sub.pid()), true);
            await until(() => log.includes('up'), 5000, 'reconnect after two failures');
        } finally { ctx.pool.connect = realConnect; }
        assert.equal(tries, 3, 'two failed attempts + the successful one');
        assert.deepEqual(log, ['down', 'up']);
        await notify('again');
        assert.deepEqual(uncaught, []);
    });

    it('close() during the pause stops reconnecting and leaks no client', async () => {
        const log = [];
        sub = await o.listenProgress(() => {}, { delaysMs: [400], onDisconnect: () => log.push('down'), onReconnect: () => log.push('up') });
        assert.equal(await kill(sub.pid()), true);
        await until(() => log.includes('down'), 5000, 'onDisconnect');
        assert.equal(sub.connected(), false);
        await sub.close();
        sub = null;
        await sleep(800);                       // past the pause: nothing may reconnect
        assert.deepEqual(log, ['down']);
        assert.equal(checkedOut(), 0, 'no client left checked out');
        assert.deepEqual(uncaught, []);
    });

    it('open / close the listener 15× on one pool (max 10): the reused client is listening every time, nothing leaks', async () => {
        // regression: state kept ON the pool client made a reused client look «dropped» → never released
        for (let i = 0; i < 15; i += 1) {
            const h = await o.listenProgress(() => {}, { delaysMs: [30] });
            assert.equal(h.connected(), true, `open #${i + 1} is listening`);
            assert.ok(h.pid() > 0);
            await h.close();
            assert.equal(checkedOut(), 0, `close #${i + 1} released the client`);
        }
        // and a reused client still delivers NOTIFY
        const events = [];
        sub = await o.listenProgress((e) => events.push(e.book_id), { delaysMs: [30] });
        await notify('reuse');
        await until(() => events.includes('reuse'), 5000, 'NOTIFY on a reused client');
    });

    it('close() while listening releases the client (UNLISTEN) — nothing checked out, no reconnect', async () => {
        const log = [];
        sub = await o.listenProgress(() => {}, { delaysMs: [30], onDisconnect: () => log.push('down'), onReconnect: () => log.push('up') });
        assert.equal(checkedOut(), 1);
        await sub.close();
        sub = null;
        await sleep(100);
        assert.equal(checkedOut(), 0);
        assert.deepEqual(log, []);
    });
});
