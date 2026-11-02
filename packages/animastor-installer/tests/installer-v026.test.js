'use strict';

/**
 * Installer 0.2.6 — version replacements of the node-deps overlay.
 *
 * Live E2E 02.11 (TIR, audio/qwen-tts): qwen-tts pins transformers==4.57.3,
 * so ~/animastor/pydeps (first in sys.path of the WHOLE ComfyUI) replaced
 * transformers 5.0.0 → 4.57.3, huggingface_hub 1.3.5 → 0.36.2,
 * cryptography 3.4.8 → 50.0.2 — silently.
 *
 *  O1  REAL Python: the comparison script finds the replacements, attributes
 *      them to the node that forced them (also transitive ones), and finds
 *      the users in another profile and the ComfyUI core range.
 *  O2  one profile: every replacement is logged, recorded in
 *      installer_options.nodeDeps.overrides and shown in RESULT ([i] / !).
 *  O3  another profile uses a replaced package: boot / --yes → FAILED with
 *      the cause, the overlay is restored from the snapshot; interactive
 *      yes → accepted and recorded (not asked again); no → FAILED, restored;
 *      --accept-node-deps-overrides → accepted.
 *  O4  a profile installed later meets the replacements already in the
 *      overlay → the same consent.
 *  O5  RESULT marks, the fix command parses, the engine keeps the record.
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const realFs = require('fs');
const { spawnSync } = require('child_process');

const { createMemoryFs, createRealIo } = require('../src/installer/engine/io');
const { createLogger } = require('../src/installer/engine/logger');
const owner = require('../src/installer/engine/comfy-owner');
const ov = require('../src/installer/engine/overrides');
const summary = require('../src/installer/engine/summary');
const cli = require('../src/installer/cli');
const engine = require('../src/installer/engine/engine');
const LINUX = require('../src/installer/platform/linux');

const HOME = '/home/jovyan';
const ROOT = `${HOME}/ComfyUI`;
const WORKER_DIR = `${HOME}/animastor/worker`;
const STATE_PATH = `${ROOT}/.animastor-installer/install-state.json`;
const PREFIX = '/notebook/p-2/n-9';
const PY = '/usr/bin/python3';
const VENV = `${HOME}/animastor/pydeps/py3.10`;
const OVERLAY_SP = `${VENV}/lib/python3.10/site-packages`;
const OVERLAY_PY = `${VENV}/bin/python`;
const TTS_CLASSES = ['Qwen3TTSLoader'];
const LTX_CLASSES = ['LTXVLoader'];

function ttsManifest() {
    return {
        profile: { id: 'audio/qwen-tts' },
        dependencies: [{
            id: 'custom-node:comfyui-qwen3-tts', kind: 'custom_node', name: 'ComfyUI-Qwen3-TTS', requirement: 'required',
            install: { directory: 'qwen3-tts' }, provides_classes: TTS_CLASSES,
        }],
    };
}

function ltxManifest() {
    return {
        profile: { id: 'video/ltx-2.3' },
        dependencies: [{
            id: 'custom-node:ltx', kind: 'custom_node', name: 'ComfyUI-LTXVideo', requirement: 'required',
            install: { directory: 'ltx-video' }, provides_classes: LTX_CLASSES,
        }],
    };
}

/** What the overlay comparison returns after qwen-tts deps are in the overlay (E2E 02.11). */
const E2E_OVERRIDES = [
    { name: 'cryptography', key: 'cryptography', platform: '3.4.8', overlay: '50.0.2' },
    { name: 'huggingface_hub', key: 'huggingface-hub', platform: '1.3.5', overlay: '0.36.2' },
    { name: 'transformers', key: 'transformers', platform: '5.0.0', overlay: '4.57.3' },
];

function e2eRaw({ ltxUsesHub = true } = {}) {
    return {
        overrides: E2E_OVERRIDES,
        nodes: [
            {
                key: 'qwen3-tts',
                uses: {
                    transformers: { specs: ['==4.57.3'], accepts_platform: false, accepts_overlay: true },
                    'huggingface-hub': { specs: ['<1.0,>=0.34.0'], accepts_platform: false, accepts_overlay: true },
                    cryptography: { specs: ['>=43'], accepts_platform: false, accepts_overlay: true },
                },
            },
            { key: 'ltx-video', uses: ltxUsesHub ? { 'huggingface-hub': { specs: ['>=1.0'], accepts_platform: true, accepts_overlay: false } } : {} },
        ],
        core: { transformers: { spec: '>=4.50.3', accepts_overlay: true } },
    };
}

