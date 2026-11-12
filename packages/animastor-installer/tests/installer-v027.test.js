// =====================================================
// Installer 0.2.7 — node-classes.json for the worker readiness gate
// =====================================================
// GPU E2E 2026-11-02: worker 2.2.0 took tasks from a ComfyUI without the
// qwen-tts nodes. Bundle 2.2.2 takes tasks only when ComfyUI /object_info
// lists the profile's node classes from <workerDir>/node-classes.json (no
// file → old behaviour + one warn). The installer writes that file:
//   N1  from the manifests' provides_classes (required dependencies only);
//   N2  idempotently (identical file untouched, changed profile rewritten,
//       no worker installed → nothing written);
//   N3  in the preflight of EVERY install/doctor/boot run — an already
//       installed node (TIR, installed by 0.2.6) gets it on its next
//       doctor/boot — and registers it for the uninstaller;
//   N4  after the bundle step of the engine (fresh install);
//   N5  never in --dry-run.
// Run: npx mocha --exit tests/installer-v027.test.js
// =====================================================

'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const realFs = require('fs');

const { createRealIo } = require('../src/installer/engine/io');
const worker = require('../src/installer/engine/worker');
const stateStore = require('../src/installer/engine/state');
const cli = require('../src/installer/cli');
const pkg = require('../package.json');

const TTS = require('../ai/install-manifests/audio/qwen-tts.json');
// VOICE_REFERENCES (2026-11-12): SaveAudioMP3 / LoadAudio are ComfyUI core nodes (not declared);
// + Qwen3TTSVoiceClone and SaveAudioAnimastorReference (animastor-voice-ref)
const TTS_CLASSES = ['Qwen3TTSAdvancedDialogue', 'Qwen3TTSLoader', 'Qwen3TTSRoleBank', 'Qwen3TTSScriptProcessor',
    'Qwen3TTSVoiceClone', 'Qwen3TTSVoiceClonePrompt', 'Qwen3TTSVoiceDesign', 'SaveAudioAnimastorReference'];

describe('0.2.7 N1 node classes come from the manifests', () => {
    it('N1a: audio/qwen-tts → its custom-node classes, sorted, unique', () => {
        assert.deepStrictEqual(worker.nodeClassesOfManifests([TTS]), { 'audio/qwen-tts': TTS_CLASSES });
    });

    it('N1b: optional dependencies do not block readiness; manifests without a profile id are ignored', () => {
        const m = {
            profile: { id: 'image/x' },
            dependencies: [
                { requirement: 'required', provides_classes: ['B', 'A', 'A'] },
                { requirement: 'optional', provides_classes: ['Opt'] },
                { provides_classes: ['NoRequirementField'] },
            ],
        };
        assert.deepStrictEqual(worker.nodeClassesOfManifests([m, { dependencies: [] }]), { 'image/x': ['A', 'B', 'NoRequirementField'] });
    });
});

