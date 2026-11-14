// ======================================================
// Orchestration v2 (stage 2a) — IMAGES: backend integration with a fake image worker
// ======================================================
// Real: PG (animastor-test), the gen core (>= 1.1.0), orchestration-v2 host +
// audio/image ports + routes, the book routes (regenerate, cancel-*, layer-config,
// progress-panel), the player read routes (iu-image, preview, scene storyboard,
// scene image, scene status, assets-state) and the storyboard export.
// Faked: the book on disk (vbook loadBook), layer-config, the GPU worker (HTTP
// client PUTting generated PNGs). The legacy image path is exercised only to
// compare the payload byte-for-byte (provider.generate stubbed).

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const http = require('http');
const express = require('express');

const { query, getPool } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const config = require('../src/config/runtime-config');
const gen = require('@animastor/orchestration').gen;
const { createOrchV2Host } = require('../src/orchestration-v2');
const { createV2Routes } = require('../src/orchestration-v2/routes');
const bookFlag = require('../src/orchestration-v2/book-flag');
const { createMockRedis } = require('./mocks/redis-mock');
const { lockReference } = require('./helpers/voice-reference-fixture');

const HUB_KEY = 'test-hub-key-orch-v2-img';
const SECRET = 'orch-v2-image-test-upload-secret-0123456789';
const stamp = `ov2i${Date.now().toString(36)}`;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const HAS_CORE_11 = !!(gen.media && typeof gen.media.inspectPng === 'function');

