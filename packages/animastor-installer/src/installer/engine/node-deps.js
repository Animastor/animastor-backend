'use strict';

/**
 * Custom-node Python dependencies of the RUNNING ComfyUI (installer 0.2.4).
 *
 * Live TIR boots 2026-10-31 (type A): only /home survives a node restart, so
 * the pip packages of a custom node (ComfyUI-Qwen3-TTS:
 * custom_nodes/qwen3-tts/requirements.txt) disappear with the image while the
 * node directory stays. The platform's ComfyUI then starts without the node
 * classes and doctor reported "ComfyUI node classes missing: Qwen3TTS*".
 *
 *   1. the interpreter is taken from the main.py PROCESS (/proc/<pid>: its
 *      argv[0], VIRTUAL_ENV / PATH from its environ, then /proc/<pid>/exe) —
 *      never a guessed `python3`;
 *   2. every required custom node of the profile that is on disk and ships a
 *      requirements.txt is checked IN THAT PYTHON (importlib.metadata +
 *      packaging; no network, nothing installed);
 *   3. unsatisfied → `<python> -m pip install -r requirements.txt` with the
 *      installed torch family pinned as a constraint (pip must never swap the
 *      platform's torch build);
 *   4. a platform ComfyUI is restarted only when allowed: SIGTERM to exactly
 *      the pid that was inspected (its /proc cmdline re-checked first), then
 *      wait until the PLATFORM starts a new main.py (new pid + GET
 *      /system_stats + the node classes in /object_info).
 */

const path = require('path');
const probe = require('./probe');
const comfyui = require('./comfyui');
const comfyOwner = require('./comfy-owner');

/**
 * Python run with `-I -c`: argv[1] = requirements.txt, argv[2..] = extra
 * site dirs put IN FRONT of sys.path (the persistent overlay, installer
 * 0.2.5 — exactly what the generated prestartup script does inside ComfyUI).
 * Prints ONE JSON line:
 * { torch: { name: version }, items: [{ line, name, status, have, want }] }
 * status: ok | missing | mismatch | skipped (marker false) | unparsed.
 */
const CHECK_SCRIPT = [
    'import json, sys',
    'try:',
    '    from packaging.requirements import Requirement',
    'except Exception:',
    '    from pip._vendor.packaging.requirements import Requirement',
    'try:',
    '    from importlib import metadata as md',
    'except Exception:',
    '    import importlib_metadata as md',
    'def ver(n):',
    '    try:',
    '        return md.version(n)',
    '    except Exception:',
    '        return None',
    'import site',
    'for _p in [p for p in sys.argv[2:] if p]:',
    '    _before = list(sys.path)',
    '    site.addsitedir(_p)',
    '    _new = [x for x in sys.path if x not in _before]',
    '    sys.path[:] = _new + [x for x in sys.path if x not in _new]',
    'items = []',
    'for raw in open(sys.argv[1], encoding="utf-8", errors="replace"):',
    '    line = raw.split(" #")[0].strip()',
    '    if not line or line.startswith("#"):',
    '        continue',
    '    if line.startswith("-") or "://" in line and "@" not in line:',
    '        items.append({"line": line, "status": "unparsed"})',
    '        continue',
    '    try:',
    '        r = Requirement(line)',
    '    except Exception:',
    '        items.append({"line": line, "status": "unparsed"})',
    '        continue',
    '    if r.marker is not None and not r.marker.evaluate():',
    '        items.append({"line": line, "name": r.name, "status": "skipped"})',
    '        continue',
    '    have = ver(r.name)',
    '    st = "missing" if have is None else ("ok" if not r.specifier or r.specifier.contains(have, prereleases=True) else "mismatch")',
    '    items.append({"line": line, "name": r.name, "status": st, "have": have, "want": str(r.specifier) or None})',
    'torch = {n: ver(n) for n in ("torch", "torchvision", "torchaudio") if ver(n)}',
    'print(json.dumps({"torch": torch, "items": items}))',
].join('\n');

function readProc(io, pid, name) {
    try { return String(io.fs.readFileSync(`/proc/${pid}/${name}`, 'utf8')); } catch (_) { return null; }
}

