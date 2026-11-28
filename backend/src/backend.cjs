// ======================================================
// Animastor Backend - v1.0.0 (MODULAR)
// ======================================================
//
// Description:
//   Модульный бэкенд — оркестратор загружает сервисы и монтирует
//   маршруты из отдельных файлов в backend/src/routes/* и services/*.
//
// ======================================================

const path = require('path');

// ======================================================
// S-6/S-7: GENERATION HOST PORTS — composition-root wiring
// ======================================================
// The Generation package (@animastor/generation — packages/animastor-
// generation, extracted from backend/src/generation/** in S-7) depends only
// on Generation-owned ports (generation.ports.*); the host implements them
// via the adapters below. Wired FIRST — before any generation module loads
// (default-registrations reads the config port at load time).
// Ownership: ports belong to the package, adapters to the host.
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md §28–29
require('./config/generation-config-adapter').bindGenerationConfig();
// (2026-11-28, этап 4: the DispatchTransport port is no longer bound — its
// only adapter, runtime/gpu-dispatcher → hub POST /task (protocol 2), is gone;
// orchestration v2 hands work to the worker through /internal/gen/*.)
require('@animastor/generation').ports.profileStore.setProfileStore({
    getAssemblyProfile: require('./services/ai-loader').getAssemblyProfile,
});
require('@animastor/generation').ports.bookData.setBookData({
    collectSceneUnits: require('./book').collectSceneUnits,
    tokensToString: require('./book/lazy-book/appearance').tokensToString,
    resolveHeroLook: require('@animastor/vbook-runtime/looks.cjs').resolveHeroLook,
    passportHeroes: require('@animastor/vbook-runtime/heroes.cjs').passportHeroes,
});
// ======================================================
// MODULE IMPORTS
// ======================================================
const audio = require('./audio');
const image = require('./image');
const video = require('./video');

// S-2: Initialize media registry with default registrations.
// Must run before any module that consumes the registry (runtime, orchestration, routes).
// S-7: the default registrations live in the package (bootstrap() is the
// eager startup entry; the registry also self-bootstraps lazily on first access).
require('@animastor/generation').bootstrap();
// 2026-11-28 (ORCHESTRATION_V2 §12 этап 4, шаг 7): the legacy orchestration is
// gone — no O-2..O-10 port adapters, no host bindings, no S-5 seams, no runtime
// loop / reconcile cycle, no GPU retry policy, no protocol-2 result handling.
// The host consumes @animastor/orchestration only as `.gen` (orchestration-v2/).
const wfManager = require('./services/workflow-manager');
const storage = require('./storage');
const book = require('./book');
const config = require('./config/runtime-config');

// ── VBook runtime package (@animastor/vbook-runtime) — composition root ──
// The VBook runtime lives in packages/animastor-vbook-runtime and must not
// read host config/env: the composition root injects the filesystem root
// (booksRoot) and the structure-detector implementation once, before any
// book operation. The live provider keeps today's read-per-call semantics
// of config.BOOKS_DIR.
// Docs: docs/03-audit/VBOOK_EXTRACTION_READINESS_AUDIT.md §2.6/§3.3,
//       docs/architecture/VBOOK_RUNTIME_RELOCATION_CHECKLIST.md
const { configureBooksRoot } = require('@animastor/vbook-runtime/books-root');
configureBooksRoot(() => config.BOOKS_DIR);
const { setStructureDetector } = require('@animastor/parser');
setStructureDetector(require('./services/structure-detector'));

const txtImporter = require('./services/txt-importer');
const lazyBook = require('./book/lazy-book');
const bookModel = require('./book/book-model.cjs');
const { createBookDeletion } = require('./services/book-deletion.cjs');
// Phase 6: Editor/Player boundaries — facades over the Canonical Book Model.
// The Player (model facade + playback HTTP contour) is physically extracted
// to packages/animastor-player (@animastor/player); the host consumes ONLY
// the package entrypoint — never package internals
// (docs/architecture/PLAYER_ROUTE_SPLIT_CHECKLIST.md, physical move COMPLETE).
// The Editor (model facade + book-editing HTTP contour) is physically
// extracted the same way to packages/animastor-editor (@animastor/editor)
// since the Phase 4 physical move
// (docs/architecture/editor-module-extraction-audit.md — Phase 4).
const { createPlayerModel, createPlayerRoutes } = require('@animastor/player');
// Editor API comes ONLY through the package root (Phase 4.1 — no deep
// imports): the model facade + the frozen-7-port seam factory.
const { createEditorModel, createEditorPorts } = require('@animastor/editor');
// Player package ports (host implementations injected into the playback
// contour — the player package must not import these directly: they carry
// generation-domain knowledge: workflows/ alignment tax, ffmpeg/ffprobe,
// auth middleware).
const videoTimeline = require('./video/video-timeline');
const authContextMiddleware = require('./middleware/auth-context');
const { computeWaveform } = require('./services/waveform-service');
const { computeIuReady } = require('./routes/book/iu-progress-utils.cjs');
const genSessionRepo = require('./storage/postgres/repositories/gen-session-repo');
const bookSourceRepo = require('./storage/postgres/repositories/book-source-repo');
// Assistant extraction: the chat-session repository is the ONLY
// ai_chat_sessions owner (its PG implementation stays host-side); the
// Assistant contour (@animastor/assistant package) and the purge flows
// reach it through ports (assistantPorts below / purgeForBook), never via
// SQL.
const chatSessionRepo = require('./storage/postgres/repositories/chat-session-repo');
// Assistant ports — the HOST adapter half of the seam (contracts live in
// the @animastor/assistant package; this module binds the concrete host
// legs: Book Model, saveBookBundle, lazyBook dir, bundle validator,
// Provider Gateway, PG chat-session repo, url-safety + shared-pool
// transports).
const { createAssistantPorts } = require('./services/assistant-ports.cjs');
// @animastor/assistant — the physically extracted Assistant contour
// (chat engine + /api/v1/ai/* HTTP routes + contracts). Consumed ONLY
// through the package root; every host dependency arrives through the
// assistantPorts seam below (docs/architecture/ai-assistant-extraction.md).
const { createChatEngine, createAssistantRoutes, buildChatRequestExtras } = require('@animastor/assistant');
// The provider connection test sends the chat's own body extras (incl.
// provider-gated enable_thinking) — bound here, the only package consumer.
require('./services/workspace-ai-provider').setChatRequestExtras(buildChatRequestExtras);
const placeholderAudio = require('./services/placeholder-audio');
const utils = require('./helpers/utils.cjs');

