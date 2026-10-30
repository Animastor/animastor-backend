'use strict';

/**
 * Installer 0.2.2 — E2E 2026-10-30 on a TIR node (V100, "type A").
 *
 *  O1-O6  ComfyUI ownership BY FACT: a platform process (`main.py --listen
 *         0.0.0.0 --port 8888 --baseurl /notebook/…`) that the installer did
 *         not start means mode=existing and ITS address (from the cmdline,
 *         confirmed by a ComfyUI /system_stats payload); managed only when the
 *         installer created the ComfyUI and nobody else runs it; an
 *         install-state that contradicts the machine is reported as a
 *         conflict; the installer's own extra instance is offered for stop.
 *  F1-F2  the fix list is APPLIED (COMFY_URL / COMFY_PORT / NOTEBOOK_PATH
 *         really change in .env), contains only real changes, and a second
 *         run has no fix list.
 *  D1     decisions already answered (optional workflows = no) are remembered,
 *         so a re-run asks nothing.
 *  H1     the hub version is detected instead of printing "hub unknown".
 *  P1     the PATH block is restored after the dotfiles are reset on boot.
 *  S1     ~/animastor/start-worker.sh becomes the `animastor start` wrapper,
 *         the old script is backed up, re-runs are idempotent.
 *  B1-B3  the boot path (`doctor --yes`, no TTY): one line, exit 0/1, missing
 *         apt packages installed without questions.
 */

const assert = require('assert');

const { createMemoryFs } = require('../src/installer/engine/io');
const probe = require('../src/installer/engine/probe');
const owner = require('../src/installer/engine/comfy-owner');
const fixes = require('../src/installer/engine/fixes');
const workerMod = require('../src/installer/engine/worker');
const management = require('../src/installer/management');
const prereq = require('../src/installer/engine/prereq');
const planMod = require('../src/installer/install-plan');
const resolver = require('../src/installer/compatibility-resolver');
const cli = require('../src/installer/cli');
const LINUX = require('../src/installer/platform/linux');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TIR_ROOT = '/home/jovyan/ComfyUI';
const NB_PREFIX = '/notebook/p-13097/n-42';
const NB_URL = `http://127.0.0.1:8888${NB_PREFIX}`;

const COMFY_STATS = { status: 200, json: { system: { os: 'posix', comfyui_version: '0.3.40' }, devices: [{ name: 'Tesla V100' }] } };
const NOT_COMFY = { status: 200, json: { ok: true } };

/**
 * io with a memory fs and a scripted /proc: one dir per process with a
 * `cmdline` file and a `cwd` symlink, exactly what listRunningComfyUI reads.
 */
function makeIo({ procs = [], http = {}, files = {}, exec = null } = {}) {
    const fs = createMemoryFs(files);
    const calls = { exec: [], spawn: [] };
    for (const p of procs) {
        const dir = `/proc/${p.pid}`;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(`${dir}/cmdline`, p.cmdline.join('\0'));
        fs.symlinkSync(p.root || TIR_ROOT, `${dir}/cwd`);
    }
    const io = {
        fs,
        calls,
        exec(cmd, args = [], opts = {}) {
            calls.exec.push({ cmd, args, opts });
            if (exec) {
                const r = exec(cmd, args, opts);
                if (r) return r;
            }
            if (cmd === 'pgrep') {
                if (procs.length === 0) return { code: 1, stdout: '', stderr: '' };
                return { code: 0, stdout: procs.map((p) => String(p.pid)).join('\n'), stderr: '' };
            }
            return { code: 1, stdout: '', stderr: '' };
        },
        spawnDaemon(command, args = [], opts = {}) {
            calls.spawn.push({ command, args, opts });
            return 555001;
        },
        kill(pid, signal) {
            calls.kill = { pid, signal };
        },
        http: {
            async fetchJson(url) {
                const handler = http[url];
                if (!handler) return { status: 404, json: null };
                if (typeof handler === 'function') return handler();
                return handler;
            },
            async fetchText(url) {
                const handler = http[url];
                if (!handler) return { status: 404, text: '' };
                if (typeof handler === 'function') return handler();
                return handler;
            },
        },
        now: () => Date.now(),
    };
    return { io, fs, calls };
}

function platformProc(extra = {}) {
    return {
        pid: 777,
        root: TIR_ROOT,
        cmdline: ['python3', `${TIR_ROOT}/main.py`, '--listen', '0.0.0.0', '--port', '8888', '--baseurl', NB_PREFIX],
        ...extra,
    };
}

