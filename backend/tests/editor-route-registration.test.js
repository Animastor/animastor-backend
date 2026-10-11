// ======================================================
// Editor contour — registration contract regression (Phase 4.1 fix)
// ======================================================
// The Phase 4.1 boundary hardening (5d116bbf) collapsed the two editor
// registrar calls into `require('./editor/index.cjs')(app, redis, deps)`
// — but the shim re-exports the package FACTORY NAMESPACE (an object),
// not a registrar function, so boot crashed with
// `TypeError: require(...) is not a function` (book-routes.cjs) and the
// entity/structure CRUD leg (15 endpoints) was silently dropped.
//
// Invariants under test:
//   - both host shims are identity re-exports of the package public API
//     (same object, 4 factories) and are NOT callable — the call-site
//     must destructure the factories (no shim-as-function masking);
//   - createEditorRoutes + createEntityCrudRoutes register the frozen
//     26-endpoint editor surface (11 core + 15 entity/structure CRUD);
//   - the composition-root seams fail closed (missing editorPorts /
//     editorModel / persistBook throw at registration time);
//   - book-routes.cjs — the real boot-path call-site — registers the
//     full editor surface through the shim factories (the regression
//     that 5d116bbf introduced and no suite caught).

const { expect } = require('chai');
const path = require('path');
const { createRequire } = require('module');

const BACKEND_SRC = path.resolve(__dirname, '..', 'src');
const EDITOR_SHIM = path.join(BACKEND_SRC, 'routes', 'editor', 'index.cjs');
const FACADE_SHIM = path.join(BACKEND_SRC, 'editor', 'index.cjs');
const BOOK_ROUTES = path.join(BACKEND_SRC, 'routes', 'book-routes.cjs');

const PACKAGE_FACTORIES = [
    'createEditorModel',
    'createEditorPorts',
    'createEditorRoutes',
    'createEntityCrudRoutes',
];

// Frozen HTTP surface (editor-route-split.test.js E1 parity — same 26
// endpoints the pre-extraction host registered).
const EDITOR_ENDPOINTS = [
    ['get', '/api/v1/book/:bookId'],
    ['get', '/api/v1/book/:bookId/source-coverage'],
    ['get', '/api/v1/book/:bookId/cover'],
    ['put', '/api/v1/book/:bookId'],
    ['patch', '/api/v1/book/:bookId/scene/:chapterId/:sceneId'],
    ['patch', '/api/v1/book/:bookId/metadata'],
    ['patch', '/api/v1/book/:bookId/locations/:locationId'],
    ['patch', '/api/v1/book/:bookId/characters/:characterId'],
    ['patch', '/api/v1/book/:bookId/voices/:voiceId'],
    ['patch', '/api/v1/book/:bookId/behaviors/:characterId'],
    ['delete', '/api/v1/book/:bookId'],
    ['post', '/api/v1/book/blank'],
    ['post', '/api/v1/book/:bookId/characters'],
    ['delete', '/api/v1/book/:bookId/characters/:characterId'],
    ['post', '/api/v1/book/:bookId/locations'],
    ['delete', '/api/v1/book/:bookId/locations/:locationId'],
    ['post', '/api/v1/book/:bookId/voices'],
    ['delete', '/api/v1/book/:bookId/voices/:voiceId'],
    ['post', '/api/v1/book/:bookId/behaviors'],
    ['delete', '/api/v1/book/:bookId/behaviors/:characterId'],
    ['post', '/api/v1/book/:bookId/chapters'],
    ['delete', '/api/v1/book/:bookId/chapters/:chapterId'],
    ['post', '/api/v1/book/:bookId/chapters/:chapterId/scenes'],
    ['delete', '/api/v1/book/:bookId/chapters/:chapterId/scenes/:sceneId'],
    ['post', '/api/v1/book/:bookId/chapters/:chapterId/scenes/:sceneId/units'],
    ['delete', '/api/v1/book/:bookId/chapters/:chapterId/scenes/:sceneId/units/:unitId'],
];

function fakeApp() {
    const routes = [];
    const app = {};
    for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
        app[m] = (p) => { routes.push([m, p]); };
    }
    return { app, routes };
}