const filesystem = storage.filesystem;
const layerConfig = storage.layerConfig;
const genScope = storage.genScope;

// ======================================================
// [02] CORE INIT
// ======================================================
const Redis = require('ioredis');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const { PORT = 3000, HUB_URL = 'https://animastor.org/gpu', BUILD_TTL_HOURS = 48 } = process.env;
const crypto = require('crypto');

// Infrastructure hosts only from the environment (owner, VBook v4 step 6):
// REDIS_HOST / REDIS_PORT / PG_HOST missing → the process stops here, before
// any connection. No short-name default: on the VPS a bare `redis` resolves
// through the hoster's wildcard search domain to a foreign machine
// (config/infra-env.js). REDIS_PASSWORD (optional): set together with
// `requirepass` on the Redis service.
const infraEnv = require('./config/infra-env');
try {
    infraEnv.assertInfraEnv();
} catch (err) {
    console.error(`[FATAL] ${err.message}`);
    process.exit(1);
}
const redis = new Redis(infraEnv.redisOptions());
const app = express();

// Trust the single reverse proxy (nginx in docker-compose) so express-rate-limit
// and req.ip use the real client IP from X-Forwarded-For. Without this,
// express-rate-limit v8 throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every
// proxied request (the header is present but trust proxy is false).
// 1 = trust only the immediately preceding hop (nginx) — nothing else.
app.set('trust proxy', 1);

// Security headers
const helmet = require('helmet');
app.use(helmet());

// Rate limiting
const rateLimit = require('express-rate-limit');
app.use('/api/', rateLimit({
    windowMs: 60_000,
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
}));

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// О1: polling / restore endpoints are never cached or answered with 304
// (Cache-Control: no-store, no ETag) — middleware/no-store.js.
const { noStoreForPolling } = require('./middleware/no-store');
app.use('/api/v1', noStoreForPolling);

// Auth context middleware (session cookie → req.user / req.workspace).
// Requests without a valid session stay anonymous; an anonymous write and
// any anonymous /api/v1/book/* request answer 401 (no guest is minted —
// owner's decision 18.11).
const { authContext, requireBookAccess, requireIdentityForWrites } = require('./middleware/auth-context');
app.use(authContext);
app.use(requireIdentityForWrites);

// Input guard: book/build ids from the URL, query string and JSON body must
// match the storage grammar before any route runs (400 otherwise).
const inputGuard = require('./middleware/input-guard');
inputGuard.registerParamGuards(app);
app.use('/api/v1', inputGuard.requestIdsGuard);

// Authentication MVP: strict rate limit on credential endpoints (brute-force
// surface), registered BEFORE the auth route handlers.
app.use('/api/v1/auth/login', rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts, try again later' },
}));
app.use('/api/v1/auth/register', rateLimit({
    windowMs: 60_000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts, try again later' },
}));

// Auth endpoints (public/pre-auth): register, login, logout, me.
require('./routes/auth-routes.cjs')(app, redis, { utils: { log: (m) => console.log(m) } });

// Book ownership guards (Authentication MVP): every /api/v1/book/:bookId/*
// endpoint plus book-keyed media serving requires an identity (user or
// guest) that may access the book; requests without identity get 401.
// Book-CREATION paths (import/blank) are exempt — they must run
// so ownership can attach to the caller's workspace inside the handler.
const { CREATE_BOOK_SUBPATHS } = inputGuard;
const bookAccessGuard = requireBookAccess('bookId');
app.use('/api/v1/book/:bookId', inputGuard.bookIdPathGuard, (req, res, next) => {
    if (CREATE_BOOK_SUBPATHS.has(req.params.bookId)) return next();
    return bookAccessGuard(req, res, next);
});
// VBOOK_FORMAT_V4 §9: a book of an unsupported format (3.1, no version,
// newer) answers every book route — generation, analysis, editor — with the
// 409 body of GET /book; deleting the book stays allowed. Runs AFTER the
// access guard: a stranger learns nothing about the format of a book.
const vbookVersionGate = require('./middleware/vbook-version-gate');
app.use('/api/v1/book/:bookId', vbookVersionGate.createBookVersionGate({
    getBookManifest: (id) => require('./book/book-model.cjs').getBookManifest(id),
    skip: CREATE_BOOK_SUBPATHS,
}));
app.use('/api/v1/scene/:bookId', inputGuard.bookIdPathGuard, requireBookAccess('bookId'));
app.use('/api/v1/iu-image/:bookId', inputGuard.bookIdPathGuard, requireBookAccess('bookId'));
app.use('/api/v1/preview/:bookId', inputGuard.bookIdPathGuard, requireBookAccess('bookId'));

