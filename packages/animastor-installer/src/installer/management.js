'use strict';

/**
 * Management Tools runtime — shared logic for the installer and the
 * command-line management tools installed next to the worker
 * (tools/status.sh, tools/reboot-worker.sh, tools/reboot-comfyui.sh,
 * tools/comfyui-monitor.sh).
 *
 * The tools are thin CLI entry points; ALL runtime behaviour lives here and
 * reuses the installer engine primitives — there is exactly ONE
 * implementation of managed ComfyUI discovery (engine/comfyui.js
 * findManagedComfyUIPids / restartManagedComfyUI), managed worker discovery
 * (engine/worker.js findRunningWorkerPid / restartManagedWorker), port
 * handling (installer_options / comfyui_runtime state) and terminal UX
 * (engine/term.js createTermRenderer + busy spinner).
 *
 * Safety invariants (mirrors the installer):
 *   - no global pkill/killall: only cwd-verified managed processes are
 *     signaled, and only ones owned by the current account (uid guard);
 *   - cross-tenant safety: paths and the install state's owner_uid go through
 *     the same ownership guard as the installer (prereq.checkOwnership);
 *   - tools never create root-owned files: the ownership guard blocks a sudo
 *     run against a user-owned installation;
 *   - read-only tools (status/monitor) never write state; reboot tools write
 *     only the runtime log files the engine's spawnDaemon already manages.
 *
 * ComfyUI API usage (v0.11.x, graceful fallback everywhere):
 *   GET /system_stats  — API reachability (comfyui.systemStats)
 *   GET /queue         — queue_running / queue_pending
 *   GET /history?max_items=N (fallback: /history) — recent errors
 * The monitor NEVER invents data it could not retrieve: unknown values are
 * rendered as "—" and unavailable blocks are omitted.
 */

const path = require('path');
const platforms = require('./platform');
const comfyui = require('./engine/comfyui');
const workerMod = require('./engine/worker');
const stateMod = require('./engine/state');
const prereq = require('./engine/prereq');
const comfyOwner = require('./engine/comfy-owner');

/** Adapter for one call (explicit override wins over auto-detect). */
function adapterOf(opts = {}) {
    return (opts && opts.platformAdapter) || platforms.getPlatformAdapter();
}

/**
 * The installed command-line tools (wrapper script → CLI subcommand).
 * `file` is the canonical (historical, Linux) file name; the platform
 * adapter maps it to the platform-appropriate script name (.sh → .cmd).
 */
const TOOL_SCRIPTS = Object.freeze([
    { file: 'status.sh', command: 'status' },
    { file: 'reboot-worker.sh', command: 'reboot-worker' },
    { file: 'reboot-comfyui.sh', command: 'reboot-comfyui' },
    { file: 'comfyui-monitor.sh', command: 'monitor' },
]);

// ---------------------------------------------------------------------------
// Runtime target resolution (one installation = one state file + roots)
// ---------------------------------------------------------------------------

/**
 * Resolve the runtime targets of THIS installation.
 * Precedence: explicit CLI flags > install state > defaults.
 * @returns {{ state, comfyuiRoot, workerDir, port, device, statePath, found: boolean }}
 */
function resolveTargets(io, { statePath, root = null, workerDir = null, port = null } = {}) {
    const st = statePath ? stateMod.loadState(io, statePath) : null;
    const comfyuiRoot = root || (st && st.root) || null;
    const resolvedWorker = workerDir
        || (st && st.components && st.components.worker && st.components.worker.dir)
        || null;
    const resolvedPort = port
        || (st && st.comfyui_runtime && st.comfyui_runtime.port)
        || null;
    const found = !!(comfyuiRoot || resolvedWorker || st);
    return {
        state: st,
        comfyuiRoot,
        workerDir: resolvedWorker,
        port: resolvedPort,
        device: st ? st.device : null,
        statePath,
        found,
    };
}

/**
 * Ownership guard for every tool invocation: blocks running as root against
 * a user-owned installation (sudo mixing) and operating on another uid's
 * installation. Same rules, same messages as the installer gates.
 * `currentUid`/`home` overrides exist for deterministic tests; production
 * passes nothing and the real uid/home are used.
 * @returns {{ ok: boolean, violations: object[] }}
 */
function checkAccess(io, targets, { currentUid = null, home = null } = {}) {
    return prereq.checkOwnership(io, {
        paths: [targets.comfyuiRoot, targets.workerDir, targets.statePath].filter(Boolean),
        home: home !== null ? home : prereq.currentHome(),
        currentUid: currentUid !== null ? currentUid : prereq.currentUid(),
        stateUid: targets.state && targets.state.owner_uid != null ? targets.state.owner_uid : null,
    });
}

