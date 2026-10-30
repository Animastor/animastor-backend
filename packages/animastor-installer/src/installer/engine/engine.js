'use strict';

/**
 * Installation Engine — Private Worker Installer Phase 2.
 *
 * Execution layer. It receives the already-computed install plan (from the
 * Phase 1.5 plan builder) and executes ONLY the operations the plan allows:
 *
 *   Environment detection → Manifest → Compatibility Resolver → Install Plan
 *       → USER CONFIRMATION → Installation Engine → Verification
 *
 * The engine never invents dependencies, URLs, or versions — everything comes
 * from the canonical manifests via resolver/plan. It is idempotent (re-run or
 * `resume` continues where it stopped) and never destroys a user's working
 * configuration on failure.
 *
 * Secrets: the Worker Key enters through `secretProvider` (interactive hidden
 * input in the CLI), is registered for log redaction immediately, and is used
 * only to write .env and to call the hub verify endpoint. It never appears in
 * the plan, state, results, or logs.
 */

const path = require('path');

const platforms = require('../platform');
const resolver = require('../compatibility-resolver');
const { buildInstallPlan } = require('../install-plan');
const { confirmationGate } = require('../safety-rules');
const { planModelDownloads } = require('../download-planner');
const state = require('./state');
const probe = require('./probe');
const comfyui = require('./comfyui');
const nodes = require('./nodes');
const workflowsInstall = require('./workflows');
const downloader = require('./downloader');
const worker = require('./worker');
const repoBundleSource = require('../worker-bundle-source');
const prereq = require('./prereq');
const management = require('../management');
const comfyOwnerMod = require('./comfy-owner');
const { createProgressReporter } = require('./progress');
const { buildVerificationReport } = require('../verification-report');

const CPU_TORCH_INDEX_URL = 'https://download.pytorch.org/whl/cpu';
const CPU_MODE_WARNING = 'CPU-only mode: no supported GPU runtime detected — a CPU build of PyTorch will be installed and ComfyUI will run with --cpu. Performance will be SIGNIFICANTLY lower; this mode is intended for the TTS/audio profile, not for image/video generation.';

function stepById(plan, id) {
    return plan.steps.find((s) => s.id === id) || null;
}

/**
 * Module-level registry of live SIGINT guards. A process runs at most ONE
 * installation at a time; a still-registered handler from a previous
 * crashed/abandoned run is stale and is unregistered when the next run
 * installs its guard (self-healing, no signal-handler leaks).
 */
const ACTIVE_INTERRUPT_HANDLERS = new Set();

function registerInterruptHandler(handler) {
    for (const stale of ACTIVE_INTERRUPT_HANDLERS) {
        process.removeListener('SIGINT', stale);
    }
    ACTIVE_INTERRUPT_HANDLERS.clear();
    ACTIVE_INTERRUPT_HANDLERS.add(handler);
    process.on('SIGINT', handler);
}

function unregisterInterruptHandler(handler) {
    ACTIVE_INTERRUPT_HANDLERS.delete(handler);
    process.removeListener('SIGINT', handler);
}

/**
 * Ctrl+C guard for the installation run.
 *
 * On SIGINT: mark the state as interrupted, mark the in-flight artifact
 * (e.g. a model whose download is mid-flight) as PARTIAL — never installed —
 * persist the resumable state, tell the user, and exit 130. Partial
 * downloads stay on disk as `<file>.part` and are resumed on the next run.
 *
 * Fully injectable (register/unregister/exit/state) for deterministic tests.
 */
function createInterruptGuard({
    state: installState, save, log = null,
    getArtifactId = null,
    exit = (code) => process.exit(code),
    register = registerInterruptHandler,
    unregister = unregisterInterruptHandler,
}) {
    let triggered = false;
    const handler = () => {
        if (triggered) { exit(130); return; } // second Ctrl+C: force exit
        triggered = true;
        try {
            installState.interrupted = true;
            installState.interrupted_at = new Date().toISOString();
            const id = getArtifactId ? getArtifactId() : null;
            if (id) state.setArtifact(installState, id, 'partial', { reason: 'interrupted by user (Ctrl+C) — download is resumable' });
            try { save(); } catch (_) { /* best effort */ }
            if (log && log.error) log.error('Interrupted (Ctrl+C) — progress saved. Partial downloads are marked and will resume on the next run (`resume` or re-run `install`).');
        } catch (_) { /* never throw from a signal handler */ }
        exit(130);
    };
    register(handler);
    return () => unregister(handler);
}

/**
 * Pick the torch spec for the detected device branch.
 *   device='cuda' (default) — canonical pin, or known-working reference with
 *   explicit consent (unchanged Phase 2 behaviour).
 *   device='cpu' — the manifest's dedicated CPU build (spec.cpu) is a
 *   first-class branch; without one, a CPU spec is derived from the existing
 *   pin/reference by stripping the CUDA local tag (explicitly warned, never
 *   silent).
 */
function pickTorchSpec(manifests, decisions, warnings, device = null) {
    if (device === 'cpu') {
        for (const m of manifests) {
            const spec = (m.runtime_requirements || {}).torch || {};
            if (spec.cpu && spec.cpu.pin) {
                return {
                    spec: { pin: spec.cpu.pin, index_url: spec.cpu.index_url || CPU_TORCH_INDEX_URL },
                    grade: 'cpu-canonical',
                };
            }
        }
        for (const m of manifests) {
            const spec = (m.runtime_requirements || {}).torch || {};
            const raw = spec.pin
                || (spec.known_working_reference && spec.known_working_reference.version)
                || null;
            if (raw) {
                const base = String(raw).split('+')[0];
                warnings.push(`manifest has no dedicated CPU torch build — deriving CPU spec from ${raw}: installing torch ${base} from ${CPU_TORCH_INDEX_URL}`);
                return { spec: { pin: base, index_url: CPU_TORCH_INDEX_URL }, grade: 'cpu-derived' };
            }
        }
        return null;
    }
    for (const m of manifests) {
        const spec = (m.runtime_requirements || {}).torch || {};
        if (spec.pin) return { spec, grade: 'canonical' };
    }
    for (const m of manifests) {
        const spec = (m.runtime_requirements || {}).torch || {};
        if (spec.known_working_reference && spec.known_working_reference.version) {
            if (decisions.accept_reference_runtime === true) {
                const ref = spec.known_working_reference;
                return {
                    spec: { pin: ref.version, index_url: ref.index_url || null },
                    grade: 'reference',
                };
            }
            warnings.push(`canonical torch pin is unknown (D1); known-working reference is ${spec.known_working_reference.version} — pass accept_reference_runtime to install it`);
            return null;
        }
    }
    return null;
}

/** Non-secret decision keys persisted to install-state.json for `resume`. */
const PERSISTED_DECISION_KEYS = Object.freeze([
    'comfyui_update', 'install_custom_nodes', 'install_models',
    'workflows', 'restore_baseline', 'worker_setup', 'worker_key_provided',
    'accept_reference_runtime', 'accept_runtime_change',
    'install_management_tools',
]);

function sanitizeDecisions(decisions) {
    const out = {};
    for (const k of PERSISTED_DECISION_KEYS) {
        if (decisions[k] !== undefined) out[k] = decisions[k];
    }
    return out;
}

/**
 * Load resumable install state or produce a resumable-not-possible verdict.
 * @returns {{ ok: true, state } | { ok: false, reason }}
 */
function loadResumableState(io, statePath) {
    const st = state.loadState(io, statePath);
    if (!st) return { ok: false, reason: 'no-state-file' };
    if (!st.profiles || !Array.isArray(st.profiles) || st.profiles.length === 0) {
        return { ok: false, reason: 'state-has-no-profiles' };
    }
    return { ok: true, state: st };
}

/** Render prior-progress summary lines from a saved state. */
function renderResumeSummary(st) {
    const ids = Object.keys(st.artifacts || {});
    if (ids.length === 0) return ['Prior progress: nothing recorded yet'];
    const marks = { verified: '✓', installed: '✓', failed: '✗', partial: '~', missing: '·' };
    const lines = ['Prior progress (from install-state.json):'];
    if (st.interrupted) {
        lines.push(`  Previous run was interrupted (Ctrl+C)${st.interrupted_at ? ` at ${st.interrupted_at}` : ''} — partial downloads will resume.`);
    }
    for (const id of ids.sort()) {
        const a = st.artifacts[id];
        lines.push(`  ${marks[a.status] || '·'} ${id}: ${a.status}${a.attempts ? ` (${a.attempts} failed attempt(s))` : ''}`);
    }
    return lines;
}

/**
 * Run the installation.
 *
 * @param {object} args
 * @param {object[]} args.manifests - loaded canonical manifests
 * @param {string} args.mode - managed | existing | shared
 * @param {object} args.io - io adapter (real, mock, or dry-run guarded)
 * @param {object} args.roots - { comfyuiRoot, workerDir, statePath, repoRoot, hubUrl }
 * @param {object} [args.decisions] - recorded user decisions (never secret values)
 * @param {Function} [args.secretProvider] - async (name) => value (hidden input)
 * @param {object} [args.logger]
 * @param {object} [args.crypto] - crypto module (hashing)
 * @param {object} [args.env] - pre-probed environment (else probed here)
 * @param {boolean} [args.dryRun]
 * @param {object} [args.initialState] - pre-loaded install state (`resume`); when
 *   given, it is used as-is and never reset
 * @param {object} [args.options] - { startComfyui, comfyPort, verifyTimeoutMs }
 */
