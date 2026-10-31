'use strict';

/**
 * ComfyUI ownership BY FACT (installer 0.2.2).
 *
 * The install state is a record, not the truth: on TIR nodes the platform
 * starts `python3 ~/ComfyUI/main.py --listen 0.0.0.0 --port 8888 --baseurl
 * /notebook/p-…` with root privileges, and the port/prefix change between
 * boots. The installer must therefore decide the mode from what RUNS:
 *
 *   - a verified ComfyUI process that the installer did not start
 *        → owner 'foreign', mode 'existing': its address (from --port /
 *          --baseurl in the cmdline, confirmed by GET /system_stats returning
 *          a ComfyUI payload) is the one the worker gets; the installer never
 *          starts a second ComfyUI next to it.
 *   - the installer's OWN process (started by spawnDaemon: `--listen
 *          127.0.0.1 --port N`, recorded in state.comfyui_runtime)
 *        → owner 'managed', mode 'managed'.
 *   - nothing running
 *        → 'managed' only when the installer created the ComfyUI
 *          (state.components.comfyui.owned); otherwise 'existing' (the
 *          user's ComfyUI is simply down — never silently take it over).
 *
 * A recorded state that contradicts the fact is reported as a CONFLICT with
 * the exact correction (mode / startComfyui / comfyPort / ownership); the
 * CLI shows it and applies the correction with one question.
 */

const path = require('path');
const probe = require('./probe');

/** The listen address of every ComfyUI the installer starts itself. */
const INSTALLER_LISTEN = '127.0.0.1';

/** 'http://127.0.0.1:8888/notebook/p-1/n-2' → '/notebook/p-1/n-2'; '' → ''. */
function normalizePrefix(baseurl) {
    const p = String(baseurl || '').trim();
    if (!p || p === '/') return '';
    const one = `/${p.replace(/^\/+|\/+$/g, '')}`;
    return one === '/' ? '' : one;
}

/**
 * The address a ComfyUI process is reachable at, taken from its OWN cmdline:
 * --listen decides the host (0.0.0.0 / :: → loopback), --port the port,
 * --baseurl the reverse-proxy prefix. Nothing is guessed.
 */
function comfyUrlFor({ port = 8188, baseurl = null, listen = null } = {}) {
    const l = String(listen || '').trim();
    const host = !l || l === '0.0.0.0' || l === '::' || l === '[::]' ? INSTALLER_LISTEN : l;
    const prefix = normalizePrefix(baseurl);
    const base = `http://${host}:${Number(port)}`;
    return { url: prefix ? `${base}${prefix}` : base, prefixed: prefix !== '', baseurl: prefix };
}

/**
 * True when the process is THE instance this installation started: the
 * installer always starts its own ComfyUI with `--listen 127.0.0.1`, no
 * --baseurl, on the port recorded in state.comfyui_runtime. A platform
 * process (`--listen 0.0.0.0 --baseurl …`) is never classified as ours, so
 * it is never stopped, wired as a managed target or reported as managed.
 */
function isInstallerInstance(proc, state) {
    if (!proc || proc.listen !== INSTALLER_LISTEN) return false;
    if (normalizePrefix(proc.baseurl)) return false;
    const rt = (state && state.comfyui_runtime) || null;
    if (!rt) return false;
    if (rt.pid != null && Number(rt.pid) === Number(proc.pid)) return true;
    return rt.port != null && Number(rt.port) === Number(proc.port);
}

/**
 * GET <url>/system_stats and require a ComfyUI payload (system + devices) —
 * a wrong reverse-proxy prefix answers 404/HTML, another service answers its
 * own JSON, so a bare 200 is not proof.
 * @returns {Promise<object|null>}
 */
async function verifyComfyUrl(io, url, { timeoutMs = 3000 } = {}) {
    try {
        const opts = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
            ? { signal: AbortSignal.timeout(timeoutMs) }
            : {};
        const res = await io.http.fetchJson(`${url}/system_stats`, opts);
        if (res && res.status === 200 && probe.isSystemStats(res.json)) return res.json;
    } catch (_) { /* not this URL */ }
    return null;
}

