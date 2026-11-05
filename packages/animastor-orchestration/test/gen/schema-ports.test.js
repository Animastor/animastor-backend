'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const gen = require('../../src/gen');
const { setupDb, makePorts, uuid, fixture, fixtureDecodePcm, hasFfmpeg, SECRET, FIXTURES } = require('./helpers');

describe('gen v2 — schema (ADR §4)', function () {
    this.timeout(20000);
    let ctx;
    beforeEach(async () => { ctx = await setupDb(); });
    afterEach(async () => { await ctx.teardown(); });

    it('migration is idempotent (second and third run change nothing)', async () => {
        const before = (await ctx.q(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = $1`, [ctx.schema])).rows[0].n;
        await gen.migrate(ctx.pool);
        await gen.migrate(ctx.pool);
        const after = (await ctx.q(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = $1`, [ctx.schema])).rows[0].n;
        assert.equal(after, before);
    });

    it('has every ADR index, incl. the partial UNIQUE «one live job per unit» and UNIQUE(book_id, client_action_id)', async () => {
        const idx = (await ctx.q(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1`, [ctx.schema])).rows;
        const def = (n) => (idx.find((i) => i.indexname === n) || {}).indexdef || '';
        assert.match(def('idx_gen_jobs_claim'), /\(executor, status, not_before\) WHERE \(status = 'queued'::text\)/);
        assert.match(def('uniq_gen_jobs_live_unit'), /UNIQUE INDEX .*\(book_id, chapter_id, scene_id, kind, unit_key\) WHERE \(status = ANY \(ARRAY\['queued'::text, 'running'::text\]\)\)/);
        assert.match(def('idx_gen_jobs_deadline'), /\(deadline\) WHERE \(status = 'running'::text\)/);
        assert.match(def('idx_gen_jobs_command_status'), /\(command_id, status\)/);
        assert.match(def('gen_commands_client_action_uniq'), /UNIQUE INDEX .*\(book_id, client_action_id\)/);
    });

    it('CHECKs reject bad status / kind / executor / lane; books.orchestration defaults to legacy', async () => {
        await ctx.q(`INSERT INTO books (book_id, workspace_id) VALUES ('b1', $1)`, [uuid()]);
        assert.equal((await ctx.q(`SELECT orchestration FROM books WHERE book_id='b1'`)).rows[0].orchestration, 'legacy');
        await assert.rejects(ctx.q(`UPDATE books SET orchestration = 'v3' WHERE book_id = 'b1'`), /books_orchestration_check/);
        const c = (await ctx.q(
            `INSERT INTO gen_commands (workspace_id, user_id, book_id, kind, scope, layers) VALUES ($1, $1, 'b1', 'regenerate', '{"level":"book"}', '{audio}') RETURNING command_id`,
            [uuid()])).rows[0].command_id;
        await assert.rejects(ctx.q(`UPDATE gen_commands SET status = 'weird' WHERE command_id = $1`, [c]), /gen_commands_status_check/);
        await assert.rejects(ctx.q(`INSERT INTO gen_commands (workspace_id, user_id, book_id, kind, scope, layers) VALUES ($1, $1, 'b1', 'x', '{"level":"book"}', '{audio}')`, [uuid()]), /gen_commands_kind_check/);
        await assert.rejects(ctx.q(`INSERT INTO gen_commands (workspace_id, user_id, book_id, kind, scope, layers) VALUES ($1, $1, 'b1', 'regenerate', '{"level":"x"}', '{audio}')`, [uuid()]), /gen_commands_scope_check/);
        await assert.rejects(ctx.q(`INSERT INTO gen_commands (workspace_id, user_id, book_id, kind, scope, layers) VALUES ($1, $1, 'b1', 'regenerate', '{"level":"book"}', '{music}')`, [uuid()]), /gen_commands_layers_check/);
        const job = (cols) => ctx.q(
            `INSERT INTO gen_jobs (command_id, workspace_id, user_id, book_id, chapter_id, scene_id, unit_key, kind, executor, lane, status)
             VALUES ($1, $2, $2, 'b1', 'c', 's', 'u', $3, $4, $5::jsonb, $6)`, [c, uuid(), cols.kind, cols.executor, cols.lane, cols.status || 'queued']);
        await job({ kind: 'audio_chunk', executor: 'gpu:audio', lane: '{"kind":"system"}' });
        await assert.rejects(job({ kind: 'audio_chunk', executor: 'gpu:audio', lane: '{"kind":"system"}', status: 'lost' }), /gen_jobs_status_check/);
        await assert.rejects(job({ kind: 'song', executor: 'gpu:audio', lane: '{"kind":"system"}' }), /gen_jobs_kind_check/);
        await assert.rejects(job({ kind: 'audio_chunk', executor: 'gpu:video', lane: '{"kind":"system"}' }), /gen_jobs_kind_executor_check/);
        await assert.rejects(job({ kind: 'audio_chunk', executor: 'cpu', lane: '{"kind":"system"}' }), /gen_jobs_executor_check/);
        await assert.rejects(job({ kind: 'audio_chunk', executor: 'gpu:audio', lane: '{"kind":"public"}' }), /gen_jobs_lane_check/);
        await assert.rejects(job({ kind: 'audio_merge', executor: 'local', lane: '{"kind":"system"}' }), /gen_jobs_lane_check/);
        // a second LIVE row of the same unit is impossible
        await assert.rejects(job({ kind: 'audio_chunk', executor: 'gpu:audio', lane: '{"kind":"system"}' }), /uniq_gen_jobs_live_unit/);
        const cols = (await ctx.q(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'workers'`, [ctx.schema])).rows.map((r) => r.column_name);
        assert.ok(cols.includes('current_job_id'));
    });
});

