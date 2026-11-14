// ======================================================
// Orchestration v2 (stage 1b) — backend integration with a fake worker over HTTP
// ======================================================
// Real: PG (animastor-test, books / workers / scene_assets / gen_*), the gen
// core, orchestration-v2 host + ports + routes, the existing book routes
// (generation-routes, progress-panel) and the book-deletion service.
// Faked: the book on disk (vbook loadBook), layer-config, the worker (HTTP
// client). Without the ffmpeg binary the silence decoder uses the recorded
// decode of the fixtures and the merge stub copies the first part; with
// ffmpeg everything is real.

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { spawnSync } = require('child_process');

const { query, getPool } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const config = require('../src/config/runtime-config');
const gen = require('@animastor/orchestration').gen;
const { createOrchV2Host } = require('../src/orchestration-v2');
const { createV2Routes } = require('../src/orchestration-v2/routes');
const bookFlag = require('../src/orchestration-v2/book-flag');
const { createMockRedis } = require('./mocks/redis-mock');
const { lockReference, toneWav } = require('./helpers/voice-reference-fixture');

const FIX = path.resolve(__dirname, '../../packages/animastor-orchestration/test/gen/fixtures');
const fixture = (n) => fs.readFileSync(path.join(FIX, n));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const HUB_KEY = 'test-hub-key-orch-v2';
const SECRET = 'orch-v2-test-upload-secret-0123456789abcdef';
const stamp = `ov2${Date.now().toString(36)}`;

async function fixtureDecodePcm(filePath) {
    const h = sha(fs.readFileSync(filePath));
    for (const f of fs.readdirSync(FIX).filter((x) => x.endsWith('.mp3'))) {
        if (sha(fixture(f)) === h) { const p = fixture(f.replace(/\.mp3$/, '.s16le')); return new Int16Array(p.buffer, p.byteOffset, p.length / 2); }
    }
    throw Object.assign(new Error('no recorded decode'), { code: 'EDECODE' });
}

// VBook 4: a voice is the `voice` block of a hero (book.heroes[].voice).
const voiceOf = (b, id) => b.heroes.find((h) => h.id === id).voice;

function bookJson(bookId, buildId) {
    const long = (n) => `Сцена ${n}: достаточно длинный текст повествования, чтобы обойтись без режима добивки коротких фраз.`;
    return {
        manifest: { book_id: bookId, build_id: buildId },
        heroes: [{ schema: 'animastor.character/1', id: 'narrator', role: 'narrator', voice: { timbre: 'calm male narrator', manner: '' } }],
        chapters: [
            { chapter_id: 'ch-1', chapter_title: 'Первая', scenes: [
                { scene_id: 'sc-1', type: 'narration', audio: { full_text: long(1) } },
                { scene_id: 'sc-2', type: 'narration', audio: { full_text: long(2) } },
            ] },
            { chapter_id: 'ch-2', chapter_title: 'Вторая', scenes: [
                { scene_id: 'sc-3', type: 'narration', audio: { full_text: long(3) } },
            ] },
        ],
    };
}