// Diagnostics surface: platform admins only.
app.use('/api/v1/debug', authContextMiddleware.requireAdmin);

// AI chat endpoints are book-scoped too (session contents belong to a book).
// The target book comes from query/body/session lookup rather than the URL,
// so it is resolved here pre-route. Pre-auth passes through; authenticated
// callers must own the book (fail closed when ownership cannot be proven).
// The guard sets `req.scopedBookId` — the single authorized book identity
// that every /api/v1/ai handler MUST operate on.
const { aiBookGuard } = require('./middleware/ai-book-guard');
// /sessions/:id and /sessions/:id/messages carry the id in the path.
app.use('/api/v1/ai/sessions/:id', aiBookGuard);
// The rest resolve the book from query/body (session_id or book_id).
app.use('/api/v1/ai', (req, res, next) => {
    if (/^\/sessions\/[^/]+/.test(req.path)) return next(); // handled above
    return aiBookGuard(req, res, next);
});
// The assistant on a book of an unsupported format: the same 409 (§9).
app.use('/api/v1/ai', vbookVersionGate.createScopedBookVersionGate({
    getBookManifest: (id) => require('./book/book-model.cjs').getBookManifest(id),
}));

// Request ID + HTTP logging
app.use((req, res, next) => {
    req.requestId = crypto.randomUUID().slice(0, 8);
    const start = Date.now();
    res.on('finish', () => {
        const ms = Date.now() - start;
        const size = res.get('Content-Length') || '-';
        console.log(`[HTTP] [${req.requestId}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms, ${size}B)`);
    });
    next();
});

const OUTPUT_DIR = config.OUTPUT_DIR;

// ======================================================
// HELPERS
// ======================================================
const { log, warn } = utils;

// ── Book-registry gate (read-time self-heal + startup recovery) ──────────
// A book is "registered" iff it owns a `books` row (workspace association).
// The composition root is the only place that decides this; the editor/
// player contours receive it as an injected port so they keep zero host
// PG requires. Read-time self-heal (BOOK-RECOVER Redis chunks + the scene
// storyboard's image_units upsert) AND startup disk recovery
// (recoverAllBooksFromDisk, stage 63) must ONLY run for registered books:
// a disk-only book whose registry rows were removed (deleted book) must
// not be resurrected just because a client still polls its book.json or
// because output files survive on disk. Fails closed (skip recovery) if
// the registry lookup errors, so a PG blip can never resurrect a deleted
// book.
const bookRepo = require('./storage/postgres/repositories/book-repo');
const isBookRegistered = async (bookId) => {
    try {
        const workspaceId = await bookRepo.getWorkspaceId(bookId);
        return !!workspaceId;
    } catch (err) {
        console.log(new Date().toISOString(),
            `[BOOK-REGISTRY] lookup failed for ${bookId} (${err.message}) — treating as unregistered (fail-closed)`);
        return false;
    }
};

// Redis chunk store (text chunk records + window counters — import / player)
const {
    saveChunk, getChunk, getAllChunks, getBookWindowStatus,
    recoverChunksFromDisk, cleanBookRedisKeys,
} = require('./helpers/chunk-store.cjs')(redis);

// ======================================================
// SERVICES (factory pattern)
// ======================================================
const cleanupService = require('./services/cleanup-service.cjs')(redis, config, { log });
// Assistant contour: the chat engine lives in the @animastor/assistant
// package now; the bundle-contract validator and the persona profile path
// are HOST legs injected here (composition-root binding). The engine
// holds no host requires.
const chatEngine = createChatEngine(config, {
    validateBundleObject: require('./book/bundle-validator.cjs').validateBundleObject,
    // Persona markdown is host-owned CONTENT (backend/ai tree); the HOST
    // reads the file here and injects the ready string — the package has
    // no fs/path knowledge. Env override (AI_PROFILE_PATH) unchanged.
    aiProfile: require('./services/assistant-profile-loader.cjs').loadAssistantProfile(),
    // Chat fallback base URL — operator env knob passed as injected config.
    aiApiBaseUrl: process.env.AI_API_BASE_URL,
    // Provider reasoning settings (disable_thinking / reasoning_effort) — the
    // ONE helper the analysis and the provider test use (VBOOK_FORMAT_V4 §12, step 4).
    withReasoning: require('./services/ai-reasoning').withReasoning,
});
const windowGenerator = require('./services/window-generator.cjs')({
    redis, txtImporter, genSessionRepo, placeholderAudio, config,
});

const iuRepo = require('./storage/postgres/repositories/iu-repo');
const sceneAssetsRepo = require('./storage/postgres/repositories/scene-assets-repo');

const bookSnapshot = require('./services/book-snapshot.cjs').createBookSnapshot({ book, config, log });

const bookDiffDeps = { book, utils };
const bookDiff = require('./services/book-diff.cjs')(redis, config, bookDiffDeps);

const entityCleanup = require('./services/entity-cleanup.cjs')(redis, config, {
    utils, storage, bookDiff, book,
});

// ======================================================
// SERVICES — periodic tasks
// ======================================================
// The pending-purge retry of entity-cleanup ran inside the legacy reconcile
// cycle; since 2026-11-28 it has its own timer (startServer below).

