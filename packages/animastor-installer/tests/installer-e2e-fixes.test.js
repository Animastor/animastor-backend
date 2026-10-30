'use strict';

/**
 * E2E 2026-10-30 follow-ups (installer 0.2.1).
 *
 *  P1-P7  host prerequisites: with root or passwordless sudo the installer
 *         asks ONE question ("Install <pkg> now? [Y/n]"), runs
 *         `apt-get install -y`, runs `apt-get update` at most once when the
 *         index is stale, names a held dpkg lock, and CONTINUES in the same
 *         run; --yes installs without asking; without the privileges nothing
 *         is installed and the exact command is printed.
 *  V1-V4  venv/prerequisites are checked only when the plan actually uses
 *         the Python runtime (existing ComfyUI + models + nodes → no venv).
 *  E1-E5  re-install over an existing worker: .env keys are preserved (real
 *         numbers in the log), the Worker Key is never asked again when it
 *         is present — also when the bundle is missing/incomplete — and is
 *         asked only when it is really absent.
 *  L1-L4  the `animastor` command lives in ~/.local/bin even under root and
 *         PATH is persisted in ~/.bashrc / ~/.profile, once and idempotently.
 *  D1     `animastor doctor` starts the worker again after a node restart.
 *
 * All external operations are mocked (memory fs + scripted io).
 */

const assert = require('assert');
const fsReal = require('fs');
const os = require('os');
const path = require('path');

const { createMemoryFs, createRealIo } = require('../src/installer/engine/io');
const prereq = require('../src/installer/engine/prereq');
const planMod = require('../src/installer/install-plan');
const resolver = require('../src/installer/compatibility-resolver');
const workerMod = require('../src/installer/engine/worker');
const management = require('../src/installer/management');
const cli = require('../src/installer/cli');

const LINUX = require('../src/installer/platform/linux');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Memory io whose exec answers ONLY what the test maps (default: failure). */
function memIo(files = {}, { exec = null } = {}) {
    const fs = createMemoryFs(files);
    const calls = { exec: [] };
    return {
        fs,
        calls,
        exec(cmd, args = [], opts = {}) {
            calls.exec.push({ cmd, args, opts });
            if (exec) {
                const r = exec(cmd, args, opts);
                if (r) return r;
            }
            return { code: 1, stdout: '', stderr: '' };
        },
        spawnDaemon() { return 4242; },
        now: () => Date.now(),
    };
}

function ttsManifest() {
    return {
        profile: { id: 'audio/qwen-tts', name: 'qwen-tts', type: 'audio' },
        runtime_requirements: {},
        dependencies: [],
        workflows: { artifacts: [] },
        worker_bundle: {
            worker_type: 'audio',
            files: ['worker.cjs', 'package.json'],
            env: {
                required: ['HUB_URL', 'ANIMASTOR_WORKER_TOKEN', 'WORKER_TYPE', 'WORKER_ID'],
                secrets: ['ANIMASTOR_WORKER_TOKEN'],
            },
        },
    };
}

function venvFailure() {
    return {
        code: 'MISSING_VENV_PACKAGE',
        summary: 'the Python venv prerequisite is missing',
        remediation: { package: 'python3.12-venv', command: 'sudo apt install python3.12-venv' },
    };
}

const promptStub = (answer = true) => ({
    available: true,
    asked: [],
    async confirm(q) { this.asked.push(q); return answer; },
});

// ---------------------------------------------------------------------------
// 1. Host prerequisites — install on consent, continue without a restart
// ---------------------------------------------------------------------------

