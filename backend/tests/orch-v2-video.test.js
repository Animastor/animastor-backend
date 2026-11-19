// ======================================================
// Orchestration v2 (stage 3) — VIDEO: backend integration with fake GPU workers
// ======================================================
// Real: PG (animastor-test), the gen core (>= 1.3.0), orchestration-v2 host +
// audio/image/video ports + routes, the LTX video workflows + connectors of
// ai/, the book routes (regenerate, cancel-generation, progress-panel) and the
// player scene video route.
// Faked: the book on disk (vbook loadBook), layer-config, the GPU workers (HTTP
// clients: GET input frames by link, PUT PNG / MP3 / MP4). Without the ffmpeg
// binary (host test runs) the audio merge copies the first chunk, durations come
// from music-metadata and the video merge steps are recorded stubs; with ffmpeg
// (container run, see the stage 3 report) everything is real.
// Scenarios (ADR §6.5, §13 п.11): {audio,image,video} of an empty scene down to
// video_merge; IU timings recalculated by the v2 audio_merge (zero-width unit
// out of the video); {video} with placeholder audio → skipped_needs_audio;
// groups from REAL durations; audio regenerated with another length → new
// timings, the group is dirty; dirty / missing pictures; IUs in work (join);
// stop mid-group; restart mid-group; repeated PUT; iu-repo keeps 0; legacy video
// never touches a v2 book; core < 1.3.0 → 409 v2_video_unavailable.

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const http = require('http');
const { spawnSync } = require('child_process');
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

const FIX = path.resolve(__dirname, '../../packages/animastor-orchestration/test/gen/fixtures');
const fixture = (n) => fs.readFileSync(path.join(FIX, n));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const HAS_CORE_13 = gen.MIGRATIONS.some((m) => m.id === '004-command-skips');
const HUB_KEY = 'test-hub-key-orch-v2-video';
const SECRET = 'orch-v2-video-test-upload-secret-0123456789';
const stamp = `ov2v${Date.now().toString(36)}`;
const FPS = 24;

async function fixtureDecodePcm(filePath) {
    const h = sha(fs.readFileSync(filePath));
    for (const f of fs.readdirSync(FIX).filter((x) => x.endsWith('.mp3'))) {
        if (sha(fixture(f)) === h) { const p = fixture(f.replace(/\.mp3$/, '.s16le')); return new Int16Array(p.buffer, p.byteOffset, p.length / 2); }
    }
    throw Object.assign(new Error('no recorded decode'), { code: 'EDECODE' });
}

