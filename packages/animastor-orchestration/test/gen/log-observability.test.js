// ======================================================
// gen v2 — О3 observability (1.2.0): [gen-v2] info lines through the logger
// port, scene_assets.width/height for images, accepted files 0644
// ======================================================
// reports/2026-11-07/orch-v2-image-scene-run.md О3 + «мелочи».

'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const gen = require('../../src/gen');
const { formatGenEvent, createGenLog, msBetween } = require('../../src/gen/log');
const { setupDb, makePorts, makeBook, makeWorker, streamOf, SECRET, noisePng, makePng } = require('./helpers');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

describe('gen v2 — [gen-v2] log line format (О3)', () => {
    it('allowlisted fields only, stable order; tokens, paths and payloads never printed', () => {
        const line = formatGenEvent('claim', {
            upload_token: 'SECRET-TOKEN', params: { prompt: 'user text' }, result_path: '/data/output/x.png',
            job_id: 'j1', book_id: 'b1', attempt: 2, worker_id: 'w1', kind: 'iu_image', unit_key: 'iu-1', ms: 12,
        });
        assert.equal(line, '[gen-v2] claim book_id=b1 job_id=j1 kind=iu_image unit_key=iu-1 attempt=2 worker_id=w1 ms=12');
        assert.ok(!line.includes('SECRET-TOKEN') && !line.includes('user text') && !line.includes('/data/output'));
    });
    it('null/undefined fields are dropped, arrays joined, spaces quoted', () => {
        assert.equal(formatGenEvent('command-created', { command_id: 'c', layers: ['audio', 'image'], status: undefined, code: 'a b' }),
            '[gen-v2] command-created command_id=c code="a b" layers=audio,image');
    });
    it('the logger is a port: info → log → nothing; a throwing logger never breaks the core', () => {
        const seen = [];
        createGenLog({ info: (m) => seen.push(['info', m]), log: (m) => seen.push(['log', m]) }).event('accept', { job_id: 'j' });
        createGenLog({ log: (m) => seen.push(['log', m]) }).event('accept', { job_id: 'k' });
        createGenLog(null).event('accept', { job_id: 'x' });
        createGenLog({ info: () => { throw new Error('boom'); } }).event('accept', { job_id: 'y' });
        assert.deepEqual(seen, [['info', '[gen-v2] accept job_id=j'], ['log', '[gen-v2] accept job_id=k']]);
        assert.equal(msBetween(new Date(Date.now() - 50)) >= 50, true);
        assert.equal(msBetween(null), null);
    });
    it('the core never calls console directly (logger port only)', () => {
        const dir = path.join(__dirname, '..', '..', 'src', 'gen');
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
            const src = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
            const uses = (src.match(/console\.\w+\(/g) || []);
            assert.deepEqual(uses, [], `${f} calls console directly`);
        }
    });
});