describe('gen v2 — ports (contract + validation)', () => {
    const fakePool = { connect() {}, query() {} };
    const base = () => makePorts({ outputDir: '/tmp' }, {}).ports;

    it('createOrchestration rejects missing / malformed ports and config', () => {
        for (const name of gen.REQUIRED_PORTS) {
            const ports = base(); delete ports[name];
            assert.throws(() => gen.createOrchestration({ pool: fakePool, ports, uploadSecret: SECRET }), new RegExp(name));
        }
        assert.throws(() => gen.createOrchestration({ pool: fakePool, ports: { ...base(), timeoutFor: () => 0 }, uploadSecret: SECRET }), /timeoutFor/);
        assert.throws(() => gen.createOrchestration({ pool: fakePool, ports: { ...base(), retryPolicy: () => ({}) }, uploadSecret: SECRET }), /retryPolicy/);
        assert.throws(() => gen.createOrchestration({ pool: fakePool, ports: { ...base(), isLayerEnabled: 1 }, uploadSecret: SECRET }), /isLayerEnabled/);
        assert.throws(() => gen.createOrchestration({ pool: fakePool, ports: base(), uploadSecret: 'short' }), /uploadSecret/);
        assert.throws(() => gen.createOrchestration({ pool: null, ports: base(), uploadSecret: SECRET }), /pool/);
        assert.ok(gen.createOrchestration({ pool: fakePool, ports: base(), uploadSecret: SECRET }));
    });

    it('default retry policy = gpu-retry-policy.cjs:50–53 (TRANSIENT 30/120 s, OOM 60 s, DETERMINISTIC/UNKNOWN 0)', () => {
        const rp = gen.defaults.retryPolicy;
        assert.deepEqual(rp('audio_chunk', 'transient', 1), { retry: true, delay_ms: 30000 });
        assert.deepEqual(rp('audio_chunk', 'transient', 2), { retry: true, delay_ms: 120000 });
        assert.deepEqual(rp('audio_chunk', 'transient', 3), { retry: false, delay_ms: 0 });
        assert.deepEqual(rp('audio_chunk', 'oom', 1), { retry: true, delay_ms: 60000 });
        assert.deepEqual(rp('audio_chunk', 'oom', 2), { retry: false, delay_ms: 0 });
        assert.deepEqual(rp('audio_chunk', 'deterministic', 1), { retry: false, delay_ms: 0 });
        assert.deepEqual(rp('audio_chunk', 'unknown', 1), { retry: false, delay_ms: 0 });
        assert.deepEqual(rp('audio_chunk', 'timeout', 1), { retry: true, delay_ms: 30000 });       // sweeper class
        assert.deepEqual(rp('audio_chunk', 'worker_offline', 2), { retry: true, delay_ms: 120000 });
        assert.deepEqual(rp('audio_chunk', 'invalid_result', 1), { retry: false, delay_ms: 0 });
        assert.equal(gen.defaults.maxAttemptsFor('audio_chunk'), 3);
        assert.equal(gen.defaults.timeoutFor('audio_chunk'), 30 * 60000);
        assert.equal(gen.defaults.timeoutFor('video_group'), 60 * 60000);
    });

    it('makeLaneFor = gpu-dispatcher.js:213–222: private worker → private; else grant → policy; else system', async () => {
        const ws = uuid(); const pol = uuid();
        const lf = (hasPriv, grant) => gen.defaults.makeLaneFor({
            hasActivePrivateWorker: async () => hasPriv, grantPolicyLane: async () => grant,
        });
        assert.deepEqual(await lf(true, { policy_id: pol })(ws, 'audio'), { kind: 'private', workspace_id: ws });
        assert.deepEqual(await lf(false, { policy_id: pol })(ws, 'audio'), { kind: 'policy', policy_id: pol });
        assert.deepEqual(await lf(false, null)(ws, 'audio'), { kind: 'system' });
        assert.deepEqual(await lf(true, null)(null, 'audio'), { kind: 'system' });
    });
});