async function runInstallation(args) {
    const {
        manifests, mode, io, roots,
        decisions = {}, secretProvider = null,
        logger = null, crypto = null, env: preEnv = null,
        dryRun = false, initialState = null, options = {},
        platformAdapter: platformAdapterOpt = null,
    } = args;

    // Platform adapter (auto-detected unless injected): every OS-specific
    // behaviour below (venv layout, process ops, build tools) goes through it.
    const platformAdapter = platformAdapterOpt || platforms.getPlatformAdapter();

    const log = logger || { info: () => {}, warn: () => {}, error: () => {}, output: () => {}, step: async (n, fn) => ({ ok: true, value: await fn() }), registerSecret: () => {} };
    const {
        comfyuiRoot, workerDir, statePath,
        repoRoot = null, hubUrl = null, toolsDir = null,
    } = roots;

    // Busy indicator for long subprocess steps (pip/npm/git/waiting): ONE
    // shared spinner through the terminal renderer. Without a term (tests,
    // library use) it is a no-op passthrough.
    const term = options.term || null;
    const withBusy = (label, fn, o) => (term ? term.withBusy(label, fn, o) : fn());
    const withBusySync = (label, fn) => (term ? term.withBusySync(label, fn) : fn());

    const result = {
        status: 'incomplete',
        mode,
        plan: null,
        report: null,
        results: {
            comfyui: null, runtime: null, custom_nodes: [], models: [],
            workflows: [], worker: [], registration: null,
        },
        blocked: [],
        warnings: [],
        verification: null,
        remediation: null,
    };

    // ── 1. detect ─────────────────────────────────────────────────────────
    // In dry-run mode, skip probing (io.exec is guarded) — use provided env or minimal.
    const env = preEnv || (dryRun
        ? { gpu: null, device: 'cpu', comfyui: null, python: null, torch: null, nodejs: null, custom_nodes: [], models: [], workflows: [], worker: null }
        : probe.probeEnvironment(io, {
            root: comfyuiRoot, workerDir, crypto,
            workerType: manifests.length === 1 ? (manifests[0].worker_bundle || {}).worker_type : null,
        })
    );
    const device = env.device || (env.gpu ? 'cuda' : 'cpu');
    if (device === 'cpu') {
        result.warnings.push(CPU_MODE_WARNING);
        if (env.gpu && env.gpu.vendor === 'amd') {
            result.warnings.push('AMD GPU detected, but the installer provides no ROCm/accelerated runtime branch yet — falling back to CPU-only mode.');
        }
    }

    // ── 2. resolve ────────────────────────────────────────────────────────
    const report = resolver.resolveInstallation({
        manifests,
        environment: env,
        mode: mode === 'shared' ? 'shared' : mode,
    });
    result.report = report;

    // ── 3. plan ───────────────────────────────────────────────────────────
    const plan = buildInstallPlan({ report, manifests, decisions });
    result.plan = plan;

    if (plan.blocked.length > 0) {
        result.status = 'blocked';
        result.blocked = plan.blocked;
        log.warn(`installation blocked: ${plan.blocked.map((b) => b.reason).join('; ')}`);
        return result;
    }
    if (dryRun) {
        result.status = 'dry_run';
        return result;
    }
    if (plan.awaiting_decisions.length > 0) {
        result.status = 'awaiting_decisions';
        return result;
    }

    // ── 4. execute ────────────────────────────────────────────────────────
    // State is an OPTIMIZATION; disk truth is always re-checked before doing.
    const st = initialState
        || state.loadState(io, statePath)
        || state.emptyState({ mode, profiles: report.profiles, root: comfyuiRoot });
    state.normalizeState(st);
    st.profiles = report.profiles;
    st.device = device;
    if (!dryRun) {
        // persist the (non-secret) decisions so `resume` does not re-prompt
        st.decisions = { ...(st.decisions || {}), ...sanitizeDecisions(decisions) };
    }
    // Managed mode owns the whole stack: services start by default (opt out
    // with --no-start-comfy / --no-start-worker), 'existing' mode leaves the
    // user's own ComfyUI alone but still runs OUR worker. The flags are also
    // remembered across re-runs — a bare re-run keeps the same wiring instead
    // of silently reverting to defaults. Explicit CLI flags always win.
    // ComfyUI ownership, resolved BY FACT by the caller (engine/comfy-owner.js
    // reads the running processes). The recorded settings are only reused
    // when they do not contradict the machine: an install-state that says
    // "managed / startComfyui=true" while the PLATFORM runs its own ComfyUI
    // must never make the installer start a second one on 8188.
    const comfyOwner = options.comfyOwner || null;
    const foreignComfy = comfyOwner && comfyOwner.owner === 'foreign' ? comfyOwner : null;
    if (!dryRun && comfyOwner) {
        for (const c of comfyOwner.conflicts || []) log.info(`install state corrected — ${c.message}`);
        if (st.mode !== mode) {
            log.info(`install state corrected: mode ${st.mode || '(unset)'} → ${mode}`);
            st.mode = mode;
        }
    }
    if (!dryRun) {
        const saved = st.installer_options || {};
        const requestedStartComfy = options.startComfyui;
        for (const k of ['comfyPort', 'startWorker']) {
            if (options[k] === undefined && saved[k] !== undefined) {
                options[k] = saved[k];
                log.info(`reusing remembered setting: ${k}=${saved[k]}`);
            }
        }
        // ComfyUI start: the ownership FACT beats both the flag and the
        // remembered setting — a foreign instance means "never start a second
        // ComfyUI", full stop.
        const startDecision = comfyOwnerMod.decideStartComfy({
            owner: comfyOwner ? comfyOwner.owner : 'none',
            requested: requestedStartComfy,
            remembered: saved.startComfyui,
            mode,
        });
        options.startComfyui = startDecision.startComfyui;
        if (startDecision.ignored_request) log.warn(`--start-comfy ignored: ${startDecision.reason}`);
        else if (startDecision.reason === 'remembered setting') log.info(`reusing remembered setting: startComfyui=${!!startDecision.startComfyui}`);
        // The worker is OURS in every mode (existing mode only leaves the
        // user's ComfyUI alone) — an installed-but-stopped worker is exactly
        // the "installed, never online" failure.
        if (options.startWorker === undefined) options.startWorker = decisions.worker_setup !== false;
        // Never wire this install to a FOREIGN service on the default port.
        if (options.comfyPort !== undefined) {
            const ours = st.comfyui_runtime && st.comfyui_runtime.port === options.comfyPort;
            const s = await comfyPortState(io, options.comfyPort);
            if (s === 'foreign' && !ours) {
                log.info(`remembered port ${options.comfyPort} is now used by another service — picking a new one`);
                options.comfyPort = undefined;
            }
        }
        if (foreignComfy && foreignComfy.port) {
            // The platform's ComfyUI IS the target: its --port (re-read from
            // the cmdline on every run — it changes between boots).
            options.comfyPort = foreignComfy.port;
        }
        if (options.comfyPort === undefined && mode !== 'managed' && options.runningComfy && options.runningComfy.port) {
            // existing/shared: the user's running ComfyUI IS the target — use
            // its real --port instead of assuming 8188.
            options.comfyPort = options.runningComfy.port;
        }
        if (options.comfyPort === undefined) {
            options.comfyPort = await autoPickComfyPort(io, { st, mode, log });
        }
        st.installer_options = {
            comfyPort: options.comfyPort ?? null,
            startComfyui: !!options.startComfyui,
            startWorker: !!options.startWorker,
        };
        // Hub version seen by this run (bootstrap env) — `animastor doctor`
        // prints it instead of "hub unknown" on later runs.
        if (options.hubVersion) st.hub_version = String(options.hubVersion);
        else if (process.env.ANIMASTOR_HUB_VERSION) st.hub_version = process.env.ANIMASTOR_HUB_VERSION;
    }
    const save = () => state.saveState(io, statePath, st, io.now);
    if (initialState) {
        for (const line of renderResumeSummary(st)) log.info(line);
    }

    // ── 4.0 host gates — BEFORE any mutation (state write, clone, venv,
    //        model downloads) ─────────────────────────────────────────────
    // Ownership mixing: never let a sudo re-run lock a normal user out of
    // their own home directory (or resume another uid's installation).
    const currentUid = options.currentUid !== undefined ? options.currentUid : prereq.currentUid();
    const home = options.home !== undefined ? options.home : prereq.currentHome();
    const ownership = prereq.checkOwnership(io, {
        paths: [comfyuiRoot, statePath, workerDir, toolsDir].filter(Boolean),
        home,
        currentUid,
        stateUid: st.owner_uid != null ? st.owner_uid : null,
    });
    if (!ownership.ok) {
        result.status = 'blocked';
        for (const v of ownership.violations) {
            result.blocked.push({ step: 'ownership', reason: v.message });
            log.error(v.message);
        }
        return result;
    }
    if (st.owner_uid == null && currentUid != null) st.owner_uid = currentUid;

    // Python runtime prerequisites (venv/ensurepip/pip) — must be verified
    // before creating or modifying anything, let alone downloading models.
    const torchEntryEarly = report.entries.find((e) => e.id === 'runtime:torch');
    const pythonEntryEarly = report.entries.find((e) => e.id === 'runtime:python');
    const needRuntimeEarly = [torchEntryEarly, pythonEntryEarly].some((e) => e && (e.status === 'missing' || e.status === 'incompatible'));
    if (needRuntimeEarly) {
        const gate = prereq.checkPythonPrerequisites(io, {
            python: (env.python && env.python.binary) || 'python3',
            tmpRoot: options.prereqTmpRoot || null,
            deep: true,
            existingVenvDir: path.join(comfyuiRoot, 'venv'),
        });
        if (!gate.ok) {
            state.setArtifact(st, 'runtime', 'failed', { reason: gate.failure.code });
            save();
            result.status = 'failed';
            result.remediation = prereq.remediationPayload(gate.failure);
            result.blocked.push({ step: 'runtime', reason: gate.failure.message });
            for (const line of prereq.renderRemediation(gate.failure)) log.error(line);
            return result;
        }
    }

    // Ctrl+C: mark interrupted state + partial artifact, save, exit 130.
    let currentArtifactId = null;
    let removeInterruptGuard = null;
    if (options.interruptGuard !== false) {
        removeInterruptGuard = createInterruptGuard({
            state: st, save, log,
            getArtifactId: () => currentArtifactId,
        });
    }

    try {
        save();

        // 4.1 ComfyUI -----------------------------------------------------------
        const comfyStep = stepById(plan, 'comfyui-update');
        if (comfyStep && comfyStep.abort) {
            result.status = 'aborted';
            result.blocked.push({ step: 'comfyui-update', reason: comfyStep.abort_reason });
            return result;
        }
        if (comfyStep && comfyStep.action) {
            const op = comfyStep.action.op;
            if (op === 'install_comfyui') {
                const src = comfyui.pickInstallSource(manifests[0]);
                if (!src) {
                    result.blocked.push({ step: 'comfyui-update', reason: 'no canonical ComfyUI pin and no known-working reference in the manifest — nothing to install (D1 research pending)' });
                } else if (src.needs_consent && decisions.accept_reference_runtime !== true) {
                    result.blocked.push({
                        step: 'comfyui-update',
                        reason: `canonical ComfyUI pin is unknown (D1); the known-working reference is ${src.source.repository} @ ${src.source.commit || src.source.tag} — confirm accept_reference_runtime to install it`,
                    });
                } else {
                    const r = await log.step('install ComfyUI', () => withBusySync('Cloning ComfyUI', () => comfyui.installComfyUI(io, { root: comfyuiRoot, source: src.source, log })));
                    result.results.comfyui = r.ok ? { op, grade: src.grade, ...r.value } : { op, failed: String(r.error && r.error.message) };
                    if (!r.ok) result.warnings.push(`ComfyUI install failed: ${r.error && r.error.message}`);
                    // installComfyUI refuses non-empty targets — success ⇒ the
                    // installer created this root and owns it.
                    st.components.comfyui = r.ok
                        ? { owned: true, path: comfyuiRoot, ref: src.source.commit || src.source.tag || null }
                        : st.components.comfyui;
                    state.setArtifact(st, 'comfyui', r.ok ? 'installed' : 'failed', { ref: src.source.commit || src.source.tag });
                    save();
                }
            } else if (op === 'update_comfyui' || op === 'downgrade_comfyui') {
                const gate = confirmationGate(op, { confirmed: true, op, via: 'install-plan' });
                if (!gate.allowed) {
                    result.blocked.push({ step: 'comfyui-update', reason: gate.reason });
                } else {
                    const target = pickUpdateTarget(manifests[0]);
                    const busyLabel = op === 'downgrade_comfyui' ? 'Downgrading ComfyUI' : 'Updating ComfyUI';
                    const r = await log.step(`${op} ComfyUI`, () => withBusySync(busyLabel, () => comfyui.updateComfyUI(io, { root: comfyuiRoot, target, state: st, log })));
                    result.results.comfyui = r.ok ? { op, ...r.value } : { op, failed: String(r.error && r.error.message) };
                    // An updated/downgraded ComfyUI pre-existed — record ownership
                    // honestly so the uninstaller never removes it wholesale.
                    if (r.ok && !st.components.comfyui) {
                        st.components.comfyui = { owned: false, path: comfyuiRoot };
                    }
                    if (r.ok) save();
                }
            }
        }
        if (comfyStep && comfyStep.continue_at_own_risk) {
            result.warnings.push('continuing with a ComfyUI newer than the tested maximum — at the user\'s own risk (recorded)');
        }
        if (!st.components.comfyui && env.comfyui && env.comfyui.present) {
            st.components.comfyui = { owned: false, path: comfyuiRoot };
            save();
        }

        // 4.2 Python runtime / torch (managed, or when missing) ------------------
        // Never touch an EXISTING working Python/Torch/CUDA setup without an
        // explicit user decision: `accept_runtime_change`. An incompatible
        // runtime OUTSIDE the managed venv (system python) does not block: the
        // installer creates an ISOLATED venv and never modifies the system
        // runtime. Only replacing an already-present venv needs consent.
        //
        // Failure semantics: when the runtime cannot be prepared (no venv, no
        // pip, broken venv that cannot be repaired) the installation is in an
        // unrecoverable state — every dependent step (custom nodes, model
        // downloads, ComfyUI start) is SKIPPED, never ploughed through.
        let runtimeFatal = false;
        const torchEntry = report.entries.find((e) => e.id === 'runtime:torch');
        const pythonEntry = report.entries.find((e) => e.id === 'runtime:python');
        const needRuntime = [torchEntry, pythonEntry].some((e) => e && (e.status === 'missing' || e.status === 'incompatible'));
        if (needRuntime && io.fs.existsSync(comfyuiRoot)) {
            const hasManagedVenv = io.fs.existsSync(platformAdapter.venvPythonBin(path.join(comfyuiRoot, 'venv')));
            const presentRuntime = [torchEntry, pythonEntry].some((e) => e && e.status === 'incompatible');
            if (presentRuntime && hasManagedVenv && decisions.accept_runtime_change !== true) {
                result.blocked.push({
                    step: 'runtime',
                    reason: 'the managed venv runtime does not match the profile requirements. The installer will NOT replace it without an explicit accept_runtime_change decision.',
                });
                state.setArtifact(st, 'runtime', 'failed', { reason: 'runtime change not accepted' });
                save();
            } else {
                if (presentRuntime && !hasManagedVenv) {
                    result.warnings.push(`the system Python/Torch runtime (outside the managed venv) does not match the profile requirement — the installer creates an isolated venv and does NOT modify the system runtime`);
                }
                const torchSpec = pickTorchSpec(manifests, decisions, result.warnings, device);
                if (torchEntry && torchEntry.status === 'missing' && !torchSpec) {
                    result.blocked.push({ step: 'runtime', reason: 'torch requirement cannot be satisfied: no canonical pin and reference not accepted' });
                } else {
                    const r = await log.step('prepare Python runtime', () => withBusy('Installing Python runtime', () => comfyui.preparePythonRuntime(io, {
                        root: comfyuiRoot,
                        torchSpec: torchSpec ? torchSpec.spec : null,
                        log,
                        term,
                        platformAdapter,
                    })));
                    result.results.runtime = r.ok ? { device, grade: torchSpec ? torchSpec.grade : null, ...r.value } : { failed: String(r.error && r.error.message) };
                    if (r.ok) {
                        // The venv under the ComfyUI root is created by this
                        // installer run — always ours (even inside a pre-existing
                        // root), so the uninstaller may remove it precisely.
                        st.components.venv = { owned: true, path: r.value.venv, created: r.value.venv_created };
                        if (torchSpec) st.torch = { device, grade: torchSpec.grade, pin: torchSpec.spec.pin };
                        if (r.value.quarantined_broken_venv) {
                            result.warnings.push(`a broken venv was found at ${r.value.venv} and moved aside to ${r.value.quarantined_broken_venv} — a fresh venv was created`);
                        }
                    } else {
                        runtimeFatal = true;
                        const err = r.error;
                        if (err && err.name === 'PrerequisiteError') {
                            result.remediation = {
                                code: err.code,
                                summary: err.summary,
                                package: err.hostPackage,
                                command: err.remediationCommand,
                            };
                            for (const line of prereq.renderRemediation(err)) log.error(line);
                        }
                    }
                    state.setArtifact(st, 'runtime', r.ok ? 'installed' : 'failed', {});
                    if (!r.ok) result.warnings.push(`python runtime preparation failed: ${r.error && r.error.message}`);
                    save();
                }
            }
        } else if (!runtimeFatal && io.fs.existsSync(platformAdapter.venvPythonBin(path.join(comfyuiRoot, 'venv')))) {
            // Runtime looks complete (torch+python already present — e.g. an
            // ADOPTED ComfyUI), so the full prepare step was skipped. The fork's
            // own requirements may still be missing from the old venv (the
            // ComfyUI process crashes on import otherwise) — and unpinned
            // torchvision/torchaudio edges must not drift off the installed
            // torch ABI. Idempotent sync constrained to the torch family.
            const torchSpec = pickTorchSpec(manifests, decisions, result.warnings, device);
            const r = await log.step('sync ComfyUI requirements', () => withBusy('Installing ComfyUI requirements', () => comfyui.syncComfyUIRequirements(io, {
                root: comfyuiRoot, torchSpec: torchSpec ? torchSpec.spec : null, log, term,
            })));
            if (!r.ok) result.warnings.push(`ComfyUI requirements sync failed: ${r.error && r.error.message}`);
        }

        // Dependent-step gating: a failed runtime stops everything that needs it.
        if (runtimeFatal) {
            const nodesStepG = stepById(plan, 'custom-nodes');
            if (nodesStepG && nodesStepG.action && nodesStepG.decision === 'yes') {
                log.warn('skipping "install custom nodes": Python runtime preparation failed');
                result.blocked.push({ step: 'custom-nodes', reason: 'skipped — Python runtime preparation failed (fix the prerequisite above and re-run)' });
                for (const item of nodesStepG.missing || []) {
                    state.setArtifact(st, item.id, 'missing', { reason: 'skipped — Python runtime preparation failed' });
                }
                save();
            }
            const modelsStepG = stepById(plan, 'models');
            if (modelsStepG && modelsStepG.action && modelsStepG.decision === 'yes') {
                log.warn('skipping model downloads: Python runtime preparation failed');
                result.blocked.push({ step: 'models', reason: 'skipped — Python runtime preparation failed (no multi-GB downloads in a broken installation)' });
                for (const item of modelsStepG.missing || []) {
                    state.setArtifact(st, item.id, 'missing', { reason: 'skipped — Python runtime preparation failed' });
                }
                save();
            }
        }

        // 4.3 Custom nodes --------------------------------------------------------
        const nodesStep = stepById(plan, 'custom-nodes');
        // Nodes an earlier run left with "python dependencies incomplete" get
        // an idempotent pip retry. This MUST also run when the plan step is a
        // noop: the resolver keys node presence off the directory, so a
        // present-but-broken node produces no install action and without this
        // pass the broken state would never heal (ComfyUI logs IMPORT FAILED
        // and /object_info lacks the node classes).
        const retryDeps = Object.keys(st.artifacts || {}).filter((id) => {
            const a = st.artifacts[id];
            return !!(a && a.detail && /python dependencies incomplete/.test(a.detail.reason || ''));
        });
        const nodesApproved = !runtimeFatal && nodesStep && nodesStep.action && nodesStep.decision === 'yes';
        if (!runtimeFatal && (nodesApproved || retryDeps.length > 0)) {
            const python = platformAdapter.venvPythonBin(path.join(comfyuiRoot, 'venv'));
            // Check for C build tools (gcc, python3-dev, libsndfile1-dev) that
            // packages like funasr/soundfile need. Missing tools produce opaque
            // metadata-generation-failed errors from pip — catch early and give
            // a precise remediation command. (Which tools/packages to check is
            // a platform concern — the adapter answers it.)
            const buildCheck = platformAdapter.checkBuildPrerequisites(io, {
                python: io.fs.existsSync(python) ? python : 'python3', log,
            });
            if (!buildCheck.ok) {
                result.remediation = {
                    code: 'MISSING_BUILD_TOOLS',
                    summary: buildCheck.message,
                    package: buildCheck.remediation.package,
                    command: buildCheck.remediation.command,
                };
            }
            const approvedIds = ((nodesStep && nodesStep.missing) || []).map((x) => x.id);
            const repairOnlyIds = retryDeps.filter((id) => !approvedIds.includes(id));
            const effectiveStep = nodesApproved
                ? { ...nodesStep, missing: [...(nodesStep.missing || []), ...repairOnlyIds.map((id) => ({ id }))] }
                : {
                    ...(nodesStep || { id: 'custom-nodes', title: 'Custom nodes' }),
                    missing: retryDeps.map((id) => ({ id })),
                    review: [],
                };
            const nodeTorchSpec = pickTorchSpec(manifests, decisions, result.warnings, device);
            const r = await log.step('install custom nodes', () => withBusySync('Installing custom nodes', () => nodes.installCustomNodes(io, {
                root: comfyuiRoot, manifests, planStep: effectiveStep,
                python: io.fs.existsSync(python) ? python : null,
                torchSpec: nodeTorchSpec ? nodeTorchSpec.spec : null,
                retryDeps, log,
            })));
            result.results.custom_nodes = r.ok ? r.value : [{ status: 'failed', reason: String(r.error && r.error.message) }];
            for (const item of result.results.custom_nodes) {
                // Only directories the installer actually created are ours.
                if (item.status === 'installed' && item.origin === 'installed' && item.directory) {
                    state.addOwnedComponent(st, 'custom_nodes', { id: item.id, path: path.join(comfyuiRoot, 'custom_nodes', item.directory) });
                }
                state.setArtifact(st, item.id, item.status === 'installed' ? 'installed' : item.status === 'failed' ? 'failed' : 'missing', { reason: item.reason || null });
            }
            save();
            // ComfyUI imports custom nodes ONLY at startup. When this run
            // actually changed a node (fresh clone or repaired deps — both
            // report no reason), restart the managed instance so the live
            // /object_info registry reflects the files on disk; otherwise
            // verification below would check a stale process and fail.
            const nodesChanged = result.results.custom_nodes.some((x) => x.status === 'installed' && !x.reason);
            if (nodesChanged && options.startComfyui !== false) {
                const port = options.comfyPort || 8188;
                const rr = await log.step('restart ComfyUI', () => withBusy('Waiting for ComfyUI to restart', () => comfyui.restartManagedComfyUI(io, {
                    root: comfyuiRoot, port, device, log,
                    verifyTimeoutMs: options.verifyTimeoutMs || 120000,
                    pollIntervalMs: options.pollIntervalMs || 2000,
                })));
                const res = rr.ok ? rr.value : null;
                if (res && res.restarted && res.up) {
                    st.comfyui_runtime = { port, pid: res.pid, started_at: io.now() };
                    log.info('ComfyUI restarted — custom node registry refreshed');
                    save();
                } else if (res && res.restarted) {
                    log.warn(`ComfyUI restart did not come up cleanly: ${res.reason}`);
                } else {
                    const why = res ? res.reason : String(rr.error && rr.error.message);
                    log.warn(`custom nodes changed but the managed ComfyUI was not restarted (${why}) — restart it manually so the new nodes are imported`);
                }
            }
        }

        // 4.4 Models ---------------------------------------------------------------
        const modelsStep = stepById(plan, 'models');
        if (!runtimeFatal && modelsStep && modelsStep.action && modelsStep.decision === 'yes') {
            const getHeader = downloader.makeHeaderProvider(process.env);
            const missingIds = (modelsStep.missing || []).map((x) => x.id);
            const hasHfToken = !!(process.env.HF_TOKEN || process.env.HUGGINGFACE_HUB_TOKEN);
            const specs = manifests.flatMap((m) => planModelDownloads(m, missingIds, { hasHfToken }));
            // User-visible download progress: ONE in-place status line (file,
            // bytes, %, speed, ETA, repo aggregate) on a TTY; throttled plain
            // lines otherwise. `term` is the shared terminal renderer so the
            // progress line and installer status share one stream and never
            // overwrite each other. Inert until a download feeds it chunks.
            const progress = createProgressReporter({
                isTTY: options.progressIsTTY !== undefined ? !!options.progressIsTTY
                    : (typeof process !== 'undefined' && process.stdout ? !!process.stdout.isTTY : false),
                log,
                now: io.now,
                term: options.term || null,
            });
            for (const spec of specs) {
                const dep = findModelDep(manifests, spec.id);
                const absTarget = path.join(comfyuiRoot, spec.target_path);
                const existedBefore = io.fs.existsSync(absTarget);
                currentArtifactId = spec.id; // SIGINT marks THIS artifact partial
                if (dep && dep.kind === 'model_repo' && dep.source && dep.source.kind === 'modelscope') {
                    const strategy = downloader.modelscopeStrategy(dep);
                    if (strategy.mechanism === 'node_auto_download') {
                        result.results.models.push({ id: spec.id, status: 'deferred-to-node', reason: strategy.note });
                        state.setArtifact(st, spec.id, 'missing', { note: strategy.note });
                    } else if (strategy.mechanism === 'installer_preload') {
                        // D2 closed: installer pre-downloads ModelScope repos
                        // Use dedicated ModelScope snapshot download (not single-file downloadArtifact)
                        // An incomplete repo downloads ONLY its missing files —
                        // files already on disk are never re-hashed or
                        // re-downloaded (a different-but-working revision must
                        // not trigger a multi-GB re-download) — and next to the
                        // found files when they live in an extra_model_paths
                        // folder.
                        const entry = report.entries.find((e) => e.id === spec.id) || {};
                        const expectedFiles = (entry.reason === 'incomplete' && Array.isArray(entry.missing_files) && entry.missing_files.length > 0)
                            ? entry.missing_files
                            : (dep.expected_files || null);
                        const loc = entry.found && entry.found.location ? entry.found.location : null;
                        const dlSpec = loc ? { ...spec, target_path: loc.target_dir } : spec;
                        const checksums = null; // ModelScope checksums not yet in manifest; verified by size
                        const r = await log.step(`download model ${spec.id} (ModelScope)`, async () => downloader.downloadModelScopeRepo(io, dlSpec, {
                            root: loc ? loc.base : comfyuiRoot,
                            getHeader,
                            retries: options.downloadRetries || 3,
                            retryDelayMs: options.retryDelayMs || 500,
                            log,
                            expectedFiles,
                            checksums,
                            progress,
                        }));
                        const res = r.ok ? r.value : { status: 'failed', reason: String(r.error && r.error.message) };
                        const status = res.status === 'failed' ? 'failed' : res.status === 'skipped' ? 'verified' : 'installed';
                        result.results.models.push({ id: spec.id, ...res });
                        if (status === 'installed') {
                            state.addOwnedComponent(st, 'models', {
                                id: spec.id,
                                path: absTarget,
                                created: !existedBefore,
                                files: (res.files || []).map((f) => f.path),
                            });
                        }
                        state.setArtifact(st, spec.id, status, { reason: res.reason });
                        save();
                        continue; // skip the generic downloadArtifact below
                    } else {
                        result.results.models.push({ id: spec.id, status: 'blocked', reason: strategy.note });
                        state.setArtifact(st, spec.id, 'missing', { note: strategy.note });
                    }
                    if (strategy.mechanism !== 'installer_preload') continue;
                }
                const singleLabel = spec.target_path || spec.id;
                if (progress && progress.beginFile) progress.beginFile(singleLabel, spec.size_bytes_approx || null);
                const r = await log.step(`download model ${spec.id}`, async () => downloader.downloadArtifact(io, spec, {
                    root: comfyuiRoot,
                    getHeader,
                    retries: options.downloadRetries || 3,
                    retryDelayMs: options.retryDelayMs || 500,
                    log,
                    onProgress: progress && progress.onChunk ? (e) => progress.onChunk(e) : null,
                }));
                if (progress && progress.endFile) progress.endFile({ status: r.ok ? r.value.status : 'failed' });
                const res = r.ok ? r.value : { status: 'failed', reason: String(r.error && r.error.message) };
                result.results.models.push({ id: spec.id, ...res });
                if (res.status === 'downloaded' || res.status === 'resumed') {
                    state.addOwnedComponent(st, 'models', {
                        id: spec.id,
                        path: absTarget,
                        created: !existedBefore,
                    });
                }
                state.setArtifact(st, spec.id, res.status === 'failed' ? 'failed'
                    : res.status === 'blocked' ? 'missing'
                        : res.status === 'skipped' ? 'verified'
                            : 'installed', { grade: res.grade, reason: res.reason });
                save();
                currentArtifactId = null;
            }
        }

        // 4.5 Baseline workflows ------------------------------------------------------
        const wfStep = stepById(plan, 'workflows');
        if (wfStep && wfStep.action && wfStep.action.items && wfStep.action.items.length > 0) {
            const hubFetchText = hubUrl && io.http && io.http.fetchText
                ? (url) => io.http.fetchText(url)
                : null;
            const r = await log.step('install baseline workflows', async () => workflowsInstall.installWorkflows(io, {
                root: comfyuiRoot, manifests, planStep: wfStep,
                repoRoot, hubUrl, crypto, log,
                httpFetchText: hubFetchText,
            }));
            result.results.workflows = r.ok ? r.value : [{ status: 'failed', reason: String(r.error && r.error.message) }];
            for (const item of result.results.workflows) {
                // Fresh copies written by the installer are ours; 'kept' files are
                // the user's — never registered, never removed.
                if ((item.status === 'installed' || item.status === 'fresh-copy-installed') && item.target_path) {
                    state.addOwnedComponent(st, 'workflows', { id: item.id, path: path.join(comfyuiRoot, item.target_path) });
                }
                state.setArtifact(st, item.id, item.status === 'installed' || item.status === 'fresh-copy-installed' ? 'verified' : item.status === 'kept' ? 'verified' : 'missing', { path: item.target_path, reason: item.reason });
            }
            save();
        }

        // Node.js for the worker: the SAME binary everywhere (installer start,
        // start-worker.sh, `animastor` tool) — recorded as NODE_BIN in .env.
        const nodePick = options.nodeBinary !== undefined ? options.nodeBinary : probe.pickNodeBinary(io);
        const nodeBin = nodePick ? nodePick.bin : process.execPath;

        // 4.55 ComfyUI up + API base probe ------------------------------------------
        // Managed mode starts its ComfyUI BEFORE the worker is wired, so the
        // worker's COMFY_URL comes from a real probe: plain
        // http://127.0.0.1:<port> first, a notebook prefix only when the plain
        // URL does not answer. Existing mode never starts the user's ComfyUI.
        const comfyPort = options.comfyPort || 8188;
        let comfyUrl = null;
        // A foreign (platform) ComfyUI is addressed EXACTLY as its cmdline says
        // (--port plus --baseurl), re-verified on every run: the port and the
        // prefix change between node boots, so nothing is remembered.
        if (!runtimeFatal && !dryRun && foreignComfy && foreignComfy.url) {
            const stats = await comfyui.systemStats(io, foreignComfy.url);
            if (stats) {
                comfyUrl = foreignComfy.url;
                log.info(`ComfyUI API: ${comfyUrl} (started outside the installer — pid ${foreignComfy.pid}, left running)`);
            } else {
                log.warn(`the ComfyUI process (pid ${foreignComfy.pid}) does not answer GET /system_stats at ${foreignComfy.url} yet`);
            }
        }
        if (!runtimeFatal && !dryRun && !comfyUrl) {
            const plainUp = await comfyui.systemStats(io, `http://127.0.0.1:${comfyPort}`);
            if (!plainUp && options.startComfyui && io.fs.existsSync(comfyuiRoot)) {
                const started = await log.step('start ComfyUI', () => withBusy('Starting ComfyUI', async () => {
                    const { pid } = comfyui.startComfyUI(io, { root: comfyuiRoot, port: comfyPort, device });
                    const up = await comfyui.waitForApi(io, `http://127.0.0.1:${comfyPort}`, { timeoutMs: options.verifyTimeoutMs || 120000, intervalMs: options.pollIntervalMs || 2000 });
                    if (!up.ok) throw new Error(up.reason);
                    return { pid, up };
                }));
                if (started.ok) result.results.comfyui_started = { pid: started.value.pid, port: comfyPort };
            }
            const prefixes = [];
            if (workerDir) prefixes.push(worker.readEnvValues(io, workerDir).NOTEBOOK_PATH);
            if (options.runningComfy && options.runningComfy.baseurl) prefixes.push(options.runningComfy.baseurl);
            if (foreignComfy && foreignComfy.baseurl) prefixes.push(foreignComfy.baseurl);
            const pr = await probe.probeComfyUrl(io, { port: comfyPort, prefixes: prefixes.filter(Boolean) });
            comfyUrl = pr.url;
            result.results.comfy_url = { url: pr.url, tried: pr.tried, prefixed: !!pr.prefixed };
            if (pr.url) log.info(`ComfyUI API: ${pr.url}${pr.prefixed ? ' (reverse-proxy prefix — the plain URL did not answer)' : ''}`);
            else log.warn(`ComfyUI API not reachable (tried: ${pr.tried.join(', ')})`);
        }

        // 4.6 Worker bundle + .env --------------------------------------------------
        const workerStep = stepById(plan, 'worker-setup');
        // An installed-but-OUTDATED bundle (e.g. 2.1.1 without COMFY_URL
        // support) is refreshed even when the plan has nothing to install —
        // only with the user's consent to the fixes.
        let bundleTargets = workerStep && workerStep.action && workerStep.decision === 'yes' ? (workerStep.workers || []) : [];
        if (bundleTargets.length === 0 && decisions.apply_fixes !== false && decisions.worker_setup !== false && workerDir
            && io.fs.existsSync(path.join(workerDir, 'worker.cjs'))) {
            const srcDir = repoBundleSource.resolveRepoBundleDir(io.fs, repoRoot);
            const have = worker.readPkgVersion(io, workerDir);
            let want = srcDir ? worker.readPkgVersion(io, srcDir) : null;
            if (!want && hubUrl && io.http && io.http.fetchJson) {
                // no bundled copy: the hub's published bundle version decides
                try {
                    const meta = await io.http.fetchJson(`${hubUrl.replace(/\/$/, '')}/worker-bundle/sha256`);
                    if (meta && meta.status === 200 && meta.json && typeof meta.json.version === 'string') want = meta.json.version;
                } catch (_) { /* hub unreachable — keep the installed bundle */ }
            }
            if (have && want && have !== want) {
                bundleTargets = [{ id: `worker:${manifests[0].profile.id}`, worker_type: (manifests[0].worker_bundle || {}).worker_type }];
            }
        }
        if (bundleTargets.length > 0) {
            for (const w of bundleTargets) {
                const manifest = manifests.find((m) => `worker:${m.profile.id}` === w.id) || manifests[0];
                const bundleRes = await log.step(`install worker bundle (${w.worker_type})`, async () => {
                    // The distributed installer package may not carry the
                    // worker bundle files. When the repo checkout is missing
                    // any of them, fetch the hub's sha256-verified worker
                    // bundle (GET /worker-bundle) and use it as copy source.
                    const wbFiles = ((manifest.worker_bundle || {}).files) || [];
                    const repoBundleDir = repoBundleSource.resolveRepoBundleDir(io.fs, repoRoot);
                    const missingFromRepo = wbFiles.filter((f) => !(repoBundleDir && io.fs.existsSync(path.join(repoBundleDir, f))));
                    let bundleDir = null;
                    let bundleTmp = null;
                    if (missingFromRepo.length > 0 && hubUrl) {
                        const fetched = await worker.fetchHubWorkerBundle(io, { hubUrl });
                        if (fetched.bundleDir) {
                            bundleDir = fetched.bundleDir;
                            bundleTmp = fetched.tmpDir;
                            log.info(`worker bundle files missing from the installer package — fetched from ${hubUrl}/worker-bundle (${missingFromRepo.length} file(s))`);
                        } else {
                            log.warn(`worker bundle fetch failed: ${fetched.reason}`);
                        }
                    }
                    try {
                        return withBusySync('Installing worker bundle', () => worker.installWorkerBundle(io, {
                            workerDir, manifest, repoRoot, bundleDir, hubUrl,
                            httpFetchText: null, log,
                            update: decisions.apply_fixes !== false,
                            nodeBin,
                        }));
                    } finally {
                        if (bundleTmp) {
                            try { io.fs.rmSync(bundleTmp, { recursive: true, force: true }); } catch (_) { /* best effort */ }
                        }
                    }
                });
                result.results.worker.push({ id: w.id, bundle: bundleRes.ok ? bundleRes.value : { status: 'failed', reason: String(bundleRes.error && bundleRes.error.message) } });
                if (bundleRes.ok && bundleRes.value.status === 'installed') {
                    // Ownership is per-file: a pre-existing worker dir keeps its
                    // own files; only what the installer copied is registered.
                    st.components.worker = {
                        owned: bundleRes.value.dir_created === true,
                        dir: workerDir,
                        files_installed: bundleRes.value.files_installed || [],
                        files_kept: bundleRes.value.files_kept || [],
                        env_created: null, // finalized by the .env step below
                    };
                }
                state.setArtifact(st, w.id, bundleRes.ok && bundleRes.value.status === 'installed' ? 'installed' : 'failed');
                save();
            }
        }

        // 4.7 Worker Key + .env configuration ----------------------------------------
        // Runs on EVERY install where the worker is wanted — even full re-runs
        // whose plan has no worker-key step (nothing left to ask). configureEnv
        // merges (never overwrites), and runtime settings like COMFY_PORT must
        // reach .env on every run: otherwise an already-running worker keeps
        // its stale wiring forever.
        const keyStep = stepById(plan, 'worker-key');
        const workerWanted = decisions.worker_setup === true || decisions.worker_setup === 'yes'
            || (keyStep && (keyStep.provided || decisions.worker_key_provided === true));
        let tokenValue = null; // held in memory only; never stored on result/state
        let workerConfigChanged = false; // .env or bundle changed in THIS run → restart a running worker
        if (workerWanted) {
            const manifest = manifests[0];
            const required = ((manifest.worker_bundle || {}).env || {}).required || [];
            const values = {};
            for (const key of (keyStep && keyStep.secret_keys) || []) {
                if (secretProvider) {
                    const value = await secretProvider(key);
                    if (value) {
                        log.registerSecret(value); // redact from ALL further output
                        values[key] = value;
                        if (key === 'ANIMASTOR_WORKER_TOKEN') tokenValue = value;
                    }
                }
            }
            for (const key of required) {
                if (values[key] === undefined && !key.includes('TOKEN')) {
                    values[key] = defaultEnvValue(key, { hubUrl, manifests });
                }
            }
            // Installer-owned wiring: worker type from the PROFILE, the node
            // binary, the probed ComfyUI API base and port (shared hosts often
            // run several ComfyUI instances; the default 8188 may belong to a
            // different one). Written for missing keys always; existing values
            // are replaced only when the user accepted the fixes
            // (decisions.apply_fixes — one "Fix?" question in the CLI).
            const desired = desiredEnvWiring({ manifests, nodeBin, comfyUrl, comfyPort: options.comfyPort, hubUrl, hubUrlExplicit: !!options.hubUrlExplicit });
            Object.assign(values, desired);
            const secretOverrides = {};
            if (options.replaceWorkerKey && secretProvider) {
                const fresh = await secretProvider('ANIMASTOR_WORKER_TOKEN');
                if (fresh) {
                    log.registerSecret(fresh);
                    secretOverrides.ANIMASTOR_WORKER_TOKEN = fresh;
                    tokenValue = fresh;
                }
            }
            const cfg = await log.step('configure worker .env', async () => worker.configureEnv(io, {
                workerDir, manifest, values,
                overrides: decisions.apply_fixes !== false ? desired : {},
                secretOverrides,
                log,
            }));
            result.results.worker.push({ id: 'env', config: cfg.ok ? cfg.value : { status: 'failed', reason: String(cfg.error && cfg.error.message) } });
            if (cfg.ok && (cfg.value.created || (cfg.value.changed || []).length > 0 || (cfg.value.added || []).length > 0)) workerConfigChanged = true;
            if (cfg.ok && st.components.worker) {
                st.components.worker.env_created = cfg.value.created === true;
            } else if (cfg.ok) {
                st.components.worker = {
                    owned: false, dir: workerDir, files_installed: [], files_kept: [],
                    env_created: cfg.value.created === true,
                };
            }
            state.setArtifact(st, 'env', cfg.ok && cfg.value.status === 'configured' ? 'installed' : 'partial', {});
            save();
        }

        // 4.75 Management tools (before the worker start: the final summary names
        // the `animastor` command in its fix lines) ---------------------------------------------------
        // Optional component (install decision install_management_tools). The
        // tools are thin wrappers around this CLI's management commands — the
        // runtime logic is shared (management.js), never duplicated. Installing
        // is idempotent: a re-run overwrites the same files (no duplicates) and
        // the files are registered as owned so the uninstaller removes them
        // precisely. A tools failure must never fail the installation itself.
        if (decisions.install_management_tools === true && toolsDir && !dryRun) {
            try {
                // The bootstrap runs this CLI from a temp dir wiped on exit —
                // the tools must point at a PERSISTENT copy of the installer
                // (<base>/installer), refreshed on every run.
                const r = await log.step('install management tools', async () => withBusySync('Installing management tools', () => management.installManagementTools(io, {
                    toolsDir,
                    nodePath: nodeBin,
                    cliPath: path.join(__dirname, '..', 'cli.js'),
                    // engine/ → installer/ → src/ → package root (src/, ai/, package.json)
                    installerSrcRoot: options.persistInstaller === false ? null : path.resolve(__dirname, '..', '..', '..'),
                    installerDestRoot: path.join(path.dirname(toolsDir), 'installer'),
                    linkDir: options.linkDir !== undefined ? options.linkDir : management.defaultLinkDir({ uid: currentUid, home }),
                    home,
                    statePath,
                    root: comfyuiRoot,
                    workerDir,
                    hubUrl,
                    log,
                    platformAdapter,
                })));
                // log.step wraps the callback result in { ok, value, error } —
                // the tools result itself is r.value (an unwrapped r.files here
                // was a latent bug: tools were never installed by real runs).
                if (r.ok && r.value) {
                    result.results.management_tools = r.value;
                    for (const f of r.value.files) {
                        state.addOwnedComponent(st, 'services', { id: 'management-tools', path: f });
                    }
                    if (r.value.link) state.addOwnedComponent(st, 'services', { id: 'animastor-command', path: r.value.link });
                    if (r.value.installerDir) state.addOwnedComponent(st, 'services', { id: 'installer-copy', path: r.value.installerDir });
                    if (r.value.path_hint) result.warnings.push(r.value.path_hint);
                    state.setArtifact(st, 'management-tools', 'installed', { dir: r.value.toolsDir });
                    // Autostart: ~/animastor/start-worker.sh becomes a thin
                    // wrapper around `animastor start` (the old script is kept
                    // as .bak). Installed next to the worker, re-applied on
                    // every run so a reboot that wipes the file is repaired.
                    const wrap = management.ensureStartWorkerWrapper(io, {
                        workerDir,
                        animastorPath: r.value.link || r.value.command || null,
                    });
                    result.results.start_worker_wrapper = wrap;
                    if (wrap.status === 'replaced') {
                        log.info(`autostart: start-worker.sh replaced by the animastor wrapper${wrap.backup ? ` (old script: ${wrap.backup})` : ''}`);
                    } else if (wrap.status === 'created') {
                        log.info(`autostart: start-worker.sh created → ${wrap.path}`);
                    } else if (wrap.status === 'failed') {
                        result.warnings.push(`autostart wrapper could not be written: ${wrap.reason}`);
                    }
                } else {
                    const reason = r.error && r.error.message ? r.error.message : 'unknown failure';
                    result.warnings.push(`management tools could not be installed: ${reason}`);
                    state.setArtifact(st, 'management-tools', 'failed', { reason });
                }
                save();
            } catch (err) {
                result.warnings.push(`management tools could not be installed: ${err.message}`);
                state.setArtifact(st, 'management-tools', 'failed', { reason: err.message });
                save();
            }
        }

        // 4.8 Worker start (default in every mode; --no-start-worker opts out) ---
        // "done" ONLY after the worker itself logged "ComfyUI ready": a
        // spawned-but-stuck process is a FAILED step, never a silent pass.
        // A fatal runtime failure leaves the install unrecoverable — every
        // dependent step (including daemon starts) is SKIPPED.
        let startedWorkerPid = null;
        let workerReady = null;
        let workerStart = null;
        if (options.startWorker && workerDir && !runtimeFatal) {
            const r = await log.step('start worker', async () => {
                const bundleChanged = result.results.worker.some((x) => x.bundle && (x.bundle.files_installed || []).length > 0);
                const res = worker.startWorker(io, { workerDir, nodeBin, graceMs: options.workerGraceMs || 3000, forceRestart: workerConfigChanged || bundleChanged });
                workerStart = res;
                if (!res.started || !res.alive) {
                    // An immediate exit is usually the fail-closed credential
                    // gate — say so (the fix is a new key, not a re-run).
                    if (res.logFile) {
                        const scan = worker.scanWorkerLog(worker.readLogFrom(io, res.logFile, res.logOffset || 0));
                        if (scan.auth_failed) {
                            workerReady = { comfy_ready: false, heartbeat: false, auth_failed: true, reason: `the Worker Key was rejected (Worker authentication failed) — see ${res.logFile}` };
                            throw new Error(workerReady.reason);
                        }
                    }
                    throw new Error(res.reason || 'worker did not start');
                }
                if (res.already_running) log.info(`worker already running (pid ${res.pid}) — not spawning a second instance`);
                const ready = await withBusy('Waiting for the worker to reach ComfyUI', () => worker.waitForWorkerReady(io, {
                    workerDir, pid: res.pid, logFile: res.logFile, logOffset: res.logOffset || 0,
                    comfyTimeoutMs: options.workerReadyTimeoutMs || 90000,
                    pollMs: options.pollIntervalMs || 1000,
                    requireHeartbeat: false,
                }));
                workerReady = ready;
                if (!ready.comfy_ready) throw new Error(ready.reason);
                return { ...res, ...ready };
            });
            const res = r.ok ? r.value : { ...(workerStart || {}), started: !!(workerStart && workerStart.started), alive: false, reason: String(r.error && r.error.message) };
            result.results.worker.push({ id: 'worker-process', pid: res.pid || null, started: !!res.started, comfy_ready: !!(workerReady && workerReady.comfy_ready), reason: r.ok ? null : res.reason, log_file: res.logFile || null });
            if (r.ok) {
                startedWorkerPid = res.pid;
                state.setArtifact(st, 'worker-process', 'installed', { pid: res.pid });
            } else {
                if (workerStart && workerStart.pid) startedWorkerPid = workerStart.pid;
                state.setArtifact(st, 'worker-process', 'failed', { reason: res.reason || null });
            }
            save();
            // Hub heartbeat (Animastor shows ONLINE) — only meaningful once the
            // worker reached ComfyUI (heartbeats start after that).
            if (r.ok) {
                const hb = await withBusy('Waiting for the hub to confirm the heartbeat', () => worker.waitForWorkerReady(io, {
                    workerDir, pid: res.pid, logFile: res.logFile, logOffset: res.logOffset || 0,
                    comfyTimeoutMs: 1000, heartbeatTimeoutMs: options.heartbeatTimeoutMs || 45000,
                    pollMs: options.pollIntervalMs || 1000,
                }));
                workerReady = hb;
            }
        }

        // 4.9 Verification --------------------------------------------------------------
        // A fatal runtime failure means ComfyUI cannot start — skip the live
        // start step entirely (it would only spawn a doomed process).
        const ver = await runVerification({
            io, manifests, roots: { comfyuiRoot, workerDir, hubUrl },
            options: { ...options, comfyUrl, startComfyui: runtimeFatal ? false : options.startComfyui },
            log, crypto,
            tokenValue,
            device,
            workerPid: startedWorkerPid,
            onEvent: (kind, value) => { result.results[kind] = value; },
        });
        result.verification = ver;
        // Record the instance this installer started so future runs reuse its
        // port instead of auto-picking a new one (the runVerification scope
        // has no state — the start step reports via the comfyui_started event).
        const startedEv = result.results.comfyui_started;
        if (startedEv && startedEv.port) {
            st.comfyui_runtime = { port: startedEv.port, pid: startedEv.pid, started_at: io.now() };
            save();
        }

        // 4.11 End-to-end: ComfyUI API → worker "ComfyUI ready" → hub heartbeat.
        result.results.comfy_owner = {
            owner: comfyOwner ? comfyOwner.owner : null,
            mode,
            pid: comfyOwner ? comfyOwner.pid : null,
            url: comfyUrl,
            baseurl: comfyOwner ? comfyOwner.baseurl : null,
        };
        result.e2e = await endToEndChecks(io, {
            mode, comfyUrl, comfyPort, hubUrl,
            workerWanted: !!(options.startWorker && workerDir && !runtimeFatal),
            workerStart, workerReady,
            tool: options.toolCommand || toolCommandFrom(result.results.management_tools),
        });

        if (runtimeFatal) {
            result.status = 'failed';
        } else if (result.e2e.some((c) => c.ok === false)) {
            const blockedCount = result.blocked.length + result.results.models.filter((m) => m.status === 'blocked').length;
            result.status = blockedCount > 0 ? 'blocked' : 'failed';
        } else {
            const blockedCount = result.blocked.length + result.results.models.filter((m) => m.status === 'blocked').length;
            if (result.blocked.length > 0 || blockedCount > 0) result.status = 'blocked';
            else if (ver.status === 'FAIL') result.status = 'failed';
            else if (ver.status === 'WARN') result.status = 'warn';
            else result.status = 'ready';
        }

        if (removeInterruptGuard) removeInterruptGuard();
        save();
        return result;
    } finally {
        if (removeInterruptGuard) removeInterruptGuard();
    }
}

