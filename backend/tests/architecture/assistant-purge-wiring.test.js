// ======================================================
// ASSISTANT PURGE WIRING — composition-root regression
// ======================================================
// Regression guard for the pre-existing defect in backend.cjs: the deletion
// adapter
//     purgeAssistantForBook: (bookId) => assistantPorts.purgeForBook(bookId)
// closed over a FREE identifier `assistantPorts` that was never bound in
// module scope — the ports object existed only as a `routeDeps` PROPERTY,
// which is not a lexical binding. At call time the closure threw
// ReferenceError, book-deletion swallowed it as a best-effort warning and
// the deletion continued: chat sessions (ai_chat_sessions) silently
// survived book deletion.
//
// The tests execute the REAL composition-root slice — the assistantPorts
// construction (when the binding exists) plus the routeDeps literal, copied
// VERBATIM from backend.cjs — inside a vm sandbox whose module-scope legs
// are stubs, and then run the REAL createBookDeletion cascade:
//
//   T1  assistantPorts is a real module-scope binding and routeDeps
//       re-exports THAT object (the adapter closes over the ports object
//       the composition root actually built, sessionRepo included);
//   T2  deleting a book really purges Assistant data —
//       assistantPorts.sessionRepo.purgeSessionsForBook(bookId) is called
//       with the deleted book id (FAILS on the pre-fix backend.cjs);
//   T3  a failing purge keeps the existing contract: warn + continue,
//       deleteBook still resolves { deleted: true } (semantics unchanged);
//   T4  the surrounding cascade steps (cancel signal, canonical reset,
//       Redis purge, PG table deletes, hub clear) are unchanged; the
//       Assistant purge is recorded in the SAME `order` journal as every
//       other step and must sit strictly between the PG deletes and the
//       GPU-hub clear (PG < Assistant purge < GPU-hub clear).
//
// Docs: docs/architecture/ai-assistant-extraction-preparation.md (A5)

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { readSource, rel, BACKEND_SRC } = require('./helpers');

const COMPOSITION_ROOT = path.join(BACKEND_SRC, 'backend.cjs');
const { createAssistantPorts } = require('../../src/services/assistant-ports.cjs');
const { createBookDeletion } = require('../../src/services/book-deletion.cjs');

// ── Slice extraction ─────────────────────────────────────────────────────
// The slice = [assistantPorts construction (when the module-scope binding
// exists)] + the `routeDeps` literal, copied verbatim. The end marker is
// the first column-0 `};` after `const routeDeps = {` — every nested
// literal inside routeDeps is indented.
function compositionSlice(src) {
    const depsIdx = src.indexOf('const routeDeps = {');
    expect(depsIdx, `${rel(COMPOSITION_ROOT)} must declare \`const routeDeps = {\``).to.be.gte(0);
    const portsIdx = src.indexOf('const assistantPorts = createAssistantPorts(');
    const start = portsIdx !== -1 && portsIdx < depsIdx ? portsIdx : depsIdx;
    const rest = src.slice(depsIdx);
    const endMatch = rest.match(/\n\};/);
    expect(endMatch, 'routeDeps literal terminator (`};` at column 0) must exist').to.not.equal(null);
    return src.slice(start, depsIdx + endMatch.index + endMatch[0].length);
}