// ── PNG / MP4 fixtures ───────────────────────────────────────────────────
const CRC_T = (() => { const t = []; for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_T[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
function picture(seed = 1, w = 64, h = 48) {
    let s = seed >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s >>> 24; };
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w * 3; x += 1) raw[y * (w * 3 + 1) + 1 + x] = rnd();
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** A clip of `frames` frames: real H.264 with ffmpeg, else an ftyp-headed blob (the merge is stubbed then). */
function clip(frames, seed = 1) {
    if (!HAS_FFMPEG) return Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), crypto.createHash('sha512').update(`${frames}:${seed}`).digest()]);
    const out = path.join(os.tmpdir(), `ov2v-${process.pid}-${seed}-${frames}.mp4`);
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=${FPS}`, '-frames:v', String(frames),
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '18', out]);  // > MIN_VIDEO_BYTES after a trim
    if (r.status !== 0) throw new Error(`ffmpeg clip: ${r.stderr}`);
    const b = fs.readFileSync(out); fs.unlinkSync(out); return b;
}
const ffprobeFrames = (p) => Number(spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', p], { encoding: 'utf8' }).stdout.trim());
const ffprobeKeyframes = (p) => spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', p], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).map(Number);
const ffprobeStreams = (p) => spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', p], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);

const IU = { a: 'iu-0a0a0a0a', b: 'iu-0b0b0b0b', c: 'iu-0c0c0c0c', d: 'iu-0d0d0d0d', e: 'iu-0e0e0e0e' };

function bookJson(bookId, buildId, prompts = {}) {
    const unit = (id, text, prompt) => ({ id, text, image: { prompt: prompts[id] || prompt }, video: { action: `${text} — slow camera move` } });
    const a = 'Рыжая лиса бежит по снегу у самой опушки леса.';
    const b = 'Лиса остановилась у реки и долго смотрит на лёд.';
    return {
        manifest: { book_id: bookId, build_id: buildId },
        heroes: [{ schema: 'animastor.character/1', id: 'narrator', role: 'narrator', voice: { timbre: 'calm male narrator', manner: '' } }],
        chapters: [
            { chapter_id: 'ch-1', chapter_title: 'Первая', scenes: [
                // one short narration → ONE TTS chunk bound to the first unit (the BA case):
                // the second unit gets zero width and is not in the video
                { scene_id: 'sc-1', type: 'narration', audio: { full_text: `${a} ${b}` },
                    units: [unit(IU.a, a, 'a red fox running through snow'), unit(IU.b, b, 'a red fox at a frozen river')] },
                { scene_id: 'sc-2', type: 'narration', audio: { full_text: 'Сцена два: достаточно длинный текст повествования, чтобы обойтись без добивки.' },
                    units: [unit(IU.c, 'Лесник идёт по тропе с фонарём.', 'a forester with a lantern')] },
            ] },
            { chapter_id: 'ch-2', chapter_title: 'Вторая', scenes: [
                { scene_id: 'sc-3', type: 'narration', audio: { full_text: 'Сцена три: утро в деревне, дым из труб и первые голоса у колодца на площади.' },
                    units: [unit(IU.d, 'Утро в деревне, дым из труб.', 'a village morning, smoke from chimneys'),
                        unit(IU.e, 'Голоса у колодца на площади.', 'people at a village well')] },
            ] },
        ],
    };
}

describe('orchestration v2 — video (stage 3): fake workers over HTTP', function () {
    this.timeout(120000);
    let server; let base; let app; let host; let routes; let redis;
    let userId; let workspaceId; const workers = {}; let bookId; let buildId;
    const books = new Map();
    const origFetch = global.fetch;
    const mergeCalls = [];
    let coreOverride = null;

    const vbook = {
        loadBook: (id) => books.get(id) || null,
        collectScenes: (b) => require('../src/book').collectScenes(b),
        collectSceneUnits: (s) => require('../src/book').collectSceneUnits(s),
    };
    const layerCfg = { audio_enabled: true, image_enabled: true, video_enabled: true };
    const layerConfig = { get: async () => ({ ...layerCfg }), set: async () => ({ ...layerCfg }) };

    /** the real merge steps, recorded; stubs without ffmpeg */
    function videoMergeDeps() {
        const real = require('../src/video/video-merge');
        const rec = (name, fn) => async (...args) => { mergeCalls.push({ name, args }); return fn(...args); };
        const copy = async (i, o) => { fs.copyFileSync(i, o); return o; };
        return {
            resolveVideoProfileMeta: real.resolveVideoProfileMeta,
            trimVideoToFrames: rec('trim', HAS_FFMPEG ? real.trimVideoToFrames : async (p) => p),
            concatVideos: rec('concat', HAS_FFMPEG ? real.concatVideos : async (ins, out) => copy(ins[0], out)),
            forceKeyframesAtUnitBoundaries: rec('keyframes', HAS_FFMPEG ? real.forceKeyframesAtUnitBoundaries : async () => true),
            encodePlaybackProfile: rec('encode', HAS_FFMPEG ? real.encodePlaybackProfile : copy),
            faststartRemux: rec('remux', HAS_FFMPEG ? real.faststartRemux : copy),
        };
    }

    function makeHost() {
        const audioDeps = { book: vbook };
        if (!HAS_FFMPEG) {
            audioDeps.pipeline = { buildSceneAudio: async (paths, out) => { fs.copyFileSync(paths[0], out); return out; } };
            audioDeps.generation = { ...require('../src/audio/generation'), trimPaddedSceneAudio: async () => {} };
            const mmDur = async (p) => { try { return Number((await require('music-metadata').parseFile(p)).format.duration) || 0; } catch (_) { return 0; } };
            audioDeps.ffmpeg = { probeDuration: mmDur, runFFmpegTrim: async (i, o) => fs.copyFileSync(i, o) };
        }
        return createOrchV2Host({
            env: { ORCH_V2_ENABLED: '1', ORCH_V2_UPLOAD_SECRET: SECRET, ORCH_V2_PUBLIC_URL: base },
            hasFfmpeg: () => true,
            getPool, redis, layerConfig, book: vbook, outputDir: config.OUTPUT_DIR,
            gpuDispatcher: require('../src/runtime/gpu-dispatcher'),
            publishProgress: async () => {},
            imageVersioned: () => false,
            timers: false, log: () => {},
            ...(coreOverride ? { gen: coreOverride } : {}),
            portOverrides: {
                audioDeps,
                videoDeps: { videoMerge: videoMergeDeps() },
                ports: HAS_FFMPEG ? {} : { validateResult: gen.defaults.createDefaultValidateResult({ decodePcm: fixtureDecodePcm }) },
            },
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
        const deps = { utils: { log: () => {} }, orchV2: routes, layerConfig, book: vbook, config, runtime: {}, state: {}, activeScenes: {}, iuRepo: {} };
        require('../src/routes/book/generation-routes.cjs')(app, redis, deps);
        require('../src/routes/book/progress-panel.cjs')(app, redis, deps);
        require('@animastor/player').createPlayerRoutes(app, redis, {
            state: require('../src/state'), image: require('../src/image'), utils: { log: () => {} },
            getChunk: async () => null, getAllChunks: async () => [], getBookWindowStatus: async () => ({}),
            activeScenes: {}, placeholderAudio: {}, layerConfig,
            iuRepo: require('../src/storage/postgres/repositories/iu-repo'),
            sceneAssetsRepo: require('../src/storage/postgres/repositories/scene-assets-repo'),
            playerModel: { loadBook: vbook.loadBook }, isBookRegistered: async () => false,
            outputRoot: config.OUTPUT_DIR, playerPorts: {},
            computeIuReady: require('../src/routes/book/iu-progress-utils.cjs').computeIuReady,
            bookProjections: { findSceneRuntimeData: require('../src/book').findSceneRuntimeData, collectSceneUnits: require('../src/book').collectSceneUnits },
        });
        server.removeAllListeners('request');
        server.on('request', app);
    }

    const api = async (method, url, body, headers = {}) => {
        const r = await origFetch(url.startsWith('http') ? url : `${base}${url}`, {
            method, headers: { 'content-type': 'application/json', ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const buf = Buffer.from(await r.arrayBuffer());
        let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch (_) { /* binary */ }
        return { status: r.status, body: json, buf, type: r.headers.get('content-type') };
    };
    const claim = async (type) => (await api('POST', '/internal/gen/claim', { worker_id: workers[type], worker_type: type }, { 'x-api-key': HUB_KEY })).body.task;
    const beacon = (type, current) => api('POST', '/internal/gen/beacon', { worker_id: workers[type], current_job_id: current || null }, { 'x-api-key': HUB_KEY });
    const put = async (task, buf) => {
        const r = await origFetch(task.upload_url, { method: 'PUT', headers: { authorization: `Bearer ${task.upload_token}` }, body: buf });
        return { status: r.status, body: await r.json() };
    };
    const fetchInput = (task, f, token = task.upload_token) => api('GET', f.url, undefined, token ? { authorization: `Bearer ${token}` } : {});
    const regenerate = (body) => api('POST', `/api/v1/book/${bookId}/regenerate`, body);
    const scene = (ch, sc, types, extra = {}) => regenerate({ worker_types: types, scope: 'current_scene', chapter_id: ch, scene_id: sc, ...extra });
    const orch = () => host.orch();
    const count = async (sql, params) => Number((await query(sql, params)).rows[0].n);
    const asset = async (sc, type) => (await query(`SELECT * FROM scene_assets WHERE book_id = $1 AND scene_id = $2 AND asset_type = $3 AND build_id = $4`, [bookId, sc, type, buildId])).rows[0];
    const ius = async (sc) => (await query(`SELECT unit_id, start_ms, end_ms, estimated_duration_sec, scene_duration_sec FROM image_units WHERE book_id = $1 AND scene_id = $2 AND build_id = $3 ORDER BY scene_order`, [bookId, sc, buildId])).rows;
    const jobs = async (kind) => (await query(`SELECT * FROM gen_jobs WHERE book_id = $1 AND kind = $2 ORDER BY created_at`, [bookId, kind])).rows;
    async function drain(type, make) {
        let n = 0;
        for (;;) {
            const t = await claim(type);
            if (!t) return n;
            const r = await put(t, make(t, n));
            expect(r.status, JSON.stringify(r.body)).to.equal(200);
            n += 1;
        }
    }
    const drainImages = () => drain('image', (_t, n) => picture(n + 31));
    const drainAudio = async () => { const n = await drain('audio', () => fixture('tone.mp3')); while (await orch().runLocalOnce()) { /* merges */ } return n; };
    async function drainVideo() {
        let n = 0;
        for (;;) {
            const t = await claim('video');
            if (!t) break;
            for (const f of t.input_files) {
                const g = await fetchInput(t, f);
                expect(g.status).to.equal(200);
                expect(sha(g.buf)).to.equal(f.sha256);
            }
            const frames = t.params ? t.input_frames : null;     // eslint: unused
            void frames;
            const job = (await query(`SELECT input FROM gen_jobs WHERE job_id = $1`, [t.job_id])).rows[0];
            const raw = job.input.part_meta.frame_counts.reduce((s, x) => s + x, 0);
            const r = await put(t, clip(Math.ceil((raw - 1) / 8) * 8 + 1, n + 1));
            expect(r.status, JSON.stringify(r.body)).to.equal(200);
            n += 1;
        }
        while (await orch().runLocalOnce()) { /* video_merge */ }
        return n;
    }
    /** v2 audio of a scene (real ports), then return its IU timings */
    async function audioOf(ch, sc) {
        const r = await scene(ch, sc, ['audio']);
        expect(r.status).to.equal(200);
        await drainAudio();
        return ius(sc);
    }

    before(async () => {
        if (!HAS_CORE_13) throw new Error('needs @animastor/orchestration >= 1.3.0 in backend/node_modules (publish 1.3.0 + bump the backend dependency)');
        await runMigrations();
        await gen.migrate(getPool());
        const wf = require('animastor-comfyui-workflow-connector').workflowLoader;
        wf.configure({ workflowsDir: path.join(__dirname, '../ai/workflows'), connectorsDir: path.join(__dirname, '../ai/connectors') });
        wf.loadWorkflows();
        userId = (await query(`INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING user_id`, [`u-${stamp}`])).rows[0].user_id;
        workspaceId = (await query(`INSERT INTO workspaces (name, type, owner_user_id) VALUES ($1, 'personal', $2) RETURNING id`, [`w-${stamp}`, userId])).rows[0].id;
        for (const type of ['audio', 'image', 'video']) {
            workers[type] = (await query(`INSERT INTO workers (workspace_id, name, worker_type, mode, token_hash, created_by, last_seen)
                VALUES ($1, $2, $3, 'private', $4, $5, floor(extract(epoch from now()))::bigint) RETURNING worker_id`,
            [workspaceId, `fake-${type}`, type, `th-${stamp}-${type}`, userId])).rows[0].worker_id;
        }
        redis = createMockRedis();
        server = http.createServer();
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(async () => {
        bookId = `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
        buildId = `bld-${bookId}`;
        books.set(bookId, bookJson(bookId, buildId));
        lockReference(books.get(bookId), config.OUTPUT_DIR);   // VOICE_REFERENCES: narrator reference locked
        await query(`INSERT INTO books (book_id, title, workspace_id, user_id, orchestration) VALUES ($1, 't', $2, $3, 'v2')`, [bookId, workspaceId, userId]);
        bookFlag.invalidate();
        await query(`UPDATE workers SET last_seen = floor(extract(epoch from now()))::bigint, current_job_id = NULL WHERE worker_id = ANY($1)`, [Object.values(workers)]);
        Object.assign(layerCfg, { audio_enabled: true, image_enabled: true, video_enabled: true });
        mergeCalls.length = 0;
        coreOverride = null;
        host = makeHost();
        await host.start();
        await wireApp();
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
        await query(`DELETE FROM workers WHERE worker_id = ANY($1)`, [Object.values(workers)]);
        if (workspaceId) await query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
        if (userId) await query(`DELETE FROM users WHERE user_id = $1`, [userId]);
    });

    it('{audio,image,video} пустой сцены: IU + аудио → audio_merge пересчитал тайминги (IU без своего чанка — 0) → группа по реальной длительности → кадры по ссылке → video_merge → плеер', async () => {
        const r = await scene('ch-1', 'sc-1', ['audio', 'image', 'video']);
        expect(r.status).to.equal(200);
        expect(r.body.summary).to.include({ joined: 0, skipped_ready: 0 });
        expect(r.body.summary.jobs_created).to.equal((await jobs('audio_chunk')).length + 2);
        expect(r.body.tasks.map((t) => t.type)).to.deep.equal(['audio', 'image', 'video']);
        expect(await drainImages()).to.equal(2);
        expect((await jobs('video_group')).length).to.equal(0, 'audio still in work → video waits');
        await drainAudio();

        // п.7: the v2 audio_merge wrote the timings (legacy IU-RECALC formulas): the one TTS chunk
        // is bound to the first unit, the second one has zero width and estimated 0
        const t = await ius('sc-1');
        expect(t.map((x) => x.unit_id)).to.deep.equal([IU.a, IU.b]);
        expect(Number(t[0].end_ms) - Number(t[0].start_ms)).to.be.greaterThan(1000);
        expect(Number(t[1].end_ms)).to.equal(Number(t[1].start_ms));
        expect(Number(t[1].estimated_duration_sec)).to.equal(0);

        const groups = await jobs('video_group');
        expect(groups.map((g) => g.unit_key)).to.deep.equal([`g-${IU.a}`], 'zero-duration unit is not in the video');
        const g = groups[0];
        const durMs = Number(t[0].end_ms) - Number(t[0].start_ms);
        expect(g.input.part_meta).to.deep.include({ group_index: 1, group_count: 1, unit_ids: [IU.a], durations_ms: [durMs] });
        expect(g.input.part_meta.frame_counts).to.deep.equal([Math.max(24, Math.round(durMs / 1000 * FPS))]);
        expect(g.input.workflow_name).to.equal('video-ltx-1p');

        const task = await claim('video');
        expect(task).to.include({ kind: 'video_group', job_type: 'video', protocol_version: 3, unit_key: `g-${IU.a}` });
        const provider = require('@animastor/generation').comfyuiProvider;
        const raw = g.input.part_meta.frame_counts[0];
        expect(task.params[provider.getNodeId('video-ltx-1p', 'totalFrames')].inputs).to.satisfy((inp) => Object.values(inp).includes(Math.ceil((raw - 1) / 8) * 8 + 1));
        expect(task.input_files).to.have.length(1);
        const f = task.input_files[0];
        expect(f.name).to.equal(`${bookId}_ch-1_sc-1_${IU.a}.png`);
        expect(f.url).to.match(new RegExp(`/internal/gen/jobs/${task.job_id}/input/.+\\?attempt=1$`));
        expect((await fetchInput(task, f, null)).status).to.equal(401);
        expect((await fetchInput(task, f, `${task.upload_token}x`)).status).to.equal(401);
        const got = await fetchInput(task, f);
        expect(got.status).to.equal(200); expect(got.type).to.equal('image/png');
        expect(sha(got.buf)).to.equal((await asset('sc-1', 'image')).metadata.gen_parts[IU.a].sha256);
        expect((await put(task, clip(Math.ceil((raw - 1) / 8) * 8 + 1, 7))).body).to.include({ status: 200, stage_jobs_created: 1 });
        expect(fs.existsSync(path.join(config.OUTPUT_DIR, buildId, `${bookId}_ch-1_sc-1_g1.mp4`))).to.equal(true);
        expect(await orch().runLocalOnce()).to.include({ status: 200 });

        const v = await asset('sc-1', 'video');
        expect(v).to.include({ status: 'ready', format: 'mp4' });
        expect(v.path).to.equal(path.join(config.OUTPUT_DIR, buildId, `${bookId}_ch-1_sc-1.mp4`));
        expect(v.scene_hash).to.equal(g.input.scene_hash);
        const trims = mergeCalls.filter((c) => c.name === 'trim');
        expect(trims.map((c) => c.args[1])).to.deep.equal([raw], 'group trimmed to its real frame count');
        if (HAS_FFMPEG) {
            expect(ffprobeStreams(v.path)).to.deep.equal(['video'], 'no audio track in the scene video (п.8)');
            expect(ffprobeFrames(v.path)).to.equal(raw, 'scene video = the real-duration frame count (8n+1 tax trimmed)');
        }
        const play = await api('GET', `/api/v1/scene/${bookId}/ch-1/sc-1/video`);
        expect(play.status).to.equal(200); expect(play.type).to.match(/video\/mp4/);
        await orch().sweepOnce();
        const panel = await api('GET', `/api/v1/book/${bookId}/progress-panel`);
        const row = panel.body.tasks.find((x) => x.type === 'video');
        expect(row).to.include({ done: true, status: 'completed' });
        expect(row.skipped).to.deep.equal({});
    });

    it('{video} при заглушке аудио → skipped_needs_audio (summary + progress-panel), аудио не ставится', async () => {
        const audioFile = path.join(config.OUTPUT_DIR, buildId, `${bookId}_ch-1_sc-2.mp3`);
        fs.mkdirSync(path.dirname(audioFile), { recursive: true });
        fs.writeFileSync(audioFile, fixture('silence.mp3'));
        require('../src/audio/placeholder-marker').writePlaceholderMarker(audioFile, { reason: 'test' });
        await query(`INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, path, build_id, status) VALUES ($1, 'ch-1', 'sc-2', 'audio', $2, $3, 'ready')`, [bookId, audioFile, buildId]);
        const r = await scene('ch-1', 'sc-2', ['video']);
        expect(r.status).to.equal(200);
        expect(r.body.summary).to.deep.equal({ jobs_created: 0, joined: 0, skipped_ready: 0, skipped_needs_audio: ['sc-2'] });
        expect(await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1`, [bookId])).to.equal(0);
        const panel = await api('GET', `/api/v1/book/${bookId}/progress-panel`);
        expect(panel.body.tasks.find((x) => x.type === 'video').skipped).to.deep.equal({ skipped_needs_audio: ['sc-2'] });
    });

    it('{video} при готовом аудио: группы по реальным длительностям; новая длина аудио → тайминги пересчитаны, группа грязная (missing делает новую); правка промпта → skipped_image_dirty; IU без gen_parts → skipped_needs_image', async () => {
        await scene('ch-2', 'sc-3', ['image']);
        await drainImages();
        // audio of the scene «from before» with known real timings (as legacy IU-RECALC left them)
        const audioFile = path.join(config.OUTPUT_DIR, buildId, `${bookId}_ch-2_sc-3.mp3`);
        fs.writeFileSync(audioFile, fixture('tone.mp3'));
        await query(`INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, path, build_id, status) VALUES ($1, 'ch-2', 'sc-3', 'audio', $2, $3, 'ready')`, [bookId, audioFile, buildId]);
        const iuRepo = require('../src/storage/postgres/repositories/iu-repo');
        await iuRepo.upsertImageUnit(buildId, bookId, 'ch-2', 'sc-3', IU.d, { scene_order: 0, estimated_duration_sec: 9.9, start_ms: 0, end_ms: 3000 });
        await iuRepo.upsertImageUnit(buildId, bookId, 'ch-2', 'sc-3', IU.e, { scene_order: 1, estimated_duration_sec: 9.9, start_ms: 3000, end_ms: 4500 });
        const r1 = await scene('ch-2', 'sc-3', ['video']);
        expect(r1.body.summary.jobs_created).to.equal(1);
        const [g1] = await jobs('video_group');
        expect(g1.unit_key).to.equal(`g-${IU.d}+${IU.e}`);
        expect(g1.input.part_meta.durations_ms).to.deep.equal([3000, 1500], 'real end-start, never the 9.9 s estimate');
        expect(g1.input.part_meta.frame_counts).to.deep.equal([72, 36]);
        expect(g1.input.workflow_name).to.equal('video-ltx-2p');
        await drainVideo();
        expect((await asset('sc-3', 'video')).status).to.equal('ready');
        if (HAS_FFMPEG) {
            const vp = (await asset('sc-3', 'video')).path;
            expect(ffprobeFrames(vp)).to.equal(108, '72 + 36 frames: 3.0 s + 1.5 s at 24 fps');
            const kf = ffprobeKeyframes(vp);
            expect(kf.some((t) => Math.abs(t - 3.0) <= 1 / FPS + 1e-3), `keyframe at the unit boundary 3.0 s: ${kf}`).to.equal(true);
        }
        expect((await scene('ch-2', 'sc-3', ['video'])).body.summary).to.include({ jobs_created: 0, skipped_ready: 1 });

        // audio regenerated on v2 with another length → п.7 timings → the group is dirty
        const before = await ius('sc-3');
        const after = await audioOf('ch-2', 'sc-3');
        expect(after.map((x) => [x.start_ms, x.end_ms])).to.not.deep.equal(before.map((x) => [x.start_ms, x.end_ms]));
        expect((await jobs('video_group')).length).to.equal(1, 'new audio does not start video by itself');
        const r2 = await scene('ch-2', 'sc-3', ['video']);
        expect(r2.body.summary.jobs_created).to.be.greaterThan(0);
        const g2 = (await jobs('video_group')).slice(1);
        expect(g2[0].input.part_hash).to.not.equal(g1.input.part_hash);
        expect(g2[0].input.scene_hash).to.not.equal(g1.input.scene_hash);
        await api('POST', `/api/v1/book/${bookId}/cancel-generation`, {});

        // prompt of one IU edited after its picture → dirty; a picture without gen_parts → needs_image
        books.set(bookId, bookJson(bookId, buildId, { [IU.d]: 'a village at night, lanterns' }));
        lockReference(books.get(bookId), config.OUTPUT_DIR);   // VOICE_REFERENCES: narrator reference locked
        const r3 = await scene('ch-2', 'sc-3', ['video']);
        expect(r3.body.summary).to.include({ jobs_created: 0 });
        expect(r3.body.summary.skipped_image_dirty).to.deep.equal(['sc-3']);
        books.set(bookId, bookJson(bookId, buildId));
        lockReference(books.get(bookId), config.OUTPUT_DIR);   // VOICE_REFERENCES: narrator reference locked
        await query(`UPDATE scene_assets SET metadata = jsonb_set(metadata, '{gen_parts}', (metadata->'gen_parts') - $2) WHERE book_id = $1 AND scene_id = 'sc-3' AND asset_type = 'image'`, [bookId, IU.e]);
        const r4 = await scene('ch-2', 'sc-3', ['video']);
        expect(r4.body.summary.skipped_needs_image).to.deep.equal(['sc-3']);
    });

    it('IU в работе по другой команде: видео присоединяется (без дублей IU), группы — после последнего IU', async () => {
        await query(`INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, path, build_id, status) VALUES ($1, 'ch-2', 'sc-3', 'audio', $2, $3, 'ready')`,
            [bookId, path.join(config.OUTPUT_DIR, buildId, `${bookId}_ch-2_sc-3.mp3`), buildId]);
        fs.mkdirSync(path.join(config.OUTPUT_DIR, buildId), { recursive: true });
        fs.writeFileSync(path.join(config.OUTPUT_DIR, buildId, `${bookId}_ch-2_sc-3.mp3`), fixture('tone.mp3'));
        const iuRepo = require('../src/storage/postgres/repositories/iu-repo');
        await iuRepo.upsertImageUnit(buildId, bookId, 'ch-2', 'sc-3', IU.d, { scene_order: 0, start_ms: 0, end_ms: 2000 });
        await iuRepo.upsertImageUnit(buildId, bookId, 'ch-2', 'sc-3', IU.e, { scene_order: 1, start_ms: 2000, end_ms: 4000 });
        await scene('ch-2', 'sc-3', ['image']);
        const ti = await claim('image');                                   // one IU running, one queued
        const rv = await scene('ch-2', 'sc-3', ['video']);
        expect(rv.body.summary).to.include({ jobs_created: 0, joined: 2 });
        expect((await jobs('iu_image')).length).to.equal(2);
        expect((await put(ti, picture(5))).status).to.equal(200);
        expect((await jobs('video_group')).length).to.equal(0);
        await drainImages();
        expect((await jobs('video_group')).length).to.equal(1);
        const links = await count(`SELECT count(*) AS n FROM gen_command_jobs l JOIN gen_jobs j ON j.job_id = l.job_id WHERE l.command_id = $1 AND j.kind = 'video_group'`, [rv.body.command_id]);
        expect(links).to.equal(1);
    });

    it('Стоп посреди группы → cancel в beacon, поздний PUT 409, кадры 409; рестарт посреди группы → новых работ нет, PUT принят, повтор того же PUT идемпотентен', async () => {
        const audioFile = path.join(config.OUTPUT_DIR, buildId, `${bookId}_ch-2_sc-3.mp3`);
        await scene('ch-2', 'sc-3', ['image']);
        await drainImages();
        fs.writeFileSync(audioFile, fixture('tone.mp3'));
        await query(`INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, path, build_id, status) VALUES ($1, 'ch-2', 'sc-3', 'audio', $2, $3, 'ready')`, [bookId, audioFile, buildId]);
        const iuRepo = require('../src/storage/postgres/repositories/iu-repo');
        await iuRepo.upsertImageUnit(buildId, bookId, 'ch-2', 'sc-3', IU.d, { scene_order: 0, start_ms: 0, end_ms: 2000 });
        await iuRepo.upsertImageUnit(buildId, bookId, 'ch-2', 'sc-3', IU.e, { scene_order: 1, start_ms: 2000, end_ms: 2600 });

        await scene('ch-2', 'sc-3', ['video']);
        const t1 = await claim('video');
        expect((await api('POST', `/api/v1/book/${bookId}/cancel-generation`, {})).status).to.equal(200);
        expect((await beacon('video', t1.job_id)).body.cancel).to.include(t1.job_id);
        expect((await put(t1, clip(73, 1))).status).to.equal(409);
        expect((await fetchInput(t1, t1.input_files[0])).status).to.equal(409);
        expect(await asset('sc-3', 'video')).to.equal(undefined);

        await scene('ch-2', 'sc-3', ['video']);
        const t2 = await claim('video');
        const nJobs = await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1`, [bookId]);
        await host.stop();
        host = makeHost(); await host.start(); await wireApp();             // backend restart
        await orch().sweepOnce();
        expect(await count(`SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1`, [bookId])).to.equal(nJobs, 'restart creates no work');
        const body = clip(73, 2);
        const p1 = await put(t2, body);
        expect(p1.body).to.include({ status: 200, stage_jobs_created: 1 });
        const p2 = await put(t2, body);
        expect(p2.body).to.include({ status: 200, idempotent: true });
        expect((await jobs('video_merge')).length).to.equal(1);
    });

    it('iu-repo хранит 0 как 0 (не оставляет старую оценку)', async () => {
        const iuRepo = require('../src/storage/postgres/repositories/iu-repo');
        await iuRepo.upsertImageUnit(buildId, bookId, 'ch-1', 'sc-1', IU.b, { scene_order: 1, estimated_duration_sec: 7.651, start_ms: 0, end_ms: 7651 });
        await iuRepo.upsertImageUnit(buildId, bookId, 'ch-1', 'sc-1', IU.b, { scene_order: 1, estimated_duration_sec: 0, start_ms: 12072, end_ms: 12072 });
        const [row] = await ius('sc-1');
        expect(Number(row.estimated_duration_sec)).to.equal(0);
        expect(Number(row.end_ms) - Number(row.start_ms)).to.equal(0);
    });

    it('legacy-видео не трогает v2-книгу: поздний scene_video отклонён до записи файла, completeGroup → orchestration_v2', async () => {
        const handler = require('../src/services/task-handler.cjs')(redis, config, { utils: { log: () => {} }, cleanupService: { resolveAssetPath: () => null }, getChunk: async () => null, saveChunk: async () => {} });
        const jobId = `${bookId}_ch-1_sc-1_g1:video`;
        let err = null;
        try { await handler.handleTaskResult(jobId, clip(9).toString('base64'), buildId, 'dispatch-x', { fence: 'f' }); } catch (e) { err = e; }
        expect(err && err.code).to.equal('orchestration_v2');
        expect(fs.existsSync(path.join(config.OUTPUT_DIR, buildId, `${bookId}_ch-1_sc-1_g1.mp4`))).to.equal(false);
        const videoOrch = require('../src/services/video-orchestrator');
        expect(await videoOrch.completeGroup(redis, bookId, 'ch-1', 'sc-1', '_g1', buildId, {})).to.deep.equal({ completed: false, reason: 'orchestration_v2' });
    });

    it('ядро < 1.3.0 → слой video отклонён (409 v2_video_unavailable), audio/image работают', async () => {
        await host.stop();
        coreOverride = { ...gen, MIGRATIONS: gen.MIGRATIONS.filter((m) => m.id !== '004-command-skips') };
        host = makeHost(); await host.start(); await wireApp();
        const v = await scene('ch-1', 'sc-1', ['video']);
        expect(v.status).to.equal(409);
        expect(v.body).to.include({ code: 'v2_video_unavailable' });
        const iv = await scene('ch-1', 'sc-1', ['image', 'video']);
        expect(iv.status).to.equal(200);
        expect(iv.body.summary.skipped_unsupported).to.deep.equal(['video']);
    });
});