describe('0.2.7 N2 writeNodeClasses', () => {
    let tmp;
    beforeEach(() => { tmp = realFs.mkdtempSync(path.join(os.tmpdir(), 'anim-v027-')); });
    afterEach(() => { realFs.rmSync(tmp, { recursive: true, force: true }); });

    it('N2a: no worker installed → nothing written', () => {
        const io = createRealIo();
        const r = worker.writeNodeClasses(io, { workerDir: path.join(tmp, 'worker'), manifests: [TTS] });
        assert.strictEqual(r.status, 'absent');
        assert.ok(!realFs.existsSync(path.join(tmp, 'worker', 'node-classes.json')));
    });

    it('N2b: written once, identical re-run is "current", a changed profile is rewritten', () => {
        const io = createRealIo();
        const dir = path.join(tmp, 'worker');
        realFs.mkdirSync(dir);
        realFs.writeFileSync(path.join(dir, 'worker.cjs'), '// 2.2.2');
        const r1 = worker.writeNodeClasses(io, { workerDir: dir, manifests: [TTS], version: '0.2.7' });
        assert.strictEqual(r1.status, 'written');
        const doc = JSON.parse(realFs.readFileSync(path.join(dir, 'node-classes.json'), 'utf8'));
        assert.deepStrictEqual(doc, { generated_by: 'animastor-installer 0.2.7', profiles: { 'audio/qwen-tts': TTS_CLASSES } });
        const mtime = realFs.statSync(path.join(dir, 'node-classes.json')).mtimeMs;
        assert.strictEqual(worker.writeNodeClasses(io, { workerDir: dir, manifests: [TTS] }).status, 'current');
        assert.strictEqual(realFs.statSync(path.join(dir, 'node-classes.json')).mtimeMs, mtime);
        const other = { profile: { id: 'audio/other' }, dependencies: [{ requirement: 'required', provides_classes: ['Z'] }] };
        assert.strictEqual(worker.writeNodeClasses(io, { workerDir: dir, manifests: [other] }).status, 'written');
        assert.deepStrictEqual(JSON.parse(realFs.readFileSync(path.join(dir, 'node-classes.json'), 'utf8')).profiles, { 'audio/other': ['Z'] });
        assert.deepStrictEqual(realFs.readdirSync(dir).filter((f) => f.includes('.tmp-')), [], 'no temp file left');
    });

    it('N2c: the file format is what bundle 2.2.2 reads ({profiles:{"<type>/<profile>":[...]}})', () => {
        const io = createRealIo();
        const dir = path.join(tmp, 'worker');
        realFs.mkdirSync(dir);
        realFs.writeFileSync(path.join(dir, 'worker.cjs'), '');
        worker.writeNodeClasses(io, { workerDir: dir, manifests: [TTS] });
        const doc = JSON.parse(realFs.readFileSync(path.join(dir, 'node-classes.json'), 'utf8'));
        for (const [profile, list] of Object.entries(doc.profiles)) {
            assert.match(profile, /^(audio|image|video)\//);
            assert.ok(Array.isArray(list) && list.every((c) => typeof c === 'string' && c.length > 0));
        }
    });
});

describe('0.2.7 N3 doctor/boot/update preflight writes node-classes.json on an installed node', () => {
    let tmp;
    beforeEach(() => { tmp = realFs.mkdtempSync(path.join(os.tmpdir(), 'anim-v027-pre-')); });
    afterEach(() => { realFs.rmSync(tmp, { recursive: true, force: true }); });

    function installedNode() {
        // a node installed by 0.2.6: bundle present, no node-classes.json
        const home = tmp;
        const base = path.join(home, 'animastor');
        const workerDir = path.join(base, 'worker');
        const toolsDir = path.join(base, 'tools');
        const root = path.join(home, 'ComfyUI');
        const statePath = path.join(root, '.animastor-installer', 'install-state.json');
        realFs.mkdirSync(workerDir, { recursive: true });
        realFs.writeFileSync(path.join(workerDir, 'worker.cjs'), '// 2.2.2');
        realFs.writeFileSync(path.join(workerDir, 'package.json'), JSON.stringify({ version: '2.2.2' }));
        realFs.writeFileSync(path.join(workerDir, '.env'), 'ANIMASTOR_WORKER_TOKEN=keep\n');
        realFs.mkdirSync(root, { recursive: true });
        const io = createRealIo();
        const st = stateStore.emptyState({ mode: 'existing', profiles: ['audio/qwen-tts'], root });
        st.components.worker = { owned: false, dir: workerDir, files_installed: ['worker.cjs', 'package.json'], files_kept: [] };
        stateStore.saveState(io, statePath, st, io.now);
        return { home, workerDir, toolsDir, root, statePath, linkDir: path.join(home, '.local', 'bin') };
    }

    it('N3a: the TIR case — the preflight writes the file and registers it for uninstall; .env untouched', async () => {
        const L = installedNode();
        const io = createRealIo();
        const pre = await cli.preflightSelfUpdate(io, {
            flags: { 'worker-dir': L.workerDir, 'tools-dir': L.toolsDir, 'no-tools': true }, statePath: L.statePath,
            root: L.root, workerDir: L.workerDir, hubUrl: null, repoRoot: null, manifests: [TTS], home: L.home, linkDir: L.linkDir,
        });
        assert.strictEqual(pre.node_classes.status, 'written');
        const doc = JSON.parse(realFs.readFileSync(path.join(L.workerDir, 'node-classes.json'), 'utf8'));
        assert.deepStrictEqual(doc.profiles, { 'audio/qwen-tts': TTS_CLASSES });
        assert.strictEqual(doc.generated_by, `animastor-installer ${pkg.version}`);
        const st = stateStore.loadState(io, L.statePath);
        assert.ok(st.components.worker.files_installed.includes('node-classes.json'), 'registered for the uninstaller');
        assert.strictEqual(realFs.readFileSync(path.join(L.workerDir, '.env'), 'utf8'), 'ANIMASTOR_WORKER_TOKEN=keep\n');
        // the next boot: nothing to change
        const again = await cli.preflightSelfUpdate(io, {
            flags: { 'worker-dir': L.workerDir, 'tools-dir': L.toolsDir, 'no-tools': true }, statePath: L.statePath,
            root: L.root, workerDir: L.workerDir, hubUrl: null, repoRoot: null, manifests: [TTS], home: L.home, linkDir: L.linkDir,
        });
        assert.strictEqual(again.node_classes.status, 'current');
        assert.deepStrictEqual(cli.preflightExtras(again), []);
    });

    it('N3b: no worker installed yet (fresh install before the bundle step) → absent, no file', async () => {
        const io = createRealIo();
        const workerDir = path.join(tmp, 'animastor', 'worker');
        const pre = await cli.preflightSelfUpdate(io, {
            flags: { 'worker-dir': workerDir, 'tools-dir': path.join(tmp, 'tools'), 'no-tools': true },
            statePath: path.join(tmp, 'state.json'), root: tmp, workerDir, hubUrl: null, repoRoot: null, manifests: [TTS],
        });
        assert.strictEqual(pre.node_classes.status, 'absent');
        assert.ok(!realFs.existsSync(path.join(workerDir, 'node-classes.json')));
    });

    it('N5: --dry-run writes nothing', async () => {
        const L = installedNode();
        const io = createRealIo();
        const pre = await cli.preflightSelfUpdate(io, {
            flags: { 'worker-dir': L.workerDir, 'tools-dir': L.toolsDir }, statePath: L.statePath, root: L.root,
            workerDir: L.workerDir, manifests: [TTS], dryRun: true,
        });
        assert.strictEqual(pre.tools_skipped, 'dry-run');
        assert.ok(!realFs.existsSync(path.join(L.workerDir, 'node-classes.json')));
    });
});

describe('0.2.7 N4 the engine writes node-classes.json after the bundle step', () => {
    it('N4a: in runInstallation the write follows the bundle install and precedes the .env step', () => {
        const src = realFs.readFileSync(path.join(__dirname, '..', 'src', 'installer', 'engine', 'engine.js'), 'utf8');
        const bundle = src.indexOf('install worker bundle (');
        const write = src.indexOf('worker.writeNodeClasses(io');
        const env = src.indexOf("log.step('configure worker .env'");
        assert.ok(bundle > 0 && write > bundle && env > write, `order bundle(${bundle}) < write(${write}) < env(${env})`);
    });

    it('N4b: preflightSelfUpdate (install, doctor and boot all run it) calls the writer', () => {
        const src = realFs.readFileSync(path.join(__dirname, '..', 'src', 'installer', 'cli.js'), 'utf8');
        const body = src.slice(src.indexOf('async function preflightSelfUpdate('), src.indexOf('function preflightExtras('));
        assert.ok(body.includes('engineMod.writeNodeClasses(io'), 'preflight writes node-classes.json');
    });
});