function ourProc() {
    return { pid: 778, root: TIR_ROOT, cmdline: ['python3', 'main.py', '--listen', '127.0.0.1', '--port', '8188'] };
}

/** State recorded by the morning run that wrongly went managed. */
function managedState() {
    return {
        mode: 'managed',
        comfyui_runtime: { port: 8188, pid: 778 },
        installer_options: { comfyPort: 8188, startComfyui: true, startWorker: true },
        components: { comfyui: { owned: false, path: TIR_ROOT } },
    };
}

function ttsManifest() {
    return {
        profile: { id: 'audio/qwen-tts' },
        runtime_requirements: {},
        dependencies: [],
        workflows: { artifacts: [] },
        worker_bundle: {
            worker_type: 'audio',
            files: ['worker.cjs', 'package.json'],
            env: { required: ['HUB_URL', 'ANIMASTOR_WORKER_TOKEN', 'WORKER_TYPE'], secrets: ['ANIMASTOR_WORKER_TOKEN'] },
        },
    };
}

// ---------------------------------------------------------------------------
// O: ownership by fact
// ---------------------------------------------------------------------------

describe('0.2.2 ownership by fact', () => {
    it('O1: the platform process decides the mode; its --baseurl is used and verified', async () => {
        const { io } = makeIo({
            procs: [platformProc()],
            http: {
                [`http://127.0.0.1:8888/system_stats`]: { status: 404, json: null }, // 404 without the prefix
                [`${NB_URL}/system_stats`]: COMFY_STATS,
            },
        });
        const r = await owner.resolveComfyOwner(io, {});
        assert.strictEqual(r.owner, 'foreign');
        assert.strictEqual(r.mode, 'existing');
        assert.strictEqual(r.url, NB_URL, 'address taken from --port/--baseurl, not 8188');
        assert.strictEqual(r.port, 8888);
        assert.strictEqual(r.baseurl, NB_PREFIX);
        assert.strictEqual(r.pid, 777);
        assert.deepStrictEqual(owner.decideStartComfy({ owner: r.owner, requested: true, remembered: true, mode: r.mode }), {
            startComfyui: false, ignored_request: true, corrected: true,
            reason: 'another ComfyUI already runs on this machine — the installer never starts a second one',
        });
    });

    it('O2: an install-state that says managed is reported as a conflict and corrected', async () => {
        const { io } = makeIo({
            procs: [platformProc()],
            http: { [`${NB_URL}/system_stats`]: COMFY_STATS },
        });
        const r = await owner.resolveComfyOwner(io, { state: managedState() });
        const keys = r.conflicts.map((c) => c.key);
        assert.ok(keys.includes('mode'), JSON.stringify(r.conflicts));
        assert.ok(keys.includes('startComfyui'), JSON.stringify(r.conflicts));
        assert.ok(keys.includes('comfyPort'), JSON.stringify(r.conflicts));
        assert.strictEqual(r.mode, 'existing');
    });

    it('O3: managed only for the installer\'s own instance (127.0.0.1, recorded pid/port)', async () => {
        const { io } = makeIo({
            procs: [ourProc()],
            http: { 'http://127.0.0.1:8188/system_stats': COMFY_STATS },
        });
        const state = { mode: 'managed', comfyui_runtime: { port: 8188, pid: 778 } };
        const r = await owner.resolveComfyOwner(io, { state });
        assert.strictEqual(r.owner, 'managed');
        assert.strictEqual(r.mode, 'managed');
        assert.strictEqual(r.url, 'http://127.0.0.1:8188');
        assert.deepStrictEqual(r.conflicts, []);
    });

    it('O3b: nothing running — disk truth decides (owned → managed, existing down → existing, clean → managed)', async () => {
        const empty = makeIo({ procs: [], files: { [`${TIR_ROOT}/main.py`]: '# comfy' } });
        const notOwned = await owner.resolveComfyOwner(empty.io, {
            state: { mode: 'managed', components: { comfyui: { owned: false } } },
            root: TIR_ROOT,
        });
        assert.strictEqual(notOwned.mode, 'existing', 'a down user ComfyUI is never silently taken over');
        assert.strictEqual(notOwned.owner, 'none');

        const owned = await owner.resolveComfyOwner(empty.io, { state: { mode: 'existing', components: { comfyui: { owned: true } } } });
        assert.strictEqual(owned.mode, 'managed');
        assert.strictEqual(owned.present, false);
    });

    it('O3c: a clean Ubuntu (no state, no ~/ComfyUI) is a MANAGED first install', async () => {
        const empty = makeIo({ procs: [] });
        const r = await owner.resolveComfyOwner(empty.io, { root: '/home/u/ComfyUI' });
        assert.strictEqual(r.mode, 'managed');
        assert.strictEqual(owner.decideStartComfy({ owner: r.owner, mode: r.mode }).startComfyui, true);
    });

    it('O4: two instances — the platform one wins, the installer\'s own is offered for stop (only it)', async () => {
        const { io, calls } = makeIo({
            procs: [platformProc(), ourProc()],
            http: {
                [`${NB_URL}/system_stats`]: COMFY_STATS,
                'http://127.0.0.1:8188/system_stats': COMFY_STATS,
            },
        });
        const r = await owner.resolveComfyOwner(io, { state: managedState() });
        assert.strictEqual(r.owner, 'foreign');
        assert.deepStrictEqual(r.stop_offer, { pid: 778, port: 8188 });
        assert.ok(r.conflicts.some((c) => c.key === 'installer-instance'));

        const stopped = owner.stopInstallerInstance(io, r.ours);
        assert.strictEqual(stopped.stopped, true);
        assert.deepStrictEqual(calls.kill, { pid: 778, signal: 'SIGTERM' });

        const refused = owner.stopInstallerInstance(io, r.foreign);
        assert.strictEqual(refused.stopped, false);
        assert.deepStrictEqual(calls.kill, { pid: 778, signal: 'SIGTERM' }, 'the platform instance is never signaled');
    });

    it('O5: a 200 JSON without the ComfyUI payload is not accepted as a ComfyUI', async () => {
        const { io } = makeIo({
            procs: [platformProc()],
            http: {
                'http://127.0.0.1:8888/system_stats': NOT_COMFY,
                [`${NB_URL}/system_stats`]: NOT_COMFY,
            },
        });
        const r = await owner.resolveComfyOwner(io, {});
        assert.strictEqual(r.owner, 'none', 'unverified processes are never wired as the worker address');
        assert.strictEqual(probe.isSystemStats({}), false);
        assert.strictEqual(probe.isSystemStats({ system: {} }), true);
        assert.strictEqual(probe.isSystemStats('<html>'), false);
    });

    it('O6: the address is rebuilt from the cmdline each time (port/prefix change between boots)', () => {
        const a = owner.comfyUrlFor({ port: 8888, baseurl: '/notebook/p-1/n-1', listen: '0.0.0.0' });
        const b = owner.comfyUrlFor({ port: 8890, baseurl: '/notebook/p-2/n-9', listen: '0.0.0.0' });
        assert.strictEqual(a.url, 'http://127.0.0.1:8888/notebook/p-1/n-1');
        assert.strictEqual(b.url, 'http://127.0.0.1:8890/notebook/p-2/n-9');

        const { io } = makeIo({
            procs: [platformProc({ cmdline: ['python3', 'main.py', '--listen', '127.0.0.1', '--port', '8890', '--baseurl', '/nb2/'] })],
            http: { 'http://127.0.0.1:8890/nb2/system_stats': COMFY_STATS },
        });
        return owner.resolveComfyOwner(io, {}).then((r) => {
            assert.strictEqual(r.url, 'http://127.0.0.1:8890/nb2');
        });
    });
});