describe('E2E: host prerequisites (apt install on consent)', () => {
    it('P1: canElevate — root yes; otherwise only passwordless sudo', () => {
        assert.deepStrictEqual(prereq.canElevate(memIo(), { uid: 0 }), { ok: true, via: 'root', command_prefix: [] });

        const sudoOk = memIo({}, { exec: (cmd, args) => (cmd === 'sudo' && args.join(' ') === '-n true' ? { code: 0 } : null) });
        assert.strictEqual(prereq.canElevate(sudoOk, { uid: 1000 }).via, 'sudo');

        const sudoNeedsPassword = memIo({}, { exec: (cmd) => (cmd === 'sudo' ? { code: 1 } : null) });
        assert.deepStrictEqual(prereq.canElevate(sudoNeedsPassword, { uid: 1000 }), { ok: false, via: null, command_prefix: [] });
    });

    it('P2: root — one `apt-get install -y <pkg>`, no sudo prefix, no update', () => {
        const io = memIo({}, { exec: () => ({ code: 0 }) });
        const r = prereq.installHostPackages(io, {
            packages: 'python3.12-venv', platformAdapter: LINUX, elevated: { ok: true, via: 'root', command_prefix: [] },
        });
        assert.strictEqual(r.ok, true);
        assert.deepStrictEqual(io.calls.exec.map((c) => [c.cmd, c.args]), [['apt-get', ['install', '-y', 'python3.12-venv']]]);
        assert.strictEqual(r.updated, false);
    });

    it('P3: non-root passwordless sudo — `sudo -n apt-get install -y <pkg>`', () => {
        const io = memIo({}, { exec: () => ({ code: 0 }) });
        const r = prereq.installHostPackages(io, {
            packages: ['python3.12-venv'], platformAdapter: LINUX, elevated: { ok: true, via: 'sudo', command_prefix: ['sudo', '-n'] },
        });
        assert.strictEqual(r.ok, true);
        assert.deepStrictEqual(io.calls.exec.map((c) => [c.cmd, c.args]), [['sudo', ['-n', 'apt-get', 'install', '-y', 'python3.12-venv']]]);
    });

    it('P4: `apt-get update` runs ONCE (stale index) and the install is retried', () => {
        let indexFresh = false;
        const io = memIo({}, {
            exec: (cmd, args) => {
                if (cmd !== 'apt-get') return null;
                if (args[0] === 'update') { indexFresh = true; return { code: 0 }; }
                if (args[0] === 'install') {
                    return indexFresh ? { code: 0 } : { code: 100, stderr: 'E: Unable to locate package python3.12-venv' };
                }
                return null;
            },
        });
        const r = prereq.installHostPackages(io, {
            packages: 'python3.12-venv', platformAdapter: LINUX, elevated: { ok: true, via: 'root', command_prefix: [] },
        });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.updated, true);
        assert.deepStrictEqual(io.calls.exec.map((c) => c.args[0]), ['install', 'update', 'install']);
    });

    it('P5: a held dpkg lock becomes a clear message, never a bare exit code', () => {
        const io = memIo({}, {
            exec: () => ({ code: 100, stderr: 'E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 123 (apt-get)' }),
        });
        const r = prereq.installHostPackages(io, {
            packages: 'python3.12-venv', platformAdapter: LINUX, elevated: { ok: true, via: 'root', command_prefix: [] },
        });
        assert.strictEqual(r.ok, false);
        assert.ok(/busy/i.test(r.message), r.message);
        assert.ok(/lock/i.test(r.message), r.message);
    });

    it('P6: without privileges nothing is installed and the remediation command is kept', async () => {
        const io = memIo({}, { exec: (cmd) => (cmd === 'sudo' ? { code: 1 } : null) });
        const prompt = promptStub(true);
        const r = await prereq.resolveHostPrerequisite(io, { failure: venvFailure(), opts: {}, prompt });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.elevatable, false);
        assert.strictEqual(prompt.asked.length, 0, 'never asks when it cannot install');
        assert.ok(!io.calls.exec.some((c) => c.cmd === 'apt-get'));
        assert.ok(prereq.renderRemediation(r.failure).join('\n').includes('sudo apt install python3.12-venv'));
    });

    it('P7: consent (enter = yes) installs and CONTINUES in the same run', async () => {
        let venvWorks = false;
        const io = memIo({}, {
            exec: (cmd, args) => {
                const line = [cmd, ...args].join(' ');
                if (line === 'sudo -n true') return { code: 0 };
                if (line.startsWith('sudo -n apt-get install')) { venvWorks = true; return { code: 0 }; }
                if (line === 'python3 --version') return { code: 0, stdout: 'Python 3.12.3' };
                if (line.startsWith('python3 -m venv')) {
                    return venvWorks ? { code: 0 } : { code: 1, stderr: 'ensurepip is not available' };
                }
                return null;
            },
        });
        const prompt = promptStub(true);
        const r = await prereq.resolveHostPrerequisite(io, {
            failure: venvFailure(), opts: { python: 'python3', deep: true }, prompt, platformAdapter: LINUX,
        });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.deepStrictEqual(r.installed.packages, ['python3.12-venv']);
        assert.strictEqual(prompt.asked[0], 'Install python3.12-venv now?');
    });

    it('P8: --yes installs without a question; a declined question installs nothing', async () => {
        const mk = () => {
            let venvWorks = false;
            return memIo({}, {
                exec: (cmd, args) => {
                    const line = [cmd, ...args].join(' ');
                    if (line === 'sudo -n true') return { code: 0 };
                    if (line.startsWith('sudo -n apt-get install')) { venvWorks = true; return { code: 0 }; }
                    if (line === 'python3 --version') return { code: 0, stdout: 'Python 3.12.3' };
                    if (line.startsWith('python3 -m venv')) return venvWorks ? { code: 0 } : { code: 1, stderr: 'ensurepip is not available' };
                    return null;
                },
            });
        };
        const yesIo = mk();
        const yesRes = await prereq.resolveHostPrerequisite(yesIo, {
            failure: venvFailure(), opts: { python: 'python3', deep: true }, prompt: null, yes: true, platformAdapter: LINUX,
        });
        assert.strictEqual(yesRes.ok, true);
        assert.ok(yesIo.calls.exec.some((c) => c.cmd === 'sudo' && c.args.includes('install')));

        const noIo = mk();
        const declined = await prereq.resolveHostPrerequisite(noIo, {
            failure: venvFailure(), opts: { python: 'python3', deep: true }, prompt: promptStub(false), platformAdapter: LINUX,
        });
        assert.strictEqual(declined.ok, false);
        assert.strictEqual(declined.declined, true);
        assert.ok(!noIo.calls.exec.some((c) => c.cmd === 'sudo' && c.args.includes('install')));
    });
});

