'use strict';

/**
 * Installer 0.2.5 — live E2E 02.11, node type A (TIR: the platform runs
 * ComfyUI as root, pid 370, /usr/bin/python3; only /home survives a node
 * restart), profile audio/qwen-tts, mode existing:
 *   - 0.2.4 installed the qwen3-tts pip packages into /usr/bin/python3, then
 *     ended with ✗ "imported nodes before that, restart is off" and the fix
 *     `~/.local/bin/animastor doctor --restart-platform-comfy`;
 *   - but ~/.local/bin/animastor was still 0.2.3 (bundle 2.2.0): the run
 *     ended before "install management tools"; doctor 0.2.3 silently dropped
 *     the unknown flag, restarted nothing and printed "node classes missing"
 *     with the fix `animastor doctor` — a loop.
 *
 *  V1  unknown option / option without a value → error, exit 2 (real CLI).
 *  V2  EVERY fix command the installer prints parses with the CLI of the
 *      same version (known command, known options).
 *  V3  preflight: tools + persistent installer copy + installed bundle are
 *      brought to this version BEFORE any early exit of cmdInstall.
 *  V4  persistent node deps: overlay venv + prestartup custom node (memory
 *      world) and the real mechanism in a real Python.
 *  V5  restart of a foreign ComfyUI: refused signal / unreadable environ
 *      → nothing stopped; deps in place + classes missing + flag → restart
 *      (no loop); an import error that a restart cannot fix is reported.
 *  V6  doctor names the cause of "node classes missing".
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const realFs = require('fs');
const { spawnSync } = require('child_process');

const { createMemoryFs, createRealIo } = require('../src/installer/engine/io');
const { createLogger } = require('../src/installer/engine/logger');
const owner = require('../src/installer/engine/comfy-owner');
const nodeDeps = require('../src/installer/engine/node-deps');
const pydeps = require('../src/installer/engine/pydeps');
const engine = require('../src/installer/engine/engine');
const summary = require('../src/installer/engine/summary');
const { buildVerificationReport } = require('../src/installer/verification-report');
const cli = require('../src/installer/cli');
const pkg = require('../package.json');

const CLI = path.join(__dirname, '..', 'src', 'installer', 'cli.js');
const HOME = '/home/jovyan';
const ROOT = `${HOME}/ComfyUI`;
const WORKER_DIR = `${HOME}/animastor/worker`;
const STATE_PATH = `${ROOT}/.animastor-installer/install-state.json`;
const PREFIX = '/notebook/p-2/n-9';
const PY = '/usr/bin/python3';
const CLASSES = ['Qwen3TTSLoader', 'Qwen3TTSVoiceDesign'];
const COMFY_STATS = { status: 200, json: { system: { os: 'posix' }, devices: [{ name: 'Tesla V100' }] } };
const OVERLAY_SP = `${HOME}/animastor/pydeps/py3.10/lib/python3.10/site-packages`;
const OVERLAY_PY = `${HOME}/animastor/pydeps/py3.10/bin/python`;

function ttsManifest() {
    return {
        profile: { id: 'audio/qwen-tts' },
        runtime_requirements: {},
        dependencies: [{
            id: 'custom-node:comfyui-qwen3-tts', kind: 'custom_node', name: 'ComfyUI-Qwen3-TTS', requirement: 'required',
            install: { directory: 'qwen3-tts' }, provides_classes: CLASSES,
        }],
        workflows: { artifacts: [] },
        worker_bundle: { worker_type: 'audio', files: ['worker.cjs', 'package.json'], env: { required: [], secrets: [] } },
    };
}

function typeAState(extra = {}) {
    return {
        state_version: 1, mode: 'existing', profiles: ['audio/qwen-tts'], artifacts: {}, decisions: {},
        installer_options: { startWorker: true, ...(extra.installer_options || {}) },
        components: { comfyui: { owned: false, path: ROOT } },
        comfy_owner: { owner: 'foreign', pid: 370, url: `http://127.0.0.1:8888${PREFIX}` },
    };
}

/**
 * Type A node on a virtual clock (pid 370 = the platform's main.py, root).
 *   prestartup   — main.py runs prestartup scripts (overlay possible)
 *   sysInstalled — the packages are present in the platform Python itself
 *   overlayInstalled — the packages are in the overlay venv
 *   restartAfter — the platform starts a new main.py after a stop (null = never)
 * A process has the node classes when, at its start, the packages were
 * visible to it: system packages, or overlay packages + the prestartup node.
 */