/**
 * Type A node: the platform's ComfyUI (pid 370) already has the node classes
 * (no restart in these tests). `overlayHasTts` — the qwen-tts deps are in the
 * overlay (then the comparison reports the E2E replacements).
 */
function world({ overlayHasTts = false, ltxOnDisk = false, ltxUsesHub = true, coreRaw = null } = {}) {
    const files = {
        [`${ROOT}/main.py`]: 'def execute_prestartup_script():\n    # prestartup_script.py\n',
        [`${ROOT}/requirements.txt`]: 'transformers>=4.50.3\n',
        [`${ROOT}/custom_nodes/qwen3-tts/requirements.txt`]: 'transformers==4.57.3\nqwen-tts\n',
        [`${VENV}/pyvenv.cfg`]: 'include-system-site-packages = true\n',
        [OVERLAY_PY]: '',
    };
    if (overlayHasTts) files[`${OVERLAY_SP}/transformers-4.57.3.dist-info/METADATA`] = 'Name: transformers\nVersion: 4.57.3\n';
    if (ltxOnDisk) files[`${ROOT}/custom_nodes/ltx-video/requirements.txt`] = 'huggingface_hub>=1.0\n';
    const fs = createMemoryFs(files);
    const w = { pip: [], cps: [], compares: [], prompts: [] };
    const overlayTts = () => fs.existsSync(`${OVERLAY_SP}/transformers-4.57.3.dist-info/METADATA`);
    const url = `http://127.0.0.1:8888${PREFIX}`;
    fs.mkdirSync('/proc/370', { recursive: true });
    fs.writeFileSync('/proc/370/cmdline', [PY, 'main.py', '--listen', '0.0.0.0', '--port', '8888', '--baseurl', PREFIX].join('\0'));
    fs.symlinkSync(ROOT, '/proc/370/cwd');
    fs.writeFileSync('/proc/370/environ', 'PATH=/usr/bin\0HOME=/root');
    const io = {
        fs,
        exec(cmd, args = []) {
            if (cmd === 'pgrep') return { code: 0, stdout: '370', stderr: '' };
            if (cmd === 'cp' && args[0] === '-a') {
                w.cps.push(args.slice(1));
                const [src, dst] = args.slice(1);
                for (const [k, v] of Array.from(fs._files.entries())) {
                    if (k.startsWith(`${src}/`)) {
                        fs.mkdirSync(path.dirname(dst + k.slice(src.length)), { recursive: true });
                        fs.writeFileSync(dst + k.slice(src.length), v.data);
                    }
                }
                return { code: 0, stdout: '', stderr: '' };
            }
            if (args[0] === '-I' && args[1] === '-c' && /version_info/.test(args[2])) return { code: 0, stdout: '3.10\n', stderr: '' };
            if (args[0] === '-I' && args[1] === '-c' && args[2] === ov.OVERRIDES_SCRIPT) {
                w.compares.push({ cmd, args: args.slice(3) });
                const raw = overlayTts() ? e2eRaw({ ltxUsesHub }) : { overrides: [], nodes: [], core: {} };
                if (coreRaw && overlayTts()) raw.core = coreRaw;
                const nodes = JSON.parse(args[5]).map((n) => n.key);
                raw.nodes = raw.nodes.filter((n) => nodes.includes(n.key));
                return { code: 0, stdout: `${JSON.stringify(raw)}\n`, stderr: '' };
            }
            if (args[0] === '-I' && args[1] === '-c') {
                const ok = args[3].includes('ltx-video') || overlayTts();
                const items = [{ line: 'qwen-tts', name: 'qwen-tts', status: ok ? 'ok' : 'missing' }];
                return { code: 0, stdout: `${JSON.stringify({ torch: { torch: '2.4.0' }, items })}\n`, stderr: '' };
            }
            if (args[0] === '-m' && args[1] === 'pip' && args[2] === '--version') return { code: 0, stdout: 'pip 22.0.2', stderr: '' };
            if (args[0] === '-m' && args[1] === 'pip') {
                w.pip.push({ cmd, args });
                fs.mkdirSync(`${OVERLAY_SP}/transformers-4.57.3.dist-info`, { recursive: true });
                fs.writeFileSync(`${OVERLAY_SP}/transformers-4.57.3.dist-info/METADATA`, 'Name: transformers\nVersion: 4.57.3\n');
                return { code: 0, stdout: 'Successfully installed', stderr: '' };
            }
            return { code: 0, stdout: '', stderr: '' };
        },
        pidAlive: (pid) => pid === 370,
        kill() { throw new Error('nothing is stopped in these tests'); },
        http: {
            async fetchJson(u) {
                if (u === `${url}/system_stats`) return { status: 200, json: { system: {}, devices: [] } };
                if (u === `${url}/object_info`) {
                    const json = {};
                    for (const c of [...TTS_CLASSES, ...LTX_CLASSES]) json[c] = {};
                    return { status: 200, json };
                }
                return { status: 404, json: null };
            },
            async fetchText() { return { status: 404, text: '' }; },
        },
        now: () => Date.parse('2026-11-02T10:00:00Z'),
    };
    return { io, fs, w, overlayTts };
}