// ======================================================
// COMPOSITION ROOT — Assistant contour ports
// ======================================================
// Built in MODULE SCOPE, before routeDeps: the deletion-cascade adapter
// (bookDeletion.purgeAssistantForBook below) closes over this binding, so
// the binding must exist before the adapter is created — otherwise the
// closure resolves an undeclared identifier at call time and the
// Assistant-data purge silently degrades to a warning.
// Assistant contour ports (the playerPorts analog — extraction COMPLETE):
// the AI Assistant HTTP contour (@animastor/assistant package) gets its
// host legs ONLY through this narrow seam. No storage barrel, no SQL,
// no whole Book/VBook services cross into the Assistant object graph:
//   loadBook       — canonical||draft read (Book Model facade, lazy mode)
//   persistBook    — ONE book-save semantics (full bundle save + the
//                    zero-chapter targeted fallback behind a single port)
//   validateBundle / validateBundleFile — bundle-contract validation
//   resolveChatAI  — chat provider resolution (Provider Gateway seam)
//   sessionRepo    — chat-session repository port (list/get/create/
//                    append/rename/delete/purge) — PG impl host-side
//   purgeForBook   — Assistant-data purge for book deletion/cache teardown
//   chatTransport  — safeFetch (@animastor/url-safety) + shared-pool inference +
//                    describeSharedError + chat source token (gateway)
//   log            — host logger
// Guarded by tests/architecture/assistant-contour.test.js (A1–A7) and
// assistant-package-boundary.test.js (PB1–PB4).
// ── Orchestration v2 (ADR animastor-docs ORCHESTRATION_V2.md; every book since
// этап 4). Master flag ORCH_V2_ENABLED; OFF → nothing of v2 runs (no migration /
// sweeper / local runner / internal routes).
const { createOrchV2Host } = require('./orchestration-v2');
const { createV2Routes } = require('./orchestration-v2/routes');
const orchV2Host = createOrchV2Host({
    env: process.env,
    getPool: () => storage.postgres.getPool(),
    // lane lookups of gen.defaults.makeLaneFor (private worker / users-policy)
    gpuDispatcher: require('./runtime/worker-lanes'),
    redis,
    layerConfig,
    book,
    // progress: PG LISTEN gen_progress → in-process SSE hub (no Redis pub/sub, ADR §9)
    outputDir: config.OUTPUT_DIR,
    log: utils.log,
});
const orchV2 = createV2Routes({
    host: orchV2Host,
    config,
    workerRepo: require('./storage/postgres/repositories/worker-repo'),
    bookRepo: require('./storage/postgres/repositories/book-repo'),
    layerConfig,
    redis,
    book,
    sessionControl: require('./services/agent-session-control').createAgentSessionControl(),
    log: utils.log,
});
orchV2.mountInternal(app);

const assistantPorts = createAssistantPorts({
    bookModel, book, lazyBook,
    bundleValidator: require('./book/bundle-validator.cjs'),
    providerGateway: require('./services/provider-gateway'),
    chatEngine,
    sessionRepo: chatSessionRepo,
    urlSafety: require('@animastor/url-safety'),
    sharedPool: require('./services/ai-connector/shared-pool'),
    log: utils.log,
});

// ======================================================
// ROUTES (each registers endpoints on app)
// ======================================================
// Compatibility with the PUBLISHED @animastor/player 0.1.5 only (the package of
// this repo, 0.1.6, no longer reads them): its GET /chunk/:id still calls
// state.getAssetStates and activeScenes.addActiveScene. The legacy runtime is
// gone — both answer "nothing". Remove together with the backend lock bump to
// @animastor/player 0.1.6.
const publishedPlayerCompat = Object.freeze({
    state: Object.freeze({
        AssetState: Object.freeze({ READY: 'ready', PLACEHOLDER: 'placeholder' }),
        getAssetStates: async () => ({}),
    }),
    activeScenes: Object.freeze({ addActiveScene: async () => 0 }),
});