function world({
    prestartup = true, sysInstalled = false, overlayInstalled = false, overlayExists = false, restartAfter = null,
    classesAt370 = null, log = null, environ = true, killError = null,
} = {}) {
    const files = {
        [`${ROOT}/main.py`]: prestartup ? 'def execute_prestartup_script():\n    # prestartup_script.py\n' : 'import nodes\n',
        [`${ROOT}/custom_nodes/qwen3-tts/requirements.txt`]: 'qwen-tts\nsoundfile\n',
        [`${ROOT}/custom_nodes/qwen3-tts/__init__.py`]: '#',
    };
    if (overlayExists || overlayInstalled) {
        files[`${HOME}/animastor/pydeps/py3.10/pyvenv.cfg`] = 'include-system-site-packages = true\n';
        files[OVERLAY_PY] = '';
    }
    const fs = createMemoryFs(files);
    const w = {
        t: 0, pid: 370, alive: true, killedAt: null, sysInstalled, overlayInstalled,
        classes: {}, kills: [], pip: [], venv: [], checks: [], spawns: [],
    };
    const prestartupPresent = () => fs.existsSync(`${ROOT}/custom_nodes/animastor-pydeps/prestartup_script.py`);
    const visible = () => w.sysInstalled || (w.overlayInstalled && prestartupPresent());
    w.classes[370] = classesAt370 === null ? visible() : classesAt370;
    const url = `http://127.0.0.1:8888${PREFIX}`;
    const writeProc = (pid) => {
        fs.mkdirSync(`/proc/${pid}`, { recursive: true });
        fs.writeFileSync(`/proc/${pid}/cmdline`, [PY, 'main.py', '--listen', '0.0.0.0', '--port', '8888', '--baseurl', PREFIX].join('\0'));
        fs.symlinkSync(ROOT, `/proc/${pid}/cwd`);
        if (environ) fs.writeFileSync(`/proc/${pid}/environ`, ['PATH=/usr/local/bin:/usr/bin', 'HOME=/root'].join('\0'));
    };
    writeProc(370);
    const tick = () => {
        if (!w.alive && w.killedAt != null && restartAfter != null && w.t >= w.killedAt + restartAfter && w.pid === 370) {
            w.pid = 371; w.alive = true; w.classes[371] = visible(); writeProc(371);
        }
    };
    const io = {
        fs,
        exec(cmd, args = []) {
            tick();
            if (cmd === 'pgrep') return w.alive ? { code: 0, stdout: String(w.pid), stderr: '' } : { code: 1, stdout: '', stderr: '' };
            if (args[0] === '-I' && args[1] === '-c' && /version_info/.test(args[2])) return { code: 0, stdout: '3.10\n', stderr: '' };
            if (args[0] === '-I' && args[1] === '-c') {
                const extra = args.slice(4);
                w.checks.push({ cmd, extra });
                const ok = w.sysInstalled || (w.overlayInstalled && extra.includes(OVERLAY_SP));
                const items = [{ line: 'qwen-tts', name: 'qwen-tts', status: ok ? 'ok' : 'missing' }, { line: 'soundfile', name: 'soundfile', status: ok ? 'ok' : 'missing' }];
                return { code: 0, stdout: `${JSON.stringify({ torch: { torch: '2.4.0+cu121' }, items })}\n`, stderr: '' };
            }
            if (args[0] === '-m' && args[1] === 'venv') {
                w.venv.push({ cmd, args });
                const dir = args[args.length - 1];
                fs.mkdirSync(`${dir}/bin`, { recursive: true });
                fs.writeFileSync(`${dir}/pyvenv.cfg`, 'include-system-site-packages = true\n');
                fs.writeFileSync(`${dir}/bin/python`, '');
                return { code: 0, stdout: '', stderr: '' };
            }
            if (args[0] === '-m' && args[1] === 'pip' && args[2] === '--version') return { code: 0, stdout: 'pip 22.0.2', stderr: '' };
            if (args[0] === '-m' && args[1] === 'pip') {
                w.pip.push({ cmd, args });
                if (w.pipFails) return { code: 1, stdout: '', stderr: 'ERROR: No matching distribution found for qwen-tts' };
                if (cmd === OVERLAY_PY) w.overlayInstalled = true; else w.sysInstalled = true;
                return { code: 0, stdout: 'Successfully installed', stderr: '' };
            }
            return { code: 0, stdout: '', stderr: '' };
        },
        spawnDaemon(cmd, args, opts) {
            w.spawns.push({ cmd, args, opts });
            w.pid = 372; w.alive = true; w.classes[372] = visible(); writeProc(372);
            return 372;
        },
        kill(pid, sig) {
            if (killError) { const e = new Error(`kill ${killError}`); e.code = killError; throw e; }
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
                    if (w.classes[w.pid]) for (const c of CLASSES) json[c] = {};
                    return { status: 200, json };
                }
                if (u === `${url}/internal/logs/raw` && log !== null) return { status: 200, json: { entries: [{ t: '', m: log }], size: {} } };
                return { status: 404, json: null };
            },
            async fetchText() { return { status: 404, text: '' }; },
        },
        now: () => w.t,
    };
    const sleep = async (ms) => { w.t += ms; };
    return { io, fs, w, sleep, url };
}

async function foreign(io) {
    const inst = await owner.resolveComfyOwner(io, { state: typeAState(), root: ROOT });
    assert.strictEqual(inst.owner, 'foreign');
    return inst;
}

function gate(env, opts = {}) {
    return foreign(env.io).then((instance) => cli.platformNodeDepsGate(env.io, {
        instance, state: typeAState(opts.stateExtra || {}), root: ROOT, manifests: [ttsManifest()], boot: false, yes: false,
        waitMs: 120000, sleep: env.sleep, statePath: STATE_PATH, workerDir: WORKER_DIR, platformGraceMs: 30000, ...opts,
    }));
}

// ---------------------------------------------------------------------------
// V1  strict command line
// ---------------------------------------------------------------------------