// ---------------------------------------------------------------------------
// 2. venv/prerequisites only when the plan uses them
// ---------------------------------------------------------------------------

describe('E2E: venv is required only when the plan uses the Python runtime', () => {
    const planOf = (steps) => ({ steps });

    it('V1: existing ComfyUI + models + nodes present (all steps noop) → no venv needed', () => {
        const plan = planOf([
            { id: 'detect-comfyui', kind: 'detect' },
            { id: 'comfyui-update', kind: 'noop' },
            { id: 'runtime', kind: 'noop' },
            { id: 'custom-nodes', kind: 'noop' },
            { id: 'models', kind: 'noop' },
            { id: 'worker-setup', kind: 'noop' },
        ]);
        const report = { entries: [{ id: 'runtime:python', status: 'installed' }, { id: 'runtime:torch', status: 'installed' }] };
        assert.strictEqual(planMod.planNeedsPythonRuntime({ plan, report, mode: 'existing' }), false);
    });

    it('V2: a planned ComfyUI install/update or custom-node install needs the venv', () => {
        for (const op of ['install_comfyui', 'update_comfyui', 'downgrade_comfyui', 'install_custom-nodes']) {
            const plan = planOf([{ id: 'x', action: { op } }]);
            assert.strictEqual(planMod.planNeedsPythonRuntime({ plan, report: { entries: [] }, mode: 'managed' }), true, op);
        }
    });

    it('V3: a missing/incompatible runtime entry needs the venv (the engine prepares it)', () => {
        const plan = planOf([{ id: 'runtime', kind: 'noop' }]);
        assert.strictEqual(planMod.planNeedsPythonRuntime({
            plan, report: { entries: [{ id: 'runtime:torch', status: 'missing' }] }, mode: 'existing',
        }), true);
        assert.strictEqual(planMod.planNeedsPythonRuntime({
            plan, report: { entries: [{ id: 'runtime:python', status: 'incompatible' }] }, mode: 'managed',
        }), true);
    });

    it('V4: an unknown plan shape keeps the historical safe behaviour (check)', () => {
        assert.strictEqual(planMod.planNeedsPythonRuntime({}), true);
        assert.strictEqual(planMod.planNeedsPythonRuntime({ plan: null }), true);
    });
});

// ---------------------------------------------------------------------------
// 3. Re-install over an existing worker: .env + Worker Key
// ---------------------------------------------------------------------------

