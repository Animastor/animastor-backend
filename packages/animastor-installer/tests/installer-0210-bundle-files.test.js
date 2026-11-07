'use strict';
// ============================================================
// installer 0.2.10 — the worker bundle is deployed WHOLE
// ============================================================
// Live 07.11: worker 2.4.1 died with «Cannot find module './worker-logs.cjs'»
// after an update by installer 0.2.9 — installWorkerBundle copied only
// manifest.worker_bundle.files, and worker-logs.cjs (new in bundle 2.4.1,
// present in the hub bundle) was not in any manifest. Pinned here:
//   - update 2.3.0 → 2.4.1 from a hub bundle with a file NOT in the manifest
//     deploys that file; a repeated run is idempotent;
//   - files of the previous version the new bundle no longer ships are removed
//     (only those recorded in install-state, never .env / node-classes.json);
//   - the manifest list is a minimal presence check;
//   - before start: every local require('./…') of worker.cjs must exist,
//     otherwise FAILED naming the file, the worker is not spawned;
//   - the three manifests and WORKER_CONFIG_FILES list worker-logs.cjs;
//   - the image profile has a minimum VRAM.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createMemoryFs } = require('../src/installer/engine/io');
const workerMod = require('../src/installer/engine/worker');
const engine = require('../src/installer/engine/engine');
const LINUX = require('../src/installer/platform/linux');

function memIo(files = {}) {
    const mfs = createMemoryFs(files);
    const calls = { exec: [], spawn: [] };
    return {
        fs: mfs, calls,
        exec(cmd, args = [], opts = {}) { calls.exec.push({ cmd, args, opts }); return { code: 0, stdout: '', stderr: '' }; },
        spawnDaemon(command, args, opts) { calls.spawn.push({ command, args, opts }); return 4242; },
        http: { async fetchJson() { throw new Error('ECONNREFUSED'); } },
        now: () => Date.now(),
    };
}

// The manifest as shipped by 0.2.9 (no worker-logs.cjs) — the hub bundle has more.
const MANIFEST_029_FILES = ['worker.cjs', 'worker-env.cjs', 'worker-cleanup.cjs', 'worker-cleanup-journal.cjs',
    'job-protocol-v2.cjs', 'package.json', 'package-lock.json', '.env.example'];
const manifest = (files = MANIFEST_029_FILES) => ({ profile: { id: 'audio/qwen-tts' }, worker_bundle: { worker_type: 'audio', files } });

const WORKER_241 = [
    'const { cleanupJobArtifacts } = require("./worker-cleanup.cjs");',
    'const journal = require("./worker-cleanup-journal.cjs");',
    'const { loadDotEnv } = require("./worker-env.cjs");',
    'const { PROTOCOL_VERSION } = require("./job-protocol-v2.cjs");',
    'const { createLogBuffer } = require("./worker-logs.cjs");',
    'try { require("./package.json").version } catch (_) {}',
].join('\n');

const HUB = '/tmp/hub-bundle/animastor-worker';
function hubBundle241() {
    return {
        [`${HUB}/worker.cjs`]: WORKER_241,
        [`${HUB}/worker-env.cjs`]: 'module.exports = {}',
        [`${HUB}/worker-cleanup.cjs`]: 'module.exports = {}',
        [`${HUB}/worker-cleanup-journal.cjs`]: 'const { cleanupJobArtifacts } = require("./worker-cleanup.cjs");',
        [`${HUB}/job-protocol-v2.cjs`]: 'module.exports = {}',
        [`${HUB}/worker-logs.cjs`]: 'module.exports = { createLogBuffer() {} }',
        [`${HUB}/package.json`]: JSON.stringify({ name: 'animastor-worker', version: '2.4.1' }),
        [`${HUB}/package-lock.json`]: '{}',
        [`${HUB}/.env.example`]: 'HUB_URL=\n',
        [`${HUB}/.env`]: 'ANIMASTOR_WORKER_TOKEN=never-copied\n',
    };
}
const W = '/home/u/animastor/worker';
function installed230() {
    return {
        [`${W}/worker.cjs`]: '// worker 2.3.0\nrequire("./worker-env.cjs"); require("./old-helper.cjs");',
        [`${W}/worker-env.cjs`]: 'old', [`${W}/worker-cleanup.cjs`]: 'old', [`${W}/worker-cleanup-journal.cjs`]: 'old',
        [`${W}/job-protocol-v2.cjs`]: 'old', [`${W}/old-helper.cjs`]: 'dropped in 2.4.x',
        [`${W}/package.json`]: JSON.stringify({ name: 'animastor-worker', version: '2.3.0' }),
        [`${W}/package-lock.json`]: '{}', [`${W}/.env.example`]: 'x',
        [`${W}/.env`]: 'ANIMASTOR_WORKER_TOKEN=wrk.keep.me\n',
        [`${W}/node-classes.json`]: '{}',
        [`${W}/user-notes.txt`]: 'not ours',
    };
}