// ---------------------------------------------------------------------------
// F: the fix list is applied for real
// ---------------------------------------------------------------------------

function envIo({ env = '', pkgVersion = '2.2.0' } = {}) {
    const { io, fs } = makeIo({
        files: {
            '/w/worker.cjs': '// worker',
            '/w/package.json': JSON.stringify({ name: 'animastor-worker', version: pkgVersion }),
            '/secret/worker.cjs': '// worker src',
            '/secret/package.json': JSON.stringify({ name: 'animastor-worker', version: '2.2.0' }),
        },
    });
    fs.writeFileSync('/w/.env', env);
    return { io, fs };
}

const DESIRED = {
    COMFY_URL: NB_URL,
    NOTEBOOK_PATH: NB_PREFIX,
    COMFY_PORT: '8888',
    WORKER_TYPE: 'audio',
};

describe('0.2.2 fix list applied to .env', () => {
    it('F1: COMFY_URL / NOTEBOOK_PATH / COMFY_PORT really change, then the list is empty', () => {
        const { io, fs } = envIo({ env: 'COMFY_URL=http://127.0.0.1:8188\nCOMFY_PORT=8188\nNOTEBOOK_PATH=\nWORKER_TYPE=audio\nHUB_URL=https://animastor.org/gpu\nANIMASTOR_WORKER_TOKEN=secret\n' });
        const plan1 = fixes.planFixes(io, { workerDir: '/w', sourceBundleDir: '/secret', desired: DESIRED });
        const keys = plan1.items.map((i) => i.key);
        assert.deepStrictEqual(keys.sort(), ['COMFY_PORT', 'COMFY_URL', 'NOTEBOOK_PATH']);

        const manifest = ttsManifest();
        const cfg = workerMod.configureEnv(io, {
            workerDir: '/w', manifest, values: DESIRED, overrides: DESIRED,
        });
        assert.strictEqual(cfg.status, 'configured');
        const env = fs.readFileSync('/w/.env', 'utf8');
        assert.ok(env.includes(`COMFY_URL=${NB_URL}`), env);
        assert.ok(env.includes(`NOTEBOOK_PATH=${NB_PREFIX}`), env);
        assert.ok(env.includes('COMFY_PORT=8888'), env);
        assert.ok(env.includes('ANIMASTOR_WORKER_TOKEN=secret'), 'the key is never touched by a fix');

        const plan2 = fixes.planFixes(io, { workerDir: '/w', sourceBundleDir: '/secret', desired: DESIRED });
        assert.deepStrictEqual(plan2.items, [], 'a re-run over a fixed .env shows no fix list');
        assert.deepStrictEqual(plan2.additions, [], 'and nothing to add');
    });

    it('F2: only real changes are listed, once per key', () => {
        const { io } = envIo({ env: `COMFY_URL=${NB_URL}\nNOTEBOOK_PATH=${NB_PREFIX}\nCOMFY_PORT=8888\nWORKER_TYPE=audio\nNODE_BIN=/usr/bin/node\n` });
        const plan = fixes.planFixes(io, { workerDir: '/w', sourceBundleDir: '/secret', desired: DESIRED });
        assert.deepStrictEqual(plan.items, []);
        assert.deepStrictEqual(plan.additions, []);

        const envWithBadNode = envIo({ env: 'COMFY_URL=http://127.0.0.1:8188\nNODE_BIN=/usr/bin/node\n' });
        const p2 = fixes.planFixes(envWithBadNode.io, {
            workerDir: '/w', sourceBundleDir: '/secret',
            desired: { ...DESIRED, NODE_BIN: '/usr/local/bin/node' },
        });
        const nodeItems = p2.items.filter((i) => i.key === 'NODE_BIN');
        assert.strictEqual(nodeItems.length, 1, `NODE_BIN listed once: ${JSON.stringify(p2.items)}`);
    });
});