const routeDeps = {
    config, audio, image, video, book, storage,
    layerConfig, genScope, placeholderAudio,
    ...publishedPlayerCompat,
    txtImporter, lazyBook, genSessionRepo, bookSourceRepo,
    // Book Model manifest read (cache teardown: the v2 build dir = manifest.build_id)
    getBookManifest: (id) => require('./book/book-model.cjs').getBookManifest(id),
    // post171: does another book name a build id (PG via book-repo + other
    // manifests)? The .vbook importer gives a taken archive build id a fresh one.
    buildIdsOfOtherBooks: (bookId, candidates) => require('./services/build-id-owners.cjs').buildIdsOfOtherBooks({
        pgOwners: require('./storage/postgres/repositories/book-repo').buildIdsNamedByOtherBooks,
        booksDir: config.BOOKS_DIR,
    }, bookId, candidates),
    utils, saveChunk, getChunk, getAllChunks, getBookWindowStatus,
    recoverChunksFromDisk, cleanBookRedisKeys,
    cleanupService, bookDiff, windowGenerator, bookSnapshot, chatEngine,
    iuRepo, computeWaveform,
    wfManager, sceneAssetsRepo,
    // Book-registry gate for read-time self-heal (scene storyboard must not
    // upsert image_units for a deleted/unregistered book).
    isBookRegistered,
    // Phase 4: Canonical Book Model facade + deletion/purge boundary
    bookModel,
    bookDeletion: createBookDeletion({
        book, redis, config, storage,
        // Scoped build-output cleanup (validated ids, only this book's files).
        // voices/ (VOICE_REFERENCES.md) belongs to the build dir itself: removed with the book.
        removeBookArtifacts: (opts) => require('./services/book-artifacts.cjs').removeBookArtifacts({
            ...opts, buildScoped: require('./utils/build-dir').PRESERVED_ENTRIES,
        }),
        getAllChunks, getChunk, cleanBookRedisKeys,
        log: utils.log,
        // Agent-session cancel port: the cascade delivers the cancellation
        // signal through the same frozen VBook session port as cancel-worker
        // (single owner of the agent_sessions cancel SQL).
        agentSessionControl: require('./services/agent-session-control').createAgentSessionControl(),
        // Assistant-data purge seam: the deletion cascade must not know the
        // ai_chat_sessions table — it purges Assistant data through the port.
        purgeAssistantForBook: (bookId) => assistantPorts.purgeForBook(bookId),
    }),
    // Assistant contour ports — built at module scope above (the seam
    // documentation lives with the construction site). Re-exported on
    // routeDeps for the Assistant route registration + book-routes/cache-
    // routes purge wiring.
    assistantPorts,
    // Phase 6: Player/Editor boundaries — book access via the Canonical
    // Book Model.
    // playerModel comes from the extracted @animastor/player package; the
    // composition root binds it to the host Book Model (VBook runtime shim).
    playerModel: createPlayerModel({ bookModel }),
    editorModel: createEditorModel({ bookModel, persistBook: book.saveBookBundle }),
    // Player package ports: the playback contour (packages/animastor-player)
    // gets its dependencies ONLY through these seams (composition root —
    // no hidden host requires inside the package, guarded by
    // player-route-split.test.js):
    //   outputRoot     — the artifact root (config.OUTPUT_DIR injected; the
    //                    player package never reads config directly; path
    //                    semantics unchanged: path.join(outputRoot, buildId, …))
    //   playerPorts    — host implementations that carry generation-domain or
    //                    host-infra knowledge the player must not import:
    //                    auth (checkBookAccess), video-timeline (ffprobe +
    //                    workflows alignment tax), waveform (ffmpeg)
    //   computeIuReady — pure IU progress math (routes/book/iu-progress-utils)
    //   bookProjections — the two pure VBook-runtime read projections
    //                    (findSceneRuntimeData / collectSceneUnits), passed
    //                    as a narrow port; the whole book module surface
    //                    never enters the player object graph.
    // Final boundary audit: the wide `videoTimeline` module seam was removed —
    // the player contour receives ONLY the port functions above; the host
    // video-timeline module (which imports workflows/ + config) never enters
    // the playback contour object graph.
    outputRoot: config.OUTPUT_DIR,
    playerPorts: {
        assertBookAccess: authContextMiddleware.checkBookAccess,
        computeVideoStartMs: videoTimeline.computeVideoStartMs,
        computeWaveform,
    },
    computeIuReady,
    bookProjections: {
        findSceneRuntimeData: book.findSceneRuntimeData,
        collectSceneUnits: book.collectSceneUnits,
    },
    // Editor contour ports (Phase 1 of the Editor extraction —
    // docs/architecture/editor-module-extraction-audit.md §6/§13): the
    // edit HTTP contour (routes/editor/**) gets its host legs ONLY through
    // this seam (the playerPorts analog — no hidden host requires inside
    // the contour, guarded by editor-route-split.test.js E2/E3):
    //   sceneAssetsRepo   — PG scene-assets (bumpSceneVersions/setDirtyUnitIds)
    //   placeholderAudio  — read-time placeholder recovery (GET /book/:id)
    //   auditCoverage     — POST source-coverage audit service
    //   promptLimit       — IMAGE_PROMPT_MAX_CHARS (agent-domain constant)
    //   purge             — entity-cleanup purgeScene/purgeUnit (structure deletes)
    //   resolveOwnership  — workspace-ownership attach (POST /book/blank)
    //   rollbackOwnership — registry-row rollback on failed blank commit
    //   recoveryCtx       — read-recovery dependencies (redis chunk repair)
    //   The four host legs that were previously required inside
    //   editor-ports.cjs (entity-cleanup, source-coverage-audit,
    //   agent-prompts, workspace-ownership) are now constructed in the
    //   composition root and passed as ready-made references so that
    //   editor-ports.cjs holds zero host require() calls (Phase 1.1).
    editorPorts: createEditorPorts({
        deps: {
            sceneAssetsRepo,
            placeholderAudio,
            // Host implementations — already created/resolved above or below;
            // editor-ports.cjs must not require them itself.
            auditCoverage: require('./services/source-coverage-audit'),
            promptLimit: require('./services/agent-prompts').IMAGE_PROMPT_MAX_CHARS,
            purge: entityCleanup,
            resolveOwnership: async (bookId, meta) => {
                const workspaceOwnership = require('./middleware/workspace-ownership');
                return workspaceOwnership.resolveWorkspaceForBook(bookId, meta);
            },
            // Blank book never got a snapshot — deleteBookSnapshots drops
            // just the fresh books row.
            rollbackOwnership: (bookId) => bookRepo.deleteBookSnapshots(bookId),
            // VBook 4 (§8.2): artifact root — state of a hero's reference files
            // in the API (voice.reference_state, image_refs[].state), read only.
            outputRoot: config.OUTPUT_DIR,
            recoveryCtx: {
                // published @animastor/editor <= 0.5.1 only (its GET /book read-repair);
                // the editor of this repo (0.6.0) no longer reads recoveryCtx.
                redis, book, config, getAllChunks, saveChunk,
                isBookRegistered,
                log: (utils && utils.log) || ((...a) => console.log(new Date().toISOString(), ...a)),
            },
        },
    }),
};