function fakeDeps() {
    return {
        editorModel: { read: () => null, commit: (b) => b },
        editorPorts: {
            placeholderAudio: () => undefined,
            purge: { purgeScene: () => undefined, purgeUnit: () => undefined },
            sceneAssetsRepo: { bumpSceneVersions: () => undefined, setDirtyUnitIds: () => undefined },
            auditCoverage: () => undefined,
            promptLimit: 1000,
            recoveryCtx: {},
        },
        utils: { log: () => undefined },
    };
}

function sortedRoutes(routes) {
    return routes.map(([m, p]) => [m, p]).sort((a, b) =>
        a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]));
}

const EXPECTED_SORTED = sortedRoutes(EDITOR_ENDPOINTS);

describe('editor registration contract (Phase 4.1 regression)', () => {
    const pkg = require('@animastor/editor');

    it('host shims are identity re-exports of the package public API (not callable)', () => {
        const shim = require(EDITOR_SHIM);
        const facade = require(FACADE_SHIM);
        expect(shim).to.equal(pkg);
        expect(facade).to.equal(pkg);
        expect(typeof shim).to.equal('object');
        expect(typeof shim).to.not.equal('function');
        expect(Object.keys(shim).sort()).to.deep.equal(PACKAGE_FACTORIES.slice().sort());
    });

    it('the two registrars freeze the 26-endpoint editor surface', () => {
        const { app, routes } = fakeApp();
        pkg.createEditorRoutes(app, {}, fakeDeps());
        pkg.createEntityCrudRoutes(app, {}, fakeDeps());
        expect(sortedRoutes(routes)).to.deep.equal(EXPECTED_SORTED);
    });

    it('registration fails closed when the composition-root seams are missing', () => {
        const { app } = fakeApp();
        const deps = fakeDeps();
        expect(() => pkg.createEditorRoutes(app, {}, { ...deps, editorPorts: undefined }))
            .to.throw();
        expect(() => pkg.createEntityCrudRoutes(app, {}, { ...deps, editorPorts: undefined }))
            .to.throw();
        expect(() => pkg.createEditorModel({})).to.throw(/persistBook/);
        expect(() => pkg.createEditorPorts({ deps: {} })).to.throw(/sceneAssetsRepo/);
    });

    it('book-routes.cjs (boot path) registers the full editor surface via the shim factories', () => {
        // Stub the sibling sub-registrars (import/export/generation/… —
        // unrelated to the editor leg) so the boot-path test exercises ONLY
        // the editor wiring with the real package registrars. Cache entries
        // are restored in finally so later suites re-require the real files.
        const bookReq = createRequire(BOOK_ROUTES);
        const siblings = [
            './book/import-routes.cjs', './book/export-routes.cjs',
            './book/generation-routes.cjs', './book/agent-routes.cjs',
            './book/progress-panel.cjs', './book/recovery-routes.cjs',
            './book/versions-routes.cjs', './book/recent-books-routes.cjs',
            './book/status-routes.cjs', './book/parse-routes.cjs',
            './book/cache-routes.cjs',
        ];
        const saved = [];
        const stub = (spec) => {
            const p = bookReq.resolve(spec);
            saved.push([p, require.cache[p]]);
            require.cache[p] = {
                id: p, filename: p, loaded: true, exports: () => undefined,
            };
        };
        saved.push([BOOK_ROUTES, require.cache[BOOK_ROUTES]]);
        try {
            siblings.forEach(stub);
            delete require.cache[BOOK_ROUTES];
            const bookRoutes = require(BOOK_ROUTES);
            const { app, routes } = fakeApp();
            const deps = {
                ...fakeDeps(),
                genSessionRepo: {}, lazyBook: {}, txtImporter: {},
                taskHandler: {}, config: {}, storage: {},
                getAllChunks: () => [], getChunk: () => null,
                cleanBookRedisKeys: () => undefined,
                assistantPorts: { purgeForBook: () => undefined },
            };
            bookRoutes(app, {}, deps);
            expect(sortedRoutes(routes)).to.deep.equal(EXPECTED_SORTED);
        } finally {
            for (const [p, entry] of saved) {
                if (entry) require.cache[p] = entry;
                else delete require.cache[p];
            }
        }
    });
});