/** One-line description used by the mode line and the conflict list. */
function describeInstance(i) {
    if (!i) return 'no ComfyUI process';
    const who = i.ours ? 'started by the installer' : 'started outside the installer';
    return `pid ${i.pid} on :${i.port}${i.baseurl || ''} (${who})`;
}

/**
 * Every running ComfyUI of this account, each with its cmdline address and a
 * verification flag. Processes whose address does not answer a ComfyUI
 * payload are still listed (they explain a port conflict) but never chosen.
 */
async function inspectComfyInstances(io, { state = null } = {}) {
    const procs = typeof probe.listRunningComfyUI === 'function'
        ? probe.listRunningComfyUI(io)
        : [];
    const out = [];
    for (const p of procs) {
        const u = comfyUrlFor(p);
        const stats = await verifyComfyUrl(io, u.url);
        out.push({
            ...p,
            url: u.url,
            prefixed: u.prefixed,
            baseurl: u.baseurl,
            ours: isInstallerInstance(p, state),
            verified: !!stats,
        });
    }
    return out;
}

/**
 * Contradictions between the recorded install-state and the machine.
 * @returns {Array<{ key, recorded, actual, message }>}
 */
function stateConflicts(state, resolved) {
    const out = [];
    if (!state) return out;
    const mode = resolved.mode;
    if (state.mode && state.mode !== mode) {
        out.push({
            key: 'mode',
            recorded: state.mode,
            actual: mode,
            message: `mode: ${state.mode} (recorded) → ${mode} (${resolved.reason})`,
        });
    }
    const opts = state.installer_options || {};
    if (mode === 'existing' && opts.startComfyui === true) {
        out.push({
            key: 'startComfyui',
            recorded: true,
            actual: false,
            message: `startComfyui: true (recorded) → false (${resolved.reason} — the installer must not start a second ComfyUI)`,
        });
    }
    if (mode === 'existing' && resolved.port != null && opts.comfyPort != null
        && Number(opts.comfyPort) !== Number(resolved.port)) {
        out.push({
            key: 'comfyPort',
            recorded: Number(opts.comfyPort),
            actual: Number(resolved.port),
            message: `comfyPort: ${opts.comfyPort} (recorded) → ${resolved.port} (from the running process)`,
        });
    }
    const owned = !!(state.components && state.components.comfyui && state.components.comfyui.owned);
    if (mode === 'existing' && owned) {
        out.push({
            key: 'components.comfyui.owned',
            recorded: true,
            actual: false,
            message: `the install state says the installer owns this ComfyUI, but the running instance was ${resolved.foreign ? describeInstance(resolved.foreign) : 'not started by it'}`,
        });
    }
    if (resolved.ours && resolved.foreign) {
        out.push({
            key: 'installer-instance',
            recorded: describeInstance(resolved.ours),
            actual: describeInstance(resolved.foreign),
            message: `two instances run: the installer's own (${describeInstance(resolved.ours)}) and the platform's (${describeInstance(resolved.foreign)}) — the platform's is the real one`,
        });
    }
    return out;
}

/**
 * Resolve the ComfyUI this installation must use — from facts only.
 * @returns {Promise<{
 *   present: boolean, owner: 'foreign'|'managed'|'none', mode: 'existing'|'managed',
 *   url: string|null, port: number|null, baseurl: string|null, pid: number|null,
 *   root: string|null, reason: string, instances: object[],
 *   foreign: object|null, ours: object|null, conflicts: object[],
 *   stop_offer: { pid: number, port: number }|null
 * }>}
 */
