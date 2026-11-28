// ======================================================
// Generate API v2 (ADR ORCHESTRATION_V2 §11.1, §9) — contract of the four endpoints
// ======================================================
//   POST /api/v1/book/:bookId/generate          {scope, layers, mode, client_action_id}
//   POST /api/v1/book/:bookId/generate/stop     {command_id} | {layer} | {}
//   GET  /api/v1/book/:bookId/generate/progress (ADR §9 aggregate)
//   GET  /api/v1/book/:bookId/generate/stream   (SSE from PG LISTEN gen_progress, no Redis)
// plus the old GET /progress-stream of a v2 book (switched to the same in-process listener).
//
// Real: PG (animastor-test: books / workers / scene_assets / gen_*), the gen core,
// the orchestration-v2 host (its own LISTEN gen_progress) + ports + routes, the
// old book routes, layer-config (services/layer-config → PG book_layer_config,
// 2026-11-27). Faked: the book on disk, the worker (HTTP client). «Redis stopped» =
// an ioredis client on a closed port (connection refused, offline queue off): every
// Redis call fails.

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { spawnSync } = require('child_process');
const Redis = require('ioredis');

const { query, getPool } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const config = require('../src/config/runtime-config');
const gen = require('@animastor/orchestration').gen;
const { createOrchV2Host } = require('../src/orchestration-v2');
const { createV2Routes } = require('../src/orchestration-v2/routes');
const { createMockRedis } = require('./mocks/redis-mock');
const { lockReference } = require('./helpers/voice-reference-fixture');

const FIX = path.resolve(__dirname, '../../packages/animastor-orchestration/test/gen/fixtures');
const fixture = (n) => fs.readFileSync(path.join(FIX, n));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const HUB_KEY = 'test-hub-key-generate-api';
const SECRET = 'generate-api-test-upload-secret-0123456789ab';
const stamp = `gapi${Date.now().toString(36)}`;

async function fixtureDecodePcm(filePath) {
    const h = sha(fs.readFileSync(filePath));
    for (const f of fs.readdirSync(FIX).filter((x) => x.endsWith('.mp3'))) {
        if (sha(fixture(f)) === h) { const p = fixture(f.replace(/\.mp3$/, '.s16le')); return new Int16Array(p.buffer, p.byteOffset, p.length / 2); }
    }
    throw Object.assign(new Error('no recorded decode'), { code: 'EDECODE' });
}

function bookJson(bookId, buildId) {
    const long = (n) => `Сцена ${n}: достаточно длинный текст повествования, чтобы обойтись без режима добивки коротких фраз.`;
    return {
        manifest: { book_id: bookId, build_id: buildId },
        heroes: [{ schema: 'animastor.character/1', id: 'narrator', role: 'narrator', voice: { timbre: 'calm male narrator', manner: '' } }],
        chapters: [
            { chapter_id: 'ch-1', chapter_title: 'Первая', display_number: 1, scenes: [
                { scene_id: 'sc-1', type: 'narration', display_index: 1, scene_title: 'Начало', audio: { full_text: long(1) } },
                { scene_id: 'sc-2', type: 'narration', display_index: 2, audio: { full_text: long(2) } },
            ] },
            { chapter_id: 'ch-2', chapter_title: 'Вторая', display_number: 2, scenes: [
                { scene_id: 'sc-3', type: 'narration', display_index: 1, audio: { full_text: long(3) } },
            ] },
        ],
    };
}

/** Minimal SSE client: collects `data:` JSON events; next(pred) waits for a matching one. */
function openSse(url) {
    const events = [];
    const waiters = [];
    let buf = '';
    let req;
    const ready = new Promise((resolve, reject) => {
        req = http.get(url, (res) => {
            resolve(res);
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                buf += chunk;
                let i;
                while ((i = buf.indexOf('\n\n')) >= 0) {
                    const block = buf.slice(0, i);
                    buf = buf.slice(i + 2);
                    const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
                    if (!data) continue;
                    let evt; try { evt = JSON.parse(data); } catch (_) { continue; }
                    events.push(evt);
                    for (const w of [...waiters]) if (w.pred(evt)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.t); w.resolve(evt); }
                }
            });
        });
        req.on('error', reject);
    });
    return {
        events,
        ready,
        next(pred, ms = 5000, label = 'event') {
            const hit = events.find(pred);
            if (hit) return Promise.resolve(hit);
            return new Promise((resolve, reject) => {
                const w = { pred, resolve, t: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`SSE: no ${label} within ${ms} ms; got ${JSON.stringify(events.map((e) => e.type + ':' + (e.reason || '')))}`)); }, ms) };
                waiters.push(w);
            });
        },
        /** only events that arrive after this call */
        after() { const n = events.length; return (pred, ms, label) => this.next((e) => events.indexOf(e) >= n && pred(e), ms, label); },
        close() { try { req.destroy(); } catch (_) { /* closed */ } },
    };
}

