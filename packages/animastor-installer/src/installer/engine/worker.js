'use strict';

/**
 * Worker installation — Private Worker Installer Phase 2.
 *
 * Deploys the existing Animastor Worker bundle (the runtime contract is NOT
 * changed), creates/updates `.env` with merge semantics, and verifies
 * registration against GPU Hub.
 *
 * Worker Key safety:
 *   - the value is accepted only via an interactive secret provider;
 *   - it is never logged, never written to the plan/state/reports, never
 *     passed through argv;
 *   - an existing valid token in `.env` is never overwritten.
 */

const path = require('path');
const platforms = require('../platform');
const { resolveRepoBundleDir } = require('../worker-bundle-source');
const { parseEnvKeys } = require('./probe');
const { currentUid } = require('./prereq');

/**
 * Platform adapter resolution for one call. Explicit `platformAdapter` /
 * `platform` wins; otherwise the running OS is auto-detected. Never called
 * at module load so tests and callers stay free to inject.
 */
function adapterOf(opts = {}) {
    return opts.platformAdapter || platforms.getPlatformAdapter(opts.platform);
}

function findWorkerManifest(manifests, workerEntryId) {
    return manifests.find((m) => `worker:${m.profile.id}` === workerEntryId) || null;
}

/**
 * Deploy the worker bundle into workerDir.
 * Source order (never invented): a repo checkout bundle first — canonical
 * `packages/animastor-worker/worker/`, legacy `worker/worker/` (pre-
 * relocation checkouts; see installer/worker-bundle-source.js) — then an
 * explicit `bundleDir` (a verified hub worker-bundle tarball the engine
 * extracted beforehand). If both fail, the install returns status 'failed'.
 * Ownership details are returned for the uninstall manifest: dir_created,
 * files the installer actually copied (files_installed) vs files that were
 * already on disk and were kept (files_kept).
 * @returns {{ status, files, files_installed, files_kept, dir_created, reason? }}
 */