// ── Sandbox: stubbed module-scope legs of the composition root ──────────
function buildComposition({ sessionRepo, order }) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animastor-purge-wiring-'));

    // Only the requires that ride INSIDE the extracted slice are allowed —
    // anything else is a wiring drift and must fail loudly.
    const sliceRequire = (spec) => {
        switch (spec) {
            case './book/bundle-validator.cjs':
                return {
                    validateBundleObject: () => ({ valid: true }),
                    validateBundleFile: () => ({ valid: true }),
                };
            case './services/provider-gateway':
                return { chat: { resolveProvider: async () => ({ provider: 'stub' }), sourceToken: () => 'stub' } };
            case '@animastor/url-safety':
                return { safeFetch: async () => ({ ok: true }) };
            case './services/ai-connector/shared-pool':
                return { runSharedInference: async () => ({ text: '' }), describeSharedError: (e) => String(e) };
            case './services/agent-session-control':
                return {
                    createAgentSessionControl: () => ({
                        cancelSessions: async () => { order.push('cancel-agent-sessions'); return { cancelled: true }; },
                    }),
                };
            case '@animastor/orchestration':
                return {
                    runtime: {
                        sceneWindow: { setCancelFlag: async () => { order.push('set-cancel-flag'); } },
                        // Stage 118 (B4/M2): the capacity-deferral port.
                        dispatch: {
                            clearDeferralsForBook: async () => 0,
                            clearDeferralsForScene: async () => 0,
                        },
                    },
                };
            case './services/source-coverage-audit':
                return async () => ({});
            case './services/agent-prompts':
                return { IMAGE_PROMPT_MAX_CHARS: 4000 };
            case './middleware/workspace-ownership':
                return { resolveWorkspaceForBook: async () => null };
            // Stage 116 (D4): the queue-idempotency port (GPU-lane claims).
            case './helpers/queue-idempotency.cjs':
                return {
                    releaseClaimsForBook: async () => ({ released: 0, done: 0, scanned: 0 }),
                    releaseClaimsForScene: async () => ({ released: 0, done: 0, scanned: 0 }),
                };
            default:
                throw new Error(`composition slice required an unexpected module: ${spec}`);
        }
    };

    const fakeRedis = {
        sadd: async (key) => { order.push(`sadd:${key}`); return 1; },
        expire: async (key) => { order.push(`expire:${key}`); return 1; },
        del: async (...keys) => { order.push(`del:${keys.join(',')}`); return keys.length; },
    };

    const sandbox = {
        require: sliceRequire,
        console,
        // ── module-scope legs the slice closes over ──
        config: {
            BOOKS_DIR: path.join(tmpDir, 'books'),
            OUTPUT_DIR: path.join(tmpDir, 'output'),
        },
        state: {}, audio: {}, image: {}, video: {},
        book: {
            resetBook: async (id) => { order.push(`resetBook:${id}`); },
            saveBookBundle: () => {},
            findSceneRuntimeData: () => null,
            collectSceneUnits: () => [],
        },
        orchestrator: {},
        storage: {
            postgres: {
                query: async (sql) => { order.push(`pg:${sql}`); return { rows: [] }; },
            },
        },
        runtime: {}, activeScenes: {}, layerConfig: {}, genScope: {},
        placeholderAudio: {}, txtImporter: {},
        lazyBook: { getBookDir: () => tmpDir },
        genSessionRepo: {}, bookSourceRepo: {},
        utils: { log: (msg) => { order.push(`log:${msg}`); } },
        saveChunk: async () => {},
        getChunk: async () => null,
        getAllChunks: async () => [],
        getBookWindowStatus: async () => null,
        detectAvailableMode: () => null,
        recoverChunksFromDisk: async () => {},
        recoverAllBooksFromDisk: async () => {},
        cleanBookRedisKeys: async () => { order.push('cleanBookRedisKeys'); },
        // Module-scope book-registry gate (stage 59) — defined above the
        // extracted slice window, stubbed here like the other module legs.
        isBookRegistered: async () => true,
        cleanupService: {}, taskHandler: {}, bookDiff: {}, windowGenerator: {},
        chatEngine: { AI_API_BASE_URL: 'http://stub.local' },
        iuRepo: {},
        computeWaveform: async () => {},
        computeIuReady: () => ({}),
        journal: {}, wfManager: {}, sceneAssetsRepo: {},
        bookModel: { loadBook: async () => ({}) },
        // The seam under test — REAL host factories from the composition root.
        createBookDeletion,
        createAssistantPorts,
        chatSessionRepo: sessionRepo,
        // Player/Editor ports (out of scope — stubs)
        createPlayerModel: () => ({}),
        createEditorModel: () => ({}),
        createEditorPorts: () => ({}),
        authContextMiddleware: { checkBookAccess: () => (_req, _res, next) => next() },
        videoTimeline: { computeVideoStartMs: () => 0 },
        entityCleanup: {},
        redis: fakeRedis,
    };

    vm.createContext(sandbox);
    const src = readSource(COMPOSITION_ROOT);
    const slice = compositionSlice(src);
    vm.runInContext(
        `${slice}\n`
        + ';globalThis.__routeDeps = routeDeps;\n'
        // `typeof` never throws on an unbound identifier: on the pre-fix
        // backend.cjs (no module-scope binding) this exports `undefined`
        // instead of aborting the whole slice.
        + ";globalThis.__assistantPorts = typeof assistantPorts !== 'undefined' ? assistantPorts : undefined;\n",
        sandbox,
        { filename: `${rel(COMPOSITION_ROOT)}#composition-slice` },
    );
    return { routeDeps: sandbox.__routeDeps, assistantPortsBinding: sandbox.__assistantPorts, tmpDir };
}

