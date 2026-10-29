// ======================================================
// POST /api/v1/book/blank — mandatory ownership + localized scaffold
// ======================================================
// Mounts the @animastor/editor SOURCE registrar (packages/animastor-editor)
// over the real book module (temp BOOKS_DIR) and asserts:
//   1. resolveOwnership → null / throw: 503 ownership_unavailable, nothing
//      written to disk;
//   2. commit failure after a resolved owner: the books registry row is
//      rolled back (real PG test DB, real resolver, host rollback wiring);
//   3. identified request without a workspace → 401 (no developer fallback);
//      pre-auth keeps the default-workspace resolve;
//   4. language: 'en' → English labels; no language → historical Russian.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');

require('./vbook-test-bindings.cjs');
const bookModule = require('../src/book/index');
const config = require('../src/config/runtime-config');
const { query } = require('../src/storage/postgres/database');
const userRepo = require('../src/storage/postgres/repositories/user-repo');
const workspaceRepo = require('../src/storage/postgres/repositories/workspace-repo');
const bookRepo = require('../src/storage/postgres/repositories/book-repo');
const workspaceOwnership = require('../src/middleware/workspace-ownership');

const REGISTRAR = path.resolve(__dirname, '..', '..', 'packages', 'animastor-editor', 'src', 'entity-crud-routes.cjs');
const ORIG_BOOKS_DIR = config.BOOKS_DIR;

function createResponse() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