function readPkgVersion(io, dir) {
    try {
        const pkg = JSON.parse(io.fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        return typeof pkg.version === 'string' ? pkg.version : null;
    } catch (_) {
        return null;
    }
}

/** Runtime dependencies declared by a bundle's package.json ({} when none). */
function declaredDependencies(io, dir) {
    try {
        const pkg = JSON.parse(io.fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        return pkg && pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
    } catch (_) {
        return {};
    }
}

/**
 * Install the bundle's runtime dependencies with `npm ci` — ONLY when the
 * bundle declares any. The canonical worker bundle is zero-dependency (Node
 * 20 global fetch), so this is normally a no-op; it exists so a future
 * bundle with dependencies can never be deployed half-installed. npm next to
 * the chosen node binary is preferred (same runtime the worker runs with).
 * Throws with the npm output tail on failure — never a silent warning.
 * @returns {{ ran: boolean, deps: string[] }}
 */
function ensureWorkerDependencies(io, { workerDir, nodeBin = null }) {
    const deps = Object.keys(declaredDependencies(io, workerDir));
    if (deps.length === 0) return { ran: false, deps };
    const npmNextToNode = nodeBin && path.isAbsolute(nodeBin) ? path.join(path.dirname(nodeBin), 'npm') : null;
    const npm = npmNextToNode && io.fs.existsSync(npmNextToNode) ? npmNextToNode : 'npm';
    const args = io.fs.existsSync(path.join(workerDir, 'package-lock.json'))
        ? ['ci', '--omit=dev', '--no-audit', '--no-fund']
        : ['install', '--omit=dev', '--no-audit', '--no-fund'];
    const r = io.exec(npm, args, { cwd: workerDir, timeout: 10 * 60 * 1000 });
    if (r.code !== 0) {
        throw new Error(`${npm} ${args[0]} in ${workerDir} failed: ${String(r.stderr || r.stdout || '').trim().slice(-300)}`);
    }
    return { ran: true, deps };
}

/**
 * Deploy the worker bundle into workerDir.
 * Source order (never invented): a repo checkout bundle first — canonical
 * `packages/animastor-worker/worker/`, legacy `worker/worker/` (pre-
 * relocation checkouts; see installer/worker-bundle-source.js) — then an
 * explicit `bundleDir` (a verified hub worker-bundle tarball the engine
 * extracted beforehand). If both fail, the install returns status 'failed'.
 * A bundle whose version differs from the source is UPDATED (bundle files
 * only — .env and logs are never touched) when `update` is true; otherwise
 * present files are kept.
 * Ownership details are returned for the uninstall manifest: dir_created,
 * files the installer actually copied (files_installed) vs files that were
 * already on disk and were kept (files_kept).
 * @returns {{ status, files, files_installed, files_kept, dir_created, updated_from?, reason? }}
 */
function installWorkerBundle(io, { workerDir, manifest, repoRoot = null, bundleDir = null, hubUrl = null, httpFetchText = null, log = null, update = true, nodeBin = null }) {
    const wb = manifest.worker_bundle || {};
    const files = wb.files || [];
    const dirCreated = !io.fs.existsSync(workerDir);
    if (dirCreated) io.fs.mkdirSync(workerDir, { recursive: true });

    const repoBundleDir = resolveRepoBundleDir(io.fs, repoRoot);
    const fromRepo = !!repoBundleDir;
    const sourceDir = fromRepo ? repoBundleDir : bundleDir;
    const installedVersion = readPkgVersion(io, workerDir);
    const sourceVersion = sourceDir ? readPkgVersion(io, sourceDir) : null;
    const outdated = !dirCreated && update && !!installedVersion && !!sourceVersion && installedVersion !== sourceVersion;
    const installed = [];
    const kept = [];
    const failed = [];

    for (const f of files) {
        const dest = path.join(workerDir, f);
        if (io.fs.existsSync(dest) && !outdated) { kept.push(f); continue; }
        if (fromRepo && io.fs.existsSync(path.join(repoBundleDir, f))) {
            io.fs.copyFileSync(path.join(repoBundleDir, f), dest);
            installed.push(f);
            continue;
        }
        if (bundleDir && io.fs.existsSync(path.join(bundleDir, f))) {
            io.fs.copyFileSync(path.join(bundleDir, f), dest);
            installed.push(f);
            continue;
        }
        if (io.fs.existsSync(dest)) { kept.push(f); continue; }
        failed.push(f);
    }

    if (failed.length > 0) {
        return { status: 'failed', files: installed, files_installed: installed, files_kept: kept, dir_created: dirCreated, reason: `could not obtain bundle files: ${failed.join(', ')} (no repo checkout, no hub bundle)` };
    }

    const deps = ensureWorkerDependencies(io, { workerDir, nodeBin });
    if (deps.ran && log) log.info(`worker dependencies installed (${deps.deps.join(', ')})`);

    if (log) {
        if (outdated) log.info(`worker bundle updated ${installedVersion} → ${sourceVersion} at ${workerDir} (.env kept)`);
        else log.info(`worker bundle deployed at ${workerDir} (${installed.length} files)`);
    }
    return {
        status: 'installed', files: installed, files_installed: installed, files_kept: kept, dir_created: dirCreated,
        version: readPkgVersion(io, workerDir),
        ...(outdated ? { updated_from: installedVersion } : {}),
    };
}

/** Serialize KEY=value lines. Values are written as given — never logged. */
function renderEnvLines(values) {
    return Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n');
}

/**
 * Create or update `.env` with merge semantics:
 *   - existing keys are preserved (a valid token is never overwritten);
 *   - missing required keys are appended;
 *   - `overrides` REPLACE the value of existing non-secret keys (installer-
 *     owned wiring the user agreed to fix: WORKER_TYPE, COMFY_URL, NODE_BIN…)
 *     and are appended when absent. Secret keys are only overridden through
 *     an explicit `secretOverrides` (a new Worker Key typed by the user after
 *     the old one was rejected);
 *   - chmod 600.
 * @param {object} opts { workerDir, manifest, values: {KEY: value} candidate
 *   values for MISSING keys only, overrides, secretOverrides, log }
 * @returns {{ status, missing_after: string[], preserved: string[], changed: string[] }}
 */
function configureEnv(io, { workerDir, manifest, values = {}, overrides = {}, secretOverrides = {}, log = null }) {
    const wb = manifest.worker_bundle || {};
    const required = (wb.env && wb.env.required) || [];
    const secretKeys = (wb.env && wb.env.secrets) || ['ANIMASTOR_WORKER_TOKEN'];
    const envPath = path.join(workerDir, '.env');

    let existingText = '';
    let existingKeys = [];
    if (io.fs.existsSync(envPath)) {
        existingText = io.fs.readFileSync(envPath, 'utf8');
        existingKeys = parseEnvKeys(existingText);
    }

    const replace = {};
    for (const [k, v] of Object.entries(overrides || {})) {
        if (v === undefined || v === null || secretKeys.includes(k)) continue;
        replace[k] = String(v);
    }
    for (const [k, v] of Object.entries(secretOverrides || {})) {
        if (v) replace[k] = String(v);
    }

    const changed = [];
    let text = existingText;
    if (Object.keys(replace).length > 0 && text) {
        text = text.split('\n').map((line) => {
            const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
            if (!m || replace[m[1]] === undefined) return line;
            const current = m[2].trim().replace(/^["']|["']$/g, '');
            if (current === replace[m[1]]) return line;
            changed.push(m[1]);
            return `${m[1]}=${replace[m[1]]}`;
        }).join('\n');
    }

    const preserved = [];
    const additions = [];
    const added = new Set();
    const add = (key, val) => { if (!added.has(key)) { additions.push(`${key}=${val}`); added.add(key); } };
    for (const key of required) {
        if (existingKeys.includes(key)) {
            if (!changed.includes(key)) preserved.push(key); // merge semantics: never overwrite
        } else if (replace[key] !== undefined) {
            add(key, replace[key]);
        } else if (values[key] !== undefined) {
            add(key, values[key]);
        }
    }
    for (const [key, val] of Object.entries(values)) {
        if (!required.includes(key) && !existingKeys.includes(key) && replace[key] === undefined) add(key, val);
    }
    for (const [key, val] of Object.entries(replace)) {
        if (!existingKeys.includes(key)) add(key, val);
    }

    const missingAfter = required.filter((k) => !existingKeys.includes(k) && !added.has(k));

    const envCreated = !io.fs.existsSync(envPath);
    if (additions.length > 0) {
        if (text && !text.endsWith('\n')) text += '\n';
        text += additions.join('\n') + '\n';
    }
    io.fs.writeFileSync(envPath, text);
    io.fs.chmodSync(envPath, 0o600);

    if (log) log.info(`.env configured: ${preserved.length} key(s) preserved, ${additions.length} added, ${changed.length} updated${changed.length ? ` (${changed.join(', ')})` : ''}, ${missingAfter.length} still missing`);
    return { status: missingAfter.length === 0 ? 'configured' : 'incomplete', missing_after: missingAfter, preserved, changed, added: Array.from(added), created: envCreated };
}

/** Read non-secret KEY=value pairs from the worker .env (secret keys skipped). */
function readEnvValues(io, workerDir, { skip = ['ANIMASTOR_WORKER_TOKEN'] } = {}) {
    const out = {};
    try {
        const text = io.fs.readFileSync(path.join(workerDir, '.env'), 'utf8');
        for (const raw of text.split('\n')) {
            const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(raw);
            if (!m || skip.includes(m[1])) continue;
            out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
        }
    } catch (_) { /* no .env */ }
    return out;
}

/** Derive the backend API base from HUB_URL (…/gpu → …/api/v1). */
function apiBaseFromHubUrl(hubUrl) {
    return String(hubUrl || '').replace(/\/gpu\/?$/, '') + '/api/v1';
}

/**
 * Verify worker registration against GPU Hub:
 *   POST {api}/worker/verify with Authorization: Bearer <token>
 * The token value is used in the request header ONLY.
 * @returns {{ registered, worker_id?, worker_type?, mode?, status_code?, reason? }}
 */
async function verifyRegistration(io, { hubUrl, token, expectedType = null }) {
    if (!token) {
        return { registered: false, reason: 'no Worker Key provided' };
    }
    const url = `${apiBaseFromHubUrl(hubUrl)}/worker/verify`;
    let res;
    try {
        res = await io.http.fetchJson(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: '{}',
        });
    } catch (err) {
        return { registered: false, reason: `hub unreachable: ${err.message}` };
    }
    if (res.status === 200 && res.json && res.json.verified === true) {
        const typeOk = expectedType ? res.json.worker_type === expectedType : true;
        return {
            registered: true,
            worker_id: res.json.worker_id,
            worker_type: res.json.worker_type,
            mode: res.json.mode,
            type_matches: typeOk,
        };
    }
    if (res.status === 401 || res.status === 403) {
        return { registered: false, status_code: res.status, reason: 'credential rejected (fail-closed) — check the Worker Key; it is shown once at creation/rotation' };
    }
    return { registered: false, status_code: res.status, reason: `unexpected hub response (${res.status})` };
}

/**
 * Local sanity check that the worker CAN start: syntax check with the node
 * binary that will run it + resolution of the dependencies the bundle
 * DECLARES (the canonical bundle declares none — the old hard-coded
 * node-fetch probe made every zero-dependency install "unstartable").
 */
function checkWorkerCanStart(io, { workerDir, nodeBin = 'node' }) {
    const workerCjs = path.join(workerDir, 'worker.cjs');
    if (!io.fs.existsSync(workerCjs)) return { ok: false, reason: 'worker.cjs missing' };
    const syntax = io.exec(nodeBin, ['--check', workerCjs]);
    if (syntax.code !== 0) return { ok: false, reason: `worker.cjs failed syntax check: ${String(syntax.stderr).slice(-200)}` };
    const deps = Object.keys(declaredDependencies(io, workerDir));
    if (deps.length > 0) {
        const r = io.exec(nodeBin, ['-e', 'for (const d of process.argv.slice(2)) require.resolve(d, { paths: [process.cwd()] })', ...deps], { cwd: workerDir });
        if (r.code !== 0) {
            return { ok: false, reason: `worker dependencies missing (${deps.join(', ')}) — run: cd ${workerDir} && npm ci --omit=dev` };
        }
    }
    return { ok: true };
}

/**
 * Download + verify + extract the hub's full worker bundle (GET
 * /worker-bundle, sha256 published at /worker-bundle/sha256). Returns the
 * extraction dir (`animastor-worker/`) as a copy source for
 * installWorkerBundle — used when the installer runs without a repo
 * checkout (the distributed installer package may not carry bundle files).
 * The caller owns the returned tmpDir and must clean it up.
 * @returns {{ bundleDir, tmpDir } | { bundleDir: null, reason }}
 */
async function fetchHubWorkerBundle(io, { hubUrl, tmpRoot = null }) {
    if (!hubUrl) return { bundleDir: null, reason: 'no hub URL' };
    if (!io.http || !io.http.download || !io.http.fetchJson || !io.hashFile) {
        return { bundleDir: null, reason: 'io layer cannot download the hub bundle' };
    }
    const base = hubUrl.replace(/\/$/, '');
    const os = require('os');
    const tmpDir = path.join(tmpRoot || os.tmpdir(), `animastor-worker-bundle-${Date.now()}`);
    const tarPath = path.join(tmpDir, 'worker-bundle.tar.gz');
    try {
        const shaRes = await io.http.fetchJson(`${base}/worker-bundle/sha256`);
        io.fs.mkdirSync(tmpDir, { recursive: true });
        const dl = await io.http.download({ url: `${base}/worker-bundle`, dest: tarPath });
        if (dl.status !== 200) {
            return { bundleDir: null, reason: `worker-bundle download failed (HTTP ${dl.status})` };
        }
        if (shaRes.status === 200 && shaRes.json && shaRes.json.sha256) {
            const actual = await io.hashFile(tarPath);
            if (actual !== shaRes.json.sha256) {
                return { bundleDir: null, reason: 'worker-bundle sha256 mismatch — download refused (integrity)' };
            }
        }
        const r = io.exec('tar', ['-xzf', tarPath, '-C', tmpDir]);
        if (r.code !== 0) {
            return { bundleDir: null, reason: `tar extraction failed: ${String(r.stderr || r.error).slice(-200)}` };
        }
        const srcDir = path.join(tmpDir, 'animastor-worker');
        if (!io.fs.isDirectory(srcDir)) {
            return { bundleDir: null, reason: 'worker-bundle layout unexpected (animastor-worker/ missing)' };
        }
        return { bundleDir: srcDir, tmpDir };
    } catch (err) {
        return { bundleDir: null, reason: `worker-bundle fetch failed: ${err && err.message ? err.message : err}` };
    } finally {
        try { if (io.fs.existsSync(tarPath)) io.fs.unlinkSync(tarPath); } catch (_) { /* best effort */ }
    }
}

/**
 * Find a RUNNING worker process for this exact workerDir. Discovery is a
 * platform concern: on Linux `pgrep -f worker.cjs` matches every worker on
 * the host (several users may run one), so the platform adapter confirms
 * each candidate via /proc/<pid>/cwd — the worker always runs with
 * cwd=workerDir. On Windows the managed marker is the pid file written at
 * start (no /proc there). Foreign installations are never returned.
 * @returns {number|null} pid of the running worker in this dir
 */
function findRunningWorkerPid(io, workerDir, opts = {}) {
    const adapter = adapterOf(opts);
    const pids = adapter.findPidsByCmdlineAndCwd(io, { cmdPattern: 'worker\\.cjs', cwd: workerDir });
    return pids.length > 0 ? pids[0] : null;
}

/**
 * True when .env was modified AFTER the worker process started: the running
 * worker loaded the OLD configuration (its process.env is fixed at startup)
 * and would keep the stale wiring (e.g. the pre-COMFY_PORT default port)
 * forever. Process start time comes from the platform adapter (/proc mtime
 * on Linux, the pid marker on Windows); without any marker the check is
 * inconclusive → false (never kill on a guess).
 */
function workerEnvIsNewer(io, { workerDir, pid, platformAdapter = null }) {
    try {
        const adapter = platformAdapter || adapterOf({});
        const envM = io.fs.statSync(path.join(workerDir, '.env')).mtimeMs;
        // Most reliable marker: logs/worker.pid written at start (by this
        // installer and by start-worker.sh) — its mtime IS the start time.
        let procM = pidFileStartMs(io, workerDir, pid);
        if (procM == null) procM = adapter.processStartMs(io, pid);
        if (procM == null && typeof adapter.workerStartMarkerMs === 'function') {
            procM = adapter.workerStartMarkerMs(io, workerDir);
        }
        if (procM == null) return false;
        return envM > procM + 1000; // 1s tolerance for same-second writes
    } catch (_) {
        return false;
    }
}

/** Default worker log: <install base>/logs/worker.log (same file start-worker.sh uses). */
function workerLogPath(workerDir) {
    return path.join(path.dirname(workerDir), 'logs', 'worker.log');
}

/**
 * Node binary for the worker: NODE_BIN from .env when it exists and is >= 20,
 * else the node running this installer (>= 20, verified by the bootstrap).
 */
function resolveWorkerNode(io, workerDir) {
    const fromEnv = readEnvValues(io, workerDir).NODE_BIN || null;
    if (fromEnv && io.fs.existsSync(fromEnv)) {
        const r = io.exec(fromEnv, ['--version']);
        const m = /^v?(\d+)/.exec(String(r.stdout || '').trim());
        if (r.code === 0 && m && Number(m[1]) >= 20) return fromEnv;
    }
    return process.execPath;
}

/**
 * Environment for the spawned worker: the installer's own environment minus
 * the worker configuration keys — the worker reads them from its .env, and a
 * stray exported WORKER_TYPE/HUB_URL/COMFY_PORT in the installer's shell must
 * never override the configuration that was just written (real env wins
 * over .env inside the worker).
 */
const WORKER_ENV_KEYS = Object.freeze([
    'HUB_URL', 'WORKER_TYPE', 'WORKER_ID', 'COMFY_PORT', 'COMFY_URL', 'NOTEBOOK_PATH',
    'COMFY_INPUT_DIR', 'ANIMASTOR_WORKER_TOKEN', 'ANIMASTOR_API_URL', 'NODE_BIN',
]);
function workerSpawnEnv(base = process.env) {
    const env = { ...base };
    for (const k of WORKER_ENV_KEYS) delete env[k];
    return env;
}

/** <base>/logs/worker.pid — written on every worker start. */
function workerPidFile(workerDir) {
    return path.join(path.dirname(workerDir), 'logs', 'worker.pid');
}

/** Start time (pid file mtime) when the pid file names `pid`, else null. */
function pidFileStartMs(io, workerDir, pid) {
    try {
        const f = workerPidFile(workerDir);
        if (!io.fs.existsSync(f)) return null;
        if (Number(String(io.fs.readFileSync(f, 'utf8')).trim()) !== Number(pid)) return null;
        const st = io.fs.statSync(f);
        return typeof st.mtimeMs === 'number' ? st.mtimeMs : null;
    } catch (_) {
        return null;
    }
}

/**
 * Start the installed worker as a detached daemon (<NODE_BIN> worker.cjs).
 * The worker loads its own .env (worker-env.cjs), so no secrets pass through
 * the environment or argv here. Returns whether the process is still alive
 * after a short grace period, plus the log file and the byte offset where
 * THIS start's output begins (readiness is judged from there).
 * Idempotent: a worker already running for this directory is left alone
 * (re-runs must never spawn a second instance) unless .env changed after it
 * started. Platform specifics (kill/sleep/alive commands, pid marker) come
 * from the platform adapter — the flow itself is universal.
 */
function startWorker(io, { workerDir, nodeBin = null, logFile = null, graceMs = 3000, sleep = null, platformAdapter = null, forceRestart = false }) {
    const adapter = platformAdapter || adapterOf({});
    const node = nodeBin || resolveWorkerNode(io, workerDir);
    const log = logFile || workerLogPath(workerDir);
    const can = checkWorkerCanStart(io, { workerDir, nodeBin: node });
    if (!can.ok) return { started: false, alive: false, reason: can.reason, logFile: log };
    const existing = findRunningWorkerPid(io, workerDir, { platformAdapter: adapter });
    // forceRestart: the caller just changed .env/the bundle — a running worker
    // holds the OLD configuration (process env is fixed at start).
    if (existing && !forceRestart && !workerEnvIsNewer(io, { workerDir, pid: existing, platformAdapter: adapter })) {
        return { started: true, already_running: true, pid: existing, alive: true, reason: null, logFile: log, logOffset: null };
    }
    if (existing) {
        // .env changed after this worker started — it is running on the OLD
        // configuration (its env is fixed at process start). Restart it so
        // re-runs with a new --comfy-port etc. actually take effect.
        const kc = adapter.killCommand(existing);
        io.exec(kc.cmd, kc.args);
        runSleep(io, adapter, sleep, 1);
    }
    try { io.fs.mkdirSync(path.dirname(log), { recursive: true }); } catch (_) { /* exists */ }
    let logOffset = 0;
    try { logOffset = io.fs.existsSync(log) ? io.fs.statSync(log).size : 0; } catch (_) { logOffset = 0; }
    const pid = io.spawnDaemon(node, ['worker.cjs'], {
        cwd: workerDir,
        logFile: log,
        env: workerSpawnEnv(),
    });
    // Platform post-start bookkeeping (Windows: write the managed pid marker)
    if (typeof adapter.onWorkerSpawned === 'function') {
        try { adapter.onWorkerSpawned(io, { workerDir, pid }); } catch (_) { /* best effort */ }
    }
    try { io.fs.writeFileSync(workerPidFile(workerDir), `${pid}\n`); } catch (_) { /* best effort */ }
    // sync grace pause (installer is already a synchronous-step CLI)
    runSleep(io, adapter, sleep, Math.max(1, Math.ceil(graceMs / 1000)));
    let alive;
    if (typeof adapter.checkDaemonAlive === 'function') {
        alive = adapter.checkDaemonAlive(io, { pid, workerDir });
    } else {
        const chkCmd = adapter.psCheckCommand(pid);
        const chk = io.exec(chkCmd.cmd, chkCmd.args);
        alive = chk.code === 0 && /worker\.cjs/.test(chk.stdout);
    }
    return { started: true, pid, alive, reason: alive ? null : `worker exited immediately — see ${log}`, logFile: log, logOffset };
}

/**
 * Classify a worker log excerpt (the output of ONE worker start: everything
 * after the last "Worker <type> started" line). Pure — shared by the
 * installer, `animastor start/status/doctor` and tests.
 * Markers (worker.cjs >= 2.2.0; "ComfyUI ready" exists in every version):
 *   comfy_ready — "ComfyUI ready"
 *   heartbeat   — "Hub heartbeat accepted"
 *   auth_failed — "Worker authentication failed"
 * @returns {{ comfy_ready, heartbeat, auth_failed, crashed, last_comfy_error, last_beacon_error, last_lines }}
 */
function scanWorkerLog(text) {
    const all = String(text || '').split('\n');
    let start = 0;
    all.forEach((l, i) => { if (/\] Worker \S+ started/.test(l)) start = i; });
    const lines = all.slice(start);
    const find = (re) => lines.some((l) => re.test(l));
    const last = (re) => {
        for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i])) return lines[i];
        return null;
    };
    const comfyErr = last(/ComfyUI not ready/);
    const lastIdx = (re) => { for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i])) return i; return -1; };
    const beaconErrIdx = lastIdx(/Beacon failed/);
    return {
        comfy_ready: find(/ComfyUI ready/),
        // ONLINE now = the latest heartbeat marker is newer than the latest
        // beacon failure (the worker re-logs the marker after a recovery).
        heartbeat: lastIdx(/Hub heartbeat accepted/) > beaconErrIdx,
        auth_failed: find(/Worker authentication failed/),
        crashed: find(/Worker crashed/),
        last_comfy_error: comfyErr ? comfyErr.replace(/^\[[^\]]*\]\s*\[[^\]]*\]\s*/, '') : null,
        last_beacon_error: beaconErrIdx >= 0 ? (lines[beaconErrIdx + 1] || lines[beaconErrIdx]).trim() : null,
        last_lines: lines.filter(Boolean).slice(-8),
    };
}