describe('E2E: re-install over an existing worker', () => {
    const ALL_KEYS = ['HUB_URL', 'ANIMASTOR_WORKER_TOKEN', 'WORKER_TYPE', 'WORKER_ID'];

    it('E1: bundle missing but .env present with the token → NO Worker Key question', () => {
        const env = { worker: { worker_type: 'audio', bundle: { present: false, files: [] }, env: { present: true, set_keys: ALL_KEYS } } };
        const report = resolver.resolveInstallation({ manifests: [ttsManifest()], environment: env, mode: 'existing' });
        const entry = report.entries.find((e) => e.kind === 'worker');
        assert.strictEqual(entry.status, 'missing');
        assert.deepStrictEqual(entry.env.missing_required, [], 'the existing .env is reported honestly');
        const plan = planMod.buildInstallPlan({ report, manifests: [ttsManifest()], decisions: { worker_setup: true } });
        assert.ok(!plan.steps.some((s) => s.id === 'worker-key'), 'no key step for a configured worker');
    });

    it('E2: incomplete bundle (bundle update) with the token present → NO Worker Key question', () => {
        const env = {
            worker: {
                worker_type: 'audio',
                bundle: { present: true, files: ['worker.cjs'], dir: '/w' },
                env: { present: true, set_keys: ALL_KEYS },
            },
        };
        const report = resolver.resolveInstallation({ manifests: [ttsManifest()], environment: env, mode: 'existing' });
        const entry = report.entries.find((e) => e.kind === 'worker');
        assert.strictEqual(entry.reason, 'incomplete_bundle');
        assert.deepStrictEqual(entry.env.missing_required, []);
        const plan = planMod.buildInstallPlan({ report, manifests: [ttsManifest()], decisions: { worker_setup: true } });
        assert.ok(!plan.steps.some((s) => s.id === 'worker-key'));
    });

    it('E3: no .env at all → the key IS asked (secret prompt, never a Yes/No)', () => {
        const env = { worker: { worker_type: 'audio', bundle: { present: true, files: ['worker.cjs', 'package.json'], dir: '/w' }, env: { present: false } } };
        const report = resolver.resolveInstallation({ manifests: [ttsManifest()], environment: env, mode: 'existing' });
        const plan = planMod.buildInstallPlan({ report, manifests: [ttsManifest()], decisions: { worker_setup: true } });
        const key = plan.steps.find((s) => s.id === 'worker-key');
        assert.ok(key, 'key step present');
        assert.strictEqual(key.kind, 'secret-prompt');
        assert.deepStrictEqual(key.secret_keys, ['ANIMASTOR_WORKER_TOKEN']);
    });

    it('E4: configureEnv preserves every existing key (real numbers) and never overwrites the token', () => {
        const original = [
            'HUB_URL=https://animastor.org/gpu',
            'ANIMASTOR_WORKER_TOKEN=existing-secret-token',
            'WORKER_TYPE=image',
            'WORKER_ID=w1',
            'COMFY_PORT=8188',
            'NOTEBOOK_PATH=',
            'NODE_BIN=/usr/bin/node',
            'EXTRA=1',
            '',
        ].join('\n');
        const io = memIo({ '/w/.env': original });
        const logs = [];
        const cfg = workerMod.configureEnv(io, {
            workerDir: '/w',
            manifest: ttsManifest(),
            values: {},
            overrides: { WORKER_TYPE: 'audio' },
            log: { info: (m) => logs.push(m) },
        });
        assert.deepStrictEqual(cfg.changed, ['WORKER_TYPE']);
        assert.strictEqual(cfg.preserved.length, 7, JSON.stringify(cfg.preserved));
        assert.deepStrictEqual(cfg.added, []);
        assert.deepStrictEqual(cfg.missing_after, []);
        assert.ok(/7 key\(s\) preserved, 0 added/.test(logs[0]), logs[0]);
        const text = io.fs.readFileSync('/w/.env', 'utf8');
        assert.ok(text.includes('ANIMASTOR_WORKER_TOKEN=existing-secret-token'), 'the key is never overwritten');
        assert.ok(text.includes('WORKER_TYPE=audio'));
    });

    it('E5: hasEnvKey reports presence only (no value, empty value = absent)', () => {
        const io = memIo({
            '/a/.env': 'ANIMASTOR_WORKER_TOKEN=abc\n',
            '/b/.env': 'ANIMASTOR_WORKER_TOKEN=\n',
            '/c/.env': 'HUB_URL=https://x\n',
        });
        assert.strictEqual(workerMod.hasEnvKey(io, '/a', 'ANIMASTOR_WORKER_TOKEN'), true);
        assert.strictEqual(workerMod.hasEnvKey(io, '/b', 'ANIMASTOR_WORKER_TOKEN'), false);
        assert.strictEqual(workerMod.hasEnvKey(io, '/c', 'ANIMASTOR_WORKER_TOKEN'), false);
        assert.strictEqual(workerMod.hasEnvKey(io, '/missing', 'ANIMASTOR_WORKER_TOKEN'), false);
    });
});