describe('0.2.5 V1 strict command line', () => {
    it('V1a: unknown option, option without value, value on a boolean, stray argument → errors; known ones parse', () => {
        assert.deepStrictEqual(cli.parseArgs(['n', 'c', 'doctor', '--bogus']).errors, ['unknown option --bogus']);
        assert.deepStrictEqual(cli.parseArgs(['n', 'c', 'doctor', '--root']).errors, ['option --root needs a value']);
        assert.deepStrictEqual(cli.parseArgs(['n', 'c', 'doctor', '--root', '--yes']).errors, ['option --root needs a value']);
        assert.deepStrictEqual(cli.parseArgs(['n', 'c', 'doctor', '--yes=1']).errors, ['option --yes takes no value (got --yes=1)']);
        assert.deepStrictEqual(cli.parseArgs(['n', 'c', 'doctor', 'now']).errors, ['unexpected argument(s): now']);
        assert.deepStrictEqual(cli.parseArgs(['n', 'c', 'doctor', '-x']).errors, ['unknown option -x']);
        const ok = cli.parseArgs(['n', 'c', 'doctor', '--restart-platform-comfy', '--yes', '--state', '/s', '--root', '', '--profile=audio/qwen-tts', '-f']);
        assert.deepStrictEqual(ok.errors, []);
        assert.strictEqual(ok.flags.root, '', 'the animastor shim passes --root \'\' — still a value');
        assert.deepStrictEqual(ok.profiles, ['audio/qwen-tts']);
    });

    it('V1b: the real CLI exits 2 on an unknown option BEFORE doing anything, naming the option and its version', () => {
        const r = spawnSync(process.execPath, [CLI, 'doctor', '--restart-platfrom-comfy'], { encoding: 'utf8', env: { ...process.env, HOME: os.tmpdir() } });
        assert.strictEqual(r.status, 2, r.stderr);
        assert.ok(r.stderr.includes(`animastor-installer ${pkg.version}: unknown option --restart-platfrom-comfy`), r.stderr);
        assert.ok(!/re-checking the installation/.test(r.stdout), 'doctor did not run');
    });

    it('V1c: --help exits 0 with usage; an unknown command keeps usage + exit 1', () => {
        const h = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
        assert.strictEqual(h.status, 0);
        assert.ok(/Usage: animastor-installer/.test(h.stderr));
        const u = spawnSync(process.execPath, [CLI, 'frobnicate'], { encoding: 'utf8' });
        assert.strictEqual(u.status, 1);
    });
});

// ---------------------------------------------------------------------------
// V2  every printed fix command parses with the CLI of the same version
// ---------------------------------------------------------------------------

const TOOL = `${HOME}/.local/bin/animastor`;