describe('POST /api/v1/book/blank — ownership + language', () => {
    let tmpDir;
    let handler;
    let ownershipCalls;

    function mount({ resolveOwnership, rollbackOwnership, commit } = {}) {
        ownershipCalls = [];
        let blank = null;
        const app = {
            post(p, h) { if (p === '/api/v1/book/blank') blank = h; },
            get() {}, put() {}, patch() {}, delete() {},
        };
        delete require.cache[require.resolve(REGISTRAR)];
        require(REGISTRAR)(app, {}, {
            editorModel: {
                read: (id) => bookModule.loadBook(id),
                commit: commit || ((b, files) => bookModule.saveBookBundle(b, files)),
            },
            editorPorts: {
                sceneAssetsRepo: { bumpSceneVersions: async () => 0, setDirtyUnitIds: async () => 0 },
                placeholderAudio: { recoverMissingPlaceholders: async () => ({ created: 0, errors: [] }) },
                auditCoverage: { auditBookCoverage: () => ({}) },
                promptLimit: 2000,
                purge: { purgeScene: async () => ({}), purgeUnit: async () => ({}) },
                resolveOwnership: async (bookId, meta) => {
                    ownershipCalls.push({ bookId, meta });
                    return resolveOwnership ? resolveOwnership(bookId, meta) : 'ws-test';
                },
                rollbackOwnership: rollbackOwnership || (async () => {}),
                recoveryCtx: {},
            },
            utils: { log: () => {} },
        });
        handler = blank;
    }

    async function post(body, reqExtra = {}) {
        const res = createResponse();
        await handler({ body, ...reqExtra }, res);
        return res;
    }

    const diskEntries = () => fs.readdirSync(tmpDir);

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blank-book-'));
        config.BOOKS_DIR = tmpDir;
    });

    afterEach(() => {
        config.BOOKS_DIR = ORIG_BOOKS_DIR;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    after(() => {
        delete require.cache[require.resolve(REGISTRAR)];
    });

    describe('ownership is mandatory', () => {
        it('resolveOwnership → null: 503 ownership_unavailable, nothing on disk', async () => {
            mount({ resolveOwnership: async () => null });
            const res = await post({ title: 'No owner' });
            expect(res.statusCode).to.equal(503);
            expect(res.body).to.deep.equal({ error: 'ownership_unavailable' });
            expect(diskEntries()).to.deep.equal([]);
        });

        it('resolveOwnership throws: 503 ownership_unavailable, nothing on disk', async () => {
            mount({ resolveOwnership: async () => { throw new Error('pg down'); } });
            const res = await post({});
            expect(res.statusCode).to.equal(503);
            expect(res.body).to.deep.equal({ error: 'ownership_unavailable' });
            expect(diskEntries()).to.deep.equal([]);
        });

        it('identified request without a workspace → 401, ownership never resolved', async () => {
            mount();
            const res = await post({}, { user: { user_id: 'u1' }, workspace: null });
            expect(res.statusCode).to.equal(401);
            expect(ownershipCalls).to.have.length(0);
            expect(diskEntries()).to.deep.equal([]);
        });

        it('identified request passes its own workspace as preferred owner', async () => {
            mount();
            const res = await post({}, { guest: { guestId: 'g1' }, workspace: { id: 'ws-guest' } });
            expect(res.statusCode).to.equal(200);
            expect(ownershipCalls[0].meta.preferredWorkspaceId).to.equal('ws-guest');
        });

        it('pre-auth (no identity) keeps the default-workspace resolve', async () => {
            mount();
            const res = await post({});
            expect(res.statusCode).to.equal(200);
            expect(ownershipCalls[0].meta.preferredWorkspaceId).to.equal(null);
        });
    });

    describe('commit failure rolls the registry row back (PG)', () => {
        let user;
        let workspace;

        before(async () => {
            user = await userRepo.createUser({ username: 'blank_rb_' + Date.now(), displayName: 'Blank RB' });
            workspace = await workspaceRepo.createWorkspace({
                name: 'Blank RB', ownerUserId: user.user_id, type: 'personal',
            });
        });

        after(async () => {
            if (workspace) {
                await query('DELETE FROM books WHERE workspace_id = $1', [workspace.id]);
                await query('DELETE FROM workspace_members WHERE workspace_id = $1', [workspace.id]);
                await query('DELETE FROM workspaces WHERE id = $1', [workspace.id]);
            }
            if (user) await query('DELETE FROM users WHERE user_id = $1', [user.user_id]);
        });

        it('failed commit → 500 and no books row for the new id', async () => {
            let createdId = null;
            mount({
                // Same legs as the backend composition root wires.
                resolveOwnership: async (bookId, meta) => {
                    const ws = await workspaceOwnership.resolveWorkspaceForBook(bookId, meta);
                    createdId = bookId;
                    // The row really existed before the rollback.
                    expect(await bookRepo.getWorkspaceId(bookId)).to.equal(workspace.id);
                    return ws;
                },
                rollbackOwnership: (bookId) => bookRepo.deleteBookSnapshots(bookId),
                commit: () => { throw new Error('disk full'); },
            });
            const res = await post({ title: 'Rollback probe' }, { user: { user_id: user.user_id }, workspace: { id: workspace.id } });
            expect(res.statusCode).to.equal(500);
            expect(createdId).to.be.a('string');
            const { rows } = await query('SELECT 1 FROM books WHERE book_id = $1', [createdId]);
            expect(rows).to.have.length(0);
        });
    });

    describe('language', () => {
        function readScaffold(bookId) {
            const b = bookModule.loadBook(bookId);
            const ch = b.chapters[0];
            return { title: b.book.title, language: b.book.language, chapter: ch.chapter_title, scene: ch.scenes[0].scene_title };
        }

        it("language: 'en' → English default labels", async () => {
            mount();
            const res = await post({ language: 'en' });
            expect(res.statusCode).to.equal(200);
            expect(res.body.title).to.equal('New book');
            expect(readScaffold(res.body.book_id)).to.deep.equal({
                title: 'New book', language: 'en', chapter: 'New chapter', scene: 'Scene 1',
            });
        });

        it('no language → historical Russian labels', async () => {
            mount();
            const res = await post({});
            expect(res.statusCode).to.equal(200);
            expect(readScaffold(res.body.book_id)).to.deep.equal({
                title: 'Новая книга', language: 'ru', chapter: 'Новая глава', scene: 'Сцена 1',
            });
        });

        it('unknown language → ru; explicit title still wins', async () => {
            mount();
            const res = await post({ language: 'de', title: 'Мой том' });
            expect(res.statusCode).to.equal(200);
            expect(readScaffold(res.body.book_id)).to.deep.equal({
                title: 'Мой том', language: 'ru', chapter: 'Новая глава', scene: 'Сцена 1',
            });
        });
    });
});