async function resolveComfyOwner(io, { state = null, root = null, timeoutMs = 3000 } = {}) {
    const instances = await inspectComfyInstances(io, { state });
    const verified = instances.filter((i) => i.verified);
    const foreign = verified.find((i) => !i.ours) || null;
    const ours = instances.find((i) => i.ours) || null;

    let mode;
    let owner;
    let chosen = null;
    let reason;
    if (foreign) {
        owner = 'foreign';
        mode = 'existing';
        chosen = foreign;
        reason = `a ComfyUI the installer did not start is running — ${describeInstance(foreign)}`;
    } else if (ours) {
        owner = 'managed';
        mode = 'managed';
        chosen = ours;
        reason = `the installer's own ComfyUI is running — ${describeInstance(ours)}`;
    } else {
        // Nothing runs. Disk truth decides:
        //   - the installer created this ComfyUI → managed (start it);
        //   - a ComfyUI exists at the root but is down → existing (the user's
        //     instance is never taken over by starting our own);
        //   - no ComfyUI at the root → managed (a first install clones one).
        const owned = !!(state && state.components && state.components.comfyui && state.components.comfyui.owned);
        const onDisk = !!(root && io.fs.existsSync(path.join(root, 'main.py')));
        owner = 'none';
        if (owned) {
            mode = 'managed';
            reason = `no ComfyUI process is running; the installer created this ComfyUI (managed${root ? `: ${root}` : ''})`;
        } else if (onDisk) {
            mode = 'existing';
            reason = `a ComfyUI exists at ${root} but does not run — the user starts it (existing)`;
        } else {
            mode = 'managed';
            reason = `no ComfyUI ${root ? `at ${root} ` : ''}and none running — the installer sets one up (managed)`;
        }
    }

    const resolved = {
        present: !!chosen,
        owner,
        mode,
        url: chosen ? chosen.url : null,
        port: chosen ? chosen.port : null,
        baseurl: chosen ? chosen.baseurl : null,
        pid: chosen ? chosen.pid : null,
        root: chosen && chosen.root ? chosen.root : null,
        reason,
        instances,
        foreign,
        ours,
        conflicts: [],
        stop_offer: (ours && foreign) ? { pid: ours.pid, port: ours.port } : null,
    };
    resolved.conflicts = stateConflicts(state, resolved);
    return resolved;
}

/**
 * Stop ONE process that was classified as the installer's own instance.
 * Refuses anything else — a foreign ComfyUI is never signaled.
 * @returns {{ stopped: boolean, reason?: string }}
 */
function stopInstallerInstance(io, instance) {
    if (!instance || !instance.ours) {
        return { stopped: false, reason: 'refusing to stop a ComfyUI the installer did not start' };
    }
    try {
        if (typeof io.kill === 'function') io.kill(instance.pid, 'SIGTERM');
        else process.kill(instance.pid, 'SIGTERM');
        return { stopped: true };
    } catch (err) {
        return { stopped: false, reason: err.message };
    }
}

/**
 * May this run start its OWN ComfyUI?
 *   - owner 'foreign' → never (a second instance next to the platform's is
 *     the bug this release fixes); an explicit --start-comfy is ignored and
 *     reported;
 *   - otherwise an explicit flag wins, then the remembered setting, then the
 *     mode (managed starts by default, existing does not).
 * @returns {{ startComfyui: boolean, ignored_request: boolean, corrected: boolean, reason: string }}
 */
function decideStartComfy({ owner = 'none', requested = undefined, remembered = undefined, mode = 'existing' } = {}) {
    if (owner === 'foreign') {
        return {
            startComfyui: false,
            ignored_request: requested === true,
            corrected: requested === true || remembered === true,
            reason: 'another ComfyUI already runs on this machine — the installer never starts a second one',
        };
    }
    if (requested !== undefined) return { startComfyui: requested === true, ignored_request: false, corrected: false, reason: 'requested' };
    if (remembered !== undefined) return { startComfyui: remembered === true, ignored_request: false, corrected: false, reason: 'remembered setting' };
    return { startComfyui: mode === 'managed', ignored_request: false, corrected: false, reason: mode === 'managed' ? 'managed mode starts its own ComfyUI' : 'existing mode leaves the running ComfyUI alone' };
}

/**
 * Wait until the platform's ComfyUI answers at `url` (boot script: the
 * platform starts it after the installer). Polls GET /system_stats.
 * @returns {Promise<{ ok: boolean, url: string|null, waited_ms: number }>}
 */
