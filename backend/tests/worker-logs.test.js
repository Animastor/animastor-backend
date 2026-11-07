// ======================================================
// Fresh worker logs — backend (ORCHESTRATION_V2 §8.5)
// ======================================================
// Matrix:
//   repo defaults
//     tenant (role='user') worker → log_shipping = false             ok
//     admin-owned workspace worker → log_shipping = true             ok
//     SYSTEM worker (admin path) → log_shipping = true               ok
//
//   disk store (services/worker-logs-store)
//     append lines as `ts level msg`, 0700 dir / 0600 file           ok
//     tail returns the newest N lines (current + rotated)            ok
//     > 5 MB rotates current.log → current.log.1 (old .1 deleted)    ok
//     a non-UUID worker id never reaches the filesystem              ok
//
//   internal ingest (POST /internal/workers/:id/logs, hub key)
//     x-api-key required; unknown/revoked worker → 404               ok
//     log_shipping=false → 204 and NOTHING written                   ok
//     log_shipping=true  → 204 and the lines land on disk            ok
//     non-UUID id → 400; missing lines[] → 400                       ok
//     body > 128 KiB → 413                                           ok
//
//   one-shot tail flag
//     POST /api/v1/workers/:id/request-log (owner/admin)             ok
//     /internal/gen/beacon delivers send_log_tail=true EXACTLY once  ok
//     foreign user 404, anonymous 401, invalid id 404                ok
//
//   GET /api/v1/workers/:id/log
//     owner 200; admin 200; foreign 404; ?lines validation 400       ok
//     SYSTEM worker readable by admin, not by a tenant               ok
//
//   full suites: run via scripts/test-backend.sh (test DB only).

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const { authContext } = require('../src/middleware/auth-context');
const workerRepo = require('../src/storage/postgres/repositories/worker-repo');
const workerLogsStore = require('../src/services/worker-logs-store');
const workerLogTail = require('../src/services/worker-log-tail');
const { createV2Routes } = require('../src/orchestration-v2/routes');
const { createMockRedis } = require('./mocks/redis-mock');

const HUB_KEY = 'worker-logs-hub-key-test';
const stamp = `wlog${Date.now().toString(36)}`;
const PREFIX = 'wlog';

function cookieOf(res) {
    const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const sid = set.find((c) => c.startsWith('animastor_sid='));
    return sid ? sid.split(';')[0] : null;
}