// Orchestration v2 handlers (every book since 2026-11-28, этап 4): the book
// routes read deps.orchV2; the deletion cascade purges gen_* (the hub is never called).
routeDeps.orchV2 = orchV2;
routeDeps.bookDeletion.configureOrchV2({
    purgeGenV2: (bookId) => orchV2.purgeBook(bookId, { getPool: () => storage.postgres.getPool(), outputDir: config.OUTPUT_DIR }),
});

require('./routes/book-routes.cjs')(app, redis, { ...routeDeps, bookDiff, windowGenerator });
// Generate API v2 (ADR ORCHESTRATION_V2 §11.1): /generate, /generate/stop,
// /generate/progress, /generate/stream; the book guard of /api/v1/book/:bookId
// applies (registered above).
orchV2.mountGenerateRoutes(app, { generationMaterial: require('./helpers/book-text.cjs') });
// Voice references (VOICE_REFERENCES.md) — orchestration v2 only; the book
// guard of /api/v1/book/:bookId applies (registered above).
require('./orchestration-v2/voice-routes').mountVoiceRoutes(app, {
    host: orchV2Host,
    editorModel: routeDeps.editorModel,
    bookRepo: require('./storage/postgres/repositories/book-repo'),
    getPool: () => storage.postgres.getPool(),
    log: utils.log,
});
// Player (playback) routes — registered through the @animastor/player
// package API (the playback HTTP contour lives in
// packages/animastor-player; the host must not require package internals —
// docs/architecture/PLAYER_ROUTE_SPLIT_CHECKLIST.md).
createPlayerRoutes(app, redis, routeDeps);
// Generation routes — GET /worker/counts, GET /book/:id/progress-stream (until
// task H). The protocol-2 hub callbacks /gpu/task/result|error are removed
// (2026-11-28, этап 4). No playback handlers remain here.
require('./routes/generation-routes.cjs')(app, redis, routeDeps);
// AI Assistant routes — registered through the @animastor/assistant
// package API (the Assistant HTTP contour lives in
// packages/animastor-assistant; the host must not require package
// internals — docs/architecture/ai-assistant-extraction.md). The contour
// gets ONLY its narrow seams (chatEngine + assistantPorts + utils): no
// storage barrel, no whole Book/VBook services, no task/generation deps
// ride into the Assistant object graph.
createAssistantRoutes(app, redis, {
    chatEngine,
    assistantPorts: routeDeps.assistantPorts,
    utils,
});
require('./routes/debug-routes.cjs')(app, redis, routeDeps);

// Workflow Manager routes
require('./routes/connector-routes.cjs')(app, redis, routeDeps);
require('./routes/workflow-routes.cjs')(app, redis, routeDeps);

// Editor limits / app config
require('./routes/config-routes.cjs')(app, redis, routeDeps);

// Workspace AI provider settings (Experimental Beta — Milestone 1)
require('./routes/settings-ai-routes.cjs')(app);

// Local AI Connector (LAC V1): registration & lifecycle routes for the
// caller's workspace (users only — guests never own long-lived credentials;
// the WS handler below shares this module). Mounted right after the settings
// AI routes (§15 Phase 2 wiring point).
// Registration-flooding rate limit (§10.2) FIRST: the create/re-arm surface
// mints one-time tokens — stricter than the generic /api/ limiter.
app.use(['/api/v1/ai-connector/registrations', '/api/v1/ai-connector/registrations/:connectorId/token'], rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many registration attempts, try again later' },
}));
require('./routes/ai-connector-routes.cjs').createAiConnectorRoutes({ redis })(app);

// LLM Sharing Phase 1 — Control Plane (SH-AI-1): workspace-owner lifecycle
// routes for shareable inference endpoints (Private by default; users only;
// foreign ids indistinguishable 404). The shared-pool resolver seam lives in
// services/ai-connector/shared-pool.js — consumer-side shared discovery is a
// later phase by design.
require('./routes/ai-endpoint-routes.cjs').createAiEndpointRoutes()(app);

// Admin foundation: system AI control (kill switch + system provider) +
// SYSTEM worker registry (Animastor-operated pool, PW-4 fail-closed model).
// Guarded by requireAdmin; served on admin.animastor.org behind Basic Auth.
require('./routes/admin-routes.cjs')(app, redis);

// Private worker registration & lifecycle (Experimental Beta — Private Worker
// Phase 1). Users only; workspace always resolved server-side.
require('./routes/worker-routes.cjs')(app, redis);

// User lookup (Experimental Beta — SH-2, worker sharing V2): minimal
// exact-username recipient picker behind the same kill-switch.
require('./routes/users-routes.cjs')(app);

// Private worker SETUP CONTRACT (Phase 3) — the unified UI-safe contract for
// Web and Android: profiles, installation methods, artifacts, workflows,
// instructions, worker setup status, installation plan. Additive layer; the
// existing worker API above is unchanged. Same session/workspace guards.
require('./routes/worker-setup-routes.cjs')(app, redis);

// ======================================================
// PROMETHEUS METRICS
// ======================================================
const prometheus = require('./metrics/prometheus');

app.get('/metrics', async (req, res) => {
    try {
        const metrics = await prometheus.getMetricsContent();
        res.set('Content-Type', prometheus.getContentType());
        res.end(metrics);
    } catch (err) {
        console.error('[METRICS] Error:', err.message);
        res.status(500).send('Internal Server Error');
    }
});

