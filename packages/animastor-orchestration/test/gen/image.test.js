// ======================================================
// gen v2 — images (1.1.0, ADR §12 этап 2a): iu_image end to end on a clean PG
// ======================================================
// PNG validation (structure, dimensions, blank frame), claim by an image worker,
// acceptance → gen_parts[unit_key] (+ part_hash) → scene ready when every IU of
// the scene is in, stale_attempt 409, invalid_result ×1 then failed, cancel by
// layer, two commands joining one IU, audio + images of one scene in parallel,
// part-level «already done» skip, no video transition without the video layer.

'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const gen = require('../../src/gen');
const { setupDb, makePorts, makeBook, makeWorker, count, fixture, streamOf, SECRET, makePng, noisePng, pngChunk } = require('./helpers');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('gen v2 — PNG validation (1.1.0: structure, dimensions, blank frame)', () => {
    const { inspectPng, DEFAULT_MIN_LUMA_STDDEV } = gen.media;

    it('a textured frame is accepted with its dimensions; every filter type unfilters', () => {
        const r = inspectPng(noisePng(64, 48));
        assert.equal(r.ok, true); assert.equal(r.width, 64); assert.equal(r.height, 48); assert.equal(r.flat_check, 'done');
        assert.ok(r.lumaStddev > 20);
        for (const filter of [0, 1, 2]) {
            const g = inspectPng(makePng(40, 30, (x, y) => [x * 6, y * 8, (x + y) * 3], { filter }));
            assert.equal(g.ok, true, `filter ${filter}`);
        }
        assert.equal(DEFAULT_MIN_LUMA_STDDEV, 2.0);
    });

    it('black / single-colour / near-flat frames → blank_frame; the threshold is a parameter', () => {
        assert.equal(inspectPng(makePng(32, 32, () => [0, 0, 0])).reason, 'blank_frame');
        assert.equal(inspectPng(makePng(32, 32, () => [120, 200, 30])).reason, 'blank_frame');
        // ±1 dither on a flat grey: stddev ≈ 1 < 2
        const dither = makePng(32, 32, (x, y) => { const v = 128 + ((x + y) % 2 ? 1 : -1); return [v, v, v]; });
        const d = inspectPng(dither);
        assert.equal(d.reason, 'blank_frame'); assert.ok(d.lumaStddev > 0.5 && d.lumaStddev < 2);
        assert.equal(inspectPng(dither, { minLumaStddev: 0.5 }).ok, true);
        // a dark but real picture (stddev ≈ 4) passes the default
        const dim = makePng(32, 32, (x, y) => { const v = 10 + ((x * 7 + y * 3) % 10); return [v, v, v]; });
        assert.equal(inspectPng(dim).ok, true);
    });

    it('broken files: not_png, truncated, bad_crc, no_ihdr, bad_dimensions, no_idat, no_iend, corrupt_data', () => {
        const good = noisePng(16, 16);
        assert.equal(inspectPng(Buffer.from('GIF89a....')).reason, 'not_png');
        assert.equal(inspectPng(Buffer.concat([SIG, Buffer.alloc(64)])).reason, 'bad_crc');
        assert.equal(inspectPng(good.subarray(0, good.length - 20)).reason, 'truncated');
        const flipped = Buffer.from(good); flipped[40] ^= 0xff;
        assert.equal(inspectPng(flipped).reason, 'bad_crc');
        const ihdr = (w, h) => { const b = Buffer.alloc(13); b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4); b[8] = 8; b[9] = 2; return pngChunk('IHDR', b); };
        const idat = pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(16 * (16 * 3 + 1))));
        const iend = pngChunk('IEND', Buffer.alloc(0));
        assert.equal(inspectPng(Buffer.concat([SIG, idat, iend])).reason, 'no_ihdr');
        assert.equal(inspectPng(Buffer.concat([SIG, ihdr(0, 16), idat, iend])).reason, 'bad_dimensions');
        assert.equal(inspectPng(Buffer.concat([SIG, ihdr(16, 0), idat, iend])).reason, 'bad_dimensions');
        assert.equal(inspectPng(Buffer.concat([SIG, ihdr(16, 16), iend])).reason, 'no_idat');
        assert.equal(inspectPng(Buffer.concat([SIG, ihdr(16, 16), idat])).reason, 'no_iend');
        // IHDR promises 16×16, the pixel stream is shorter
        const short = pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(100)));
        assert.equal(inspectPng(Buffer.concat([SIG, ihdr(16, 16), short, iend])).reason, 'corrupt_data');
        assert.equal(inspectPng(Buffer.concat([SIG, ihdr(16, 16), pngChunk('IDAT', Buffer.from('not zlib')), iend])).reason, 'corrupt_data');
    });

    it('default validateResult dispatches iu_image to the PNG check (file on disk)', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-png-'));
        try {
            const v = gen.defaults.createDefaultValidateResult({});
            fs.writeFileSync(path.join(tmp, 'ok.png'), noisePng());
            fs.writeFileSync(path.join(tmp, 'black.png'), makePng(8, 8, () => [0, 0, 0]));
            assert.equal((await v({ kind: 'iu_image' }, path.join(tmp, 'ok.png'))).ok, true);
            assert.equal((await v({ kind: 'iu_image' }, path.join(tmp, 'black.png'))).reason, 'blank_frame');
            const strict = gen.defaults.createDefaultValidateResult({ minLumaStddev: 1000 });
            assert.equal((await strict({ kind: 'iu_image' }, path.join(tmp, 'ok.png'))).reason, 'blank_frame');
        } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    });
});