async function register(base, username) {
    const res = await fetch(`${base}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'correct-horse-42', email: `${username}@test.local` }),
    });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).to.equal(201);
    return { cookie: cookieOf(res), workspaceId: body.workspace.id, username };
}

function makeHost() {
    return {
        isEnabled: () => true,
        disabledReason: () => null,
        maxUploadBytes: 1024 * 1024,
        orch: () => ({
            beacon: async () => ({ cancel: [] }),
            claim: async () => ({ task: null }),
        }),
    };
}

async function cleanup() {
    await query(`DELETE FROM share_policies WHERE worker_id IN (
        SELECT worker_id FROM workers WHERE workspace_id IN (
            SELECT id FROM workspaces WHERE owner_user_id IN (
                SELECT user_id FROM users WHERE username LIKE $1)))`, [`${PREFIX}%`]);
    await query(`DELETE FROM share_policy_grants WHERE workspace_id IN (
        SELECT id FROM workspaces WHERE owner_user_id IN (
            SELECT user_id FROM users WHERE username LIKE $1))`, [`${PREFIX}%`]);
    await query(`DELETE FROM workers WHERE workspace_id IN (
        SELECT id FROM workspaces WHERE owner_user_id IN (
            SELECT user_id FROM users WHERE username LIKE $1))`, [`${PREFIX}%`]);
    await query(`DELETE FROM workers WHERE mode = 'system' AND name LIKE $1`, [`${PREFIX}%`]);
    await query(`DELETE FROM workspace_members WHERE workspace_id IN (
        SELECT id FROM workspaces WHERE owner_user_id IN (
            SELECT user_id FROM users WHERE username LIKE $1))`, [`${PREFIX}%`]);
    await query(`DELETE FROM sessions WHERE user_id IN (
        SELECT user_id FROM users WHERE username LIKE $1)`, [`${PREFIX}%`]);
    await query(`DELETE FROM workspaces WHERE owner_user_id IN (
        SELECT user_id FROM users WHERE username LIKE $1)`, [`${PREFIX}%`]);
    await query(`DELETE FROM users WHERE username LIKE $1`, [`${PREFIX}%`]);
}

describe('worker logs — repository opt-in defaults', () => {
    let aliceWorkspaceId, adminWorkspaceId, tenantWorkerId, adminWorkerId, systemWorkerId;

    before(async function () {
        this.timeout(60000);
        await runMigrations();
        await cleanup();
        const alice = await query(`INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING user_id`, [`${PREFIX}_alice_repo`]);
        const admin = await query(`INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING user_id`, [`${PREFIX}_admin_repo`]);
        const wa = await query(`INSERT INTO workspaces (name, owner_user_id, type) VALUES ($1, $2, 'personal') RETURNING id`, [`${PREFIX}_wa`, alice.rows[0].user_id]);
        const wb = await query(`INSERT INTO workspaces (name, owner_user_id, type) VALUES ($1, $2, 'personal') RETURNING id`, [`${PREFIX}_wb`, admin.rows[0].user_id]);
        aliceWorkspaceId = wa.rows[0].id;
        adminWorkspaceId = wb.rows[0].id;
    });

    after(async function () {
        this.timeout(30000);
        await cleanup();
    });

    it('tenant worker (workspace owner role=user) defaults to log_shipping=false', async () => {
        const r = await workerRepo.createWorker({ workspaceId: aliceWorkspaceId, name: `${PREFIX}_tenant`, workerType: 'audio' });
        tenantWorkerId = r.worker.worker_id;
        expect(r.worker.log_shipping).to.equal(false);
        expect((await workerRepo.findById(tenantWorkerId)).log_shipping).to.equal(false);
    });

    it('admin-owned workspace worker defaults to log_shipping=true', async () => {
        const r = await workerRepo.createWorker({ workspaceId: adminWorkspaceId, name: `${PREFIX}_adminw`, workerType: 'audio' });
        adminWorkerId = r.worker.worker_id;
        expect(r.worker.log_shipping).to.equal(true);
    });

    it('SYSTEM worker (admin path) defaults to log_shipping=true', async () => {
        const r = await workerRepo.createSystemWorker({ name: `${PREFIX}_sys`, workerType: 'audio' });
        systemWorkerId = r.worker.worker_id;
        expect(r.worker.log_shipping).to.equal(true);
        expect((await workerRepo.findById(systemWorkerId)).log_shipping).to.equal(true);
    });

    it('the mirror identity carries log_shipping (findActiveByIdWithTokenHash)', async () => {
        const row = await workerRepo.findActiveByIdWithTokenHash(tenantWorkerId);
        expect(row.log_shipping).to.equal(false);
    });
});

describe('worker logs — disk store', () => {
    let root;
    const workerId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    before(function () {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-logs-'));
        process.env.WORKER_LOGS_DIR = root;
        workerLogTail.clear();
    });

    after(function () {
        delete process.env.WORKER_LOGS_DIR;
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('writes `ts level msg` lines with 0700 dir / 0600 file', async () => {
        const r = await workerLogsStore.writeLines(workerId, [
            { ts: '2026-11-06T10:00:00.000Z', level: 'info', msg: 'first' },
            { ts: '2026-11-06T10:00:01.000Z', level: 'warn', msg: 'second\ninjected' },
        ]);
        expect(r.written).to.equal(2);
        const dir = path.join(root, workerId);
        expect(fs.statSync(dir).mode & 0o777).to.equal(0o700);
        const file = path.join(dir, 'current.log');
        expect(fs.statSync(file).mode & 0o777).to.equal(0o600);
        const text = fs.readFileSync(file, 'utf8');
        expect(text).to.include('2026-11-06T10:00:00.000Z info first\n');
        // newline inside msg is escaped: exactly two physical lines
        expect(text.split('\n').filter(Boolean)).to.have.lengthOf(2);
        expect(text).to.include('second\\ninjected');
    });

    it('readTail returns the newest N lines (oldest → newest)', async () => {
        const tail = await workerLogsStore.readTail(workerId, 1);
        expect(tail).to.have.lengthOf(1);
        expect(tail[0]).to.include('second');
    });

    it('rejects a non-UUID worker id before touching the filesystem', async () => {
        let err = null;
        try { await workerLogsStore.writeLines('../../etc/passwd', [{ msg: 'x' }]); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.code).to.equal('bad_worker_id');
        expect(fs.existsSync(path.join(root, '..', 'etc'))).to.equal(false);
    });

    it('rotates current.log → current.log.1 past 5 MB and deletes the old .1', async () => {
        // Two distinguishable 5.6 MB batches so "the OLD .1 was replaced"
        // is observable (batch A only ever lives in the first .1).
        const mk = (tag, ts) => {
            const batch = [];
            for (let i = 0; i < 700; i++) batch.push({ ts, level: 'info', msg: `${tag}${i}-` + 'x'.repeat(8000) });
            return batch;
        };
        const batchA = mk('A', '2026-11-06T10:00:00.000Z');
        const batchB = mk('B', '2026-11-06T10:00:05.000Z');
        const dir = path.join(root, workerId);
        const prev = path.join(dir, 'current.log.1');

        // First rotation: the whole current block moves to .1.
        await workerLogsStore.writeLines(workerId, batchA);
        expect(fs.existsSync(prev)).to.equal(true);
        expect(fs.statSync(prev).size).to.be.greaterThan(5 * 1024 * 1024);
        expect(fs.existsSync(path.join(dir, 'current.log'))).to.equal(false);

        // A new line starts a fresh current.log.
        await workerLogsStore.writeLines(workerId, [{ ts: '2026-11-06T10:00:02.000Z', level: 'info', msg: 'after-rotate' }]);
        expect(fs.existsSync(path.join(dir, 'current.log'))).to.equal(true);

        // Second rotation replaces the previous .1: exactly one file stays,
        // it holds the NEW block and the OLD one is gone with it.
        await workerLogsStore.writeLines(workerId, batchB);
        expect(fs.readdirSync(dir).sort()).to.deep.equal(['current.log.1']);
        const prevText = fs.readFileSync(prev, 'utf8');
        expect(prevText).to.include('B0-');
        expect(prevText).to.not.include('A0-');
    });

    it('readTail spans current.log + current.log.1', async () => {
        const tail = await workerLogsStore.readTail(workerId, 2000);
        expect(tail.length).to.be.at.least(700);
        expect(tail[tail.length - 1]).to.include('B699-');
    });
});

describe('worker logs — HTTP surface', function () {
    this.timeout(60000);
    let server, base, redis, root;
    let alice, bob, admin, aliceWorkerId, adminWorkerId, systemWorkerId;

    before(async function () {
        await runMigrations();
        await cleanup();
        workerLogTail.clear();
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-logs-http-'));
        process.env.WORKER_LOGS_DIR = root;
        redis = createMockRedis();

        const app = express();
        app.use(express.json({ limit: '2mb' }));
        app.use(authContext);
        require('../src/routes/auth-routes.cjs')(app, null, { utils: { log: () => {} } });
        require('../src/routes/worker-routes.cjs')(app, redis);
        const routes = createV2Routes({
            host: makeHost(),
            config: { GPU_HUB_API_KEY: HUB_KEY, shareFeaturesEnabled: () => false },
            workerRepo,
            bookRepo: {},
            layerConfig: {},
            redis,
            book: {},
            sessionControl: null,
            log: () => {},
        });
        routes.mountInternal(app);
        await new Promise((resolve) => {
            server = app.listen(0, () => {
                base = `http://127.0.0.1:${server.address().port}`;
                resolve();
            });
        });

        alice = await register(base, `${PREFIX}_alice_http_${stamp}`);
        bob = await register(base, `${PREFIX}_bob_http_${stamp}`);
        admin = await register(base, `${PREFIX}_admin_http_${stamp}`);
        await query(`UPDATE users SET role = 'admin' WHERE username = $1`, [admin.username]);

        const cw = async (who, name) => {
            const res = await fetch(`${base}/api/v1/workers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: who.cookie },
                body: JSON.stringify({ name, worker_type: 'audio' }),
            });
            expect(res.status).to.equal(201);
            return (await res.json()).worker.worker_id;
        };
        aliceWorkerId = await cw(alice, `${PREFIX}_alice_worker`);
        adminWorkerId = await cw(admin, `${PREFIX}_admin_worker`);
        systemWorkerId = (await workerRepo.createSystemWorker({ name: `${PREFIX}_sys_http`, workerType: 'audio' })).worker.worker_id;

        // Seed a few lines for the read tests.
        await workerLogsStore.writeLines(aliceWorkerId, [
            { ts: '2026-11-06T11:00:00.000Z', level: 'info', msg: 'alice-line-1' },
            { ts: '2026-11-06T11:00:01.000Z', level: 'warn', msg: 'alice-line-2' },
        ]);
        await workerLogsStore.writeLines(systemWorkerId, [
            { ts: '2026-11-06T11:00:02.000Z', level: 'info', msg: 'system-line-1' },
        ]);
    });

    after(async function () {
        if (server) server.close();
        delete process.env.WORKER_LOGS_DIR;
        workerLogTail.clear();
        if (root) fs.rmSync(root, { recursive: true, force: true });
        await cleanup();
    });

    function api(method, p, body, cookie, extraHeaders = {}) {
        const headers = { 'Content-Type': 'application/json', ...extraHeaders };
        if (cookie) headers.Cookie = cookie;
        return fetch(`${base}${p}`, {
            method,
            headers,
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
    }

    function postLogs(workerId, body, key = HUB_KEY) {
        const headers = { 'Content-Type': 'application/json' };
        if (key) headers['x-api-key'] = key;
        return fetch(`${base}/internal/workers/${workerId}/logs`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
    }

    // ── ingest ─────────────────────────────────────────────────────────
    it('ingest requires the hub key (401) and a UUID (400)', async () => {
        const noKey = await postLogs(aliceWorkerId, { lines: [] }, null);
        expect(noKey.status).to.equal(401);
        const badId = await postLogs('not-a-uuid', { lines: [] });
        expect(badId.status).to.equal(400);
        const noLines = await postLogs(aliceWorkerId, { msg: 'x' });
        expect(noLines.status).to.equal(400);
    });

    it('ingest of an unknown worker → 404', async () => {
        const res = await postLogs('00000000-0000-4000-8000-000000000000', { lines: [{ msg: 'x' }] });
        expect(res.status).to.equal(404);
    });

    it('log_shipping=false → 204 and nothing is written', async () => {
        const before = fs.existsSync(path.join(root, aliceWorkerId));
        const res = await postLogs(aliceWorkerId, {
            worker_id: aliceWorkerId,
            seq_from: 1,
            seq_to: 1,
            lines: [{ ts: '2026-11-06T11:10:00.000Z', level: 'info', msg: 'must-not-land' }],
        });
        expect(res.status).to.equal(204);
        const after = fs.existsSync(path.join(root, aliceWorkerId));
        expect(after).to.equal(before);
        if (after) {
            expect(fs.readFileSync(path.join(root, aliceWorkerId, 'current.log'), 'utf8')).to.not.include('must-not-land');
        }
    });

    it('log_shipping=true → 204 and the lines land on disk', async () => {
        const res = await postLogs(adminWorkerId, {
            worker_id: 'spoofed-body-id',
            seq_from: 1,
            seq_to: 2,
            lines: [
                { ts: '2026-11-06T11:11:00.000Z', level: 'info', msg: 'admin-line-1' },
                { ts: '2026-11-06T11:11:01.000Z', level: 'error', msg: 'admin-line-2' },
            ],
        });
        expect(res.status).to.equal(204);
        const text = fs.readFileSync(path.join(root, adminWorkerId, 'current.log'), 'utf8');
        expect(text).to.include('admin-line-1');
        expect(text).to.include('admin-line-2');
    });

    it('a body over 128 KiB is rejected with 413 before writing', async () => {
        const res = await postLogs(adminWorkerId, {
            lines: [{ ts: '2026-11-06T11:12:00.000Z', level: 'info', msg: 'x'.repeat(140000) }],
        });
        expect(res.status).to.equal(413);
    });

    // ── one-shot tail ──────────────────────────────────────────────────
    it('request-log: anonymous 401, foreign 404, owner 200, admin 200', async () => {
        const anon = await api('POST', `/api/v1/workers/${aliceWorkerId}/request-log`, {});
        expect(anon.status).to.equal(401);
        const foreign = await api('POST', `/api/v1/workers/${aliceWorkerId}/request-log`, {}, bob.cookie);
        expect(foreign.status).to.equal(404);
        const owner = await api('POST', `/api/v1/workers/${aliceWorkerId}/request-log`, {}, alice.cookie);
        expect(owner.status).to.equal(200);
        expect((await owner.json()).requested).to.equal(true);
        const adm = await api('POST', `/api/v1/workers/${systemWorkerId}/request-log`, {}, admin.cookie);
        expect(adm.status).to.equal(200);
    });

    it('/internal/gen/beacon delivers send_log_tail exactly ONCE', async () => {
        const first = await api('POST', '/internal/gen/beacon', { worker_id: aliceWorkerId }, null, { 'x-api-key': HUB_KEY });
        expect(first.status).to.equal(200);
        expect((await first.json()).send_log_tail).to.equal(true);
        const second = await api('POST', '/internal/gen/beacon', { worker_id: aliceWorkerId }, null, { 'x-api-key': HUB_KEY });
        expect((await second.json()).send_log_tail).to.equal(false);
    });

    // ── GET log ────────────────────────────────────────────────────────
    it('GET log: owner 200, foreign 404, admin 200, SYSTEM is admin-only', async () => {
        const owner = await api('GET', `/api/v1/workers/${aliceWorkerId}/log?lines=1`, undefined, alice.cookie);
        expect(owner.status).to.equal(200);
        const body = await owner.json();
        expect(body.lines).to.have.lengthOf(1);
        expect(body.lines[0]).to.include('alice-line-2'); // newest

        const foreign = await api('GET', `/api/v1/workers/${aliceWorkerId}/log`, undefined, bob.cookie);
        expect(foreign.status).to.equal(404);

        const adm = await api('GET', `/api/v1/workers/${systemWorkerId}/log`, undefined, admin.cookie);
        expect(adm.status).to.equal(200);
        expect((await adm.json()).lines[0]).to.include('system-line-1');

        const tenantOnSystem = await api('GET', `/api/v1/workers/${systemWorkerId}/log`, undefined, alice.cookie);
        expect(tenantOnSystem.status).to.equal(404);
    });

    it('GET log validates ?lines (1..2000) and unknown ids 404', async () => {
        for (const bad of ['0', '-1', '2001', 'abc']) {
            const res = await api('GET', `/api/v1/workers/${aliceWorkerId}/log?lines=${bad}`, undefined, alice.cookie);
            expect(res.status, `lines=${bad}`).to.equal(400);
        }
        const unknown = await api('GET', '/api/v1/workers/00000000-0000-4000-8000-000000000000/log', undefined, alice.cookie);
        expect(unknown.status).to.equal(404);
    });

    it('GET log defaults to 200 lines when ?lines is absent', async () => {
        const res = await api('GET', `/api/v1/workers/${aliceWorkerId}/log`, undefined, alice.cookie);
        expect(res.status).to.equal(200);
        const body = await res.json();
        expect(body.count).to.equal(2);
    });
});