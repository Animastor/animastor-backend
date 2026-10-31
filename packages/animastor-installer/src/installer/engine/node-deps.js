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
 * Python run with `-I -c`: argv[1] = requirements.txt. Prints ONE JSON line:
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
function checkRequirementsFile(io, { python, reqPath }) {
    let r = null;
    try { r = io.exec(python, ['-I', '-c', CHECK_SCRIPT, reqPath], { timeout: 120000 }); } catch (err) { r = { code: 1, stderr: err.message }; }
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
function checkNodeDeps(io, { python, root, manifests }) {
    const nodes = [];
    const errors = [];
    let torch = {};
    for (const n of profileNodeRequirements(io, { root, manifests })) {
        const c = checkRequirementsFile(io, { python, reqPath: n.reqPath });
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
 * with --user (the account's site-packages live in /home and survive).
 * @returns {{ ok: boolean, installed: string[], failed: Array<{ directory, reason }> }}
 */
function installNodeDeps(io, { python, nodes, torch = {}, constraintsPath = null, log = null }) {
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
    for (const n of nodes) {
        const args = ['-m', 'pip', 'install', '-r', n.reqPath];
        if (constraint) args.push('-c', constraint);
        if (log) log.info(`installing the Python dependencies of ${n.directory} into ${python}`);
        let r = io.exec(python, args, { timeout: 60 * 60 * 1000 });
        if (r.code !== 0 && /permission denied|not writeable|EnvironmentError: \[Errno 13\]/i.test(String(r.stderr || ''))) {
            r = io.exec(python, [...args, '--user'], { timeout: 60 * 60 * 1000 });
        }
        if (r.code === 0) installed.push(n.directory);
        else failed.push({ directory: n.directory, reason: `pip install -r ${n.reqPath} failed: ${String(r.stderr || r.error || '').slice(-300)}` });
    }
    return { ok: failed.length === 0, installed, failed };
}

function pidAlive(io, pid) {
    if (typeof io.pidAlive === 'function') return io.pidAlive(pid);
    return io.fs.existsSync(`/proc/${pid}`);
}

/**
 * Restart the PLATFORM's ComfyUI: stop exactly `pid` (its /proc cmdline is
 * re-read and must still be a main.py — a recycled pid is never signaled),
 * then wait until the platform starts a new one: another pid, GET
 * /system_stats with a ComfyUI payload and every class of `expectClasses`
 * in /object_info. The platform starts it — the installer never does.
 * @returns {Promise<{ ok: boolean, stopped: boolean, old_pid, pid: number|null, url: string|null, waited_ms: number, missing_classes: string[], reason: string|null }>}
 */
async function restartPlatformComfyUI(io, {
    pid, timeoutMs = 600000, intervalMs = 3000, stopTimeoutMs = 15000, expectClasses = [],
    sleep = null, log = null, onProgress = null, progressMs = 30000,
} = {}) {
    const now = () => (typeof io.now === 'function' ? io.now() : Date.now());
    const pause = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const started = now();
    const base = { stopped: false, old_pid: pid, pid: null, url: null, waited_ms: 0, missing_classes: [] };
    const argv = String(readProc(io, pid, 'cmdline') || '').split('\0').filter(Boolean);
    if (!argv.some((a) => /(^|\/)main\.py$/.test(a))) {
        return { ...base, ok: false, reason: `pid ${pid} is no longer a ComfyUI main.py — nothing was stopped` };
    }
    const kill = (sig) => { try { if (typeof io.kill === 'function') io.kill(pid, sig); else process.kill(pid, sig); } catch (_) { /* gone */ } };
    if (log) log.info(`stopping the platform's ComfyUI (pid ${pid}) so it is started again with the new node dependencies`);
    kill('SIGTERM');
    const stopDeadline = now() + stopTimeoutMs;
    while (pidAlive(io, pid) && now() < stopDeadline) await pause(Math.min(500, intervalMs));
    if (pidAlive(io, pid)) kill('SIGKILL');
    let nextProgress = started + progressMs;
    let last = null;
    for (;;) {
        const waited = now() - started;
        const procs = probe.listRunningComfyUI(io).filter((p) => p.pid !== pid);
        for (const p of procs) {
            const { url } = comfyOwner.comfyUrlFor(p);
            if (!(await comfyOwner.verifyComfyUrl(io, url))) { last = { pid: p.pid, url, why: 'does not answer GET /system_stats yet' }; continue; }
            const classes = expectClasses.length > 0 ? await comfyui.objectInfoClasses(io, url) : new Set();
            const missing = expectClasses.filter((c) => !classes || !classes.has(c));
            if (missing.length === 0) {
                return { ...base, ok: true, stopped: true, pid: p.pid, url, waited_ms: waited, reason: null };
            }
            last = { pid: p.pid, url, why: `answers, node classes missing: ${missing.join(', ')}`, missing };
        }
        if (waited >= timeoutMs) {
            const secs = Math.round(timeoutMs / 1000);
            const reason = last
                ? `the platform started ComfyUI again (pid ${last.pid} at ${last.url}) but it ${last.why} after ${secs} s`
                : `the platform did not start ComfyUI again within ${secs} s after it was stopped (old pid ${pid}) — start it from the platform console`;
            return { ...base, ok: false, stopped: true, pid: last ? last.pid : null, url: last ? last.url : null, waited_ms: waited, missing_classes: (last && last.missing) || [], reason };
        }
        if (onProgress && now() >= nextProgress) {
            onProgress(`waiting for the platform to start ComfyUI again — ${last ? `pid ${last.pid} ${last.why}` : 'no new main.py process yet'} (${Math.round(waited / 1000)} s of ${Math.round(timeoutMs / 1000)} s)`);
            nextProgress += progressMs;
        }
        await pause(Math.min(intervalMs, Math.max(1, timeoutMs - waited)));
    }
}

module.exports = {
    CHECK_SCRIPT,
    pythonOfProcess,
    profileNodeRequirements,
    checkRequirementsFile,
    checkNodeDeps,
    describeUnsatisfied,
    installNodeDeps,
    restartPlatformComfyUI,
};
