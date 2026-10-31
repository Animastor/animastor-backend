'use strict';

/**
 * Installer 0.2.4 — unattended start on cloud nodes, live TIR boots
 * 2026-10-31 (bootstrap.log on the node):
 *   - TIR starts its ComfyUI only AFTER the startup script has finished — a
 *     doctor that waits inside the script deadlocks (gave up 05:19:06,
 *     main.py started 05:19:35);
 *   - only /home survives a restart — the pip packages of ComfyUI-Qwen3-TTS
 *     (custom_nodes/qwen3-tts/requirements.txt) are gone, ComfyUI starts
 *     without the nodes → "ComfyUI node classes missing: Qwen3TTS*".
 *
 *  X1  `animastor boot` detaches (new session, stdin /dev/null, log with a
 *      header) and returns 0 at once; the child is `doctor --yes
 *      --comfy-wait-ms 600000`.
 *  X2  the interpreter is taken from the main.py process (/proc).
 *  X3  missing node deps + restart allowed → pip install in THAT python, the
 *      platform's main.py (exact pid) is stopped, the platform starts a new
 *      one (pid changes) with the node classes → OK.
 *  X4  restart not allowed → deps installed, the foreign main.py is NOT
 *      signaled, FAILED with the fix.
 *  X5  the platform restarts ComfyUI but the classes never appear → FAILED.
 *  X6  the platform does not start ComfyUI again → FAILED with the reason.
 *  X7  verification re-checks node classes until the end of the window:
 *      they appear → OK; they never appear → FAILED.
 *  X8  restart option: flag > state > boot default; interactive answer recorded.
 *  X9  type B (managed): deps checked in its venv python → pip retry +
 *      restart of its OWN ComfyUI; type B boot does not wait for a platform.
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const realFs = require('fs');
const { spawn } = require('child_process');

const { createMemoryFs } = require('../src/installer/engine/io');
const { createLogger } = require('../src/installer/engine/logger');
const owner = require('../src/installer/engine/comfy-owner');
const nodeDeps = require('../src/installer/engine/node-deps');
const engine = require('../src/installer/engine/engine');
const cli = require('../src/installer/cli');
const LINUX = require('../src/installer/platform/linux');

const ROOT = '/home/jovyan/ComfyUI';
const STATE_PATH = `${ROOT}/.animastor-installer/install-state.json`;
const PREFIX = '/notebook/p-2/n-9';
const PY = '/opt/conda/bin/python3';
const CLASSES = ['Qwen3TTSLoader', 'Qwen3TTSVoiceDesign'];
const COMFY_STATS = { status: 200, json: { system: { os: 'posix' }, devices: [{ name: 'Tesla V100' }] } };

function ttsManifest() {
    return {
        profile: { id: 'audio/qwen-tts' },
        runtime_requirements: {},
        dependencies: [
            {
                id: 'custom-node:comfyui-qwen3-tts', kind: 'custom_node', name: 'ComfyUI-Qwen3-TTS', requirement: 'required',
                install: { directory: 'qwen3-tts', source: { repository: 'https://github.com/wanaigc/ComfyUI-Qwen3-TTS', commit: '2ee1131' } },
                provides_classes: CLASSES,
            },
            {
                id: 'custom-node:comfyui-manager', kind: 'custom_node', name: 'ComfyUI-Manager', requirement: 'optional',
                install: { directory: 'comfyui-manager', source: { repository: 'https://github.com/Comfy-Org/ComfyUI-Manager' } },
            },
        ],
        workflows: { artifacts: [] },
        worker_bundle: { worker_type: 'audio', files: [], env: { required: [], secrets: [] } },
    };
}

function typeAState(extra = {}) {
    return {
        state_version: 1,
        mode: 'existing',
        profiles: ['audio/qwen-tts'],
        artifacts: {},
        decisions: {},
        installer_options: { comfyPort: 8890, startComfyui: false, startWorker: true, ...(extra.installer_options || {}) },
        components: { comfyui: { owned: false, path: ROOT } },
        comfy_owner: { owner: 'foreign', pid: 1348, url: `http://127.0.0.1:8888/notebook/p-1/n-1` },
    };
}

/**
 * A type A node on a virtual clock. The platform's main.py (pid 900) runs
 * from the start; pip packages of qwen3-tts are missing (wiped by the
 * restart). After a SIGTERM the platform starts a new main.py (pid 901)
 * `restartAfter` ms later (null = never); a process imports the node
 * classes only when the deps were installed BEFORE it started (and
 * `classesLoad` is true).
 */