function typeAState(extra = {}) {
    return {
        state_version: 1, mode: 'existing', profiles: ['audio/qwen-tts'], artifacts: {}, decisions: {},
        installer_options: { startWorker: true, ...(extra.installer_options || {}) },
        components: { comfyui: { owned: false, path: ROOT } },
        comfy_owner: { owner: 'foreign', pid: 370, url: `http://127.0.0.1:8888${PREFIX}` },
        ...(extra.profiles ? { profiles: extra.profiles } : {}),
    };
}

async function gate(env, opts = {}) {
    const state = opts.state || typeAState();
    const instance = await owner.resolveComfyOwner(env.io, { state, root: ROOT });
    assert.strictEqual(instance.owner, 'foreign');
    const lines = [];
    const logger = { info: (l) => lines.push(`i ${l}`), warn: (l) => lines.push(`! ${l}`), error: (l) => lines.push(`x ${l}`) };
    const g = await cli.platformNodeDepsGate(env.io, {
        instance, state, root: ROOT, manifests: [ttsManifest()], boot: false, yes: false,
        waitMs: 60000, sleep: async () => {}, statePath: STATE_PATH, workerDir: WORKER_DIR, platformGraceMs: 1000, logger,
        ...opts,
    });
    return { g, lines };
}

// ---------------------------------------------------------------------------
// O1  real Python
// ---------------------------------------------------------------------------