describe('installer 0.2.10 — whole worker bundle, stale files, start guard', () => {
    it('update 2.3.0 → 2.4.1 from the hub bundle deploys worker-logs.cjs (not in the manifest); .env kept', () => {
        const io = memIo({ ...installed230(), ...hubBundle241() });
        const r = workerMod.installWorkerBundle(io, { workerDir: W, manifest: manifest(), bundleDir: HUB, update: true });
        assert.strictEqual(r.status, 'installed');
        assert.strictEqual(r.updated_from, '2.3.0');
        assert.strictEqual(r.version, '2.4.1');
        assert.ok(r.files_installed.includes('worker-logs.cjs'), r.files_installed.join(','));
        assert.ok(io.fs.existsSync(`${W}/worker-logs.cjs`));
        assert.strictEqual(io.fs.readFileSync(`${W}/.env`, 'utf8'), 'ANIMASTOR_WORKER_TOKEN=wrk.keep.me\n', '.env untouched');
        assert.ok(!r.bundle_files.includes('.env'), 'the hub .env is never part of the bundle');
        assert.ok(r.bundle_files.includes('worker-logs.cjs') && r.bundle_files.includes('.env.example'));
        assert.deepStrictEqual(workerMod.checkWorkerCanStart(io, { workerDir: W, nodeBin: '/n' }), { ok: true });
    });

    it('stale files of the previous version are removed — only installer-recorded ones', () => {
        const io = memIo({ ...installed230(), ...hubBundle241() });
        const prev = [...MANIFEST_029_FILES, 'old-helper.cjs', '.env', 'node-classes.json'];
        const r = workerMod.installWorkerBundle(io, { workerDir: W, manifest: manifest(), bundleDir: HUB, update: true, previousBundleFiles: prev });
        assert.deepStrictEqual(r.files_removed, ['old-helper.cjs']);
        assert.ok(!io.fs.existsSync(`${W}/old-helper.cjs`));
        assert.ok(io.fs.existsSync(`${W}/.env`) && io.fs.existsSync(`${W}/node-classes.json`), 'protected files stay');
        assert.ok(io.fs.existsSync(`${W}/user-notes.txt`), 'a file the installer never recorded stays');
        // no record (pre-0.2.10 state without files_installed) → nothing is removed
        const io2 = memIo({ ...installed230(), ...hubBundle241() });
        const r2 = workerMod.installWorkerBundle(io2, { workerDir: W, manifest: manifest(), bundleDir: HUB, update: true });
        assert.deepStrictEqual(r2.files_removed, []);
        assert.ok(io2.fs.existsSync(`${W}/old-helper.cjs`));
    });

    it('a repeated run is idempotent: nothing copied, nothing removed, same bundle_files', () => {
        const io = memIo({ ...installed230(), ...hubBundle241() });
        const first = workerMod.installWorkerBundle(io, { workerDir: W, manifest: manifest(), bundleDir: HUB, update: true, previousBundleFiles: [...MANIFEST_029_FILES, 'old-helper.cjs'] });
        const again = workerMod.installWorkerBundle(io, { workerDir: W, manifest: manifest(), bundleDir: HUB, update: true, previousBundleFiles: first.bundle_files });
        assert.strictEqual(again.updated_from, undefined);
        assert.deepStrictEqual(again.files_installed, []);
        assert.deepStrictEqual(again.files_removed, []);
        assert.deepStrictEqual(again.bundle_files, first.bundle_files);
    });

    it('the installer package copy (<installer>/worker/worker, as the hub packs it) is deployed whole too', () => {
        const REPO = '/opt/animastor-installer';
        const files = {};
        for (const [k, v] of Object.entries(hubBundle241())) files[k.replace(HUB, `${REPO}/worker/worker`)] = v;
        const io = memIo({ ...installed230(), ...files });
        const r = workerMod.installWorkerBundle(io, { workerDir: W, manifest: manifest(), repoRoot: REPO, update: true });
        assert.strictEqual(r.status, 'installed');
        assert.ok(io.fs.existsSync(`${W}/worker-logs.cjs`));
    });

    it('the manifest list is the minimal presence check: a listed file absent everywhere → failed', () => {
        const io = memIo({ ...hubBundle241() });
        const r = workerMod.installWorkerBundle(io, { workerDir: '/fresh', manifest: manifest([...MANIFEST_029_FILES, 'must-exist.cjs']), bundleDir: HUB });
        assert.strictEqual(r.status, 'failed');
        assert.match(r.reason, /must-exist\.cjs/);
    });

    it('start guard: a missing local require → FAILED naming the file, the worker is never spawned', () => {
        const files = { ...hubBundle241() };
        delete files[`${HUB}/worker-logs.cjs`];
        const moved = {};
        for (const [k, v] of Object.entries(files)) moved[k.replace(HUB, W)] = v;
        const io = memIo(moved);
        const can = workerMod.checkWorkerCanStart(io, { workerDir: W, nodeBin: '/n' });
        assert.strictEqual(can.ok, false);
        assert.deepStrictEqual(can.missing, ['./worker-logs.cjs']);
        assert.match(can.reason, /worker-logs\.cjs/);
        assert.ok(!io.calls.exec.some((c) => c.args.includes('--check')), 'no node --check / spawn before the files are there');
        const st = workerMod.startWorker(io, { workerDir: W, nodeBin: '/n', platformAdapter: LINUX, graceMs: 0, sleep: () => {} });
        assert.strictEqual(st.started, false);
        assert.match(st.reason, /worker-logs\.cjs/);
        assert.strictEqual(io.calls.spawn.length, 0);
    });

    it('transitive local requires are followed (worker-cleanup-journal → worker-cleanup)', () => {
        const moved = {};
        for (const [k, v] of Object.entries(hubBundle241())) if (!k.endsWith('/worker-cleanup.cjs')) moved[k.replace(HUB, W)] = v;
        const io = memIo(moved);
        assert.deepStrictEqual(workerMod.missingLocalRequires(io, W), ['./worker-cleanup.cjs']);
    });

    it('install-state: previousBundleFilesOf — bundle_files, else files_installed (without node-classes.json), only for THIS dir', () => {
        assert.deepStrictEqual(engine.previousBundleFilesOf({ dir: W, bundle_files: ['a', 'b'], files_installed: ['x'] }, W), ['a', 'b']);
        assert.deepStrictEqual(engine.previousBundleFilesOf({ dir: W, files_installed: ['worker.cjs', 'node-classes.json'] }, W), ['worker.cjs']);
        assert.strictEqual(engine.previousBundleFilesOf({ dir: '/other', bundle_files: ['a'] }, W), null);
        assert.strictEqual(engine.previousBundleFilesOf(null, W), null);
    });

    it('manifests and WORKER_CONFIG_FILES list worker-logs.cjs; the image profile has a minimum VRAM', () => {
        assert.ok(workerMod.WORKER_CONFIG_FILES.includes('worker-logs.cjs'));
        const dir = path.join(__dirname, '..', 'ai', 'install-manifests');
        for (const [t, f] of [['audio', 'qwen-tts'], ['image', 'qwen-image'], ['video', 'ltx-2.3']]) {
            const m = JSON.parse(fs.readFileSync(path.join(dir, t, `${f}.json`), 'utf8'));
            assert.ok(m.worker_bundle.files.includes('worker-logs.cjs'), `${t}: worker-logs.cjs`);
        }
        const img = JSON.parse(fs.readFileSync(path.join(dir, 'image', 'qwen-image.json'), 'utf8'));
        assert.strictEqual(typeof img.hardware.gpu_min_vram_gb, 'number');
        assert.ok(img.hardware.gpu_min_vram_gb > 0 && img.hardware.gpu_min_vram_gb <= 16, '16 GB cards must pass');
    });

    it('the real worker bundle (animastor-worker checkout, when present) passes the start guard with the new manifest list', function () {
        const real = '/home/animastor/src/animastor-worker/packages/animastor-worker/worker';
        if (!fs.existsSync(real)) this.skip();
        const io = { fs: { existsSync: fs.existsSync, readFileSync: fs.readFileSync, statSync: (p) => { const s = fs.statSync(p); return { isFile: s.isFile(), isDirectory: s.isDirectory() }; } } };
        assert.deepStrictEqual(workerMod.missingLocalRequires(io, real), []);
        const listed = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ai', 'install-manifests', 'audio', 'qwen-tts.json'), 'utf8')).worker_bundle.files);
        for (const f of fs.readdirSync(real)) assert.ok(listed.has(f), `bundle file ${f} is listed in the manifest`);
    });
});