function depsWorld({ restartAfter = 20000, classesLoad = true, installed = false, port = 8890 } = {}) {
    const fs = createMemoryFs({
        [`${ROOT}/main.py`]: '#',
        [`${ROOT}/custom_nodes/qwen3-tts/requirements.txt`]: 'transformers>=4.40\nlibrosa\n',
        [`${ROOT}/custom_nodes/comfyui-manager/requirements.txt`]: 'GitPython\n',
    });
    const w = {
        t: 0, installed, pid: 900, alive: true, killedAt: null,
        procHasClasses: { 900: installed }, kills: [], pipArgs: [], checks: 0,
    };
    const url = `http://127.0.0.1:${port}${PREFIX}`;
    const writeProc = (pid) => {
        fs.mkdirSync(`/proc/${pid}`, { recursive: true });
        fs.writeFileSync(`/proc/${pid}/cmdline`, [PY, `${ROOT}/main.py`, '--listen', '0.0.0.0', '--port', String(port), '--baseurl', PREFIX].join('\0'));
        fs.symlinkSync(ROOT, `/proc/${pid}/cwd`);
    };
    writeProc(900);
    const tick = () => {
        if (!w.alive && w.killedAt != null && restartAfter != null && w.t >= w.killedAt + restartAfter && w.pid === 900) {
            w.pid = 901;
            w.alive = true;
            w.procHasClasses[901] = w.installed && classesLoad;
            writeProc(901);
        }
    };
    const io = {
        fs,
        exec(cmd, args = []) {
            tick();
            if (cmd === 'pgrep') return w.alive ? { code: 0, stdout: String(w.pid), stderr: '' } : { code: 1, stdout: '', stderr: '' };
            if (cmd === PY && args[0] === '-I' && args[1] === '-c') {
                w.checks += 1;
                const req = args[3];
                const items = /qwen3-tts/.test(req)
                    ? [{ line: 'transformers>=4.40', name: 'transformers', status: w.installed ? 'ok' : 'missing', have: w.installed ? '4.45.0' : null, want: '>=4.40' },
                        { line: 'librosa', name: 'librosa', status: w.installed ? 'ok' : 'missing', have: null, want: null }]
                    : [{ line: 'GitPython', name: 'GitPython', status: 'missing' }];
                return { code: 0, stdout: `${JSON.stringify({ torch: { torch: '2.4.0+cu121' }, items })}\n`, stderr: '' };
            }
            if (cmd === PY && args[0] === '-m' && args[1] === 'pip') {
                w.pipArgs.push(args);
                w.installed = true;
                return { code: 0, stdout: 'Successfully installed', stderr: '' };
            }
            return { code: 0, stdout: '', stderr: '' };
        },
        kill(pid, sig) {
            w.kills.push({ pid, sig });
            if (pid === w.pid && w.alive) { w.alive = false; w.killedAt = w.t; }
        },
        pidAlive: (pid) => pid === w.pid && w.alive,
        http: {
            async fetchJson(u) {
                tick();
                if (!w.alive) return { status: 502, json: null };
                if (u === `${url}/system_stats`) return COMFY_STATS;
                if (u === `${url}/object_info`) {
                    const json = { KSampler: {} };
                    if (w.procHasClasses[w.pid]) for (const c of CLASSES) json[c] = {};
                    return { status: 200, json };
                }
                return { status: 404, json: null };
            },
            async fetchText() { return { status: 404, text: '' }; },
        },
        now: () => w.t,
    };
    const sleep = async (ms) => { w.t += ms; };
    return { io, fs, w, sleep, url };
}

async function foreignInstance(io) {
    const inst = await owner.resolveComfyOwner(io, { state: typeAState(), root: ROOT });
    assert.strictEqual(inst.owner, 'foreign');
    return inst;
}

// ---------------------------------------------------------------------------