/** A pure wheel built by hand (no network, no setuptools). */
function buildWheel(dir, name, version, requires = []) {
    const meta = [`Metadata-Version: 2.1`, `Name: ${name}`, `Version: ${version}`, ...requires.map((r) => `Requires-Dist: ${r}`)].join('\n');
    const r = spawnSync('python3', ['-I', '-c', [
        'import zipfile, hashlib, base64, sys, json',
        'name, ver, meta, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]',
        'mod = name.replace("-", "_")',
        'di = "%s-%s.dist-info" % (mod, ver)',
        'files = {mod + "/__init__.py": ("V = %r\\n" % ver).encode(), di + "/METADATA": (meta + "\\n").encode(), di + "/WHEEL": b"Wheel-Version: 1.0\\nGenerator: t\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n"}',
        'rec = []',
        'z = zipfile.ZipFile("%s/%s-%s-py3-none-any.whl" % (out, mod, ver), "w")',
        'for n, b in files.items():',
        '    z.writestr(n, b)',
        '    rec.append("%s,sha256=%s,%d" % (n, base64.urlsafe_b64encode(hashlib.sha256(b).digest()).rstrip(b"=").decode(), len(b)))',
        'rec.append(di + "/RECORD,,")',
        'z.writestr(di + "/RECORD", "\\n".join(rec) + "\\n")',
        'z.close()',
    ].join('\n'), name, version, meta, dir], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
}

function pipTarget(wheelDir, target, specs) {
    const r = spawnSync('python3', ['-m', 'pip', 'install', '--no-index', '--no-deps', '--find-links', wheelDir, '--target', target, ...specs], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
}

describe('0.2.6 O1 overlay comparison in a REAL Python', () => {
    it('O1a: replacements (direct + transitive) attributed to the node that forced them; another profile and the core range are found', function () {
        this.timeout(120000);
        const pre = spawnSync('python3', ['-c', 'import venv, pip; from pip._vendor.packaging.requirements import Requirement'], { encoding: 'utf8' });
        if (pre.status !== 0) this.skip();
        const tmp = realFs.mkdtempSync(path.join(os.tmpdir(), 'anim-ovr-'));
        try {
            const wheels = path.join(tmp, 'wheels');
            realFs.mkdirSync(wheels);
            buildWheel(wheels, 'animtf', '5.0.0', ['animhub>=1.0']);
            buildWheel(wheels, 'animhub', '1.3.5');
            buildWheel(wheels, 'animcrypt', '3.4.8');
            buildWheel(wheels, 'animtf', '4.57.3', ['animhub<1.0,>=0.34', 'animcrypt>=43; python_version >= "3"', 'animunused; extra == "never"']);
            buildWheel(wheels, 'animhub', '0.36.2');
            buildWheel(wheels, 'animcrypt', '50.0.2');
            buildWheel(wheels, 'animnew', '1.0');
            // the "platform": a venv (system site-packages for packaging/pip) with the platform versions
            const plat = path.join(tmp, 'platform');
            const v = spawnSync('python3', ['-m', 'venv', '--without-pip', '--system-site-packages', plat], { encoding: 'utf8' });
            if (v.status !== 0) this.skip();
            const platPy = path.join(plat, 'bin', 'python');
            const platSp = String(spawnSync(platPy, ['-I', '-c', 'import sysconfig; print(sysconfig.get_paths()["purelib"])'], { encoding: 'utf8' }).stdout).trim();
            pipTarget(wheels, platSp, ['animtf==5.0.0', 'animhub==1.3.5', 'animcrypt==3.4.8']);
            const overlay = path.join(tmp, 'overlay');
            pipTarget(wheels, overlay, ['animtf==4.57.3', 'animhub==0.36.2', 'animcrypt==50.0.2', 'animnew==1.0']);
            const root = path.join(tmp, 'ComfyUI');
            realFs.mkdirSync(path.join(root, 'custom_nodes', 'qwen3-tts'), { recursive: true });
            realFs.mkdirSync(path.join(root, 'custom_nodes', 'ltx-video'), { recursive: true });
            realFs.writeFileSync(path.join(root, 'requirements.txt'), 'animtf>=4.50.3\nanimcrypt<10\n');
            realFs.writeFileSync(path.join(root, 'custom_nodes', 'qwen3-tts', 'requirements.txt'), 'animtf==4.57.3\nanimnew\n');
            realFs.writeFileSync(path.join(root, 'custom_nodes', 'ltx-video', 'requirements.txt'), 'animhub>=1.0\n');
            const io = createRealIo();
            const manifests = [
                { profile: { id: 'audio/qwen-tts' }, dependencies: [{ kind: 'custom_node', requirement: 'required', install: { directory: 'qwen3-tts' } }] },
                { profile: { id: 'video/ltx-2.3' }, dependencies: [{ kind: 'custom_node', requirement: 'required', install: { directory: 'ltx-video' } }] },
            ];
            const nodes = ov.nodesOfProfiles(io, { root, manifests });
            const raw = ov.inspectOverlay(io, { python: platPy, sitePackages: overlay, root, nodes });
            assert.strictEqual(raw.ok, true, raw.error);
            const res = ov.analyzeOverrides(raw, nodes, { profileCount: 2 });
            const byName = Object.fromEntries(res.overrides.map((o) => [o.package, o]));
            assert.deepStrictEqual(Object.keys(byName).sort(), ['animcrypt', 'animhub', 'animtf'], 'animnew is an addition, not a replacement');
            assert.deepStrictEqual(byName.animtf, { package: 'animtf', key: 'animtf', platform: '5.0.0', overlay: '4.57.3', major: 'down', needed_by: ['qwen3-tts'], profiles: ['audio/qwen-tts'] });
            assert.deepStrictEqual(byName.animhub.needed_by, ['qwen3-tts'], 'transitive (Requires-Dist of the overlay animtf)');
            assert.strictEqual(byName.animcrypt.major, 'up');
            assert.strictEqual(ov.describeOverride(byName.animtf), 'animtf platform 5.0.0 → overlay 4.57.3 (needed by qwen3-tts)');
            const kinds = res.conflicts.map((c) => `${c.kind}:${c.package}:${c.profile || '-'}:${c.accepts_overlay}`).sort();
            assert.deepStrictEqual(kinds, ['core:animcrypt:-:false', 'profile:animhub:video/ltx-2.3:false']);
            // one profile → no conflict at all (the current single-node behaviour is unchanged)
            const single = ov.analyzeOverrides(raw, ov.nodesOfProfiles(io, { root, manifests: [manifests[0]] }), { profileCount: 1 });
            assert.strictEqual(single.conflicts.length, 0);
            assert.strictEqual(single.overrides.length, 3);
        } finally {
            realFs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// O2  one profile
// ---------------------------------------------------------------------------

describe('0.2.6 O2 one profile: replacements are reported and recorded', () => {
    it('O2a: boot installs qwen-tts deps → three replacements logged ([i] / ! for major), recorded, RESULT lines; not failed', async () => {
        const env = world();
        const { g, lines } = await gate(env, { boot: true });
        assert.strictEqual(g.failed, false, g.reason);
        assert.strictEqual(env.w.pip.length, 1);
        assert.strictEqual(env.w.cps.length, 0, 'one profile — no snapshot');
        assert.strictEqual(env.w.compares[0].cmd, PY, 'compared in the PLATFORM Python');
        assert.strictEqual(env.w.compares[0].args[0], OVERLAY_SP);
        assert.deepStrictEqual(g.record.nodeDeps.overrides, [
            { package: 'cryptography', platform: '3.4.8', overlay: '50.0.2', major: 'up', needed_by: ['qwen3-tts'], profiles: ['audio/qwen-tts'] },
            { package: 'huggingface_hub', platform: '1.3.5', overlay: '0.36.2', major: 'down', needed_by: ['qwen3-tts'], profiles: ['audio/qwen-tts'] },
            { package: 'transformers', platform: '5.0.0', overlay: '4.57.3', major: 'down', needed_by: ['qwen3-tts'], profiles: ['audio/qwen-tts'] },
        ]);
        assert.ok(lines.some((l) => l.startsWith('! node-deps overlay replaces a platform package: transformers platform 5.0.0 → overlay 4.57.3 (needed by qwen3-tts) — major version DOWN (5 → 4)')), lines.join('\n'));
        const items = ov.resultItems(g.overrides);
        assert.deepStrictEqual(items.map((i) => i.ok), ['warn', 'warn', 'warn']);
        const text = summary.renderFinalSummary({ extra: items, e2e: [{ ok: true, label: 'Worker' }] });
        assert.ok(text.ok, 'replacements are never failures');
        assert.ok(text.text.includes('! transformers platform 5.0.0 → overlay 4.57.3 (needed by qwen3-tts) — major version DOWN'), text.text);
    });

    it('O2b: a minor replacement is [i]; doctor with the deps already in place still reports and records them', async () => {
        const env = world({ overlayHasTts: true });
        const { g } = await gate(env, { yes: true });
        assert.strictEqual(g.failed, false, g.reason);
        assert.strictEqual(env.w.pip.length, 0);
        assert.strictEqual(g.record.nodeDeps.overrides.length, 3);
        const minor = { package: 'x', platform: '1.2.0', overlay: '1.4.1', major: null, needed_by: ['n'] };
        const [item] = ov.resultItems([minor]);
        assert.strictEqual(item.ok, 'info');
        assert.ok(summary.renderFinalSummary({ extra: [item] }).text.includes('[i] x platform 1.2.0 → overlay 1.4.1 (needed by n)'));
    });
});

// ---------------------------------------------------------------------------
// O3  another profile on the same ComfyUI
// ---------------------------------------------------------------------------

describe('0.2.6 O3 a replacement that touches another profile needs consent', () => {
    it('O3a: boot → FAILED with the cause, the overlay is restored from the snapshot', async () => {
        const env = world({ ltxOnDisk: true });
        const { g, lines } = await gate(env, { boot: true, otherManifests: [ltxManifest()] });
        assert.strictEqual(g.failed, true);
        assert.deepStrictEqual(env.w.cps, [[VENV, `${VENV}.pre-install`]], 'snapshot before pip');
        assert.strictEqual(env.w.pip.length, 1);
        assert.strictEqual(env.overlayTts(), false, 'the replacement was undone');
        assert.strictEqual(env.fs.existsSync(`${VENV}.pre-install`), false);
        assert.strictEqual(env.fs.existsSync(`${VENV}/pyvenv.cfg`), true, 'the overlay venv itself is back');
        assert.ok(/boot never consents/.test(g.reason), g.reason);
        assert.ok(g.reason.includes('huggingface_hub platform 1.3.5 → overlay 0.36.2 (needed by qwen3-tts, profile audio/qwen-tts) also changes it for profile video/ltx-2.3 (node ltx-video, requires >=1.0; the overlay version is OUTSIDE that range)'), g.reason);
        assert.ok(g.reason.includes('One GPU node — one profile'));
        assert.ok(g.reason.includes('restored'));
        assert.deepStrictEqual(g.record.nodeDeps.overrides, [], 'the record shows the restored overlay');
        assert.ok(lines.some((l) => l.startsWith('! version replacement affects another profile: huggingface_hub')), lines.join('\n'));
        assert.ok(g.fix.endsWith('doctor --accept-node-deps-overrides'), g.fix);
        const parsed = cli.parseArgs(['n', 'c', ...g.fix.split(': ').pop().split(' ').slice(1)]);
        assert.deepStrictEqual(parsed.errors, []);
        assert.strictEqual(parsed.flags['accept-node-deps-overrides'], true);
    });

    it('O3b: --yes is not consent; --accept-node-deps-overrides is, and it is recorded', async () => {
        const a = world({ ltxOnDisk: true });
        const ra = await gate(a, { yes: true, otherManifests: [ltxManifest()] });
        assert.strictEqual(ra.g.failed, true);
        assert.ok(/--yes is not consent/.test(ra.g.reason), ra.g.reason);

        const b = world({ ltxOnDisk: true });
        const rb = await gate(b, { yes: true, flags: { 'accept-node-deps-overrides': true }, otherManifests: [ltxManifest()] });
        assert.strictEqual(rb.g.failed, false, rb.g.reason);
        assert.strictEqual(b.overlayTts(), true, 'kept');
        assert.strictEqual(b.fs.existsSync(`${VENV}.pre-install`), false, 'snapshot dropped');
        assert.deepStrictEqual(rb.g.record.nodeDeps.accepted.map((x) => x.key), ['huggingface-hub@0.36.2:video/ltx-2.3']);
    });

    it('O3c: interactive — the question lists the conflict (default No); yes is recorded and not asked again; no restores', async () => {
        const asked = [];
        const env = world({ ltxOnDisk: true });
        const yesPrompt = { available: true, confirm: async (q, o) => { asked.push({ q, o }); return true; } };
        const r1 = await gate(env, { prompt: yesPrompt, otherManifests: [ltxManifest()], flags: { 'restart-platform-comfy': true } });
        assert.strictEqual(r1.g.failed, false, r1.g.reason);
        const q = asked.find((x) => /node-deps overlay is first in sys.path/.test(x.q));
        assert.ok(q, asked.map((x) => x.q).join('\n'));
        assert.strictEqual(q.o.defaultYes, false);
        assert.ok(q.q.includes('profile video/ltx-2.3'));
        // next run with the recorded answer: no question, not failed
        const asked2 = [];
        const state = typeAState({ installer_options: { nodeDeps: r1.g.record.nodeDeps } });
        const r2 = await gate(env, { state, prompt: { available: true, confirm: async (x) => { asked2.push(x); return false; } }, otherManifests: [ltxManifest()], flags: { 'restart-platform-comfy': true } });
        assert.strictEqual(r2.g.failed, false, r2.g.reason);
        assert.strictEqual(asked2.filter((x) => /sys.path/.test(x)).length, 0);

        const env3 = world({ ltxOnDisk: true });
        const r3 = await gate(env3, { prompt: { available: true, confirm: async (x) => !/sys.path/.test(x) }, otherManifests: [ltxManifest()], flags: { 'restart-platform-comfy': true } });
        assert.strictEqual(r3.g.failed, true);
        assert.ok(/not accepted/.test(r3.g.reason));
        assert.strictEqual(env3.overlayTts(), false);
    });

    it('O3d: another profile that does NOT use the replaced packages → no question, no failure', async () => {
        const env = world({ ltxOnDisk: true, ltxUsesHub: false });
        const { g } = await gate(env, { boot: true, otherManifests: [ltxManifest()] });
        assert.strictEqual(g.failed, false, g.reason);
        assert.strictEqual(env.overlayTts(), true);
        assert.strictEqual(env.w.cps.length, 1, 'snapshot taken (two profiles) and dropped');
        assert.strictEqual(env.fs.existsSync(`${VENV}.pre-install`), false);
    });

    it('O3e: two profiles + a ComfyUI core requirement whose range excludes the overlay version → conflict', async () => {
        const env = world({ ltxOnDisk: true, ltxUsesHub: false, coreRaw: { transformers: { spec: '>=5.0', accepts_overlay: false } } });
        const { g } = await gate(env, { boot: true, otherManifests: [ltxManifest()] });
        assert.strictEqual(g.failed, true);
        assert.ok(g.reason.includes('is outside the range of the ComfyUI core requirement transformers>=5.0'), g.reason);
    });
});

// ---------------------------------------------------------------------------
// O4  a profile installed later
// ---------------------------------------------------------------------------

describe('0.2.6 O4 installing another profile next to existing replacements', () => {
    it('O4a: `install --profile video/ltx-2.3` on a ComfyUI whose overlay already serves qwen-tts → consent; boot-like run fails, nothing removed', async () => {
        const env = world({ overlayHasTts: true, ltxOnDisk: true });
        const { g } = await gate(env, {
            yes: true, manifests: [ltxManifest()], otherManifests: [ttsManifest()], command: 'install', flags: { profiles: ['video/ltx-2.3'] },
        });
        assert.strictEqual(g.failed, true);
        assert.strictEqual(env.w.pip.length, 0);
        assert.strictEqual(env.overlayTts(), true, 'the overlay of the installed profile is left alone');
        assert.ok(g.fix.includes('install --profile video/ltx-2.3 --accept-node-deps-overrides'), g.fix);
    });

    it('O4b: the other profiles come from install-state (profiles + recorded overrides), the current ones excluded, unknown ids skipped', () => {
        const loaded = [];
        const warned = [];
        const st = typeAState({
            profiles: ['audio/qwen-tts'],
            installer_options: { nodeDeps: { overrides: [{ package: 'x', profiles: ['image/qwen-image', 'nope/missing'] }] } },
        });
        const out = cli.otherProfileManifests(st, ['video/ltx-2.3'], {
            load: (id) => { if (id === 'nope/missing') throw new Error('not found'); loaded.push(id); return { profile: { id } }; },
            logger: { warn: (l) => warned.push(l) },
        });
        assert.deepStrictEqual(out.map((m) => m.profile.id), ['audio/qwen-tts', 'image/qwen-image']);
        assert.strictEqual(warned.length, 1);
        assert.deepStrictEqual(cli.otherProfileManifests(st, ['audio/qwen-tts', 'image/qwen-image', 'nope/missing'], { load: (id) => ({ profile: { id } }) }), []);
    });
});

// ---------------------------------------------------------------------------
// O5  plumbing
// ---------------------------------------------------------------------------

describe('0.2.6 O5 plumbing', () => {
    it('O5a: majorChange', () => {
        assert.strictEqual(ov.majorChange('5.0.0', '4.57.3'), 'down');
        assert.strictEqual(ov.majorChange('3.4.8', '50.0.2'), 'up');
        assert.strictEqual(ov.majorChange('1.2', '1.9.0'), null);
        assert.strictEqual(ov.majorChange('abc', '1.0'), null);
    });

    it('O5b: the CLI knows --accept-node-deps-overrides', () => {
        assert.ok(cli.BOOLEAN_FLAGS.includes('accept-node-deps-overrides'));
        assert.deepStrictEqual(cli.parseArgs(['n', 'c', 'doctor', '--accept-node-deps-overrides']).errors, []);
    });

    it('O5c: the engine keeps installer_options.nodeDeps written by the dependency gate (real runInstallation)', async () => {
        const R = '/c';
        const VPY = `${R}/venv/bin/python`;
        const fs = createMemoryFs({ [`${R}/main.py`]: '#', [VPY]: '', [`${R}/custom_nodes/qwen3-tts/requirements.txt`]: 'transformers\n' });
        const io = {
            fs,
            exec(cmd, args = []) {
                if (cmd === VPY && args[0] === '-I') return { code: 0, stdout: JSON.stringify({ torch: {}, items: [{ name: 'transformers', status: 'ok' }] }) };
                if (cmd === 'pgrep') return { code: 1, stdout: '' };
                if (/python/.test(cmd) && args[0] === '--version') return { code: 0, stdout: 'Python 3.10.12' };
                if (/python/.test(cmd) && args[0] === '-c') return { code: 0, stdout: '2.4.0+cu121' };
                return { code: 0, stdout: '', stderr: '' };
            },
            spawnDaemon: () => 4242,
            http: { async fetchJson() { throw new Error('ECONNREFUSED'); }, async fetchText() { return { status: 404, text: '' }; } },
            now: () => Date.now(),
        };
        const nodeDepsRecord = { target: 'overlay', overlay: OVERLAY_SP, python: PY, overrides: [{ package: 'transformers', platform: '5.0.0', overlay: '4.57.3', major: 'down', needed_by: ['qwen3-tts'], profiles: ['audio/qwen-tts'] }], accepted: [] };
        const sp = `${R}/.animastor-installer/install-state.json`;
        fs.mkdirSync(`${R}/.animastor-installer`, { recursive: true });
        fs.writeFileSync(sp, JSON.stringify({
            state_version: 1, mode: 'managed', profiles: ['audio/qwen-tts'], artifacts: {}, decisions: {},
            installer_options: { comfyPort: 8188, startComfyui: false, startWorker: false, nodeDeps: nodeDepsRecord },
            components: { comfyui: { owned: true, path: R } },
        }));
        const logger = createLogger({ io, quiet: true });
        const comfyOwner = await owner.resolveComfyOwner(io, { state: { components: { comfyui: { owned: true } } }, root: R });
        await engine.runInstallation({
            manifests: [{ ...ttsManifest(), runtime_requirements: {}, workflows: { artifacts: [] }, worker_bundle: { worker_type: 'audio', files: [], env: { required: [], secrets: [] } } }],
            mode: 'managed', io,
            roots: { comfyuiRoot: R, workerDir: null, statePath: sp, repoRoot: '/repo', hubUrl: 'https://h/gpu' },
            decisions: { worker_setup: false, workflows: 'none', comfyui_update: 'no', apply_fixes: true, install_custom_nodes: true },
            secretProvider: async () => null,
            logger, crypto: require('crypto'),
            options: {
                interruptGuard: false, currentUid: 1000, home: '/home/u', nodeBinary: { bin: '/n22', version: '22.0.0' },
                startComfyui: false, startWorker: false, verifyTimeoutMs: 50, pollIntervalMs: 5, comfyOwner,
            },
            platformAdapter: { ...LINUX, checkBuildPrerequisites: () => ({ ok: true }), sleepCommand: () => ({ cmd: 'true', args: [] }) },
        });
        const after = JSON.parse(fs.readFileSync(sp, 'utf8'));
        assert.deepStrictEqual(after.installer_options.nodeDeps, nodeDepsRecord);
        assert.strictEqual(after.installer_options.comfyPort, 8188, 'the engine did write installer_options');
    });

    it('O5d: a failed comparison is a warning, never a failure', async () => {
        const env = world({ overlayHasTts: true });
        const exec = env.io.exec;
        env.io.exec = (cmd, args) => (args && args[2] === ov.OVERRIDES_SCRIPT ? { code: 1, stdout: '', stderr: 'boom' } : exec(cmd, args));
        const { g, lines } = await gate(env, { boot: true });
        assert.strictEqual(g.failed, false);
        assert.ok(lines.some((l) => /overlay version comparison failed: boom/.test(l)));
    });
});
