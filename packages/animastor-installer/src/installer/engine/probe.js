'use strict';

/**
 * Environment probe — Private Worker Installer Phase 2.
 *
 * Detects the real installed state of a machine and produces the
 * environment object consumed by the compatibility resolver:
 *
 *   GPU / ComfyUI / Python / Torch / Node.js / custom nodes / models /
 *   workflows / worker bundle+.env
 *
 * Read-only: probing never mutates anything.
 *
 * .env handling is keys-only: the probe records WHICH keys are set, never
 * their values (Worker Key safety).
 */

const path = require('path');
const platforms = require('../platform');

const MODEL_DIRS = [
    'models/unet', 'models/clip', 'models/vae', 'models/loras',
    'models/text_encoders', 'models/checkpoints', 'models/upscale_models',
    'models/latent_upscale_models', 'models/TTS',
];

const WORKFLOW_SCAN_ROOT = 'user/default/workflows';

/**
 * Device kinds for env.device:
 *   cuda — NVIDIA GPU verified through the driver runtime (nvidia-smi query);
 *   cpu  — no supported GPU: CPU-only mode (ComfyUI --cpu, CPU PyTorch).
 * An AMD GPU is detected and reported, but the installer provides no ROCm
 * runtime branch yet — such machines fall back to cpu with an explicit note
 * (never a silent degradation).
 */
const DEVICE_KINDS = Object.freeze(['cuda', 'cpu']);

