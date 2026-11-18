// ======================================================
// VBook v4 step 6 — owner's decisions on the step-5 questions
// ======================================================
//   a) /api/v1/connectors writes are platform-admin only (system data:
//      ai/connectors/ files + the one global prompt-profile override);
//      /api/v1/auth/me tells the fronts is_admin (role OR allowlist).
//   b) REDIS_HOST / REDIS_PORT / PG_HOST only from the environment; a missing
//      value stops the start — never a fallback to a short host name (the VPS
//      search domain resolves every short name to a foreign machine).

'use strict';

const { expect } = require('chai');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const infraEnv = require('../src/config/infra-env');
const { isAdminUser } = require('../src/middleware/auth-context');

const BACKEND = path.join(__dirname, '..');

function startApp(mount) {
    const app = express();
    app.use(express.json());
    // test identity: x-test-user: "<username>:<role>" (no header → anonymous)
    app.use((req, res, next) => {
        req.user = null;
        const h = req.headers['x-test-user'];
        if (h) { const [username, role] = String(h).split(':'); req.user = { userId: `u-${username}`, username, role }; }
        next();
    });
    mount(app);
    return new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
    });
}

describe('step 6 — connectors writes are admin only (owner, 18.11)', () => {
    const calls = [];
    const wfManager = new Proxy({}, {
        get: (_t, name) => (...args) => {
            calls.push(name);
            if (name === 'validateConnectorJson') return { valid: true, errors: [] };
            if (name === 'listConnectors') return [];
            return { ok: true, warnings: [] };
        },
    });
    const fakeRedis = { get: async () => null, set: async () => 'OK', del: async () => 1 };
    let srv; let savedAllow;
    before(async () => {
        savedAllow = process.env.ADMIN_USERNAMES;
        process.env.ADMIN_USERNAMES = 'boss';
        srv = await startApp((app) => require('../src/routes/connector-routes.cjs')(app, fakeRedis, { wfManager, utils: { log: () => {} } }));
    });
    after(async () => {
        if (savedAllow === undefined) delete process.env.ADMIN_USERNAMES; else process.env.ADMIN_USERNAMES = savedAllow;
        await new Promise((r) => srv.server.close(r));
    });
    const call = (method, p, user, body) => fetch(srv.base + p, {
        method,
        headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const WRITES = [
        ['POST', '/api/v1/connectors', { name: 'conn-x', connector: {} }],
        ['POST', '/api/v1/connectors/validate', { connector: {} }],
        ['POST', '/api/v1/connectors/reload', {}],
        ['PUT', '/api/v1/connectors/profiles', { type: 'audio', profile: null }],
        ['PUT', '/api/v1/connectors/conn-x/parameters', { paramKey: 'a', value: 1 }],
        ['PUT', '/api/v1/connectors/conn-x/status', { status: 'disabled' }],
        ['PUT', '/api/v1/connectors/conn-x/bindings', { section: 's', entityKey: 'e', nodeId: '1' }],
        ['DELETE', '/api/v1/connectors/conn-x', undefined],
    ];
    it('every write: anonymous → 401, a plain user → 403 admin_required; the handler never runs', async () => {
        calls.length = 0;
        for (const [m, p, b] of WRITES) {
            expect((await call(m, p, null, b)).status, `${m} ${p} anon`).to.equal(401);
            const r = await call(m, p, 'alice:user', b);
            expect(r.status, `${m} ${p} user`).to.equal(403);
            expect((await r.json()).code).to.equal('admin_required');
        }
        expect(calls).to.deep.equal([]);
    });
    it('an admin (role or ADMIN_USERNAMES) reaches the handler', async () => {
        calls.length = 0;
        expect((await call('POST', '/api/v1/connectors/validate', 'root:admin', { connector: {} })).status).to.equal(200);
        expect((await call('POST', '/api/v1/connectors/reload', 'boss:user', {})).status).to.equal(200);
        expect(calls).to.deep.equal(['validateConnectorJson', 'reloadConnectors']);
    });
    it('reads stay open to a signed-in user (the settings screen shows the profile)', async () => {
        expect((await call('GET', '/api/v1/connectors', 'alice:user')).status).to.equal(200);
    });
    it('the guard is mounted before every connector route', () => {
        const src = fs.readFileSync(path.join(BACKEND, 'src/routes/connector-routes.cjs'), 'utf8');
        const guard = src.indexOf("app.use('/api/v1/connectors', connectorWriteGuard)");
        const firstRoute = src.search(/app\.(get|post|put|patch|delete)\('\/api\/v1\/connectors/);
        expect(guard).to.be.greaterThan(-1);
        expect(guard).to.be.lessThan(firstRoute);
    });

    it('isAdminUser: role admin or allowlist; /auth/me reports is_admin', async () => {
        expect(isAdminUser({ role: 'admin', username: 'x' })).to.equal(true);
        expect(isAdminUser({ role: 'user', username: 'BOSS' })).to.equal(true);
        expect(isAdminUser({ role: 'user', username: 'alice' })).to.equal(false);
        expect(isAdminUser(null)).to.equal(false);
        const me = await startApp((app) => require('../src/routes/auth-routes.cjs')(app, null, { authService: {}, guestRepo: {} }));
        try {
            const get = async (u) => (await (await fetch(`${me.base}/api/v1/auth/me`, { headers: { 'x-test-user': u } })).json()).user;
            expect(await get('boss:user')).to.include({ role: 'user', is_admin: true });
            expect(await get('alice:user')).to.include({ role: 'user', is_admin: false });
        } finally {
            await new Promise((r) => me.server.close(r));
        }
    });
});

describe('step 6 — infrastructure hosts only from the environment (owner, 18.11)', () => {
    const FULL = { REDIS_HOST: '127.0.0.1', REDIS_PORT: '56381', PG_HOST: '127.0.0.1' };
    it('redisOptions: host and port from env; password only when set', () => {
        expect(infraEnv.redisOptions(FULL)).to.deep.equal({ host: '127.0.0.1', port: 56381 });
        expect(infraEnv.redisOptions({ ...FULL, REDIS_PASSWORD: 'p' })).to.include({ password: 'p' });
    });
    it('a missing or blank value throws infra_env_missing — never a default host', () => {
        for (const env of [{ ...FULL, REDIS_HOST: '' }, { ...FULL, REDIS_HOST: '  ' }, { REDIS_PORT: '6379' }]) {
            expect(() => infraEnv.redisOptions(env)).to.throw(/REDIS_HOST is not set/).with.property('code', 'infra_env_missing');
        }
        expect(() => infraEnv.redisOptions({ REDIS_HOST: 'redis' })).to.throw(/REDIS_PORT is not set/);
        for (const bad of ['0', '70000', 'abc', '63 79']) {
            expect(() => infraEnv.redisOptions({ REDIS_HOST: 'redis', REDIS_PORT: bad }), bad).to.throw(/REDIS_PORT must be a TCP port/);
        }
        expect(() => infraEnv.pgHost({})).to.throw(/PG_HOST is not set/);
        expect(infraEnv.pgHost({ PG_HOST: 'postgres' })).to.equal('postgres');
    });
    it('missingInfraEnv lists every problem at once', () => {
        expect(infraEnv.missingInfraEnv({})).to.have.length(3);
        expect(infraEnv.missingInfraEnv(FULL)).to.deep.equal([]);
    });
    it('the sources carry no short-name default any more', () => {
        const backend = fs.readFileSync(path.join(BACKEND, 'src/backend.cjs'), 'utf8');
        expect(backend).to.not.match(/host:\s*'redis'/);
        expect(backend).to.match(/new Redis\(infraEnv\.redisOptions\(\)\)/);
        expect(backend.indexOf('infraEnv.assertInfraEnv()')).to.be.lessThan(backend.indexOf('new Redis('));
        const db = fs.readFileSync(path.join(BACKEND, 'src/storage/postgres/database.js'), 'utf8');
        expect(db).to.not.match(/PG_HOST\s*\|\|/);
        expect(db).to.match(/host: infraEnv\.pgHost\(\)/);
    });
    // Child processes run with NO PG_* / REDIS_* at all — nothing can connect.
    const bareEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, NODE_PATH: process.env.NODE_PATH || '' });
    it('backend.cjs without REDIS_HOST/REDIS_PORT/PG_HOST stops at once with one FATAL line naming all three', function () {
        this.timeout(30000);
        const r = spawnSync(process.execPath, ['src/backend.cjs'], { cwd: BACKEND, env: { ...bareEnv(), PORT: '0' }, encoding: 'utf8', timeout: 25000 });
        expect(r.status, r.stderr.slice(-500)).to.equal(1);
        expect(r.stderr).to.match(/\[FATAL\] REDIS_HOST is not set.*REDIS_PORT is not set.*PG_HOST is not set/);
        expect(r.stdout + r.stderr).to.not.match(/ENOTFOUND|ECONNREFUSED|\[ioredis\]/);
    });
    it('the PG pool is not created without PG_HOST', function () {
        this.timeout(15000);
        const code = "try{require('./src/storage/postgres/database').getPool();console.log('CREATED')}catch(e){console.log('ERR '+e.code+' '+e.message)}";
        const r = spawnSync(process.execPath, ['-e', code], { cwd: BACKEND, env: { ...bareEnv(), NODE_ENV: 'test', PG_DB: 'x_test' }, encoding: 'utf8' });
        expect(r.stdout).to.match(/^ERR infra_env_missing PG_HOST is not set/);
    });
});