function readLogFrom(io, logFile, offset) {
    try {
        const text = String(io.fs.readFileSync(logFile, 'utf8'));
        return offset ? Buffer.from(text).subarray(offset).toString('utf8') : text;
    } catch (_) {
        return '';
    }
}

/**
 * Wait until the worker proves it is serving, judged from ITS OWN log:
 *   1. "ComfyUI ready"            (worker reached the ComfyUI API) — within comfyTimeoutMs
 *   2. "Hub heartbeat accepted"   (the hub recorded the heartbeat → Animastor
 *                                  shows ONLINE) — within heartbeatTimeoutMs after 1
 * Stops early when the process died or authentication failed.
 * @returns {Promise<{ comfy_ready, heartbeat, auth_failed, exited, reason, logFile, scan }>}
 */
async function waitForWorkerReady(io, { workerDir, pid = null, logFile = null, logOffset = 0, comfyTimeoutMs = 90000, heartbeatTimeoutMs = 45000, pollMs = 1000, requireHeartbeat = true, platformAdapter = null }) {
    const log = logFile || workerLogPath(workerDir);
    const adapter = platformAdapter || adapterOf({});
    const now = () => (io.now ? io.now() : Date.now());
    const alive = () => {
        if (!pid) return true;
        try {
            if (typeof adapter.checkDaemonAlive === 'function') return adapter.checkDaemonAlive(io, { pid, workerDir });
            const chk = adapter.psCheckCommand(pid);
            const r = io.exec(chk.cmd, chk.args);
            return r.code === 0 && /worker\.cjs/.test(r.stdout);
        } catch (_) { return false; }
    };
    let scan = scanWorkerLog(readLogFrom(io, log, logOffset));
    let deadline = now() + comfyTimeoutMs;
    let phase = scan.comfy_ready ? 'heartbeat' : 'comfy';
    if (phase === 'heartbeat') deadline = now() + heartbeatTimeoutMs;
    for (;;) {
        scan = scanWorkerLog(readLogFrom(io, log, logOffset));
        if (scan.auth_failed) {
            return { ...flags(scan), exited: !alive(), reason: 'the Worker Key was rejected (Worker authentication failed)', logFile: log, scan };
        }
        if (phase === 'comfy' && scan.comfy_ready) {
            if (!requireHeartbeat) return { ...flags(scan), exited: false, reason: null, logFile: log, scan };
            phase = 'heartbeat';
            deadline = now() + heartbeatTimeoutMs;
        }
        if (phase === 'heartbeat' && scan.heartbeat) {
            return { ...flags(scan), exited: false, reason: null, logFile: log, scan };
        }
        if (!alive()) {
            return { ...flags(scan), exited: true, reason: `worker process exited${scan.crashed ? ' (Worker crashed)' : ''} — see ${log}`, logFile: log, scan };
        }
        if (now() > deadline) {
            const reason = phase === 'comfy'
                ? `worker did not log "ComfyUI ready" within ${Math.round(comfyTimeoutMs / 1000)} s${scan.last_comfy_error ? ` (${scan.last_comfy_error})` : ''} — see ${log}`
                : `the hub did not confirm a heartbeat within ${Math.round(heartbeatTimeoutMs / 1000)} s${scan.last_beacon_error ? ` (${scan.last_beacon_error})` : ''} — see ${log}`;
            return { ...flags(scan), exited: false, reason, logFile: log, scan };
        }
        await new Promise((r) => setTimeout(r, pollMs));
    }
}