function pickUpdateTarget(manifest) {
    const spec = (manifest.runtime_requirements || {}).comfyui || {};
    if (spec.pin && (spec.pin.commit || spec.pin.tag)) return spec.pin;
    if (spec.known_working_reference) return spec.known_working_reference;
    throw new Error('no update target in manifest');
}

function findModelDep(manifests, id) {
    for (const m of manifests) {
        const dep = (m.dependencies || []).find((d) => d.id === id);
        if (dep) return dep;
    }
    return null;
}

/**
 * Installer-owned .env wiring for this run (non-secret): WORKER_TYPE from the
 * profile manifest (never a hard-coded default), NODE_BIN, COMFY_URL when a
 * probe proved it, COMFY_PORT, HUB_URL when the hub was given explicitly.
 */
function desiredEnvWiring({ manifests, nodeBin = null, comfyUrl = null, comfyPort = null, hubUrl = null, hubUrlExplicit = false }) {
    const out = {};
    const type = (manifests[0] && manifests[0].worker_bundle && manifests[0].worker_bundle.worker_type) || null;
    if (type) out.WORKER_TYPE = type;
    if (nodeBin) out.NODE_BIN = nodeBin;
    if (comfyUrl) {
        out.COMFY_URL = comfyUrl;
        // NOTEBOOK_PATH follows the probe too (older workers ignore COMFY_URL
        // and build the URL from COMFY_PORT + NOTEBOOK_PATH): empty when the
        // plain URL answered, the prefix only when the probe needed it.
        const m = /^https?:\/\/[^/]+(\/.*)?$/.exec(comfyUrl);
        out.NOTEBOOK_PATH = m && m[1] ? m[1] : '';
    }
    if (comfyPort) out.COMFY_PORT = String(comfyPort);
    if (hubUrlExplicit && hubUrl) out.HUB_URL = hubUrl;
    return out;
}