// ── Test harness ─────────────────────────────────────────────────────────
describe('architecture: assistant purge wiring (composition root)', () => {
    const tmpDirs = [];
    let order;
    let purged;
    let purgeError;
    let sessionRepo;
    let originalFetch;

    beforeEach(() => {
        order = [];
        purged = [];
        purgeError = null;
        sessionRepo = {
            purgeSessionsForBook: async (bookId) => {
                // One shared journal for the WHOLE cascade: T4 asserts the
                // strict PG < Assistant purge < GPU-hub chain on `order`.
                order.push(`purge-assistant:${bookId}`);
                purged.push(bookId);
                if (purgeError) throw purgeError;
            },
        };
        // book-deletion clears the GPU-hub queue best-effort — keep the test
        // hermetic (same stub pattern as generation-routes.test.js).
        originalFetch = global.fetch;
        global.fetch = async () => { order.push('hub-clear'); return { ok: true, status: 200 }; };
    });

    afterEach(() => {
        global.fetch = originalFetch;
        for (const dir of tmpDirs.splice(0)) {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
        }
    });

    function makeComposition() {
        const built = buildComposition({ sessionRepo, order });
        tmpDirs.push(built.tmpDir);
        return built;
    }

    it('T1: purgeAssistantForBook closes over a real module-scope assistantPorts binding', () => {
        const { routeDeps, assistantPortsBinding } = makeComposition();

        expect(assistantPortsBinding,
            'assistantPorts must be declared in module scope of the composition root '
            + '(a routeDeps PROPERTY is not a lexical binding the deletion adapter can close over)')
            .to.be.an('object');
        expect(typeof assistantPortsBinding.purgeForBook).to.equal('function');
        expect(assistantPortsBinding.sessionRepo,
            'the ports object must carry the host session repo handed to createAssistantPorts')
            .to.equal(sessionRepo);
        expect(routeDeps.assistantPorts,
            'routeDeps must re-export the SAME ports object the adapter closes over')
            .to.equal(assistantPortsBinding);
        expect(typeof routeDeps.bookDeletion.deleteBook).to.equal('function');
    });

    it('T2: deleting a book purges Assistant data through assistantPorts.sessionRepo with the book id', async () => {
        const { routeDeps } = makeComposition();

        const result = await routeDeps.bookDeletion.deleteBook('book-purge-1');

        expect(result.deleted).to.be.true;
        expect(purged, 'Assistant-data purge must reach the session repo (ReferenceError in the '
            + 'closure used to swallow this call behind a warning)').to.deep.equal(['book-purge-1']);
        // The adapter must resolve to the composed ports object, not a copy.
        expect(routeDeps.assistantPorts.sessionRepo.purgeSessionsForBook).to.equal(sessionRepo.purgeSessionsForBook);
    });

    it('T3: a failing purge keeps the existing contract — warn + continue, deletion resolves', async () => {
        const { routeDeps } = makeComposition();
        purgeError = new Error('session repo down');

        const warns = [];
        const originalWarn = console.warn;
        console.warn = (...args) => { warns.push(args.join(' ')); };
        let result;
        try {
            result = await routeDeps.bookDeletion.deleteBook('book-purge-2');
        } finally {
            console.warn = originalWarn;
        }

        expect(purged).to.deep.equal(['book-purge-2']); // the purge WAS attempted
        expect(result.deleted, 'purge failure must not change the deletion semantics').to.be.true;
        expect(warns.join('\n')).to.match(/\[DELETE-BOOK\] Assistant data cleanup failed: session repo down/);
    });

    it('T4: the surrounding deletion cascade is unchanged (cancel → reset → redis → PG → purge → hub)', async () => {
        const { routeDeps } = makeComposition();

        const result = await routeDeps.bookDeletion.deleteBook('book-purge-3');

        expect(result).to.deep.equal({ deleted: true, book_id: 'book-purge-3' });

        const idx = (needle) => order.findIndex((entry) => entry.includes(needle));
        const cancelIdx = idx('sadd:animastor:cancelled-workers:book-purge-3');
        const agentIdx = idx('cancel-agent-sessions');
        const resetIdx = idx('resetBook:book-purge-3');
        const redisIdx = idx('cleanBookRedisKeys');
        const pgBooksIdx = order.findIndex((e) => e === 'pg:DELETE FROM books WHERE book_id = $1');
        // Every position below comes from the ONE shared `order` journal —
        // including the Assistant purge (never from the separate `purged`
        // array), so a step running in the wrong slot moves its index there.
        const lastPgIdx = order.reduce(
            (last, entry, i) => (entry.startsWith('pg:') && i > last ? i : last), -1);
        const purgeIdx = order.indexOf('purge-assistant:book-purge-3');
        const hubIdx = order.indexOf('hub-clear');

        expect(cancelIdx, 'cancelled-workers signal must be sent').to.be.gte(0);
        expect(agentIdx, 'agent-session cancel must be sent').to.be.gte(0);
        expect(resetIdx, 'canonical reset must run').to.be.gte(0);
        expect(redisIdx, 'book-keyed Redis purge must run').to.be.gte(0);
        expect(pgBooksIdx, 'PG books cleanup must run').to.be.gte(0);
        expect(hubIdx, 'GPU-hub queue clear must run').to.be.gte(0);
        expect(purgeIdx, 'Assistant purge must be recorded in the shared order journal').to.be.gte(0);

        // Order contract of the cascade (book-deletion.cjs §1–6).
        expect(cancelIdx).to.be.below(resetIdx);
        expect(agentIdx).to.be.below(resetIdx);
        expect(resetIdx).to.be.below(redisIdx);
        expect(redisIdx, 'Redis purge must precede the PG step').to.be.below(pgBooksIdx);
        // Strict chain on the shared journal: PG deletes < Assistant purge <
        // GPU-hub clear (step 5 → 5b → 6).
        expect(lastPgIdx, 'the PG table loop must run').to.be.gte(0);
        expect(purgeIdx, 'Assistant purge must run AFTER the PG deletes').to.be.above(lastPgIdx);
        expect(hubIdx, 'GPU-hub clear must run AFTER the Assistant purge').to.be.above(purgeIdx);
    });
});
