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
// ── installer 0.2.10: the bundle source is copied WHOLE ─────────────────────
// 0.2.9 copied only manifest.worker_bundle.files; bundle 2.4.1 added
// worker-logs.cjs (required by worker.cjs) → «Cannot find module
// './worker-logs.cjs'» after an update. The source dir (hub bundle or the
// installer's bundled copy) IS the bundle: every regular file is deployed;
// the manifest list is only the minimal presence check. Never copied: .env
// and .env.* (except .env.example), node_modules/, .git/, logs/.
const BUNDLE_SKIP_DIRS = new Set(['node_modules', '.git', 'logs']);
/** Files of a bundle that are never removed as «stale» (user data / installer-written). */
const BUNDLE_PROTECTED = new Set(['.env', 'node-classes.json']);

/** io.fs.statSync returns booleans; node fs returns methods — accept both. */
function statIs(st, what) {
    if (!st) return false;
    const v = st[what];
    return typeof v === 'function' ? v.call(st) === true : v === true;
}

function isBundleFile(relPath) {
    const base = relPath.split('/').pop();
    if (base === '.env' || /^\.env\..+$/.test(base)) return base === '.env.example';
    return true;
}

/** Sorted relative paths of every deployable file of a bundle dir. */
function listBundleFiles(io, dir) {
    const out = [];
    const walk = (rel) => {
        const abs = rel ? path.join(dir, rel) : dir;
        let names;
        try { names = io.fs.readdirSync(abs); } catch (_) { return; }
        for (const name of names) {
            const r = rel ? `${rel}/${name}` : name;
            const p = path.join(dir, r);
            let st;
            try { st = io.fs.statSync(p); } catch (_) { continue; }
            if (statIs(st, 'isDirectory')) { if (!BUNDLE_SKIP_DIRS.has(name)) walk(r); continue; }
            if (statIs(st, 'isFile') && isBundleFile(r)) out.push(r);
        }
    };
    walk('');
    return out.sort();
}