describe('0.2.4 animastor boot — detach and return 0 at once', () => {
    const tmp = realFs.mkdtempSync(path.join(os.tmpdir(), 'animastor-boot-'));
    after(() => realFs.rmSync(tmp, { recursive: true, force: true }));

    it('X1: spawns a detached `doctor --yes --comfy-wait-ms 600000` with stdin ignored and the log as stdout', () => {
        const calls = [];
        const fakeSpawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { pid: 777, unref() { calls.unref = true; } }; };
        const flags = { state: STATE_PATH, root: ROOT, 'worker-dir': path.join(tmp, 'a', 'worker'), 'hub-url': 'https://h/gpu', profiles: [] };
        const prev = process.exitCode;
        const orig = console.log;
        const out = [];
        console.log = (...a) => out.push(a.join(' '));
        let res;
        try {
            res = cli.cmdBoot(flags, { spawn: fakeSpawn, execPath: '/n22', cliPath: '/cli.js', now: () => new Date('2026-10-31T05:19:00Z') });
            assert.strictEqual(process.exitCode, 0);
        } finally { console.log = orig; process.exitCode = prev; }
        assert.strictEqual(calls.length, 1);
        const c = calls[0];
        assert.strictEqual(c.cmd, '/n22');
        assert.deepStrictEqual(c.args.slice(0, 3), ['/cli.js', 'doctor', '--yes']);
        assert.ok(c.args.join(' ').includes('--comfy-wait-ms 600000'), c.args.join(' '));
        assert.ok(c.args.join(' ').includes(`--state ${STATE_PATH}`));
        assert.strictEqual(c.opts.detached, true, 'own session (setsid)');
        assert.strictEqual(c.opts.stdio[0], 'ignore', 'stdin /dev/null');
        assert.strictEqual(typeof c.opts.stdio[1], 'number');
        assert.strictEqual(c.opts.env.ANIMASTOR_BOOT, '1');
        assert.strictEqual(calls.unref, true);
        assert.strictEqual(res.logFile, path.join(tmp, 'a', 'logs', 'bootstrap.log'), '~/animastor/logs/bootstrap.log');
        const log = realFs.readFileSync(res.logFile, 'utf8');
        assert.ok(/===== animastor boot 2026-10-31T05:19:00\.000Z \(system boot [^)]+\) =====/.test(log), log);
        assert.ok(log.includes('doctor --yes detached (pid 777)'), log);
        assert.ok(/^animastor boot: started in the background \(pid 777\), log /.test(out[0]), out.join('\n'));
    });

    it('X1b: an explicit --comfy-wait-ms is passed through unchanged', () => {
        const args = cli.bootChildArgs({ 'comfy-wait-ms': '0', profiles: [], 'restart-platform-comfy': true }, { cliPath: '/cli.js' });
        assert.deepStrictEqual(args, ['/cli.js', 'doctor', '--yes', '--comfy-wait-ms', '0', '--restart-platform-comfy']);
    });

    it('X1c: real detach — returns before the child ends; the child runs in its own session and writes to the log', async function () {
        if (process.platform !== 'linux') this.skip();
        this.timeout(10000);
        const script = path.join(tmp, 'child.js');
        realFs.writeFileSync(script, "console.log('child args ' + process.argv.slice(2).join(' ')); setTimeout(() => console.log('child done'), 1500);\n");
        const flags = { 'worker-dir': path.join(tmp, 'b', 'worker'), profiles: [] };
        const prev = process.exitCode;
        const orig = console.log;
        console.log = () => {};
        let res;
        const t0 = Date.now();
        try {
            res = cli.cmdBoot(flags, { spawn, execPath: process.execPath, cliPath: script });
            assert.strictEqual(process.exitCode, 0);
        } finally { console.log = orig; process.exitCode = prev; }
        assert.ok(Date.now() - t0 < 1000, 'returned at once');
        assert.ok(res.pid > 0);
        const sid = (pid) => Number(realFs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[3]);
        assert.strictEqual(sid(res.pid), res.pid, 'the child leads its own session');
        assert.notStrictEqual(sid(res.pid), sid(process.pid));
        const deadline = Date.now() + 6000;
        let log = '';
        while (Date.now() < deadline) {
            log = realFs.readFileSync(res.logFile, 'utf8');
            if (log.includes('child done')) break;
            await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(/child args doctor --yes .*--comfy-wait-ms 600000/.test(log), log);
        assert.ok(log.includes('child done'), log);
    });

    it('X1d: the install result prints the one-line startup script', () => {
        assert.ok(/^export PATH="\$HOME\/\.local\/bin:\$PATH"; \/.+\/animastor boot$/.test(cli.startupScriptLine({})), cli.startupScriptLine({}));
    });
});