// ======================================================
// HEALTH ENDPOINT (S3.2, 2026-07-19)
// ======================================================
// Lightweight liveness probe. No auth — public endpoint.
// Returns 200 if Redis responds to PING, 503 otherwise. Since 2026-11-28
// (этап 4) there is no legacy runtime loop: `loop` is gone from the body,
// `orch_v2` reports whether orchestration v2 runs (informational — a
// disabled v2 is a configuration state, not a liveness failure). Used by container orchestrators (docker healthcheck,
// k8s liveness probe) to decide whether to restart the container.

let _isShuttingDown = false;

app.get('/health', async (req, res) => {
    const ts = Date.now();
    if (_isShuttingDown) {
        return res.status(503).json({
            status: 'shutting_down',
            redis: 'unknown',
            ts
        });
    }

    let redisStatus = 'PONG';
    try {
        const pong = await redis.ping();
        redisStatus = pong === 'PONG' ? 'PONG' : 'DOWN';
    } catch (err) {
        redisStatus = 'DOWN';
    }
    let orchV2Enabled = false;
    try { orchV2Enabled = orchV2Host.isEnabled(); } catch (_) { orchV2Enabled = false; }

    const ok = redisStatus === 'PONG';
    res.status(ok ? 200 : 503).json({
        status: ok ? 'ok' : 'degraded',
        redis: redisStatus,
        orch_v2: orchV2Enabled,
        ts
    });
});

// ======================================================
// [14] SERVER STARTUP
// ======================================================

let housekeepingTimer = null;

