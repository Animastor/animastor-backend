'use strict';

/**
 * Installer UX fixes from the E2E run of 2026-10-30 (V100, ComfyUI and the
 * Qwen3-TTS models already present):
 *   - model detection: extra_model_paths.yaml folders, repository metadata
 *     files never make a model "incomplete", explicit reasons, only missing
 *     files are downloaded, the plan shows only what is really missing;
 *   - ComfyUI URL probe: plain URL first, notebook prefix only as fallback;
 *   - worker type from the profile, .env fixes with one consent, token safety;
 *   - worker bundle: zero-dependency bundle starts without npm, declared
 *     dependencies are installed, outdated bundles are updated;
 *   - "start worker" is done only after "ComfyUI ready"; end-to-end checks
 *     and the final summary (one cause + one fix per ✗, no "scroll up");
 *   - prompts: /dev/tty, hidden input with pasted chunks, no-TTY error;
 *   - the `animastor` command and the persistent installer copy.
 */

const assert = require('assert');
const fsReal = require('fs');
const os = require('os');
const path = require('path');

const { createMemoryFs, createRealIo } = require('../src/installer/engine/io');
const probe = require('../src/installer/engine/probe');
const resolver = require('../src/installer/compatibility-resolver');
const { buildInstallPlan } = require('../src/installer/install-plan');
const workerMod = require('../src/installer/engine/worker');
const fixes = require('../src/installer/engine/fixes');
const summary = require('../src/installer/engine/summary');
const tty = require('../src/installer/engine/tty');
const management = require('../src/installer/management');
const engine = require('../src/installer/engine/engine');

const LINUX = require('../src/installer/platform/linux');

const TTS_FILES = [
    '.gitattributes', 'README.md', 'config.json', 'configuration.json', 'generation_config.json',
    'merges.txt', 'model.safetensors', 'preprocessor_config.json', 'tokenizer_config.json', 'vocab.json',
    'speech_tokenizer/config.json', 'speech_tokenizer/configuration.json',
    'speech_tokenizer/model.safetensors', 'speech_tokenizer/preprocessor_config.json',
];