describe('0.2.4 node dependencies in the Python of the running ComfyUI', () => {
    it('X2: the interpreter comes from the process: absolute argv[0], VIRTUAL_ENV / PATH of its environ, /proc/<pid>/exe', () => {
        const fs = createMemoryFs({ '/v/bin/python3': '', '/usr/bin/python3': '' });
        const io = { fs };
        const proc = (pid, argv, env = null, exe = null) => {
            fs.mkdirSync(`/proc/${pid}`, { recursive: true });
            fs.writeFileSync(`/proc/${pid}/cmdline`, argv.join('\0'));
            if (env) fs.writeFileSync(`/proc/${pid}/environ`, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0'));
            if (exe) fs.symlinkSync(exe, `/proc/${pid}/exe`);
        };
        proc(1, [PY, 'main.py']);
        proc(2, ['python3', 'main.py'], { VIRTUAL_ENV: '/v', PATH: '/usr/bin' });
        proc(3, ['python3', 'main.py'], { PATH: '/nope:/usr/bin' });
        proc(4, ['python3', 'main.py'], null, '/usr/bin/python3.10');
        assert.deepStrictEqual(nodeDeps.pythonOfProcess(io, 1), { python: PY, source: 'argv[0]' });
        assert.strictEqual(nodeDeps.pythonOfProcess(io, 2).python, '/v/bin/python3');
        assert.strictEqual(nodeDeps.pythonOfProcess(io, 3).python, '/usr/bin/python3');
        assert.strictEqual(nodeDeps.pythonOfProcess(io, 4).python, '/usr/bin/python3.10');
        assert.strictEqual(nodeDeps.pythonOfProcess(io, 5).python, null);
    });

    it('X2b: only REQUIRED profile nodes with a requirements.txt are checked', () => {
        const { io } = depsWorld();
        const reqs = nodeDeps.profileNodeRequirements(io, { root: ROOT, manifests: [ttsManifest()] });
        assert.deepStrictEqual(reqs.map((r) => r.directory), ['qwen3-tts']);
        const c = nodeDeps.checkNodeDeps(io, { python: PY, root: ROOT, manifests: [ttsManifest()] });
        assert.strictEqual(nodeDeps.describeUnsatisfied(c.nodes), 'qwen3-tts (transformers missing, librosa missing)');
    });

    it('X2c: the check script really runs in a Python (packaging/importlib.metadata) when one is available', function () {
        const py = ['python3', '/usr/bin/python3'].find((p) => { try { return require('child_process').spawnSync(p, ['--version']).status === 0; } catch (_) { return false; } });
        if (!py) this.skip();
        const dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'animastor-req-'));
        const req = path.join(dir, 'requirements.txt');
        realFs.writeFileSync(req, '# c\npip>=1\nanimastor-surely-not-installed-pkg\nnope ; python_version < "2"\n-e git+https://x/y.git#egg=z\n');
        const { createRealIo } = require('../src/installer/engine/io');
        const r = nodeDeps.checkRequirementsFile(createRealIo(), { python: py, reqPath: req });
        realFs.rmSync(dir, { recursive: true, force: true });
        assert.ok(r.ok, r.error);
        const by = Object.fromEntries(r.items.map((i) => [i.name || i.line, i.status]));
        assert.strictEqual(by.pip, 'ok');
        assert.strictEqual(by['animastor-surely-not-installed-pkg'], 'missing');
        assert.strictEqual(by.nope, 'skipped');
        assert.strictEqual(r.unsatisfied.length, 1);
    });

    it('X3: deps missing + restart allowed (boot, type A) → pip in the process Python, exact pid stopped, the platform starts a new pid with the classes → OK', async () => {
        const { io, w, sleep, url } = depsWorld({ restartAfter: 20000 });
        const logger = createLogger({ io, quiet: true });
        const inst = await foreignInstance(io);
        const gate = await cli.platformNodeDepsGate(io, {
            instance: inst, state: typeAState(), root: ROOT, manifests: [ttsManifest()], boot: true,
            waitMs: 600000, logger, statePath: STATE_PATH, sleep,
        });
        assert.strictEqual(gate.failed, false, gate.reason);
        assert.deepStrictEqual(gate.installed, ['qwen3-tts']);
        assert.strictEqual(w.pipArgs.length, 1);
        assert.deepStrictEqual(w.pipArgs[0].slice(0, 5), ['-m', 'pip', 'install', '-r', `${ROOT}/custom_nodes/qwen3-tts/requirements.txt`]);
        assert.ok(w.pipArgs[0].includes('-c'), 'installed torch pinned as a constraint');
        assert.strictEqual(io.fs.readFileSync(`${ROOT}/.animastor-installer/node-deps-constraints.txt`, 'utf8'), 'torch==2.4.0+cu121\n');
        assert.deepStrictEqual(w.kills, [{ pid: 900, sig: 'SIGTERM' }], 'only the inspected main.py, once');
        assert.strictEqual(gate.restarted, true);
        assert.strictEqual(gate.pid_changed, true);
        assert.strictEqual(gate.instance.pid, 901);
        assert.strictEqual(gate.instance.url, url);
        const log = logger.lines.join('\n');
        assert.ok(log.includes(`custom-node dependencies missing in ${PY} (ComfyUI pid 900): qwen3-tts (transformers missing, librosa missing)`), log);
        assert.ok(/the platform started ComfyUI again: pid 900 → 901 at .* node classes present/.test(log), log);
    });

    it('X4: restart NOT allowed (--yes, no record, no flag) → deps installed, the foreign main.py is not signaled, FAILED with the fix', async () => {
        const { io, w, sleep } = depsWorld();
        const inst = await foreignInstance(io);
        const gate = await cli.platformNodeDepsGate(io, {
            instance: inst, state: typeAState(), root: ROOT, manifests: [ttsManifest()], yes: true, boot: false,
            waitMs: 600000, statePath: STATE_PATH, sleep,
        });
        assert.strictEqual(w.kills.length, 0, 'a ComfyUI that is not ours is never stopped without the option');
        assert.strictEqual(gate.failed, true);
        assert.deepStrictEqual(gate.installed, ['qwen3-tts']);
        assert.ok(/was not restarted \(restart of the platform's ComfyUI is off\)/.test(gate.reason), gate.reason);
        assert.ok(/--restart-platform-comfy/.test(gate.fix), gate.fix);
        const res = cli.nodeDepsFailedResult({ gate, mode: 'existing' });
        assert.strictEqual(res.status, 'failed');
        assert.strictEqual(res.e2e[0].ok, false);

        // recorded "no" beats the boot default as well
        const w2 = depsWorld();
        const g2 = await cli.platformNodeDepsGate(w2.io, {
            instance: await foreignInstance(w2.io), state: typeAState({ installer_options: { restartPlatformComfy: false } }),
            root: ROOT, manifests: [ttsManifest()], boot: true, waitMs: 600000, sleep: w2.sleep,
        });
        assert.strictEqual(w2.w.kills.length, 0);
        assert.strictEqual(g2.failed, true);
    });

    it('X5: the platform restarts ComfyUI but the node classes never appear → FAILED naming the new pid', async () => {
        const { io, w, sleep } = depsWorld({ restartAfter: 10000, classesLoad: false });
        const gate = await cli.platformNodeDepsGate(io, {
            instance: await foreignInstance(io), state: typeAState(), root: ROOT, manifests: [ttsManifest()], boot: true,
            waitMs: 120000, sleep,
        });
        assert.strictEqual(gate.failed, true);
        assert.strictEqual(w.pid, 901);
        assert.ok(/the platform started ComfyUI again \(pid 901 at .*\) but it answers, node classes missing: Qwen3TTSLoader, Qwen3TTSVoiceDesign after 120 s/.test(gate.reason), gate.reason);
    });

    it('X6: the platform does not start ComfyUI again within the window → FAILED with a clear reason', async () => {
        const { io, sleep } = depsWorld({ restartAfter: null });
        const gate = await cli.platformNodeDepsGate(io, {
            instance: await foreignInstance(io), state: typeAState(), root: ROOT, manifests: [ttsManifest()], boot: true,
            waitMs: 90000, sleep,
        });
        assert.strictEqual(gate.failed, true);
        assert.strictEqual(gate.restarted, true);
        assert.strictEqual(gate.reason, 'the platform did not start ComfyUI again within 90 s after it was stopped (old pid 900) — start it from the platform console');
    });

    it('X6b: deps already satisfied → nothing installed, nothing stopped', async () => {
        const { io, w, sleep } = depsWorld({ installed: true });
        const gate = await cli.platformNodeDepsGate(io, {
            instance: await foreignInstance(io), state: typeAState(), root: ROOT, manifests: [ttsManifest()], boot: true, waitMs: 600000, sleep,
        });
        assert.strictEqual(gate.failed, false);
        assert.strictEqual(w.pipArgs.length, 0);
        assert.strictEqual(w.kills.length, 0);
    });

    it('X6c: a recycled pid (no longer a main.py) is never signaled', async () => {
        const { io, w } = depsWorld();
        io.fs.writeFileSync('/proc/900/cmdline', ['bash', '-c', 'sleep 1'].join('\0'));
        const rr = await nodeDeps.restartPlatformComfyUI(io, { pid: 900, timeoutMs: 1000 });
        assert.strictEqual(rr.ok, false);
        assert.strictEqual(rr.stopped, false);
        assert.strictEqual(w.kills.length, 0);
    });
});

describe('0.2.4 restart option', () => {
    it('X8: flag > recorded state > boot default; interactive run without a record asks once and records the answer', async () => {
        assert.deepStrictEqual(cli.restartPlatformComfyDecision({ 'restart-platform-comfy': true }, typeAState({ installer_options: { restartPlatformComfy: false } })), { allowed: true, source: 'flag' });
        assert.deepStrictEqual(cli.restartPlatformComfyDecision({ 'no-restart-platform-comfy': true }, null, { boot: true }), { allowed: false, source: 'flag' });
        assert.deepStrictEqual(cli.restartPlatformComfyDecision({}, typeAState({ installer_options: { restartPlatformComfy: false } }), { boot: true }), { allowed: false, source: 'state' });
        assert.deepStrictEqual(cli.restartPlatformComfyDecision({}, typeAState(), { boot: true }), { allowed: true, source: 'boot' });
        assert.deepStrictEqual(cli.restartPlatformComfyDecision({}, typeAState()), { allowed: null, source: 'unset' });
        assert.ok(cli.parseArgs(['n', 'c', 'doctor', '--restart-platform-comfy', '--yes']).flags['restart-platform-comfy'] === true);

        // interactive, deps missing: ONE question (install + restart); "yes" is recorded
        const { io, w, sleep } = depsWorld({ restartAfter: 5000 });
        const questions = [];
        const prompt = { available: true, confirm: async (q) => { questions.push(q); return true; } };
        const gate = await cli.platformNodeDepsGate(io, {
            instance: await foreignInstance(io), state: typeAState(), root: ROOT, manifests: [ttsManifest()], prompt,
            waitMs: 600000, sleep,
        });
        assert.strictEqual(questions.length, 1);
        assert.ok(/^Install the missing Python packages — qwen3-tts \(.*\) — into \/opt\/conda\/bin\/python3 and restart the platform's ComfyUI \(pid 900\) so it loads them\?$/.test(questions[0]), questions[0]);
        assert.strictEqual(gate.failed, false, gate.reason);
        assert.deepStrictEqual(gate.record, { restartPlatformComfy: true });
        assert.strictEqual(w.pid, 901);

        // the record lands in install-state.json and survives the next engine run
        io.fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
        io.fs.writeFileSync(STATE_PATH, JSON.stringify(typeAState()));
        assert.strictEqual(cli.recordInstallerOption(io, STATE_PATH, 'restartPlatformComfy', true), true);
        assert.strictEqual(JSON.parse(io.fs.readFileSync(STATE_PATH, 'utf8')).installer_options.restartPlatformComfy, true);

        // interactive, deps fine, nothing recorded: the option question is asked once
        const w3 = depsWorld({ installed: true });
        const q3 = [];
        const g3 = await cli.platformNodeDepsGate(w3.io, {
            instance: await foreignInstance(w3.io), state: typeAState(), root: ROOT, manifests: [ttsManifest()],
            prompt: { available: true, confirm: async (q) => { q3.push(q); return false; } }, waitMs: 600000, sleep: w3.sleep,
        });
        assert.strictEqual(q3.length, 1);
        assert.deepStrictEqual(g3.record, { restartPlatformComfy: false });
        assert.strictEqual(w3.w.kills.length, 0);
    });
});

// ---------------------------------------------------------------------------

/** A verification-only engine call against the depsWorld io. */
async function verify(io, { url, deadline = null, sleep }) {
    const logger = createLogger({ io, quiet: true });
    const ver = await engine.runVerification({
        io, manifests: [ttsManifest()],
        roots: { comfyuiRoot: ROOT, workerDir: null, hubUrl: 'https://h/gpu' },
        options: { comfyUrl: url, startComfyui: false, nodeClassesDeadline: deadline, pollIntervalMs: 3000, sleep },
        log: logger, crypto: null,
    });
    const cls = (ver.checks || []).find((c) => c.label === 'ComfyUI node classes') || null;
    return { ver, cls, lines: logger.lines };
}

describe('0.2.4 node classes are re-checked until the end of the window', () => {
    it('X7: classes appear 30 s later (the new ComfyUI is still importing) → no missing classes', async () => {
        const { io, w, sleep, url } = depsWorld({ installed: true });
        w.procHasClasses[900] = false;
        const orig = io.http.fetchJson;
        io.http.fetchJson = async (u, o) => {
            if (w.t >= 30000) w.procHasClasses[900] = true;
            return orig(u, o);
        };
        const { ver, cls, lines } = await verify(io, { url, deadline: 600000, sleep });
        assert.strictEqual(cls, null, JSON.stringify(ver.checks));
        assert.ok(lines.some((l) => /node classes not registered yet \(Qwen3TTSLoader, Qwen3TTSVoiceDesign\) — re-checking for up to 600 s/.test(l)), lines.join('\n'));
        assert.ok(lines.some((l) => /node classes registered/.test(l)));
        assert.ok(w.t >= 30000 && w.t < 40000, String(w.t));
    });

    it('X7b: classes never appear → missing at the end of the window (FAILED)', async () => {
        const { io, w, sleep, url } = depsWorld({ installed: true });
        w.procHasClasses[900] = false;
        const { ver, cls } = await verify(io, { url, deadline: 60000, sleep });
        assert.strictEqual(cls.verdict, false);
        assert.ok(cls.detail.startsWith('missing: Qwen3TTSLoader, Qwen3TTSVoiceDesign'), cls.detail);
        assert.ok(w.t >= 60000);
        assert.strictEqual(ver.status, 'FAIL');
    });

    it('X7c: without a reason to wait (no deps installed, same pid) the check fails at once', async () => {
        const { io, w, sleep, url } = depsWorld({ installed: true });
        w.procHasClasses[900] = false;
        const { cls } = await verify(io, { url, deadline: null, sleep });
        assert.strictEqual(cls.verdict, false);
        assert.strictEqual(w.t, 0);
    });
});

describe('0.2.4 type B (managed)', () => {
    it('X9: type B boot does not wait for a platform ComfyUI', () => {
        const state = { mode: 'managed', installer_options: { startComfyui: true }, components: { comfyui: { owned: true } } };
        assert.strictEqual(cli.shouldWaitForPlatformComfy({ waitMs: 600000, instance: { owner: 'none' }, state }), false);
        assert.strictEqual(cli.shouldWaitForPlatformComfy({ waitMs: 600000, instance: { owner: 'none' }, state: typeAState() }), true);
    });

    it('X9b: deps missing in its venv → pip retry into the venv and a restart of its OWN ComfyUI; the platform path is not used', async () => {
        const R = '/c';
        const VPY = `${R}/venv/bin/python`;
        const fs = createMemoryFs({
            [`${R}/main.py`]: '#',
            [VPY]: '',
            [`${R}/custom_nodes/qwen3-tts/requirements.txt`]: 'transformers\n',
        });
        let installed = false;
        const pip = [];
        const io = {
            fs,
            exec(cmd, args = []) {
                if (cmd === VPY && args[0] === '-I') {
                    return { code: 0, stdout: JSON.stringify({ torch: {}, items: [{ name: 'transformers', status: installed ? 'ok' : 'missing' }] }) };
                }
                if (cmd === VPY && args[1] === 'pip') { pip.push(args); installed = true; return { code: 0, stdout: '' }; }
                if (cmd === 'pgrep') return { code: 1, stdout: '' };
                if (/python/.test(cmd) && args[0] === '--version') return { code: 0, stdout: 'Python 3.10.12' };
                if (/python/.test(cmd) && args[0] === '-c') return { code: 0, stdout: '2.4.0+cu121' };
                return { code: 0, stdout: '', stderr: '' };
            },
            spawnDaemon: () => 4242,
            http: { async fetchJson() { throw new Error('ECONNREFUSED'); }, async fetchText() { return { status: 404, text: '' }; } },
            now: () => Date.now(),
        };
        fs.mkdirSync(`${R}/.animastor-installer`, { recursive: true });
        fs.writeFileSync(`${R}/.animastor-installer/install-state.json`, JSON.stringify({
            state_version: 1, mode: 'managed', profiles: ['audio/qwen-tts'], artifacts: {}, decisions: {},
            installer_options: { comfyPort: 8188, startComfyui: false, startWorker: false },
            components: { comfyui: { owned: true, path: R } },
        }));
        const logger = createLogger({ io, quiet: true });
        const comfyOwner = await owner.resolveComfyOwner(io, { state: { components: { comfyui: { owned: true } } }, root: R });
        const result = await engine.runInstallation({
            manifests: [ttsManifest()], mode: 'managed', io,
            roots: { comfyuiRoot: R, workerDir: null, statePath: `${R}/.animastor-installer/install-state.json`, repoRoot: '/repo', hubUrl: 'https://h/gpu' },
            decisions: { worker_setup: false, workflows: 'none', comfyui_update: 'no', apply_fixes: true, install_custom_nodes: true },
            secretProvider: async () => null,
            logger, crypto: require('crypto'),
            options: {
                interruptGuard: false, currentUid: 1000, home: '/home/u', nodeBinary: { bin: '/n22', version: '22.0.0' },
                startComfyui: true, startWorker: false, verifyTimeoutMs: 50, pollIntervalMs: 5, comfyOwner,
            },
            platformAdapter: { ...LINUX, checkBuildPrerequisites: () => ({ ok: true }), sleepCommand: () => ({ cmd: 'true', args: [] }) },
        });
        const log = logger.lines.join('\n');
        assert.ok(log.includes(`custom-node dependencies missing in ${VPY}: qwen3-tts (transformers missing)`), log);
        assert.strictEqual(pip.length, 1, log);
        assert.deepStrictEqual(pip[0].slice(0, 5), ['-m', 'pip', 'install', '-r', `${R}/custom_nodes/qwen3-tts/requirements.txt`]);
        const node = (result.results.custom_nodes || []).find((n) => n.id === 'custom-node:comfyui-qwen3-tts');
        assert.ok(node && node.status === 'installed' && !node.reason, JSON.stringify(result.results.custom_nodes));
        // the restart path of its OWN instance ran (nothing of ours runs here yet → it is started fresh later)
        assert.ok(/custom nodes changed but the managed ComfyUI was not restarted \(no running ComfyUI process found for this installation root\)/.test(log), log);
        assert.ok(!/platform's ComfyUI/.test(log), 'the platform path is not used');
    });
    it('X9c: its own running ComfyUI (python from the process) is restarted after the deps → new pid recorded, classes present', async () => {
        const R = '/c';
        const VPY = `${R}/venv/bin/python`;
        const OLD = 99999999; // never a real pid: the liveness probe sees it gone
        const fs = createMemoryFs({ [`${R}/main.py`]: '#', [VPY]: '', [`${R}/custom_nodes/qwen3-tts/requirements.txt`]: 'transformers\n' });
        fs.mkdirSync(`/proc/${OLD}`, { recursive: true });
        fs.writeFileSync(`/proc/${OLD}/cmdline`, [VPY, 'main.py', '--listen', '127.0.0.1', '--port', '8188'].join('\0'));
        fs.symlinkSync(R, `/proc/${OLD}/cwd`);
        let installed = false;
        let restarted = false;
        const kills = [];
        const io = {
            fs,
            exec(cmd, args = []) {
                if (cmd === VPY && args[0] === '-I') return { code: 0, stdout: JSON.stringify({ torch: {}, items: [{ name: 'transformers', status: installed ? 'ok' : 'missing' }] }) };
                if (cmd === VPY && args[1] === 'pip') { installed = true; return { code: 0, stdout: '' }; }
                if (cmd === 'pgrep') return { code: 0, stdout: String(OLD) };
                if (/python/.test(cmd) && args[0] === '--version') return { code: 0, stdout: 'Python 3.10.12' };
                if (/python/.test(cmd) && args[0] === '-c') return { code: 0, stdout: '2.4.0+cu121' };
                return { code: 0, stdout: '', stderr: '' };
            },
            spawnDaemon: (command, args) => { if (args.includes('main.py')) restarted = true; return 4243; },
            kill: (pid, sig) => kills.push({ pid, sig }),
            http: {
                async fetchJson(u) {
                    if (!restarted) throw new Error('ECONNREFUSED');
                    if (u === 'http://127.0.0.1:8188/system_stats') return COMFY_STATS;
                    if (u === 'http://127.0.0.1:8188/object_info') return { status: 200, json: Object.fromEntries(CLASSES.map((c) => [c, {}])) };
                    throw new Error('ECONNREFUSED');
                },
                async fetchText() { return { status: 404, text: '' }; },
            },
            now: () => Date.now(),
        };
        const statePath = `${R}/.animastor-installer/install-state.json`;
        const st0 = {
            state_version: 1, mode: 'managed', profiles: ['audio/qwen-tts'], artifacts: {}, decisions: {},
            installer_options: { comfyPort: 8188, startComfyui: true, startWorker: false },
            components: { comfyui: { owned: true, path: R } },
            comfyui_runtime: { port: 8188, pid: OLD },
        };
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(st0));
        const comfyOwner = await owner.resolveComfyOwner(io, { state: st0, root: R });
        assert.strictEqual(comfyOwner.owner, 'managed');
        const logger = createLogger({ io, quiet: true });
        await engine.runInstallation({
            manifests: [ttsManifest()], mode: 'managed', io,
            roots: { comfyuiRoot: R, workerDir: null, statePath, repoRoot: '/repo', hubUrl: 'https://h/gpu' },
            decisions: { worker_setup: false, workflows: 'none', comfyui_update: 'no', apply_fixes: true, install_custom_nodes: true },
            secretProvider: async () => null,
            logger, crypto: require('crypto'),
            options: {
                interruptGuard: false, currentUid: 1000, home: '/home/u', nodeBinary: { bin: '/n22', version: '22.0.0' },
                startWorker: false, verifyTimeoutMs: 2000, pollIntervalMs: 5, comfyOwner,
            },
            platformAdapter: { ...LINUX, checkBuildPrerequisites: () => ({ ok: true }), sleepCommand: () => ({ cmd: 'true', args: [] }) },
        });
        const log = logger.lines.join('\n');
        assert.ok(log.includes(`custom-node dependencies missing in ${VPY}`), 'python taken from its own main.py');
        assert.deepStrictEqual(kills, [{ pid: OLD, sig: 'SIGTERM' }], log);
        assert.ok(restarted, 'its own ComfyUI started again');
        assert.ok(/ComfyUI restarted — custom node registry refreshed/.test(log), log);
        const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        assert.strictEqual(st.comfyui_runtime.pid, 4243);
        assert.ok(!/missing: Qwen3TTS/.test(log), log);
    });
});