/** The command users type for fixes: `animastor` when linked into PATH, else the absolute tool path. */
function toolCommandFrom(tools) {
    if (tools && tools.command) return tools.command;
    return 'animastor';
}

/**
 * The three end-to-end checks the installer result is judged by. Each ✗
 * carries ONE line of cause and ONE exact fix command — the final summary
 * prints exactly these (no "scroll up").
 * @returns {Promise<Array<{ id, ok: boolean|null, label, detail, fix }>>}
 */
async function endToEndChecks(io, { mode, comfyUrl, comfyPort, hubUrl, workerWanted, workerStart, workerReady, tool = 'animastor' }) {
    const checks = [];
    const stats = comfyUrl ? await comfyui.systemStats(io, comfyUrl) : null;
    checks.push(stats
        ? { id: 'comfyui', ok: true, label: 'ComfyUI API', detail: comfyUrl, fix: null }
        : {
            id: 'comfyui', ok: false, label: 'ComfyUI API',
            detail: `not reachable at http://127.0.0.1:${comfyPort || 8188} (GET /system_stats)`,
            fix: mode === 'managed'
                ? `${tool} start`
                : `start your ComfyUI on port ${comfyPort || 8188}, then run: ${tool} doctor`,
        });
    if (!workerWanted) {
        checks.push({ id: 'worker', ok: null, label: 'Worker → ComfyUI', detail: 'worker start skipped (--no-start-worker)', fix: `${tool} start` });
        checks.push({ id: 'heartbeat', ok: null, label: 'Hub heartbeat (Online)', detail: 'not checked — worker not started', fix: `${tool} start` });
        return checks;
    }
    const newKeyFix = `create a new Worker Key in Animastor → Settings → Workers, then run: ${tool} doctor --new-key`;
    const r = workerReady || {};
    if (r.comfy_ready) {
        checks.push({ id: 'worker', ok: true, label: 'Worker → ComfyUI', detail: '"ComfyUI ready" in the worker log', fix: null });
    } else {
        const reason = (r.reason || (workerStart && workerStart.reason) || 'worker did not start').replace(/\s+/g, ' ');
        checks.push({
            id: 'worker', ok: false, label: 'Worker → ComfyUI', detail: reason,
            fix: r.auth_failed ? newKeyFix : `${tool} doctor`,
        });
    }
    if (r.heartbeat) {
        checks.push({ id: 'heartbeat', ok: true, label: 'Hub heartbeat (Online)', detail: hubUrl || null, fix: null });
    } else if (!r.comfy_ready) {
        checks.push({ id: 'heartbeat', ok: false, label: 'Hub heartbeat (Online)', detail: 'not reached — the worker sends heartbeats only after it reached ComfyUI', fix: r.auth_failed ? newKeyFix : `${tool} doctor` });
    } else {
        checks.push({
            id: 'heartbeat', ok: false, label: 'Hub heartbeat (Online)',
            detail: (r.reason || 'no heartbeat confirmed').replace(/\s+/g, ' '),
            fix: r.auth_failed ? newKeyFix : `check that this machine reaches ${hubUrl} (curl -fsS ${hubUrl}/health), then run: ${tool} doctor`,
        });
    }
    return checks;
}