function flags(scan) {
    return { comfy_ready: scan.comfy_ready, heartbeat: scan.heartbeat, auth_failed: scan.auth_failed };
}

/** Grace sleep through the adapter (test-injectable `sleep` command wins). */
function runSleep(io, adapter, sleepOverride, seconds) {
    if (sleepOverride) {
        io.exec(sleepOverride, [String(seconds)]);
        return;
    }
    const sc = adapter.sleepCommand(seconds);
    io.exec(sc.cmd, sc.args);
}

/**
 * Uid of a process (platform adapter: /proc stat on Linux, null on Windows)
 * or null when unavailable.
 */
function pidUid(io, pid, opts = {}) {
    return adapterOf(opts).pidUid(io, pid);
}

/**
 * Stop a RUNNING worker of THIS installation (pid from findRunningWorkerPid,
 * i.e. cwd-verified) and wait for it to exit. Never uses pkill/killall: the
 * pid is addressed directly, and a pid owned by a DIFFERENT account is
 * refused (shared host with several Animastor installations).
 * @returns {{ stopped: boolean, pid: number|null, reason: string|null }}
 */
async function stopManagedWorker(io, { workerDir, stopTimeoutMs = 15000, pollMs = 300, log = null, platformAdapter = null }) {
    const adapter = platformAdapter || adapterOf({});
    const pid = findRunningWorkerPid(io, workerDir, { platformAdapter: adapter });
    if (!pid) return { stopped: false, pid: null, reason: 'no running worker process found for this installation' };
    const me = currentUid();
    const owner = pidUid(io, pid, { platformAdapter: adapter });
    if (me != null && owner != null && me !== 0 && owner !== me) {
        return { stopped: false, pid, reason: `worker process ${pid} is owned by uid ${owner} — refusing to signal a foreign process` };
    }
    if (log) log.info(`stopping worker (pid ${pid})`);
    try {
        if (typeof io.kill === 'function') io.kill(pid, 'SIGTERM');
        else process.kill(pid, 'SIGTERM');
    } catch (_) {
        return { stopped: true, pid, reason: null }; // already gone
    }
    const alive = () => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
    const deadline = (io.now ? io.now() : Date.now()) + stopTimeoutMs;
    while (alive() && (io.now ? io.now() : Date.now()) < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
    }
    if (alive()) {
        try { if (typeof io.kill === 'function') io.kill(pid, 'SIGKILL'); else process.kill(pid, 'SIGKILL'); } catch (_) { /* gone */ }
    }
    return { stopped: true, pid, reason: null };
}

