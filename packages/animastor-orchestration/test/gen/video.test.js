// ======================================================
// gen v2 — video (1.3.0, ADR §6.3, §6.5, §8.1, §13 п.11): video_group + video_merge on a clean PG
// ======================================================
// The host video planner here is a small test double with the SAME decisions
// as the backend one (wait for live images / audio, skip with a reason, groups
// with merge_parts), reading PG through ctx.db of the calling transaction.
// Covered: audio + image + video of an empty scene down to video_merge; video
// only with placeholder audio → skipped_needs_audio; IU without gen_parts →
// skipped_needs_image; dirty IU → skipped_image_dirty (at creation and in the
// transition); joining IUs of another command; all groups done → merge only;
// stop mid-group; restart mid-group; repeated PUT; input channel (token,
// attempt, name, sha); two groups accepted concurrently → one merge;
// onArtifactPlaced gets the acceptance tx (db) + runLocal meta.

'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const gen = require('../../src/gen');
const { setupDb, makePorts, makeBook, makeWorker, count, fixture, streamOf, SECRET, noisePng } = require('./helpers');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const mp4 = (seed = 1) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), crypto.createHash('sha512').update(String(seed)).digest()]);

describe('gen v2 — video (1.3.0: video_group + video_merge, ADR §6.5, §13 п.11)', function () {
    this.timeout(30000);
    let ctx; let o; let book; let w; let ports; let placed;
    // ch → sc → ordered IU ids; partHash[iu] = current image workflow hash; durMs[iu] = real duration
    let scenes; let partHash; let durMs; let groupSize; let videoPlans;

    function inScope(scope, ch, sc) {
        if (scope.level === 'book') return true;
        if (scope.level === 'chapter') return scope.chapter_id === ch;
        if (scope.level === 'scenes') return scope.scene_ids.includes(sc);
        return scope.scene_id === sc;
    }

    function imagePlan(scope) {
        const units = [];
        for (const [ch, scs] of Object.entries(scenes)) {
            for (const [sc, ius] of Object.entries(scs)) {
                if (!inScope(scope, ch, sc)) continue;
                const parts = ius.map((u) => ({ unit_key: u, part_hash: partHash[u] || 'p1' }));
                for (const u of ius) {
                    units.push({
                        chapter_id: ch, scene_id: sc, kind: 'iu_image', unit_key: u, build_id: 'build-1', scene_hash: `img-${sc}`,
                        input: { part_hash: partHash[u] || 'p1', scene_parts: parts },
                    });
                }
            }
        }
        return units;
    }

    /** The decisions of the backend video planner, on the caller's transaction. */
    async function videoPlan(scope, planCtx) {
        assert.ok(planCtx && planCtx.db && typeof planCtx.db.query === 'function', 'video planner gets ctx.db');
        const db = planCtx.db;
        const out = { units: [], waits: [], skipped: [] };
        for (const [ch, scs] of Object.entries(scenes)) {
            for (const [sc, ius] of Object.entries(scs)) {
                if (!inScope(scope, ch, sc)) continue;
                const live = new Set((await db.query(
                    `SELECT kind FROM gen_jobs WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3 AND status IN ('queued','running')`,
                    [book.bookId, ch, sc])).rows.map((r) => r.kind));
                const audioLive = live.has('audio_chunk') || live.has('audio_merge');
                const audio = (await db.query(
                    `SELECT status FROM scene_assets WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3 AND asset_type = 'audio' AND build_id = 'build-1'`,
                    [book.bookId, ch, sc])).rows[0];
                const img = (await db.query(
                    `SELECT metadata->'gen_parts' AS parts FROM scene_assets WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3 AND asset_type = 'image' AND build_id = 'build-1'`,
                    [book.bookId, ch, sc])).rows[0];
                const parts = (img && img.parts) || {};
                const imgLive = live.has('iu_image');
                const missing = ius.filter((u) => !parts[u]);
                const dirty = ius.filter((u) => parts[u] && parts[u].part_hash !== (partHash[u] || 'p1'));
                if (audioLive || imgLive) {
                    if (!imgLive && (missing.length || dirty.length)) { out.skipped.push({ chapter_id: ch, scene_id: sc, reason: missing.length ? 'skipped_needs_image' : 'skipped_image_dirty' }); continue; }
                    out.waits.push({ chapter_id: ch, scene_id: sc });
                    continue;
                }
                if (!audio || audio.status !== 'ready') { out.skipped.push({ chapter_id: ch, scene_id: sc, reason: 'skipped_needs_audio' }); continue; }
                if (missing.length) { out.skipped.push({ chapter_id: ch, scene_id: sc, reason: 'skipped_needs_image' }); continue; }
                if (dirty.length) { out.skipped.push({ chapter_id: ch, scene_id: sc, reason: 'skipped_image_dirty' }); continue; }
                const used = ius.filter((u) => (durMs[u] ?? 1000) > 0);
                const groups = [];
                for (let i = 0; i < used.length; i += groupSize) groups.push(used.slice(i, i + groupSize));
                const g = groups.map((ids, i) => {
                    const frames = ids.map((u) => parts[u].sha256);
                    const d = ids.map((u) => durMs[u] ?? 1000);
                    return {
                        unit_key: 'g:' + ids.join('+'), ids, index: i + 1,
                        part_hash: 'vg-v2:' + sha(JSON.stringify({ frames, d, wf: 'ltx' })).slice(0, 32),
                        inputs: ids.map((u) => ({ name: `${book.bookId}_${ch}_${sc}_${u}.png`, path: parts[u].path, sha256: parts[u].sha256, bytes: parts[u].bytes })),
                        d,
                    };
                });
                const mergeParts = g.map((x) => ({ unit_key: x.unit_key, part_hash: x.part_hash }));
                const sceneHash = 'video-v2:' + sha(JSON.stringify(mergeParts)).slice(0, 32);
                for (const x of g) {
                    out.units.push({
                        chapter_id: ch, scene_id: sc, kind: 'video_group', unit_key: x.unit_key, build_id: 'build-1', scene_hash: sceneHash,
                        input: { workflow_json: JSON.stringify({ ltx: x.ids }), part_hash: x.part_hash, merge_parts: mergeParts, inputs: x.inputs,
                            part_meta: { group_index: x.index, group_count: g.length, unit_ids: x.ids, durations_ms: x.d } },
                    });
                }
            }
        }
        videoPlans.push({ scope, units: out.units.length, waits: out.waits.length, skipped: out.skipped.map((s) => s.reason) });
        return out;
    }

    async function setup(sceneMap = { ch: { sc: ['iu-a', 'iu-b'] } }, opts = {}) {
        ctx = await setupDb();
        scenes = sceneMap; partHash = {}; durMs = {}; groupSize = opts.groupSize || 1; videoPlans = []; placed = [];
        const audioPlan = {};
        for (const [ch, scs] of Object.entries(sceneMap)) { audioPlan[ch] = {}; for (const sc of Object.keys(scs)) audioPlan[ch][sc] = 1; }
        ports = makePorts(ctx, audioPlan);
        const audioPlanFn = ports.ports.planUnits;
        ports.ports.planUnits = async (b, scope, layer, planCtx) => {
            if (layer === 'image') return imagePlan(scope);
            if (layer === 'video') return videoPlan(scope, planCtx);
            return audioPlanFn(b, scope, layer);
        };
        const audioArtifact = ports.ports.artifactPath;
        ports.ports.artifactPath = (job) => {
            const pre = `${job.book_id}_${job.chapter_id}_${job.scene_id}`;
            if (job.kind === 'iu_image') return path.join(ctx.outputDir, job.build_id, `${pre}_${job.unit_key}.png`);
            if (job.kind === 'video_group') return path.join(ctx.outputDir, job.build_id, `${pre}_g${job.input.part_meta.group_index}.mp4`);
            if (job.kind === 'video_merge') return path.join(ctx.outputDir, job.build_id, `${pre}.mp4`);
            return audioArtifact(job);
        };
        const audioRunLocal = ports.ports.runLocal;
        ports.ports.runLocal = async (job) => {
            if (job.kind !== 'video_merge') { const r = await audioRunLocal(job); return { ...r, meta: { measured: job.kind } }; }
            const out = path.join(ctx.outputDir, job.build_id, `merge-${job.job_id}.tmp.mp4`);
            fs.writeFileSync(out, mp4(`merge-${job.input.parts.map((p) => p.sha256).join()}`));
            return { path: out, meta: { groups: job.input.parts.length } };
        };
        ports.ports.onArtifactPlaced = async (job, p, hookCtx) => {
            // the hook runs inside the acceptance transaction (§7 п.3: after the rename, before the job row update)
            const r = await hookCtx.db.query('SELECT status FROM gen_jobs WHERE job_id = $1', [job.job_id]);
            placed.push({ kind: job.kind, p, meta: hookCtx.meta, statusInTx: r.rows[0].status });
        };
        ports.ports.inputFiles = (job) => (job.kind === 'video_group' ? job.input.inputs : []);
        o = gen.createOrchestration({ pool: ctx.pool, ports: ports.ports, uploadSecret: SECRET, outputDir: ctx.outputDir });
        book = await makeBook(ctx);
        w = {
            image: await makeWorker(ctx, { workspaceId: book.workspaceId, type: 'image' }),
            audio: await makeWorker(ctx, { workspaceId: book.workspaceId, type: 'audio' }),
            video: await makeWorker(ctx, { workspaceId: book.workspaceId, type: 'video' }),
        };
    }
    afterEach(async () => { if (o) o.stop(); if (ctx) await ctx.teardown(); ctx = null; o = null; });

    const claim = async (type) => (await o.claim({ workerId: w[type], workerType: type, mode: 'private', workspaceId: book.workspaceId })).task;
    const put = (t, buf) => o.acceptResult(t.job_id, t.attempt, t.upload_token, streamOf(buf));
    const jobsOf = async (kind) => (await ctx.q(`SELECT * FROM gen_jobs WHERE book_id = $1 AND kind = $2 ORDER BY created_at`, [book.bookId, kind])).rows;
    const asset = async (type, sc = 'sc') => (await ctx.q(`SELECT * FROM scene_assets WHERE book_id = $1 AND asset_type = $2 AND scene_id = $3`, [book.bookId, type, sc])).rows[0];
    const cmd = (layers, extra = {}) => o.createCommand({ ...book, scope: { level: 'book' }, layers, ...extra });
    async function doImages(n) {
        for (let i = 0; i < n; i += 1) { const t = await claim('image'); assert.ok(t, 'an IU job'); assert.equal((await put(t, noisePng(32, 24, i + 7))).status, 200); }
    }
    async function doAudio() {
        const t = await claim('audio'); assert.equal((await put(t, fixture('tone.mp3'))).status, 200);
        const r = await o.runLocalOnce(); assert.equal(r.status, 200, 'audio_merge accepted');
        return r;
    }
    /** audio ready (real) for the scene without going through jobs */
    const readyAudio = (sc = 'sc', status = 'ready') => ctx.q(
        `INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, build_id, status, path) VALUES ($1, 'ch', $2, 'audio', 'build-1', $3, '/x.mp3')`,
        [book.bookId, sc, status]);

    it('{audio,image,video} of an empty scene: waits for IUs and audio, groups after audio_merge, input by link, merge → ready, command done', async () => {
        await setup();
        const c = await cmd(['audio', 'image', 'video']);
        assert.deepEqual(c.summary, { jobs_created: 3, joined: 0, skipped_ready: 0 });
        assert.deepEqual(videoPlans.at(-1), { scope: { level: 'book' }, units: 0, waits: 1, skipped: [] });
        await doImages(2);
        assert.equal(videoPlans.at(-1).waits, 1, 'after the last IU: audio still in work → wait');
        assert.equal((await jobsOf('video_group')).length, 0);
        const am = await doAudio();
        assert.equal(am.status, 200);
        const groups = await jobsOf('video_group');
        assert.equal(groups.length, 2, 'groups created by the audio_merge transition');
        assert.deepEqual(groups.map((g) => g.unit_key), ['g:iu-a', 'g:iu-b']);
        const linked = await count(ctx, `SELECT count(*) AS n FROM gen_command_jobs WHERE command_id = $1`, [c.command_id]);
        assert.equal(linked, 1 + 2 + 1 + 2, 'chunk + 2 IU + audio_merge + 2 groups linked to the command');
        // audio_merge hook: inside the tx (job already done there) with runLocal meta
        const amPlaced = placed.find((p) => p.kind === 'audio_merge');
        assert.deepEqual(amPlaced.meta, { measured: 'audio_merge' }); assert.equal(amPlaced.statusInTx, 'running', 'hook: right after the rename, before the job row turns done (§7 п.3)');

        const t1 = await claim('video');
        assert.equal(t1.kind, 'video_group');
        assert.equal(t1.input_files.length, 1);
        const f = t1.input_files[0];
        const img = (await asset('image')).metadata.gen_parts['iu-a'];
        assert.equal(f.name, `${book.bookId}_ch_sc_iu-a.png`); assert.equal(f.sha256, img.sha256); assert.equal(f.bytes, img.bytes);
        const got = await o.openInput(t1.job_id, t1.attempt, t1.upload_token, f.name);
        assert.equal(got.status, 200); assert.equal(sha(got.body), img.sha256);
        assert.equal((await put(t1, mp4(1))).stage_jobs_created, 0, 'one group left → no merge yet');
        const t2 = await claim('video');
        assert.equal((await put(t2, mp4(2))).stage_jobs_created, 1, 'last group → video_merge');
        const merge = (await jobsOf('video_merge'))[0];
        assert.deepEqual(merge.input.parts.map((p) => p.unit_key), ['g:iu-a', 'g:iu-b'], 'parts in merge_parts order');
        assert.equal((await o.runLocalOnce()).status, 200);
        const v = await asset('video');
        assert.equal(v.status, 'ready'); assert.equal(v.format, 'mp4'); assert.equal(v.scene_hash, groups[0].input.scene_hash);
        assert.deepEqual(Object.keys(v.metadata.gen_parts).sort(), ['g:iu-a', 'g:iu-b']);
        assert.deepEqual(placed.find((p) => p.kind === 'video_merge').meta, { groups: 2 });
        await o.sweepOnce();
        assert.equal((await ctx.q(`SELECT status FROM gen_commands WHERE command_id = $1`, [c.command_id])).rows[0].status, 'done');
    });

    it('{video} with placeholder audio → skipped_needs_audio (summary + progress); no audio is started; command done', async () => {
        await setup({ ch: { sc: ['iu-a'], sc2: ['iu-c'] } });
        await readyAudio('sc', 'placeholder');
        const c = await cmd(['video']);
        assert.deepEqual(c.summary.skipped_needs_audio, ['sc', 'sc2']);
        assert.equal(c.summary.jobs_created, 0);
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_jobs WHERE book_id = $1`, [book.bookId]), 0);
        const p = await o.progress(book.bookId);
        assert.deepEqual(p.commands[0].skipped, { skipped_needs_audio: ['sc', 'sc2'] });
        await o.sweepOnce();
        const p2 = await o.progress(book.bookId, { finishedWithinMs: 60000 });
        assert.equal(p2.commands[0].status, 'done');
    });

    it('{video} with ready audio: IU without gen_parts → skipped_needs_image; edited prompt → skipped_image_dirty; clean scene → groups (zero-duration IU left out)', async () => {
        await setup({ ch: { sc: ['iu-a', 'iu-b', 'iu-z'], sc2: ['iu-c'], sc3: ['iu-d'] } });
        await o.createCommand({ ...book, scope: { level: 'book' }, layers: ['image'] });
        await doImages(5);
        await ctx.q(`UPDATE scene_assets SET metadata = jsonb_set(metadata, '{gen_parts}', (metadata->'gen_parts') - 'iu-c') WHERE scene_id = 'sc2' AND asset_type = 'image'`);
        partHash['iu-d'] = 'p2';                                  // prompt of iu-d edited after its picture
        durMs['iu-z'] = 0;                                        // no own audio → not in the video
        for (const sc of ['sc', 'sc2', 'sc3']) await readyAudio(sc);
        const c = await cmd(['video']);
        assert.deepEqual(c.summary.skipped_needs_image, ['sc2']);
        assert.deepEqual(c.summary.skipped_image_dirty, ['sc3']);
        assert.equal(c.summary.jobs_created, 2);
        assert.deepEqual((await jobsOf('video_group')).map((g) => g.unit_key), ['g:iu-a', 'g:iu-b']);
    });

    it('IUs in work under another command: video joins them (no new IU); stopping the image command keeps them; groups follow the last IU', async () => {
        await setup();
        await readyAudio();
        const ci = await o.createCommand({ ...book, scope: { level: 'book' }, layers: ['image'] });
        const cv = await cmd(['video']);
        assert.equal(cv.summary.jobs_created, 0); assert.equal(cv.summary.joined, 2);
        assert.equal((await jobsOf('iu_image')).length, 2, 'no duplicate IU');
        const r = await o.cancel({ commandId: ci.command_id });
        assert.equal(r.jobs_cancelled, 0); assert.equal(r.kept_shared, 2);
        await doImages(2);
        assert.equal((await jobsOf('video_group')).length, 2);
        const links = await count(ctx, `SELECT count(*) AS n FROM gen_command_jobs l JOIN gen_jobs j ON j.job_id = l.job_id WHERE l.command_id = $1 AND j.kind = 'video_group'`, [cv.command_id]);
        assert.equal(links, 2);
    });

    it('prompt edited while the IU renders → the transition skips the scene (skipped_image_dirty in progress); command done', async () => {
        await setup({ ch: { sc: ['iu-a'] } });
        await readyAudio();
        const c = await cmd(['image', 'video']);
        assert.equal(c.summary.jobs_created, 1);
        partHash['iu-a'] = 'p2';                                  // edited during rendering
        await doImages(1);
        assert.equal((await jobsOf('video_group')).length, 0);
        const p = await o.progress(book.bookId);
        assert.deepEqual(p.commands[0].skipped, { skipped_image_dirty: ['sc'] });
        await o.sweepOnce();
        assert.equal((await ctx.q(`SELECT status FROM gen_commands WHERE command_id = $1`, [c.command_id])).rows[0].status, 'done');
    });

    it('missing mode: all groups already done but no merge for this content → the merge alone (local), no GPU; then ready → skipped', async () => {
        await setup();
        await readyAudio();
        await o.createCommand({ ...book, scope: { level: 'book' }, layers: ['image'] });
        await doImages(2);
        await cmd(['video']);
        for (let i = 0; i < 2; i += 1) { const t = await claim('video'); await put(t, mp4(i)); }
        // the merge job failed for good (e.g. ffmpeg): scene video not ready
        const m = (await jobsOf('video_merge'))[0];
        await ctx.q(`UPDATE gen_jobs SET status = 'failed', finished_at = now() WHERE job_id = $1`, [m.job_id]);
        await o.sweepOnce();
        const c2 = await cmd(['video']);
        assert.deepEqual({ created: c2.summary.jobs_created, skipped: c2.summary.skipped_ready }, { created: 1, skipped: 2 });
        assert.equal((await jobsOf('video_group')).length, 2, 'no new GPU work');
        const m2 = (await jobsOf('video_merge')).at(-1);
        assert.equal(m2.status, 'queued'); assert.equal(m2.input.parts.length, 2);
        assert.equal((await o.runLocalOnce()).status, 200);
        assert.equal((await asset('video')).status, 'ready');
        const c3 = await cmd(['video']);
        assert.deepEqual({ created: c3.summary.jobs_created, skipped: c3.summary.skipped_ready }, { created: 0, skipped: 2 });
        // force: everything again
        const c4 = await cmd(['video'], { force: true });
        assert.equal(c4.summary.jobs_created, 2);
    });

    it('stop mid-group: the video command is cancelled, beacon says cancel, late PUT → 409, no merge, scene video not ready', async () => {
        await setup();
        await readyAudio();
        await o.createCommand({ ...book, scope: { level: 'book' }, layers: ['image'] });
        await doImages(2);
        const c = await cmd(['video']);
        const t = await claim('video');
        const r = await o.cancel({ commandId: c.command_id });
        assert.equal(r.jobs_cancelled, 2);
        assert.deepEqual((await o.beacon(w.video, { current_job_id: t.job_id })).cancel, [t.job_id]);
        assert.equal((await put(t, mp4(1))).status, 409);
        assert.equal((await o.openInput(t.job_id, t.attempt, t.upload_token, t.input_files[0].name)).status, 409);
        assert.equal((await jobsOf('video_merge')).length, 0);
        assert.equal(await asset('video'), undefined);
    });

    it('restart mid-group (new instance): nothing new is created, the running group is accepted, merge follows; a repeated PUT is idempotent', async () => {
        await setup({ ch: { sc: ['iu-a', 'iu-b'] } }, { groupSize: 2 });
        await readyAudio();
        await o.createCommand({ ...book, scope: { level: 'book' }, layers: ['image'] });
        await doImages(2);
        await cmd(['video']);
        const t = await claim('video');
        const before = await count(ctx, `SELECT count(*) AS n FROM gen_jobs`);
        o.stop();
        o = gen.createOrchestration({ pool: ctx.pool, ports: ports.ports, uploadSecret: SECRET, outputDir: ctx.outputDir });
        await o.sweepOnce();
        assert.equal(await count(ctx, `SELECT count(*) AS n FROM gen_jobs`), before, 'restart creates no work');
        const r1 = await put(t, mp4(5));
        assert.equal(r1.status, 200); assert.equal(r1.stage_jobs_created, 1);
        const r2 = await put(t, mp4(5));
        assert.equal(r2.status, 200); assert.equal(r2.idempotent, true);
        assert.equal((await jobsOf('video_merge')).length, 1);
    });

    it('input channel: bad token 401, unknown name 404, stale attempt 409, frame replaced after planning → 409 input_changed', async () => {
        await setup({ ch: { sc: ['iu-a'] } });
        await readyAudio();
        await o.createCommand({ ...book, scope: { level: 'book' }, layers: ['image'] });
        await doImages(1);
        await cmd(['video']);
        const t = await claim('video');
        const name = t.input_files[0].name;
        assert.equal((await o.openInput(t.job_id, t.attempt, 'v1.1.bad', name)).status, 401);
        assert.equal((await o.openInput(t.job_id, t.attempt, t.upload_token, 'other.png')).status, 404);
        assert.equal((await o.openInput(t.job_id, t.attempt, t.upload_token, '../x.png')).status, 404);
        assert.equal((await o.openInput(t.job_id, t.attempt + 1, t.upload_token, name)).status, 401, 'token is per attempt');
        const job = (await jobsOf('video_group'))[0];
        fs.writeFileSync(job.input.inputs[0].path, noisePng(32, 24, 99));
        assert.deepEqual(await o.openInput(t.job_id, t.attempt, t.upload_token, name), { status: 409, code: 'input_changed' });
    });

    it('two groups accepted concurrently → exactly one video_merge', async () => {
        await setup();
        await readyAudio();
        await o.createCommand({ ...book, scope: { level: 'book' }, layers: ['image'] });
        await doImages(2);
        await cmd(['video']);
        const t1 = await claim('video'); const t2 = await claim('video');
        // a second worker for the parallel claim
        const r = await Promise.all([put(t1, mp4(11)), put(t2, mp4(12))]);
        assert.deepEqual(r.map((x) => x.status), [200, 200]);
        assert.equal(r[0].stage_jobs_created + r[1].stage_jobs_created, 1);
        assert.equal((await jobsOf('video_merge')).length, 1);
    });
});