function firstLine(s) {
    return String(s || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
}

/**
 * NVIDIA GPU detection — runtime check, not just command presence:
 * nvidia-smi must succeed AND report at least one GPU row.
 */
function probeNvidiaGpu(io) {
    const r = io.exec('nvidia-smi', [
        '--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits',
    ]);
    if (r.code !== 0) return null;
    const line = firstLine(r.stdout);
    if (!line || /^\[?n?a$/i.test(line)) return null;
    const [name, mib, driver] = line.split(',').map((x) => x.trim());
    if (!name) return null;
    return {
        vendor: 'nvidia',
        name,
        vram_mib: mib ? Number(mib) : null,
        driver_version: driver || null,
    };
}

/**
 * AMD GPU detection with positive evidence only. The detection mechanism is
 * a platform concern (Linux: rocm-smi/drm sysfs/lspci; Windows: wmic) —
 * delegated to the platform adapter. Empty/unknown output is treated as
 * "not detected" — never guessed.
 */
function probeAmdGpu(io, platformAdapter = null) {
    return (platformAdapter || platforms.getPlatformAdapter()).probeAmdGpu(io);
}

function probeGpu(io) {
    const nvidia = probeNvidiaGpu(io);
    if (nvidia) return nvidia;
    const amd = probeAmdGpu(io);
    if (amd) return amd;
    return null;
}

function probeCuda(io) {
    const r = io.exec('nvidia-smi', []);
    if (r.code !== 0) return null;
    const m = /CUDA Version:\s*([0-9.]+)/.exec(r.stdout);
    return m ? m[1] : null;
}

function gitInfo(io, dir) {
    if (!io.fs.isDirectory(path.join(dir, '.git'))) return null;
    const remote = io.exec('git', ['-C', dir, 'remote', 'get-url', 'origin']);
    const head = io.exec('git', ['-C', dir, 'rev-parse', 'HEAD']);
    const tag = io.exec('git', ['-C', dir, 'describe', '--tags', '--exact-match']);
    return {
        repository: remote.code === 0 ? firstLine(remote.stdout) : null,
        commit: head.code === 0 ? firstLine(head.stdout) : null,
        tag: tag.code === 0 ? firstLine(tag.stdout) : null,
    };
}

function probeComfyui(io, root) {
    if (!root || !io.fs.isDirectory(root)) return null;
    const mainPy = io.fs.existsSync(path.join(root, 'main.py'));
    if (!mainPy) return null;
    const git = gitInfo(io, root);
    return {
        present: true,
        repository: git ? git.repository : null,
        commit: git ? git.commit : null,
        tag: git ? git.tag : null,
        version: git && git.tag ? git.tag.replace(/^v/, '') : null,
    };
}

function pythonBin(io, root, platformAdapter = null) {
    // prefer a venv next to ComfyUI, then python3 (venv layout is a
    // platform concern: bin/python on Linux, Scripts/python.exe on Windows)
    if (root) {
        const venvPy = (platformAdapter || platforms.getPlatformAdapter()).venvPythonBin(path.join(root, 'venv'));
        if (io.fs.existsSync(venvPy)) return venvPy;
    }
    return 'python3';
}

function probePython(io, root) {
    const py = pythonBin(io, root);
    const r = io.exec(py, ['--version']);
    if (r.code !== 0) return null;
    const m = /Python\s+([0-9][0-9.]*)/.exec(r.stdout + r.stderr);
    return m ? { version: m[1], binary: py } : null;
}

function probeTorch(io, root) {
    const py = pythonBin(io, root);
    const r = io.exec(py, ['-c', 'import torch; print(torch.__version__)']);
    if (r.code !== 0) return null;
    const v = firstLine(r.stdout);
    return v ? { version: v } : null;
}

function probeNodejs(io) {
    const r = io.exec('node', ['--version']);
    if (r.code !== 0) return null;
    const v = firstLine(r.stdout).replace(/^v/, '');
    return v ? { version: v } : null;
}

function nodeMajor(version) {
    const m = /^v?(\d+)/.exec(String(version || ''));
    return m ? Number(m[1]) : 0;
}

/**
 * The Node.js binary the worker must run with: the one running this
 * installer when it is >= 20 (the bootstrap verified or provisioned it),
 * otherwise the first `node`/`node22`/`node20` on PATH that is >= 20.
 * Written to .env as NODE_BIN so start-worker.sh, the `animastor` tool and
 * the installer start the SAME binary (no silent fallback to an old system
 * Node 18).
 * @returns {{ bin: string, version: string } | null}
 */
function pickNodeBinary(io, { execPath = process.execPath, execVersion = process.versions.node } = {}) {
    if (execPath && nodeMajor(execVersion) >= 20) return { bin: execPath, version: execVersion };
    for (const cand of ['node', 'node22', 'node20']) {
        const r = io.exec(cand, ['-p', 'process.execPath + " " + process.versions.node']);
        if (r.code !== 0) continue;
        const [bin, version] = firstLine(r.stdout).split(' ');
        if (bin && nodeMajor(version) >= 20) return { bin, version };
    }
    return null;
}

/** Version of a node binary (e.g. NODE_BIN from .env) or null. */
function nodeBinaryVersion(io, bin) {
    if (!bin) return null;
    const r = io.exec(bin, ['--version']);
    if (r.code !== 0) return null;
    return firstLine(r.stdout).replace(/^v/, '') || null;
}

/**
 * A ComfyUI process of the current user (python ... main.py): pid, cwd
 * (the ComfyUI root), --port and --baseurl from its command line. Used to
 * find the user's existing ComfyUI when it does not live in ~/ComfyUI and to
 * learn the port/prefix instead of guessing. Linux only (/proc); null
 * elsewhere or when none runs.
 */
function detectRunningComfyUI(io, { uid = (typeof process.getuid === 'function' ? process.getuid() : null) } = {}) {
    const all = listRunningComfyUI(io, { uid });
    if (all.length === 0) return null;
    const { pid, root, port, baseurl } = all[0];
    return { pid, root, port, baseurl };
}

/**
 * Every ComfyUI process of the account: pid, cwd (the ComfyUI root) and the
 * --listen / --port / --baseurl values from its own command line. Linux only
 * (/proc); [] elsewhere or when none runs. Order = pgrep order (newest
 * processes are not guaranteed first — callers must not rely on it).
 */
function listRunningComfyUI(io, { uid = (typeof process.getuid === 'function' ? process.getuid() : null) } = {}) {
    if (uid == null) return [];
    let r = null;
    try { r = io.exec('pgrep', ['-u', String(uid), '-f', 'main\\.py']); } catch (_) { r = null; }
    if (!r || r.code !== 0) return [];
    const out = [];
    for (const pidStr of String(r.stdout || '').split(/\s+/).filter(Boolean)) {
        const pid = Number(pidStr);
        if (!Number.isFinite(pid) || pid <= 0) continue;
        let cwd = null;
        let argv = [];
        try { cwd = io.fs.readlinkSync(`/proc/${pid}/cwd`); } catch (_) { cwd = null; }
        try { argv = String(io.fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean); } catch (_) { argv = []; }
        if (!argv.some((a) => /(^|\/)main\.py$/.test(a))) continue;
        const flag = (name) => {
            const i = argv.indexOf(name);
            if (i !== -1 && argv[i + 1]) return argv[i + 1];
            const eq = argv.find((a) => a.startsWith(`${name}=`));
            return eq ? eq.slice(name.length + 1) : null;
        };
        const port = flag('--port');
        out.push({
            pid,
            root: cwd && io.fs.existsSync(path.join(cwd, 'main.py')) ? cwd : null,
            // ComfyUI defaults to 8188 when --port is absent
            port: port ? Number(port) : 8188,
            listen: flag('--listen'),
            baseurl: flag('--baseurl'),
        });
    }
    return out;
}

/**
 * Resolve the ComfyUI root: an explicit --root wins; then the default
 * (~/ComfyUI) when it holds a ComfyUI; then the root of the user's running
 * ComfyUI process; finally the default (a managed install creates it).
 * @returns {{ root: string, source: 'flag'|'default'|'running-process' }}
 */
function resolveComfyRoot(io, { explicit = null, defaultRoot, running = undefined } = {}) {
    if (explicit) return { root: explicit, source: 'flag' };
    if (defaultRoot && io.fs.existsSync(path.join(defaultRoot, 'main.py'))) return { root: defaultRoot, source: 'default' };
    const proc = running === undefined ? detectRunningComfyUI(io) : running;
    if (proc && proc.root) return { root: proc.root, source: 'running-process' };
    return { root: defaultRoot, source: 'default' };
}

/**
 * True for a REAL ComfyUI /system_stats answer (installer 0.2.2): the payload
 * carries a `system` object (ComfyUI always sends `system` + `devices`; the
 * system block alone is its signature). A wrong reverse-proxy prefix answers
 * 404/HTML, another service answers its own JSON — a bare 200 JSON object is
 * NOT proof (a notebook proxy or a coworker's app would otherwise be
 * accepted as "our" ComfyUI and wired into COMFY_URL).
 */
function isSystemStats(json) {
    return !!(json && typeof json === 'object' && !Array.isArray(json)
        && json.system && typeof json.system === 'object' && !Array.isArray(json.system));
}

/**
 * Probe the ComfyUI API base the worker must use (COMFY_URL). The plain
 * http://127.0.0.1:<port> is tried FIRST; a reverse-proxy prefix (notebook
 * deployments) only when the plain URL does not answer. Never guessed: the
 * returned URL answered GET /system_stats with a ComfyUI payload.
 * @param {object} opts { port, prefixes: string[] (e.g. NOTEBOOK_PATH, --baseurl), timeoutMs }
 * @returns {Promise<{ url: string, prefixed: boolean, tried: string[] } | { url: null, tried: string[] }>}
 */
async function probeComfyUrl(io, { port, prefixes = [], timeoutMs = 3000 } = {}) {
    const base = `http://127.0.0.1:${port}`;
    const candidates = [base];
    for (const p of prefixes) {
        if (!p) continue;
        const norm = `/${String(p).replace(/^\/+|\/+$/g, '')}`;
        if (norm === '/') continue;
        const url = `${base}${norm}`;
        if (!candidates.includes(url)) candidates.push(url);
    }
    for (const url of candidates) {
        try {
            const opts = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? { signal: AbortSignal.timeout(timeoutMs) } : {};
            const res = await io.http.fetchJson(`${url}/system_stats`, opts);
            if (res && res.status === 200 && isSystemStats(res.json)) {
                return { url, prefixed: url !== base, tried: candidates };
            }
        } catch (_) { /* next candidate */ }
    }
    return { url: null, tried: candidates };
}

function probeCustomNodes(io, root) {
    const dir = path.join(root, 'custom_nodes');
    if (!io.fs.isDirectory(dir)) return [];
    const out = [];
    for (const name of io.fs.readdirSync(dir)) {
        if (!io.fs.isDirectory(path.join(dir, name))) continue;
        const git = gitInfo(io, path.join(dir, name));
        out.push({
            directory: name,
            repository: git ? git.repository : null,
            commit: git ? git.commit : null,
            is_git: git !== null,
        });
    }
    return out;
}

/**
 * Walk one model folder. `relDir` is the CANONICAL ComfyUI-relative path the
 * files are reported under (models/<folder>/...), `absDir` where they really
 * live — the same for the default layout, different for a folder declared in
 * extra_model_paths.yaml. `location` (absolute folder base) is attached to
 * files found outside the default layout so the engine downloads missing
 * pieces next to them, never into a second copy.
 */
function walkModelDir(io, absDir, relDir, out, { depth = 0, location = null } = {}) {
    if (!io.fs.isDirectory(absDir)) return;
    let names = [];
    try { names = io.fs.readdirSync(absDir); } catch (_) { return; }
    for (const name of names) {
        const rel = `${relDir}/${name}`;
        let st;
        try { st = io.fs.statSync(path.join(absDir, name)); } catch (_) { continue; }
        if (st.isDirectory) {
            if (depth < 4) walkModelDir(io, path.join(absDir, name), rel, out, { depth: depth + 1, location });
        } else if (st.isFile) {
            out.push(location ? { path: rel, size_bytes: st.size, location } : { path: rel, size_bytes: st.size });
        }
    }
}

/**
 * Minimal extra_model_paths.yaml reader (ComfyUI's own format):
 *
 *   comfyui:
 *       base_path: /data/ComfyUI/
 *       checkpoints: models/checkpoints/
 *       TTS: models/TTS/
 *       loras: |
 *            models/loras/
 *            more_loras/
 *
 * Returns [{ folder, path }] with absolute paths (relative entries resolve
 * against the section's base_path, else against the ComfyUI root). Unknown
 * syntax is skipped — never guessed.
 */
function parseExtraModelPaths(text, root) {
    const out = [];
    const sections = [];
    let cur = null;
    let blockKey = null;
    let blockIndent = 0;
    for (const raw of String(text || '').split(/\r?\n/)) {
        const noComment = raw.replace(/\s+#.*$/, '');
        if (!noComment.trim() || noComment.trim().startsWith('#')) continue;
        const indent = noComment.length - noComment.trimStart().length;
        const line = noComment.trim();
        if (blockKey && indent > blockIndent) {
            cur.entries.push({ folder: blockKey, value: line });
            continue;
        }
        blockKey = null;
        if (indent === 0) {
            const m = /^([^:]+):\s*$/.exec(line);
            cur = m ? { name: m[1].trim(), base: null, entries: [] } : null;
            if (cur) sections.push(cur);
            continue;
        }
        if (!cur) continue;
        const kv = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
        if (!kv) continue;
        const key = kv[1];
        const value = kv[2].replace(/^['"]|['"]$/g, '').trim();
        if (key === 'base_path') { cur.base = value; continue; }
        if (key === 'is_default' || key === 'download_model_base') continue;
        if (value === '|' || value === '>' || value === '|-' || value === '') {
            blockKey = key;
            blockIndent = indent;
            continue;
        }
        cur.entries.push({ folder: key, value });
    }
    for (const sec of sections) {
        const base = sec.base ? (path.isAbsolute(sec.base) ? sec.base : path.join(root, sec.base)) : root;
        for (const e of sec.entries) {
            const v = e.value.replace(/^['"]|['"]$/g, '');
            if (!v) continue;
            out.push({ folder: e.folder, path: path.normalize(path.isAbsolute(v) ? v : path.join(base, v)) });
        }
    }
    return out;
}

/**
 * Additional model folders: extra_model_paths.yaml next to the ComfyUI root
 * (the file ComfyUI itself reads). Each entry maps a folder name (e.g. TTS,
 * the folder the ComfyUI-Qwen3-TTS loader resolves via
 * folder_paths.get_folder_paths("TTS")) to an absolute directory.
 */
function extraModelFolders(io, root) {
    const yamlPath = path.join(root, 'extra_model_paths.yaml');
    if (!io.fs.existsSync(yamlPath)) return [];
    try {
        return parseExtraModelPaths(io.fs.readFileSync(yamlPath, 'utf8'), root);
    } catch (_) {
        return [];
    }
}

function probeModels(io, root) {
    const out = [];
    for (const dir of MODEL_DIRS) walkModelDir(io, path.join(root, dir), dir, out);
    const seen = new Set(MODEL_DIRS.map((d) => path.normalize(path.join(root, d))));
    for (const extra of extraModelFolders(io, root)) {
        const abs = extra.path.replace(/[\\/]+$/, '');
        if (seen.has(path.normalize(abs))) continue; // same as the default layout
        seen.add(path.normalize(abs));
        walkModelDir(io, abs, `models/${extra.folder}`, out, { location: abs });
    }
    return out;
}

function sha256OfFile(io, crypto, absPath) {
    const data = io.fs.readFileSync(absPath); // workflows are small; fine
    return crypto.createHash('sha256').update(Buffer.from(data)).digest('hex');
}

function walkWorkflows(io, crypto, root, relDir, out) {
    const abs = path.join(root, relDir);
    if (!io.fs.isDirectory(abs)) return;
    for (const name of io.fs.readdirSync(abs)) {
        const rel = `${relDir}/${name}`;
        const st = io.fs.statSync(path.join(abs, name));
        if (st.isDirectory) {
            walkWorkflows(io, crypto, root, rel, out);
        } else if (name.endsWith('.json')) {
            let hash = null;
            try { hash = sha256OfFile(io, crypto, path.join(abs, name)); } catch (_) { /* unreadable */ }
            out.push({ path: rel, sha256: hash });
        }
    }
}

function probeWorkflows(io, crypto, root) {
    const out = [];
    walkWorkflows(io, crypto, root, WORKFLOW_SCAN_ROOT, out);
    return out;
}

/** Parse KEY=value lines; record key NAMES only — never values. */
function parseEnvKeys(text) {
    const keys = [];
    for (const raw of String(text || '').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        if (m) keys.push(m[1]);
    }
    return keys;
}

function probeWorker(io, workerDir) {
    if (!workerDir || !io.fs.isDirectory(workerDir)) return null;
    // '.env' is excluded on purpose (secret values are never probed); other
    // dotfiles (e.g. '.env.example' from the bundle manifest) are visible.
    let files = [];
    try { files = io.fs.readdirSync(workerDir).filter((f) => f !== '.env'); } catch (_) { files = []; }
    const envPath = path.join(workerDir, '.env');
    let env = null;
    if (io.fs.existsSync(envPath)) {
        env = { present: true, set_keys: parseEnvKeys(io.fs.readFileSync(envPath, 'utf8')) };
    }
    return {
        worker_type: null, // resolved by the engine against the manifest worker_type
        bundle: { present: files.includes('worker.cjs'), dir: workerDir, files },
        env,
    };
}

/**
 * Probe the full environment.
 * @param {object} io
 * @param {object} opts { root: ComfyUI root, workerDir, crypto }
 * @returns resolver-compatible environment object
 */
function probeEnvironment(io, { root = null, workerDir = null, crypto = null, workerType = null } = {}) {
    const env = {
        root,
        comfyui: undefined,
        python: undefined,
        torch: undefined,
        nodejs: undefined,
        gpu: undefined,
        device: undefined,
        custom_nodes: undefined,
        models: undefined,
        python_packages: undefined,
        workflows: undefined,
        worker: undefined,
    };

    env.gpu = probeGpu(io);
    env.cuda = probeCuda(io);
    env.device = env.gpu && env.gpu.vendor === 'nvidia' ? 'cuda' : 'cpu';
    env.nodejs = probeNodejs(io);
    // The worker runs with NODE_BIN (the installer's own Node >= 20), not with
    // whatever `node` is first in PATH — judge the runtime by that binary and
    // keep the PATH version for information only.
    if (!env.nodejs || nodeMajor(env.nodejs.version) < 20) {
        const pick = pickNodeBinary(io);
        if (pick) env.nodejs = { version: pick.version, binary: pick.bin, path_version: env.nodejs ? env.nodejs.version : null };
    }
    env.comfyui = probeComfyui(io, root);
    env.python = probePython(io, root);
    env.torch = probeTorch(io, root);

    if (env.comfyui) {
        env.custom_nodes = probeCustomNodes(io, root);
        env.models = probeModels(io, root);
        env.python_packages = [];
        if (crypto) env.workflows = probeWorkflows(io, crypto, root);
    } else {
        env.custom_nodes = [];
        env.models = [];
        env.python_packages = [];
        env.workflows = [];
    }

    const worker = probeWorker(io, workerDir);
    if (worker) {
        worker.worker_type = workerType;
        env.worker = worker;
    } else {
        env.worker = null;
    }

    return env;
}

/** Human-readable detection summary (for `detect` / existing-mode display). */
function renderDetection(env) {
    const lines = [];
    if (env.gpu && env.gpu.name) {
        lines.push(`GPU: ${env.gpu.name}${env.gpu.vram_mib ? ` (${Math.round(env.gpu.vram_mib / 1024)} GB VRAM)` : ''} [${env.gpu.vendor}]`);
    } else {
        lines.push('GPU: not detected');
    }
    if (env.device === 'cpu') {
        lines.push('Device: CPU-only mode');
        if (env.gpu && env.gpu.vendor === 'amd') {
            lines.push('  Note: an AMD GPU was detected, but the installer provides no ROCm/accelerated runtime branch yet — CPU mode will be used.');
        }
        lines.push('  Warning: performance will be SIGNIFICANTLY lower than GPU. Suitable for the TTS/audio profile test, not for image/video generation.');
    } else {
        lines.push('Device: CUDA (NVIDIA GPU acceleration)');
    }
    if (env.cuda) lines.push(`CUDA: ${env.cuda}`);
    if (env.comfyui && env.comfyui.present) {
        lines.push(`ComfyUI: detected at ${env.root}`);
        lines.push(`  Version: ${env.comfyui.version || env.comfyui.tag || env.comfyui.commit || 'unknown'}`);
    } else {
        lines.push('ComfyUI: not detected');
    }
    lines.push(`Python: ${env.python ? env.python.version : 'not detected'}`);
    lines.push(`Torch: ${env.torch ? env.torch.version : 'not detected'}`);
    lines.push(`Node.js: ${env.nodejs ? env.nodejs.version : 'not detected'}`);
    if (env.custom_nodes && env.custom_nodes.length > 0) {
        lines.push(`Custom nodes: ${env.custom_nodes.length} found`);
    }
    if (env.models && env.models.length > 0) {
        lines.push(`Models: ${env.models.length} files found`);
    }
    if (env.workflows && env.workflows.length > 0) {
        lines.push(`Workflows: ${env.workflows.length} user workflow files found`);
    }
    if (env.worker && env.worker.bundle && env.worker.bundle.present) {
        lines.push(`Worker: bundle present at ${env.worker.bundle.dir}`);
    }
    return lines.join('\n');
}

module.exports = {
    detectRunningComfyUI,
    resolveComfyRoot,
    MODEL_DIRS,
    parseExtraModelPaths,
    probeModels,
    pickNodeBinary,
    nodeBinaryVersion,
    nodeMajor,
    detectRunningComfyUI,
    resolveComfyRoot,
    probeComfyUrl,
    listRunningComfyUI,
    isSystemStats,
    DEVICE_KINDS,
    probeEnvironment,
    probeGpu,
    probeNvidiaGpu,
    probeAmdGpu,
    probeComfyui,
    probeWorker,
    parseEnvKeys,
    renderDetection,
    pythonBin,
};