function defaultEnvValue(key, { hubUrl, manifests }) {
    if (key === 'HUB_URL') return hubUrl || 'https://animastor.org/gpu';
    if (key === 'WORKER_TYPE') return (manifests[0].worker_bundle || {}).worker_type || 'image';
    if (key === 'WORKER_ID') return `gpu-${Date.now().toString(36)}`;
    return '';
}

// ---------------------------------------------------------------------------
// Verification (live checks where possible)
// ---------------------------------------------------------------------------

async function runVerification({ io, manifests, roots, options, log, crypto, tokenValue = null, device = null, workerPid = null, onEvent = null }) {
    const emit = (kind, value) => { if (onEvent) onEvent(kind, value); };
    const { comfyuiRoot, workerDir, hubUrl } = roots;
    const live = {};

    // ComfyUI live check: use an already-running instance, or start one in
    // managed mode (files on disk are NOT sufficient verification).
    const port = options.comfyPort || 8188;
    const baseUrl = options.comfyUrl || `http://127.0.0.1:${port}`;
    const withBusy = (label, fn, o) => (options.term ? options.term.withBusy(label, fn, o) : fn());
    let stats = await comfyui.systemStats(io, baseUrl);
    if (!stats && options.startComfyui && io.fs.existsSync(comfyuiRoot)) {
        const started = await log.step('start ComfyUI', () => withBusy('Starting ComfyUI', async () => {
            const { pid } = comfyui.startComfyUI(io, { root: comfyuiRoot, port, device });
            const up = await comfyui.waitForApi(io, baseUrl, { timeoutMs: options.verifyTimeoutMs || 120000, intervalMs: options.pollIntervalMs || 2000 });
            return { pid, up };
        }));
        if (started.ok && started.value.up.ok) {
            stats = started.value.up.system_stats;
            emit('comfyui_started', { pid: started.value.pid, port });
        } else {
            live.comfyui = { running: false, api_reachable: false };
        }
    }
    if (stats) {
        live.comfyui = { running: true, api_reachable: true };
        const classes = await comfyui.objectInfoClasses(io, baseUrl);
        if (classes) {
            const manifestClasses = new Set();
            for (const m of manifests) {
                for (const dep of m.dependencies || []) {
                    for (const cls of dep.provides_classes || []) manifestClasses.add(cls);
                }
            }
            const missingClasses = Array.from(manifestClasses).filter((c) => !classes.has(c));
            if (missingClasses.length > 0) live.comfyui.missing_node_classes = missingClasses;
        }
        // workflow static validation (no generation) — only meaningful when
        // at least one OPTIONAL profile workflow copy is actually installed;
        // absent optional copies are never checked and never reported as a
        // problem (Animastor sends workflow JSON with each task via the API)
        if (crypto) {
            const wfProblems = [];
            let wfChecked = 0;
            for (const m of manifests) {
                for (const wf of (m.workflows && m.workflows.artifacts) || []) {
                    const abs = path.join(comfyuiRoot, `${wf.target_dir}/${wf.filename}`);
                    if (!io.fs.existsSync(abs)) continue;
                    wfChecked += 1;
                    try {
                        const problems = comfyui.validateWorkflowStatic(io.fs.readFileSync(abs, 'utf8'), { availableClasses: null });
                        if (problems.parse_error) wfProblems.push(`${wf.filename}: ${problems.parse_error}`);
                    } catch (_) { /* unreadable */ }
                }
            }
            if (wfChecked > 0) live.workflow = { accepted: wfProblems.length === 0, problems: wfProblems };
        }
    } else if (!live.comfyui) {
        live.comfyui = { running: false, api_reachable: false };
    }

    // Worker registration check
    const manifest = manifests[0];
    const expectedType = (manifest.worker_bundle || {}).worker_type || null;
    let token = tokenValue;
    if (!token && workerDir && io.fs.existsSync(path.join(workerDir, '.env'))) {
        token = readEnvValueLocal(io, workerDir, 'ANIMASTOR_WORKER_TOKEN');
        if (token && log.registerSecret) log.registerSecret(token);
    }
    if (hubUrl && token) {
        const reg = await worker.verifyRegistration(io, { hubUrl, token, expectedType });
        emit('registration', { registered: reg.registered, worker_id: reg.worker_id || null, worker_type: reg.worker_type || null, reason: reg.reason || null });
        live.worker = { process_alive: null, registered: reg.registered === true };
        live.hub = { connection: reg.reason ? reg.reason.indexOf('unreachable') === -1 : true, registration: reg.registered === true };
        if (!reg.registered) {
            log.warn('Installation completed locally, but Worker registration failed. The installed environment is intact — fix the credential/network and re-run `verify`.');
        }
    } else {
        const canStart = workerDir ? worker.checkWorkerCanStart(io, { workerDir }) : { ok: false, reason: 'worker dir missing' };
        live.worker = { process_alive: null, registered: null, can_start: canStart.ok };
    }
    // A worker started by this run is checked for real — a pid that died
    // before verification is a FAIL, never a silent pass.
    if (workerPid) {
        // Platform-appropriate liveness check (Linux: ps -o args= grep,
        // Windows: pid marker + tasklist).
        const adapter = platforms.getPlatformAdapter();
        const alive = typeof adapter.checkDaemonAlive === 'function'
            ? adapter.checkDaemonAlive(io, { pid: workerPid, workerDir })
            : (() => {
                const chkCmd = adapter.psCheckCommand(workerPid);
                const chk = io.exec(chkCmd.cmd, chkCmd.args);
                return chk.code === 0 && /worker\.cjs/.test(chk.stdout);
            })();
        live.worker = live.worker || {};
        live.worker.process_alive = alive;
        if (!alive) log.warn(`worker process (pid ${workerPid}) is not running — see the worker log`);
    }

    // Re-probe disk state for the final report
    const envAfter = probe.probeEnvironment(io, { root: comfyuiRoot, workerDir, crypto, workerType: expectedType });
    const reportAfter = require('../compatibility-resolver').resolveInstallation({
        manifests, environment: envAfter, mode: manifests.length > 1 ? 'shared' : 'existing',
    });
    const ver = buildVerificationReport({ report: reportAfter, live });
    log.output(ver.text);
    return ver;
}

