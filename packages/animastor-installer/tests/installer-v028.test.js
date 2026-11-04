// =====================================================
// Installer 0.2.8 — `doctor` does not restart a healthy or busy worker
// =====================================================
// 04.11 (reports/2026-11-04/gpu-generation-stall.md §8): `animastor doctor`
// restarted the audio worker at 13:55:15Z and the image worker at 13:58:52Z
// — between tasks only by chance. Cause: configureEnv rewrote an UNCHANGED
// .env on every run, its new mtime made workerEnvIsNewer() true and
// startWorker() killed the running worker.
//   D1  healthy worker, configuration unchanged → no-op ("left as is");
//   D2  busy worker is never restarted (no config change → left; config
//       change → waits, still busy at --wait-job-ms → deferred = FAILED);
//   D3  boot (doctor --yes, no TTY): starts a stopped worker, never restarts
//       a running one;
//   D4  changed .env → restart AFTER the task finished;
//   D5  --force restarts a busy worker; unknown busy state → deferred;
//   D6  an unchanged .env is not rewritten (mtime kept);
//   D7  activity from the worker's own log (Task/Done/Failed/Rejecting);
//   D8  CLI: --wait-job-ms / --force, `current job:` in doctor and status;
//   D9  `animastor start` never kills a busy worker for a stale .env.
// Run: npx mocha --exit tests/installer-v028.test.js
// =====================================================

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const realFs = require('fs');

const { createRealIo } = require('../src/installer/engine/io');
const worker = require('../src/installer/engine/worker');
const engine = require('../src/installer/engine/engine');
const management = require('../src/installer/management');
const { renderFinalSummary } = require('../src/installer/engine/summary');
const cli = require('../src/installer/cli');
const pkg = require('../package.json');

const PID = 4242;
const T0 = 1_700_000_000_000; // fixed clock in the past: worker start

function line(ts, level, msg) {
    return `[${new Date(ts).toISOString()}] [${level}] ${msg}`;
}
const STARTED = [
    line(T0, 'info', 'Worker audio started'),
    line(T0 + 10, 'info', 'Worker ID: w1 (label only — identity comes from the credential)'),
    line(T0 + 2000, 'info', 'ComfyUI ready'),
    line(T0 + 3000, 'info', 'Node classes ready: 7/7 (audio/qwen-tts)'),
    line(T0 + 4000, 'info', 'Hub heartbeat accepted — worker is ONLINE'),
];
const TASK = (id) => line(T0 + 5000, 'info', `Task ${id} (type=audio, timeout_ms=default)`);
const DONE = (id) => line(T0 + 9000, 'info', `Done ${id}`);

/** A fake installation: <base>/worker (+.env, bundle), <base>/logs/worker.{log,pid}. */
function makeInstall(tmp, { logLines = STARTED, envNewer = false, bundleNewer = false } = {}) {
    const workerDir = path.join(tmp, 'worker');
    const logs = path.join(tmp, 'logs');
    realFs.mkdirSync(workerDir, { recursive: true });
    realFs.mkdirSync(logs, { recursive: true });
    const sec = (ms) => ms / 1000;
    for (const f of ['worker.cjs', 'package.json']) {
        realFs.writeFileSync(path.join(workerDir, f), f === 'package.json' ? '{"version":"2.2.3"}' : '// worker');
        realFs.utimesSync(path.join(workerDir, f), sec(T0 - 60000), sec(bundleNewer && f === 'worker.cjs' ? T0 + 60000 : T0 - 60000));
    }
    realFs.writeFileSync(path.join(workerDir, '.env'), 'WORKER_TYPE=audio\nCOMFY_PORT=8188\n');
    realFs.utimesSync(path.join(workerDir, '.env'), sec(T0 - 60000), sec(envNewer ? T0 + 60000 : T0 - 60000));
    // pid file mtime = the worker's start time
    realFs.writeFileSync(path.join(logs, 'worker.pid'), `${PID}\n`);
    realFs.utimesSync(path.join(logs, 'worker.pid'), sec(T0), sec(T0));
    const logFile = path.join(logs, 'worker.log');
    if (logLines) {
        realFs.writeFileSync(logFile, logLines.join('\n') + '\n');
        realFs.utimesSync(logFile, sec(T0 + 5000), sec(T0 + 5000));
    }
    return { workerDir, logFile };
}