/**
 * Restart the managed worker of THIS installation: stop the running process
 * (cwd-verified, uid-guarded — a foreign worker is never signaled), then
 * start a fresh one via startWorker (which is idempotent, refuses a broken
 * bundle, and reports liveness after a grace period). Also used when the
 * worker is already stopped: the stop step is skipped and it is just started.
 * @returns {{ restarted: boolean, previously_running: boolean, pid: number|null,
 *             alive: boolean, reason: string|null }}
 */
async function restartManagedWorker(io, { workerDir, log = null, stopTimeoutMs = 15000, pollMs = 300, graceMs = 3000, platformAdapter = null }) {
    const previouslyRunning = !!findRunningWorkerPid(io, workerDir, { platformAdapter });
    if (previouslyRunning) {
        const stop = await stopManagedWorker(io, { workerDir, stopTimeoutMs, pollMs, log, platformAdapter });
        if (!stop.stopped) {
            return { restarted: false, previously_running: true, pid: stop.pid, alive: false, reason: stop.reason };
        }
    }
    const start = startWorker(io, { workerDir, graceMs, log, platformAdapter });
    if (!start.started) {
        return { restarted: true, previously_running: previouslyRunning, pid: null, alive: false, reason: start.reason };
    }
    if (start.already_running) {
        return { restarted: false, previously_running: true, pid: start.pid, alive: true, reason: null };
    }
    return { restarted: true, previously_running: previouslyRunning, pid: start.pid, alive: start.alive, reason: start.reason };
}

module.exports = {
    installWorkerBundle,
    ensureWorkerDependencies,
    declaredDependencies,
    readPkgVersion,
    readEnvValues,
    resolveWorkerNode,
    workerLogPath,
    workerSpawnEnv,
    scanWorkerLog,
    readLogFrom,
    waitForWorkerReady,
    fetchHubWorkerBundle,
    startWorker,
    stopManagedWorker,
    restartManagedWorker,
    findRunningWorkerPid,
    workerEnvIsNewer,
    configureEnv,
    apiBaseFromHubUrl,
    verifyRegistration,
    checkWorkerCanStart,
    renderEnvLines,
};
