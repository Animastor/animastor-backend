'use strict';

/**
 * Installer 0.2.3 — boot on a TIR node (type A), live run 2026-10-31: the
 * boot script ran `animastor doctor --yes --comfy-wait-ms 180000` before the
 * platform had started its ComfyUI; the worker was started at once against
 * the address of the previous boot and the result said "start your ComfyUI
 * on port 8888" (no notebook prefix).
 *
 *  W1  the platform's process appears after N s → the gate waits for the
 *      process AND /system_stats, progress every 30 s; the engine then
 *      rewrites COMFY_URL / COMFY_PORT / NOTEBOOK_PATH and starts the worker.
 *  W2  the process never appears → FAILED with the type A reason and fix,
 *      the worker is not started.
 *  W3  the process appears but never answers → the reason names it with the
 *      FULL (prefixed) address.
 *  W4  port/prefix change between boots: each boot uses its own cmdline.
 *  W5  the 90 s "worker → ComfyUI ready" window opens only after ComfyUI
 *      answered.
 *  W6  `animastor status`: "started by the platform (pid …)", not "your own".
 *  W7  cosmetics: no "reusing remembered setting: comfyPort=<old>" and no
 *      "remembered port … picking a new one" with a platform ComfyUI; the
 *      managed (type B) port choice is unchanged.
 */

const assert = require('assert');

const { createMemoryFs } = require('../src/installer/engine/io');
const { createLogger } = require('../src/installer/engine/logger');
const owner = require('../src/installer/engine/comfy-owner');
const workerMod = require('../src/installer/engine/worker');
const engine = require('../src/installer/engine/engine');
const management = require('../src/installer/management');
const cli = require('../src/installer/cli');
const LINUX = require('../src/installer/platform/linux');

const ROOT = '/home/jovyan/ComfyUI';
const STATE_PATH = `${ROOT}/.animastor-installer/install-state.json`;
const OLD_PREFIX = '/notebook/p-1/n-1';
const NEW_PREFIX = '/notebook/p-2/n-9';
const OLD_URL = `http://127.0.0.1:8888${OLD_PREFIX}`;
const NEW_URL = `http://127.0.0.1:8890${NEW_PREFIX}`;
const COMFY_STATS = { status: 200, json: { system: { os: 'posix' }, devices: [{ name: 'Tesla V100' }] } };

/** Recorded by the previous boot's run: type A, platform ComfyUI on 8888 + OLD_PREFIX. */
function typeAState() {
    return {
        state_version: 1,
        mode: 'existing',
        profiles: ['audio/qwen-tts'],
        artifacts: {},
        decisions: {},
        installer_options: { comfyPort: 8888, startComfyui: false, startWorker: true },
        components: { comfyui: { owned: false, path: ROOT } },
        comfy_owner: { owner: 'foreign', pid: 1348, url: OLD_URL },
    };
}

function platformCmdline(port, prefix) {
    return ['python3', `${ROOT}/main.py`, '--listen', '0.0.0.0', '--port', String(port), '--baseurl', prefix];
}

/**
 * A node on a VIRTUAL clock: the platform's main.py appears at `appearAt`
 * ms and answers /system_stats from `answerAt` ms (null = never). The gate's
 * sleep advances the clock, so 180 s of boot run in milliseconds.
 */
