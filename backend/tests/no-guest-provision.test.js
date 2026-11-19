// ======================================================
// No guest is ever minted (owner's decision 18.11, VBook v4 step 5)
// ======================================================
// An anonymous write anywhere under /api/v1 and any anonymous request to
// /api/v1/book/* answer 401 login_required BEFORE a route runs — no row of
// users / workspaces / guests, no animastor_gid cookie. The fronts open the
// sign-in window on 401 (web auth-sticky, Android login prompt). Machine
// surfaces keep their own credentials: /api/v1/worker/* (wrk.*),
// /api/v1/ai-connector/* (llmc.*); /api/v1/auth/* is the sign-in itself.

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const express = require('express');

const { query } = require('../src/storage/postgres/database');
const authService = require('../src/auth/auth-service');
const { authContext, requireIdentityForWrites, anonymousAllowed } = require('../src/middleware/auth-context');

describe('no guest provisioning — anonymous writes are 401 (owner, 18.11)', () => {
    describe('anonymousAllowed — the path/method matrix', () => {
        const r = (method, p) => anonymousAllowed({ method, path: p });
        it('every method of /api/v1/book/* is refused (reads included)', () => {
            for (const m of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
                expect(r(m, '/api/v1/book/b1'), m).to.equal(false);
                expect(r(m, '/api/v1/book/b1/heroes/yura'), m).to.equal(false);
                expect(r(m, '/api/v1/book/import'), m).to.equal(false);
            }
            expect(r('GET', '/api/v1/book')).to.equal(false);
            expect(r('GET', '/api/v1/books')).to.equal(true); // not /book/*
        });
        it('writes anywhere else under /api/v1 are refused', () => {
            for (const [m, p] of [['POST', '/api/v1/ai/chat'], ['PUT', '/api/v1/settings/ai/provider'], ['POST', '/api/v1/workers'],
                ['POST', '/api/v1/connectors'], ['PATCH', '/api/v1/ai-endpoints/x'], ['DELETE', '/api/v1/workers/w1'],
                ['POST', '/api/v1/generate'], ['POST', '/api/v1/private-worker/setup/plan'], ['POST', '/api/v1/admin/x'], ['POST', '/api/v1/workerx']]) {
                expect(r(m, p), `${m} ${p}`).to.equal(false);
            }
        });
        it('sign-in, machine surfaces, reads outside /book and non-/api/v1 paths pass', () => {
            for (const [m, p] of [['POST', '/api/v1/auth/login'], ['POST', '/api/v1/auth/register'], ['POST', '/api/v1/auth/logout'],
                ['POST', '/api/v1/worker/verify'], ['POST', '/api/v1/ai-connector/registrations/c1/token'],
                ['GET', '/api/v1/auth/me'], ['GET', '/api/v1/books'], ['GET', '/api/v1/system/info'],
                ['POST', '/gpu/task/result'], ['POST', '/internal/gen/claim'], ['GET', '/health']]) {
                expect(r(m, p), `${m} ${p}`).to.equal(true);
            }
        });
    });

    describe('HTTP — authContext + requireIdentityForWrites against PG', () => {
        let server; let base;
        const handled = [];
        before(async () => {
            const app = express();
            app.use(express.json());
            app.use(authContext);
            app.use(requireIdentityForWrites);
            app.all('*', (req, res) => { handled.push(`${req.method} ${req.path}`); res.json({ kind: req.auth.kind }); });
            await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
            base = `http://127.0.0.1:${server.address().port}`;
        });
        after(() => server.close());

        const rows = async () => (await query(`SELECT (SELECT COUNT(*)::int FROM users) AS users,
            (SELECT COUNT(*)::int FROM workspaces) AS workspaces, (SELECT COUNT(*)::int FROM guests) AS guests`)).rows[0];

        it('anonymous → 401 login_required; the route never runs; no cookie; no new rows', async () => {
            const before = await rows();
            handled.length = 0;
            for (const [m, p] of [['POST', '/api/v1/book/blank'], ['GET', '/api/v1/book/b1'], ['PATCH', '/api/v1/book/b1/heroes/yura'],
                ['POST', '/api/v1/ai/chat'], ['PUT', '/api/v1/settings/ai/provider'], ['POST', '/api/v1/connectors'], ['DELETE', '/api/v1/workers/w1']]) {
                const res = await fetch(`${base}${p}`, { method: m, headers: { 'Content-Type': 'application/json' }, body: m === 'GET' ? undefined : '{}' });
                expect(res.status, `${m} ${p}`).to.equal(401);
                expect(await res.json(), `${m} ${p}`).to.deep.equal({ error: 'Authentication required', code: 'login_required' });
                expect(res.headers.get('set-cookie'), `${m} ${p}`).to.equal(null);
            }
            expect(handled).to.deep.equal([]);
            expect(await rows()).to.deep.equal(before);
        });

        it('a guest minted before 18.11 still passes (its rights are checked further on)', async () => {
            const created = await authService.createGuest();
            try {
                const res = await fetch(`${base}/api/v1/ai/chat`, { method: 'POST', headers: { Cookie: `animastor_gid=${created.token}` } });
                expect(res.status).to.equal(200);
                expect(await res.json()).to.deep.equal({ kind: 'guest' });
            } finally {
                await query('DELETE FROM guests WHERE guest_id = $1', [created.guestId]);
                await query('DELETE FROM workspaces WHERE id = $1', [created.workspace.id]);
            }
        });
    });

    it('backend.cjs mounts requireIdentityForWrites right after authContext; auth-context mints no guest', () => {
        const src = fs.readFileSync(path.join(__dirname, '../src/backend.cjs'), 'utf8');
        expect(src).to.match(/app\.use\(authContext\);\napp\.use\(requireIdentityForWrites\);/);
        const ctx = fs.readFileSync(path.join(__dirname, '../src/middleware/auth-context.js'), 'utf8');
        expect(ctx).to.not.match(/createGuest\(/);
        expect(ctx).to.not.match(/guestCookieHeader\(/);
    });
});