describe('gen v2 — media validation (ADR §7 п.1, §13.4)', () => {
    it('MP3: magic bytes + duration from frame headers', () => {
        const ok = gen.media.inspectMp3(fixture('tone.mp3'));
        assert.equal(ok.ok, true);
        assert.ok(ok.durationSec > 1.4 && ok.durationSec < 1.8, `duration ${ok.durationSec}`);
        assert.deepEqual(gen.media.inspectMp3(Buffer.alloc(4096, 7)), { ok: false, reason: 'not_mp3' });
        assert.deepEqual(gen.media.inspectMp3(Buffer.alloc(10)), { ok: false, reason: 'too_small' });
        const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1000)]);
        assert.equal(gen.media.inspectMp3(png).ok, false);
    });

    it('audio: tone accepted, digital silence and near-silence rejected (RMS threshold is a parameter)', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-media-'));
        try {
            const v = gen.defaults.createAudioValidator({ decodePcm: fixtureDecodePcm, rmsThresholdDbfs: -60 });
            for (const f of ['tone', 'silence', 'quiet']) fs.copyFileSync(path.join(FIXTURES, `${f}.mp3`), path.join(tmp, `${f}.mp3`));
            assert.equal((await v(path.join(tmp, 'tone.mp3'))).ok, true);
            assert.equal((await v(path.join(tmp, 'silence.mp3'))).reason, 'silence');
            assert.equal((await v(path.join(tmp, 'quiet.mp3'))).reason, 'silence');                     // -87 dBFS < -60
            const lax = gen.defaults.createAudioValidator({ decodePcm: fixtureDecodePcm, rmsThresholdDbfs: -100 });
            assert.equal((await lax(path.join(tmp, 'quiet.mp3'))).ok, true);                              // threshold honoured
            const noDecoder = gen.defaults.createAudioValidator({ decodePcm: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
            assert.equal((await noDecoder(path.join(tmp, 'tone.mp3'))).reason, 'decoder_unavailable');  // fail-closed
        } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    });

    it('default ffmpeg decoder agrees with the recorded decode (skipped without ffmpeg)', async function () {
        if (!hasFfmpeg()) this.skip();
        const v = gen.defaults.createAudioValidator({ rmsThresholdDbfs: -60 });
        assert.equal((await v(path.join(FIXTURES, 'tone.mp3'))).ok, true);
        assert.equal((await v(path.join(FIXTURES, 'silence.mp3'))).reason, 'silence');
        assert.equal((await v(path.join(FIXTURES, 'quiet.mp3'))).reason, 'silence');
        const pcm = await gen.media.ffmpegDecodePcm(path.join(FIXTURES, 'tone.mp3'));
        const rec = await fixtureDecodePcm(path.join(FIXTURES, 'tone.mp3'));
        assert.ok(Math.abs(gen.media.rmsDbfs(pcm) - gen.media.rmsDbfs(rec)) < 0.5);
    });

    it('image / video magic bytes', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-media-'));
        try {
            const v = gen.defaults.createDefaultValidateResult({ decodePcm: fixtureDecodePcm });
            fs.writeFileSync(path.join(tmp, 'a.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]));
            fs.writeFileSync(path.join(tmp, 'a.mp4'), Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64)]));
            assert.equal((await v({ kind: 'iu_image' }, path.join(tmp, 'a.png'))).ok, true);
            assert.equal((await v({ kind: 'iu_image' }, path.join(tmp, 'a.mp4'))).ok, false);
            assert.equal((await v({ kind: 'video_group' }, path.join(tmp, 'a.mp4'))).ok, true);
            assert.equal((await v({ kind: 'video_merge' }, path.join(tmp, 'a.png'))).ok, false);
        } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    });
});