/** Extract the --port value from a process cmdline (platform adapter). */
function readPidPort(io, pid, opts = {}) {
    const parts = adapterOf(opts).readProcessCmdline(io, pid);
    if (parts && Array.isArray(parts)) {
        const i = parts.indexOf('--port');
        if (i !== -1 && parts[i + 1]) return Number(parts[i + 1]);
    }
    return null;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * Snapshot of the managed runtime. Reuses the managed discovery primitives:
 *   - Worker: engine/worker.findRunningWorkerPid (cwd-verified)
 *   - ComfyUI: engine/comfyui.findManagedComfyUIPids (cwd-verified — a
 *     foreign ComfyUI on the same port is NEVER reported as ours)
 *   - API: engine/comfyui.systemStats (GET /system_stats)
 *   - Queue: GET /queue
 * Never throws on unreachable components — unreachable IS the status.
 */
async function collectStatus(io, targets, opts = {}) {
    const adapter = adapterOf(opts);
    const workerPid = targets.workerDir
        ? workerMod.findRunningWorkerPid(io, targets.workerDir, { platformAdapter: adapter })
        : null;
    const comfyRootPresent = !!(targets.comfyuiRoot && io.fs.existsSync(targets.comfyuiRoot));
    const comfyPids = comfyRootPresent
        ? comfyui.findManagedComfyUIPids(io, { root: targets.comfyuiRoot, platformAdapter: adapter })
        : [];
    let port = targets.port || null;
    if (comfyPids.length > 0) {
        port = readPidPort(io, comfyPids[0], { platformAdapter: adapter }) || port;
    }
    // existing/shared mode: the ComfyUI is the user's own (not discoverable
    // as "ours") — its API is the COMFY_URL the installer probed into .env.
    const external = !!(targets.state && targets.state.mode && targets.state.mode !== 'managed');
    const envVals = targets.workerDir ? workerMod.readEnvValues(io, targets.workerDir) : {};
    let baseUrl = port ? `http://127.0.0.1:${port}` : null;
    if (external && envVals.COMFY_URL) baseUrl = envVals.COMFY_URL;
    // Who started the ComfyUI (installer 0.2.3): a running main.py the
    // installer did not start is the PLATFORM's — its address comes from its
    // own cmdline (port/prefix change between boots), not from .env.
    let foreign = null;
    if (external) {
        try {
            const procs = await comfyOwner.inspectComfyInstances(io, { state: targets.state });
            foreign = procs.find((p) => !p.ours && p.verified) || procs.find((p) => !p.ours) || null;
        } catch (_) { foreign = null; }
        if (foreign && foreign.verified) baseUrl = foreign.url;
    }
    const startedBy = !external ? 'installer'
        : foreign ? 'platform'
            : comfyOwner.platformOwnedByRecord(targets.state) && targets.state.comfy_owner ? 'platform' : 'user';
    const stats = baseUrl ? await comfyui.systemStats(io, baseUrl) : null;
    // Hub heartbeat as the worker itself reports it (its log).
    let hub = null;
    if (workerPid && targets.workerDir) {
        const logFile = workerMod.workerLogPath(targets.workerDir);
        if (io.fs.existsSync(logFile)) {
            const scan = workerMod.scanWorkerLog(String(io.fs.readFileSync(logFile, 'utf8')));
            hub = { heartbeat: scan.heartbeat, comfy_ready: scan.comfy_ready, last_error: scan.last_beacon_error || scan.last_comfy_error || null };
        }
    }
    let queue = null;
    if (stats && baseUrl) {
        try {
            const r = await io.http.fetchJson(`${baseUrl}/queue`);
            if (r.status === 200 && r.json && Array.isArray(r.json.queue_running)) {
                queue = {
                    running: r.json.queue_running.length,
                    pending: (r.json.queue_pending || []).length,
                };
            }
        } catch (_) { /* queue is optional */ }
    }
    return {
        worker: { running: !!workerPid, pid: workerPid || null },
        comfyui: {
            running: comfyPids.length > 0, root_present: comfyRootPresent, port, pids: comfyPids, external, url: baseUrl,
            started_by: startedBy, foreign_pid: foreign ? foreign.pid : null,
        },
        api: { ok: !!stats },
        queue,
        hub,
    };
}

/** Render the `Animastor status` block. */
function renderStatus(snapshot) {
    const ok = '✓';
    const bad = '✗';
    const lines = [];
    lines.push('Animastor status');
    lines.push('');
    lines.push(`Worker:   ${snapshot.worker.running ? `${ok} RUNNING` : `${bad} STOPPED`}`);
    if (snapshot.comfyui.external) {
        const c = snapshot.comfyui;
        const state = snapshot.api.ok ? `${ok} RUNNING` : `${bad} UNREACHABLE`;
        if (c.started_by === 'platform') {
            const pid = c.foreign_pid ? `pid ${c.foreign_pid}` : 'no process running';
            lines.push(`ComfyUI:  ${state} — started by the platform (${pid})${c.url ? `, ${c.url}` : ''}`);
        } else {
            lines.push(`ComfyUI:  ${state} (your own${c.url ? `, ${c.url}` : ''})`);
        }
    } else {
        lines.push(`ComfyUI:  ${snapshot.comfyui.running
            ? `${ok} RUNNING${snapshot.comfyui.port ? ` :${snapshot.comfyui.port}` : ''}`
            : `${bad} STOPPED`}`);
    }
    lines.push(`API:      ${snapshot.api.ok ? `${ok} OK` : `${bad} UNREACHABLE`}`);
    if (snapshot.queue) {
        lines.push(`Queue:    ${snapshot.queue.running} running / ${snapshot.queue.pending} pending`);
    } else {
        lines.push('Queue:    — (API unreachable)');
    }
    if (snapshot.hub) {
        lines.push(`Hub:      ${snapshot.hub.heartbeat ? `${ok} ONLINE (heartbeat accepted)` : `${bad} no heartbeat${snapshot.hub.last_error ? ` — ${snapshot.hub.last_error}` : (snapshot.hub.comfy_ready ? '' : ' — worker has not reached ComfyUI')}`}`);
    }
    return lines.join('\n');
}

/** Exit code for a status snapshot: 0 healthy, 1 degraded. */
function statusExitCode(snapshot) {
    const comfyOk = snapshot.comfyui.running || (snapshot.comfyui.external && snapshot.api.ok);
    const hubOk = !snapshot.hub || snapshot.hub.heartbeat;
    return snapshot.worker.running && comfyOk && snapshot.api.ok && hubOk ? 0 : 1;
}

// ---------------------------------------------------------------------------
// reboot-worker / reboot-comfyui
// ---------------------------------------------------------------------------

/**
 * Restart THIS installation's worker. Managed-only and uid-guarded via
 * engine/worker.restartManagedWorker (no global pkill/killall). Correctly
 * handles the already-stopped case (skips the stop step and just starts).
 * @returns {{ ok: boolean, healthy: boolean, detail: string|null }}
 */
async function restartWorker(io, targets, { term = null, log = null, stopTimeoutMs = 15000, platformAdapter = null } = {}) {
    const withBusy = (label, fn) => (term ? term.withBusy(label, fn) : fn());
    const withBusySync = (label, fn) => (term ? term.withBusySync(label, fn) : fn());
    const wasRunning = !!workerMod.findRunningWorkerPid(io, targets.workerDir, { platformAdapter });

    if (wasRunning) {
        await withBusy('Stopping Worker', async () => {
            const stop = await workerMod.stopManagedWorker(io, { workerDir: targets.workerDir, stopTimeoutMs, log, platformAdapter });
            if (!stop.stopped) throw new Error(stop.reason || 'worker could not be stopped');
            return stop;
        });
    }
    const start = withBusySync(wasRunning ? 'Starting Worker' : 'Starting Worker (was stopped)', () =>
        workerMod.startWorker(io, { workerDir: targets.workerDir, log, platformAdapter }));
    if (!start.started) {
        return { ok: false, healthy: false, detail: start.reason || 'worker could not be started' };
    }
    // startWorker already waited the grace period and verified the process is
    // alive (ps args check) — that IS the runtime's worker health check.
    if (!start.alive) {
        return { ok: false, healthy: false, detail: start.reason || 'worker exited immediately — see the worker log' };
    }
    return { ok: true, healthy: true, detail: start.already_running ? 'already running' : null };
}

/**
 * Restart THIS installation's managed ComfyUI. REUSES the installer engine:
 *   - running  → engine/comfyui.restartManagedComfyUI (managed discovery,
 *                uid-guarded via allowedUids, API wait built in);
 *   - stopped  → engine/comfyui.startComfyUI + waitForApi (the same
 *                primitives the installer's verification step uses).
 * @returns {{ ok: boolean, port: number|null, detail: string|null }}
 */
async function restartComfyUI(io, targets, { term = null, log = null, verifyTimeoutMs = 120000, pollIntervalMs = 2000, platformAdapter = null } = {}) {
    const adapter = adapterOf({ platformAdapter });
    const withBusy = (label, fn) => (term ? term.withBusy(label, fn, { minShowMs: 200 }) : fn());
    if (!targets.comfyuiRoot || !io.fs.existsSync(targets.comfyuiRoot)) {
        return { ok: false, port: null, detail: `ComfyUI root not found${targets.comfyuiRoot ? ` (${targets.comfyuiRoot})` : ''}` };
    }
    const me = prereq.currentUid();
    const allowedUids = me != null ? [me] : null;
    const pids = comfyui.findManagedComfyUIPids(io, { root: targets.comfyuiRoot, platformAdapter: adapter });
    let port = targets.port || null;
    if (pids.length > 0) port = readPidPort(io, pids[0], { platformAdapter: adapter }) || port;

    if (pids.length > 0) {
        const res = await withBusy('Restarting ComfyUI', () => comfyui.restartManagedComfyUI(io, {
            root: targets.comfyuiRoot,
            port: port || 8188,
            device: targets.device || null,
            log,
            verifyTimeoutMs,
            pollIntervalMs,
            allowedUids,
            platformAdapter: adapter,
        }));
        if (!res.restarted) {
            return { ok: false, port, detail: res.reason || 'managed ComfyUI was not restarted' };
        }
        if (!res.up) {
            return { ok: true, port, detail: res.reason || 'ComfyUI restarted but the API did not come up — see the ComfyUI log', up: false };
        }
        return { ok: true, port, detail: null };
    }
    // stopped → start (same primitives as the installer's start step)
    const res = await withBusy('Starting ComfyUI (was stopped)', async () => {
        const started = comfyui.startComfyUI(io, {
            root: targets.comfyuiRoot,
            port: port || 8188,
            device: targets.device || null,
            platformAdapter: adapter,
        });
        const up = await comfyui.waitForApi(io, `http://127.0.0.1:${started.port}`, { timeoutMs: verifyTimeoutMs, intervalMs: pollIntervalMs });
        return { started, up };
    });
    if (!res.up.ok) {
        return { ok: true, port: res.started.port, detail: res.up.reason, up: false };
    }
    return { ok: true, port: res.started.port, detail: null };
}

// ---------------------------------------------------------------------------
// comfyui-monitor
// ---------------------------------------------------------------------------

/** Best-effort job kind from a queue entry's prompt graph (never throws). */
function guessJobKind(queueEntry) {
    try {
        const prompt = queueEntry && queueEntry[2];
        const classes = [];
        if (prompt && typeof prompt === 'object') {
            if (Array.isArray(prompt.nodes)) {
                for (const n of prompt.nodes) if (n && (n.class_type || n.type)) classes.push(String(n.class_type || n.type));
            } else {
                for (const n of Object.values(prompt)) {
                    if (n && typeof n === 'object' && n.class_type) classes.push(String(n.class_type));
                }
            }
        }
        const joined = classes.join(' ');
        if (/tts|audio|voice|speech/i.test(joined)) return 'audio generation';
        if (/video|svd|vhs|animate|framepack/i.test(joined)) return 'video generation';
        if (/upscale/i.test(joined)) return 'upscale';
        if (/ksampler|checkpoint|clip|vae|latent|diffusion/i.test(joined)) return 'image generation';
        if (classes.length > 0) return classes[0];
    } catch (_) { /* never */ }
    return 'workflow';
}

function fmtClock(tsMs) {
    try {
        const d = new Date(Number(tsMs));
        if (Number.isNaN(d.getTime())) return null;
        const p = (n) => String(n).padStart(2, '0');
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    } catch (_) {
        return null;
    }
}

/**
 * Collect monitor data from the ComfyUI API with graceful fallback:
 *   - /system_stats down → api.ok=false (monitor still renders, exit 1);
 *   - /queue unavailable → queue section omitted;
 *   - /history?max_items unavailable → retries plain /history;
 *   - running-job duration/progress are not exposed by the supported
 *     ComfyUI REST API → rendered as "—", never invented.
 */
async function collectMonitor(io, targets, { historyMax = 24 } = {}) {
    const port = targets.port || 8188;
    const base = `http://127.0.0.1:${port}`;
    const stats = await comfyui.systemStats(io, base);

    let queue = null;
    try {
        const r = await io.http.fetchJson(`${base}/queue`);
        if (r.status === 200 && r.json && Array.isArray(r.json.queue_running)) {
            queue = { running: r.json.queue_running || [], pending: r.json.queue_pending || [] };
        }
    } catch (_) { /* optional */ }

    let history = null;
    try {
        let r = await io.http.fetchJson(`${base}/history?max_items=${historyMax}`);
        if (!(r.status === 200 && r.json)) r = await io.http.fetchJson(`${base}/history`);
        if (r.status === 200 && r.json) history = r.json;
    } catch (_) { /* optional */ }

    const errors = [];
    if (history && typeof history === 'object') {
        for (const [promptId, entry] of Object.entries(history)) {
            const status = entry && entry.status;
            if (!status || status.status_str !== 'error') continue;
            for (const msg of status.messages || []) {
                const [event, data] = Array.isArray(msg) ? msg : [null, null];
                if (event !== 'execution_error' || !data || typeof data !== 'object') continue;
                errors.push({
                    prompt_id: promptId,
                    node_type: data.node_type || null,
                    message: String(data.exception_message || data.exception_type || 'execution error'),
                    timestamp: data.timestamp || null,
                });
            }
        }
    }
    errors.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    return {
        port,
        api: { ok: !!stats },
        stats,
        queue,
        errors: errors.slice(0, 5),
    };
}

/** Render the `Animastor ComfyUI Monitor` block. */
function renderMonitor(data) {
    const ok = '✓';
    const bad = '✗';
    const lines = [];
    lines.push('Animastor ComfyUI Monitor');
    lines.push('────────────────────────────────────');
    lines.push('');
    lines.push(`ComfyUI:  ${data.api.ok ? `${ok} RUNNING` : `${bad} NOT RESPONDING`}`);
    lines.push(`API:      ${data.api.ok ? `${ok} OK` : `${bad} UNREACHABLE`}`);
    lines.push(`Port:     ${data.port}`);
    if (data.stats && data.stats.system && data.stats.system.comfyui_version) {
        lines.push(`Version:  ${data.stats.system.comfyui_version}`);
    }

    if (!data.queue) {
        lines.push('');
        lines.push('Queue     — (unavailable)');
    } else {
        const running = data.queue.running || [];
        const pending = data.queue.pending || [];
        lines.push('');
        lines.push('Queue');
        lines.push(`  Running: ${running.length}`);
        lines.push(`  Pending: ${pending.length}`);
        if (running.length === 0 && pending.length === 0) {
            lines.push('  Status: empty');
        }

        if (running.length > 0) {
            lines.push('');
            lines.push('Running');
            for (const entry of running.slice(0, 5)) {
                const id = entry && entry[1] ? String(entry[1]) : '?';
                // duration/progress are not exposed by the REST API — shown as "—"
                lines.push(`  #${id}  ${guessJobKind(entry)}  —`);
            }
        }
        if (pending.length > 0) {
            lines.push('');
            lines.push('Pending');
            for (const entry of pending.slice(0, 8)) {
                const id = entry && entry[1] ? String(entry[1]) : '?';
                lines.push(`  #${id}  ${guessJobKind(entry)}  waiting`);
            }
            if (pending.length > 8) lines.push(`  … ${pending.length - 8} more`);
        }
    }

    if (data.errors.length > 0) {
        lines.push('');
        lines.push('Recent errors');
        for (const e of data.errors) {
            const when = e.timestamp ? fmtClock(e.timestamp) : null;
            const head = String(e.message).split('\n')[0].slice(0, 120);
            lines.push(`  [${when || '—'}] ${e.node_type || 'node'}: ${head}`);
        }
    }
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tools installation (installer component)
// ---------------------------------------------------------------------------

/**
 * Render one tool wrapper. The wrapper is a THIN shim: all runtime behaviour
 * lives in the installer CLI (`management.js`), so there is exactly one
 * implementation of discovery/restart logic for installer and tools.
 * Delegates to the platform adapter (#!/bin/sh on Linux, .cmd on Windows).
 */
function renderToolScript({ command, nodePath, cliPath, statePath, root, workerDir, platformAdapter = null }) {
    return adapterOf({ platformAdapter }).renderToolScript({ command, nodePath, cliPath, statePath, root, workerDir });
}

/**
 * Where the `animastor` command is linked: ALWAYS ~/.local/bin (XDG user
 * bin, created when missing) — root included. E2E nodes only keep /home
 * across a reboot, so a /usr/local/bin link would vanish while the
 * installation in $HOME survived; the command must survive with it.
 * `uid` stays in the signature because callers/tests pass it.
 */
function defaultLinkDir({ uid = prereq.currentUid(), home = prereq.currentHome() } = {}) {
    if (!home) return null;
    return path.join(home, '.local', 'bin');
}

// ---------------------------------------------------------------------------
// PATH persistence
// ---------------------------------------------------------------------------

/** Marker line of the PATH block this installer appends to shell rc files. */
const PATH_MARKER = '# animastor: PATH for the `animastor` command (added by animastor-installer)';

/**
 * Make `dir` reachable in EVERY future login shell: append an idempotent
 * PATH block to ~/.bashrc and ~/.profile when the directory is not there
 * yet. The block keeps the current PATH intact and is added once — re-runs
 * of the installer never duplicate it. Necessary because the link dir is
 * ~/.local/bin (also for root) and many non-login shells skip it.
 * @returns {{ dir: string|null, updated: string[], already: string[] }}
 */
function ensurePathEntry(io, { dir, home = null, files = ['.bashrc', '.profile'] } = {}) {
    if (!dir || !home) return { dir: dir || null, updated: [], already: [] };
    const block = [
        PATH_MARKER,
        `case ":$PATH:" in *":${dir}:"*) ;; *) export PATH="${dir}:$PATH" ;; esac`,
        '',
    ].join('\n');
    const updated = [];
    const already = [];
    for (const name of files) {
        const file = path.join(home, name);
        let text = '';
        try { text = io.fs.existsSync(file) ? String(io.fs.readFileSync(file, 'utf8')) : ''; } catch (_) { text = ''; }
        const present = text.includes(PATH_MARKER)
            || text.split('\n').some((line) => line.includes(dir) && /\bPATH\b/.test(line));
        if (present) { already.push(file); continue; }
        try {
            io.fs.mkdirSync(path.dirname(file), { recursive: true });
            const prefix = text && !text.endsWith('\n') ? '\n' : '';
            io.fs.writeFileSync(file, `${text}${prefix}${block}`);
            updated.push(file);
        } catch (_) { /* best effort — the hint below still tells the user */ }
    }
    return { dir, updated, already };
}

function shQuote(v) {
    return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

/**
 * The `animastor` command (Linux): ONE entry point for the management
 * subcommands — start | stop | status | logs | doctor (+ monitor,
 * reboot-worker, reboot-comfyui). A thin shim: every behaviour lives in the
 * persistent installer CLI; the recorded paths of THIS installation are
 * injected so the command works from any directory.
 */
function renderAnimastorCommand({ nodePath, cliPath, statePath, root, workerDir, hubUrl }) {
    return [
        '#!/bin/sh',
        '# animastor — Animastor GPU worker management (generated by animastor-installer).',
        '# Usage: animastor start | stop | status | logs [-f] | doctor [--new-key] | boot',
        '# Do not edit: re-run the installer (or `animastor doctor`) to refresh.',
        'cmd="${1:-status}"',
        '[ $# -gt 0 ] && shift',
        'case "$cmd" in',
        '  -h|--help|help) echo "usage: animastor start | stop | status | logs [-f] | doctor [--new-key] | boot"; exit 0 ;;',
        'esac',
        `exec ${shQuote(nodePath)} ${shQuote(cliPath)} "$cmd" \\`,
        `  --state ${shQuote(statePath)} \\`,
        `  --root ${shQuote(root || '')} \\`,
        `  --worker-dir ${shQuote(workerDir || '')} \\`,
        `  --hub-url ${shQuote(hubUrl || '')} "$@"`,
        '',
    ].join('\n');
}

/**
 * Copy the installer package (src/, ai/, package.json, bundled workflows /
 * worker files) to a persistent directory — the bootstrap unpacks it into a
 * temp dir that is wiped on exit, and the tools must keep working. Idempotent:
 * the destination is replaced as a whole (never merged with stale files).
 * @returns {string} absolute path of the persistent cli.js
 */
function persistInstaller(io, { srcRoot, destRoot }) {
    const src = path.resolve(srcRoot);
    const dest = path.resolve(destRoot);
    if (src === dest) return path.join(dest, 'src', 'installer', 'cli.js');
    const tmp = `${dest}.tmp-${process.pid}`;
    if (io.fs.existsSync(tmp)) io.fs.rmSync(tmp, { recursive: true, force: true });
    const copyDir = (from, to) => {
        io.fs.mkdirSync(to, { recursive: true });
        for (const name of io.fs.readdirSync(from)) {
            if (name === 'node_modules' || name === '.git' || name === 'tests') continue;
            const a = path.join(from, name);
            const b = path.join(to, name);
            if (io.fs.isDirectory(a)) copyDir(a, b);
            else io.fs.copyFileSync(a, b);
        }
    };
    copyDir(src, tmp);
    if (io.fs.existsSync(dest)) io.fs.rmSync(dest, { recursive: true, force: true });
    io.fs.renameSync(tmp, dest);
    return path.join(dest, 'src', 'installer', 'cli.js');
}

/** True when `dir` is listed in PATH. */
function inPath(dir, envPath = process.env.PATH || '') {
    return String(envPath).split(path.delimiter).some((p) => p && path.resolve(p) === path.resolve(dir));
}

/**
 * Link <linkDir>/animastor → the generated command. An existing link is
 * replaced only when it is a symlink to an `animastor` command generated by
 * the installer (another installation of the same user); a foreign file is
 * never overwritten.
 * @returns {{ link: string|null, command: string, path_hint: string|null, reason?: string }}
 */
function linkAnimastorCommand(io, { target, linkDir }) {
    if (!linkDir || typeof io.fs.symlinkSync !== 'function') {
        return { link: null, command: target, path_hint: null, reason: 'no link directory' };
    }
    const link = path.join(linkDir, 'animastor');
    try {
        io.fs.mkdirSync(linkDir, { recursive: true });
        const existing = typeof io.fs.lstatSync === 'function' ? io.fs.lstatSync(link) : null;
        if (existing) {
            if (!existing.isSymbolicLink) {
                return { link: null, command: target, path_hint: null, reason: `${link} exists and is not an installer link — left untouched` };
            }
            const current = io.fs.readlinkSync(link);
            if (current !== target && !/[\\/]tools[\\/]animastor$/.test(current)) {
                return { link: null, command: target, path_hint: null, reason: `${link} points to ${current} — left untouched` };
            }
            if (current !== target) io.fs.unlinkSync(link);
            else return { link, command: inPath(linkDir) ? 'animastor' : link, path_hint: pathHint(linkDir) };
        }
        io.fs.symlinkSync(target, link);
        return { link, command: inPath(linkDir) ? 'animastor' : link, path_hint: pathHint(linkDir) };
    } catch (err) {
        return { link: null, command: target, path_hint: null, reason: err.message };
    }
}

function pathHint(linkDir) {
    if (inPath(linkDir)) return null;
    return `${linkDir} is not in PATH yet for this shell — open a new login shell, or run: export PATH="${linkDir}:$PATH"`;
}

/**
 * Re-apply the PATH block on every run (installer, doctor AND `animastor
 * start`): E2E nodes reset ~/.bashrc and ~/.profile on every boot, so the
 * block added at install time disappears while the installation in $HOME
 * survives. Idempotent — no duplicate blocks.
 * @returns {{ dir, updated: string[], already: string[] }}
 */
function restoreCommandPath(io, { linkDir = null, home = null } = {}) {
    if (!linkDir) return { dir: null, updated: [], already: [] };
    return ensurePathEntry(io, { dir: linkDir, home: home || (linkDir ? path.resolve(linkDir, '..', '..') : null) });
}

// ---------------------------------------------------------------------------
// Autostart wrapper (~/animastor/start-worker.sh)
// ---------------------------------------------------------------------------

/** Marker of the generated autostart wrapper (never re-backed-up). */
const WRAPPER_MARKER = '# animastor: generated autostart wrapper';

/** ~/animastor/start-worker.sh for <workerDir> = ~/animastor/worker. */
function startWorkerScriptPath(workerDir) {
    if (!workerDir) return null;
    return path.join(path.dirname(path.resolve(workerDir)), 'start-worker.sh');
}

/**
 * The autostart wrapper. It delegates to the persistent `animastor` command:
 * after a reboot the old script apt-installed Node 18 on every boot, waited
 * for port 8188 and knew nothing about the platform's ComfyUI — the command
 * handles PATH, the probed ComfyUI address, missing apt packages and the
 * worker in one place (installer 0.2.2).
 */
function renderStartWorkerWrapper(animastorPath) {
    return [
        '#!/bin/sh',
        `${WRAPPER_MARKER} (installer 0.2.2) — do not edit; re-run: animastor doctor`,
        '# The previous launcher is kept next to this file as start-worker.sh.bak.',
        '# All logic (PATH block, ComfyUI address, apt prerequisites, worker) lives',
        '# in the installer: `animastor start` (and `animastor doctor`).',
        `exec ${shQuote(animastorPath)} start "$@"`,
        '',
    ].join('\n');
}

/**
 * Replace <base>/start-worker.sh with the wrapper (the old script is backed
 * up once). Idempotent: a second run rewrites the same bytes and creates no
 * second backup. Never touches a foreign file without keeping a copy.
 * @returns {{ path: string|null, status: 'created'|'replaced'|'unchanged'|'failed'|'skipped', backup: string|null, reason?: string }}
 */
function ensureStartWorkerWrapper(io, { workerDir, animastorPath = null, backupSuffix = '.bak' } = {}) {
    const file = startWorkerScriptPath(workerDir);
    if (!file || !animastorPath) return { path: file, status: 'skipped', backup: null };
    const wanted = renderStartWorkerWrapper(animastorPath);
    let current = '';
    try { current = io.fs.existsSync(file) ? String(io.fs.readFileSync(file, 'utf8')) : ''; } catch (_) { current = ''; }
    if (current === wanted) return { path: file, status: 'unchanged', backup: null };
    let backup = null;
    if (current && !current.includes(WRAPPER_MARKER)) {
        backup = `${file}${backupSuffix}`;
        try {
            // Keep the FIRST original: a second run must not overwrite the
            // user's only copy with the already-generated wrapper.
            if (!io.fs.existsSync(backup)) io.fs.copyFileSync(file, backup);
        } catch (_) { backup = null; }
    }
    try {
        io.fs.mkdirSync(path.dirname(file), { recursive: true });
        io.fs.writeFileSync(file, wanted);
        io.fs.chmodSync(file, 0o755);
    } catch (err) {
        return { path: file, status: 'failed', backup, reason: err.message };
    }
    return { path: file, status: current ? 'replaced' : 'created', backup };
}

/**
 * Install (or idempotently refresh) the command-line management tools next
 * to the worker. Re-running the installer overwrites the same files —
 * no duplicates, no broken state. Script filenames/extensions and content
 * are platform-specific (platform adapter). On Linux the `animastor` command
 * (start|stop|status|logs|doctor) is generated too and linked into PATH.
 * @returns {{ toolsDir, files: string[], command: string, link: string|null, installerDir: string|null, path_hint: string|null }}
 */
function installManagementTools(io, { toolsDir, nodePath, cliPath, statePath, root, workerDir, hubUrl = null, installerSrcRoot = null, installerDestRoot = null, linkDir = null, home = null, log = null, platformAdapter = null }) {
    const adapter = adapterOf({ platformAdapter });
    io.fs.mkdirSync(toolsDir, { recursive: true });
    let cli = cliPath;
    let installerDir = null;
    if (installerSrcRoot && installerDestRoot) {
        cli = persistInstaller(io, { srcRoot: installerSrcRoot, destRoot: installerDestRoot });
        installerDir = installerDestRoot;
    }
    const files = [];
    for (const t of TOOL_SCRIPTS) {
        const p = path.join(toolsDir, adapter.toolScriptName(t.file));
        io.fs.writeFileSync(p, renderToolScript({
            command: t.command, nodePath, cliPath: cli, statePath, root, workerDir,
            platformAdapter: adapter,
        }));
        io.fs.chmodSync(p, adapter.TOOL_SCRIPT_MODE);
        files.push(p);
    }
    let command = null;
    let link = null;
    let hint = null;
    let pathEntry = null;
    if (adapter.name === 'linux') {
        const p = path.join(toolsDir, 'animastor');
        io.fs.writeFileSync(p, renderAnimastorCommand({ nodePath, cliPath: cli, statePath, root, workerDir, hubUrl }));
        io.fs.chmodSync(p, 0o755);
        files.push(p);
        const linked = linkAnimastorCommand(io, { target: p, linkDir });
        command = linked.command;
        link = linked.link;
        hint = linked.path_hint;
        if (linked.reason && log && log.warn) log.warn(`animastor command not linked into PATH: ${linked.reason} — use ${p}`);
        if (link) {
            // The command lives in ~/.local/bin (also for root) — persist the
            // PATH entry so `animastor doctor` works after a node restart in a
            // fresh shell, without re-installing anything.
            const rcHome = home || (linkDir ? path.resolve(linkDir, '..', '..') : null);
            pathEntry = ensurePathEntry(io, { dir: linkDir, home: rcHome });
            if (log && log.info && pathEntry.updated.length > 0) {
                log.info(`PATH updated for future shells: ${pathEntry.updated.join(', ')}`);
            }
        }
    }
    if (log && log.info) log.info(`management tools installed at ${toolsDir} (${files.length} commands${link ? `; ${link}` : ''})`);
    return { toolsDir, files, command: command || null, link, installerDir, path_hint: hint, path_entry: pathEntry };
}

module.exports = {
    TOOL_SCRIPTS,
    resolveTargets,
    checkAccess,
    readPidPort,
    collectStatus,
    renderStatus,
    statusExitCode,
    restartWorker,
    restartComfyUI,
    collectMonitor,
    renderMonitor,
    guessJobKind,
    renderToolScript,
    renderAnimastorCommand,
    persistInstaller,
    linkAnimastorCommand,
    defaultLinkDir,
    ensurePathEntry,
    restoreCommandPath,
    ensureStartWorkerWrapper,
    startWorkerScriptPath,
    renderStartWorkerWrapper,
    PATH_MARKER,
    WRAPPER_MARKER,
    installManagementTools,
};