// ---------------------------------------------------------------------------
// D: remembered answers
// ---------------------------------------------------------------------------

describe('0.2.2 remembered decisions (doctor)', () => {
    it('D1: a declined optional-workflow step is not asked again on a re-run', () => {
        const manifests = [ttsManifest()];
        const report = resolver.resolveInstallation({
            manifests,
            environment: { root: TIR_ROOT, comfyui: { present: true, version: '0.3.40' }, device: 'cuda', custom_nodes: [], models: [], workflows: [] },
            mode: 'existing',
        });
        const recorded = cli.priorReusableDecisions({ decisions: { workflows: 'none', install_models: false } });
        assert.deepStrictEqual(recorded, { workflows: 'none', install_models: false });

        const plan = planMod.buildInstallPlan({ report, manifests, decisions: recorded });
        assert.ok(!plan.awaiting_decisions.includes('workflows'), JSON.stringify(plan.awaiting_decisions));
    });
});

// ---------------------------------------------------------------------------
// H: hub version
// ---------------------------------------------------------------------------

describe('0.2.2 hub version', () => {
    it('H1: known from state, else from /health, else from the served installer script', async () => {
        const noNet = makeIo({});
        assert.strictEqual(await cli.detectHubVersion(noNet.io, 'https://animastor.org/gpu', { known: '0.1.0' }), '0.1.0');

        const health = makeIo({
            http: { 'https://animastor.org/gpu/health': { status: 200, json: { version: '0.2.2', gpus: 0 } } },
        });
        assert.strictEqual(await cli.detectHubVersion(health.io, 'https://animastor.org/gpu'), '0.2.2');

        const script = makeIo({
            http: {
                'https://animastor.org/gpu/health': { status: 200, json: { gpus: 0 } },
                'https://animastor.org/gpu/installer': { status: 200, text: 'export ANIMASTOR_HUB_VERSION="0.1.0"\nexport X=1\n' },
            },
        });
        assert.strictEqual(await cli.detectHubVersion(script.io, 'https://animastor.org/gpu'), '0.1.0');

        assert.strictEqual(await cli.detectHubVersion(noNet.io, 'https://animastor.org/gpu'), null);
    });
});