function bootWorld({ appearAt = null, answerAt = null, port = 8890, prefix = NEW_PREFIX, pid = 900, extraFiles = {} } = {}) {
    const fs = createMemoryFs({ [`${ROOT}/main.py`]: '#', ...extraFiles });
    const world = { t: 0 };
    const calls = { exec: [], spawn: [] };
    const url = `http://127.0.0.1:${port}${prefix}`;
    const appeared = () => appearAt != null && world.t >= appearAt;
    const answers = () => appeared() && answerAt != null && world.t >= answerAt;
    const syncProc = () => {
        if (appeared() && !fs.existsSync(`/proc/${pid}/cmdline`)) {
            fs.mkdirSync(`/proc/${pid}`, { recursive: true });
            fs.writeFileSync(`/proc/${pid}/cmdline`, platformCmdline(port, prefix).join('\0'));
            fs.symlinkSync(ROOT, `/proc/${pid}/cwd`);
        }
    };
    const io = {
        fs,
        calls,
        exec(cmd, args = []) {
            calls.exec.push({ cmd, args });
            syncProc();
            if (cmd === 'pgrep') {
                if (args.includes('main\\.py') && appeared()) return { code: 0, stdout: String(pid), stderr: '' };
                return { code: 1, stdout: '', stderr: '' };
            }
            if (cmd === 'nvidia-smi' || cmd === 'rocm-smi') return { code: 1, stdout: '' };
            if (cmd === 'ps') return { code: 0, stdout: 'node worker.cjs' };
            if (/python/.test(cmd) && args[0] === '--version') return { code: 0, stdout: 'Python 3.10.12' };
            if (/python/.test(cmd) && args[0] === '-c') return { code: 0, stdout: '2.4.0+cu121' };
            return { code: 0, stdout: '', stderr: '' };
        },
        spawnDaemon(command, args, opts) {
            calls.spawn.push({ command, args, opts });
            if (args[0] === 'worker.cjs') {
                fs.appendFileSync(opts.logFile, ['[t] [info] Worker audio started', '[t] [info] ComfyUI ready', '[t] [info] Hub heartbeat accepted — worker is ONLINE'].join('\n') + '\n');
            }
            return 4242;
        },
        http: {
            async fetchJson(u) {
                if (u === `${url}/system_stats`) return answers() ? COMFY_STATS : { status: 502, json: null };
                if (u.endsWith('/worker/verify')) return { status: 200, json: { verified: true, worker_id: 'w1', worker_type: 'audio', mode: 'private' } };
                return { status: 404, json: null };
            },
            async fetchText() { return { status: 404, text: '' }; },
        },
        now: () => world.t,
    };
    const sleep = async (ms) => { world.t += ms; };
    return { io, fs, world, calls, sleep, url };
}

function ttsManifest() {
    return {
        profile: { id: 'audio/qwen-tts' },
        runtime_requirements: {},
        dependencies: [],
        workflows: { artifacts: [] },
        worker_bundle: {
            worker_type: 'audio',
            files: ['worker.cjs', 'package.json', '.env.example'],
            env: { required: ['HUB_URL', 'ANIMASTOR_WORKER_TOKEN', 'WORKER_TYPE', 'WORKER_ID'], secrets: ['ANIMASTOR_WORKER_TOKEN'] },
        },
    };
}

const BUNDLE_FILES = {
    '/repo/packages/animastor-worker/worker/worker.cjs': '// worker',
    '/repo/packages/animastor-worker/worker/package.json': '{"name":"animastor-worker","version":"2.2.0"}',
    '/repo/packages/animastor-worker/worker/.env.example': 'HUB_URL=\n',
};

/** One engine run (doctor after the gate) on the world's io. */
async function runEngine(io, { comfyOwner, mode = 'existing', comfyuiRoot = ROOT, statePath = STATE_PATH, options = {} } = {}) {
    const logger = createLogger({ io, quiet: true });
    // the engine's own polls use real timers — keep them short here
    const realNow = Date.now();
    const savedNow = io.now;
    io.now = () => savedNow() + (Date.now() - realNow);
    const result = await engine.runInstallation({
        manifests: [ttsManifest()], mode, io,
        roots: { comfyuiRoot, workerDir: '/home/jovyan/animastor/worker', statePath, repoRoot: '/repo', hubUrl: 'https://h/gpu' },
        decisions: { worker_setup: true, worker_key_provided: true, workflows: 'none', comfyui_update: 'no', apply_fixes: true },
        secretProvider: async () => 'wrk.w1.secret',
        logger, crypto: require('crypto'),
        options: {
            interruptGuard: false, currentUid: 1000, home: '/home/jovyan', nodeBinary: { bin: '/n22', version: '22.0.0' },
            workerGraceMs: 1, workerReadyTimeoutMs: 200, heartbeatTimeoutMs: 200, pollIntervalMs: 5,
            sleepCommand: 'true', comfyOwner, ...options,
        },
        platformAdapter: { ...LINUX, sleepCommand: () => ({ cmd: 'true', args: [] }) },
    });
    io.now = savedNow;
    return { result, lines: logger.lines };
}