function procEnv(io, pid) {
    const raw = readProc(io, pid, 'environ');
    const env = {};
    if (!raw) return env;
    for (const kv of raw.split('\0')) {
        const i = kv.indexOf('=');
        if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return env;
}

/**
 * The Python interpreter a running ComfyUI process uses, from /proc/<pid>.
 * @returns {{ python: string|null, source: string }}
 */
function pythonOfProcess(io, pid) {
    const argv = String(readProc(io, pid, 'cmdline') || '').split('\0').filter(Boolean);
    if (argv.length === 0) return { python: null, source: 'no /proc cmdline' };
    const a0 = argv[0];
    const env = procEnv(io, pid);
    const cwd = (() => { try { return io.fs.readlinkSync(`/proc/${pid}/cwd`); } catch (_) { return null; } })();
    if (path.isAbsolute(a0)) return { python: a0, source: 'argv[0]' };
    if (/python/.test(path.basename(a0))) {
        if (a0.includes('/') && cwd) return { python: path.resolve(cwd, a0), source: 'argv[0] (relative to cwd)' };
        if (env.VIRTUAL_ENV) {
            const cand = path.join(env.VIRTUAL_ENV, 'bin', a0);
            if (io.fs.existsSync(cand)) return { python: cand, source: 'VIRTUAL_ENV of the process' };
        }
        for (const dir of String(env.PATH || '').split(':').filter(Boolean)) {
            const cand = path.join(dir, a0);
            if (io.fs.existsSync(cand)) return { python: cand, source: 'PATH of the process' };
        }
    }
    try {
        const exe = io.fs.readlinkSync(`/proc/${pid}/exe`);
        if (exe) return { python: exe, source: '/proc/<pid>/exe' };
    } catch (_) { /* not readable */ }
    return { python: null, source: `cannot resolve ${a0}` };
}

/** Required custom nodes of the profiles that are on disk with a requirements.txt. */
function profileNodeRequirements(io, { root, manifests }) {
    const out = [];
    const seen = new Set();
    for (const m of manifests || []) {
        for (const dep of m.dependencies || []) {
            if (dep.kind !== 'custom_node' || dep.requirement !== 'required' || seen.has(dep.id)) continue;
            seen.add(dep.id);
            const dir = (dep.install && dep.install.directory) || dep.name;
            const reqPath = path.join(root, 'custom_nodes', dir, 'requirements.txt');
            if (!io.fs.existsSync(reqPath)) continue;
            out.push({ id: dep.id, directory: dir, reqPath, classes: dep.provides_classes || [] });
        }
    }
    return out;
}

/** Run the check script for one requirements.txt in `python`. */
function checkRequirementsFile(io, { python, reqPath, extraPaths = [] }) {
    let r = null;
    try { r = io.exec(python, ['-I', '-c', CHECK_SCRIPT, reqPath, ...(extraPaths || []).filter(Boolean)], { timeout: 120000 }); } catch (err) { r = { code: 1, stderr: err.message }; }
    if (!r || r.code !== 0) return { ok: false, error: String((r && (r.stderr || r.error)) || 'check failed').slice(-300), unsatisfied: [], torch: {} };
    let parsed = null;
    try { parsed = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch (_) { parsed = null; }
    if (!parsed || !Array.isArray(parsed.items)) return { ok: false, error: 'unexpected check output', unsatisfied: [], torch: {} };
    const unsatisfied = parsed.items.filter((i) => i.status === 'missing' || i.status === 'mismatch');
    return { ok: true, unsatisfied, torch: parsed.torch || {}, items: parsed.items };
}

/**
 * Which profile nodes have unsatisfied pip requirements in `python`.
 * @returns {{ python, nodes: Array<{ id, directory, reqPath, classes, unsatisfied: object[] }>, torch: object, errors: string[] }}
 */
function checkNodeDeps(io, { python, root, manifests, extraPaths = [] }) {
    const nodes = [];
    const errors = [];
    let torch = {};
    for (const n of profileNodeRequirements(io, { root, manifests })) {
        const c = checkRequirementsFile(io, { python, reqPath: n.reqPath, extraPaths });
        if (!c.ok) { errors.push(`${n.directory}: ${c.error}`); continue; }
        torch = { ...torch, ...c.torch };
        if (c.unsatisfied.length > 0) nodes.push({ ...n, unsatisfied: c.unsatisfied });
    }
    return { python, nodes, torch, errors };
}

/** "qwen3-tts (transformers missing, librosa>=0.10 has 0.9)" */
function describeUnsatisfied(nodes) {
    return nodes.map((n) => `${n.directory} (${n.unsatisfied.map((u) => (u.status === 'missing'
        ? `${u.name} missing`
        : `${u.name}${u.want || ''} has ${u.have}`)).join(', ')})`).join('; ');
}

/**
 * pip install -r for every node in `nodes` into `python`, with the installed
 * torch family pinned. A permission error on a system interpreter retries
 * with --user. With `pipPython` (the persistent overlay venv, installer
 * 0.2.5) pip runs in the overlay: only what the platform Python lacks is
 * written, under the installation in /home — no --user retry (as root the
 * user site is /root/.local, outside /home, and is lost with a restart too).
 * @returns {{ ok: boolean, installed: string[], failed: Array<{ directory, reason }>, target: string }}
 */
function installNodeDeps(io, { python, nodes, torch = {}, constraintsPath = null, log = null, pipPython = null }) {
    let constraint = null;
    const pins = Object.entries(torch || {}).map(([n, v]) => `${n}==${v}`);
    if (pins.length > 0 && constraintsPath) {
        try {
            io.fs.mkdirSync(path.dirname(constraintsPath), { recursive: true });
            io.fs.writeFileSync(constraintsPath, `${pins.join('\n')}\n`);
            constraint = constraintsPath;
        } catch (_) { constraint = null; }
    }
    const installed = [];
    const failed = [];
    const pip = pipPython || python;
    for (const n of nodes) {
        const args = ['-m', 'pip', 'install', '-r', n.reqPath];
        if (constraint) args.push('-c', constraint);
        if (log) log.info(`installing the Python dependencies of ${n.directory} into ${pipPython ? `the persistent overlay ${path.dirname(path.dirname(pipPython))} (for ${python})` : python}`);
        let r = io.exec(pip, args, { timeout: 60 * 60 * 1000 });
        if (!pipPython && r.code !== 0 && /permission denied|not writeable|EnvironmentError: \[Errno 13\]/i.test(String(r.stderr || ''))) {
            r = io.exec(python, [...args, '--user'], { timeout: 60 * 60 * 1000 });
        }
        if (r.code === 0) installed.push(n.directory);
        else failed.push({ directory: n.directory, reason: `pip install -r ${n.reqPath} failed: ${String(r.stderr || r.error || '').slice(-300)}` });
    }
    return { ok: failed.length === 0, installed, failed, target: pipPython ? 'overlay' : 'system' };
}

function pidAlive(io, pid) {
    if (typeof io.pidAlive === 'function') return io.pidAlive(pid);
    if (!io.fs.existsSync(`/proc/${pid}`)) return false;
    // A zombie (exited, not yet reaped by the platform's supervisor) is gone.
    const stat = readProc(io, pid, 'stat');
    const m = stat ? /\)\s+([A-Za-z])\s/.exec(stat) : null;
    return !(m && (m[1] === 'Z' || m[1] === 'X'));
}

/**
 * Everything needed to start the SAME ComfyUI again, read from /proc/<pid>
 * BEFORE anything is stopped: argv (incl. --port/--listen/--baseurl), cwd,
 * the full environment, the interpreter. A process whose environment cannot
 * be read (another user, hardened /proc) is never stopped — it could not be
 * started again faithfully.
 * @returns {{ ok: boolean, reason: string|null, argv: string[], cwd: string|null, env: object|null, python: string|null, port: number, listen: string|null, baseurl: string|null, url: string|null }}
 */
function snapshotProcess(io, pid) {
    const argv = String(readProc(io, pid, 'cmdline') || '').split('\0').filter(Boolean);
    const out = { ok: false, reason: null, argv, cwd: null, env: null, python: null, port: 8188, listen: null, baseurl: null, url: null };
    if (!argv.some((a) => /(^|\/)main\.py$/.test(a))) {
        out.reason = `pid ${pid} is no longer a ComfyUI main.py — nothing was stopped`;
        return out;
    }
    try { out.cwd = io.fs.readlinkSync(`/proc/${pid}/cwd`); } catch (_) { out.cwd = null; }
    if (!out.cwd) {
        out.reason = `the working directory of the ComfyUI process (pid ${pid}) is not readable — it is not stopped, because it could not be started again the same way`;
        return out;
    }
    const raw = readProc(io, pid, 'environ');
    if (raw === null) {
        out.reason = `the environment of the ComfyUI process (pid ${pid}) is not readable (another user?) — it is not stopped, because it could not be started again the same way`;
        return out;
    }
    out.env = procEnv(io, pid);
    const flag = (name) => {
        const i = argv.indexOf(name);
        if (i !== -1 && argv[i + 1]) return argv[i + 1];
        const eq = argv.find((a) => a.startsWith(`${name}=`));
        return eq ? eq.slice(name.length + 1) : null;
    };
    out.port = flag('--port') ? Number(flag('--port')) : 8188;
    out.listen = flag('--listen');
    out.baseurl = flag('--baseurl');
    out.url = comfyOwner.comfyUrlFor({ port: out.port, baseurl: out.baseurl, listen: out.listen }).url;
    const py = pythonOfProcess(io, pid);
    out.python = py.python;
    out.ok = true;
    return out;
}

/** argv to start the snapshot again: an interpreter given by name is resolved like the original (pythonOfProcess). */
function relaunchArgv(snap) {
    const argv = snap.argv.slice();
    if (!path.isAbsolute(argv[0]) && /python/.test(path.basename(argv[0])) && snap.python) argv[0] = snap.python;
    return argv;
}

/** Last lines of a log file (diagnostics), or ''. */
function tailFile(io, file, maxBytes = 4000) {
    try {
        const s = String(io.fs.readFileSync(file, 'utf8'));
        return s.slice(-maxBytes);
    } catch (_) { return ''; }
}

/**
 * Restart a ComfyUI the installer did NOT start (the platform's — type A,
 * installer 0.2.5). Live E2E 02.11: the platform (TIR) does NOT bring its
 * ComfyUI back after it stops, so "SIGTERM and wait for the platform"
 * (0.2.4) left the node without ComfyUI.
 *
 *   1. snapshot /proc/<pid>: argv, cwd, environment (nothing is stopped
 *      when any of it is unreadable);
 *   2. SIGTERM exactly that pid (SIGKILL after stopTimeoutMs); a signal the
 *      kernel refuses (EPERM) stops here — nothing changed;
 *   3. platform grace window (platformGraceMs): a NEW main.py appearing on its
 *      own means the platform supervises ComfyUI — it is used, the installer
 *      starts nothing;
 *   4. otherwise the installer starts the same command line in the same cwd
 *      with the same environment, detached (own session), output appended to
 *      `logFile`;
 *   5. wait for GET <url>/system_stats (url from --listen/--port/--baseurl of
 *      the original command line), then for every class of expectClasses in
 *      /object_info. A started process that exits is reported with the tail
 *      of its log at once.
 * @returns {Promise<{ ok: boolean, stopped: boolean, started_by: 'platform'|'installer'|null, old_pid, pid: number|null, url: string|null, waited_ms: number, missing_classes: string[], reason: string|null, log_file: string|null }>}
 */
async function restartForeignComfyUI(io, {
    pid, timeoutMs = 600000, intervalMs = 3000, stopTimeoutMs = 15000, platformGraceMs = 30000, expectClasses = [],
    logFile = null, sleep = null, log = null, onProgress = null, progressMs = 30000,
} = {}) {
    const now = () => (typeof io.now === 'function' ? io.now() : Date.now());
    const pause = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const started = now();
    const base = { stopped: false, started_by: null, old_pid: pid, pid: null, url: null, waited_ms: 0, missing_classes: [], log_file: null };
    const snap = snapshotProcess(io, pid);
    if (!snap.ok) return { ...base, ok: false, reason: snap.reason };
    base.url = snap.url;
    let killError = null;
    const kill = (p, sig) => {
        try {
            if (typeof io.kill === 'function') io.kill(p, sig); else process.kill(p, sig);
        } catch (err) {
            if (err && err.code !== 'ESRCH') killError = err;
        }
    };
    if (log) log.info(`stopping the platform's ComfyUI (pid ${pid}) to start it again with the node dependencies: ${snap.argv.join(' ')} (cwd ${snap.cwd})`);
    kill(pid, 'SIGTERM');
    if (killError) {
        return { ...base, ok: false, reason: `cannot stop the ComfyUI process (pid ${pid}): ${killError.code || killError.message} — run the installer as the user that owns it, or restart ComfyUI from the platform console` };
    }
    base.stopped = true;
    const stopDeadline = now() + stopTimeoutMs;
    while (pidAlive(io, pid) && now() < stopDeadline) await pause(Math.min(500, intervalMs));
    if (pidAlive(io, pid)) kill(pid, 'SIGKILL');
    const otherProcs = () => probe.listRunningComfyUI(io).filter((p) => p.pid !== pid);

    // 3. Does the platform supervise its ComfyUI? Give it the grace window.
    let next = null;
    const graceEnd = now() + platformGraceMs;
    for (;;) {
        next = otherProcs()[0] || null;
        if (next || now() >= graceEnd) break;
        await pause(Math.min(intervalMs, Math.max(1, graceEnd - now())));
    }
    let ownPid = null;
    if (next) {
        base.started_by = 'platform';
        if (log) log.info(`the platform started ComfyUI again by itself (pid ${next.pid}) — the installer starts nothing`);
    } else {
        // 4. Nobody brought it back: start the same command line ourselves.
        const argv = relaunchArgv(snap);
        if (logFile) {
            try { io.fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch (_) { /* spawn reports it */ }
        }
        try {
            ownPid = io.spawnDaemon(argv[0], argv.slice(1), { cwd: snap.cwd, env: snap.env, logFile });
        } catch (err) {
            return { ...base, ok: false, waited_ms: now() - started, reason: `the platform did not start ComfyUI again and starting it failed: ${err.message} — start it from the platform console` };
        }
        base.started_by = 'installer';
        base.log_file = logFile;
        if (log) log.info(`the platform did not start ComfyUI again within ${Math.round(platformGraceMs / 1000)} s — started the same command line (pid ${ownPid}, cwd ${snap.cwd}${logFile ? `, log ${logFile}` : ''})`);
    }

    // 5. Wait for the API at the ORIGINAL address (prefix from --baseurl), then the classes.
    let nextProgress = now() + progressMs;
    let last = null;
    for (;;) {
        const waited = now() - started;
        if (ownPid != null && !pidAlive(io, ownPid)) {
            const tail = logFile ? tailFile(io, logFile, 1500).trim().split('\n').slice(-6).join(' | ') : '';
            return { ...base, ok: false, pid: ownPid, waited_ms: waited, reason: `the restarted ComfyUI (pid ${ownPid}) exited${tail ? `: ${tail}` : ''}${logFile ? ` (log ${logFile})` : ''}` };
        }
        const candidates = ownPid != null
            ? [{ pid: ownPid, url: snap.url }]
            : otherProcs().map((p) => ({ pid: p.pid, url: comfyOwner.comfyUrlFor(p).url }));
        for (const c of candidates) {
            if (!(await comfyOwner.verifyComfyUrl(io, c.url))) { last = { pid: c.pid, url: c.url, why: 'does not answer GET /system_stats yet' }; continue; }
            const classes = expectClasses.length > 0 ? await comfyui.objectInfoClasses(io, c.url) : new Set();
            const missing = expectClasses.filter((x) => !classes || !classes.has(x));
            if (missing.length === 0) return { ...base, ok: true, pid: c.pid, url: c.url, waited_ms: waited, reason: null };
            last = { pid: c.pid, url: c.url, why: `answers, node classes missing: ${missing.join(', ')}`, missing };
        }
        if (waited >= timeoutMs) {
            const secs = Math.round(timeoutMs / 1000);
            const who = base.started_by === 'installer' ? 'the installer started ComfyUI again' : 'the platform started ComfyUI again';
            const reason = last
                ? `${who} (pid ${last.pid} at ${last.url}) but it ${last.why} after ${secs} s`
                : `the platform did not start ComfyUI again within ${secs} s after it was stopped (old pid ${pid}) — start it from the platform console`;
            return { ...base, ok: false, pid: last ? last.pid : ownPid, url: last ? last.url : base.url, waited_ms: waited, missing_classes: (last && last.missing) || [], reason };
        }
        if (onProgress && now() >= nextProgress) {
            onProgress(`waiting for ComfyUI (${base.started_by === 'installer' ? `pid ${ownPid}, started by the installer` : 'started by the platform'}) — ${last ? `pid ${last.pid} ${last.why}` : 'no answer yet'} (${Math.round(waited / 1000)} s of ${Math.round(timeoutMs / 1000)} s)`);
            nextProgress += progressMs;
        }
        await pause(Math.min(intervalMs, Math.max(1, timeoutMs - waited)));
    }
}

/** 0.2.4 name, kept for callers: the platform ComfyUI restart is now restartForeignComfyUI. */
const restartPlatformComfyUI = restartForeignComfyUI;

// ---------------------------------------------------------------------------
// Why are node classes missing? (installer 0.2.5)
// ---------------------------------------------------------------------------

/**
 * Custom-node import failures in a ComfyUI startup log:
 *   "Cannot import /x/custom_nodes/qwen3-tts module for custom nodes: No module named 'qwen_tts'"
 *   "   0.0 seconds (IMPORT FAILED): /x/custom_nodes/qwen3-tts"
 * Only the LAST startup in the text counts (an appended log holds several).
 * @returns {Array<{ dir: string, name: string, error: string|null }>}
 */
function parseImportFailures(text) {
    let s = String(text || '');
    const marks = ['** ComfyUI startup time', 'Prestartup times for custom nodes'];
    let cut = -1;
    for (const m of marks) cut = Math.max(cut, s.lastIndexOf(m));
    if (cut > 0) {
        // keep from the start of that line
        const lineStart = s.lastIndexOf('\n', cut);
        s = s.slice(lineStart + 1);
    }
    const out = new Map();
    for (const m of s.matchAll(/Cannot import (\S+) module for custom nodes: ([^\n]*)/g)) {
        const dir = m[1].replace(/[\\/]+$/, '');
        out.set(dir, { dir, name: path.basename(dir), error: m[2].trim() || null });
    }
    for (const m of s.matchAll(/\(IMPORT FAILED\):\s*(\S+)/g)) {
        const dir = m[1].replace(/[\\/]+$/, '');
        if (!out.has(dir)) out.set(dir, { dir, name: path.basename(dir), error: null });
    }
    return Array.from(out.values());
}

/**
 * The startup log of a running ComfyUI, best source first:
 *   1. GET <url>/internal/logs/raw | /internal/logs (ComfyUI's in-memory log);
 *   2. the file behind /proc/<pid>/fd/1 or fd/2 (stdout redirected to a file);
 *   3. `files` (the installer's restart log, <root>/comfyui-installer.log, …).
 * @returns {Promise<{ text: string, source: string|null }>}
 */
async function readComfyLog(io, { url = null, pid = null, files = [], maxBytes = 1024 * 1024 } = {}) {
    if (url && io.http && typeof io.http.fetchJson === 'function') {
        for (const ep of ['/internal/logs/raw', '/internal/logs']) {
            try {
                const r = await io.http.fetchJson(`${url}${ep}`);
                if (r && r.status === 200 && r.json != null) {
                    const j = r.json;
                    let text = null;
                    if (typeof j === 'string') text = j;
                    else if (j && Array.isArray(j.entries)) text = j.entries.map((e) => String((e && e.m) || '')).join('');
                    if (text) return { text: text.slice(-maxBytes), source: `${url}${ep}` };
                }
            } catch (_) { /* older ComfyUI */ }
        }
    }
    const candidates = [];
    if (pid) {
        for (const fd of [1, 2]) {
            try {
                const target = io.fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
                if (target && target.startsWith('/') && !target.startsWith('/dev/')) candidates.push(target);
            } catch (_) { /* not readable */ }
        }
    }
    for (const f of files || []) if (f) candidates.push(f);
    for (const f of Array.from(new Set(candidates))) {
        try {
            if (!io.fs.existsSync(f)) continue;
            const text = String(io.fs.readFileSync(f, 'utf8'));
            if (text) return { text: text.slice(-maxBytes), source: f };
        } catch (_) { /* unreadable */ }
    }
    return { text: '', source: null };
}

const IMPORT_ERROR_RE = /No module named|ModuleNotFoundError|ImportError|cannot import name/i;

/**
 * The CAUSE of "ComfyUI node classes missing" — never just "run doctor"
 * (live E2E 02.11: doctor printed "node classes missing" with the fix
 * `animastor doctor`, which changed nothing → endless loop).
 *
 * Per required custom node that provides a missing class:
 *   deps-missing   — its requirements are not satisfied in the ComfyUI Python
 *                    (persistent overlay included);
 *   import-failed  — the ComfyUI log has IMPORT FAILED for it with an error
 *                    that is not a missing module;
 *   restart-needed — the packages are in place, but the running process
 *                    failed to import the node at startup (missing module) or
 *                    has no record of it: it predates the dependencies.
 * @returns {Promise<{ kind: 'deps-missing'|'import-failed'|'restart-needed'|'unknown', detail: string, nodes: object[], log_source: string|null, python: string|null }>}
 */
async function diagnoseMissingClasses(io, {
    missingClasses = [], manifests = [], root, url = null, pid = null, python = null, extraPaths = [], logFiles = [],
} = {}) {
    const missing = new Set(missingClasses);
    const reqs = profileNodeRequirements(io, { root, manifests });
    const affected = [];
    for (const m of manifests || []) {
        for (const dep of m.dependencies || []) {
            if (dep.kind !== 'custom_node') continue;
            const cls = (dep.provides_classes || []).filter((c) => missing.has(c));
            if (cls.length === 0) continue;
            const dir = (dep.install && dep.install.directory) || dep.name;
            if (affected.some((a) => a.directory === dir)) continue;
            affected.push({ id: dep.id, directory: dir, classes: cls, req: reqs.find((r) => r.directory === dir) || null });
        }
    }
    let py = python;
    if (!py && pid) py = pythonOfProcess(io, pid).python;
    const logRes = await readComfyLog(io, { url, pid, files: logFiles });
    const failures = parseImportFailures(logRes.text);
    const nodes = [];
    for (const a of affected) {
        const n = { directory: a.directory, classes: a.classes, kind: 'unknown', detail: '' };
        let unsatisfied = [];
        let checked = false;
        if (py && a.req) {
            const c = checkRequirementsFile(io, { python: py, reqPath: a.req.reqPath, extraPaths });
            if (c.ok) { checked = true; unsatisfied = c.unsatisfied; }
        }
        const fail = failures.find((f) => f.name === a.directory || f.dir.endsWith(`/custom_nodes/${a.directory}`));
        if (unsatisfied.length > 0) {
            n.kind = 'deps-missing';
            n.detail = `${a.directory}: Python packages missing in ${py}: ${describeUnsatisfied([{ directory: a.directory, unsatisfied }]).replace(/^[^(]*\(|\)$/g, '')}`;
        } else if (fail && fail.error && !IMPORT_ERROR_RE.test(fail.error)) {
            n.kind = 'import-failed';
            n.detail = `${a.directory}: IMPORT FAILED — ${fail.error} (${logRes.source})`;
        } else if (fail) {
            n.kind = 'restart-needed';
            n.detail = `${a.directory}: the running ComfyUI${pid ? ` (pid ${pid})` : ''} failed to import it at startup${fail.error ? ` (${fail.error})` : ''}${checked ? '; the packages are installed now' : ''} — ComfyUI must be restarted`;
        } else if (checked) {
            n.kind = 'restart-needed';
            n.detail = `${a.directory}: the packages are installed, but the running ComfyUI${pid ? ` (pid ${pid})` : ''} has not loaded the node${logRes.source ? '' : ' (no ComfyUI log available)'} — it was started before the node or its dependencies were in place; ComfyUI must be restarted`;
        } else {
            n.detail = `${a.directory}: not registered by ComfyUI${logRes.source ? '' : ' (no ComfyUI log available)'}`;
        }
        nodes.push(n);
    }
    const order = ['deps-missing', 'import-failed', 'restart-needed', 'unknown'];
    const kind = nodes.length > 0 ? order.find((k) => nodes.some((n) => n.kind === k)) : 'unknown';
    const detail = nodes.length > 0 ? nodes.map((n) => n.detail).join('; ') : 'no profile custom node provides them';
    return { kind, detail, nodes, log_source: logRes.source, python: py || null };
}

module.exports = {
    CHECK_SCRIPT,
    pythonOfProcess,
    profileNodeRequirements,
    checkRequirementsFile,
    checkNodeDeps,
    describeUnsatisfied,
    installNodeDeps,
    snapshotProcess,
    restartForeignComfyUI,
    restartPlatformComfyUI,
    parseImportFailures,
    readComfyLog,
    diagnoseMissingClasses,
};