/** Read one KEY value from the local .env (verification only; redacted). */
function readEnvValueLocal(io, workerDir, key) {
    try {
        const text = io.fs.readFileSync(path.join(workerDir, '.env'), 'utf8');
        for (const line of text.split('\n')) {
            const m = new RegExp(`^${key}\\s*=\\s*(.*)$`).exec(line.trim());
            if (m) return m[1].trim() || null;
        }
    } catch (_) { /* no .env */ }
    return null;
}

// ---------------------------------------------------------------------------
// Service autostart + port selection (managed mode owns the whole stack)
// ---------------------------------------------------------------------------

/**
 * Classify what listens on 127.0.0.1:<port>:
 *   'free'    — nothing answers (connection refused / timeout)
 *   'comfyui' — a ComfyUI API (/system_stats → JSON with .system)
 *   'foreign' — something else answers
 * A FOREIGN service on the default port must never receive this install's
 * worker: shared hosts routinely run several users' ComfyUI instances.
 */
async function comfyPortState(io, port) {
    try {
        const res = await io.http.fetchJson(`http://127.0.0.1:${port}/system_stats`, { signal: AbortSignal.timeout(2000) });
        if (res && res.status === 200 && res.json && res.json.system) return 'comfyui';
        return 'foreign';
    } catch (_) {
        return 'free';
    }
}