// ---------------------------------------------------------------------------
// P: PATH survives the dotfile reset
// ---------------------------------------------------------------------------

describe('0.2.2 PATH restored on every run', () => {
    it('P1: the block is added again after ~/.bashrc is reset; never duplicated', () => {
        const { io, fs } = makeIo({ files: {} });
        fs.mkdirSync('/home/u', { recursive: true });
        fs.writeFileSync('/home/u/.bashrc', '# reset by the image\n');
        fs.writeFileSync('/home/u/.profile', '# reset by the image\n');

        const r1 = management.restoreCommandPath(io, { linkDir: '/home/u/.local/bin', home: '/home/u' });
        assert.deepStrictEqual(r1.updated.sort(), ['/home/u/.bashrc', '/home/u/.profile']);

        const again = management.restoreCommandPath(io, { linkDir: '/home/u/.local/bin', home: '/home/u' });
        assert.deepStrictEqual(again.updated, []);
        assert.strictEqual(again.already.length, 2);

        // the node reboots: the dotfiles are reset again
        fs.writeFileSync('/home/u/.bashrc', '# reset by the image\n');
        fs.writeFileSync('/home/u/.profile', '# reset by the image\n');
        const afterBoot = management.restoreCommandPath(io, { linkDir: '/home/u/.local/bin', home: '/home/u' });
        assert.strictEqual(afterBoot.updated.length, 2);
        const text = fs.readFileSync('/home/u/.bashrc', 'utf8');
        assert.strictEqual(text.split(management.PATH_MARKER).length - 1, 1, 'exactly one block');
    });
});

// ---------------------------------------------------------------------------
// S: autostart wrapper
// ---------------------------------------------------------------------------

describe('0.2.2 autostart wrapper', () => {
    it('S1: start-worker.sh → `exec …/animastor start "$@"`, old script backed up once', () => {
        const { io, fs } = makeIo({ files: { '/home/u/animastor/worker/worker.cjs': '// worker' } });
        fs.writeFileSync('/home/u/animastor/start-worker.sh', '#!/bin/sh\napt-get install -y nodejs\nnode worker/worker.cjs\n');

        const r1 = management.ensureStartWorkerWrapper(io, {
            workerDir: '/home/u/animastor/worker', animastorPath: '/home/u/.local/bin/animastor',
        });
        assert.strictEqual(r1.status, 'replaced');
        assert.strictEqual(r1.path, '/home/u/animastor/start-worker.sh');
        assert.strictEqual(r1.backup, '/home/u/animastor/start-worker.sh.bak');
        const wrapper = fs.readFileSync(r1.path, 'utf8');
        assert.ok(wrapper.startsWith('#!/bin/sh'), wrapper);
        assert.ok(wrapper.includes(`exec '/home/u/.local/bin/animastor' start "$@"`), wrapper);
        assert.ok(!/apt-get install -y nodejs/.test(wrapper));
        assert.ok(/apt-get install -y nodejs/.test(fs.readFileSync(r1.backup, 'utf8')), 'the old launcher is kept');

        const r2 = management.ensureStartWorkerWrapper(io, {
            workerDir: '/home/u/animastor/worker', animastorPath: '/home/u/.local/bin/animastor',
        });
        assert.strictEqual(r2.status, 'unchanged');
        assert.strictEqual(r2.backup, null);

        // a wrapper pointing at a stale command is rewritten, without a second backup
        const r3 = management.ensureStartWorkerWrapper(io, {
            workerDir: '/home/u/animastor/worker', animastorPath: '/opt/animastor/bin/animastor',
        });
        assert.strictEqual(r3.status, 'replaced');
        assert.strictEqual(r3.backup, null);
        assert.ok(fs.readFileSync(r3.path, 'utf8').includes(`exec '/opt/animastor/bin/animastor' start`));
        assert.ok(/apt-get install -y nodejs/.test(fs.readFileSync('/home/u/animastor/start-worker.sh.bak', 'utf8')));

        const created = makeIo({ files: { '/home/v/animastor/worker/worker.cjs': '// w' } });
        const r4 = management.ensureStartWorkerWrapper(created.io, {
            workerDir: '/home/v/animastor/worker', animastorPath: '/home/v/.local/bin/animastor',
        });
        assert.strictEqual(r4.status, 'created');
        assert.strictEqual(r4.backup, null);
    });
});