describe('gen v2 — iu_image end to end (ADR §6–§7, 2a)', function () {
    this.timeout(30000);
    let ctx; let o; let book; let imgWorker; let audioWorker; let ports;
    // scene → ordered IU ids; partHash[unit] can be changed to simulate a prompt edit
    let scenes; let partHash;

    function imagePlan(scope) {
        const units = [];
        for (const [ch, scs] of Object.entries(scenes)) {
            if (scope.level === 'chapter' && scope.chapter_id !== ch) continue;
            for (const [sc, ius] of Object.entries(scs)) {
                if ((scope.level === 'scene' || scope.level === 'unit') && scope.scene_id !== sc) continue;
                const parts = ius.map((u) => ({ unit_key: u, part_hash: partHash[u] || 'p1' }));
                const sceneHash = 'image-v2:' + sha(parts.map((p) => `${p.unit_key}:${p.part_hash}`).join('\n')).slice(0, 32);
                for (const u of ius) {
                    if (scope.level === 'unit' && scope.unit_id !== u) continue;
                    units.push({
                        chapter_id: ch, scene_id: sc, kind: 'iu_image', unit_key: u, build_id: 'build-1', scene_hash: sceneHash,
                        input: { workflow_json: JSON.stringify({ prompt: `${u}/${partHash[u] || 'p1'}` }), part_hash: partHash[u] || 'p1', scene_parts: parts },
                    });
                }
            }
        }
        return units;
    }

    async function setup(sceneMap = { ch: { sc: ['iu-a', 'iu-b'] } }, audioPlan = { ch: { sc: 1 } }) {
        ctx = await setupDb();
        scenes = sceneMap; partHash = {};
        ports = makePorts(ctx, audioPlan);
        const audioPlanFn = ports.ports.planUnits;
        ports.ports.planUnits = async (b, scope, layer) => {
            if (layer === 'image') return imagePlan(scope);
            if (layer === 'video') return [];               // 2a: no video planner — the transition creates nothing
            return audioPlanFn(b, scope, layer);
        };
        const audioArtifact = ports.ports.artifactPath;
        ports.ports.artifactPath = (job) => (job.kind === 'iu_image'
            ? path.join(ctx.outputDir, job.build_id, `${job.book_id}_${job.chapter_id}_${job.scene_id}_${job.unit_key}.png`)
            : audioArtifact(job));
        const placed = [];
        ports.ports.onArtifactPlaced = (job, p) => { placed.push({ kind: job.kind, p }); };
        ports.placed = placed;
        o = gen.createOrchestration({ pool: ctx.pool, ports: ports.ports, uploadSecret: SECRET, outputDir: ctx.outputDir });
        book = await makeBook(ctx);
        imgWorker = await makeWorker(ctx, { workspaceId: book.workspaceId, type: 'image' });
        audioWorker = await makeWorker(ctx, { workspaceId: book.workspaceId, type: 'audio' });
    }
    afterEach(async () => { o.stop(); await ctx.teardown(); });

    const command = (extra = {}) => o.createCommand({ ...book, scope: { level: 'book' }, layers: ['image'], ...extra });
    const claimImg = async () => (await o.claim({ workerId: imgWorker, workerType: 'image', mode: 'private', workspaceId: book.workspaceId })).task;
    const claimAudio = async () => (await o.claim({ workerId: audioWorker, workerType: 'audio', mode: 'private', workspaceId: book.workspaceId })).task;
    const put = (t, buf) => o.acceptResult(t.job_id, t.attempt, t.upload_token, streamOf(buf));
    const asset = async (type = 'image') => (await ctx.q(`SELECT * FROM scene_assets WHERE book_id = $1 AND asset_type = $2`, [book.bookId, type])).rows[0];

    it('claim (image worker only) → PUT PNG → gen_parts[unit_key] + part_hash; scene ready only when every IU is in (sha manifest, job_id, path)', async () => {
        await setup();
        const c = await command();
        assert.deepEqual(c.summary, { jobs_created: 2, joined: 0, skipped_ready: 0 });
        assert.equal(await claimAudio(), null, 'an audio worker never gets iu_image');
        const a = await claimImg();
        assert.equal(a.kind, 'iu_image'); assert.equal(a.unit_key, 'iu-a'); assert.equal(a.timeout_ms, 30 * 60_000);
        const b = await claimImg();
        const pa = noisePng(32, 32, 1); const pb = noisePng(32, 32, 2);
        const r1 = await put(a, pa);
        assert.equal(r1.status, 200); assert.equal(r1.stage_jobs_created, 0, 'no video layer → no transition');
        let row = await asset();
        assert.equal(row.status, 'pending', 'one IU of two: scene not ready (I5)');
        assert.equal(row.metadata.gen_parts['iu-a'].sha256, sha(pa));
        assert.equal(row.metadata.gen_parts['iu-a'].part_hash, 'p1');
        assert.equal(row.job_id, null);
        assert.equal((await put(b, pb)).status, 200);
        row = await asset();
        assert.equal(row.status, 'ready');
        assert.equal(row.job_id, b.job_id);
        assert.equal(row.sha256, sha(`iu-a:${sha(pa)}\niu-b:${sha(pb)}`));
        assert.equal(row.path, ports.ports.artifactPath({ ...a, build_id: 'build-1' }));
        assert.equal(row.format, 'png');
        assert.equal(sha(fs.readFileSync(row.metadata.gen_parts['iu-b'].path)), sha(pb));
        assert.deepEqual(ports.placed.map((x) => x.kind), ['iu_image', 'iu_image'], 'onArtifactPlaced runs for images (preview invalidation hook)');
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_jobs WHERE kind <> 'iu_image'`), 0);
        await o.sweepOnce();
        assert.equal((await ctx.q(`SELECT status FROM gen_commands WHERE command_id = $1`, [c.command_id])).rows[0].status, 'done');
    });

    it('stale attempt → 409 (file discarded); blank frame → invalid_result: one retry, then failed; scene never ready', async () => {
        await setup({ ch: { sc: ['iu-a'] } });
        await command();
        const t1 = await claimImg();
        await ctx.q(`UPDATE gen_jobs SET deadline = now() - interval '1 second' WHERE job_id = $1`, [t1.job_id]);
        await o.sweepOnce();                                  // timeout → queued (attempt 2 later)
        await ctx.q(`UPDATE gen_jobs SET not_before = now() WHERE job_id = $1`, [t1.job_id]);
        const t2 = await claimImg();
        assert.equal(t2.attempt, 2);
        const late = await put(t1, noisePng());
        assert.equal(late.status, 409); assert.equal(late.code, 'stale_attempt');
        assert.equal(fs.existsSync(ports.ports.artifactPath({ ...t1, build_id: 'build-1' })), false, 'stale file not placed');
        const black = makePng(32, 32, () => [0, 0, 0]);
        let r = await put(t2, black);
        assert.equal(r.status, 422); assert.equal(r.code, 'invalid_result'); assert.equal(r.reason, 'blank_frame'); assert.equal(r.job_status, 'queued');
        await ctx.q(`UPDATE gen_jobs SET not_before = now() WHERE job_id = $1`, [t1.job_id]);
        const t3 = await claimImg();
        assert.equal(t3.attempt, 3);
        r = await put(t3, black);
        assert.equal(r.status, 422); assert.equal(r.job_status, 'failed');
        const j = (await ctx.q(`SELECT status, error_class FROM gen_jobs WHERE job_id = $1`, [t1.job_id])).rows[0];
        assert.deepEqual(j, { status: 'failed', error_class: 'invalid_result' });
        assert.equal(await asset(), undefined, 'no scene_assets row for a never-accepted image');
    });

    it('cancel by layer image stops images only (audio of the same book keeps running); late PUT → 409', async () => {
        await setup();
        await command({ layers: ['image', 'audio'] });
        const ti = await claimImg();
        const ta = await claimAudio();
        const r = await o.cancel({ bookId: book.bookId, layer: 'image' });
        assert.equal(r.jobs_cancelled, 2);
        assert.equal((await put(ti, noisePng())).status, 409);
        assert.equal((await o.beacon(imgWorker, { current_job_id: ti.job_id })).cancel.includes(ti.job_id), true);
        assert.equal((await ctx.q(`SELECT status FROM gen_jobs WHERE job_id = $1`, [ta.job_id])).rows[0].status, 'running');
        assert.equal((await o.acceptResult(ta.job_id, ta.attempt, ta.upload_token, streamOf(fixture('tone.mp3')))).status, 200);
    });

    it('two commands on one IU: the second joins (no duplicate job); stopping the first keeps the shared IU', async () => {
        await setup();
        const a = await command();
        const b = await command({ scope: { level: 'unit', chapter_id: 'ch', scene_id: 'sc', unit_id: 'iu-b' } });
        assert.deepEqual(b.summary, { jobs_created: 0, joined: 1, skipped_ready: 0 });
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_jobs WHERE unit_key = 'iu-b'`), 1);
        const stop = await o.cancel({ commandId: a.command_id });
        assert.equal(stop.jobs_cancelled, 1); assert.equal(stop.kept_shared, 1);
        assert.deepEqual(stop.layers, ['image'], '1.1.0: cancel({commandId}) reports the layers of the command');
        const t = await claimImg();
        assert.equal(t.unit_key, 'iu-b');
        assert.equal(await claimImg(), null);
        assert.equal((await put(t, noisePng())).status, 200);
        await o.sweepOnce();
        assert.equal((await ctx.q(`SELECT status FROM gen_commands WHERE command_id = $1`, [b.command_id])).rows[0].status, 'done');
        assert.equal((await asset()).status, 'pending', 'iu-a was cancelled → the scene is not complete');
    });

    it('audio and images of ONE scene in parallel: independent workers, assets, merge only for audio', async () => {
        await setup({ ch: { sc: ['iu-a'] } }, { ch: { sc: 1 } });
        const c = await command({ layers: ['audio', 'image'] });
        assert.equal(c.summary.jobs_created, 2);
        const [ta, ti] = await Promise.all([claimAudio(), claimImg()]);
        assert.equal(ta.kind, 'audio_chunk'); assert.equal(ti.kind, 'iu_image');
        const [ra, ri] = await Promise.all([
            o.acceptResult(ta.job_id, ta.attempt, ta.upload_token, streamOf(fixture('tone.mp3'))),
            put(ti, noisePng()),
        ]);
        assert.equal(ra.stage_jobs_created, 1, 'audio_merge'); assert.equal(ri.stage_jobs_created, 0);
        assert.equal((await asset('image')).status, 'ready');
        assert.equal((await asset('audio')).status, 'pending');
        assert.equal((await o.runLocalOnce()).status, 200);
        assert.equal((await asset('audio')).status, 'ready');
        await o.sweepOnce();
        assert.equal((await ctx.q(`SELECT status FROM gen_commands WHERE command_id = $1`, [c.command_id])).rows[0].status, 'done');
    });

    it('without force: a ready scene is skipped; after a prompt edit only the changed IU is redone (part_hash); force redoes all', async () => {
        await setup({ ch: { sc: ['iu-a', 'iu-b', 'iu-c'] } });
        await command();
        for (let i = 0; i < 3; i += 1) assert.equal((await put(await claimImg(), noisePng(16, 16, i + 1))).status, 200);
        assert.equal((await asset()).status, 'ready');
        assert.deepEqual((await command()).summary, { jobs_created: 0, joined: 0, skipped_ready: 3 });
        partHash['iu-b'] = 'p2';                              // the prompt of iu-b changed
        const c2 = await command();
        assert.deepEqual(c2.summary, { jobs_created: 1, joined: 0, skipped_ready: 2 });
        const t = await claimImg();
        assert.equal(t.unit_key, 'iu-b');
        assert.equal((await put(t, noisePng(16, 16, 9))).status, 200);
        const row = await asset();
        assert.equal(row.status, 'ready'); assert.equal(row.metadata.gen_parts['iu-b'].part_hash, 'p2');
        assert.deepEqual((await command({ force: true })).summary, { jobs_created: 3, joined: 0, skipped_ready: 0 });
        // a row the host marked stale proves nothing
        await ctx.q(`UPDATE gen_jobs SET status = 'cancelled' WHERE status IN ('queued','running')`);
        await ctx.q(`UPDATE scene_assets SET status = 'stale'`);
        assert.deepEqual((await command()).summary, { jobs_created: 3, joined: 0, skipped_ready: 0 });
    });

    it('a part with a NEW content hash on a ready scene → pending until the whole new set is in', async () => {
        await setup({ ch: { sc: ['iu-a', 'iu-b'] } });
        await command();
        for (let i = 0; i < 2; i += 1) await put(await claimImg(), noisePng(16, 16, i + 1));
        assert.equal((await asset()).status, 'ready');
        partHash['iu-a'] = 'p2'; partHash['iu-b'] = 'p2';
        await command();
        await put(await claimImg(), noisePng(16, 16, 5));
        let row = await asset();
        assert.equal(row.status, 'pending'); assert.equal(row.sha256, null); assert.equal(row.job_id, null);
        await put(await claimImg(), noisePng(16, 16, 6));
        row = await asset();
        assert.equal(row.status, 'ready');
    });

    it('two IUs of one scene accepted concurrently → exactly one completes the scene (row lock)', async () => {
        await setup({ ch: { sc: ['iu-a', 'iu-b'] } });
        await command();
        const [a, b] = [await claimImg(), await claimImg()];
        const rs = await Promise.all([put(a, noisePng(16, 16, 1)), put(b, noisePng(16, 16, 2))]);
        assert.deepEqual(rs.map((r) => r.status), [200, 200]);
        const row = await asset();
        assert.equal(row.status, 'ready');
        assert.deepEqual(Object.keys(row.metadata.gen_parts).sort(), ['iu-a', 'iu-b']);
        assert.ok([a.job_id, b.job_id].includes(row.job_id));
    });

    it('iu_image of a command WITH video: the transition asks planUnits(video); an empty plan creates nothing (2a: prepared, not enabled)', async () => {
        await setup({ ch: { sc: ['iu-a'] } });
        const asked = [];
        const orig = ports.ports.planUnits;
        ports.ports.planUnits = async (b, scope, layer) => { if (layer === 'video') asked.push(scope); return orig(b, scope, layer); };
        o.stop();
        o = gen.createOrchestration({ pool: ctx.pool, ports: ports.ports, uploadSecret: SECRET, outputDir: ctx.outputDir });
        await o.createCommand({ ...book, scope: { level: 'book' }, layers: ['image', 'video'] });
        const t = await claimImg();
        const r = await put(t, noisePng());
        assert.equal(r.stage_jobs_created, 0);
        assert.deepEqual(asked.slice(-1), [{ level: 'scene', chapter_id: 'ch', scene_id: 'sc' }]);
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_jobs WHERE kind = 'video_group'`), 0);
    });
});