function ttsManifest(extra = {}) {
    return {
        profile: { id: 'audio/qwen-tts', name: 'qwen-tts' },
        hardware: { gpu_min_vram_gb: 12 },
        runtime_requirements: {},
        dependencies: [{
            id: 'model-repo:vd', kind: 'model_repo', name: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign',
            requirement: 'required', basis: 'known_working', repo: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign',
            target_dir: 'models/TTS/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign',
            expected_files: TTS_FILES, size_bytes_approx: 4520164607,
            source: { kind: 'modelscope', repository: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign', verification: 'confirmed' },
            delivery: { mechanism: 'installer_preload' },
            ...extra,
        }],
        workflows: { artifacts: [] },
        worker_bundle: {
            worker_type: 'audio',
            files: ['worker.cjs', 'package.json', '.env.example'],
            env: { required: ['HUB_URL', 'ANIMASTOR_WORKER_TOKEN', 'WORKER_TYPE', 'WORKER_ID'], secrets: ['ANIMASTOR_WORKER_TOKEN'] },
        },
    };
}

function memIo(files = {}, { exec = null, http = null } = {}) {
    const fs = createMemoryFs(files);
    const calls = { exec: [], spawn: [] };
    return {
        fs,
        calls,
        exec(cmd, args = [], opts = {}) {
            calls.exec.push({ cmd, args, opts });
            if (exec) {
                const r = exec(cmd, args, opts);
                if (r) return r;
            }
            return { code: 0, stdout: '', stderr: '' };
        },
        spawnDaemon(command, args, opts) {
            calls.spawn.push({ command, args, opts });
            return 4242;
        },
        http: {
            async fetchJson(url, opts) {
                if (http) return http(url, opts);
                throw new Error('ECONNREFUSED');
            },
        },
        now: () => Date.now(),
    };
}

const modelEntry = (env, manifest = ttsManifest()) => resolver.resolveInstallation({ manifests: [manifest], environment: env, mode: 'existing' })
    .entries.find((e) => e.kind === 'model_repo');

// ---------------------------------------------------------------------------
// Model detection
// ---------------------------------------------------------------------------

describe('UX: model detection (extra_model_paths.yaml, metadata files, reasons)', () => {
    it('X1: parses extra_model_paths.yaml (base_path, relative, absolute, block lists, comments)', () => {
        const yaml = [
            '# my setup',
            'comfyui:',
            '    base_path: /data/comfy/',
            '    is_default: true',
            '    checkpoints: models/checkpoints/',
            '    TTS: /mnt/tts   # absolute',
            '    loras: |',
            '         models/loras/',
            '         more_loras/',
            'other:',
            '    unet: unet_extra',
        ].join('\n');
        const out = probe.parseExtraModelPaths(yaml, '/home/u/ComfyUI');
        assert.deepStrictEqual(out, [
            { folder: 'checkpoints', path: '/data/comfy/models/checkpoints/' },
            { folder: 'TTS', path: '/mnt/tts' },
            { folder: 'loras', path: '/data/comfy/models/loras/' },
            { folder: 'loras', path: '/data/comfy/more_loras/' },
            { folder: 'unet', path: '/home/u/ComfyUI/unet_extra' },
        ]);
    });

    it('X2: models in an extra_model_paths folder are found under their canonical path, with the real location', () => {
        const files = {
            '/home/u/ComfyUI/main.py': '#',
            '/home/u/ComfyUI/extra_model_paths.yaml': 'comfyui:\n    TTS: /mnt/tts\n',
        };
        for (const f of TTS_FILES) files[`/mnt/tts/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign/${f}`] = 'x';
        const io = memIo(files);
        const models = probe.probeModels(io, '/home/u/ComfyUI');
        const hit = models.find((m) => m.path === 'models/TTS/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign/model.safetensors');
        assert.ok(hit, JSON.stringify(models.slice(0, 3)));
        assert.strictEqual(hit.location, '/mnt/tts');
        const e = modelEntry({ models });
        assert.strictEqual(e.status, 'installed');
        assert.deepStrictEqual(e.found.location, { base: '/mnt/tts', target_dir: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign' });
    });

    it('X3: missing repository metadata (.gitattributes, README.md, configuration.json) does NOT make a model incomplete', () => {
        const prefix = 'models/TTS/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign';
        const meta = new Set(['.gitattributes', 'README.md', 'configuration.json', 'speech_tokenizer/configuration.json']);
        const models = TTS_FILES.filter((f) => !meta.has(f)).map((f) => ({ path: `${prefix}/${f}`, size_bytes: 10 }));
        const e = modelEntry({ models });
        assert.strictEqual(e.status, 'installed', JSON.stringify(e));
        assert.strictEqual(e.action, 'skip');
    });

    it('X4: a really incomplete repo names the missing files; only those are planned, with their size', () => {
        const prefix = 'models/TTS/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign';
        const models = TTS_FILES.filter((f) => f !== 'model.safetensors').map((f) => ({ path: `${prefix}/${f}`, size_bytes: 10 }));
        const report = resolver.resolveInstallation({ manifests: [ttsManifest()], environment: { models }, mode: 'existing' });
        const e = report.entries.find((x) => x.kind === 'model_repo');
        assert.strictEqual(e.status, 'missing');
        assert.strictEqual(e.reason, 'incomplete');
        assert.deepStrictEqual(e.missing_files, ['model.safetensors']);
        assert.ok(e.notes[0].includes('missing files: model.safetensors'), e.notes[0]);
        e.missing_bytes_approx = 3833000000; // what annotateMissingModelSizes fills from the registry
        const plan = buildInstallPlan({ report, manifests: [ttsManifest()], decisions: {} });
        assert.ok(/✗ Qwen\/Qwen3-TTS-12Hz-1\.7B-VoiceDesign — incomplete — missing model\.safetensors \(≈ 3\.57 GiB\)/.test(plan.plan_text), plan.plan_text);
        assert.ok(plan.plan_text.includes('Download 1 missing file(s) of Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign (≈ 3.57 GiB)'), plan.plan_text);
        assert.ok(!plan.plan_text.includes('4.21 GiB'), 'never the whole repo size for a partial download');
    });

    it('X5: an interrupted download is reported as such (.part on disk)', () => {
        const prefix = 'models/TTS/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign';
        const models = TTS_FILES.filter((f) => f !== 'model.safetensors').map((f) => ({ path: `${prefix}/${f}` }))
            .concat([{ path: `${prefix}/model.safetensors.part` }]);
        const e = modelEntry({ models });
        assert.ok(e.notes[0].includes('download interrupted (model.safetensors: .part on disk)'), e.notes[0]);
    });

    it('X6: a fully missing repo shows "not found" with the full approximate size; a complete one is listed as detected', () => {
        const report = resolver.resolveInstallation({ manifests: [ttsManifest()], environment: { models: [] }, mode: 'existing' });
        const plan = buildInstallPlan({ report, manifests: [ttsManifest()], decisions: {} });
        assert.ok(plan.plan_text.includes('— not found (≈ 4.21 GiB download)'), plan.plan_text);
        const prefix = 'models/TTS/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign';
        const full = resolver.resolveInstallation({ manifests: [ttsManifest()], environment: { models: TTS_FILES.map((f) => ({ path: `${prefix}/${f}` })) }, mode: 'existing' });
        const plan2 = buildInstallPlan({ report: full, manifests: [ttsManifest()], decisions: {} });
        assert.ok(plan2.plan_text.includes('✓ Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign'), plan2.plan_text);
        assert.ok(!plan2.plan_text.includes('Missing:'), plan2.plan_text);
    });
});

// ---------------------------------------------------------------------------
// ComfyUI URL probe / root / mode
// ---------------------------------------------------------------------------

describe('UX: ComfyUI URL probe (prefix only when needed) and root detection', () => {
    const answering = (okUrls) => async (url) => {
        if (okUrls.includes(url)) return { status: 200, json: { system: { os: 'posix' }, devices: [] } };
        return { status: 404, json: null };
    };

    it('U1: the plain URL wins when ComfyUI answers without the notebook prefix', async () => {
        const io = memIo({}, { http: answering(['http://127.0.0.1:8188/system_stats', 'http://127.0.0.1:8188/notebook/u/x/system_stats']) });
        const r = await probe.probeComfyUrl(io, { port: 8188, prefixes: ['/notebook/u/x/'] });
        assert.strictEqual(r.url, 'http://127.0.0.1:8188');
        assert.strictEqual(r.prefixed, false);
    });

    it('U2: the notebook prefix is used only when ComfyUI answers there', async () => {
        const io = memIo({}, { http: answering(['http://127.0.0.1:8888/notebook/u/x/system_stats']) });
        const r = await probe.probeComfyUrl(io, { port: 8888, prefixes: ['notebook/u/x'] });
        assert.strictEqual(r.url, 'http://127.0.0.1:8888/notebook/u/x');
        assert.strictEqual(r.prefixed, true);
    });

    it('U3: nothing answers → no URL (never guessed), every candidate listed', async () => {
        const io = memIo({});
        const r = await probe.probeComfyUrl(io, { port: 8188, prefixes: ['/nb'] });
        assert.strictEqual(r.url, null);
        assert.deepStrictEqual(r.tried, ['http://127.0.0.1:8188', 'http://127.0.0.1:8188/nb']);
    });

    it('U4: ComfyUI root — explicit flag > ~/ComfyUI with main.py > running process cwd > default', () => {
        const io = memIo({ '/home/u/ComfyUI/main.py': '#', '/opt/comfy/main.py': '#' });
        assert.deepStrictEqual(probe.resolveComfyRoot(io, { explicit: '/x', defaultRoot: '/home/u/ComfyUI', running: null }), { root: '/x', source: 'flag' });
        assert.deepStrictEqual(probe.resolveComfyRoot(io, { defaultRoot: '/home/u/ComfyUI', running: { root: '/opt/comfy' } }), { root: '/home/u/ComfyUI', source: 'default' });
        assert.deepStrictEqual(probe.resolveComfyRoot(io, { defaultRoot: '/home/v/ComfyUI', running: { root: '/opt/comfy' } }), { root: '/opt/comfy', source: 'running-process' });
        assert.deepStrictEqual(probe.resolveComfyRoot(io, { defaultRoot: '/home/v/ComfyUI', running: null }), { root: '/home/v/ComfyUI', source: 'default' });
    });

    it('U5: the running ComfyUI process gives root, --port and --baseurl', () => {
        const io = memIo({ '/proc/77/cmdline': ['python', 'main.py', '--port', '8888', '--baseurl', '/notebook/u/x'].join('\0'), '/opt/comfy/main.py': '#' }, {
            exec: (cmd) => (cmd === 'pgrep' ? { code: 0, stdout: '77\n' } : null),
        });
        io.fs.readlinkSync = (p) => (p === '/proc/77/cwd' ? '/opt/comfy' : (() => { throw new Error('x'); })());
        assert.deepStrictEqual(probe.detectRunningComfyUI(io, { uid: 1000 }), { pid: 77, root: '/opt/comfy', port: 8888, baseurl: '/notebook/u/x' });
    });

    it('U6: Node.js for the worker — the installer\'s own node when >= 20, never an old node 18', () => {
        const io = memIo({}, { exec: (cmd) => (cmd === 'node' ? { code: 0, stdout: '/usr/bin/node 18.19.0\n' } : { code: 1, stdout: '' }) });
        assert.deepStrictEqual(probe.pickNodeBinary(io, { execPath: '/opt/node22/bin/node', execVersion: '22.23.2' }), { bin: '/opt/node22/bin/node', version: '22.23.2' });
        assert.strictEqual(probe.pickNodeBinary(io, { execPath: '/usr/bin/node', execVersion: '18.19.0' }), null);
    });
});

// ---------------------------------------------------------------------------
// Worker type, .env fixes, token safety
// ---------------------------------------------------------------------------

describe('UX: worker .env wiring (type from the profile, one consent for fixes)', () => {
    it('W1: WORKER_TYPE comes from the profile, not a hard-coded "image"', () => {
        const d = engine.desiredEnvWiring({ manifests: [ttsManifest()], nodeBin: '/n', comfyUrl: 'http://127.0.0.1:8188', comfyPort: 8188 });
        assert.deepStrictEqual(d, { WORKER_TYPE: 'audio', NODE_BIN: '/n', COMFY_URL: 'http://127.0.0.1:8188', NOTEBOOK_PATH: '', COMFY_PORT: '8188' });
        assert.strictEqual(engine.desiredEnvWiring({ manifests: [ttsManifest()], comfyUrl: 'http://127.0.0.1:8888/notebook/u/x' }).NOTEBOOK_PATH, '/notebook/u/x');
        assert.strictEqual(engine.desiredEnvWiring({ manifests: [ttsManifest()], hubUrl: 'https://h/gpu' }).HUB_URL, undefined, 'HUB_URL only when given explicitly');
    });

    it('W2: fix list shows differing wiring (type image→audio, node, prefixed URL); missing keys are additions, not fixes', () => {
        const items = fixes.planEnvFixes(
            { WORKER_TYPE: 'image', NODE_BIN: '/usr/bin/node', COMFY_URL: 'http://127.0.0.1:8188/notebook/u/x', ANIMASTOR_WORKER_TOKEN: 'never-listed' },
            { WORKER_TYPE: 'audio', NODE_BIN: '/opt/node22/bin/node', COMFY_URL: 'http://127.0.0.1:8188', COMFY_PORT: '8188' },
        );
        assert.deepStrictEqual(items.map((i) => i.key), ['WORKER_TYPE', 'NODE_BIN', 'COMFY_URL']);
        assert.ok(items[0].title.startsWith('WORKER_TYPE: image → audio'));
        assert.ok(!JSON.stringify(items).includes('never-listed'), 'the token is never part of the fix list');
    });

    it('W3: configureEnv overrides replace installer-owned keys, never the Worker Key; secretOverrides replace it explicitly', () => {
        const io = memIo({ '/w/.env': 'HUB_URL=https://animastor.org/gpu\nANIMASTOR_WORKER_TOKEN=wrk.a.old\nWORKER_TYPE=image\nWORKER_ID=x\n' });
        io.fs.mkdirSync('/w', { recursive: true });
        const r = workerMod.configureEnv(io, {
            workerDir: '/w', manifest: ttsManifest(),
            values: { COMFY_URL: 'http://127.0.0.1:8188' },
            overrides: { WORKER_TYPE: 'audio', ANIMASTOR_WORKER_TOKEN: 'wrk.a.sneaky', NODE_BIN: '/n' },
        });
        const text = io.fs.readFileSync('/w/.env', 'utf8');
        assert.ok(text.includes('WORKER_TYPE=audio') && !text.includes('WORKER_TYPE=image'), text);
        assert.ok(text.includes('ANIMASTOR_WORKER_TOKEN=wrk.a.old'), 'token untouched by overrides');
        assert.ok(!text.includes('sneaky'));
        assert.ok(text.includes('NODE_BIN=/n') && text.includes('COMFY_URL=http://127.0.0.1:8188'));
        assert.deepStrictEqual(r.changed, ['WORKER_TYPE']);
        workerMod.configureEnv(io, { workerDir: '/w', manifest: ttsManifest(), secretOverrides: { ANIMASTOR_WORKER_TOKEN: 'wrk.a.new' } });
        assert.ok(io.fs.readFileSync('/w/.env', 'utf8').includes('ANIMASTOR_WORKER_TOKEN=wrk.a.new'));
    });

    it('W4: declining the fixes keeps existing values (only missing keys are added)', () => {
        const io = memIo({ '/w/.env': 'WORKER_TYPE=image\n' });
        workerMod.configureEnv(io, { workerDir: '/w', manifest: ttsManifest(), values: { WORKER_TYPE: 'audio', COMFY_URL: 'http://127.0.0.1:8188' }, overrides: {} });
        const text = io.fs.readFileSync('/w/.env', 'utf8');
        assert.ok(text.includes('WORKER_TYPE=image') && !text.includes('WORKER_TYPE=audio'), text);
        assert.ok(text.includes('COMFY_URL=http://127.0.0.1:8188'));
    });
});

// ---------------------------------------------------------------------------
// Worker bundle, start, readiness
// ---------------------------------------------------------------------------

describe('UX: worker bundle and readiness', () => {
    const SRC = '/repo/packages/animastor-worker/worker';
    const bundleFiles = (version, deps = null) => ({
        [`${SRC}/worker.cjs`]: `// worker ${version}`,
        [`${SRC}/package.json`]: JSON.stringify({ name: 'animastor-worker', version, ...(deps ? { dependencies: deps } : {}) }),
        [`${SRC}/.env.example`]: 'HUB_URL=\n',
    });

    it('B1: a zero-dependency bundle is deployed and passes the start check without npm (no node-fetch probe)', () => {
        const io = memIo(bundleFiles('2.2.0'));
        const r = workerMod.installWorkerBundle(io, { workerDir: '/home/u/animastor/worker', manifest: ttsManifest(), repoRoot: '/repo' });
        assert.strictEqual(r.status, 'installed');
        assert.ok(!io.calls.exec.some((c) => /npm/.test(c.cmd)), 'npm never runs for a zero-dependency bundle');
        const can = workerMod.checkWorkerCanStart(io, { workerDir: '/home/u/animastor/worker', nodeBin: '/n' });
        assert.deepStrictEqual(can, { ok: true });
        assert.ok(!io.calls.exec.some((c) => c.args.join(' ').includes('node-fetch')));
    });

    it('B2: declared dependencies are installed with npm ci next to the chosen node; a failure is an error, not a warning', () => {
        const io = memIo({ ...bundleFiles('2.2.0', { ws: '^8' }), [`${SRC}/package-lock.json`]: '{}', '/opt/node/bin/npm': '#' }, {
            exec: (cmd, args) => (cmd === '/opt/node/bin/npm' && args[0] === 'ci' ? { code: 0, stdout: '' } : null),
        });
        workerMod.installWorkerBundle(io, { workerDir: '/w', manifest: { ...ttsManifest(), worker_bundle: { ...ttsManifest().worker_bundle, files: ['worker.cjs', 'package.json', 'package-lock.json', '.env.example'] } }, repoRoot: '/repo', nodeBin: '/opt/node/bin/node' });
        assert.ok(io.calls.exec.some((c) => c.cmd === '/opt/node/bin/npm' && c.args[0] === 'ci' && c.opts.cwd === '/w'));
        const bad = memIo(bundleFiles('2.2.0', { ws: '^8' }), { exec: (cmd) => (cmd === 'npm' ? { code: 1, stderr: 'E404' } : null) });
        assert.throws(() => workerMod.installWorkerBundle(bad, { workerDir: '/w', manifest: ttsManifest(), repoRoot: '/repo' }), /npm install in \/w failed: E404/);
    });

    it('B3: an outdated bundle is updated (worker files only, .env kept); a current one is left alone', () => {
        const io = memIo({ ...bundleFiles('2.2.0'), '/w/worker.cjs': '// worker 2.1.1', '/w/package.json': '{"version":"2.1.1"}', '/w/.env.example': 'x', '/w/.env': 'ANIMASTOR_WORKER_TOKEN=wrk.a.b\n' });
        const r = workerMod.installWorkerBundle(io, { workerDir: '/w', manifest: ttsManifest(), repoRoot: '/repo' });
        assert.strictEqual(r.updated_from, '2.1.1');
        assert.strictEqual(io.fs.readFileSync('/w/worker.cjs', 'utf8'), '// worker 2.2.0');
        assert.strictEqual(io.fs.readFileSync('/w/.env', 'utf8'), 'ANIMASTOR_WORKER_TOKEN=wrk.a.b\n');
        const again = workerMod.installWorkerBundle(io, { workerDir: '/w', manifest: ttsManifest(), repoRoot: '/repo' });
        assert.strictEqual(again.updated_from, undefined);
        assert.strictEqual(again.files_installed.length, 0);
        const plan = fixes.planFixes(memIo({ ...bundleFiles('2.2.0'), '/w/worker.cjs': '#', '/w/package.json': '{"version":"2.1.1"}' }), { workerDir: '/w', sourceBundleDir: SRC });
        assert.ok(plan.items.some((i) => i.title.startsWith('worker bundle 2.1.1 → 2.2.0')));
    });

    it('B4: scanWorkerLog judges only the LAST start and finds the readiness markers', () => {
        const log = [
            '[t] [info] Worker audio started', '[t] [info] ComfyUI ready', '[t] [info] Hub heartbeat accepted — worker is ONLINE',
            '[t] [info] Worker audio started', '[t] [warn] ComfyUI not ready (attempt 3): HTTP 404 from http://127.0.0.1:8188/nb/system_stats',
        ].join('\n');
        const s = workerMod.scanWorkerLog(log);
        assert.strictEqual(s.comfy_ready, false, 'an older start never counts');
        assert.strictEqual(s.heartbeat, false);
        assert.strictEqual(s.last_comfy_error, 'ComfyUI not ready (attempt 3): HTTP 404 from http://127.0.0.1:8188/nb/system_stats');
        const lost = workerMod.scanWorkerLog('[t] [info] Worker audio started\n[t] [info] ComfyUI ready\n[t] [info] Hub heartbeat accepted — worker is ONLINE\n[t] [error] Beacon failed\nHub rejected beacon: HTTP 502');
        assert.strictEqual(lost.heartbeat, false, 'a heartbeat followed by beacon failures is not ONLINE');
        assert.strictEqual(lost.last_beacon_error, 'Hub rejected beacon: HTTP 502');
    });

    const aliveExec = (cmd) => (cmd === 'ps' ? { code: 0, stdout: 'node worker.cjs' } : null);

    it('B5: waitForWorkerReady — ready after "ComfyUI ready" + heartbeat; timeout names the cause and the log', async () => {
        const io = memIo({ '/b/logs/worker.log': 'old\n[t] [info] Worker audio started\n[t] [info] ComfyUI ready\n[t] [info] Hub heartbeat accepted — worker is ONLINE\n' }, { exec: aliveExec });
        const ok = await workerMod.waitForWorkerReady(io, { workerDir: '/b/worker', pid: 1, logOffset: 4, pollMs: 5, platformAdapter: LINUX });
        assert.deepStrictEqual([ok.comfy_ready, ok.heartbeat, ok.reason], [true, true, null]);
        const stuck = memIo({ '/b/logs/worker.log': '[t] [info] Worker audio started\n[t] [warn] ComfyUI not ready (attempt 1): fetch failed\n' }, { exec: aliveExec });
        const r = await workerMod.waitForWorkerReady(stuck, { workerDir: '/b/worker', pid: 1, comfyTimeoutMs: 30, pollMs: 5, platformAdapter: LINUX });
        assert.strictEqual(r.comfy_ready, false);
        assert.ok(r.reason.includes('did not log "ComfyUI ready"') && r.reason.includes('fetch failed') && r.reason.includes('/b/logs/worker.log'), r.reason);
    });

    it('B6: waitForWorkerReady stops at once on a rejected key or a dead process', async () => {
        const auth = memIo({ '/b/logs/worker.log': '[t] [info] Worker audio started\n[t] [error] Worker authentication failed — check ANIMASTOR_WORKER_TOKEN\n' }, { exec: aliveExec });
        const a = await workerMod.waitForWorkerReady(auth, { workerDir: '/b/worker', pid: 1, pollMs: 5, platformAdapter: LINUX });
        assert.strictEqual(a.auth_failed, true);
        const dead = memIo({ '/b/logs/worker.log': '[t] [info] Worker audio started\n' }, { exec: (cmd) => (cmd === 'ps' ? { code: 1, stdout: '' } : null) });
        const d = await workerMod.waitForWorkerReady(dead, { workerDir: '/b/worker', pid: 1, pollMs: 5, platformAdapter: LINUX });
        assert.strictEqual(d.exited, true);
    });

    it('B7: startWorker runs NODE_BIN from .env, logs to <base>/logs/worker.log and strips worker keys from the spawn env', () => {
        const io = memIo({ '/b/worker/worker.cjs': '#', '/b/worker/.env': 'NODE_BIN=/opt/n22/bin/node\n', '/opt/n22/bin/node': '#' }, {
            exec: (cmd, args) => {
                if (cmd === '/opt/n22/bin/node' && args[0] === '--version') return { code: 0, stdout: 'v22.1.0' };
                if (cmd === 'ps') return { code: 0, stdout: '/opt/n22/bin/node worker.cjs' };
                if (cmd === 'pgrep') return { code: 1, stdout: '' };
                return null;
            },
        });
        const prev = process.env.WORKER_TYPE;
        process.env.WORKER_TYPE = 'image';
        try {
            const r = workerMod.startWorker(io, { workerDir: '/b/worker', sleep: 'true', platformAdapter: LINUX });
            assert.strictEqual(r.alive, true, JSON.stringify(r));
            const sp = io.calls.spawn[0];
            assert.strictEqual(sp.command, '/opt/n22/bin/node');
            assert.strictEqual(sp.opts.logFile, '/b/logs/worker.log');
            assert.strictEqual(sp.opts.env.WORKER_TYPE, undefined, 'a stray exported WORKER_TYPE never overrides .env');
        } finally {
            if (prev === undefined) delete process.env.WORKER_TYPE; else process.env.WORKER_TYPE = prev;
        }
    });
});

// ---------------------------------------------------------------------------
// End-to-end checks and the final summary
// ---------------------------------------------------------------------------

describe('UX: end-to-end checks and the final summary', () => {
    const statsOk = async () => ({ status: 200, json: { system: {} } });

    it('E1: all ✓ → "Done — return to the Animastor page", no "scroll up"', async () => {
        const io = memIo({}, { http: statsOk });
        const checks = await engine.endToEndChecks(io, {
            mode: 'existing', comfyUrl: 'http://127.0.0.1:8188', comfyPort: 8188, hubUrl: 'https://animastor.org/gpu',
            workerWanted: true, workerReady: { comfy_ready: true, heartbeat: true },
        });
        assert.deepStrictEqual(checks.map((c) => c.ok), [true, true, true]);
        const s = summary.renderFinalSummary({ verification: { checks: [] }, e2e: checks });
        assert.strictEqual(s.ok, true);
        assert.ok(s.text.includes('Done — return to the Animastor page'));
        assert.ok(!/scroll up/i.test(s.text));
    });

    it('E2: every ✗ has one cause line and one exact fix command', async () => {
        const io = memIo({});
        const checks = await engine.endToEndChecks(io, {
            mode: 'existing', comfyUrl: null, comfyPort: 8188, hubUrl: 'https://animastor.org/gpu',
            workerWanted: true, workerReady: { comfy_ready: false, reason: 'worker did not log "ComfyUI ready" within 90 s — see /b/logs/worker.log' },
            tool: 'animastor',
        });
        const s = summary.renderFinalSummary({
            verification: { checks: [{ verdict: false, label: 'Models', detail: 'Qwen/...: missing' }, { verdict: false, label: 'ComfyUI API', detail: null }] },
            e2e: checks, tool: 'animastor', mode: 'existing',
        });
        assert.strictEqual(s.ok, false);
        const lines = s.text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('✗')) assert.ok(lines[i + 1].startsWith('    fix: '), `fix line after: ${lines[i]}`);
        }
        assert.ok(s.text.includes('✗ Models: Qwen/...: missing\n    fix: animastor doctor'));
        assert.ok(s.text.includes('fix: start your ComfyUI on port 8188, then run: animastor doctor'));
        assert.strictEqual(lines.filter((l) => l.startsWith('✗ ComfyUI API')).length, 1, 'ComfyUI API reported once (e2e covers it)');
        assert.ok(!/scroll up/i.test(s.text));
    });

    it('E3: a rejected Worker Key points at doctor --new-key', async () => {
        const io = memIo({}, { http: statsOk });
        const checks = await engine.endToEndChecks(io, {
            mode: 'managed', comfyUrl: 'http://127.0.0.1:8188', comfyPort: 8188, hubUrl: 'https://h/gpu',
            workerWanted: true, workerReady: { comfy_ready: false, auth_failed: true, reason: 'the Worker Key was rejected' }, tool: '/home/u/animastor/tools/animastor',
        });
        assert.ok(checks[1].fix.endsWith('/home/u/animastor/tools/animastor doctor --new-key'), checks[1].fix);
    });
});

// ---------------------------------------------------------------------------
// Prompts (/dev/tty)
// ---------------------------------------------------------------------------

describe('UX: prompts via /dev/tty', () => {
    it('T1: hidden input handles a pasted chunk ending with CR, backspace and Ctrl+C', () => {
        assert.deepStrictEqual(tty.applySecretChunk({ value: '', done: false, cancelled: false }, 'wrk.abc.def\r'), { value: 'wrk.abc.def', done: true, cancelled: false });
        assert.strictEqual(tty.applySecretChunk({ value: 'ab', done: false, cancelled: false }, 'c\u007F\u007Fx').value, 'ax');
        assert.strictEqual(tty.applySecretChunk({ value: 'ab', done: false, cancelled: false }, '\u0003').cancelled, true);
    });

    it('T1b: line editor — CRLF counts once, type-ahead is kept for the next question, escape sequences ignored', () => {
        const st = { value: '', done: false, rest: '' };
        tty.feedLine(st, 'y\r\nn\r');
        assert.deepStrictEqual([st.value, st.done, st.rest], ['y', true, '\nn\r']);
        const next = { value: '', done: false, rest: '', skipLf: true };
        tty.feedLine(next, st.rest);
        assert.deepStrictEqual([next.value, next.done], ['n', true], 'the LF of CRLF is not an empty answer');
        const arrows = { value: '', done: false, rest: '' };
        tty.feedLine(arrows, '\u001b[Ay\n');
        assert.strictEqual(arrows.value, 'y');
        const hidden = { value: '', done: false, rest: '' };
        assert.strictEqual(tty.feedLine(hidden, 'secret', { hidden: true }), '', 'hidden input is never echoed');
    });

    it('T2: yes/no parsing with defaults (Enter = default)', () => {
        assert.strictEqual(tty.parseYesNo('', true), true);
        assert.strictEqual(tty.parseYesNo('', false), false);
        assert.strictEqual(tty.parseYesNo('Yes'), true);
        assert.strictEqual(tty.parseYesNo('n', true), false);
        assert.strictEqual(tty.parseYesNo('да'), true);
        assert.strictEqual(tty.parseYesNo('maybe'), null);
    });

    it('T3: no terminal → every question throws a clear NoTerminalError (never reads the piped script)', async () => {
        assert.strictEqual(tty.openTerminal({ stdin: { isTTY: false }, devTty: path.join(os.tmpdir(), 'no-such-tty-device') }), null);
        const p = tty.createPrompt(null);
        assert.strictEqual(p.available, false);
        await assert.rejects(() => p.confirm('Fix?'), (err) => err instanceof tty.NoTerminalError && /No interactive terminal/.test(err.message));
        await assert.rejects(() => p.secret('Key'), tty.NoTerminalError);
    });

    it('T4: stdin TTY is used as-is (no /dev/tty open)', () => {
        const stdin = { isTTY: true };
        const t = tty.openTerminal({ stdin, stdout: { isTTY: true }, fsMod: { openSync: () => { throw new Error('must not open /dev/tty'); } } });
        assert.strictEqual(t.input, stdin);
        assert.strictEqual(t.owned, false);
    });
});

// ---------------------------------------------------------------------------
// `animastor` command + persistent installer copy
// ---------------------------------------------------------------------------

describe('UX: the animastor command', () => {
    it('A1: renders start|stop|status|logs|doctor dispatch with the recorded paths', () => {
        const sh = management.renderAnimastorCommand({ nodePath: '/n', cliPath: '/b/installer/src/installer/cli.js', statePath: '/s.json', root: '/c', workerDir: '/b/worker', hubUrl: 'https://h/gpu' });
        assert.ok(sh.startsWith('#!/bin/sh'));
        assert.ok(sh.includes(`exec '/n' '/b/installer/src/installer/cli.js' "$cmd" \\`), sh);
        assert.ok(sh.includes(`--hub-url 'https://h/gpu' "$@"`));
        assert.ok(sh.includes('cmd="${1:-status}"'));
    });

    it('A2: link dir — always ~/.local/bin (root included: only /home survives a node restart)', () => {
        assert.strictEqual(management.defaultLinkDir({ uid: 0, home: '/root' }), '/root/.local/bin');
        assert.strictEqual(management.defaultLinkDir({ uid: 1000, home: '/home/u' }), '/home/u/.local/bin');
    });

    it('A3: real fs — installer copied to a persistent dir, command linked, re-run idempotent, foreign file untouched', () => {
        const tmp = fsReal.mkdtempSync(path.join(os.tmpdir(), 'animastor-tools-'));
        try {
            const src = path.join(tmp, 'bundle', 'animastor-installer');
            fsReal.mkdirSync(path.join(src, 'src', 'installer'), { recursive: true });
            fsReal.writeFileSync(path.join(src, 'src', 'installer', 'cli.js'), '// cli');
            fsReal.mkdirSync(path.join(src, 'ai', 'install-manifests', 'audio'), { recursive: true });
            fsReal.writeFileSync(path.join(src, 'ai', 'install-manifests', 'audio', 'qwen-tts.json'), '{}');
            const io = createRealIo();
            const args = {
                toolsDir: path.join(tmp, 'animastor', 'tools'), nodePath: process.execPath, cliPath: '/tmp/x/cli.js',
                installerSrcRoot: src, installerDestRoot: path.join(tmp, 'animastor', 'installer'),
                linkDir: path.join(tmp, 'bin'), statePath: '/s.json', root: '/c', workerDir: path.join(tmp, 'animastor', 'worker'),
                hubUrl: 'https://h/gpu', platformAdapter: LINUX,
            };
            const r1 = management.installManagementTools(io, args);
            const persisted = path.join(tmp, 'animastor', 'installer', 'src', 'installer', 'cli.js');
            assert.ok(fsReal.existsSync(persisted));
            assert.ok(fsReal.existsSync(path.join(tmp, 'animastor', 'installer', 'ai', 'install-manifests', 'audio', 'qwen-tts.json')));
            assert.ok(fsReal.readFileSync(path.join(tmp, 'animastor', 'tools', 'animastor'), 'utf8').includes(persisted), 'tools point at the persistent copy, not the temp bundle');
            assert.strictEqual(fsReal.readlinkSync(r1.link), path.join(tmp, 'animastor', 'tools', 'animastor'));
            assert.ok(r1.path_hint && r1.path_hint.includes('not in PATH'));
            const r2 = management.installManagementTools(io, args);
            assert.strictEqual(r2.link, r1.link, 'idempotent re-run');
            fsReal.unlinkSync(r1.link);
            fsReal.writeFileSync(r1.link, '#!/bin/sh\necho mine\n');
            const r3 = management.installManagementTools(io, args);
            assert.strictEqual(r3.link, null);
            assert.strictEqual(fsReal.readFileSync(r1.link, 'utf8'), '#!/bin/sh\necho mine\n', 'a foreign file is never overwritten');
        } finally {
            fsReal.rmSync(tmp, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

describe('UX: banner', () => {
    it('S1: ASCII banner with installer / worker bundle / profile / hub versions', () => {
        const b = summary.renderBanner({ installer: '0.2.0', worker: '2.2.0', profile: 'audio/qwen-tts', profileRevision: '2026.10.30-r1', hub: '0.1.0', bootstrap: '1.2.0' });
        assert.ok(b.includes('/_/   \\_\\_| \\_|___|'), b);
        assert.ok(b.includes('GPU worker installer 0.2.0'));
        assert.ok(b.includes('worker bundle 2.2.0 · profile audio/qwen-tts (2026.10.30-r1)'));
        assert.ok(b.includes('hub 0.1.0 · bootstrap 1.2.0'));
        assert.ok(summary.renderBanner({}).includes('hub unknown'));
    });
});

// ---------------------------------------------------------------------------
// Engine: "start worker" is done only after real readiness
// ---------------------------------------------------------------------------

describe('UX: engine — worker start judged by the worker log', () => {
    const { createLogger } = require('../src/installer/engine/logger');

    function engineIo(logLinesOnSpawn) {
        const files = {
            '/c/main.py': '#',
            '/repo/packages/animastor-worker/worker/worker.cjs': '// worker',
            '/repo/packages/animastor-worker/worker/package.json': '{"name":"animastor-worker","version":"2.2.0"}',
            '/repo/packages/animastor-worker/worker/.env.example': 'HUB_URL=\n',
        };
        const io = memIo(files, {
            exec: (cmd, args) => {
                if (cmd === 'nvidia-smi' || cmd === 'rocm-smi' || cmd === 'pgrep') return { code: 1, stdout: '' };
                if (cmd === 'ps') return { code: 0, stdout: 'node worker.cjs' };
                if (/python/.test(cmd) && args[0] === '--version') return { code: 0, stdout: 'Python 3.10.12' };
                if (/python/.test(cmd) && args[0] === '-c') return { code: 0, stdout: '2.4.0+cu121' };
                return null;
            },
            http: async (url) => {
                if (url.endsWith('/worker/verify')) return { status: 200, json: { verified: true, worker_id: 'w1', worker_type: 'audio', mode: 'private' } };
                if (url.endsWith('/system_stats')) return { status: 200, json: { system: {}, devices: [] } };
                return { status: 404, json: null };
            },
        });
        io.spawnDaemon = (command, args, opts) => {
            io.calls.spawn.push({ command, args, opts });
            if (args[0] === 'worker.cjs') io.fs.appendFileSync(opts.logFile, logLinesOnSpawn.join('\n') + '\n');
            return 4242;
        };
        return io;
    }

    async function run(io) {
        const logger = createLogger({ io, quiet: true });
        const manifest = { ...ttsManifest(), dependencies: [] };
        const result = await engine.runInstallation({
            manifests: [manifest], mode: 'existing', io,
            roots: { comfyuiRoot: '/c', workerDir: '/b/worker', statePath: '/c/.animastor-installer/install-state.json', repoRoot: '/repo', hubUrl: 'https://h/gpu' },
            decisions: { worker_setup: true, worker_key_provided: true, workflows: 'none', comfyui_update: 'no' },
            secretProvider: async () => 'wrk.w1.secret',
            logger, crypto: require('crypto'),
            options: {
                interruptGuard: false, currentUid: 1000, home: '/b', nodeBinary: { bin: '/n22', version: '22.0.0' },
                workerGraceMs: 1, workerReadyTimeoutMs: 60, heartbeatTimeoutMs: 60, pollIntervalMs: 5,
                comfyPort: 8188, sleepCommand: 'true',
            },
            platformAdapter: { ...LINUX, sleepCommand: () => ({ cmd: 'true', args: [] }) },
        });
        return { result, lines: logger.lines };
    }

    it('G1: worker logs "ComfyUI ready" + heartbeat → step done, e2e all ✓, .env wired from the profile', async () => {
        const io = engineIo(['[t] [info] Worker audio started', '[t] [info] ComfyUI ready', '[t] [info] Hub heartbeat accepted — worker is ONLINE']);
        const { result, lines } = await run(io);
        assert.ok(lines.some((l) => /start worker — done/.test(l)), lines.join('\n'));
        assert.deepStrictEqual(result.e2e.map((c) => [c.id, c.ok]), [['comfyui', true], ['worker', true], ['heartbeat', true]]);
        const env = io.fs.readFileSync('/b/worker/.env', 'utf8');
        assert.ok(env.includes('WORKER_TYPE=audio') && env.includes('NODE_BIN=/n22') && env.includes('COMFY_URL=http://127.0.0.1:8188'), env);
        assert.strictEqual(io.calls.spawn.find((s) => s.args[0] === 'worker.cjs').command, '/n22');
        // (the mock host has no real Python runtime, so the Runtime line may
        // fail — the worker-related verification lines must all pass)
        const workerChecks = result.verification.checks.filter((c) => /Worker|Hub/.test(c.label));
        assert.ok(workerChecks.length > 0 && workerChecks.every((c) => c.verdict === true), JSON.stringify(workerChecks));
        assert.ok(!lines.join('\n').includes('wrk.w1.secret'), 'the key never reaches the log');
    });

    it('G2: worker never reaches ComfyUI → "start worker — FAILED" with the cause; e2e ✗ with a fix; status failed', async () => {
        const io = engineIo(['[t] [info] Worker audio started', '[t] [warn] ComfyUI not ready (attempt 1): HTTP 404 from http://127.0.0.1:8188/nb/system_stats']);
        const { result, lines } = await run(io);
        assert.ok(lines.some((l) => /start worker — FAILED .*did not log "ComfyUI ready".*HTTP 404/.test(l)), lines.join('\n'));
        assert.ok(!lines.some((l) => /start worker — done/.test(l)));
        const w = result.e2e.find((c) => c.id === 'worker');
        assert.strictEqual(w.ok, false);
        assert.strictEqual(w.fix, 'animastor doctor');
        assert.strictEqual(result.status, 'failed', JSON.stringify(result.blocked));
        assert.deepStrictEqual(result.blocked, []);
    });
});