// ---------------------------------------------------------------------------
// B: boot path
// ---------------------------------------------------------------------------

describe('0.2.2 boot path (doctor --yes, no TTY)', () => {
    it('B1: boot mode is doctor + --yes without a TTY', () => {
        assert.strictEqual(cli.isBootRun({ yes: true }, true), true);
        assert.strictEqual(cli.isBootRun({}, true), false);
        assert.strictEqual(cli.isBootRun({ yes: true }, false), false);
    });

    it('B2: missing apt packages are installed without a question; installed ones are skipped', async () => {
        const missing = makeIo({
            exec: (cmd) => (cmd === 'dpkg-query' ? { code: 1, stdout: 'not-installed', stderr: '' }
                : cmd === 'apt-get' ? { code: 0, stdout: '', stderr: '' }
                    : cmd === 'sudo' ? { code: 0 } : null),
        });
        const r = await prereq.installMissingHostPackages(missing.io, { packages: ['nodejs'], yes: true, platformAdapter: LINUX });
        assert.strictEqual(r.ok, true);
        assert.deepStrictEqual(r.installed, ['nodejs']);
        assert.ok(
            missing.calls.exec.some((c) => (c.cmd === 'apt-get' || (c.cmd === 'sudo' && c.args.includes('apt-get')))
                && c.args.includes('install') && c.args.includes('nodejs')),
            `one apt-get install, no question: ${JSON.stringify(missing.calls.exec.map((c) => [c.cmd, c.args]))}`,
        );

        const present = makeIo({
            exec: (cmd) => (cmd === 'dpkg-query' ? { code: 0, stdout: 'install ok installed', stderr: '' } : null),
        });
        const r2 = await prereq.installMissingHostPackages(present.io, { packages: ['nodejs'], yes: true, platformAdapter: LINUX });
        assert.strictEqual(r2.ok, true);
        assert.deepStrictEqual(r2.installed, []);
        assert.ok(!present.calls.exec.some((c) => c.cmd === 'apt-get'), 'nothing is installed when nothing is missing');
    });

    it('B3: the result is ONE line, and a failure sets a non-zero exit code', () => {
        const savedExit = process.exitCode;
        const savedLog = console.log;
        const lines = [];
        console.log = (s) => lines.push(String(s));
        try {
            process.exitCode = undefined;
            cli.printOneLineSummary({
                mode: 'existing',
                status: 'ready',
                results: { comfy_owner: { url: NB_URL }, worker: [{ id: 'worker-process', started: true, pid: 4242 }] },
                e2e: [
                    { id: 'comfyui', ok: true, label: 'ComfyUI API', detail: NB_URL },
                    { id: 'worker', ok: true, label: 'Worker → ComfyUI', detail: 'ready' },
                    { id: 'heartbeat', ok: true, label: 'Hub heartbeat (Online)', detail: null },
                ],
            }, { flags: {}, mode: 'existing' });
            assert.strictEqual(lines.filter((l) => l.startsWith('animastor doctor:')).length, 1, lines.join('\n'));
            assert.ok(/OK — mode existing, ComfyUI http:\/\/127\.0\.0\.1:8888\/notebook/.test(lines[0]), lines.join('\n'));
            assert.strictEqual(process.exitCode, undefined);

            lines.length = 0;
            cli.printOneLineSummary({
                mode: 'existing', status: 'failed',
                results: { comfy_owner: { url: null }, worker: [] },
                e2e: [{ id: 'comfyui', ok: false, label: 'ComfyUI API', detail: 'not reachable', fix: 'animastor start' }],
            }, { flags: {}, mode: 'existing' });
            assert.ok(lines[0].startsWith('animastor doctor: FAILED'), lines.join('\n'));
            assert.strictEqual(process.exitCode, 1);
        } finally {
            console.log = savedLog;
            process.exitCode = savedExit;
        }
    });
});