async function waitForComfyUrl(io, { url = null, timeoutMs = 180000, intervalMs = 3000 } = {}) {
    const deadline = io.now() + timeoutMs;
    let last = null;
    for (;;) {
        const target = url || last;
        if (target) {
            const stats = await verifyComfyUrl(io, target, { timeoutMs: Math.min(3000, intervalMs) });
            if (stats) return { ok: true, url: target, waited_ms: Math.max(0, io.now() - (deadline - timeoutMs)) };
        }
        if (io.now() > deadline) {
            return { ok: false, url: target || url, waited_ms: timeoutMs };
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

/**
 * True when the RECORDED installation says "this ComfyUI belongs to the
 * platform" (installer 0.2.3, type A): a previous run saw a foreign
 * instance (state.comfy_owner.owner === 'foreign'), or the installation is
 * an `existing` one / never starts its own ComfyUI and did not create it.
 * A managed install of a clean Ubuntu (type B: owned, startComfyui=true) is
 * never platform-owned.
 */
function platformOwnedByRecord(state) {
    if (!state) return false;
    if (state.comfy_owner && state.comfy_owner.owner === 'foreign') return true;
    const owned = !!(state.components && state.components.comfyui && state.components.comfyui.owned);
    if (owned) return false;
    const opts = state.installer_options || {};
    return state.mode === 'existing' || opts.startComfyui === false;
}

/** The platform message for type A when ComfyUI never came up. */
function platformComfyMissingReason(waitedMs, lastSeen = null) {
    const secs = Math.round(Number(waitedMs || 0) / 1000);
    const seen = lastSeen && lastSeen.pid
        ? ` (process pid ${lastSeen.pid} at ${lastSeen.url} did not answer GET /system_stats)`
        : ' (no ComfyUI main.py process appeared)';
    return `ComfyUI is started by the platform; it did not come up in ${secs} s${seen}`;
}

/**
 * Boot (type A): wait until the PLATFORM's ComfyUI runs AND answers. Every
 * poll re-reads the processes (pgrep + /proc cmdline) and re-verifies GET
 * /system_stats at the address built from THAT cmdline — the port and the
 * notebook prefix of the previous boot are never reused. Progress goes to
 * `onProgress` once per `progressMs` (the boot log).
 * @returns {Promise<{ ok: boolean, instance: object, waited_ms: number, last_seen: { pid, url }|null }>}
 */
async function waitForPlatformComfyUI(io, {
    state = null, root = null, timeoutMs = 180000, intervalMs = 3000, progressMs = 30000,
    onProgress = null, sleep = null,
} = {}) {
    const now = () => (typeof io.now === 'function' ? io.now() : Date.now());
    const pause = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const started = now();
    let nextProgress = started + progressMs;
    let lastSeen = null;
    for (;;) {
        const instance = await resolveComfyOwner(io, { state, root });
        const waited = now() - started;
        if (instance.owner === 'foreign') return { ok: true, instance, waited_ms: waited, last_seen: lastSeen };
        const proc = (instance.instances || []).find((i) => !i.ours) || null;
        lastSeen = proc ? { pid: proc.pid, url: proc.url } : lastSeen;
        if (waited >= timeoutMs) return { ok: false, instance, waited_ms: waited, last_seen: lastSeen };
        if (onProgress && now() >= nextProgress) {
            const what = proc
                ? `process pid ${proc.pid} at ${proc.url} does not answer GET /system_stats yet`
                : 'no ComfyUI main.py process yet';
            onProgress(`waiting for the platform's ComfyUI — ${what} (${Math.round(waited / 1000)} s of ${Math.round(timeoutMs / 1000)} s)`);
            nextProgress += progressMs;
        }
        await pause(Math.min(intervalMs, Math.max(1, timeoutMs - waited)));
    }
}

module.exports = {
    INSTALLER_LISTEN,
    normalizePrefix,
    comfyUrlFor,
    isInstallerInstance,
    verifyComfyUrl,
    inspectComfyInstances,
    stateConflicts,
    resolveComfyOwner,
    decideStartComfy,
    stopInstallerInstance,
    waitForComfyUrl,
    describeInstance,
    platformOwnedByRecord,
    platformComfyMissingReason,
    waitForPlatformComfyUI,
};