describe('orchestration v2 — backend integration (fake worker over HTTP)', function () {
    this.timeout(60000);
    let server; let base; let app; let host; let routes; let redis;
    let userId; let workspaceId; let workerId; let bookId; let buildId;
    const books = new Map();
    const published = [];
    const fetchCalls = [];
    const origFetch = global.fetch;

    const vbook = {
        loadBook: (id) => books.get(id) || null,
        collectScenes: (b) => require('../src/book').collectScenes(b),
    };
    const layerCfg = { audio_enabled: true, image_enabled: true, video_enabled: true };
    const layerConfig = { get: async () => ({ ...layerCfg }), set: async (_r, _b, v) => { for (const [k, x] of Object.entries(v)) if (x !== undefined) layerCfg[k] = x; return { ...layerCfg }; } };

    function makeHost() {
        const audioDeps = { book: vbook };
        if (!HAS_FFMPEG) {
            audioDeps.pipeline = { buildSceneAudio: async (paths, out) => { fs.copyFileSync(paths[0], out); return out; } };
            const realGen = require('../src/audio/generation');
            audioDeps.generation = { ...realGen, trimPaddedSceneAudio: async () => {} };
        }
        const h = createOrchV2Host({
            env: { ORCH_V2_ENABLED: '1', ORCH_V2_UPLOAD_SECRET: SECRET, ORCH_V2_PUBLIC_URL: base },
            hasFfmpeg: () => true,
            getPool, redis, layerConfig, book: vbook, outputDir: config.OUTPUT_DIR,
            gpuDispatcher: require('../src/runtime/gpu-dispatcher'),
            publishProgress: async (_r, b, payload) => { published.push({ book: b, ...payload }); },
            timers: false, log: () => {},
            portOverrides: {
                audioDeps,
                ports: HAS_FFMPEG ? {} : { validateResult: gen.defaults.createDefaultValidateResult({ decodePcm: fixtureDecodePcm }) },
            },
        });
        return h;
    }

    function mountBookRoutes(a, r) {
        const deps = {
            utils: { log: () => {} }, orchV2: r, layerConfig, book: vbook, config,
            runtime: {}, state: {}, activeScenes: {}, iuRepo: {},
        };
        require('../src/routes/book/generation-routes.cjs')(a, redis, deps);
        require('../src/routes/book/progress-panel.cjs')(a, redis, deps);
        require('../src/routes/book/cache-routes.cjs')(a, {
            redis, config, storage: { postgres: { query } }, path, fs,
            getAllChunks: async () => [], getChunk: async () => null, cleanBookRedisKeys: async () => {},
            purgeAssistantForBook: async () => {}, orchV2: r, log: () => {},
        });
    }

    async function wireApp() {
        app = express();
        app.use(express.json());
        app.use((req, _res, next) => { req.user = { user_id: userId }; next(); });
        routes = createV2Routes({
            host, config: { GPU_HUB_API_KEY: HUB_KEY, shareFeaturesEnabled: () => false },
            workerRepo: require('../src/storage/postgres/repositories/worker-repo'),
            bookRepo: require('../src/storage/postgres/repositories/book-repo'),
            layerConfig, redis, book: vbook, sessionControl: { cancelSessions: async () => {} }, log: () => {},
        });
        routes.mountInternal(app);
        mountBookRoutes(app, routes);
        require('../src/orchestration-v2/voice-routes').mountVoiceRoutes(app, {
            host, editorModel: { read: (id) => books.get(id) || null, commit: () => {} },
            bookRepo: require('../src/storage/postgres/repositories/book-repo'), getPool, log: () => {},
        });
        server.removeAllListeners('request');
        server.on('request', app);
    }

    const api = async (method, url, body, headers = {}) => {
        const r = await origFetch(`${base}${url}`, {
            method, headers: { 'content-type': 'application/json', ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        let json = null; try { json = await r.json(); } catch (_) { /* empty */ }
        return { status: r.status, body: json };
    };
    const worker = {
        claim: () => api('POST', '/internal/gen/claim', { worker_id: workerId, worker_type: 'audio' }, { 'x-api-key': HUB_KEY }),
        beacon: (current) => api('POST', '/internal/gen/beacon', { worker_id: workerId, current_job_id: current || null }, { 'x-api-key': HUB_KEY }),
        put: async (task, buf = fixture('tone.mp3'), token = task.upload_token) => {
            const r = await origFetch(task.upload_url, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/mpeg' }, body: buf });
            return { status: r.status, body: await r.json() };
        },
        error: (task, body) => origFetch(task.error_url, { method: 'POST', headers: { authorization: `Bearer ${task.upload_token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
            .then(async (r) => ({ status: r.status, body: await r.json() })),
    };
    const regenerate = (body) => api('POST', `/api/v1/book/${bookId}/regenerate`, { worker_types: ['audio'], rebuild_all: true, ...body });
    const orch = () => host.orch();
    const count = async (sql, params) => Number((await query(sql, params)).rows[0].n);

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
        server = http.createServer();
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}`;
        global.fetch = async (url, opts) => { fetchCalls.push(String(url)); return origFetch(url, opts); };
    });

    beforeEach(async () => {
        bookId = `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
        buildId = `bld-${bookId}`;
        books.set(bookId, bookJson(bookId, buildId));
        lockReference(books.get(bookId), config.OUTPUT_DIR);   // VOICE_REFERENCES: narrator reference locked
        await query(`INSERT INTO books (book_id, title, workspace_id, user_id, orchestration) VALUES ($1, 't', $2, $3, 'v2')`, [bookId, workspaceId, userId]);
        bookFlag.invalidate();
        await query(`UPDATE workers SET last_seen = floor(extract(epoch from now()))::bigint, current_job_id = NULL WHERE worker_id = $1`, [workerId]);
        host = makeHost();
        await host.start();
        await wireApp();
        published.length = 0;
        fetchCalls.length = 0;
    });

    afterEach(async () => {
        await host.stop();
        await gen.purgeBook(getPool(), bookId);
        await query(`DELETE FROM scene_assets WHERE book_id = $1`, [bookId]);
        await query(`DELETE FROM books WHERE book_id = $1`, [bookId]);
        fs.rmSync(path.join(config.OUTPUT_DIR, buildId), { recursive: true, force: true });
    });

    after(async () => {
        global.fetch = origFetch;
        await new Promise((r) => server.close(r));
        await query(`DELETE FROM workers WHERE worker_id = $1`, [workerId]);
        await query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
        await query(`DELETE FROM users WHERE user_id = $1`, [userId]);
    });

    async function runScene(chapterId, sceneId, extra = {}) {
        return regenerate({ scope: 'current_scene', chapter_id: chapterId, scene_id: sceneId, ...extra });
    }

    it('«аудио» сцены: claim → PUT → audio_merge → scene ready (sha256, job_id), sidecar снят, progress-panel done', async () => {
        // a placeholder with its sidecar marker is on disk (import), as in production
        const { getOutputPath } = require('../src/audio/helpers');
        const sceneFile = getOutputPath(buildId, `${bookId}_ch-1_sc-1.mp3`);
        fs.mkdirSync(path.dirname(sceneFile), { recursive: true });
        fs.writeFileSync(sceneFile, fixture('silence.mp3'));
        const marker = require('../src/audio/placeholder-marker');
        marker.writePlaceholderMarker(sceneFile, { reason: 'test' });
        expect(marker.isPlaceholderAudioFile(sceneFile)).to.equal(true);

        const r = await runScene('ch-1', 'sc-1', { client_action: { kind: 'user_click', action_id: 'a-1' } });
        expect(r.status).to.equal(200);
        expect(r.body.orchestration).to.equal('v2');
        expect(r.body.summary).to.deep.equal({ jobs_created: 1, joined: 0, skipped_ready: 0 });
        expect(r.body.build_id).to.equal(buildId);
        const t = (await worker.claim()).body.task;
        expect(t).to.include({ kind: 'audio_chunk', book_id: bookId, scene_id: 'sc-1', unit_key: '0001', attempt: 1 });
        expect(t.params).to.be.an('object');
        expect(t.upload_url).to.equal(`${base}/internal/gen/jobs/${t.job_id}/result?attempt=1`);
        let panel = await api('GET', `/api/v1/book/${bookId}/progress-panel`);
        expect(panel.body.tasks).to.have.length(1);
        expect(panel.body.tasks[0]).to.include({ task_id: r.body.command_id, type: 'audio', scope: 'current_scene', done: false, total: 2, ready: 0 });
        expect(panel.body.any_incomplete).to.equal(true);

        const up = await worker.put(t);
        expect(up.status).to.equal(200);
        expect(up.body.stage_jobs_created).to.equal(1);
        expect((await orch().runLocalOnce()).status).to.equal(200);
        const asset = (await query(`SELECT * FROM scene_assets WHERE book_id = $1 AND scene_id = 'sc-1' AND asset_type = 'audio' AND build_id = $2`, [bookId, buildId])).rows[0];
        expect(asset.status).to.equal('ready');
        expect(asset.sha256).to.match(/^[0-9a-f]{64}$/);
        expect(asset.sha256).to.equal(sha(fs.readFileSync(sceneFile)));
        const merge = (await query(`SELECT job_id FROM gen_jobs WHERE book_id = $1 AND kind = 'audio_merge'`, [bookId])).rows[0];
        expect(asset.job_id).to.equal(merge.job_id);
        expect(marker.isPlaceholderAudioFile(sceneFile)).to.equal(false, 'sidecar marker removed');
        await orch().sweepOnce();
        panel = await api('GET', `/api/v1/book/${bookId}/progress-panel`);
        expect(panel.body.tasks[0]).to.include({ done: true, percent: 100, status: 'completed' });
        expect(panel.body.any_incomplete).to.equal(false);
    });

    it('глава; двойной клик (тот же client_action) → одна команда и тот же summary; пересекающиеся → joined без дублей', async () => {
        const a = await regenerate({ scope: 'current_chapter', chapter_id: 'ch-1', client_action: { kind: 'user_click', action_id: 'dbl' } });
        const b = await regenerate({ scope: 'current_chapter', chapter_id: 'ch-1', client_action: { kind: 'user_click', action_id: 'dbl' } });
        expect(a.body.summary).to.deep.equal({ jobs_created: 2, joined: 0, skipped_ready: 0 });
        expect(b.body.command_id).to.equal(a.body.command_id);
        expect(b.body.existing).to.equal(true);
        expect(b.body.summary).to.deep.equal(a.body.summary);
        const whole = await regenerate({ scope: 'whole_book' });
        expect(whole.body.summary).to.deep.equal({ jobs_created: 1, joined: 2, skipped_ready: 0 });
        expect(await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1`, [bookId])).to.equal(3);
        expect(await count(`SELECT count(*) AS n FROM gen_commands WHERE book_id = $1`, [bookId])).to.equal(2);
    });

    it('стоп книги посередине: оставшиеся cancelled, beacon отдаёт cancel, поздний PUT → 409, сцена не ready', async () => {
        await regenerate({ scope: 'whole_book' });
        const t1 = (await worker.claim()).body.task;
        const t2 = (await worker.claim()).body.task;
        expect((await worker.put(t1)).status).to.equal(200);
        const stop = await api('POST', `/api/v1/book/${bookId}/cancel-generation`, {});
        expect(stop.status).to.equal(200);
        expect(await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1 AND status IN ('queued','running')`, [bookId])).to.equal(0);
        const beacon = await worker.beacon(t2.job_id);
        expect(beacon.body.cancel).to.include(t2.job_id);
        expect((await worker.put(t2)).status).to.equal(409);
        expect(await count(`SELECT count(*) AS n FROM scene_assets WHERE book_id = $1 AND status = 'ready'`, [bookId])).to.equal(0);
        expect(fetchCalls.filter((u) => u.includes('/queue/clear'))).to.deep.equal([], 'hub untouched for a v2 book');
        await orch().sweepOnce();
        expect(await orch().runLocalOnce()).to.equal(null, 'no merge after stop');
    });

    it('стоп одной из двух команд с общим юнитом: юнит выполняется, B → done, A → cancelled', async () => {
        const a = await regenerate({ scope: 'current_chapter', chapter_id: 'ch-1' });
        const b = await runScene('ch-1', 'sc-2');
        expect(b.body.summary).to.deep.equal({ jobs_created: 0, joined: 1, skipped_ready: 0 });
        const stop = await api('POST', `/api/v1/book/${bookId}/cancel-worker`, { task_id: a.body.command_id });
        expect(stop.body).to.include({ ok: true, jobs_cancelled: 1, kept_shared: 1 });
        const t = (await worker.claim()).body.task;
        expect(t.scene_id).to.equal('sc-2');
        expect((await worker.claim()).body.task).to.equal(null);
        expect((await worker.put(t)).body.stage_jobs_created).to.equal(1);
        await orch().runLocalOnce();
        await orch().sweepOnce();
        const st = Object.fromEntries((await query(`SELECT command_id, status FROM gen_commands WHERE book_id = $1`, [bookId])).rows.map((r) => [r.command_id, r.status]));
        expect(st[a.body.command_id]).to.equal('cancelled');
        expect(st[b.body.command_id]).to.equal('done');
    });

    it('рестарт backend посередине (новый экземпляр): дочитывает без потерь, новых job не создано', async () => {
        await regenerate({ scope: 'whole_book' });
        const t1 = (await worker.claim()).body.task;
        const before = await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1`, [bookId]);
        await host.stop();
        host = makeHost();                                    // «restart»
        await host.start();
        await wireApp();
        await orch().sweepOnce();
        expect(await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1`, [bookId])).to.equal(before);
        expect((await worker.put(t1)).status).to.equal(200, 'the in-flight upload of the previous process is accepted');
        for (;;) {
            const t = (await worker.claim()).body.task;
            if (!t) break;
            expect((await worker.put(t)).status).to.equal(200);
        }
        while (await orch().runLocalOnce()) { /* merges */ }
        await orch().sweepOnce();
        expect(await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1 AND status = 'done'`, [bookId])).to.equal(6);
        expect(await count(`SELECT count(*) AS n FROM scene_assets WHERE book_id = $1 AND status = 'ready'`, [bookId])).to.equal(3);
        expect(await count(`SELECT count(*) AS n FROM gen_commands WHERE book_id = $1 AND status = 'done'`, [bookId])).to.equal(1);
    });

    it('воркер пропал (нет beacon 60 с) → повтор; тишина → один повтор, затем failed; сцена не ready', async () => {
        await runScene('ch-1', 'sc-1');
        const t1 = (await worker.claim()).body.task;
        await query(`UPDATE workers SET last_seen = floor(extract(epoch from now()))::bigint - 61 WHERE worker_id = $1`, [workerId]);
        expect((await orch().sweepOnce()).offline).to.equal(1);
        let j = (await query(`SELECT status, error_class FROM gen_jobs WHERE job_id = $1`, [t1.job_id])).rows[0];
        expect(j).to.deep.equal({ status: 'queued', error_class: 'worker_offline' });
        await query(`UPDATE gen_jobs SET not_before = now() WHERE job_id = $1`, [t1.job_id]);
        await worker.beacon(null);
        const t2 = (await worker.claim()).body.task;
        expect(t2.attempt).to.equal(2);
        let r = await worker.put(t2, fixture('silence.mp3'));
        expect(r.status).to.equal(422); expect(r.body.job_status).to.equal('queued');
        await query(`UPDATE gen_jobs SET not_before = now() WHERE job_id = $1`, [t1.job_id]);
        const t3 = (await worker.claim()).body.task;
        expect(t3.attempt).to.equal(3);
        r = await worker.put(t3, fixture('silence.mp3'));
        expect(r.status).to.equal(422); expect(r.body.job_status).to.equal('failed');
        j = (await query(`SELECT status, error_class FROM gen_jobs WHERE job_id = $1`, [t1.job_id])).rows[0];
        expect(j).to.deep.equal({ status: 'failed', error_class: 'invalid_result' });
        expect(await count(`SELECT count(*) AS n FROM scene_assets WHERE book_id = $1 AND status = 'ready'`, [bookId])).to.equal(0);
        await orch().sweepOnce();
        const panel = await api('GET', `/api/v1/book/${bookId}/progress-panel`);
        expect(panel.body.tasks[0]).to.include({ failed: true, done: false });
    });

    it('internal routes: без ключа / токена → 401; video без готового аудио → 200, работ нет, skipped_needs_audio (этап 3)', async () => {
        expect((await api('POST', '/internal/gen/claim', { worker_id: workerId })).status).to.equal(401);
        expect((await api('POST', '/internal/gen/claim', { worker_id: workerId }, { 'x-api-key': 'wrong' })).status).to.equal(401);
        expect((await api('POST', '/internal/gen/beacon', { worker_id: workerId })).status).to.equal(401);
        await runScene('ch-1', 'sc-1');
        const t = (await worker.claim()).body.task;
        const noTok = await origFetch(t.upload_url, { method: 'PUT', body: fixture('tone.mp3') });
        expect(noTok.status).to.equal(401);
        expect((await worker.put(t, fixture('tone.mp3'), `${t.upload_token}x`)).status).to.equal(401);
        expect((await api('POST', `/internal/gen/jobs/${t.job_id}/error?attempt=1`, { error_class: 'transient' })).status).to.equal(401);
        for (const types of [['video'], ['video', 'video']]) {
            const r = await regenerate({ worker_types: types, scope: 'whole_book' });
            expect(r.status).to.equal(200);
            expect(r.body.summary.jobs_created).to.equal(0);
            // the scenes of this book have no IU pictures and (but sc-1, in work) no audio
            const skippedScenes = Object.entries(r.body.summary).filter(([k]) => k.startsWith('skipped_needs_')).flatMap(([, v]) => v);
            expect(skippedScenes.length, JSON.stringify(r.body.summary)).to.be.greaterThan(0);
            expect(await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1 AND layer = 'video'`, [bookId])).to.equal(0);
        }
        expect((await regenerate({ worker_types: ['bogus'], scope: 'whole_book' })).status).to.equal(400);
        const e = await worker.error(t, { error_class: 'deterministic', reason: 'node_errors' });
        expect(e.body).to.include({ status: 200, job_status: 'failed' });
    });

    it('cancel-worker type=audio и PUT layer-config audio_enabled=false снимают слой (и audio_merge)', async () => {
        await regenerate({ scope: 'whole_book' });
        const t = (await worker.claim()).body.task;
        const r = await api('POST', `/api/v1/book/${bookId}/cancel-worker`, { type: 'audio' });
        expect(r.body).to.include({ ok: true, jobs_cancelled: 3 });
        expect((await worker.put(t)).status).to.equal(409);
        await regenerate({ scope: 'current_scene', chapter_id: 'ch-2', scene_id: 'sc-3' });
        const t3 = (await worker.claim()).body.task;
        await worker.put(t3);                                           // → audio_merge queued
        expect(await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1 AND kind = 'audio_merge' AND status = 'queued'`, [bookId])).to.equal(1);
        const put = await api('PUT', `/api/v1/book/${bookId}/layer-config`, { audio_enabled: false });
        expect(put.body.cancelled_stages).to.deep.equal(['audio']);
        expect(await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1 AND status IN ('queued','running')`, [bookId])).to.equal(0);
        layerCfg.audio_enabled = true;
    });

    it('удаление v2-книги: gen_* этой книги пусто, .incoming её работ удалён, хаб не вызывается', async () => {
        await regenerate({ scope: 'whole_book' });
        const t = (await worker.claim()).body.task;
        const incoming = path.join(config.OUTPUT_DIR, buildId, '.incoming');
        fs.mkdirSync(incoming, { recursive: true });
        fs.writeFileSync(path.join(incoming, `${t.job_id}.1.dead.tmp`), 'x');
        fs.writeFileSync(path.join(incoming, `00000000-0000-4000-8000-000000000000.1.other.tmp`), 'y');
        const { createBookDeletion } = require('../src/services/book-deletion.cjs');
        const deletion = createBookDeletion({
            book: { resetBook: async () => {} }, redis, config, storage: { postgres: { query } },
            getAllChunks: async () => [], getChunk: async () => null, cleanBookRedisKeys: async () => {},
            log: () => {}, setCancelFlag: async () => {}, agentSessionControl: { cancelSessions: async () => {} }, purgeAssistantForBook: async () => {},
            isV2Book: (id) => routes.isV2Book(id),
            purgeGenV2: (id) => routes.purgeBook(id, { getPool, outputDir: config.OUTPUT_DIR }),
        });
        fetchCalls.length = 0;
        await deletion.deleteBook(bookId);
        for (const tbl of ['gen_jobs', 'gen_commands']) {
            expect(await count(`SELECT count(*) AS n FROM ${tbl} WHERE book_id = $1`, [bookId])).to.equal(0);
        }
        expect(await count(`SELECT count(*) AS n FROM gen_command_jobs l LEFT JOIN gen_jobs j ON j.job_id = l.job_id WHERE j.job_id IS NULL`)).to.equal(0);
        expect(fs.existsSync(path.join(incoming, `${t.job_id}.1.dead.tmp`))).to.equal(false);
        expect(fs.existsSync(path.join(incoming, `00000000-0000-4000-8000-000000000000.1.other.tmp`))).to.equal(true, 'other books\' files stay');
        expect(fetchCalls.filter((u) => u.includes('/queue/clear'))).to.deep.equal([]);
    });

    it('from_current_scene → scope {level:scenes, scene_ids: current…end} в порядке книги; выдача в этом порядке; ошибки 400/404', async () => {
        const r = await regenerate({ scope: 'from_current_scene', chapter_id: 'ch-1', scene_id: 'sc-2' });
        expect(r.status).to.equal(200);
        expect(r.body.summary).to.deep.equal({ jobs_created: 2, joined: 0, skipped_ready: 0 });
        expect(r.body.scope).to.equal('from_current_scene');
        const stored = (await query(`SELECT scope FROM gen_commands WHERE command_id = $1`, [r.body.command_id])).rows[0].scope;
        expect(stored).to.deep.equal({ level: 'scenes', scene_ids: ['sc-2', 'sc-3'] });
        const order = [];
        for (let i = 0; i < 2; i += 1) order.push((await worker.claim()).body.task.scene_id);
        expect(order).to.deep.equal(['sc-2', 'sc-3']);
        expect((await worker.claim()).body.task).to.equal(null, 'sc-1 (before the current scene) is not in the command');
        // the same expansion as the legacy gen-scope.scopeBounds
        const all = vbook.collectScenes(books.get(bookId));
        const { startIndex, endIndex } = require('../src/services/gen-scope').scopeBounds({ scope: 'from_current_scene', chapter_id: 'ch-1', scene_id: 'sc-2' }, all);
        expect(all.slice(startIndex, endIndex).map((x) => x.scene_id)).to.deep.equal(stored.scene_ids);
        // the first scene of the book → the whole book
        const first = await regenerate({ scope: 'from_current_scene', chapter_id: 'ch-1', scene_id: 'sc-1', rebuild_all: false });
        expect(first.body.summary).to.deep.equal({ jobs_created: 1, joined: 2, skipped_ready: 0 });
        expect((await regenerate({ scope: 'from_current_scene', chapter_id: 'ch-1', scene_id: 'nope' })).body.code).to.equal('scene_not_found');
        expect((await regenerate({ scope: 'from_current_scene', chapter_id: 'ch-1', scene_id: 'nope' })).status).to.equal(404);
        expect((await regenerate({ scope: 'from_current_scene' })).status).to.equal(400);
    });

    it('DELETE /book/:id/cache для v2-книги: хаб не вызывается, работа книги отменена (до стирания); legacy-книга — хаб вызывается', async () => {
        await regenerate({ scope: 'whole_book' });
        const t = (await worker.claim()).body.task;
        fetchCalls.length = 0;
        const r = await api('DELETE', `/api/v1/book/${bookId}/cache`);
        expect(r.status).to.equal(200);
        expect(r.body).to.include({ cleared: true, orchestration: 'v2', hub_skipped: true, commands_cancelled: 1, jobs_cancelled: 3 });
        expect(fetchCalls.filter((u) => u.includes('/queue/clear'))).to.deep.equal([], 'hub untouched for a v2 book');
        expect(await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1 AND status IN ('queued','running')`, [bookId])).to.equal(0);
        expect((await worker.beacon(t.job_id)).body.cancel).to.include(t.job_id);
        expect((await worker.put(t)).status).to.equal(409, 'a late result cannot re-create the wiped asset');
        expect(await count(`SELECT count(*) AS n FROM scene_assets WHERE book_id = $1`, [bookId])).to.equal(0);

        // control: a legacy book still goes through the hub
        const legacyId = `${bookId}-legacy`;
        await query(`INSERT INTO books (book_id, title, workspace_id, user_id, orchestration) VALUES ($1, 't', $2, $3, 'legacy')`, [legacyId, workspaceId, userId]);
        try {
            bookFlag.invalidate();
            fetchCalls.length = 0;
            const l = await api('DELETE', `/api/v1/book/${legacyId}/cache`);
            expect(l.status).to.equal(200);
            expect(l.body.orchestration).to.equal(undefined);
            expect(fetchCalls.filter((u) => u.includes(`/queue/clear?book_id=${legacyId}`))).to.have.length.greaterThan(0);
        } finally {
            await query(`DELETE FROM books WHERE book_id = $1`, [legacyId]);
        }
    });

    // VOICE_REFERENCES.md: a chunk is cloned from the narrator's LOCKED reference —
    // the task carries LoadAudio(vref_<sha>.wav) and the file as a job input (by link)
    it('аудио-чанк: workflow = buildSegmentWorkflow (клон с референса), референс приходит input_files по ссылке, sha256 сходится', async () => {
        const ref = lockReference(books.get(bookId), config.OUTPUT_DIR);
        const r = await runScene('ch-1', 'sc-1');
        expect(r.status).to.equal(200);
        const t = (await worker.claim()).body.task;
        const generation = require('../src/audio/generation');
        const s = require('../src/book').collectScenes(books.get(bookId)).find((x) => x.scene_id === 'sc-1');
        const seg = require('../src/audio/segments').buildSegments(s)[0];
        const built = generation.buildSegmentWorkflow(seg, s, books.get(bookId), host.voiceRefs());
        expect(JSON.stringify(t.params)).to.equal(JSON.stringify(built.workflow));
        expect(t.params['90'].inputs.audio).to.equal(ref.name);
        expect(Object.values(t.params).map((n) => n.class_type)).to.not.include('Qwen3TTSVoiceDesign');
        expect(t.input_files.map((f) => [f.name, f.sha256])).to.deep.equal([[ref.name, ref.sha256]]);
        const got = await origFetch(t.input_files[0].url, { headers: { authorization: `Bearer ${t.upload_token}` } });
        expect(got.status).to.equal(200);
        expect(crypto.createHash('sha256').update(Buffer.from(await got.arrayBuffer())).digest('hex')).to.equal(ref.sha256);
    });

    it('нет закреплённого референса / sha256 не совпал → 409 voice_reference_required, работ нет (без фолбэка)', async () => {
        delete voiceOf(books.get(bookId), 'narrator').reference;
        const r1 = await runScene('ch-1', 'sc-1');
        expect(r1.status).to.equal(409);
        expect(r1.body).to.include({ code: 'voice_reference_required' });
        expect(r1.body.character_ids).to.deep.equal(['narrator']);
        expect(r1.body.reasons).to.deep.equal({ narrator: 'missing' });
        const ref = lockReference(books.get(bookId), config.OUTPUT_DIR);
        fs.appendFileSync(ref.path, Buffer.from([0, 0]));          // the file changed after locking
        const r2 = await runScene('ch-1', 'sc-1');
        expect(r2.status).to.equal(409);
        expect(r2.body.reasons).to.deep.equal({ narrator: 'sha_mismatch' });
        expect(await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1`, [bookId])).to.equal(0);
    });

    // ── VOICE_REFERENCES.md: candidates → worker → strict check → lock ──
    function candidateWav(meta) {
        const base = toneWav(9);
        const text = Buffer.concat([Buffer.from(JSON.stringify(meta), 'utf8'), Buffer.from([0])]);
        const t2 = text.length % 2 ? Buffer.concat([text, Buffer.from([0])]) : text;
        const icmt = Buffer.concat([Buffer.from('ICMT'), Buffer.from(Uint32Array.of(t2.length).buffer), t2]);
        const body = Buffer.concat([Buffer.from('INFO'), icmt]);
        const list = Buffer.concat([Buffer.from('LIST'), Buffer.from(Uint32Array.of(body.length).buffer), body]);
        const out = Buffer.concat([base, list]);
        out.writeUInt32LE(out.length - 8, 4);
        return out;
    }

    it('референсы голоса: кандидаты по явной команде → воркер → строгая сверка → закрепление; «Очистить кэш» не трогает voices/', async () => {
        const b = books.get(bookId);
        b.book = { language: 'ru' };
        b.heroes.push({ schema: 'animastor.character/1', id: 'anna', voice: { timbre: 'Warm female voice.', manner: 'Teasing.', timbre_source: 'user' } });
        const phrase = require('../ai/voice-reference-phrases.json').ru.conversational.text;

        expect((await api('POST', `/api/v1/book/${bookId}/voices/references/candidates`, { character_ids: ['anna'] })).body.code).to.equal('no_user_action');
        expect((await api('POST', `/api/v1/book/${bookId}/voices/references/candidates`, { character_ids: ['narrator'], client_action: { action_id: 'x0' } })).body.code).to.equal('reference_locked');
        const c = await api('POST', `/api/v1/book/${bookId}/voices/references/candidates`, { character_ids: ['anna'], count: 2, client_action: { action_id: 'v1' } });
        expect(c.status).to.equal(200);
        expect(c.body.summary.jobs_created).to.equal(2);

        let list = (await api('GET', `/api/v1/book/${bookId}/voices/references`)).body;
        const anna = () => list.voices.find((v) => v.id === 'anna');
        expect(anna().reference_status).to.equal('missing');
        expect(anna().design_description).to.equal('Warm female voice.');      // a character: timbre only
        expect(anna().candidates.map((x) => x.status)).to.deep.equal(['pending', 'pending']);
        expect(anna().phrase.text).to.equal(phrase);

        const t1 = (await worker.claim()).body.task;
        const t2 = (await worker.claim()).body.task;
        for (const t of [t1, t2]) {
            expect(t.kind).to.equal('voice_reference');
            expect(t.params['1009'].class_type).to.equal('SaveAudioAnimastorReference');
            expect(t.params['71'].inputs).to.include({ text: phrase, voice_instruction: 'Warm female voice.', language: 'Russian' });
        }
        expect(t1.params['71'].inputs.seed).to.not.equal(t2.params['71'].inputs.seed);
        // case / punctuation / ё differ → still equal after normalisation; one changed word → failed
        const ok = phrase.toUpperCase().replace(/[.,]/g, '').replace(/е/g, 'ё');
        const bad = phrase.replace('окна', 'двери');
        expect((await worker.put(t1, candidateWav({ asr_transcript: ok, verification_model: 'faster-whisper-small', words: [{ w: 'x', start: 0, end: 0.2, p: 0.9 }] }))).status).to.equal(200);
        expect((await worker.put(t2, candidateWav({ asr_transcript: bad, verification_model: 'faster-whisper-small' }))).status).to.equal(200);

        list = (await api('GET', `/api/v1/book/${bookId}/voices/references`)).body;
        const byJob = (t) => anna().candidates.find((x) => x.candidate_id === t.unit_key);
        const good = byJob(t1); const failed = byJob(t2);
        expect(good).to.include({ status: 'ready', verification: 'passed', source: 'designed', duration_sec: 9, comparison_policy_version: 1, verification_model: 'faster-whisper-small', asr_transcript: ok });
        expect(good.phrase_id).to.equal('ru-conversational-1');
        expect(failed.verification).to.equal('failed');
        expect(failed.verification_problems).to.include('transcript_mismatch');
        // stored canonical: LIST cut, sha256 = the stored bytes
        const stored = fs.readFileSync(path.join(config.OUTPUT_DIR, buildId, 'voices', 'anna', `${t1.unit_key}.wav`));
        const vr = require('../src/audio/voice-references');
        expect(vr.parseWavMeta(stored)).to.equal(null);
        expect(vr.sha256(stored)).to.equal(good.sha256);
        const audio = await origFetch(`${base}/api/v1/book/${bookId}/voices/anna/references/candidates/${t1.unit_key}/audio`);
        expect(audio.headers.get('content-type')).to.equal('audio/wav');

        expect((await api('POST', `/api/v1/book/${bookId}/voices/anna/reference`, { candidate_id: t2.unit_key })).body.code).to.equal('candidate_not_verified');
        const lock = await api('POST', `/api/v1/book/${bookId}/voices/anna/reference`, { candidate_id: t1.unit_key });
        expect(lock.status).to.equal(200);
        expect(voiceOf(b, 'anna').reference).to.include({ file: `voices/anna/${t1.unit_key}.wav`, ref_text: phrase, source: 'designed', sha256: good.sha256, verification: 'passed', locked: true });
        expect(voiceOf(b, 'anna').reference.seed).to.equal(t1.params['71'].inputs.seed);
        expect((await api('DELETE', `/api/v1/book/${bookId}/voices/anna/references/candidates/${t1.unit_key}`)).body.code).to.equal('candidate_locked');
        expect((await api('DELETE', `/api/v1/book/${bookId}/voices/anna/references/candidates/${t2.unit_key}`)).status).to.equal(200);

        // В3: cache clear keeps voices/
        fs.writeFileSync(path.join(config.OUTPUT_DIR, buildId, 'generated.mp3'), 'x');
        await api('DELETE', `/api/v1/book/${bookId}/cache`);
        expect(fs.existsSync(path.join(config.OUTPUT_DIR, buildId, 'voices', 'anna', `${t1.unit_key}.wav`))).to.equal(true);

        expect((await api('DELETE', `/api/v1/book/${bookId}/voices/anna/reference`)).status).to.equal(200);
        expect(voiceOf(b, 'anna')).to.not.have.property('reference');
    });
});