// ---------------------------------------------------------------------------
// 4. E2E nodes keep only /home: ~/.local/bin + persisted PATH
// ---------------------------------------------------------------------------

describe('E2E: the `animastor` command survives a node restart (only /home kept)', () => {
    it('L1: the link dir is ~/.local/bin even for root (never /usr/local/bin)', () => {
        assert.strictEqual(management.defaultLinkDir({ uid: 0, home: '/root' }), '/root/.local/bin');
        assert.strictEqual(management.defaultLinkDir({ uid: 1000, home: '/home/u' }), '/home/u/.local/bin');
    });

    it('L2: PATH is persisted in ~/.bashrc and ~/.profile — once, idempotently', () => {
        const io = memIo({ '/home/u/.bashrc': 'export FOO=1\n' });
        const dir = '/home/u/.local/bin';
        const r1 = management.ensurePathEntry(io, { dir, home: '/home/u' });
        assert.deepStrictEqual(r1.updated, ['/home/u/.bashrc', '/home/u/.profile']);
        for (const f of r1.updated) {
            const text = io.fs.readFileSync(f, 'utf8');
            assert.ok(text.includes(management.PATH_MARKER), f);
            assert.ok(text.includes(`export PATH="${dir}:$PATH"`), f);
        }
        assert.ok(io.fs.readFileSync('/home/u/.bashrc', 'utf8').startsWith('export FOO=1\n'), 'existing content kept');

        const r2 = management.ensurePathEntry(io, { dir, home: '/home/u' });
        assert.deepStrictEqual(r2.updated, [], 'second run writes nothing');
        assert.strictEqual(r2.already.length, 2);
        const markers = io.fs.readFileSync('/home/u/.bashrc', 'utf8').split(management.PATH_MARKER).length - 1;
        assert.strictEqual(markers, 1, 'no duplicate block');
    });

    it('L3: an rc file that already exports the dir is left untouched', () => {
        const io = memIo({ '/home/u/.profile': 'export PATH="/home/u/.local/bin:$PATH"\n' });
        const r = management.ensurePathEntry(io, { dir: '/home/u/.local/bin', home: '/home/u' });
        assert.deepStrictEqual(r.already, ['/home/u/.profile']);
        assert.deepStrictEqual(r.updated, ['/home/u/.bashrc']);
    });

    it('L4: installing the tools links ~/.local/bin/animastor AND records the PATH update', () => {
        const tmp = fsReal.mkdtempSync(path.join(os.tmpdir(), 'animastor-path-'));
        try {
            const io = createRealIo();
            const home = path.join(tmp, 'home');
            fsReal.mkdirSync(home, { recursive: true });
            const linkDir = path.join(home, '.local', 'bin');
            const r = management.installManagementTools(io, {
                toolsDir: path.join(home, 'animastor', 'tools'),
                nodePath: process.execPath,
                cliPath: '/tmp/x/cli.js',
                statePath: path.join(home, 'ComfyUI', '.animastor-installer', 'install-state.json'),
                root: path.join(home, 'ComfyUI'),
                workerDir: path.join(home, 'animastor', 'worker'),
                linkDir,
                home,
                platformAdapter: LINUX,
            });
            assert.strictEqual(r.link, path.join(linkDir, 'animastor'));
            assert.ok(fsReal.existsSync(r.link));
            assert.deepStrictEqual(r.path_entry.updated, [path.join(home, '.bashrc'), path.join(home, '.profile')]);
            assert.ok(fsReal.readFileSync(path.join(home, '.profile'), 'utf8').includes(linkDir));
        } finally {
            fsReal.rmSync(tmp, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// 5. doctor after a node restart
// ---------------------------------------------------------------------------

describe('E2E: `animastor doctor` after a node restart', () => {
    it('D1: doctor starts the worker again (opt out with --no-start-worker)', () => {
        assert.strictEqual(cli.installOptions({}, { doctor: true }).startWorker, true);
        assert.strictEqual(cli.installOptions({ 'no-start-worker': true }, { doctor: true }).startWorker, false);
        assert.strictEqual(cli.installOptions({ 'start-worker': true }, { doctor: false }).startWorker, true);
        assert.strictEqual(cli.installOptions({}, { doctor: false }).startWorker, undefined,
            'a normal install still never starts services unprompted');
    });
});