describe('gen v2 — О3 events on a real run, image size, file mode', function () {
    this.timeout(30000);
    let ctx; let o; let book; let worker; let ports; let lines;

    async function setup(extra = {}) {
        ctx = await setupDb();
        ports = makePorts(ctx, { ch: { sc: 1 } }, extra);
        ports.ports.planUnits = async (b, scope, layer) => (layer === 'image' ? [{
            chapter_id: 'ch', scene_id: 'sc', kind: 'iu_image', unit_key: 'iu-a', build_id: 'build-1', scene_hash: 'image-v2:h',
            input: { workflow_json: '{}', part_hash: 'p1', scene_parts: [{ unit_key: 'iu-a', part_hash: 'p1' }] },
        }] : []);
        ports.ports.artifactPath = (job) => path.join(ctx.outputDir, job.build_id, `${job.book_id}_${job.unit_key}.png`);
        lines = [];
        o = gen.createOrchestration({
            pool: ctx.pool, ports: ports.ports, uploadSecret: SECRET, outputDir: ctx.outputDir,
            logger: { info: (m) => lines.push(m), error: (m) => lines.push(`ERR ${m}`) },
        });
        book = await makeBook(ctx);
        worker = await makeWorker(ctx, { workspaceId: book.workspaceId, type: 'image' });
    }
    afterEach(async () => { o.stop(); await ctx.teardown(); });
    const claim = async () => (await o.claim({ workerId: worker, workerType: 'image', mode: 'private', workspaceId: book.workspaceId })).task;
    const ev = (name) => lines.filter((l) => l.startsWith(`[gen-v2] ${name} `));

    it('command-created → claim → accept → command-finished, with ids, sha256, size and durations; no token in any line', async () => {
        await setup();
        const png = noisePng(64, 48);
        const c = await o.createCommand({ ...book, scope: { level: 'book' }, layers: ['image'] });
        const t = await claim();
        const r = await o.acceptResult(t.job_id, t.attempt, t.upload_token, streamOf(png));
        assert.equal(r.status, 200);
        assert.equal(r.width, undefined, 'internal width/height are not part of the API answer');
        await o.sweepOnce();

        const [created] = ev('command-created');
        assert.match(created, new RegExp(`book_id=${book.bookId} command_id=${c.command_id} .*layers=image .*jobs_created=1`));
        const [cl] = ev('claim');
        assert.match(cl, new RegExp(`command_id=${c.command_id} job_id=${t.job_id} kind=iu_image unit_key=iu-a attempt=1 max_attempts=\\d+ worker_id=${worker} ms=\\d+`));
        const [ac] = ev('accept');
        assert.match(ac, new RegExp(`job_id=${t.job_id} .*attempt=1 worker_id=${worker} sha256=${sha(png)} bytes=${png.length} width=64 height=48 .*ms=\\d+ run_ms=\\d+`));
        const [fin] = ev('command-finished');
        assert.match(fin, new RegExp(`command_id=${c.command_id} status=done done=1 failed=0 cancelled=0 run_ms=\\d+`));
        for (const l of lines) assert.ok(!l.includes(t.upload_token) && !l.includes(ctx.outputDir), l);

        const a = (await ctx.q(`SELECT status, width, height, path FROM scene_assets WHERE book_id = $1 AND asset_type = 'image'`, [book.bookId])).rows[0];
        assert.equal(a.status, 'ready'); assert.equal(a.width, 64); assert.equal(a.height, 48);
        assert.equal(fs.statSync(a.path).mode & 0o777, 0o644, 'accepted file is 0644 like legacy outputs');
        const parts = (await ctx.q(`SELECT metadata FROM scene_assets WHERE book_id = $1`, [book.bookId])).rows[0].metadata.gen_parts;
        assert.equal(parts['iu-a'].width, 64); assert.equal(parts['iu-a'].height, 48);
    });

    it('invalid result → error + requeue; stale attempt → error code=stale_attempt', async () => {
        await setup();
        await o.createCommand({ ...book, scope: { level: 'book' }, layers: ['image'] });
        const t = await claim();
        const bad = await o.acceptResult(t.job_id, t.attempt, t.upload_token, streamOf(makePng(16, 16, () => [0, 0, 0])));
        assert.equal(bad.status, 422);
        const [err] = ev('error');
        assert.match(err, new RegExp(`job_id=${t.job_id} .*attempt=1 .*job_status=queued error_class=invalid_result retry=true`));
        const [rq] = ev('requeue');
        assert.match(rq, new RegExp(`job_id=${t.job_id} .*attempt=1 .*error_class=invalid_result delay_ms=\\d+`));
        // the old attempt uploads again → 409 stale
        const stale = await o.acceptResult(t.job_id, t.attempt, t.upload_token, streamOf(noisePng(8, 8)));
        assert.equal(stale.status, 409);
        assert.ok(ev('error').some((l) => l.includes(`job_id=${t.job_id}`) && l.includes('code=stale_attempt')));
    });
});
