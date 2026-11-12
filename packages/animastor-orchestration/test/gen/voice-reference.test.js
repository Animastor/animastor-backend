'use strict';

// 1.4.0 — kind voice_reference (animastor-docs architecture/VOICE_REFERENCES.md)

const assert = require('node:assert/strict');
const path = require('path');
const gen = require('../../src/gen');
const { setupDb, makePorts, makeBook, makeWorker, streamOf, SECRET } = require('./helpers');

function wav({ seconds = 1, rate = 24000, amp = 8000, extra = null } = {}) {
    const n = Math.round(seconds * rate);
    const data = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i += 1) data.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / rate)), i * 2);
    const fmt = Buffer.alloc(16);
    fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(rate, 4);
    fmt.writeUInt32LE(rate * 2, 8); fmt.writeUInt16LE(2, 12); fmt.writeUInt16LE(16, 14);
    const chunk = (id, b) => Buffer.concat([Buffer.from(id, 'latin1'), Buffer.from(Uint32Array.of(b.length).buffer), b, b.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), chunk('data', data), extra ? chunk('LIST', extra) : Buffer.alloc(0)]);
    return Buffer.concat([Buffer.from('RIFF'), Buffer.from(Uint32Array.of(body.length).buffer), body]);
}

describe('gen v2 — voice_reference (1.4.0)', function () {
    this.timeout(30000);
    let ctx; let o; let book; let planned; let placed;

    beforeEach(async () => {
        ctx = await setupDb();
        planned = []; placed = [];
        const base = makePorts(ctx, { 'ch-1': { 'sc-1': 1 } });
        const ports = {
            ...base.ports,
            planUnits: async (b, scope, layer, planCtx) => {
                planned.push({ scope, layer, kind: planCtx && planCtx.kind });
                if (planCtx && planCtx.kind === 'voice_reference') {
                    return scope.voice.candidates.map((c) => ({
                        chapter_id: '_voices', scene_id: scope.voice.character_id, kind: 'voice_reference',
                        unit_key: c, build_id: 'build-1', input: { candidate_id: c },
                    }));
                }
                return base.ports.planUnits(b, scope, layer);
            },
            artifactPath: (job) => (job.kind === 'voice_reference'
                ? path.join(ctx.outputDir, job.build_id, 'voices', job.scene_id, `${job.unit_key}.wav`)
                : base.ports.artifactPath(job)),
            onArtifactPlaced: async (job, finalPath) => { placed.push({ kind: job.kind, finalPath }); },
        };
        o = gen.createOrchestration({ pool: ctx.pool, ports, uploadSecret: SECRET, outputDir: ctx.outputDir });
        book = await makeBook(ctx);
    });
    afterEach(async () => { o.stop(); await ctx.teardown(); });

    const voiceCmd = (extra = {}) => o.createCommand({
        ...book, kind: 'voice_reference', layers: ['audio'],
        scope: { level: 'book', voice: { character_id: 'anna', candidates: ['c1', 'c2', 'c3'] } }, ...extra,
    });

    it('creates voice_reference jobs on gpu:audio (layer audio), planCtx.kind passed, scope.voice stored', async () => {
        const r = await voiceCmd({ clientActionId: 'v1' });
        assert.deepEqual(r.summary, { jobs_created: 3, joined: 0, skipped_ready: 0 });
        assert.deepEqual(planned.map((p) => p.kind), ['voice_reference']);
        const rows = (await ctx.q(`SELECT kind, executor, layer, scene_id, unit_key FROM gen_jobs ORDER BY unit_key`)).rows;
        assert.deepEqual(rows.map((x) => [x.kind, x.executor, x.layer, x.scene_id, x.unit_key]),
            [['voice_reference', 'gpu:audio', 'audio', 'anna', 'c1'], ['voice_reference', 'gpu:audio', 'audio', 'anna', 'c2'], ['voice_reference', 'gpu:audio', 'audio', 'anna', 'c3']]);
        const c = (await ctx.q(`SELECT kind, scope FROM gen_commands`)).rows[0];
        assert.equal(c.kind, 'voice_reference');
        assert.deepEqual(c.scope.voice.candidates, ['c1', 'c2', 'c3']);
    });

    it('ignores the book layer-config (not a book layer); validates layers and scope', async () => {
        const r = await voiceCmd({ enabledLayers: [] });
        assert.equal(r.summary.jobs_created, 3);
        await assert.rejects(voiceCmd({ layers: ['image'] }), (e) => e.status === 400);
        await assert.rejects(voiceCmd({ scope: { level: 'scene', scene_id: 'x', voice: {} } }), (e) => e.status === 400);
        await assert.rejects(voiceCmd({ scope: { level: 'book' } }), (e) => e.status === 400);
    });

    it('a regenerate command may not plan voice_reference units, and vice versa', async () => {
        const bad = gen.createOrchestration({
            pool: ctx.pool, uploadSecret: SECRET, outputDir: ctx.outputDir,
            ports: { ...makePorts(ctx, {}).ports, planUnits: async () => [{ chapter_id: '_voices', scene_id: 'a', kind: 'voice_reference', unit_key: 'c', build_id: 'b', input: {} }] },
        });
        try {
            await assert.rejects(bad.createCommand({ ...book, kind: 'regenerate', scope: { level: 'book' }, layers: ['audio'] }), (e) => e.code === 'bad_plan');
        } finally { bad.stop(); }
    });

    it('claim → task with 15 min timeout; a valid WAV is accepted, placed, NO scene_assets row; no stage transition', async () => {
        await voiceCmd();
        const w = await makeWorker(ctx, { workspaceId: book.workspaceId });
        const { task } = await o.claim({ workerId: w, workerType: 'audio', mode: 'private', workspaceId: book.workspaceId });
        assert.equal(task.kind, 'voice_reference');
        assert.equal(task.timeout_ms, 15 * 60000);
        const r = await o.acceptResult(task.job_id, task.attempt, task.upload_token, streamOf(wav({ extra: Buffer.from('INFOICMT\u0002\u0000\u0000\u0000{}') })));
        assert.equal(r.status, 200);
        assert.equal(r.stage_jobs_created, 0);
        assert.equal(placed.length, 1);
        assert.match(placed[0].finalPath, /voices\/anna\/c\d\.wav$/);
        assert.equal(Number((await ctx.q(`SELECT count(*) AS n FROM scene_assets`)).rows[0].n), 0);
        assert.equal((await ctx.q(`SELECT status FROM gen_jobs WHERE job_id = $1`, [task.job_id])).rows[0].status, 'done');
    });

    it('a silent or non-WAV result is invalid_result', async () => {
        await voiceCmd();
        const w = await makeWorker(ctx, { workspaceId: book.workspaceId });
        const t1 = (await o.claim({ workerId: w, workerType: 'audio', mode: 'private', workspaceId: book.workspaceId })).task;
        const r1 = await o.acceptResult(t1.job_id, t1.attempt, t1.upload_token, streamOf(wav({ amp: 0 })));
        assert.equal(r1.status, 422); assert.equal(r1.reason, 'silence');
        const t2 = (await o.claim({ workerId: w, workerType: 'audio', mode: 'private', workspaceId: book.workspaceId })).task;
        const r2 = await o.acceptResult(t2.job_id, t2.attempt, t2.upload_token, streamOf(Buffer.from('ID3\u0003not a wav at all')));
        assert.equal(r2.status, 422); assert.equal(r2.reason, 'not_wav');
    });

    it('migration 005 is idempotent and the constraints accept the new kind only on gpu:audio / layer audio', async () => {
        await gen.migrate(ctx.pool);
        await gen.migrate(ctx.pool);
        const defs = (await ctx.q(`SELECT conname, pg_get_constraintdef(oid) AS d FROM pg_constraint
            WHERE conname IN ('gen_jobs_kind_check','gen_jobs_kind_executor_check','gen_jobs_layer_kind_check','gen_commands_kind_check')
              AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`)).rows;
        assert.equal(defs.length, 4);
        for (const d of defs) assert.match(d.d, /voice_reference/, d.conname);
        await voiceCmd();
        await assert.rejects(ctx.q(`UPDATE gen_jobs SET executor = 'gpu:image' WHERE kind = 'voice_reference'`), /gen_jobs_kind_executor_check/);
    });

    it('inspectWav reports format, data and duration', () => {
        const w = gen.media.inspectWav(wav({ seconds: 0.5 }));
        assert.equal(w.ok, true);
        assert.deepEqual(w.fmt, { format: 1, channels: 1, sampleRate: 24000, bitsPerSample: 16 });
        assert.equal(w.durationSec, 0.5);
        assert.equal(gen.media.inspectWav(Buffer.from('RIFF....WAVEfmt ')).ok, false);
    });
});