/** Platform adapter stub: process lookup only (no real processes touched). */
function adapterStub(state) {
    return {
        findPidsByCmdlineAndCwd: () => (state.running ? [state.pid || PID] : []),
        processStartMs: () => null,
        killCommand: (pid) => ({ cmd: 'true', args: [String(pid)] }),
        sleepCommand: () => ({ cmd: 'true', args: [] }),
    };
}

/** startWorker stand-in: records the call, never spawns. */
function startStub(calls) {
    return (io, opts) => {
        calls.push({ forceRestart: !!opts.forceRestart });
        return { started: true, pid: 5151, alive: true, reason: null, logFile: opts.logFile, logOffset: 0 };
    };
}

function fakeClockIo(start = T0 + 10000) {
    const clock = { t: start };
    const io = { ...createRealIo(), now: () => clock.t };
    return { io, clock };
}

function logCollector() {
    const lines = [];
    return { lines, info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`), error: (m) => lines.push(`error ${m}`) };
}

describe('0.2.8 D1 healthy worker, configuration unchanged → no-op', () => {
    let tmp;
    beforeEach(() => { tmp = realFs.mkdtempSync(path.join(os.tmpdir(), 'anim-v028-')); });
    afterEach(() => { realFs.rmSync(tmp, { recursive: true, force: true }); });

    it('D1a: left as is, startWorker not called, "worker already running (pid N), left as is"', async () => {
        const { workerDir } = makeInstall(tmp);
        const calls = [];
        const log = logCollector();
        const { io } = fakeClockIo();
        const r = await worker.ensureWorker(io, {
            workerDir, platformAdapter: adapterStub({ running: true }), startFn: startStub(calls), log,
        });
        assert.strictEqual(r.action, 'left');
        assert.strictEqual(r.already_running, true);
        assert.strictEqual(r.pid, PID);
        assert.strictEqual(r.current_job, 'none');
        assert.deepStrictEqual(r.restart_reasons, []);
        assert.strictEqual(calls.length, 0, 'startWorker (which can kill) is not called at all');
        assert.ok(log.lines.includes(`info worker already running (pid ${PID}), left as is`), log.lines.join('\n'));
    });

    it('D1b: also with --force: --force bypasses only the busy guard, not "no restart needed"', async () => {
        const { workerDir } = makeInstall(tmp);
        const calls = [];
        const { io } = fakeClockIo();
        const r = await worker.ensureWorker(io, {
            workerDir, platformAdapter: adapterStub({ running: true }), startFn: startStub(calls), force: true,
        });
        assert.strictEqual(r.action, 'left');
        assert.strictEqual(calls.length, 0);
    });
});

describe('0.2.8 D2 a busy worker is not restarted', () => {
    let tmp;
    beforeEach(() => { tmp = realFs.mkdtempSync(path.join(os.tmpdir(), 'anim-v028-')); });
    afterEach(() => { realFs.rmSync(tmp, { recursive: true, force: true }); });

    it('D2a: busy, configuration unchanged → left as is, current job reported', async () => {
        const { workerDir } = makeInstall(tmp, { logLines: [...STARTED, TASK('book_ch1_sc1_0001:audio')] });
        const calls = [];
        const { io } = fakeClockIo();
        const r = await worker.ensureWorker(io, { workerDir, platformAdapter: adapterStub({ running: true }), startFn: startStub(calls) });
        assert.strictEqual(r.action, 'left');
        assert.strictEqual(r.current_job, 'book_ch1_sc1_0001:audio');
        assert.strictEqual(calls.length, 0);
    });

    it('D2b: busy + .env changed, task outlives --wait-job-ms → deferred (FAILED), never killed', async () => {
        const { workerDir } = makeInstall(tmp, { envNewer: true, logLines: [...STARTED, TASK('job-A')] });
        const calls = [];
        const log = logCollector();
        const { io, clock } = fakeClockIo();
        const sleeps = [];
        const r = await worker.ensureWorker(io, {
            workerDir, platformAdapter: adapterStub({ running: true }), startFn: startStub(calls), log,
            waitJobMs: 20000, pollMs: 5000,
            sleep: async (ms) => { sleeps.push(ms); clock.t += ms; },
        });
        assert.strictEqual(r.action, 'deferred');
        assert.strictEqual(r.deferred, true);
        assert.strictEqual(r.started, false);
        assert.strictEqual(r.busy_job, 'job-A');
        assert.strictEqual(r.current_job, 'job-A');
        assert.strictEqual(calls.length, 0, 'no restart while busy');
        assert.strictEqual(sleeps.reduce((a, b) => a + b, 0), 20000, 'waited exactly --wait-job-ms');
        assert.ok(/worker is busy with job-A \(pid 4242\) — restart deferred \(waited 20 s; needed for: \.env changed after the worker started\)/.test(r.reason), r.reason);
        assert.ok(r.reason.includes('animastor doctor --force'), r.reason);
    });

    it('D2c: the deferred restart is FAILED in the result: ✗ "Worker restart", summary not ok (exit 1)', async () => {
        const workerStart = {
            deferred: true, pid: PID, busy_job: 'job-A', action: 'deferred',
            reason: 'worker is busy with job-A (pid 4242) — restart deferred (waited 600 s; needed for: .env changed by this run); re-run `animastor doctor` when the task finishes, or `animastor doctor --force` to restart now (the task\'s result is lost)',
        };
        const checks = await engine.endToEndChecks(createRealIo(), {
            mode: 'existing', comfyUrl: null, comfyPort: 1, hubUrl: 'https://hub.invalid/gpu', workerWanted: true, workerStart, workerReady: null,
        });
        const restart = checks.find((c) => c.label === 'Worker restart');
        assert.ok(restart, JSON.stringify(checks));
        assert.strictEqual(restart.ok, false);
        assert.ok(restart.detail.includes('busy with job-A'));
        assert.ok(restart.fix.includes('animastor doctor --force') && restart.fix.includes('--wait-job-ms'), restart.fix);
        const summary = renderFinalSummary({ e2e: checks.filter((c) => c.id !== 'comfyui') });
        assert.strictEqual(summary.ok, false, 'FAILED → printResult sets exit code 1');
        assert.ok(summary.text.includes('✗ Worker restart: worker is busy with job-A'), summary.text);
    });
});

describe('0.2.8 D3 boot path starts a stopped worker only', () => {
    let tmp;
    beforeEach(() => { tmp = realFs.mkdtempSync(path.join(os.tmpdir(), 'anim-v028-')); });
    afterEach(() => { realFs.rmSync(tmp, { recursive: true, force: true }); });

    it('D3a: boot, worker not running → started', async () => {
        const { workerDir } = makeInstall(tmp, { envNewer: true });
        const calls = [];
        const { io } = fakeClockIo();
        const r = await worker.ensureWorker(io, {
            workerDir, platformAdapter: adapterStub({ running: false }), startFn: startStub(calls), boot: true,
            configChanged: ['.env changed by this run'],
        });
        assert.strictEqual(r.action, 'started');
        assert.deepStrictEqual(calls, [{ forceRestart: false }]);
        assert.strictEqual(r.current_job, 'none');
    });

    it('D3b: boot, worker running, configuration changed → left as is, restart pending', async () => {
        const { workerDir } = makeInstall(tmp, { envNewer: true });
        const calls = [];
        const log = logCollector();
        const { io } = fakeClockIo();
        const r = await worker.ensureWorker(io, {
            workerDir, platformAdapter: adapterStub({ running: true }), startFn: startStub(calls), boot: true, log,
        });
        assert.strictEqual(r.action, 'left');
        assert.deepStrictEqual(r.restart_pending, ['.env changed after the worker started']);
        assert.strictEqual(calls.length, 0);
        assert.ok(log.lines.some((l) => l.startsWith(`warn worker already running (pid ${PID}), left as is — restart pending`)), log.lines.join('\n'));
    });

    it('D3c: installOptions — boot only for `doctor --yes` without a TTY; --force/--wait-job-ms carried', () => {
        const prev = process.env.ANIMASTOR_BOOT;
        process.env.ANIMASTOR_BOOT = '1';
        try {
            const boot = cli.installOptions(cli.parseArgs(['n', 'c', 'doctor', '--yes']).flags, { doctor: true });
            assert.strictEqual(boot.boot, true);
            assert.strictEqual(boot.startWorker, true);
            const inst = cli.installOptions(cli.parseArgs(['n', 'c', 'install', '--yes', '--profile', 'audio/qwen-tts']).flags, { doctor: false });
            assert.strictEqual(inst.boot, false);
            const f = cli.installOptions(cli.parseArgs(['n', 'c', 'doctor', '--force', '--wait-job-ms', '1500']).flags, { doctor: true });
            assert.strictEqual(f.forceWorkerRestart, true);
            assert.strictEqual(f.waitJobMs, 1500);
            assert.strictEqual(f.boot, false, 'no --yes → not boot');
            assert.strictEqual(cli.installOptions(cli.parseArgs(['n', 'c', 'doctor']).flags, { doctor: true }).waitJobMs, undefined, 'default from the engine (600 s)');
        } finally {
            if (prev === undefined) delete process.env.ANIMASTOR_BOOT; else process.env.ANIMASTOR_BOOT = prev;
        }
        assert.strictEqual(worker.DEFAULT_WAIT_JOB_MS, 600000);
    });
});

describe('0.2.8 D4 changed .env → restart after the task finished', () => {
    let tmp;
    beforeEach(() => { tmp = realFs.mkdtempSync(path.join(os.tmpdir(), 'anim-v028-')); });
    afterEach(() => { realFs.rmSync(tmp, { recursive: true, force: true }); });

    it('D4a: waits while busy, restarts once "Done <id>" is logged', async () => {
        const { workerDir, logFile } = makeInstall(tmp, { envNewer: true, logLines: [...STARTED, TASK('job-B')] });
        const calls = [];
        const log = logCollector();
        const { io, clock } = fakeClockIo();
        let polls = 0;
        const r = await worker.ensureWorker(io, {
            workerDir, platformAdapter: adapterStub({ running: true }), startFn: startStub(calls), log,
            pollMs: 5000,
            sleep: async (ms) => {
                clock.t += ms;
                polls += 1;
                assert.strictEqual(calls.length, 0, 'not restarted while the task runs');
                if (polls === 3) realFs.appendFileSync(logFile, `${DONE('job-B')}\n${line(T0 + 9100, 'info', 'Cleanup job-B: removed 2 artifact(s) (1 input, 1 output)')}\n`);
            },
        });
        assert.strictEqual(polls, 3);
        assert.strictEqual(r.action, 'restarted');
        assert.strictEqual(r.restarted_from, PID);
        assert.deepStrictEqual(calls, [{ forceRestart: true }]);
        assert.strictEqual(r.current_job, 'none');
        assert.ok(log.lines.some((l) => l.includes('worker is busy with job-B (pid 4242) — waiting up to 600 s')), log.lines.join('\n'));
        assert.ok(log.lines.some((l) => l.includes('finished job-B')), log.lines.join('\n'));
    });

    it('D4b: idle + changed bundle → restarted at once', async () => {
        const { workerDir } = makeInstall(tmp, { bundleNewer: true });
        const calls = [];
        const { io } = fakeClockIo();
        const r = await worker.ensureWorker(io, {
            workerDir, platformAdapter: adapterStub({ running: true }), startFn: startStub(calls),
            sleep: async () => { throw new Error('must not wait'); },
        });
        assert.strictEqual(r.action, 'restarted');
        assert.deepStrictEqual(r.restart_reasons, ['worker.cjs changed after the worker started']);
        assert.deepStrictEqual(calls, [{ forceRestart: true }]);
    });

    it('D4c: worker exits while waited for → simply started', async () => {
        const { workerDir } = makeInstall(tmp, { envNewer: true, logLines: [...STARTED, TASK('job-C')] });
        const calls = [];
        const st = { running: true };
        const { io, clock } = fakeClockIo();
        const r = await worker.ensureWorker(io, {
            workerDir, platformAdapter: adapterStub(st), startFn: startStub(calls),
            sleep: async (ms) => { clock.t += ms; st.running = false; },
        });
        assert.strictEqual(r.action, 'started');
        assert.deepStrictEqual(calls, [{ forceRestart: false }]);
    });
});

describe('0.2.8 D5 --force and an unknown busy state', () => {
    let tmp;
    beforeEach(() => { tmp = realFs.mkdtempSync(path.join(os.tmpdir(), 'anim-v028-')); });
    afterEach(() => { realFs.rmSync(tmp, { recursive: true, force: true }); });

    it('D5a: --force restarts a busy worker immediately (with a warning)', async () => {
        const { workerDir } = makeInstall(tmp, { envNewer: true, logLines: [...STARTED, TASK('job-D')] });
        const calls = [];
        const log = logCollector();
        const { io } = fakeClockIo();
        const r = await worker.ensureWorker(io, {
            workerDir, platformAdapter: adapterStub({ running: true }), startFn: startStub(calls), force: true, log,
            sleep: async () => { throw new Error('must not wait'); },
        });
        assert.strictEqual(r.action, 'restarted');
        assert.deepStrictEqual(calls, [{ forceRestart: true }]);
        assert.ok(log.lines.some((l) => l.startsWith('warn --force: restarting the worker (pid 4242) while it is busy with job-D')), log.lines.join('\n'));
    });

    it('D5b: no worker log → busy state unknown → deferred, not killed', async () => {
        const { workerDir } = makeInstall(tmp, { envNewer: true, logLines: null });
        const calls = [];
        const { io } = fakeClockIo();
        const r = await worker.ensureWorker(io, { workerDir, platformAdapter: adapterStub({ running: true }), startFn: startStub(calls) });
        assert.strictEqual(r.action, 'deferred');
        assert.strictEqual(r.current_job, 'unknown');
        assert.ok(r.reason.includes('cannot tell whether the worker (pid 4242) is busy'), r.reason);
        assert.strictEqual(calls.length, 0);
    });

    it('D5c: a log last written before this process started is not its log → unknown', () => {
        const { workerDir, logFile } = makeInstall(tmp, { logLines: [...STARTED, TASK('old')] });
        realFs.utimesSync(logFile, (T0 - 30000) / 1000, (T0 - 30000) / 1000);
        const a = worker.readWorkerActivity(createRealIo(), { workerDir, pid: PID });
        assert.strictEqual(a.known, false);
        assert.ok(a.reason.includes('not written by the running worker'), a.reason);
    });

    it('D5d: decideWorkerAction table', () => {
        const busy = { known: true, current_job_id: 'j' };
        const idle = { known: true, current_job_id: null };
        const R = ['x'];
        assert.strictEqual(worker.decideWorkerAction({ pid: null, reasons: R }).action, 'start');
        assert.strictEqual(worker.decideWorkerAction({ pid: 1, reasons: [], activity: busy }).action, 'leave');
        assert.strictEqual(worker.decideWorkerAction({ pid: 1, reasons: R, activity: busy, boot: true }).action, 'leave');
        assert.strictEqual(worker.decideWorkerAction({ pid: 1, reasons: R, activity: busy, boot: true, force: true }).action, 'restart');
        assert.strictEqual(worker.decideWorkerAction({ pid: 1, reasons: R, activity: busy }).action, 'wait');
        assert.strictEqual(worker.decideWorkerAction({ pid: 1, reasons: R, activity: idle }).action, 'restart');
        assert.strictEqual(worker.decideWorkerAction({ pid: 1, reasons: R, activity: { known: false } }).action, 'defer');
    });
});

describe('0.2.8 D6 an unchanged .env is not rewritten', () => {
    let tmp;
    beforeEach(() => { tmp = realFs.mkdtempSync(path.join(os.tmpdir(), 'anim-v028-')); });
    afterEach(() => { realFs.rmSync(tmp, { recursive: true, force: true }); });

    const manifest = { worker_bundle: { env: { required: ['HUB_URL', 'WORKER_TYPE'], secrets: ['ANIMASTOR_WORKER_TOKEN'] } } };

    it('D6a: same values → no write, mtime kept; a real change → written', () => {
        const io = createRealIo();
        const envPath = path.join(tmp, '.env');
        realFs.writeFileSync(envPath, 'HUB_URL=https://animastor.org/gpu\nWORKER_TYPE=audio\nANIMASTOR_WORKER_TOKEN=wrk.secret\n');
        realFs.utimesSync(envPath, 1000, 1000);
        const r1 = worker.configureEnv(io, {
            workerDir: tmp, manifest,
            values: { HUB_URL: 'https://animastor.org/gpu', WORKER_TYPE: 'audio' },
            overrides: { WORKER_TYPE: 'audio' },
        });
        assert.deepStrictEqual(r1.changed, []);
        assert.deepStrictEqual(r1.added, []);
        assert.strictEqual(r1.created, false);
        assert.strictEqual(realFs.statSync(envPath).mtimeMs, 1000 * 1000, 'mtime untouched');
        assert.strictEqual((realFs.statSync(envPath).mode & 0o777), 0o600);
        const r2 = worker.configureEnv(io, { workerDir: tmp, manifest, values: {}, overrides: { WORKER_TYPE: 'image' } });
        assert.deepStrictEqual(r2.changed, ['WORKER_TYPE']);
        assert.ok(realFs.statSync(envPath).mtimeMs > 1000 * 1000, 'rewritten on a real change');
        assert.ok(realFs.readFileSync(envPath, 'utf8').includes('WORKER_TYPE=image'));
    });

    it('D6b: workerConfigNewer — only files newer than the process start', () => {
        const { workerDir } = makeInstall(tmp, { envNewer: true, bundleNewer: true });
        const changed = worker.workerConfigNewer(createRealIo(), { workerDir, pid: PID, platformAdapter: adapterStub({}) });
        assert.deepStrictEqual(changed, ['.env', 'worker.cjs']);
        assert.deepStrictEqual(worker.workerConfigNewer(createRealIo(), { workerDir, pid: 999, platformAdapter: adapterStub({}) }), [],
            'unknown start time (pid file names another pid) → no restart on a guess');
    });
});

describe('0.2.8 D7 activity from the worker log', () => {
    it('D7a: Task/Done/Failed/Rejecting, only the current process', () => {
        const p = (lines) => worker.parseWorkerActivity(lines.join('\n'));
        assert.strictEqual(p([...STARTED, TASK('a')]).current_job_id, 'a');
        assert.strictEqual(p([...STARTED, TASK('a'), DONE('a')]).current_job_id, null);
        assert.strictEqual(p([...STARTED, TASK('a'), DONE('a')]).last_job_id, 'a');
        assert.strictEqual(p([...STARTED, TASK('a'), line(T0, 'error', 'Failed a'), '"ComfyUI execution error"']).current_job_id, null);
        // "Failed to send error to hub" is not the end of task "to"
        assert.strictEqual(p([...STARTED, TASK('a'), line(T0, 'error', 'Failed to send error to hub')]).current_job_id, 'a');
        assert.strictEqual(p([...STARTED, TASK('a'), line(T0, 'error', 'Rejecting incompatible task: protocol=1, dispatch=missing')]).current_job_id, null);
        // a task of the PREVIOUS process (killed mid-task) does not count
        assert.strictEqual(p([...STARTED, TASK('old'), ...STARTED]).current_job_id, null);
    });

    it('D7b: health = ComfyUI ready + latest beacon accepted', () => {
        assert.strictEqual(worker.parseWorkerActivity(STARTED.join('\n')).healthy, true);
        const failing = [...STARTED, line(T0 + 50000, 'error', 'Beacon failed'), 'fetch failed'];
        const a = worker.parseWorkerActivity(failing.join('\n'));
        assert.strictEqual(a.healthy, false);
        assert.strictEqual(a.heartbeat, false);
        assert.strictEqual(worker.parseWorkerActivity([...failing, line(T0 + 60000, 'info', 'Hub heartbeat accepted — worker is ONLINE')].join('\n')).healthy, true);
    });
});

describe('0.2.8 D8 CLI flags and the `current job:` line', () => {
    let tmp;
    beforeEach(() => { tmp = realFs.mkdtempSync(path.join(os.tmpdir(), 'anim-v028-')); });
    afterEach(() => { realFs.rmSync(tmp, { recursive: true, force: true }); });

    it('D8a: --force is boolean, --wait-job-ms takes milliseconds, garbage is a usage error', () => {
        const ok = cli.parseArgs(['n', 'c', 'doctor', '--wait-job-ms', '0', '--force']);
        assert.deepStrictEqual(ok.errors, []);
        assert.strictEqual(ok.flags['wait-job-ms'], '0');
        assert.strictEqual(ok.flags.force, true);
        assert.ok(cli.parseArgs(['n', 'c', 'doctor', '--wait-job-ms', '10m']).errors.some((e) => e.includes('--wait-job-ms needs a number')));
        assert.ok(cli.parseArgs(['n', 'c', 'doctor', '--force=yes']).errors.some((e) => e.includes('--force takes no value')));
    });

    it('D8b: status prints "current job: none|<id>"', async () => {
        const { workerDir } = makeInstall(tmp, { logLines: [...STARTED, TASK('job-S')] });
        const snap = { worker: { running: true, pid: PID, current_job: worker.currentJobLabel(createRealIo(), { workerDir, pid: PID }) }, comfyui: { running: true, port: 8188, external: false }, api: { ok: true }, queue: null, hub: null };
        assert.ok(management.renderStatus(snap).split('\n').includes('current job: job-S'), management.renderStatus(snap));
        const stopped = { ...snap, worker: { running: false, pid: null, current_job: 'none' } };
        assert.ok(management.renderStatus(stopped).split('\n').includes('current job: none'));
        assert.strictEqual(worker.currentJobLabel(createRealIo(), { workerDir, pid: null }), 'none', 'no running worker → none');
    });

    it('D8c: collectStatus carries the current job of the running worker', async () => {
        const { workerDir } = makeInstall(tmp, { logLines: [...STARTED, TASK('job-T')] });
        const snap = await management.collectStatus(createRealIo(), { workerDir, comfyuiRoot: null, port: null, state: null },
            { platformAdapter: { ...adapterStub({ running: true }), pidUid: () => null } });
        assert.strictEqual(snap.worker.pid, PID);
        assert.strictEqual(snap.worker.current_job, 'job-T');
    });

    it('D8d: package version is 0.2.8', () => {
        assert.strictEqual(pkg.version, '0.2.8');
    });
});

describe('0.2.8 D9 `animastor start` never kills a busy worker for a stale .env', () => {
    let tmp;
    beforeEach(() => { tmp = realFs.mkdtempSync(path.join(os.tmpdir(), 'anim-v028-')); });
    afterEach(() => { realFs.rmSync(tmp, { recursive: true, force: true }); });

    it('D9a: startWorker → already_running + restart_pending, no kill, no spawn', () => {
        const { workerDir } = makeInstall(tmp, { envNewer: true, logLines: [...STARTED, TASK('job-E')] });
        const io = createRealIo();
        const execs = [];
        const spawned = [];
        io.exec = (cmd, args) => { execs.push([cmd, ...(args || [])].join(' ')); return { code: 0, stdout: '', stderr: '' }; };
        io.spawnDaemon = () => { spawned.push(1); return 1; };
        const r = worker.startWorker(io, { workerDir, nodeBin: 'node', platformAdapter: adapterStub({ running: true }) });
        assert.strictEqual(r.already_running, true);
        assert.strictEqual(r.busy_job, 'job-E');
        assert.deepStrictEqual(r.restart_pending, ['.env']);
        assert.ok(!execs.some((e) => e.startsWith('true 4242')), `no kill: ${execs.join(' | ')}`);
        assert.strictEqual(spawned.length, 0);
    });
});