function withState(fs, state) {
    fs.mkdirSync(`${ROOT}/.animastor-installer`, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));
}

function oldEnv(fs) {
    fs.mkdirSync('/home/jovyan/animastor/worker', { recursive: true });
    fs.writeFileSync('/home/jovyan/animastor/worker/.env', [
        'HUB_URL=https://h/gpu', 'ANIMASTOR_WORKER_TOKEN=wrk.w1.secret', 'WORKER_TYPE=audio', 'WORKER_ID=gpu-1',
        `COMFY_URL=${OLD_URL}`, 'COMFY_PORT=8888', `NOTEBOOK_PATH=${OLD_PREFIX}`, '',
    ].join('\n'));
}

function captureConsole(fn) {
    const out = [];
    const orig = console.log;
    const prevExit = process.exitCode;
    console.log = (...a) => { out.push(a.join(' ')); };
    let exitCode;
    try {
        fn();
        exitCode = process.exitCode;
    } finally {
        console.log = orig;
        process.exitCode = prevExit;
    }
    return { out, exitCode };
}

// ---------------------------------------------------------------------------

describe('0.2.3 boot gate — type A waits for the platform ComfyUI', () => {
    it('W0: the recorded installation decides "ComfyUI belongs to the platform"', () => {
        assert.strictEqual(owner.platformOwnedByRecord(typeAState()), true);
        assert.strictEqual(owner.platformOwnedByRecord({ mode: 'existing' }), true);
        assert.strictEqual(owner.platformOwnedByRecord({ mode: 'managed', installer_options: { startComfyui: false } }), true);
        assert.strictEqual(owner.platformOwnedByRecord({ mode: 'managed', installer_options: { startComfyui: true }, comfy_owner: { owner: 'foreign' } }), true);
        // type B: the installer created the ComfyUI and starts it
        assert.strictEqual(owner.platformOwnedByRecord({ mode: 'managed', installer_options: { startComfyui: true }, components: { comfyui: { owned: true } } }), false);
        assert.strictEqual(owner.platformOwnedByRecord(null), false);
    });

    it('W1: the process appears after 60 s, answers at 75 s → OK; .env rewritten; worker started after it', async () => {
        const { io, fs, sleep, world, calls } = bootWorld({ appearAt: 60000, answerAt: 75000, extraFiles: BUNDLE_FILES });
        withState(fs, typeAState());
        oldEnv(fs);
        const logger = createLogger({ io, quiet: true });
        const gate = await cli.platformComfyGate(io, { state: typeAState(), root: ROOT, waitMs: 180000, logger, sleep });

        assert.strictEqual(gate.failed, false);
        assert.strictEqual(gate.waited.ok, true);
        assert.ok(gate.waited.waited_ms >= 75000 && gate.waited.waited_ms < 80000, String(gate.waited.waited_ms));
        assert.strictEqual(gate.instance.owner, 'foreign');
        assert.strictEqual(gate.instance.url, NEW_URL, 'address from THIS boot\'s cmdline');
        assert.strictEqual(calls.spawn.length, 0, 'nothing started while waiting');
        const log = logger.lines.join('\n');
        assert.ok(/waiting for the platform's ComfyUI — no ComfyUI main\.py process yet \(30 s of 180 s\)/.test(log), log);
        assert.ok(log.includes(`process pid 900 at ${NEW_URL} does not answer GET /system_stats yet (60 s of 180 s)`), log);
        assert.ok(log.includes(`the platform's ComfyUI answers at ${NEW_URL} (pid 900, after 75 s)`), log);
        const progress = logger.lines.filter((l) => /waiting for the platform's ComfyUI —/.test(l));
        assert.strictEqual(progress.length, 2, 'once per 30 s (30, 60)');

        world.t = 100000;
        const { result, lines } = await runEngine(io, { comfyOwner: gate.instance });
        const env = fs.readFileSync('/home/jovyan/animastor/worker/.env', 'utf8');
        assert.ok(env.includes(`COMFY_URL=${NEW_URL}\n`), env);
        assert.ok(env.includes('COMFY_PORT=8890\n'), env);
        assert.ok(env.includes(`NOTEBOOK_PATH=${NEW_PREFIX}\n`), env);
        assert.ok(calls.spawn.some((s) => s.args[0] === 'worker.cjs'), 'worker started');
        assert.ok(!calls.spawn.some((s) => /main\.py/.test(s.args.join(' '))), 'no second ComfyUI');
        assert.deepStrictEqual(result.e2e.map((c) => [c.id, c.ok]), [['comfyui', true], ['worker', true], ['heartbeat', true]], lines.join('\n'));
        const st = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
        assert.strictEqual(st.installer_options.comfyPort, 8890);
        assert.strictEqual(st.comfy_owner.owner, 'foreign');
        assert.strictEqual(st.comfy_owner.url, NEW_URL);
    });

    it('W2: no process within --comfy-wait-ms → FAILED with the type A reason; the worker is not started', async () => {
        const { io, sleep, calls } = bootWorld({ appearAt: null });
        const logger = createLogger({ io, quiet: true });
        const gate = await cli.platformComfyGate(io, { state: typeAState(), root: ROOT, waitMs: 180000, logger, sleep });
        assert.strictEqual(gate.failed, true);
        assert.strictEqual(gate.waited.ok, false);
        assert.ok(gate.waited.waited_ms >= 180000);
        assert.strictEqual(logger.lines.filter((l) => /waiting for the platform's ComfyUI —/.test(l)).length, 5, 'progress at 30..150 s');
        assert.ok(logger.lines.some((l) => /\[ERROR\] ComfyUI is started by the platform; it did not come up in 180 s/.test(l)), logger.lines.join('\n'));

        const result = cli.platformComfyMissingResult({ waited: gate.waited, tool: '/home/jovyan/.local/bin/animastor', mode: 'existing' });
        const { out, exitCode } = captureConsole(() => cli.printResult(result, { flags: {}, mode: 'existing', boot: true }));
        assert.strictEqual(exitCode, 1);
        assert.ok(/^animastor doctor: FAILED — 1 problem\(s\) — mode existing, ComfyUI not reachable, worker not started/.test(out[0]), out.join('\n'));
        assert.ok(out[1].includes('✗ ComfyUI API: ComfyUI is started by the platform; it did not come up in 180 s (no ComfyUI main.py process appeared)'), out.join('\n'));
        assert.ok(out[1].includes("fix: run `/home/jovyan/.local/bin/animastor doctor` after the platform's ComfyUI is up"), out[1]);
        assert.ok(!out.join('\n').includes('start your ComfyUI on port'), 'no type-B fix for type A');
        assert.strictEqual(calls.spawn.length, 0, 'worker never spawned');
    });

    it('W3: the process appears but never answers → the reason names it with the FULL prefixed address', async () => {
        const { io, sleep } = bootWorld({ appearAt: 10000, answerAt: null });
        const gate = await cli.platformComfyGate(io, { state: typeAState(), root: ROOT, waitMs: 60000, logger: null, sleep });
        assert.strictEqual(gate.failed, true);
        const reason = owner.platformComfyMissingReason(gate.waited.waited_ms, gate.waited.last_seen);
        assert.strictEqual(reason, `ComfyUI is started by the platform; it did not come up in 60 s (process pid 900 at ${NEW_URL} did not answer GET /system_stats)`);
    });

    it('W4: port/prefix change between boots — each boot is addressed by its own cmdline', async () => {
        const boot1 = bootWorld({ appearAt: 0, answerAt: 0, port: 8888, prefix: OLD_PREFIX, pid: 1348 });
        const g1 = await cli.platformComfyGate(boot1.io, { state: typeAState(), root: ROOT, waitMs: 180000, sleep: boot1.sleep });
        assert.strictEqual(g1.waited, null, 'already up — no wait');
        assert.strictEqual(g1.instance.url, OLD_URL);

        const boot2 = bootWorld({ appearAt: 20000, answerAt: 20000, port: 8890, prefix: NEW_PREFIX, pid: 900 });
        const g2 = await cli.platformComfyGate(boot2.io, { state: { ...typeAState(), comfy_owner: { owner: 'foreign', pid: 1348, url: OLD_URL } }, root: ROOT, waitMs: 180000, sleep: boot2.sleep });
        assert.strictEqual(g2.instance.url, NEW_URL);
        assert.strictEqual(g2.instance.port, 8890);
        assert.strictEqual(g2.instance.baseurl, NEW_PREFIX);
        const desired = engine.desiredEnvWiring({ manifests: [ttsManifest()], comfyUrl: g2.instance.url, comfyPort: g2.instance.port });
        assert.deepStrictEqual(
            { COMFY_URL: desired.COMFY_URL, COMFY_PORT: desired.COMFY_PORT, NOTEBOOK_PATH: desired.NOTEBOOK_PATH },
            { COMFY_URL: NEW_URL, COMFY_PORT: '8890', NOTEBOOK_PATH: NEW_PREFIX },
        );
    });

    it('W4b: type B (managed, owned) with nothing running is never failed by the gate', async () => {
        const { io, sleep } = bootWorld({ appearAt: null });
        const state = { state_version: 1, mode: 'managed', installer_options: { comfyPort: 8188, startComfyui: true }, components: { comfyui: { owned: true } } };
        assert.strictEqual((await cli.platformComfyGate(io, { state, root: ROOT, waitMs: 0, sleep })).waited, null, '--comfy-wait-ms 0 → no wait');
        const g = await cli.platformComfyGate(io, { state, root: ROOT, waitMs: 6000, sleep });
        assert.strictEqual(g.failed, false, 'managed starts its own ComfyUI after the wait');
        assert.strictEqual(g.instance.mode, 'managed');
    });
});

describe('0.2.3 worker readiness window opens after ComfyUI answers', () => {
    it('W5: a ComfyUI that answers only after the worker\'s window would have elapsed does not fail the worker', async () => {
        const fs = createMemoryFs({});
        const io = { fs, exec: () => ({ code: 0, stdout: 'node worker.cjs' }), now: () => Date.now() };
        fs.mkdirSync('/w/logs', { recursive: true });
        fs.writeFileSync('/w/logs/worker.log', '[t] [info] Worker audio started\n');
        const upAt = Date.now() + 120;
        let wrote = false;
        const comfyUp = async () => {
            const up = Date.now() >= upAt;
            if (up && !wrote) {
                wrote = true;
                setTimeout(() => fs.appendFileSync('/w/logs/worker.log', '[t] [info] ComfyUI ready\n'), 30);
            }
            return up;
        };
        const ready = await workerMod.waitForWorkerReady(io, {
            workerDir: '/w', logFile: '/w/logs/worker.log', comfyTimeoutMs: 80, pollMs: 5,
            requireHeartbeat: false, comfyUp, comfyUpTimeoutMs: 2000,
        });
        assert.strictEqual(ready.comfy_ready, true, ready.reason);

        // without the gate the same 80 ms window runs out while ComfyUI loads
        fs.writeFileSync('/w/logs/worker2.log', '[t] [info] Worker audio started\n');
        const late = await workerMod.waitForWorkerReady(io, { workerDir: '/w', logFile: '/w/logs/worker2.log', comfyTimeoutMs: 80, pollMs: 5, requireHeartbeat: false });
        assert.strictEqual(late.comfy_ready, false);
        assert.ok(/within 0 s|within \d+ s/.test(late.reason));
    });
});

describe('0.2.3 animastor status — who started the ComfyUI', () => {
    function statusIo({ proc = true, answers = true } = {}) {
        const w = bootWorld({ appearAt: proc ? 0 : null, answerAt: answers ? 0 : null, port: 8888, prefix: OLD_PREFIX, pid: 1348 });
        return w;
    }
    const targets = (state) => ({ found: true, state, comfyuiRoot: ROOT, workerDir: '/home/jovyan/animastor/worker', port: null });

    it('W6: a running platform ComfyUI → "started by the platform (pid …)" with its full address', async () => {
        const { io } = statusIo();
        const snap = await management.collectStatus(io, targets(typeAState()), { platformAdapter: LINUX });
        const text = management.renderStatus(snap);
        assert.ok(text.includes(`ComfyUI:  ✓ RUNNING — started by the platform (pid 1348), ${OLD_URL}`), text);
        assert.ok(!text.includes('your own'), text);
    });

    it('W6b: the platform has not started it yet → still "started by the platform", never "your own"', async () => {
        const { io } = statusIo({ proc: false });
        const text = management.renderStatus(await management.collectStatus(io, targets(typeAState()), { platformAdapter: LINUX }));
        assert.ok(text.includes('ComfyUI:  ✗ UNREACHABLE — started by the platform (no process running)'), text);
    });

    it('W6c: a user\'s own ComfyUI with no platform record keeps "your own"', async () => {
        const { io } = statusIo({ proc: false });
        const state = { state_version: 1, mode: 'existing', installer_options: { startComfyui: false } };
        const text = management.renderStatus(await management.collectStatus(io, targets(state), { platformAdapter: LINUX }));
        assert.ok(text.includes('(your own'), text);
    });
});

describe('0.2.3 port cosmetics', () => {
    it('W7: with the platform ComfyUI no "reusing comfyPort=<old>" and no "picking a new one"', async () => {
        const { io, fs } = bootWorld({ appearAt: 0, answerAt: 0, extraFiles: BUNDLE_FILES });
        withState(fs, typeAState());
        oldEnv(fs);
        // the remembered 8888 answers, but not as ComfyUI (the notebook proxy)
        const inner = io.http.fetchJson;
        io.http.fetchJson = async (u, o) => (u === 'http://127.0.0.1:8888/system_stats' ? { status: 404, json: null } : inner(u, o));
        const instance = await owner.resolveComfyOwner(io, { state: typeAState(), root: ROOT });
        assert.strictEqual(instance.owner, 'foreign');
        const { lines } = await runEngine(io, { comfyOwner: instance });
        const log = lines.join('\n');
        assert.ok(!/reusing remembered setting: comfyPort=/.test(log), log);
        assert.ok(!/is now used by another service — picking a new one/.test(log), log);
        assert.ok(/reusing remembered setting: startWorker=true/.test(log), 'other remembered settings are still reused');
    });

    it('W7b: managed (type B) — a remembered port taken by another service still picks a new one', async () => {
        const files = { ...BUNDLE_FILES, '/c/main.py': '#' };
        const { io, fs } = bootWorld({ appearAt: null, extraFiles: files });
        fs.mkdirSync('/c/.animastor-installer', { recursive: true });
        fs.writeFileSync('/c/.animastor-installer/install-state.json', JSON.stringify({
            state_version: 1, mode: 'managed', profiles: ['audio/qwen-tts'], artifacts: {}, decisions: {},
            installer_options: { comfyPort: 8188, startComfyui: false, startWorker: false },
            components: { comfyui: { owned: true, path: '/c' } },
        }));
        // 8188 is held by another service (200, not a ComfyUI payload); 8288 is free
        io.http.fetchJson = async (u) => {
            if (u === 'http://127.0.0.1:8188/system_stats') return { status: 200, json: { ok: true } };
            if (u.endsWith('/worker/verify')) return { status: 200, json: { verified: true, worker_id: 'w1', worker_type: 'audio', mode: 'private' } };
            throw new Error('ECONNREFUSED');
        };
        const instance = await owner.resolveComfyOwner(io, { state: JSON.parse(fs.readFileSync('/c/.animastor-installer/install-state.json', 'utf8')), root: '/c' });
        assert.strictEqual(instance.mode, 'managed');
        const { lines } = await runEngine(io, {
            comfyOwner: instance, mode: 'managed', comfyuiRoot: '/c', statePath: '/c/.animastor-installer/install-state.json',
            options: { startWorker: false },
        });
        const log = lines.join('\n');
        assert.ok(/reusing remembered setting: comfyPort=8188/.test(log), log);
        assert.ok(/remembered port 8188 is now used by another service — picking a new one/.test(log), log);
        assert.ok(/port 8188 is occupied \(foreign\) — this install's ComfyUI will use port 8288/.test(log), log);
        const st = JSON.parse(fs.readFileSync('/c/.animastor-installer/install-state.json', 'utf8'));
        assert.strictEqual(st.installer_options.comfyPort, 8288);
    });
});