describe('generate API v2 — /generate, /generate/stop, /generate/progress, /generate/stream', function () {
    this.timeout(60000);
    let server; let base; let host; let routes; let redis;
    let userId; let workspaceId; let workerId; let bookId; let buildId;
    const books = new Map();
    const cancelledSessions = [];
    const redisPublishes = [];
    const legacyBooks = [];

    const vbook = {
        loadBook: (id) => books.get(id) || null,
        collectScenes: (b) => require('../src/book').collectScenes(b),
    };
    // the real service: layer-config is PG-only (book_layer_config), no Redis
    const layerConfig = require('../src/services/layer-config');

    function makeHost(redisClient) {
        const audioDeps = { book: vbook };
        if (!HAS_FFMPEG) {
            audioDeps.pipeline = { buildSceneAudio: async (paths, out) => { fs.copyFileSync(paths[0], out); return out; } };
            const realGen = require('../src/audio/generation');
            audioDeps.generation = { ...realGen, trimPaddedSceneAudio: async () => {} };
        }
        return createOrchV2Host({
            env: { ORCH_V2_ENABLED: '1', ORCH_V2_UPLOAD_SECRET: SECRET, ORCH_V2_PUBLIC_URL: base, ORCH_V2_PROGRESS_COALESCE_MS: '20' },
            hasFfmpeg: () => true,
            getPool, redis: redisClient, layerConfig, book: vbook, outputDir: config.OUTPUT_DIR,
            gpuDispatcher: require('../src/runtime/worker-lanes'),
            timers: false, log: () => {},
            listenDelaysMs: [50, 100],
            portOverrides: {
                audioDeps,
                ports: HAS_FFMPEG ? {} : { validateResult: gen.defaults.createDefaultValidateResult({ decodePcm: fixtureDecodePcm }) },
            },
        });
    }

    function wireApp(redisClient) {
        const app = express();
        app.use(express.json());
        app.use('/api/v1', require('../src/middleware/no-store').noStoreForPolling);   // as backend.cjs
        app.use((req, _res, next) => { req.user = { user_id: userId }; next(); });
        routes = createV2Routes({
            host, config: { GPU_HUB_API_KEY: HUB_KEY, shareFeaturesEnabled: () => false },
            workerRepo: require('../src/storage/postgres/repositories/worker-repo'),
            bookRepo: require('../src/storage/postgres/repositories/book-repo'),
            layerConfig, redis: redisClient, book: vbook,
            sessionControl: { cancelSessions: async (b) => { cancelledSessions.push(b); } }, log: () => {},
        });
        routes.mountInternal(app);
        routes.mountGenerateRoutes(app, { generationMaterial: require('../src/helpers/book-text.cjs') });
        const deps = { utils: { log: () => {} }, orchV2: routes, layerConfig, book: vbook, config, runtime: {}, state: {}, activeScenes: {}, iuRepo: {} };
        require('../src/routes/book/generation-routes.cjs')(app, redisClient, deps);
        require('../src/routes/generation-routes.cjs')(app, redisClient, deps);   // old GET /progress-stream
        server.removeAllListeners('request');
        server.on('request', app);
    }

    const api = async (method, url, body) => {
        const r = await fetch(`${base}${url}`, {
            method, headers: { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        let json = null; try { json = await r.json(); } catch (_) { /* empty */ }
        return { status: r.status, body: json, headers: Object.fromEntries(r.headers.entries()) };
    };
    // fake worker: the internal routes need the hub key header
    const claim = async () => {
        const r = await fetch(`${base}/internal/gen/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': HUB_KEY }, body: JSON.stringify({ worker_id: workerId, worker_type: 'audio' }) });
        return (await r.json()).task;
    };
    const put = async (task) => {
        const r = await fetch(task.upload_url, { method: 'PUT', headers: { authorization: `Bearer ${task.upload_token}`, 'content-type': 'audio/mpeg' }, body: fixture('tone.mp3') });
        return { status: r.status, body: await r.json() };
    };
    /** worker finishes everything that is queued for the book (audio chunks + local merges). */
    async function finishAll() {
        for (let i = 0; i < 20; i += 1) {
            const t = await claim();
            if (!t) break;
            expect((await put(t)).status).to.equal(200);
        }
        while (await host.orch().runLocalOnce()) { /* merges */ }
        await host.orch().sweepOnce();
    }
    const gen_ = (body) => api('POST', `/api/v1/book/${bookId}/generate`, { layers: ['audio'], mode: 'missing', client_action_id: crypto.randomUUID(), ...body });
    const scene = (sceneId, chapterId = 'ch-1') => ({ level: 'scene', chapter_id: chapterId, scene_id: sceneId });
    const count = async (sql, params) => Number((await query(sql, params)).rows[0].n);
    const jobsOf = (b = bookId) => count('SELECT count(*)::int AS n FROM gen_jobs WHERE book_id = $1', [b]);
    const commandsOf = (b = bookId) => count('SELECT count(*)::int AS n FROM gen_commands WHERE book_id = $1', [b]);

    async function addBook(id, orchestration) {
        const bld = `bld-${id}`;
        books.set(id, bookJson(id, bld));
        lockReference(books.get(id), config.OUTPUT_DIR);
        await query(`INSERT INTO books (book_id, title, workspace_id, user_id, orchestration) VALUES ($1, 't', $2, $3, $4)`, [id, workspaceId, userId, orchestration]);
        return bld;
    }
    async function dropBook(id) {
        await gen.purgeBook(getPool(), id);
        await query('DELETE FROM scene_assets WHERE book_id = $1', [id]);
        await query('DELETE FROM books WHERE book_id = $1', [id]);
        fs.rmSync(path.join(config.OUTPUT_DIR, `bld-${id}`), { recursive: true, force: true });
    }

    before(async () => {
        await runMigrations();
        await gen.migrate(getPool());
        const wf = require('animastor-comfyui-workflow-connector').workflowLoader;
        wf.configure({ workflowsDir: path.join(__dirname, '../ai/workflows'), connectorsDir: path.join(__dirname, '../ai/connectors') });
        wf.loadWorkflows();
        userId = (await query(`INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING user_id`, [`u-${stamp}`])).rows[0].user_id;
        workspaceId = (await query(`INSERT INTO workspaces (name, type, owner_user_id) VALUES ($1, 'personal', $2) RETURNING id`, [`w-${stamp}`, userId])).rows[0].id;
        workerId = (await query(`INSERT INTO workers (workspace_id, name, worker_type, mode, token_hash, created_by, last_seen)
                                 VALUES ($1, 'fake', 'audio', 'private', $2, $3, floor(extract(epoch from now()))::bigint) RETURNING worker_id`,
        [workspaceId, `th-${stamp}`, userId])).rows[0].worker_id;
        redis = createMockRedis();
        const realPublish = redis.publish;
        redis.publish = async (ch, msg) => { redisPublishes.push(ch); return realPublish ? realPublish.call(redis, ch, msg) : 0; };
        server = http.createServer();
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(async () => {
        bookId = `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
        buildId = await addBook(bookId, 'v2');
        await query(`UPDATE workers SET last_seen = floor(extract(epoch from now()))::bigint, current_job_id = NULL WHERE worker_id = $1`, [workerId]);
        host = makeHost(redis);
        await host.start();
        wireApp(redis);
        cancelledSessions.length = 0;
        redisPublishes.length = 0;
    });

    afterEach(async () => {
        await host.stop();
        await dropBook(bookId);
        while (legacyBooks.length) await dropBook(legacyBooks.pop());
    });

    after(async () => {
        await new Promise((r) => server.close(r));
        await query('DELETE FROM workers WHERE worker_id = $1', [workerId]);
        await query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
        await query('DELETE FROM users WHERE user_id = $1', [userId]);
    });

    // ── POST /generate ──────────────────────────────────────────────────
    describe('POST /generate', () => {
        it('успех: сцена, audio, missing → {command_id, existing:false, summary}, без build_id', async () => {
            const r = await gen_({ scope: scene('sc-1'), client_action_id: 'click-1' });
            expect(r.status).to.equal(200);
            expect(r.body).to.include({ book_id: bookId, orchestration: 'v2', existing: false, mode: 'missing', status: 'active' });
            expect(r.body.command_id).to.match(/^[0-9a-f-]{36}$/);
            expect(r.body.summary).to.deep.equal({ jobs_created: 1, joined: 0, skipped_ready: 0 });
            expect(r.body.layers).to.deep.equal(['audio']);
            expect(r.body.scope).to.deep.equal(scene('sc-1'));
            expect(r.body).to.not.have.property('build_id');
            const row = (await query('SELECT kind, force, client_action_id, scope FROM gen_commands WHERE command_id = $1', [r.body.command_id])).rows[0];
            expect(row).to.deep.include({ kind: 'regenerate', force: false, client_action_id: 'click-1' });
        });

        it('повтор того же client_action_id → existing:true, тот же command_id и summary, без дублей', async () => {
            const a = await gen_({ scope: { level: 'chapter', chapter_id: 'ch-1' }, client_action_id: 'dbl' });
            const jobsAfterFirst = await jobsOf();
            const b = await gen_({ scope: { level: 'chapter', chapter_id: 'ch-1' }, client_action_id: 'dbl' });
            // a concurrent double click (both in flight) → still one command
            const [c, d] = await Promise.all([
                gen_({ scope: scene('sc-3', 'ch-2'), client_action_id: 'dbl-2' }),
                gen_({ scope: scene('sc-3', 'ch-2'), client_action_id: 'dbl-2' }),
            ]);
            expect(a.status).to.equal(200);
            expect(b.status).to.equal(200);
            expect(b.body).to.include({ command_id: a.body.command_id, existing: true, mode: 'missing' });
            expect(b.body.summary).to.deep.equal(a.body.summary);
            expect(a.body.summary.jobs_created).to.equal(2);
            expect(c.body.command_id).to.equal(d.body.command_id);
            expect([c.body.existing, d.body.existing].sort()).to.deep.equal([false, true]);
            expect(await commandsOf()).to.equal(2);
            expect(await jobsOf()).to.equal(jobsAfterFirst + 1);
        });

        it('mode missing пропускает готовое, mode all перегенерирует', async () => {
            const first = await gen_({ scope: scene('sc-1') });
            expect(first.body.summary.jobs_created).to.equal(1);
            await finishAll();
            const ready = (await query(`SELECT status FROM scene_assets WHERE book_id = $1 AND scene_id = 'sc-1' AND asset_type = 'audio' AND build_id = $2`, [bookId, buildId])).rows[0];
            expect(ready && ready.status).to.equal('ready');

            const missing = await gen_({ scope: scene('sc-1'), mode: 'missing' });
            expect(missing.status).to.equal(200);
            expect(missing.body.summary).to.include({ jobs_created: 0, skipped_ready: 1 });
            expect(missing.body.mode).to.equal('missing');

            const all = await gen_({ scope: scene('sc-1'), mode: 'all' });
            expect(all.status).to.equal(200);
            expect(all.body.mode).to.equal('all');
            expect(all.body.summary).to.include({ jobs_created: 1, skipped_ready: 0 });
            expect((await query('SELECT force FROM gen_commands WHERE command_id = $1', [all.body.command_id])).rows[0].force).to.equal(true);
        });

        it('scope from_current_scene разворачивается в scenes (порядок книги)', async () => {
            const r = await gen_({ scope: { level: 'from_current_scene', chapter_id: 'ch-1', scene_id: 'sc-2' } });
            expect(r.status).to.equal(200);
            expect(r.body.scope).to.deep.equal({ level: 'scenes', scene_ids: ['sc-2', 'sc-3'] });
            expect(r.body.summary.jobs_created).to.equal(2);
        });

        it('ошибки тела: mode, client_action_id, layers, scope → 400 {code, error}', async () => {
            const cases = [
                [{ mode: 'rebuild' }, 'bad_request'],
                [{ client_action_id: '' }, 'client_action_id_required'],
                [{ client_action_id: undefined }, 'client_action_id_required'],
                [{ layers: [] }, 'bad_request'],
                [{ layers: ['vbook'] }, 'bad_request'],
                [{ scope: 'current_scene' }, 'bad_request'],
                [{ scope: { level: 'chapter' } }, 'bad_request'],
            ];
            for (const [body, code] of cases) {
                const r = await gen_({ scope: scene('sc-1'), ...body });
                expect(r.status, JSON.stringify(body)).to.equal(400);
                expect(r.body.code, JSON.stringify(body)).to.equal(code);
                expect(r.body.error).to.be.a('string');
            }
            expect(await commandsOf()).to.equal(0);
        });

        it('все слои выключены в layer-config → 409 layer_disabled', async () => {
            expect((await api('PUT', `/api/v1/book/${bookId}/layer-config`, { audio_enabled: false })).status).to.equal(200);
            const r = await gen_({ scope: scene('sc-1') });
            expect(r.status).to.equal(409);
            expect(r.body.code).to.equal('layer_disabled');
        });
    });

    // ── layer-config in PG (ADR §11.1, 2026-11-27) ─────────────────────
    describe('layer-config в PG (book_layer_config)', () => {
        const rowOf = async (b = bookId) => (await query('SELECT config FROM book_layer_config WHERE book_id = $1', [b])).rows[0];

        it('PUT layer-config → FLUSHDB Redis → GET то же; /generate учитывает выключенный слой (409 layer_disabled)', async () => {
            const put1 = await api('PUT', `/api/v1/book/${bookId}/layer-config`, { image_enabled: false, chunk_size: 2, video_timeout_minutes: 90 });
            expect(put1.status).to.equal(200);
            const put2 = await api('PUT', `/api/v1/book/${bookId}/layer-config`, { audio_enabled: false });
            expect(put2.status).to.equal(200);
            const before = (await api('GET', `/api/v1/book/${bookId}/layer-config`)).body;
            expect(before).to.include({ audio_enabled: false, image_enabled: false, video_enabled: true, chunk_size: 2, video_timeout_minutes: 90 });
            expect((await rowOf()).config).to.include({ audio_enabled: false, image_enabled: false });

            // the dedicated test Redis (test-db-safety: never the prod port) and the suite's Redis
            expect(Number(process.env.REDIS_PORT)).to.not.equal(6379);
            const real = new Redis({ host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT), lazyConnect: true, maxRetriesPerRequest: 1 });
            await real.connect();
            try {
                expect(await real.flushdb()).to.equal('OK');
                expect(await real.dbsize()).to.equal(0);
            } finally { real.disconnect(); }
            await redis.flushdb();

            const after = (await api('GET', `/api/v1/book/${bookId}/layer-config`)).body;
            expect(after).to.deep.equal(before);
            const r = await gen_({ scope: scene('sc-1') });
            expect(r.status).to.equal(409);
            expect(r.body.code).to.equal('layer_disabled');
            expect(await commandsOf()).to.equal(0);

            // and with a Redis that refuses every call: same config, same 409
            await host.stop();
            const dead = new Redis({ host: '127.0.0.1', port: 9, lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null });
            dead.on('error', () => {});
            await dead.connect().catch(() => {});
            try {
                host = makeHost(dead);
                await host.start();
                wireApp(dead);
                expect((await api('GET', `/api/v1/book/${bookId}/layer-config`)).body).to.deep.equal(before);
                const r2 = await gen_({ scope: scene('sc-1') });
                expect(r2.status).to.equal(409);
                expect(r2.body.code).to.equal('layer_disabled');
                const put3 = await api('PUT', `/api/v1/book/${bookId}/layer-config`, { audio_enabled: true });
                expect(put3.status).to.equal(200);
                expect((await rowOf()).config.audio_enabled).to.equal(true);
            } finally {
                await host.stop();
                dead.disconnect();
                host = makeHost(redis);
                await host.start();
                wireApp(redis);
            }
        });

        it('PUT layer-config audio_enabled=false во время работы: стоп работ слоя (§6.4), ответ cancelled_stages; включение — ничего не снимает', async () => {
            const a = await gen_({ scope: { level: 'book' } });
            expect(a.status).to.equal(200);
            const t = await claim();
            expect(t).to.be.an('object');
            const active = () => count(`SELECT count(*)::int AS n FROM gen_jobs WHERE book_id = $1 AND status IN ('queued','running')`, [bookId]);
            expect(await active()).to.be.greaterThan(0);
            const off = await api('PUT', `/api/v1/book/${bookId}/layer-config`, { audio_enabled: false });
            expect(off.status).to.equal(200);
            expect(off.body.cancelled_stages).to.deep.equal(['audio']);
            expect(await active()).to.equal(0);
            expect((await put(t)).status).to.equal(409);                  // late result of a cancelled job
            expect((await rowOf()).config.audio_enabled).to.equal(false);
            const on = await api('PUT', `/api/v1/book/${bookId}/layer-config`, { audio_enabled: true });
            expect(on.body.cancelled_stages).to.deep.equal([]);
        });

        it('PUT layer-config книги без строки books → 200 как раньше (API не меняется), строки PG нет', async () => {
            const ghost = `${stamp}-ghost`;
            const r = await api('PUT', `/api/v1/book/${ghost}/layer-config`, { audio_enabled: false });
            expect(r.status).to.equal(200);
            expect(r.body).to.include({ book_id: ghost, audio_enabled: false });
            expect(await rowOf(ghost)).to.equal(undefined);
        });
    });

    // ── POST /generate/stop ─────────────────────────────────────────────
    describe('POST /generate/stop', () => {
        it('стоп по команде: только её работы; вторая команда идёт; чужая книга → 404', async () => {
            const a = await gen_({ scope: scene('sc-1') });
            const b = await gen_({ scope: scene('sc-2') });
            const r = await api('POST', `/api/v1/book/${bookId}/generate/stop`, { command_id: a.body.command_id });
            expect(r.status).to.equal(200);
            expect(r.body).to.include({ ok: true, target: 'command', command_id: a.body.command_id, commands_cancelled: 1, jobs_cancelled: 1, kept_shared: 0 });
            expect(r.body.layers).to.deep.equal(['audio']);
            const st = async (id) => (await query('SELECT status FROM gen_commands WHERE command_id = $1', [id])).rows[0].status;
            expect(await st(a.body.command_id)).to.equal('cancelled');
            expect(await st(b.body.command_id)).to.equal('active');
            expect(await count(`SELECT count(*)::int AS n FROM gen_jobs WHERE command_id = $1 AND status = 'queued'`, [b.body.command_id])).to.equal(1);

            // a command of ANOTHER book through this book's URL → 404, nothing stopped
            const other = `${stamp}-o${crypto.randomBytes(2).toString('hex')}`;
            legacyBooks.push(other);
            await addBook(other, 'v2');
            const foreign = await api('POST', `/api/v1/book/${other}/generate/stop`, { command_id: b.body.command_id });
            expect(foreign.status).to.equal(404);
            expect(foreign.body.code).to.equal('command_not_found');
            expect(await st(b.body.command_id)).to.equal('active');
            const bogus = await api('POST', `/api/v1/book/${bookId}/generate/stop`, { command_id: 'not-a-uuid' });
            expect(bogus.status).to.equal(400);
            const both = await api('POST', `/api/v1/book/${bookId}/generate/stop`, { command_id: b.body.command_id, layer: 'audio' });
            expect(both.status).to.equal(400);
        });

        it('стоп по слою: снимает работы слоя книги во всех командах', async () => {
            await gen_({ scope: scene('sc-1') });
            await gen_({ scope: { level: 'chapter', chapter_id: 'ch-2' } });
            const r = await api('POST', `/api/v1/book/${bookId}/generate/stop`, { layer: 'audio' });
            expect(r.status).to.equal(200);
            expect(r.body).to.include({ ok: true, target: 'layer', layer: 'audio', jobs_cancelled: 2 });
            expect(await count(`SELECT count(*)::int AS n FROM gen_jobs WHERE book_id = $1 AND status IN ('queued','running')`, [bookId])).to.equal(0);
            expect(cancelledSessions).to.deep.equal([]);
            const badLayer = await api('POST', `/api/v1/book/${bookId}/generate/stop`, { layer: 'vbook' });
            expect(badLayer.status).to.equal(400);
        });

        it('стоп по книге ({}): все команды и работы книги + VBook-сессии', async () => {
            await gen_({ scope: scene('sc-1') });
            await gen_({ scope: scene('sc-2') });
            const r = await api('POST', `/api/v1/book/${bookId}/generate/stop`, {});
            expect(r.status).to.equal(200);
            expect(r.body).to.include({ ok: true, target: 'book', commands_cancelled: 2, jobs_cancelled: 2, vbook_cancelled: true });
            expect(await count(`SELECT count(*)::int AS n FROM gen_commands WHERE book_id = $1 AND status = 'active'`, [bookId])).to.equal(0);
            expect(cancelledSessions).to.deep.equal([bookId]);
        });
    });

    // ── GET /generate/progress ──────────────────────────────────────────
    it('GET /generate/progress: агрегат §9 — команда × слой × сцена, ready/total, метки', async () => {
        const a = await gen_({ scope: scene('sc-1') });
        const p = await api('GET', `/api/v1/book/${bookId}/generate/progress`);
        expect(p.status).to.equal(200);
        expect(p.headers['cache-control'], 'polling path: no-store (О1)').to.equal('no-store');
        expect(p.headers.etag).to.equal(undefined);
        expect(p.body).to.include({ book_id: bookId, orchestration: 'v2', active: true });
        expect(p.body.commands).to.have.length(1);
        const c = p.body.commands[0];
        expect(c).to.include({ command_id: a.body.command_id, status: 'active', mode: 'missing', kind: 'regenerate' });
        expect(c.layers).to.deep.equal(['audio']);
        expect(c.labels).to.include({ chapter_label: 'Chapter 1 — Первая', scene_label: 'Scene 1 — Начало' });
        expect(c.by_layer.audio).to.include({ queued: 1, running: 0, done: 0, ready: 0, total: 2, percent: 0 });
        expect(c.scenes).to.deep.equal([{ chapter_id: 'ch-1', scene_id: 'sc-1', layer: 'audio', queued: 1, running: 0, done: 0, failed: 0, cancelled: 0, retrying: 0, joined_queued: 0, joined_running: 0 }]);
        expect(c.summary).to.deep.equal({ jobs_created: 1, joined: 0, skipped_ready: 0 });
        await finishAll();
        const done = (await api('GET', `/api/v1/book/${bookId}/generate/progress`)).body;
        expect(done.active).to.equal(false);
        expect(done.commands[0]).to.include({ status: 'done' });
        expect(done.commands[0].by_layer.audio).to.include({ ready: 2, total: 2, percent: 100 });
    });

    // ── GET /generate/stream (SSE) ──────────────────────────────────────
    describe('GET /generate/stream', () => {
        it('подключение → сразу свежий агрегат; завершение работы → событие с done', async () => {
            const a = await gen_({ scope: scene('sc-1') });
            const s = openSse(`${base}/api/v1/book/${bookId}/generate/stream`);
            try {
                const res = await s.ready;
                expect(res.statusCode).to.equal(200);
                expect(res.headers['content-type']).to.match(/text\/event-stream/);
                const first = await s.next((e) => e.type === 'gen_progress', 3000, 'connect aggregate');
                expect(first.reason).to.equal('connect');
                expect(first.progress.commands.map((c) => c.command_id)).to.deep.equal([a.body.command_id]);
                expect(first.progress.commands[0].status).to.equal('active');
                await finishAll();
                const done = await s.next((e) => e.type === 'gen_progress' && e.reason === 'notify'
                    && e.progress.commands.some((c) => c.command_id === a.body.command_id && c.status === 'done'), 5000, 'done event');
                expect(done.command_ids).to.include(a.body.command_id);
                expect(done.progress.commands[0].by_layer.audio).to.include({ percent: 100 });
                // progress of v2 never goes to Redis pub/sub
                expect(redisPublishes.filter((ch) => ch.startsWith('animastor:progress:'))).to.deep.equal([]);
            } finally { s.close(); }
        });

        it('переподключение → сразу свежий агрегат (стоп случился, пока клиента не было)', async () => {
            const a = await gen_({ scope: scene('sc-1') });
            const s1 = openSse(`${base}/api/v1/book/${bookId}/generate/stream`);
            await s1.next((e) => e.type === 'gen_progress' && e.reason === 'connect');
            s1.close();
            await new Promise((r) => setTimeout(r, 50));
            expect((await api('POST', `/api/v1/book/${bookId}/generate/stop`, { command_id: a.body.command_id })).status).to.equal(200);
            await new Promise((r) => setTimeout(r, 100));
            const s2 = openSse(`${base}/api/v1/book/${bookId}/generate/stream`);
            try {
                const first = await s2.next((e) => e.type === 'gen_progress', 3000, 'reconnect aggregate');
                expect(first.reason).to.equal('connect');
                expect(first.progress.commands.find((c) => c.command_id === a.body.command_id).status).to.equal('cancelled');
                expect(host.progressHub().stats().aggregate_clients).to.equal(1);
            } finally { s2.close(); }
            await new Promise((r) => setTimeout(r, 50));
            expect(host.progressHub().stats().aggregate_clients).to.equal(0);
        });

        it('Redis остановлен → события /generate/stream и старого /progress-stream всё равно приходят', async () => {
            // swap in a Redis that refuses every call (closed port, no offline queue)
            await host.stop();
            const dead = new Redis({ host: '127.0.0.1', port: 9, lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null });
            dead.on('error', () => {});
            await dead.connect().catch(() => {});
            let deadErr = null;
            try { await dead.publish('x', 'y'); } catch (e) { deadErr = e; }
            expect(deadErr, 'the swapped-in Redis refuses calls').to.be.an('error');
            host = makeHost(dead);
            await host.start();
            wireApp(dead);
            const sNew = openSse(`${base}/api/v1/book/${bookId}/generate/stream`);
            const sOld = openSse(`${base}/api/v1/book/${bookId}/progress-stream`);
            try {
                await sNew.next((e) => e.type === 'gen_progress' && e.reason === 'connect');
                await sOld.ready;
                await new Promise((r) => setTimeout(r, 100));   // old route: hub subscription is in place
                const a = await gen_({ scope: scene('sc-1') });
                expect(a.status).to.equal(200);
                const created = await sNew.next((e) => e.reason === 'notify' && e.progress.commands.some((c) => c.command_id === a.body.command_id), 5000, 'created event');
                expect(created.progress.active).to.equal(true);
                await finishAll();
                await sNew.next((e) => e.reason === 'notify' && e.progress.commands.some((c) => c.command_id === a.body.command_id && c.status === 'done'), 5000, 'done event');
                const oldDone = await sOld.next((e) => e.type === 'generation_complete' && e.command_id === a.body.command_id, 5000, 'old generation_complete');
                expect(oldDone.status).to.equal('done');
                expect(sOld.events.some((e) => e.type === 'progress' && e.layer === 'audio' && e.command_id === a.body.command_id)).to.equal(true);
            } finally {
                sNew.close(); sOld.close();
                await new Promise((r) => setTimeout(r, 50));
                dead.disconnect();
            }
        });
    });

    // ── LISTEN survives a lost PG connection (@animastor/orchestration 1.4.3) ──
    it('обрыв LISTEN (pg_terminate_backend) → процесс жив, строка в лог, переподключение, SSE получает свежий агрегат, NOTIFY снова доходит', async function () {
        const listener = host.progressListener();
        if (!listener || typeof listener.pid !== 'function') {
            // the core in node_modules is < 1.4.3 (backend/package.json stays on the published version until 1.4.3 is published)
            this.skip();
        }
        const lines = [];
        const origWarn = console.warn; const origLog = console.log;
        console.warn = (...a) => { lines.push(['warn', a.join(' ')]); };
        console.log = (...a) => { if (String(a[0]).includes('[ORCH-V2]')) lines.push(['log', a.join(' ')]); else origLog(...a); };
        const s = openSse(`${base}/api/v1/book/${bookId}/generate/stream`);
        try {
            await s.next((e) => e.type === 'gen_progress' && e.reason === 'connect');
            const pid1 = listener.pid();
            // a command created while the listener is down: its NOTIFY is lost, the resync must show it
            expect((await query('SELECT pg_terminate_backend($1) AS ok', [pid1])).rows[0].ok).to.equal(true);
            await new Promise((r) => setTimeout(r, 20));
            const a = await gen_({ scope: scene('sc-1') });
            const resync = await s.next((e) => e.reason === 'resync', 5000, 'resync aggregate');
            expect(resync.progress.commands.map((c) => c.command_id)).to.include(a.body.command_id);
            expect(listener.connected()).to.equal(true);
            expect(listener.pid()).to.not.equal(pid1);
            expect(lines.filter(([k, t]) => k === 'warn' && t.includes('[ORCH-V2] progress LISTEN lost'))).to.have.length(1);
            expect(lines.filter(([k, t]) => k === 'log' && t.includes('[ORCH-V2] progress LISTEN restored'))).to.have.length(1);
            // NOTIFY reaches the new connection
            const after = s.after();
            const b = await gen_({ scope: scene('sc-2') });
            await after((e) => e.reason === 'notify' && e.progress.commands.some((c) => c.command_id === b.body.command_id), 5000, 'notify after reconnect');
        } finally {
            console.warn = origWarn; console.log = origLog;
            s.close();
        }
    });

    // ── old GET /progress-stream (until step 5) ─────────────────────────
    it('старый /progress-stream v2-книги: прежние события из того же слушателя, без Redis pub/sub', async () => {
        const s = openSse(`${base}/api/v1/book/${bookId}/progress-stream`);
        try {
            await s.ready;
            await new Promise((r) => setTimeout(r, 100));
            const a = await gen_({ scope: scene('sc-2') });
            const ev = await s.next((e) => e.type === 'progress' && e.command_id === a.body.command_id, 5000, 'old progress event');
            expect(ev).to.include({ layer: 'audio', ready: 0, total: 1 });
            await finishAll();
            await s.next((e) => e.type === 'generation_complete' && e.command_id === a.body.command_id, 5000, 'old generation_complete');
            expect(redisPublishes.filter((ch) => ch.startsWith('animastor:progress:'))).to.deep.equal([]);
            expect(host.progressHub().stats().legacy_clients).to.equal(1);
        } finally { s.close(); }
        await new Promise((r) => setTimeout(r, 50));
        expect(host.progressHub().stats().legacy_clients).to.equal(0);
    });

    // ── cancel-worker stays until task H (ADR §11.3) ─────────────────────
    it('cancel-worker {task_id: command_id} снимает команду generate API (оставлен до задачи H)', async () => {
        const r = await gen_({ scope: scene('sc-1') });
        expect(r.status).to.equal(200);
        const stop = await api('POST', `/api/v1/book/${bookId}/cancel-worker`, { task_id: r.body.command_id });
        expect(stop.body).to.include({ ok: true, jobs_cancelled: 1 });
        const p = (await api('GET', `/api/v1/book/${bookId}/generate/progress`)).body;
        expect(p.commands.find((c) => c.command_id === r.body.command_id).status).to.equal('cancelled');
    });
});