function installWorkerBundle(io, { workerDir, manifest, repoRoot = null, bundleDir = null, hubUrl = null, httpFetchText = null, log = null, update = true, nodeBin = null, previousBundleFiles = null }) {
    const wb = manifest.worker_bundle || {};
    const manifestFiles = wb.files || [];
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
    const removed = [];

    // every file of the source bundle(s), manifest-listed or not; a file only
    // the hub bundle has (repo copy partial) still comes from the hub bundle
    const sources = [fromRepo ? repoBundleDir : null, bundleDir].filter(Boolean);
    const sourceOf = new Map();
    for (const dir of sources) for (const f of listBundleFiles(io, dir)) if (!sourceOf.has(f)) sourceOf.set(f, dir);
    const bundleFiles = [...new Set([...sourceOf.keys(), ...manifestFiles])].sort();

    for (const f of bundleFiles) {
        const dest = path.join(workerDir, f);
        if (io.fs.existsSync(dest) && !outdated) { kept.push(f); continue; }
        const src = sourceOf.get(f);
        if (src) {
            io.fs.mkdirSync(path.dirname(dest), { recursive: true });
            io.fs.copyFileSync(path.join(src, f), dest);
            installed.push(f);
            continue;
        }
        if (io.fs.existsSync(dest)) { kept.push(f); continue; }
        failed.push(f);
    }

    // minimal presence check: everything the manifest names must be on disk
    const missing = manifestFiles.filter((f) => !io.fs.existsSync(path.join(workerDir, f)));
    for (const f of missing) if (!failed.includes(f)) failed.push(f);
    if (failed.length > 0) {
        return { status: 'failed', files: installed, files_installed: installed, files_kept: kept, dir_created: dirCreated, reason: `could not obtain bundle files: ${failed.join(', ')} (no repo checkout, no hub bundle)` };
    }

    // an UPDATE removes the files of the previous bundle version that the new
    // one no longer ships — only files the installer itself recorded
    // (install-state worker.bundle_files), never .env / node-classes.json
    if (outdated && Array.isArray(previousBundleFiles) && sources.length > 0) {
        const now = new Set(bundleFiles);
        for (const f of previousBundleFiles) {
            if (typeof f !== 'string' || !f || now.has(f) || BUNDLE_PROTECTED.has(f) || f.includes('..') || path.isAbsolute(f)) continue;
            const p = path.join(workerDir, f);
            try {
                if (io.fs.existsSync(p) && statIs(io.fs.statSync(p), 'isFile')) { io.fs.unlinkSync(p); removed.push(f); }
            } catch (_) { /* best effort */ }
        }
        if (removed.length && log) log.info(`worker bundle: removed ${removed.length} file(s) of ${installedVersion} not in ${sourceVersion}: ${removed.join(', ')}`);
    }

    const deps = ensureWorkerDependencies(io, { workerDir, nodeBin });
    if (deps.ran && log) log.info(`worker dependencies installed (${deps.deps.join(', ')})`);

    if (log) {
        if (outdated) log.info(`worker bundle updated ${installedVersion} → ${sourceVersion} at ${workerDir} (.env kept)`);
        else log.info(`worker bundle deployed at ${workerDir} (${installed.length} files)`);
    }
    return {
        status: 'installed', files: installed, files_installed: installed, files_kept: kept, dir_created: dirCreated,
        // install-state worker.bundle_files: what the NEXT update may remove as stale
        bundle_files: sources.length > 0 ? bundleFiles : (Array.isArray(previousBundleFiles) ? previousBundleFiles : bundleFiles),
        files_removed: removed,
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

    // Merge semantics: EVERY key of the existing .env that this run did not
    // change is preserved — the log line must show the real numbers (a re-run
    // over a configured worker used to report "0 key(s) preserved" because
    // only manifest-required keys were counted).
    const preserved = existingKeys.filter((k) => !changed.includes(k));
    const additions = [];
    const added = new Set();
    const add = (key, val) => { if (!added.has(key)) { additions.push(`${key}=${val}`); added.add(key); } };
    for (const key of required) {
        if (existingKeys.includes(key)) {
            // already preserved above (merge semantics: never overwrite)
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
    // Installer 0.2.8: an unchanged .env is NOT rewritten. Its mtime is the
    // "configuration changed after the worker started" marker
    // (workerConfigNewer) — rewriting identical content made every doctor
    // run restart a running (even busy) worker (04.11, 13:55/13:58 UTC).
    if (envCreated || text !== existingText) io.fs.writeFileSync(envPath, text);
    io.fs.chmodSync(envPath, 0o600);

    if (log) log.info(`.env configured: ${preserved.length} key(s) preserved, ${additions.length} added, ${changed.length} updated${changed.length ? ` (${changed.join(', ')})` : ''}, ${missingAfter.length} still missing`);
    return { status: missingAfter.length === 0 ? 'configured' : 'incomplete', missing_after: missingAfter, preserved, changed, added: Array.from(added), created: envCreated };
}

/**
 * True when the worker .env already holds a NON-EMPTY value for `key`.
 * Only a boolean is returned — the value itself is never read out of .env,
 * so a Worker Key can never leak through this check (re-installs therefore
 * never ask for a key that is already there).
 */
function hasEnvKey(io, workerDir, key) {
    try {
        const text = String(io.fs.readFileSync(path.join(workerDir, '.env'), 'utf8'));
        for (const raw of text.split('\n')) {
            const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(raw);
            if (!m || m[1] !== key) continue;
            const value = m[2].trim().replace(/^["']|[\"']$/g, '');
            if (value) return true;
        }
    } catch (_) { /* no .env */ }
    return false;
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
const LOCAL_REQUIRE_RE = /require\(\s*(["'])(\.{1,2}\/[^"']+)\1\s*\)/g;

/**
 * installer 0.2.10: every local `require('./…')` reachable from worker.cjs
 * must exist on disk — otherwise the worker dies at start with «Cannot find
 * module» (bundle 2.4.1 / worker-logs.cjs). Pure over io.fs.
 * @returns {string[]} missing modules as written in the source (e.g. './worker-logs.cjs')
 */
function missingLocalRequires(io, workerDir, entry = 'worker.cjs') {
    const missing = [];
    const seen = new Set();
    const queue = [path.join(workerDir, entry)];
    const resolve = (from, spec) => {
        const base = path.resolve(path.dirname(from), spec);
        for (const c of [base, `${base}.js`, `${base}.cjs`, `${base}.json`, path.join(base, 'index.js')]) {
            try { if (io.fs.existsSync(c) && statIs(io.fs.statSync(c), 'isFile')) return c; } catch (_) { /* next */ }
        }
        return null;
    };
    while (queue.length) {
        const file = queue.shift();
        if (seen.has(file)) continue;
        seen.add(file);
        let src;
        try { src = io.fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
        if (typeof src !== 'string') src = String(src);
        LOCAL_REQUIRE_RE.lastIndex = 0;
        let m;
        while ((m = LOCAL_REQUIRE_RE.exec(src)) !== null) {
            const hit = resolve(file, m[2]);
            if (!hit) { if (!missing.includes(m[2])) missing.push(m[2]); continue; }
            if (/\.(c?js)$/.test(hit) && path.resolve(hit).startsWith(path.resolve(workerDir))) queue.push(hit);
        }
    }
    return missing;
}

function checkWorkerCanStart(io, { workerDir, nodeBin = 'node' }) {
    const workerCjs = path.join(workerDir, 'worker.cjs');
    if (!io.fs.existsSync(workerCjs)) return { ok: false, reason: 'worker.cjs missing' };
    const missing = missingLocalRequires(io, workerDir);
    if (missing.length > 0) {
        return { ok: false, reason: `worker bundle incomplete: ${missing.join(', ')} missing in ${workerDir} (required by worker.cjs) — re-run the installer to redeploy the bundle`, missing };
    }
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
        const envM = io.fs.statSync(path.join(workerDir, '.env')).mtimeMs;
        const procM = workerProcessStartMs(io, { workerDir, pid, platformAdapter });
        if (procM == null) return false;
        return envM > procM + 1000; // 1s tolerance for same-second writes
    } catch (_) {
        return false;
    }
}

/**
 * Start time of the running worker `pid` (ms) or null when unknown.
 * Most reliable marker: logs/worker.pid written at start (by this installer
 * and by start-worker.sh) — its mtime IS the start time; then the platform
 * adapter (/proc/<pid> on Linux, the pid marker on Windows).
 */
function workerProcessStartMs(io, { workerDir, pid, platformAdapter = null }) {
    try {
        const adapter = platformAdapter || adapterOf({});
        let procM = pidFileStartMs(io, workerDir, pid);
        if (procM == null) procM = adapter.processStartMs(io, pid);
        if (procM == null && typeof adapter.workerStartMarkerMs === 'function') {
            procM = adapter.workerStartMarkerMs(io, workerDir);
        }
        return procM == null ? null : procM;
    } catch (_) {
        return null;
    }
}

/** Files whose change requires a worker restart: .env and the bundle (installer 0.2.8). */
const WORKER_CONFIG_FILES = Object.freeze(['.env', 'package.json', 'worker.cjs', 'worker-env.cjs',
    'job-protocol-v2.cjs', 'worker-cleanup.cjs', 'worker-cleanup-journal.cjs', 'worker-logs.cjs']);

/**
 * Configuration files (.env, bundle files) modified AFTER the worker `pid`
 * started — the running process holds the old configuration (env and code
 * are fixed at process start). Persistent across runs: a restart deferred
 * because the worker was busy is still required on the next run. Unknown
 * start time → [] (never restart on a guess).
 * @returns {string[]} changed file names
 */
function workerConfigNewer(io, { workerDir, pid, platformAdapter = null, files = WORKER_CONFIG_FILES }) {
    const procM = workerProcessStartMs(io, { workerDir, pid, platformAdapter });
    if (procM == null) return [];
    const out = [];
    for (const f of files) {
        try {
            const p = path.join(workerDir, f);
            if (!io.fs.existsSync(p)) continue;
            if (io.fs.statSync(p).mtimeMs > procM + 1000) out.push(f);
        } catch (_) { /* unreadable → not counted */ }
    }
    return out;
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
    if (existing && !forceRestart) {
        // Installer 0.2.8: a stale-config restart never kills a task in
        // progress (`animastor start` path; doctor/install decide in
        // ensureWorker, which waits for the task).
        const act = readWorkerActivity(io, { workerDir, pid: existing, logFile: log });
        if (act.known && act.current_job_id) {
            return {
                started: true, already_running: true, pid: existing, alive: true, reason: null, logFile: log, logOffset: null,
                restart_pending: ['.env'], busy_job: act.current_job_id,
            };
        }
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

// ── Worker activity (installer 0.2.8) ─────────────────────────────────────────
// The hub's heartbeat record (current_job_id) lives in the hub's Redis and is
// not readable from the node; the worker's OWN log carries the same facts:
//   "[ts] [info] Task <job_id> (type=…"         — a task was taken
//   "[ts] [info] Done <job_id>"                  — result delivered
//   "[ts] [error] Failed <job_id>"               — task failed (error sent)
//   "[ts] [error] Rejecting incompatible task…"  — the taken task was refused
// Only the output of the CURRENT process counts (after its last
// "Worker <type> started"). "Hub heartbeat accepted" is logged on the first
// accepted beacon and again after every recovery; every failed beacon logs
// "Beacon failed" — so "heartbeat fresh" = the latest beacon marker of this
// process is an accepted one.
const TASK_START_RE = /\] Task (\S+) \(type=/;
const TASK_END_RE = /\] (?:Done|Failed) (\S+)\s*$/;
const TASK_REJECT_RE = /\] Rejecting incompatible task/;
const WORKER_LOG_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * Pure: classify the worker log (text of one or more runs).
 * @returns {{ started: boolean, current_job_id: string|null, last_job_id: string|null,
 *             comfy_ready: boolean, heartbeat: boolean, healthy: boolean, last_beacon_error: string|null }}
 */
function parseWorkerActivity(text) {
    const all = String(text || '').split('\n');
    let start = -1;
    all.forEach((l, i) => { if (/\] Worker \S+ started/.test(l)) start = i; });
    const lines = start >= 0 ? all.slice(start) : all;
    let current = null;
    let last = null;
    for (const l of lines) {
        let m = TASK_START_RE.exec(l);
        if (m) { current = m[1]; last = m[1]; continue; }
        m = TASK_END_RE.exec(l);
        if (m) { if (current === m[1]) current = null; continue; }
        if (TASK_REJECT_RE.test(l)) current = null;
    }
    const scan = scanWorkerLog(lines.join('\n'));
    return {
        started: start >= 0,
        current_job_id: current,
        last_job_id: last,
        comfy_ready: scan.comfy_ready,
        heartbeat: scan.heartbeat,
        healthy: start >= 0 && scan.comfy_ready && scan.heartbeat && !scan.crashed && !scan.auth_failed,
        last_beacon_error: scan.last_beacon_error,
    };
}

/**
 * Activity of the running worker `pid` from its log (tail of at most
 * WORKER_LOG_TAIL_BYTES). known=false when there is no log, or the log was
 * last written BEFORE this process started (it is some other process's log —
 * busy/idle cannot be told).
 * @returns {{ known: boolean, reason: string|null, current_job_id, last_job_id, comfy_ready, heartbeat, healthy, last_beacon_error, log_file }}
 */
function readWorkerActivity(io, { workerDir, pid = null, logFile = null, tailBytes = WORKER_LOG_TAIL_BYTES }) {
    const log = logFile || workerLogPath(workerDir);
    const unknown = (reason) => ({
        known: false, reason, current_job_id: null, last_job_id: null, comfy_ready: false, heartbeat: false,
        healthy: false, last_beacon_error: null, log_file: log,
    });
    let text;
    try {
        if (!io.fs.existsSync(log)) return unknown(`no worker log at ${log}`);
        text = String(io.fs.readFileSync(log, 'utf8'));
    } catch (err) {
        return unknown(`worker log ${log} unreadable: ${err.message}`);
    }
    if (pid) {
        // Only the pid file is a precise start marker here (/proc/<pid> mtime
        // on Linux is the procfs inode time, not the start time).
        const procM = pidFileStartMs(io, workerDir, pid);
        let logM = null;
        try { logM = io.fs.statSync(log).mtimeMs; } catch (_) { logM = null; }
        if (procM != null && typeof logM === 'number' && logM + 1000 < procM) {
            return unknown(`worker log ${log} was not written by the running worker (pid ${pid})`);
        }
    }
    if (text.length > tailBytes) text = text.slice(text.length - tailBytes);
    const a = parseWorkerActivity(text);
    return { known: true, reason: null, ...a, log_file: log };
}

/** "none" | "<job_id>" | "unknown" for the `current job:` line of doctor/status. */
function currentJobLabel(io, { workerDir, pid = undefined, platformAdapter = null, logFile = null }) {
    const p = pid === undefined ? findRunningWorkerPid(io, workerDir, { platformAdapter }) : pid;
    if (!p) return 'none';
    const a = readWorkerActivity(io, { workerDir, pid: p, logFile });
    if (!a.known) return 'unknown';
    return a.current_job_id || 'none';
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
async function waitForWorkerReady(io, { workerDir, pid = null, logFile = null, logOffset = 0, comfyTimeoutMs = 90000, heartbeatTimeoutMs = 45000, pollMs = 1000, requireHeartbeat = true, platformAdapter = null, comfyUp = null, comfyUpTimeoutMs = 0 }) {
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
    // comfyUp (installer 0.2.3): the comfyTimeoutMs window opens only once
    // ComfyUI itself answers — up to comfyUpTimeoutMs are spent waiting for
    // that first (0 = check once, then count as before).
    if (phase === 'comfy' && typeof comfyUp === 'function') {
        const upDeadline = now() + Math.max(0, comfyUpTimeoutMs);
        for (;;) {
            let up = false;
            try { up = await comfyUp(); } catch (_) { up = false; }
            if (up) break;
            scan = scanWorkerLog(readLogFrom(io, log, logOffset));
            if (scan.comfy_ready || scan.auth_failed || !alive() || now() >= upDeadline) break;
            await new Promise((r) => setTimeout(r, pollMs));
        }
        deadline = now() + comfyTimeoutMs;
    }
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

// ── ensureWorker (installer 0.2.8) ──────────────────────────────────────────
// install/doctor/boot no longer restart a running worker by default
// (04.11: doctor restarted the audio/image workers at 13:55:15 and 13:58:52,
// between tasks only by chance — a result in flight would have been lost).
//
//   not running                          → start
//   running, configuration unchanged     → left as is
//   running, .env/bundle changed:
//     boot (doctor --yes, no TTY)        → left as is, restart pending (warn)
//     --force                            → restart now
//     idle                               → restart
//     busy (a task in progress)          → wait up to waitJobMs for the task
//                                          to finish, then restart; still
//                                          busy → DEFERRED (FAILED, exit ≠ 0)
//     busy state unknown (no log of this
//     process)                           → DEFERRED (FAILED; --force restarts)
const DEFAULT_WAIT_JOB_MS = 600000;

/**
 * Pure decision for a running worker.
 * @returns {{ action: 'start'|'leave'|'restart'|'wait'|'defer', reasons: string[] }}
 */
function decideWorkerAction({ pid = null, reasons = [], activity = null, force = false, boot = false }) {
    if (!pid) return { action: 'start', reasons: [] };
    if (reasons.length === 0) return { action: 'leave', reasons: [] };
    if (force) return { action: 'restart', reasons };
    if (boot) return { action: 'leave', reasons };
    if (!activity || !activity.known) return { action: 'defer', reasons };
    if (activity.current_job_id) return { action: 'wait', reasons };
    return { action: 'restart', reasons };
}

/**
 * Bring the worker of this installation up without ever killing a task in
 * progress (see the table above). Returns the startWorker() shape plus
 * { action, restart_reasons, current_job, busy_job, deferred, restart_pending }.
 * @param {object} o
 * @param {string[]} [o.configChanged] what THIS run changed (".env", "worker bundle 2.2.2 → 2.2.3")
 */
async function ensureWorker(io, {
    workerDir, nodeBin = null, graceMs = 3000, platformAdapter = null, logFile = null,
    configChanged = [], force = false, boot = false, waitJobMs = DEFAULT_WAIT_JOB_MS,
    pollMs = 5000, progressMs = 30000, sleep = null, log = null, startFn = startWorker, tool = 'animastor',
}) {
    const adapter = platformAdapter || adapterOf({});
    const lf = logFile || workerLogPath(workerDir);
    const now = () => (io.now ? io.now() : Date.now());
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const info = (m) => { if (log) log.info(m); };
    const warn = (m) => { if (log) log.warn(m); };
    const start = (forceRestart) => startFn(io, { workerDir, nodeBin, graceMs, platformAdapter: adapter, logFile: lf, forceRestart });

    let pid = findRunningWorkerPid(io, workerDir, { platformAdapter: adapter });
    if (!pid) {
        const res = start(false);
        return { ...res, action: 'started', restart_reasons: [], current_job: 'none' };
    }
    // What this run changed explains itself; otherwise the persistent marker
    // (files newer than the process — e.g. a restart deferred by an earlier run).
    const reasons = (configChanged || []).length > 0
        ? Array.from(new Set(configChanged))
        : workerConfigNewer(io, { workerDir, pid, platformAdapter: adapter }).map((f) => `${f} changed after the worker started`);
    let activity = readWorkerActivity(io, { workerDir, pid, logFile: lf });
    const decision = decideWorkerAction({ pid, reasons, activity, force, boot });
    const jobOf = (a) => (a.known ? (a.current_job_id || 'none') : 'unknown');
    const left = (extra = {}) => ({
        started: true, already_running: true, pid, alive: true, reason: null, logFile: lf, logOffset: null,
        action: 'left', restart_reasons: reasons, current_job: jobOf(activity), ...extra,
    });
    const deferred = (why) => ({
        started: false, already_running: true, pid, alive: true, deferred: true, reason: why, logFile: lf, logOffset: null,
        action: 'deferred', restart_reasons: reasons, current_job: jobOf(activity), busy_job: activity.current_job_id || null,
    });

    if (decision.action === 'leave' && reasons.length === 0) {
        const health = activity.known && !activity.healthy
            ? ` — ${activity.comfy_ready ? (activity.last_beacon_error ? `last beacon failed: ${activity.last_beacon_error}` : 'no heartbeat accepted yet') : 'it has not reached ComfyUI yet'}`
            : '';
        info(`worker already running (pid ${pid}), left as is${health}`);
        return left();
    }
    if (decision.action === 'leave') {
        warn(`worker already running (pid ${pid}), left as is — restart pending (${reasons.join('; ')}); the boot path never restarts a running worker: run \`${tool} doctor\``);
        return left({ restart_pending: reasons });
    }
    if (decision.action === 'defer') {
        const why = `cannot tell whether the worker (pid ${pid}) is busy (${activity.reason}) — restart for ${reasons.join('; ')} deferred; to restart anyway: ${tool} doctor --force`;
        warn(why);
        return deferred(why);
    }
    if (decision.action === 'wait') {
        const deadline = now() + Math.max(0, Number(waitJobMs) || 0);
        let nextProgress = now();
        while (activity.known && activity.current_job_id && now() < deadline) {
            if (now() >= nextProgress) {
                info(`worker is busy with ${activity.current_job_id} (pid ${pid}) — waiting up to ${Math.round((deadline - now()) / 1000)} s for the task to finish before the restart (${reasons.join('; ')})`);
                nextProgress = now() + progressMs;
            }
            await wait(Math.min(pollMs, Math.max(1, deadline - now())));
            const still = findRunningWorkerPid(io, workerDir, { platformAdapter: adapter });
            if (still !== pid) { pid = still; break; }
            activity = readWorkerActivity(io, { workerDir, pid, logFile: lf });
        }
        if (!pid) {
            info('the worker exited while waiting — starting it');
            const res = start(false);
            return { ...res, action: 'started', restart_reasons: reasons, current_job: 'none' };
        }
        if (!activity.known) {
            const why = `cannot tell whether the worker (pid ${pid}) is busy (${activity.reason}) — restart for ${reasons.join('; ')} deferred; to restart anyway: ${tool} doctor --force`;
            warn(why);
            return deferred(why);
        }
        if (activity.current_job_id) {
            const why = `worker is busy with ${activity.current_job_id} (pid ${pid}) — restart deferred (waited ${Math.round((Number(waitJobMs) || 0) / 1000)} s; needed for: ${reasons.join('; ')}); re-run \`${tool} doctor\` when the task finishes, or \`${tool} doctor --force\` to restart now (the task's result is lost)`;
            warn(why);
            return deferred(why);
        }
        info(`the worker (pid ${pid}) finished ${activity.last_job_id || 'its task'}`);
    }
    // restart: idle (or --force)
    if (force && activity.current_job_id) warn(`--force: restarting the worker (pid ${pid}) while it is busy with ${activity.current_job_id} — the task's result is lost`);
    info(`restarting the worker (pid ${pid}): ${reasons.join('; ')}`);
    const res = start(true);
    return { ...res, action: 'restarted', restarted_from: pid, restart_reasons: reasons, current_job: 'none' };
}

// ── node-classes.json (installer 0.2.7, worker bundle >= 2.2.2) ─────────────
// GPU E2E 2026-11-02: a worker took tasks from a ComfyUI without its
// profile's nodes. Bundle 2.2.2 asks for tasks only after ComfyUI's
// /object_info lists every class of this file; without the file it keeps the
// old behaviour (ComfyUI API only) and logs one warning. The installer writes
// it from the manifests' `provides_classes` (required dependencies only) on a
// fresh install, on a bundle update and on every doctor/boot run — so a node
// installed by an older installer gets it on its next doctor/boot.
//
//   { "generated_by": "animastor-installer <v>",
//     "profiles": { "audio/qwen-tts": ["Qwen3TTSLoader", …] } }
const NODE_CLASSES_FILE = 'node-classes.json';

/** {profileId: [classes]} of the given manifests (required deps only, sorted, unique). */
function nodeClassesOfManifests(manifests) {
    const profiles = {};
    for (const m of manifests || []) {
        const id = m && m.profile && m.profile.id;
        if (!id) continue;
        const set = new Set(profiles[id] || []);
        for (const dep of m.dependencies || []) {
            if (dep && dep.requirement && dep.requirement !== 'required') continue;
            for (const cls of (dep && dep.provides_classes) || []) {
                if (typeof cls === 'string' && cls.trim()) set.add(cls.trim());
            }
        }
        profiles[id] = Array.from(set).sort();
    }
    return profiles;
}

/**
 * Write <workerDir>/node-classes.json for the profiles of this run. Only when
 * a worker bundle is installed there (worker.cjs present). Atomic (temp +
 * rename); an identical file is left untouched.
 * @returns {{ status: 'written'|'current'|'absent'|'skipped'|'failed', path?: string, profiles?: object, reason?: string }}
 */
function writeNodeClasses(io, { workerDir, manifests, log = null, version = null }) {
    if (!workerDir || !io.fs.existsSync(path.join(workerDir, 'worker.cjs'))) return { status: 'absent' };
    const profiles = nodeClassesOfManifests(manifests);
    if (Object.keys(profiles).length === 0) return { status: 'skipped', reason: 'no profile manifests' };
    const file = path.join(workerDir, NODE_CLASSES_FILE);
    let v = version;
    if (!v) { try { v = require('../../../package.json').version || null; } catch (_) { v = null; } }
    const doc = { generated_by: `animastor-installer${v ? ` ${v}` : ''}`, profiles };
    const text = JSON.stringify(doc, null, 2) + '\n';
    try {
        if (io.fs.existsSync(file)) {
            let current = null;
            try { current = JSON.parse(String(io.fs.readFileSync(file, 'utf8'))); } catch (_) { current = null; }
            if (current && JSON.stringify(current.profiles || null) === JSON.stringify(profiles)) {
                return { status: 'current', path: file, profiles };
            }
        }
        const tmp = `${file}.tmp-${process.pid}`;
        io.fs.writeFileSync(tmp, text);
        io.fs.renameSync(tmp, file);
        const n = Object.values(profiles).reduce((a, l) => a + l.length, 0);
        if (log) log.info(`${NODE_CLASSES_FILE} written: ${Object.keys(profiles).join(', ')} (${n} node class(es)) — the worker takes tasks only when ComfyUI lists them`);
        return { status: 'written', path: file, profiles };
    } catch (err) {
        if (log) log.warn(`${NODE_CLASSES_FILE} could not be written: ${err.message} — the worker falls back to the ComfyUI-API-only readiness`);
        return { status: 'failed', path: file, reason: err.message };
    }
}

module.exports = {
    installWorkerBundle,
    listBundleFiles,
    missingLocalRequires,
    ensureWorkerDependencies,
    declaredDependencies,
    readPkgVersion,
    readEnvValues,
    hasEnvKey,
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
    workerProcessStartMs,
    workerConfigNewer,
    WORKER_CONFIG_FILES,
    parseWorkerActivity,
    readWorkerActivity,
    currentJobLabel,
    decideWorkerAction,
    ensureWorker,
    DEFAULT_WAIT_JOB_MS,
    configureEnv,
    apiBaseFromHubUrl,
    verifyRegistration,
    checkWorkerCanStart,
    renderEnvLines,
    NODE_CLASSES_FILE,
    nodeClassesOfManifests,
    writeNodeClasses,
};