// ── PNG fixtures (8-bit RGB, filter 0) ──────────────────────────────────
const CRC_T = (() => { const t = []; for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_T[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
function png(w, h, pixel) {
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
        const [r, g, b] = pixel(x, y); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function picture(seed = 1, w = 480, h = 640) {
    let s = seed >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s >>> 24; };
    return png(w, h, () => [rnd(), rnd(), rnd()]);
}
const BLACK = png(64, 64, () => [0, 0, 0]);

const IU = { a: 'iu-0a0a0a0a', b: 'iu-0b0b0b0b', c: 'iu-0c0c0c0c', d: 'iu-0d0d0d0d' };

function bookJson(bookId, buildId) {
    const long = (n) => `Сцена ${n}: достаточно длинный текст повествования, чтобы обойтись без режима добивки коротких фраз.`;
    return {
        manifest: { book_id: bookId, build_id: buildId },
        heroes: [{ schema: 'animastor.character/1', id: 'narrator', role: 'narrator', voice: { timbre: 'calm male narrator', manner: '' } }],
        chapters: [
            { chapter_id: 'ch-1', chapter_title: 'Первая', scenes: [
                { scene_id: 'sc-1', type: 'narration', audio: { full_text: long(1) },
                    units: [
                        { id: IU.a, text: 'Рыжая лиса бежит по снегу.', image: { prompt: 'a red fox running through snow, dawn light' } },
                        { id: IU.b, text: 'Лиса остановилась у реки.', image: { prompt: 'a red fox at a frozen river' } },
                    ] },
                { scene_id: 'sc-2', type: 'dialogue', audio: { full_text: long(2) },
                    dialogue_blocks: [{ units: [{ id: IU.c, text: '— Кто здесь? — спросил лесник.', image: { prompt: 'a forester in a dark forest, lantern' } }] }] },
            ] },
            { chapter_id: 'ch-2', chapter_title: 'Вторая', scenes: [
                { scene_id: 'sc-3', type: 'narration', audio: { full_text: long(3) },
                    units: [{ id: IU.d, text: 'Утро в деревне.', image: { prompt: 'a village morning, smoke from chimneys' } }] },
            ] },
        ],
    };
}

describe('orchestration v2 — images (2a): fake image worker over HTTP + player read routes', function () {
    this.timeout(60000);
    let server; let base; let app; let host; let routes; let redis;
    let userId; let workspaceId; let workerId; let audioWorkerId; let bookId; let buildId;
    let imageVersioned = false;
    const books = new Map();
    const fetchCalls = [];
    const origFetch = global.fetch;

    const vbook = {
        loadBook: (id) => books.get(id) || null,
        collectScenes: (b) => require('../src/book').collectScenes(b),
    };
    const layerCfg = { audio_enabled: true, image_enabled: true, video_enabled: true };
    const layerConfig = { get: async () => ({ ...layerCfg }), set: async (_r, _b, v) => { for (const [k, x] of Object.entries(v)) if (x !== undefined) layerCfg[k] = x; return { ...layerCfg }; } };

    function makeHost() {
        return createOrchV2Host({
            env: { ORCH_V2_ENABLED: '1', ORCH_V2_UPLOAD_SECRET: SECRET, ORCH_V2_PUBLIC_URL: base },
            hasFfmpeg: () => true,
            getPool, redis, layerConfig, book: vbook, outputDir: config.OUTPUT_DIR,
            gpuDispatcher: require('../src/runtime/gpu-dispatcher'),
            publishProgress: async () => {},
            imageVersioned: () => imageVersioned,
            timers: false, log: () => {},
        });
    }

    function mountRoutes(a, r) {
        const deps = {
            utils: { log: () => {} }, orchV2: r, layerConfig, book: vbook, config,
            runtime: {}, state: {}, activeScenes: {}, iuRepo: {},
        };
        require('../src/routes/book/generation-routes.cjs')(a, redis, deps);
        require('../src/routes/book/progress-panel.cjs')(a, redis, deps);
        require('../src/routes/book/export-routes.cjs')(a, redis, { config, book: vbook, audio: {}, utils: { log: () => {} } });
        require('@animastor/player').createPlayerRoutes(a, redis, {
            state: require('../src/state'), image: require('../src/image'), utils: { log: () => {} },
            getChunk: async () => null, getAllChunks: async () => [], getBookWindowStatus: async () => ({}),
            activeScenes: {}, placeholderAudio: {}, layerConfig,
            iuRepo: require('../src/storage/postgres/repositories/iu-repo'),
            sceneAssetsRepo: require('../src/storage/postgres/repositories/scene-assets-repo'),
            playerModel: { loadBook: vbook.loadBook },
            isBookRegistered: async () => false,                 // reads only: no storyboard self-heal writes
            outputRoot: config.OUTPUT_DIR, playerPorts: {},
            computeIuReady: require('../src/routes/book/iu-progress-utils.cjs').computeIuReady,
            bookProjections: { findSceneRuntimeData: require('../src/book').findSceneRuntimeData, collectSceneUnits: require('../src/book').collectSceneUnits },
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
        mountRoutes(app, routes);
        server.removeAllListeners('request');
        server.on('request', app);
    }

    const api = async (method, url, body, headers = {}) => {
        const r = await origFetch(`${base}${url}`, {
            method, headers: { 'content-type': 'application/json', ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const buf = Buffer.from(await r.arrayBuffer());
        let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch (_) { /* binary */ }
        return { status: r.status, body: json, buf, type: r.headers.get('content-type') };
    };
    const workerOf = (id, type) => ({
        claim: () => api('POST', '/internal/gen/claim', { worker_id: id, worker_type: type }, { 'x-api-key': HUB_KEY }),
        beacon: (current) => api('POST', '/internal/gen/beacon', { worker_id: id, current_job_id: current || null }, { 'x-api-key': HUB_KEY }),
    });
    const worker = workerOf(null, 'image');
    const put = async (task, buf) => {
        const r = await origFetch(task.upload_url, { method: 'PUT', headers: { authorization: `Bearer ${task.upload_token}`, 'content-type': 'image/png' }, body: buf });
        return { status: r.status, body: await r.json() };
    };
    const regenerate = (body) => api('POST', `/api/v1/book/${bookId}/regenerate`, { worker_types: ['image'], ...body });
    const runScene = (ch, sc, extra = {}) => regenerate({ scope: 'current_scene', chapter_id: ch, scene_id: sc, ...extra });
    const orch = () => host.orch();
    const count = async (sql, params) => Number((await query(sql, params)).rows[0].n);
    const imageAsset = async (sc) => (await query(`SELECT * FROM scene_assets WHERE book_id = $1 AND scene_id = $2 AND asset_type = 'image' AND build_id = $3`, [bookId, sc, buildId])).rows[0];
    const iuFile = (ch, sc, iu) => path.join(config.OUTPUT_DIR, buildId, `${bookId}_${ch}_${sc}_${iu}.png`);
    const previewFile = (ch, sc, iu) => path.join(config.OUTPUT_DIR, buildId, `${bookId}_${ch}_${sc}_pr${iu.replace(/^iu/, '')}.png`);
    const drain = async (pics = new Map()) => {
        let n = 0;
        for (;;) {
            const t = (await worker.claim()).body.task;
            if (!t) return n;
            const buf = pics.get(t.unit_key) || picture(n + 11);
            expect((await put(t, buf)).status).to.equal(200);
            n += 1;
        }
    };

    before(async () => {
        if (!HAS_CORE_11) throw new Error('needs @animastor/orchestration >= 1.1.0 in backend/node_modules (publish 1.1.0 + bump the backend dependency)');
        await runMigrations();
        await gen.migrate(getPool());
        const wf = require('animastor-comfyui-workflow-connector').workflowLoader;
        wf.configure({ workflowsDir: path.join(__dirname, '../ai/workflows'), connectorsDir: path.join(__dirname, '../ai/connectors') });
        wf.loadWorkflows();
        userId = (await query(`INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING user_id`, [`u-${stamp}`])).rows[0].user_id;
        workspaceId = (await query(`INSERT INTO workspaces (name, type, owner_user_id) VALUES ($1, 'personal', $2) RETURNING id`, [`w-${stamp}`, userId])).rows[0].id;
        const mk = async (type) => (await query(`INSERT INTO workers (workspace_id, name, worker_type, mode, token_hash, created_by, last_seen)
                                 VALUES ($1, $2, $3, 'private', $4, $5, floor(extract(epoch from now()))::bigint) RETURNING worker_id`,
        [workspaceId, `fake-${type}`, type, `th-${stamp}-${type}`, userId])).rows[0].worker_id;
        workerId = await mk('image');
        audioWorkerId = await mk('audio');
        Object.assign(worker, workerOf(workerId, 'image'));
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
        await query(`UPDATE workers SET last_seen = floor(extract(epoch from now()))::bigint, current_job_id = NULL WHERE worker_id = ANY($1)`, [[workerId, audioWorkerId]]);
        imageVersioned = false;
        Object.assign(layerCfg, { audio_enabled: true, image_enabled: true, video_enabled: true });
        host = makeHost();
        await host.start();
        await wireApp();
        fetchCalls.length = 0;
    });

    afterEach(async () => {
        await host.stop();
        await gen.purgeBook(getPool(), bookId);
        await query(`DELETE FROM scene_assets WHERE book_id = $1`, [bookId]);
        await query(`DELETE FROM image_units WHERE book_id = $1`, [bookId]);
        await query(`DELETE FROM books WHERE book_id = $1`, [bookId]);
        fs.rmSync(path.join(config.OUTPUT_DIR, buildId), { recursive: true, force: true });
    });

    after(async () => {
        global.fetch = origFetch;
        if (server) await new Promise((r) => server.close(r));
        if (workerId) await query(`DELETE FROM workers WHERE worker_id = ANY($1)`, [[workerId, audioWorkerId]]);
        if (workspaceId) await query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
        if (userId) await query(`DELETE FROM users WHERE user_id = $1`, [userId]);
    });

    it('«картинки» сцены: claim (тип image) → PUT PNG → gen_parts → сцена ready; все эндпоинты чтения отдают картинку; превью инвалидируется', async () => {
        const r = await runScene('ch-1', 'sc-1', { client_action: { kind: 'user_click', action_id: 'img-1' } });
        expect(r.status).to.equal(200);
        expect(r.body).to.include({ orchestration: 'v2' });
        expect(r.body.summary).to.deep.equal({ jobs_created: 2, joined: 0, skipped_ready: 0 });
        expect(r.body.tasks).to.deep.equal([{ task_id: r.body.command_id, type: 'image', target_count: 2 }]);
        expect((await workerOf(audioWorkerId, 'audio').claim()).body.task).to.equal(null, 'an audio node never gets image work');

        const t1 = (await worker.claim()).body.task;
        expect(t1).to.include({ kind: 'iu_image', job_type: 'image', protocol_version: 3, scene_id: 'sc-1', unit_key: IU.a, attempt: 1 });
        expect(t1.params['108'].inputs.text).to.be.a('string').and.match(/fox/);
        expect(t1.params['109'].inputs.text).to.be.a('string').and.not.equal('');
        let panel = await api('GET', `/api/v1/book/${bookId}/progress-panel`);
        expect(panel.body.tasks).to.have.length(1);
        expect(panel.body.tasks[0]).to.include({ type: 'image', total: 2, ready: 0, done: false, scope: 'current_scene' });

        // a stale thumbnail from an earlier generation is on disk
        fs.mkdirSync(path.dirname(previewFile('ch-1', 'sc-1', IU.a)), { recursive: true });
        fs.writeFileSync(previewFile('ch-1', 'sc-1', IU.a), BLACK);
        const pa = picture(1); const pb = picture(2);
        expect((await put(t1, pa)).status).to.equal(200);
        expect(fs.existsSync(previewFile('ch-1', 'sc-1', IU.a))).to.equal(false, 'stale preview dropped at acceptance');
        let asset = await imageAsset('sc-1');
        expect(asset.status).to.equal('pending');
        const t2 = (await worker.claim()).body.task;
        expect(t2.unit_key).to.equal(IU.b);
        expect((await put(t2, pb)).status).to.equal(200);

        asset = await imageAsset('sc-1');
        expect(asset.status).to.equal('ready');
        expect(asset.job_id).to.equal(t2.job_id);
        expect(asset.format).to.equal('png');
        expect(asset.path).to.equal(iuFile('ch-1', 'sc-1', IU.a));
        expect(asset.sha256).to.equal(sha(`${IU.a}:${sha(pa)}\n${IU.b}:${sha(pb)}`));
        expect(Object.keys(asset.metadata.gen_parts)).to.have.members([IU.a, IU.b]);
        expect(asset.metadata.gen_parts[IU.b]).to.include({ sha256: sha(pb), kind: 'iu_image', path: iuFile('ch-1', 'sc-1', IU.b) });
        expect(asset.metadata.gen_parts[IU.b].part_hash).to.match(/^iu-v2:[0-9a-f]{32}$/);

        // ── the read endpoints of web / Android (разведка §4) ──
        const q = `?build_id=${buildId}`;
        let g = await api('GET', `/api/v1/iu-image/${bookId}/ch-1/sc-1/${IU.a}${q}`);
        expect(g.status).to.equal(200); expect(sha(g.buf)).to.equal(sha(pa)); expect(g.type).to.match(/image\/png/);
        g = await api('GET', `/api/v1/iu-image/${bookId}/ch-1/sc-1/${IU.b}${q}`);
        expect(sha(g.buf)).to.equal(sha(pb));
        g = await api('GET', `/api/v1/preview/${bookId}/ch-1/sc-1/${IU.a}${q}`);
        expect(g.status).to.equal(200);
        const meta = await require('sharp')(g.buf).metadata();
        expect(meta.width).to.equal(240, 'preview rebuilt from the NEW picture (240 px)');
        g = await api('GET', `/api/v1/scene/${bookId}/ch-1/sc-1/storyboard${q}`);
        expect(g.status).to.equal(200);
        expect(g.body.ius.map((x) => x.unit_id)).to.deep.equal([IU.a, IU.b]);
        g = await api('GET', `/api/v1/scene/${bookId}/ch-1/sc-1/image${q}`);
        expect(g.status).to.equal(200); expect(g.type).to.match(/image\/png/);
        g = await api('GET', `/api/v1/scene/${bookId}/ch-1/sc-1/status${q}`);
        expect(g.body.image_ready).to.equal(true);
        g = await api('GET', `/api/v1/book/${bookId}/storyboard`);
        expect(g.status).to.equal(200);
        const AdmZip = require('adm-zip');
        const names = new AdmZip(g.buf).getEntries().map((e) => e.entryName);
        expect(names).to.include.members([`${bookId}_ch-1_sc-1_${IU.a}.png`, `${bookId}_ch-1_sc-1_${IU.b}.png`]);
        g = await api('GET', `/api/v1/book/${bookId}/assets-state`);
        expect(g.status).to.equal(200);                          // counters from legacy Redis chunks (none for v2) — see the 2a report

        await orch().sweepOnce();
        panel = await api('GET', `/api/v1/book/${bookId}/progress-panel`);
        expect(panel.body.tasks[0]).to.include({ type: 'image', done: true, percent: 100, status: 'completed', total: 2, ready: 2 });
        expect(fetchCalls.filter((u) => !u.startsWith(base))).to.deep.equal([], 'no hub / legacy calls');
    });

    it('payload IU = workflow старого пути (тот же buildIUWorkflow), байт-в-байт, детерминированный seed', async () => {
        const provider = require('@animastor/generation').comfyuiProvider;
        const sent = [];
        const origGenerate = provider.generate;
        provider.generate = async (req) => { sent.push(req); return { sent: true }; };
        try {
            const iu = require('../src/image/iu-processor');
            const s = require('../src/book').collectScenes(books.get(bookId)).find((x) => x.scene_id === 'sc-1');
            await iu.generateSceneIUImages(createMockRedis(), s, books.get(bookId), buildId, bookId, new Set(), 'disp-1');
        } finally { provider.generate = origGenerate; }
        expect(sent.map((x) => x.jobType)).to.deep.equal(['image', 'image']);
        await runScene('ch-1', 'sc-1');
        const tasks = [(await worker.claim()).body.task, (await worker.claim()).body.task];
        for (let i = 0; i < 2; i += 1) expect(JSON.stringify(tasks[i].params)).to.equal(JSON.stringify(sent[i].workflow));
        const seedNode = Object.values(tasks[0].params).find((n) => n && n.inputs && n.inputs.seed !== undefined);
        expect(seedNode.inputs.seed).to.equal(458007174637134, 'the static seed of img-qwen-image');
        expect(sent[0].jobId).to.equal(`${bookId}_ch-1_sc-1_${IU.a}:iu_image`);
    });

    it('глава; двойной клик → та же команда; пересекающаяся → joined; без force готовое пропускается по part_hash; rebuild_all → всё заново', async () => {
        const a = await regenerate({ scope: 'current_chapter', chapter_id: 'ch-1', client_action: { kind: 'user_click', action_id: 'dbl' } });
        const b = await regenerate({ scope: 'current_chapter', chapter_id: 'ch-1', client_action: { kind: 'user_click', action_id: 'dbl' } });
        expect(a.body.summary).to.deep.equal({ jobs_created: 3, joined: 0, skipped_ready: 0 });
        expect(b.body.command_id).to.equal(a.body.command_id);
        expect(b.body.existing).to.equal(true);
        const whole = await regenerate({ scope: 'whole_book' });
        expect(whole.body.summary).to.deep.equal({ jobs_created: 1, joined: 3, skipped_ready: 0 });
        expect(await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1`, [bookId])).to.equal(4);
        expect(await drain()).to.equal(4);
        await orch().sweepOnce();
        for (const sc of ['sc-1', 'sc-2', 'sc-3']) expect((await imageAsset(sc)).status).to.equal('ready');
        expect((await regenerate({ scope: 'whole_book' })).body.summary).to.deep.equal({ jobs_created: 0, joined: 0, skipped_ready: 4 });
        // the prompt of ONE unit changes → only that IU is redone
        books.get(bookId).chapters[0].scenes[0].units[1].image.prompt = 'a red fox sleeping under a pine';
        expect((await regenerate({ scope: 'whole_book' })).body.summary).to.deep.equal({ jobs_created: 1, joined: 0, skipped_ready: 3 });
        expect((await imageAsset('sc-1')).status).to.equal('ready', 'the old set stays ready until the changed IU is accepted');
        expect(await drain()).to.equal(1);
        expect((await imageAsset('sc-1')).status).to.equal('ready');
        expect((await regenerate({ scope: 'whole_book', rebuild_all: true })).body.summary).to.deep.equal({ jobs_created: 4, joined: 0, skipped_ready: 0 });
    });

    it('Стоп посередине (cancel-generation): beacon отдаёт cancel, поздний PUT → 409, сцена не ready, хаб не вызывается', async () => {
        await regenerate({ scope: 'whole_book' });
        const t1 = (await worker.claim()).body.task;
        const t2 = (await worker.claim()).body.task;
        expect((await put(t1, picture(1))).status).to.equal(200);
        expect((await api('POST', `/api/v1/book/${bookId}/cancel-generation`, {})).status).to.equal(200);
        expect(await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1 AND status IN ('queued','running')`, [bookId])).to.equal(0);
        expect((await worker.beacon(t2.job_id)).body.cancel).to.include(t2.job_id);
        const late = await put(t2, picture(2));
        expect(late.status).to.equal(409);
        expect(fs.existsSync(iuFile(t2.chapter_id, t2.scene_id, t2.unit_key))).to.equal(false, 'the late file is discarded');
        expect((await imageAsset('sc-1')).status).to.equal('pending');
        expect(fetchCalls.filter((u) => u.includes('/queue/clear'))).to.deep.equal([]);
        await orch().sweepOnce();
        const panel = await api('GET', `/api/v1/book/${bookId}/progress-panel`);
        expect(panel.body.tasks[0]).to.include({ type: 'image', cancelled: true });
    });

    it('рестарт backend посередине: загрузка прежнего процесса принимается, новых работ нет, всё доходит до ready', async () => {
        await regenerate({ scope: 'whole_book' });
        const t1 = (await worker.claim()).body.task;
        const before = await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1`, [bookId]);
        await host.stop();
        host = makeHost();
        await host.start();
        await wireApp();
        await orch().sweepOnce();
        expect(await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1`, [bookId])).to.equal(before);
        expect((await put(t1, picture(1))).status).to.equal(200);
        expect(await drain()).to.equal(3);
        await orch().sweepOnce();
        expect(await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1`, [bookId])).to.equal(4, 'no duplicates');
        expect(await count(`SELECT count(*) AS n FROM scene_assets WHERE book_id = $1 AND asset_type = 'image' AND status = 'ready'`, [bookId])).to.equal(3);
        expect(await count(`SELECT count(*) AS n FROM gen_commands WHERE book_id = $1 AND status = 'done'`, [bookId])).to.equal(1);
    });

    it('нода пропала (нет beacon 60 с) → worker_offline → attempt 2 без дублей; пустой кадр → invalid_result ×1, затем failed', async () => {
        await runScene('ch-2', 'sc-3');
        const t1 = (await worker.claim()).body.task;
        await query(`UPDATE workers SET last_seen = floor(extract(epoch from now()))::bigint - 61 WHERE worker_id = $1`, [workerId]);
        expect((await orch().sweepOnce()).offline).to.equal(1);
        expect((await query(`SELECT status, error_class FROM gen_jobs WHERE job_id = $1`, [t1.job_id])).rows[0]).to.deep.equal({ status: 'queued', error_class: 'worker_offline' });
        await query(`UPDATE gen_jobs SET not_before = now() WHERE job_id = $1`, [t1.job_id]);
        await worker.beacon(null);
        const t2 = (await worker.claim()).body.task;
        expect(t2.job_id).to.equal(t1.job_id); expect(t2.attempt).to.equal(2);
        expect((await put(t1, picture(1))).status).to.equal(409, 'the first attempt is stale');
        let r = await put(t2, BLACK);
        expect(r.status).to.equal(422); expect(r.body).to.include({ code: 'invalid_result', reason: 'blank_frame', job_status: 'queued' });
        await query(`UPDATE gen_jobs SET not_before = now() WHERE job_id = $1`, [t1.job_id]);
        const t3 = (await worker.claim()).body.task;
        r = await put(t3, BLACK);
        expect(r.body.job_status).to.equal('failed');
        expect(await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1`, [bookId])).to.equal(1, 'one job, three attempts');
        expect(await imageAsset('sc-3')).to.equal(undefined);
        await orch().sweepOnce();
        const panel = await api('GET', `/api/v1/book/${bookId}/progress-panel`);
        expect(panel.body.tasks[0]).to.include({ failed: true, done: false });
    });

    it('video (этап 3): [image, video] без аудио → только IU, видео skipped_needs_audio; [video] → 200 без работ; аудио + картинки одной сцены параллельно', async () => {
        const r = await runScene('ch-1', 'sc-1', { worker_types: ['image', 'video'] });
        expect(r.status).to.equal(200);
        expect(r.body.summary).to.deep.equal({ jobs_created: 2, joined: 0, skipped_ready: 0, skipped_needs_audio: ['sc-1'] });
        expect(r.body.skipped_worker_types).to.deep.equal([]);
        expect((await query(`SELECT layers FROM gen_commands WHERE command_id = $1`, [r.body.command_id])).rows[0].layers).to.deep.equal(['image', 'video']);
        const v = await runScene('ch-1', 'sc-1', { worker_types: ['video'] });
        expect(v.status).to.equal(200);
        expect(v.body.summary).to.include({ jobs_created: 0 });
        expect(v.body.summary.skipped_needs_audio).to.deep.equal(['sc-1']);
        expect(await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1 AND layer = 'video'`, [bookId])).to.equal(0);

        await api('POST', `/api/v1/book/${bookId}/cancel-generation`, {});      // drop the sc-1 images queued above
        const both = await runScene('ch-2', 'sc-3', { worker_types: ['audio', 'image'] });
        expect(both.body.tasks.map((t) => t.type)).to.deep.equal(['audio', 'image']);
        const ta = (await workerOf(audioWorkerId, 'audio').claim()).body.task;
        const ti = (await worker.claim()).body.task;
        expect(ta.kind).to.equal('audio_chunk'); expect(ti.kind).to.equal('iu_image');
        expect(ti.scene_id).to.equal(ta.scene_id);
        expect((await put(ti, picture(4))).status).to.equal(200);
        expect((await imageAsset('sc-3')).status).to.equal('ready');
    });

    it('layer-config: image выключен → 409 layer_disabled; выключение во время работы → отмена слоя image (аудио идёт)', async () => {
        layerCfg.image_enabled = false;
        const r = await regenerate({ scope: 'whole_book' });
        expect(r.status).to.equal(409);
        expect(r.body).to.include({ error: 'layer_disabled' });
        expect(r.body.disabled_worker_types).to.deep.equal(['image']);
        const partial = await regenerate({ scope: 'whole_book', worker_types: ['audio', 'image'] });
        expect(partial.status).to.equal(200);
        expect(partial.body.tasks.map((t) => t.type)).to.deep.equal(['audio']);
        expect(partial.body.skipped_worker_types).to.deep.equal(['image'], 'a disabled layer is reported as skipped');
        await api('POST', `/api/v1/book/${bookId}/cancel-generation`, {});
        layerCfg.image_enabled = true;
        await regenerate({ scope: 'whole_book', worker_types: ['audio', 'image'] });
        const t = (await worker.claim()).body.task;
        const put1 = await api('PUT', `/api/v1/book/${bookId}/layer-config`, { image_enabled: false });
        expect(put1.body.cancelled_stages).to.deep.equal(['image']);
        expect(await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1 AND layer = 'image' AND status IN ('queued','running')`, [bookId])).to.equal(0);
        const audioJobs = await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1 AND layer = 'audio' AND status <> 'cancelled'`, [bookId]);
        expect(audioJobs).to.be.greaterThan(0);
        expect(await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1 AND layer = 'audio' AND status = 'queued'`, [bookId])).to.equal(audioJobs, 'audio untouched');
        expect((await worker.beacon(t.job_id)).body.cancel).to.include(t.job_id);
        expect((await put(t, picture(1))).status).to.equal(409);
        // cancel-worker type=image on a fresh command
        layerCfg.image_enabled = true;
        await regenerate({ scope: 'current_chapter', chapter_id: 'ch-2' });
        const cw = await api('POST', `/api/v1/book/${bookId}/cancel-worker`, { type: 'image' });
        expect(cw.body).to.include({ ok: true, jobs_cancelled: 1 });
        const c2 = await regenerate({ scope: 'current_chapter', chapter_id: 'ch-2' });
        const byCmd = await api('POST', `/api/v1/book/${bookId}/cancel-worker`, { task_id: c2.body.command_id });
        expect(byCmd.body.cancelled).to.deep.equal(['image']);
    });

    it('IU_IMAGE_VERSIONED включён → image на v2-книге fail-closed (409 v2_image_unavailable), аудио работает; legacy-книга идёт мимо v2', async () => {
        imageVersioned = true;
        const r = await regenerate({ scope: 'whole_book', worker_types: ['image'] });
        expect(r.status).to.equal(409);
        expect(r.body.code).to.equal('v2_image_unavailable');
        expect(r.body.error).to.match(/IU_IMAGE_VERSIONED/);
        expect((await regenerate({ scope: 'whole_book', worker_types: ['audio', 'image'] })).status).to.equal(409);
        expect(await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1`, [bookId])).to.equal(0);
        expect((await regenerate({ scope: 'whole_book', worker_types: ['audio'] })).status).to.equal(200, 'audio is not affected');
        // a legacy book never reaches the v2 handler (the flag stays legacy's business)
        const legacyId = `${bookId}-legacy`;
        await query(`INSERT INTO books (book_id, title, workspace_id, user_id, orchestration) VALUES ($1, 't', $2, $3, 'legacy')`, [legacyId, workspaceId, userId]);
        const seen = [];
        const orig = routes.regenerate;
        routes.regenerate = async (req, res) => { seen.push(req.params.bookId); return orig(req, res); };
        try {
            bookFlag.invalidate();
            await api('POST', `/api/v1/book/${legacyId}/regenerate`, { worker_types: ['image'], scope: 'whole_book' });
            expect(seen).to.deep.equal([]);
            expect(await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1`, [legacyId])).to.equal(0);
        } finally {
            routes.regenerate = orig;
            await query(`DELETE FROM books WHERE book_id = $1`, [legacyId]);
        }
        imageVersioned = false;
        expect((await regenerate({ scope: 'whole_book', worker_types: ['image'] })).status).to.equal(200, 'flag off → image works again');
    });

    it('old core (< 1.1.0, no PNG check) → image fail-closed at the command', async () => {
        await host.stop();
        const fakeGen = { ...gen, media: { ...gen.media, inspectPng: undefined } };
        host = createOrchV2Host({
            env: { ORCH_V2_ENABLED: '1', ORCH_V2_UPLOAD_SECRET: SECRET, ORCH_V2_PUBLIC_URL: base },
            hasFfmpeg: () => true, gen: fakeGen,
            getPool, redis, layerConfig, book: vbook, outputDir: config.OUTPUT_DIR,
            gpuDispatcher: require('../src/runtime/gpu-dispatcher'), imageVersioned: () => false, timers: false, log: () => {},
        });
        await host.start();
        await wireApp();
        const r = await regenerate({ scope: 'whole_book' });
        expect(r.status).to.equal(409);
        expect(r.body.error).to.match(/1\.1\.0/);
    });
});