/** Command lines `<tool> <command> [--options]` inside a fix string. */
function commandsIn(fix, tool = TOOL) {
    const out = [];
    const s = String(fix || '');
    let i = s.indexOf(tool);
    while (i !== -1) {
        const rest = s.slice(i + tool.length).replace(/[`'"]/g, ' ');
        const toks = rest.split(/[\s,;)]+/).filter(Boolean);
        const argv = [];
        if (toks.length > 0) {
            argv.push(toks[0]);
            for (let k = 1; k < toks.length; k++) {
                const t = toks[k];
                if (!t.startsWith('-')) break;
                argv.push(t);
                const key = t.replace(/^--/, '').split('=')[0];
                if (cli.VALUE_FLAGS.includes(key) && !t.includes('=') && toks[k + 1]) { argv.push(toks[k + 1]); k += 1; }
            }
        }
        out.push(argv);
        i = s.indexOf(tool, i + tool.length);
    }
    return out;
}

async function allFixes() {
    const fixes = [];
    const add = (f, where) => { if (f) fixes.push({ fix: f, where }); };
    // verification checks (every label incl. each node-classes cause)
    const labels = ['GPU', 'VRAM', 'ComfyUI running', 'ComfyUI API', 'Worker registration', 'GPU Hub registration', 'Worker process', 'Runtime', 'Custom Nodes', 'Models', 'ComfyUI node classes', 'Worker'];
    for (const mode of ['managed', 'existing']) {
        for (const label of labels) add(summary.fixForCheck({ label, detail: 'incompatible' }, { tool: TOOL, mode }), `fixForCheck ${label}/${mode}`);
        for (const kind of ['deps-missing', 'import-failed', 'restart-needed', 'unknown']) {
            for (const own of ['foreign', 'managed']) add(summary.fixForCheck({ label: 'ComfyUI node classes', cause: { kind, owner: own, log_source: '/x.log' } }, { tool: TOOL, mode }), `node classes ${kind}/${own}`);
        }
    }
    // the platform ComfyUI never came up
    for (const c of cli.platformComfyMissingResult({ waited: { waited_ms: 600000, last_seen: null }, tool: TOOL, mode: 'existing' }).e2e) add(c.fix, 'platformComfyMissing');
    // blocked steps / remediation
    for (const reason of ['accept_runtime_change needed', 'accept_reference_runtime needed', 'other']) {
        for (const c of cli.resultExtras({ blocked: [{ step: 's', reason }], remediation: null }, TOOL)) add(c.fix, `blocked ${reason}`);
    }
    for (const c of cli.resultExtras({ blocked: [], remediation: { code: 'X', command: 'sudo apt-get install -y python3.10-venv' } }, TOOL)) add(c.fix, 'remediation');
    // end-to-end checks
    const e2e = await engine.endToEndChecks({ http: { fetchJson: async () => ({ status: 500 }) }, fs: createMemoryFs({}), now: () => 0 }, {
        mode: 'existing', comfyUrl: null, comfyPort: 8188, hubUrl: 'https://h/gpu', workerWanted: true,
        workerStart: { started: false, reason: 'x' }, workerReady: null, tool: TOOL, platformComfy: true,
    });
    for (const c of e2e) add(c.fix, `e2e ${c.label}`);
    // the node-deps gate: declined, pip failure, restart off, restart failure, import error
    const scenarios = [
        { name: 'declined', env: world(), opts: { prompt: { available: true, confirm: async () => false } } },
        { name: 'pip fails', env: (() => { const e = world(); e.w.pipFails = true; return e; })(), opts: { yes: true } },
        { name: 'restart off', env: world(), opts: { yes: true } },
        { name: 'restart refused (EPERM)', env: world({ killError: 'EPERM' }), opts: { boot: true } },
        { name: 'environ unreadable', env: world({ environ: false }), opts: { boot: true } },
        { name: 'import failed', env: world({ sysInstalled: true, classesAt370: false, log: `** ComfyUI startup time: 1\nCannot import ${ROOT}/custom_nodes/qwen3-tts module for custom nodes: invalid syntax (nodes.py, line 3)\n` }), opts: { yes: true } },
    ];
    for (const sc of scenarios) {
        const g = await gate(sc.env, { ...sc.opts, flags: { 'tools-dir': `${HOME}/animastor/tools` } });
        assert.strictEqual(g.failed, true, `${sc.name}: expected a failed gate`);
        for (const c of cli.nodeDepsFailedResult({ gate: g, mode: 'existing' }).e2e) add(c.fix, `gate ${sc.name}`);
    }
    return fixes;
}

describe('0.2.5 V2 every printed fix command exists in this version', () => {
    it('V2: each `<animastor> <command> [--options]` in every fix parses with parseArgs of this package: known command, no unknown option', async () => {
        const fixes = await allFixes();
        // the gate's fixes name toolCommandPath(): ~/.local/bin/animastor or <tools-dir>/animastor
        const tools = [TOOL, `${HOME}/animastor/tools/animastor`, cli.toolCommandPath({ 'tools-dir': `${HOME}/animastor/tools` })];
        const lines = [];
        for (const { fix, where } of fixes) {
            for (const tool of tools) {
                for (const argv of commandsIn(fix, tool)) {
                    const parsed = cli.parseArgs(['node', 'cli.js', ...argv]);
                    assert.deepStrictEqual(parsed.errors, [], `${where}: "${fix}" → ${argv.join(' ')}`);
                    assert.ok(cli.COMMANDS.includes(parsed.command), `${where}: unknown command in "${fix}"`);
                    assert.ok(!parsed.unknownCommand);
                    lines.push(argv.join(' '));
                }
            }
        }
        const uniq = Array.from(new Set(lines));
        // not vacuous: the commands of this incident are among them
        for (const want of ['doctor --restart-platform-comfy', 'doctor --yes --restart-platform-comfy', 'doctor --new-key', 'reboot-comfyui', 'doctor --accept-runtime-change']) {
            assert.ok(uniq.includes(want), `"${want}" not among ${JSON.stringify(uniq)}`);
        }
        // no node-classes fix is a bare `doctor` (the loop of 02.11)
        for (const { fix, where } of fixes.filter((f) => /^node classes/.test(f.where))) {
            assert.notStrictEqual(fix.trim(), `${TOOL} doctor`, where);
        }
    });

    it('V2b: the fix command of the 02.11 result is `doctor --restart-platform-comfy` and THIS version understands it', () => {
        const parsed = cli.parseArgs(['n', 'c', 'doctor', '--restart-platform-comfy']);
        assert.deepStrictEqual(parsed.errors, []);
        assert.strictEqual(cli.restartPlatformComfyDecision(parsed.flags, typeAState()).allowed, true);
    });
});

// ---------------------------------------------------------------------------
// V3  preflight: tools and bundle of this version before any early exit
// ---------------------------------------------------------------------------

describe('0.2.5 V3 tools and worker bundle are updated before any early exit', () => {
    let tmp;
    beforeEach(() => { tmp = realFs.mkdtempSync(path.join(os.tmpdir(), 'anim-v025-')); });
    afterEach(() => { realFs.rmSync(tmp, { recursive: true, force: true }); });

    function layout() {
        const home = tmp;
        const base = path.join(home, 'animastor');
        const workerDir = path.join(base, 'worker');
        const toolsDir = path.join(base, 'tools');
        const root = path.join(home, 'ComfyUI');
        const statePath = path.join(root, '.animastor-installer', 'install-state.json');
        // installed 0.2.3 tools + bundle 2.2.0
        realFs.mkdirSync(path.join(base, 'installer', 'src', 'installer'), { recursive: true });
        realFs.writeFileSync(path.join(base, 'installer', 'package.json'), JSON.stringify({ version: '0.2.3' }));
        realFs.writeFileSync(path.join(base, 'installer', 'src', 'installer', 'cli.js'), '// 0.2.3');
        realFs.mkdirSync(workerDir, { recursive: true });
        realFs.writeFileSync(path.join(workerDir, 'worker.cjs'), '// 2.2.0');
        realFs.writeFileSync(path.join(workerDir, 'package.json'), JSON.stringify({ version: '2.2.0' }));
        realFs.writeFileSync(path.join(workerDir, '.env'), 'ANIMASTOR_WORKER_TOKEN=keep\n');
        // this installer: package root with the bundled worker 2.2.1
        const pkgRoot = path.join(tmp, 'unpacked', 'animastor-installer');
        realFs.mkdirSync(path.join(pkgRoot, 'src', 'installer'), { recursive: true });
        realFs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ version: pkg.version }));
        realFs.writeFileSync(path.join(pkgRoot, 'src', 'installer', 'cli.js'), `// ${pkg.version}`);
        realFs.mkdirSync(path.join(pkgRoot, 'worker', 'worker'), { recursive: true });
        realFs.writeFileSync(path.join(pkgRoot, 'worker', 'worker', 'worker.cjs'), '// 2.2.1');
        realFs.writeFileSync(path.join(pkgRoot, 'worker', 'worker', 'package.json'), JSON.stringify({ version: '2.2.1' }));
        realFs.mkdirSync(root, { recursive: true });
        return { home, base, workerDir, toolsDir, root, statePath, pkgRoot, linkDir: path.join(home, '.local', 'bin') };
    }

    it('V3a: 0.2.3 tools + bundle 2.2.0 → the animastor command runs THIS version, bundle 2.2.1, .env kept; no extra ✗ lines', async () => {
        const L = layout();
        const io = createRealIo();
        const pre = await cli.preflightSelfUpdate(io, {
            flags: { 'worker-dir': L.workerDir, 'tools-dir': L.toolsDir }, statePath: L.statePath, root: L.root, workerDir: L.workerDir,
            hubUrl: null, repoRoot: L.pkgRoot, manifests: [ttsManifest()], nodeBin: process.execPath, home: L.home, linkDir: L.linkDir,
            installerSrcRoot: L.pkgRoot, cliPath: path.join(L.pkgRoot, 'src', 'installer', 'cli.js'),
        });
        assert.strictEqual(pre.tools_error, null);
        assert.strictEqual(pre.tools_version, pkg.version);
        assert.strictEqual(JSON.parse(realFs.readFileSync(path.join(L.base, 'installer', 'package.json'), 'utf8')).version, pkg.version);
        const shim = realFs.readFileSync(path.join(L.toolsDir, 'animastor'), 'utf8');
        assert.ok(shim.includes(path.join(L.base, 'installer', 'src', 'installer', 'cli.js')), shim);
        assert.strictEqual(realFs.readlinkSync(path.join(L.linkDir, 'animastor')), path.join(L.toolsDir, 'animastor'));
        assert.strictEqual(pre.bundle.status, 'updated');
        assert.strictEqual(JSON.parse(realFs.readFileSync(path.join(L.workerDir, 'package.json'), 'utf8')).version, '2.2.1');
        assert.strictEqual(realFs.readFileSync(path.join(L.workerDir, '.env'), 'utf8'), 'ANIMASTOR_WORKER_TOKEN=keep\n');
        assert.deepStrictEqual(cli.preflightExtras(pre), []);
    });

    it('V3b: tools that cannot be updated → the result says the command is still the old version (not a silent mismatch)', async () => {
        const L = layout();
        const io = createRealIo();
        realFs.writeFileSync(L.toolsDir, 'a file where the tools dir should be');
        const pre = await cli.preflightSelfUpdate(io, {
            flags: { 'worker-dir': L.workerDir, 'tools-dir': L.toolsDir }, statePath: L.statePath, root: L.root, workerDir: L.workerDir,
            hubUrl: null, repoRoot: L.pkgRoot, manifests: [ttsManifest()], nodeBin: process.execPath, home: L.home, linkDir: L.linkDir,
            installerSrcRoot: L.pkgRoot, cliPath: path.join(L.pkgRoot, 'src', 'installer', 'cli.js'),
        });
        assert.ok(pre.tools_error);
        const extra = cli.preflightExtras(pre);
        assert.strictEqual(extra.length, 1);
        assert.strictEqual(extra[0].label, 'Management tools');
        assert.ok(extra[0].detail.includes(`runs installer 0.2.3, this installer is ${pkg.version}`), extra[0].detail);
        // and it is in the printed result of an early exit
        const res = cli.resultExtras({ blocked: [], preflight: pre }, TOOL);
        assert.strictEqual(res[0].label, 'Management tools');
    });

    it('V3c: --no-tools and --dry-run never touch the tools', async () => {
        const L = layout();
        const io = createRealIo();
        const pre = await cli.preflightSelfUpdate(io, {
            flags: { 'worker-dir': L.workerDir, 'tools-dir': L.toolsDir, 'no-tools': true }, statePath: L.statePath, root: L.root,
            workerDir: L.workerDir, repoRoot: L.pkgRoot, manifests: [], home: L.home, linkDir: L.linkDir, installerSrcRoot: L.pkgRoot,
        });
        assert.ok(pre.tools_skipped);
        assert.ok(!realFs.existsSync(path.join(L.toolsDir, 'animastor')));
        assert.deepStrictEqual(cli.preflightExtras(pre), []);
        const dry = await cli.preflightSelfUpdate(io, { flags: { 'tools-dir': L.toolsDir }, dryRun: true });
        assert.strictEqual(dry.tools_skipped, 'dry-run');
    });

    it('V3d: in cmdInstall the preflight runs before the host gates and before EVERY early result', () => {
        const src = realFs.readFileSync(CLI, 'utf8');
        const body = src.slice(src.indexOf('async function cmdInstall('), src.indexOf('function installOptions('));
        const pre = body.indexOf('await preflightSelfUpdate(realIo');
        assert.ok(pre > 0, 'preflight is called in cmdInstall');
        for (const marker of ['platformComfyGate(realIo', 'platformNodeDepsGate(realIo', 'runHostGates(realIo', 'printResult(', 'printFinal(', 'runInstallation(']) {
            const at = body.indexOf(marker);
            assert.ok(at > pre, `${marker} comes after the preflight`);
        }
    });
});

// ---------------------------------------------------------------------------
// V4  persistent node dependencies
// ---------------------------------------------------------------------------

describe('0.2.5 V4 node dependencies survive a node restart', () => {
    it('V4a: missing deps → overlay venv (--without-pip --system-site-packages) + pip in the overlay + prestartup node; restart of the same command line', async () => {
        const env = world({ restartAfter: null });
        const logger = createLogger({ io: env.io, quiet: true });
        const g = await gate(env, { boot: true, logger });
        assert.strictEqual(g.failed, false, g.reason);
        assert.deepStrictEqual(env.w.venv[0].args, ['-m', 'venv', '--without-pip', '--system-site-packages', `${HOME}/animastor/pydeps/py3.10`]);
        assert.strictEqual(env.w.venv[0].cmd, PY);
        assert.strictEqual(env.w.pip.length, 1);
        assert.strictEqual(env.w.pip[0].cmd, OVERLAY_PY, 'pip runs in the overlay, never into /usr/bin/python3');
        const script = env.fs.readFileSync(`${ROOT}/custom_nodes/animastor-pydeps/prestartup_script.py`, 'utf8');
        assert.ok(script.startsWith(pydeps.PRESTARTUP_MARKER));
        assert.ok(script.includes(JSON.stringify(`${HOME}/animastor/pydeps`)));
        assert.deepStrictEqual(g.record.nodeDeps, { target: 'overlay', overlay: OVERLAY_SP, python: PY });
        // the re-check after pip sees the overlay exactly as ComfyUI does
        assert.ok(env.w.checks[env.w.checks.length - 1].extra.includes(OVERLAY_SP), JSON.stringify(env.w.checks));
        assert.strictEqual(g.restart.started_by, 'installer');
        assert.strictEqual(env.w.spawns[0].cmd, PY);
        assert.deepStrictEqual(env.w.spawns[0].args, ['main.py', '--listen', '0.0.0.0', '--port', '8888', '--baseurl', PREFIX]);
        assert.strictEqual(g.instance.pid, 372);
    });

    it('V4b: after a node restart (system packages gone, overlay + prestartup in /home) the platform ComfyUI already has the classes: no pip, no restart', async () => {
        const first = world({ restartAfter: null });
        await gate(first, { boot: true });
        // "node restart": /usr is fresh, /home is kept
        const env = world({ overlayInstalled: true, sysInstalled: false });
        for (const f of ['prestartup_script.py', '__init__.py']) {
            const p = `${ROOT}/custom_nodes/animastor-pydeps/${f}`;
            env.fs.mkdirSync(path.dirname(p), { recursive: true });
            env.fs.writeFileSync(p, first.fs.readFileSync(p, 'utf8'));
        }
        env.w.classes[370] = true; // started with the prestartup node in place
        const g = await gate(env, { boot: true });
        assert.strictEqual(g.failed, false, g.reason);
        assert.strictEqual(env.w.pip.length, 0);
        assert.strictEqual(env.w.kills.length, 0);
        assert.strictEqual(env.w.venv.length, 0);
    });

    it('V4c: an old ComfyUI without prestartup scripts → 0.2.4 fallback into the platform Python, with a warning', async () => {
        const env = world({ prestartup: false, restartAfter: 5000 });
        const logger = createLogger({ io: env.io, quiet: true });
        const g = await gate(env, { boot: true, logger });
        assert.strictEqual(g.failed, false, g.reason);
        assert.strictEqual(env.w.pip[0].cmd, PY);
        assert.strictEqual(env.w.venv.length, 0);
        assert.ok(logger.lines.join('\n').includes('they are lost with a node restart'), logger.lines.join('\n'));
        assert.strictEqual(g.record.nodeDeps.target, 'system');
    });

    it('V4d: the prestartup node is idempotent and a foreign file of the same name is never overwritten', () => {
        const fs = createMemoryFs({});
        const io = { fs };
        assert.strictEqual(pydeps.ensurePrestartupNode(io, { root: ROOT, base: '/b' }).status, 'created');
        assert.strictEqual(pydeps.ensurePrestartupNode(io, { root: ROOT, base: '/b' }).status, 'unchanged');
        assert.strictEqual(pydeps.ensurePrestartupNode(io, { root: ROOT, base: '/c' }).status, 'updated');
        fs.writeFileSync(`${ROOT}/custom_nodes/animastor-pydeps/prestartup_script.py`, 'print("mine")');
        assert.strictEqual(pydeps.ensurePrestartupNode(io, { root: ROOT, base: '/b' }).status, 'foreign');
        assert.strictEqual(fs.readFileSync(`${ROOT}/custom_nodes/animastor-pydeps/prestartup_script.py`, 'utf8'), 'print("mine")');
    });

    it('V4e: REAL Python — overlay venv without ensurepip, system pip installs only what is missing, the prestartup script (run like ComfyUI runs it) makes it importable', function () {
        this.timeout(60000);
        const py = spawnSync('python3', ['-c', 'import venv, pip'], { encoding: 'utf8' });
        if (py.status !== 0) this.skip();
        const tmp = realFs.mkdtempSync(path.join(os.tmpdir(), 'anim-pydeps-'));
        try {
            const io = createRealIo();
            const base = path.join(tmp, 'animastor', 'pydeps');
            const root = path.join(tmp, 'ComfyUI');
            realFs.mkdirSync(root, { recursive: true });
            realFs.writeFileSync(path.join(root, 'main.py'), '# execute_prestartup_script: prestartup_script.py\n');
            const plan = pydeps.planPersistence(io, { python: 'python3', root, base, create: true });
            if (plan.kind !== 'overlay') this.skip(); // e.g. no pip module for the host python
            // a wheel built by hand (no network, no setuptools)
            const wheelDir = path.join(tmp, 'wheels');
            realFs.mkdirSync(wheelDir);
            const mk = spawnSync('python3', ['-I', '-c', [
                'import zipfile, hashlib, base64, sys',
                'files = {"animtestpkg/__init__.py": b"X = 1\\n", "animtestpkg-1.0.dist-info/METADATA": b"Metadata-Version: 2.1\\nName: animtestpkg\\nVersion: 1.0\\n", "animtestpkg-1.0.dist-info/WHEEL": b"Wheel-Version: 1.0\\nGenerator: t\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n"}',
                'rec = []',
                'z = zipfile.ZipFile(sys.argv[1] + "/animtestpkg-1.0-py3-none-any.whl", "w")',
                'for n, b in files.items():',
                '    z.writestr(n, b)',
                '    rec.append("%s,sha256=%s,%d" % (n, base64.urlsafe_b64encode(hashlib.sha256(b).digest()).rstrip(b"=").decode(), len(b)))',
                'rec.append("animtestpkg-1.0.dist-info/RECORD,,")',
                'z.writestr("animtestpkg-1.0.dist-info/RECORD", "\\n".join(rec) + "\\n")',
                'z.close()',
            ].join('\n'), wheelDir], { encoding: 'utf8' });
            assert.strictEqual(mk.status, 0, mk.stderr);
            const reqDir = path.join(root, 'custom_nodes', 'tts');
            realFs.mkdirSync(reqDir, { recursive: true });
            realFs.writeFileSync(path.join(reqDir, 'requirements.txt'), 'animtestpkg\npip\n');
            const manifests = [{ dependencies: [{ id: 'n', kind: 'custom_node', requirement: 'required', install: { directory: 'tts' }, provides_classes: ['T'] }] }];
            const before = nodeDeps.checkNodeDeps(io, { python: 'python3', root, manifests, extraPaths: [plan.sitePackages] });
            assert.deepStrictEqual(before.nodes[0].unsatisfied.map((u) => u.name), ['animtestpkg'], 'pip (system) counts as satisfied');
            const r = io.exec(plan.paths.python, ['-m', 'pip', 'install', '--no-index', '--find-links', wheelDir, '-r', path.join(reqDir, 'requirements.txt')], { timeout: 60000 });
            assert.strictEqual(r.code, 0, r.stderr);
            const sp = realFs.readdirSync(plan.sitePackages);
            assert.ok(sp.includes('animtestpkg'), sp.join(','));
            assert.ok(!sp.some((n) => /^pip/.test(n)), 'the platform pip is NOT copied into the overlay');
            const after = nodeDeps.checkNodeDeps(io, { python: 'python3', root, manifests, extraPaths: [plan.sitePackages] });
            assert.strictEqual(after.nodes.length, 0);
            assert.strictEqual(pydeps.ensurePrestartupNode(io, { root, base }).status, 'created');
            // ComfyUI: execute_prestartup_script → spec_from_file_location + exec_module, then the node imports
            const run = spawnSync('python3', ['-I', '-c', [
                'import importlib.util, sys',
                'spec = importlib.util.spec_from_file_location("prestartup_script", sys.argv[1])',
                'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
                'import animtestpkg; print("IMPORTED", animtestpkg.X)',
            ].join('\n'), path.join(root, 'custom_nodes', 'animastor-pydeps', 'prestartup_script.py')], { encoding: 'utf8' });
            assert.strictEqual(run.status, 0, run.stderr);
            assert.ok(/IMPORTED 1/.test(run.stdout), run.stdout);
            assert.ok(run.stdout.includes('[animastor] node dependencies:'), run.stdout);
        } finally {
            realFs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// V5  restart of the platform's ComfyUI
// ---------------------------------------------------------------------------

describe('0.2.5 V5 restart of a ComfyUI the installer did not start', () => {
    it('V5a: deps in place, classes missing, `doctor --restart-platform-comfy` → it IS restarted (the printed fix does not loop)', async () => {
        const env = world({ sysInstalled: true, classesAt370: false, restartAfter: null });
        const g = await gate(env, { flags: { 'restart-platform-comfy': true } });
        assert.strictEqual(g.failed, false, g.reason);
        assert.deepStrictEqual(env.w.kills, [{ pid: 370, sig: 'SIGTERM' }]);
        assert.strictEqual(env.w.pip.length, 0);
        assert.strictEqual(g.instance.pid, 372);
    });

    it('V5b: same state without consent (--yes, nothing recorded) → not signaled; the fix is the flag', async () => {
        const env = world({ sysInstalled: true, classesAt370: false });
        const g = await gate(env, { yes: true });
        assert.strictEqual(env.w.kills.length, 0);
        assert.strictEqual(g.failed, true);
        assert.ok(g.fix.endsWith('doctor --restart-platform-comfy'), g.fix);
    });

    it('V5c: the platform restarts it by itself within the grace window → the installer starts nothing', async () => {
        const env = world({ sysInstalled: true, classesAt370: false, restartAfter: 10000 });
        const g = await gate(env, { boot: true });
        assert.strictEqual(g.failed, false, g.reason);
        assert.strictEqual(env.w.spawns.length, 0);
        assert.strictEqual(g.restart.started_by, 'platform');
        assert.strictEqual(g.instance.pid, 371);
    });

    it('V5d: a refused signal (EPERM) or an unreadable environ → nothing is stopped or started', async () => {
        const a = world({ sysInstalled: true, classesAt370: false, killError: 'EPERM' });
        const ga = await gate(a, { boot: true });
        assert.strictEqual(ga.failed, true);
        assert.strictEqual(ga.restarted, false);
        assert.ok(/cannot stop the ComfyUI process \(pid 370\): EPERM/.test(ga.reason), ga.reason);
        assert.strictEqual(a.w.spawns.length, 0);
        const b = world({ sysInstalled: true, classesAt370: false, environ: false });
        const gb = await gate(b, { boot: true });
        assert.strictEqual(gb.failed, true);
        assert.strictEqual(b.w.kills.length, 0);
        assert.ok(/environment of the ComfyUI process \(pid 370\) is not readable/.test(gb.reason), gb.reason);
    });

    it('V5e: an import error a restart cannot fix (log: IMPORT FAILED, not a missing module) → reported, the boot run does not restart on every boot', async () => {
        const log = `old run\nCannot import ${ROOT}/custom_nodes/qwen3-tts module for custom nodes: No module named 'qwen_tts'\n** ComfyUI startup time: 2026-11-02\nCannot import ${ROOT}/custom_nodes/qwen3-tts module for custom nodes: invalid syntax (nodes.py, line 3)\n   0.0 seconds (IMPORT FAILED): ${ROOT}/custom_nodes/qwen3-tts\n`;
        const env = world({ sysInstalled: true, classesAt370: false, log });
        const g = await gate(env, { boot: true });
        assert.strictEqual(env.w.kills.length, 0);
        assert.strictEqual(g.failed, true);
        assert.ok(g.reason.includes('IMPORT FAILED — invalid syntax (nodes.py, line 3)'), g.reason);
        assert.ok(g.fix.includes('/internal/logs/raw'), g.fix);
    });
});

// ---------------------------------------------------------------------------
// V6  doctor names the cause of missing node classes
// ---------------------------------------------------------------------------

describe('0.2.5 V6 cause of "node classes missing"', () => {
    it('V6a: parseImportFailures keeps only the last startup of an appended log', () => {
        const f = nodeDeps.parseImportFailures(`Cannot import /r/custom_nodes/a module for custom nodes: x\n** ComfyUI startup time: 1\n   0.1 seconds (IMPORT FAILED): /r/custom_nodes/b\n`);
        assert.deepStrictEqual(f, [{ dir: '/r/custom_nodes/b', name: 'b', error: null }]);
    });

    it('V6b: deps missing / restart needed (ModuleNotFound at startup, packages present now) / import failed — each with its own fix', async () => {
        const cases = [
            { env: world({ sysInstalled: false, classesAt370: false }), kind: 'deps-missing', fix: `${TOOL} doctor --yes --restart-platform-comfy` },
            { env: world({ sysInstalled: true, classesAt370: false, log: `Cannot import ${ROOT}/custom_nodes/qwen3-tts module for custom nodes: No module named 'qwen_tts'\n` }), kind: 'restart-needed', fix: `${TOOL} doctor --restart-platform-comfy` },
            { env: world({ sysInstalled: true, classesAt370: false }), kind: 'restart-needed', fix: `${TOOL} doctor --restart-platform-comfy` },
            { env: world({ sysInstalled: true, classesAt370: false, log: `Cannot import ${ROOT}/custom_nodes/qwen3-tts module for custom nodes: CUDA error\n` }), kind: 'import-failed', fix: null },
        ];
        for (const c of cases) {
            const d = await nodeDeps.diagnoseMissingClasses(c.env.io, {
                missingClasses: CLASSES, manifests: [ttsManifest()], root: ROOT, url: c.env.url, pid: 370,
            });
            assert.strictEqual(d.kind, c.kind, d.detail);
            const rep = buildVerificationReport({ report: {
                entries: [{ kind: 'custom_node', id: 'custom-node:comfyui-qwen3-tts', requirement: 'required', status: 'installed' }],
                hardware: { device: 'cuda', gpu: { name: 'V100' } },
            }, live: { comfyui: { running: true, api_reachable: true, missing_node_classes: CLASSES, missing_node_classes_cause: { kind: d.kind, detail: d.detail, owner: 'foreign', log_source: d.log_source } } } });
            const chk = rep.checks.find((x) => x.label === 'ComfyUI node classes');
            assert.ok(chk.detail.includes(d.detail), chk.detail);
            const fix = summary.fixForCheck(chk, { tool: TOOL, mode: 'existing' });
            if (c.fix) assert.strictEqual(fix, c.fix);
            else assert.ok(/fix the import error .*\/internal\/logs\/raw.*doctor --restart-platform-comfy/.test(fix), fix);
            assert.notStrictEqual(fix, `${TOOL} doctor`);
        }
    });

    it('V6c: runVerification attaches the cause (log line + check detail) when classes stay missing', async () => {
        const env = world({ sysInstalled: true, classesAt370: false, log: `Cannot import ${ROOT}/custom_nodes/qwen3-tts module for custom nodes: No module named 'qwen_tts'\n` });
        const logger = createLogger({ io: env.io, quiet: true });
        const ver = await engine.runVerification({
            io: env.io, manifests: [ttsManifest()],
            roots: { comfyuiRoot: ROOT, workerDir: WORKER_DIR, hubUrl: 'https://h/gpu' },
            options: { comfyUrl: env.url, startComfyui: false, comfyOwner: { owner: 'foreign', pid: 370 } },
            log: logger, crypto: null,
        });
        const chk = (ver.checks || []).find((c) => c.label === 'ComfyUI node classes');
        assert.ok(chk, JSON.stringify(ver.checks));
        assert.strictEqual(chk.cause.kind, 'restart-needed');
        assert.ok(/ComfyUI restart needed: qwen3-tts: the running ComfyUI \(pid 370\) failed to import it at startup \(No module named 'qwen_tts'\)/.test(chk.detail), chk.detail);
        assert.strictEqual(summary.fixForCheck(chk, { tool: TOOL, mode: 'existing' }), `${TOOL} doctor --restart-platform-comfy`);
    });
});

describe('0.2.5 V7 uninstall knows the overlay', () => {
    it('V7: the overlay base and the prestartup node are registered as owned service paths', async () => {
        const env = world({ restartAfter: null });
        const g = await gate(env, { boot: true });
        assert.deepStrictEqual(cli.nodeDepsOwnedServices(g), [
            { id: 'node-deps-overlay', path: `${HOME}/animastor/pydeps` },
            { id: 'node-deps-prestartup-node', path: `${ROOT}/custom_nodes/animastor-pydeps` },
        ]);
        env.fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
        env.fs.writeFileSync(STATE_PATH, JSON.stringify(typeAState()));
        assert.strictEqual(cli.recordOwnedServices(env.io, STATE_PATH, cli.nodeDepsOwnedServices(g)), true);
        const st = JSON.parse(env.fs.readFileSync(STATE_PATH, 'utf8'));
        assert.deepStrictEqual(st.components.services.map((e) => e.id), ['node-deps-overlay', 'node-deps-prestartup-node']);
    });
});