/**
 * Pick the ComfyUI port for this install:
 *   1. a ComfyUI this installer started previously and still alive → keep it
 *   2. default 8188 when free → take it
 *   3. non-managed mode: the user's own ComfyUI on 8188 IS the target → use it
 *   4. otherwise the first free port in the managed range (8288+)
 */
async function autoPickComfyPort(io, { st, mode, log }) {
    const rt = st.comfyui_runtime;
    if (rt && rt.port && await comfyPortState(io, rt.port) === 'comfyui') return rt.port;
    const s8188 = await comfyPortState(io, 8188);
    if (s8188 === 'free') return 8188;
    if (mode !== 'managed' && s8188 === 'comfyui') return 8188;
    for (const p of [8288, 8289, 8290, 8291]) {
        if (await comfyPortState(io, p) === 'free') {
            if (log) log.info(`port 8188 is occupied (${s8188}) — this install's ComfyUI will use port ${p}`);
            return p;
        }
    }
    return 8188;
}

module.exports = {
    runInstallation,
    runVerification,
    pickTorchSpec,
    readEnvValueLocal,
    loadResumableState,
    renderResumeSummary,
    sanitizeDecisions,
    createInterruptGuard,
    comfyPortState,
    autoPickComfyPort,
    desiredEnvWiring,
    endToEndChecks,
    CPU_MODE_WARNING,
};