async function startServer() {
    // Load workflow templates (connectors are required — failure is fatal)
    try {
        const wfLoader = require('animastor-comfyui-workflow-connector').workflowLoader;
        // Host-owned asset directories are injected (extraction §1.3/§2):
        // the package has no host default — the backend passes the AI tree
        // paths at boot. Env WF_DIR / CONNECTOR_DIR still take precedence
        // only when configure() has not set the dirs (package resolution
        // order: explicit injection → env).
        wfLoader.configure({
            workflowsDir: path.join(__dirname, '../ai/workflows'),
            connectorsDir: path.join(__dirname, '../ai/connectors'),
        });
        await wfLoader.loadWorkflows();
        log('[STARTUP] Workflows loaded');
    } catch (wfErr) {
        console.error('[FATAL] Workflow loading failed:', wfErr.message);
        console.error('[FATAL] Every workflow must have a matching connector in the AI connectors dir.');
        console.error('[FATAL] Starting the server without valid workflows would cause silent failures.');
        process.exit(1);
    }

    // Initialize PostgreSQL storage
    try {
        await storage.postgres.initialize();
        log('[STARTUP] PostgreSQL initialized');
    } catch (pgErr) {
        console.error('[STARTUP] PostgreSQL initialization failed (non-fatal):', pgErr.message);
    }

    // Orchestration v2 (master flag ORCH_V2_ENABLED): migration + sweeper + local runner.
    try {
        await orchV2Host.start();
    } catch (v2Err) {
        console.error('[STARTUP] Orchestration v2 start failed — v2 stays disabled:', v2Err.message);
    }

    // Authentication MVP: periodic housekeeping for expired/revoked sessions
    // (PG stays bounded; failures are harmless and only logged).
    try {
        const sessionRepo = require('./storage/postgres/repositories/session-repo');
        setInterval(async () => {
            try {
                const n = await sessionRepo.purgeExpired();
                if (n > 0) log(`[SESSIONS] Purged ${n} expired sessions`);
            } catch (err) {
                console.warn('[SESSIONS] purge failed (non-fatal):', err.message);
            }
        }, 6 * 60 * 60 * 1000).unref(); // every 6h
    } catch (err) {
        console.warn('[SESSIONS] periodic purge setup failed (non-fatal):', err.message);
    }

    // Guest Workspace MVP: expired guest identities + temporary workspaces
    // past TTL+grace are hard-deleted. Duplication-safe by design (each
    // backend process purges, inner-loop lock contention is harmless).
    try {
        const guestRepo = require('./storage/postgres/repositories/guest-repo');
        setInterval(async () => {
            try {
                const deleted = await guestRepo.purgeExpired();
                if ((deleted && deleted.guests) || (deleted && deleted.workspaces)) {
                    log(`[GUESTS] Purged ${deleted.guests} stale guest identities, ${deleted.workspaces} expired temporary workspaces`);
                }
            } catch (err) {
                console.warn('[GUESTS] purge failed (non-fatal):', err.message);
            }
        }, 6 * 60 * 60 * 1000).unref(); // every 6h
    } catch (err) {
        console.warn('[GUESTS] periodic purge setup failed (non-fatal):', err.message);
    }

    // Private Worker (Experimental Beta Phase 1): keep the Redis worker-auth
    // mirror in sync with PG (startup rebuild + periodic resync — heals Redis
    // loss and revoke-during-blip races). Non-fatal.
    try {
        const workerAuth = require('./services/worker-auth');
        workerAuth.startWorkerAuthMirrorSync(redis);
    } catch (err) {
        console.warn('[WORKER-AUTH] mirror sync setup failed (non-fatal):', err.message);
    }

    // LAC-2: Local AI Connector WebSocket endpoint (Phase 2 — WS Foundation).
    // Must be attached before the listen callback (the upgrade event fires
    // after listen, but the listener must be registered before it).
    let aiConnectorWs = null;
    try {
        const { createWsHandler } = require('./routes/ai-connector-routes.cjs');
        aiConnectorWs = createWsHandler({ redis, logger: console });
        log('[STARTUP] Local AI Connector WS handler created');
    } catch (err) {
        console.warn('[STARTUP] Local AI Connector WS setup failed (non-fatal):', err.message);
    }

    // Start server
    const server = app.listen(PORT, () => {
        log(`[STARTUP] Backend server running on port ${PORT}`);
        log(`[STARTUP] GPU HUB URL: ${HUB_URL}`);
        log(`[STARTUP] Output directory: ${OUTPUT_DIR}`);

        // Post-listen initialization (command-only generation: a backend
        // start creates no work). VBook window sessions that were running at
        // shutdown are marked interrupted — never resumed (until task H).
        setImmediate(async () => {
            try {
                const { interruptIncompleteSessions } = require('./services/window-sessions-startup');
                await interruptIncompleteSessions(log);
            } catch (intErr) {
                console.warn('[STARTUP] Interrupting VBook window sessions failed:', intErr.message);
            }
        });

        // Periodic host housekeeping — formerly run inside the legacy runtime
        // loop / reconcile cycle (every 60 s), the same cadence on one timer:
        //   • entity-cleanup retry of incomplete scene / unit purges
        //     (animastor:pending-purge);
        //   • worker liveness → PG mirror (hub heartbeats → workers.status /
        //     last_seen / version; GPU E2E 2026-11-02 §8 п.6).
        let lastWorkerLivenessError = null;
        housekeepingTimer = setInterval(async () => {
            try {
                await entityCleanup.retryPendingPurges();
            } catch (err) {
                console.warn('[PENDING-PURGE] retry failed:', err.message);
            }
            try {
                const wl = await require('./services/worker-liveness-sync.cjs').syncWorkerLiveness(redis);
                if (!wl.ok) {
                    if (wl.error !== lastWorkerLivenessError) console.warn(`[WORKER-LIVENESS] sync failed: ${wl.error}`);
                    lastWorkerLivenessError = wl.error;
                } else {
                    lastWorkerLivenessError = null;
                    if (wl.offline > 0) log(`[WORKER-LIVENESS] live=${wl.live} online=${wl.online} → offline=${wl.offline}`);
                }
            } catch (err) {
                console.warn('[WORKER-LIVENESS] sync failed:', err.message);
            }
        }, 60_000);
        housekeepingTimer.unref();
    });

    // LAC-2: Attach the WebSocket upgrade handler to the HTTP server.
    // Must happen after server.listen() returns — the server object must
    // exist. The upgrade event listener is safe to attach at any point
    // after the server is created; events only arrive after listen.
    if (aiConnectorWs) {
        aiConnectorWs.attachUpgrade(server);
        log('[STARTUP] Local AI Connector WS upgrade handler attached');
    }

    // Graceful shutdown (S3.1, 2026-07-19)
    // SIGTERM  — Kubernetes/docker stop.  Stop timers, close the HTTP server,
    //            stop orchestration v2, close Redis & PG. Hard timeout 10s.
    // SIGINT   — Ctrl+C in dev.  Same path.
    // S2UP:    — uncaught exception.  Try to log + exit non-zero.
    async function gracefulShutdown(signal) {
        if (_isShuttingDown) return;
        _isShuttingDown = true;
        log(`[SHUTDOWN] ${signal} received, shutting down gracefully...`);

        const HARD_TIMEOUT_MS = 10000;
        const hardExit = setTimeout(() => {
            console.error('[SHUTDOWN] Hard timeout — forcing exit');
            process.exit(1);
        }, HARD_TIMEOUT_MS);
        hardExit.unref();

        try {
            // 1. Stop the periodic host housekeeping timer.
            if (housekeepingTimer) { clearInterval(housekeepingTimer); housekeepingTimer = null; }

            // 2. Close all live Local AI Connector WS sessions (marks each
            // connector offline; sockets get a server_shutdown close).
            try {
                if (aiConnectorWs) {
                    aiConnectorWs.shutdown();
                    log('[SHUTDOWN] Local AI Connector WS sessions closed');
                }
            } catch (wsErr) {
                console.warn(`[SHUTDOWN] AI Connector WS shutdown failed: ${wsErr.message}`);
            }

            // 3. Stop accepting new HTTP connections
            try {
                await new Promise((resolve) => server.close(() => {
                    log('[SHUTDOWN] HTTP server closed');
                    resolve();
                }));
            } catch (_) {}

            // 3.5 Orchestration v2: stop the sweeper / local runner / LISTEN client
            try { await orchV2Host.stop(); log('[SHUTDOWN] Orchestration v2 stopped'); } catch (_) {}

            // 4. Close Redis & PG pools
            try { await redis.quit(); log('[SHUTDOWN] Redis closed'); } catch (_) {}
            try { await storage.postgres.closePool(); log('[SHUTDOWN] PostgreSQL closed'); } catch (_) {}

            log('[SHUTDOWN] Goodbye');
            clearTimeout(hardExit);
            process.exit(0);
        } catch (shutdownErr) {
            console.error('[SHUTDOWN] Error during shutdown:', shutdownErr.message);
            clearTimeout(hardExit);
            process.exit(1);
        }
    }

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
}

startServer().catch(err => {
    console.error('[FATAL] Server startup failed:', err.message);
    process.exit(1);
});

// ======================================================
// EXPORTS (for testing)
// ======================================================
module.exports = { app, redis, config, book, audio, image, video, storage };
