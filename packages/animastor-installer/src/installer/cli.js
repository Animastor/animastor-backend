#!/usr/bin/env node
'use strict';

/**
 * Animastor GPU Worker Installer CLI — Phase 2.
 *
 * Usage:
 *   animastor-installer detect     [--root PATH] [--worker-dir PATH]
 *   animastor-installer plan       --profile P[,P2] [--mode managed|existing|shared] [--root PATH]
 *   animastor-installer install    --profile P[,P2] [--mode ...] [--root PATH] [--yes] [--dry-run] [--worker-dir PATH] [--hub-url URL]
 *                                  [--start-comfy] [--comfy-port N] [--start-worker]
 *                                  [--accept-reference-runtime]
 *   animastor-installer verify     [--profile P[,P2]] [--root PATH] [--worker-dir PATH] [--hub-url URL]
 *   animastor-installer resume
 *   animastor-installer uninstall  [--all] [--yes] [--dry-run] [--state PATH] [--home PATH]
 *   animastor-installer start | stop | status | logs [-f] [--lines N] | doctor [--new-key]
 *                                  (what the `animastor` command in PATH runs)
 *
 * Flags:
 *   --profile P        Generation profile id (repeatable or comma-separated)
 *   --mode MODE        managed | existing | shared (default: existing when a ComfyUI
 *                      is found — in ~/ComfyUI or as a running process — else managed)
 *   --root PATH        ComfyUI root directory (default: ~/ComfyUI)
 *   --worker-dir PATH  Worker bundle directory (default: ~/animastor/worker)
 *   --hub-url URL      GPU Hub base URL (default: https://animastor.org/gpu)
 *   --repo-root PATH   Animastor repo root (default: derived from cli.js location)
 *   --state PATH       Install state file path
 *   --yes              Auto-confirm all prompts
 *   --dry-run          Show plan only; never perform real changes
 *   --all              uninstall: full uninstall (everything recorded in the manifest)
 */

const fs = require('fs');
const path = require('path');

const { createRealIo, createDryRunIo } = require('./engine/io');
const { createLogger } = require('./engine/logger');
const { createTermRenderer } = require('./engine/term');
const platforms = require('./platform');
const probeMod = require('./engine/probe');
const { probeEnvironment, renderDetection } = probeMod;
const { runInstallation, loadResumableState, renderResumeSummary } = require('./engine/engine');
const prereq = require('./engine/prereq');
const stateStore = require('./engine/state');
const management = require('./management');
const resolver = require('./compatibility-resolver');
const { buildInstallPlan, renderPlanText, planNeedsPythonRuntime } = require('./install-plan');
const manifest = require('./install-manifest');
const uninstaller = require('./uninstaller');
const { createPrompt, NoTerminalError } = require('./engine/tty');
const { renderBanner, renderFinalSummary } = require('./engine/summary');
const fixes = require('./engine/fixes');
const workerMod = require('./engine/worker');
const comfyuiMod = require('./engine/comfyui');
const comfyOwner = require('./engine/comfy-owner');
const downloader = require('./engine/downloader');
const { resolveRepoBundleDir } = require('./worker-bundle-source');
const engineMod = require('./engine/engine');

// ---------------------------------------------------------------------------
// Paths (platform-specific defaults; the platform adapter owns them)
// ---------------------------------------------------------------------------

const CLI_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/**
 * The platform adapter is auto-detected ONCE at CLI startup. An unsupported
 * host (e.g. macOS) fails here — clearly, early, before any side effect —
 * instead of somewhere inside a Linux-only code path.
 * (Resolution is silent; support notices are printed by main().)
 */
function bootPlatform() {
    return platforms.resolveRuntime();
}

const PLATFORM_RUNTIME = bootPlatform();
const PLATFORM_ADAPTER = PLATFORM_RUNTIME.adapter;

/** Support notices: preview platform / experimental deployment. */
function printPlatformNotices() {
    if (!PLATFORM_ADAPTER.productionReady) {
        console.error('=========================================================================');
        console.error(`  PREVIEW PLATFORM: ${PLATFORM_ADAPTER.displayName}`);
        console.error(`  ${PLATFORM_ADAPTER.previewNotice || 'This platform is not production-supported yet.'}`);
        console.error('=========================================================================');
    }
    if (PLATFORM_RUNTIME.deployment === 'docker' && !PLATFORM_RUNTIME.deploymentAdapter.productionReady) {
        console.error(`[notice] docker deployment detected (${PLATFORM_RUNTIME.deploymentAdapter.displayName}) — experimental, NOT production-supported yet.`);
    }
}

/** Home directory, respecting the platform's env variable. */
function homeDir() {
    return process.env[PLATFORM_ADAPTER.HOME_ENV]
        || require('os').homedir();
}

const DEFAULT_ROOT = PLATFORM_ADAPTER.defaultRoot(homeDir());
const DEFAULT_WORKER_DIR = PLATFORM_ADAPTER.defaultWorkerDir(homeDir());
const DEFAULT_HUB_URL = 'https://animastor.org/gpu';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const args = argv.slice(2);
    const parsed = { command: null, profiles: [], flags: {} };
    const positional = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            if (['yes', 'dry-run', 'resume', 'start-comfy', 'start-worker', 'no-start-comfy', 'no-start-worker', 'all', 'accept-reference-runtime', 'accept-runtime-change', 'install-tools', 'no-tools', 'new-key', 'follow', 'no-fix'].includes(key)) {
                parsed.flags[key] = true;
            } else {
                const val = args[++i];
                parsed.flags[key] = val || '';
            }
        } else if (a === '-f') {
            parsed.flags.follow = true;
        } else if (a === '-y') {
            parsed.flags.yes = true;
        } else {
            positional.push(a);
        }
    }
    parsed.command = positional[0] || null;
    const profileFlag = parsed.flags.profile || '';
    if (profileFlag) {
        parsed.profiles = profileFlag.split(',').map((s) => s.trim()).filter(Boolean);
    }
    // Normalize: every cmd* receives `flags` and reads flags.profiles
    parsed.flags.profiles = parsed.profiles;
    return parsed;
}

function resolveRoot(flags) {
    return flags.root || DEFAULT_ROOT;
}

function resolveWorkerDir(flags) {
    return flags['worker-dir'] || DEFAULT_WORKER_DIR;
}

function resolveHubUrl(flags) {
    return flags['hub-url'] || DEFAULT_HUB_URL;
}

/**
 * Root that holds the bundled worker files and workflows. In the hub
 * installer tarball that is the unpacked `animastor-installer/` itself
 * (worker/worker/, backend/ai/workflows/ next to src/); in a repo checkout
 * it is the repository root. (The tarball case used to resolve OUTSIDE the
 * unpacked bundle, so the bundled worker could never be found.)
 */
function resolveRepoRoot(flags) {
    if (flags['repo-root']) return flags['repo-root'];
    if (resolveRepoBundleDir(fs, CLI_ROOT)) return CLI_ROOT;
    return REPO_ROOT;
}

function resolveStatePath(flags) {
    return flags.state || path.join(resolveRoot(flags), '.animastor-installer', 'install-state.json');
}

/**
 * Management tools install directory: next to the worker/runtime
 * (<workerDir parent>/tools, e.g. ~/animastor/tools). Overridable.
 */
function resolveToolsDir(flags) {
    return flags['tools-dir'] || path.join(path.dirname(resolveWorkerDir(flags)), 'tools');
}

/**
 * Resolve the management runtime targets for the tool subcommands
 * (status / monitor / reboot-*). Explicit flags win over the install state;
 * a missing worker dir falls back to the documented default layout.
 */
function managementTargets(io, flags) {
    const targets = management.resolveTargets(io, {
        statePath: resolveStatePath(flags),
        root: flags.root || null,
        workerDir: flags['worker-dir'] || null,
        port: flags.port ? Number(flags.port) : null,
    });
    if (!targets.workerDir) targets.workerDir = DEFAULT_WORKER_DIR;
    return targets;
}

/**
 * Shared ownership guard for every management command: blocks a sudo run
 * against a user-owned installation and any cross-tenant access (same rules
 * as the installer gates). Prints the violations and sets the exit code.
 * @returns {boolean} true when access is allowed
 */
function guardManagementAccess(io, targets) {
    const access = management.checkAccess(io, targets);
    if (!access.ok) {
        console.error('Management tools stopped because of an ownership mismatch:');
        for (const v of access.violations) console.error(`  ${v.message}`);
        process.exitCode = 1;
        return false;
    }
    return true;
}

/**
 * Management-tools decision: explicit flags win; a decision recorded by a
 * previous run is kept (tools are part of the installation state and are
 * refreshed idempotently); otherwise ask / default to Yes (interactive runs
 * prompt "Install command-line management tools?").
 */
async function resolveToolsDecision({ flags, prompt = null, prior = null }) {
    if (flags['no-tools']) return false;
    if (flags['install-tools']) return true;
    if (prior === true || prior === false) return prior;
    if (prompt) return prompt.confirm('Install command-line management tools?');
    return true; // non-interactive default: tools are part of a normal installation
}

function priorToolsDecision(io, statePath) {
    const st = statePath ? stateStore.loadState(io, statePath) : null;
    return st && st.decisions && typeof st.decisions.install_management_tools === 'boolean'
        ? st.decisions.install_management_tools
        : null;
}

/**
 * Host gates that run BEFORE any heavy change (plan execution, venv, clone,
 * model downloads): Python venv/ensurepip/pip prerequisites and ownership
 * mixing (sudo vs. normal user). On failure prints the exact remediation
 * and exits — the installer never ploughs on into an unrecoverable state.
 */
async function runHostGates(realIo, { paths, dryRun = false, stateUid = null, venvDir = null, needVenv = true, prompt = null, yes = false, log = null }) {
    const uid = prereq.currentUid();
    const ownership = prereq.checkOwnership(realIo, {
        paths,
        home: prereq.currentHome(),
        currentUid: uid,
        stateUid,
    });
    if (!ownership.ok) {
        console.error('\nInstallation stopped because of an ownership mismatch:');
        for (const v of ownership.violations) console.error(`  ${v.message}`);
        console.error('\nDo not mix sudo and normal-user installs in the same home directory.');
        process.exit(1);
    }
    if (dryRun) return;
    // Only what the plan will ACTUALLY use is checked: a working `existing`
    // ComfyUI with every model/node present never touches a venv, so a
    // missing python3.X-venv must not block (or be installed for) nothing.
    if (!needVenv) return;
    const gateOpts = { python: 'python3', deep: true, existingVenvDir: venvDir };
    const gate = prereq.checkPythonPrerequisites(realIo, gateOpts);
    if (gate.ok) return;
    // root / passwordless sudo: install the package on consent and CONTINUE
    // in this same run ("Install python3.12-venv now? [Y/n]"); --yes installs
    // without asking. Without the privileges the exact command is printed.
    const resolved = await prereq.resolveHostPrerequisite(realIo, {
        failure: gate.failure, opts: gateOpts, prompt, yes, log,
    });
    if (resolved.ok) {
        console.log(`✓ ${resolved.installed.packages.join(' ')} installed — continuing`);
        return;
    }
    console.error('');
    for (const line of prereq.renderRemediation(resolved.failure)) console.error(line);
    if (resolved.install && resolved.install.message) console.error(resolved.install.message);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Resolve the environment against the manifests and build the install plan —
 * the ONLY call shape that produces a plan in the CLI. The plan is ALWAYS
 * built from a freshly resolved report passed under the `report` key, so
 * buildInstallPlan can never be invoked with a missing/undefined report.
 * The plan is re-derived after the interactive prompts because decisions
 * change it; the report is re-resolved at the same time (single source).
 */
function resolveAndPlan({ manifests, env, mode, decisions }) {
    const report = resolver.resolveInstallation({ manifests, environment: env, mode });
    const plan = buildInstallPlan({ report, manifests, decisions });
    return { report, plan };
}

/**
 * Same as resolveAndPlan, plus the real download size of incomplete model
 * repos (ModelScope listing) so the plan shows exactly what will be
 * downloaded. Network failures leave the size unknown.
 */
async function resolveAndPlanWithSizes({ io, manifests, env, mode, decisions }) {
    const report = resolver.resolveInstallation({ manifests, environment: env, mode });
    try { await downloader.annotateMissingModelSizes(io, report, manifests); } catch (_) { /* size unknown */ }
    const plan = buildInstallPlan({ report, manifests, decisions });
    return { report, plan };
}

/**
 * The question asked for a plan step. Component lists are already printed
 * in the plan (Missing/Actions) — list-type questions get one short line
 * instead of a second copy of the menu; context questions (ComfyUI version
 * decisions) are shown in full because the plan does not contain them.
 */
function stepQuestion(step) {
    switch (step.id) {
        case 'custom-nodes': return 'Install the missing custom node(s) listed above?';
        case 'models': return 'Download the missing model file(s) listed above?';
        case 'workflows': return 'Install the optional profile workflows (not required for Animastor)?';
        case 'worker-setup': return 'Install and configure the Animastor worker (listed above)?';
        default: return String(step.prompt.question).replace(/\n\n+/g, '\n');
    }
}

/** Versions shown in the banner. Hub/bootstrap versions come from the bootstrap env. */
function bannerVersions(manifests, flags, { hub = null } = {}) {
    const pkg = require('../../package.json');
    let worker = process.env.ANIMASTOR_WORKER_BUNDLE_VERSION || null;
    if (!worker) {
        const dir = resolveRepoBundleDir(fs, resolveRepoRoot(flags));
        if (dir) worker = workerMod.readPkgVersion({ fs: { readFileSync: fs.readFileSync } }, dir);
    }
    return {
        installer: pkg.version,
        worker,
        profile: manifests.map((m) => m.profile.id).join(' + '),
        profileRevision: manifests.length === 1 ? manifests[0].revision : null,
        hub: process.env.ANIMASTOR_HUB_VERSION || hub || null,
        bootstrap: process.env.ANIMASTOR_BOOTSTRAP_VERSION || null,
        platform: `${PLATFORM_RUNTIME.platform}/${PLATFORM_RUNTIME.deployment}`,
    };
}

/** Absolute path of the `animastor` command of this installation. */
function toolCommandPath(flags) {
    const linkDir = management.defaultLinkDir();
    if (linkDir) {
        const link = path.join(linkDir, 'animastor');
        if (fs.existsSync(link)) return link;
    }
    return path.join(resolveToolsDir(flags), 'animastor');
}

/**
 * Hub version for the banner. The bootstrap exports ANIMASTOR_HUB_VERSION;
 * the install state remembers it; otherwise the hub is asked: GET
 * <hub>/health (when it publishes a version) or the served installer script,
 * whose `export ANIMASTOR_HUB_VERSION="…"` line is exactly what a fresh
 * install receives. Never "hub unknown" while the hub is reachable.
 */
async function detectHubVersion(io, hubUrl, { known = null } = {}) {
    if (known) return String(known);
    const base = String(hubUrl || '').replace(/\/$/, '');
    if (!base || !io.http) return null;
    try {
        const health = await io.http.fetchJson(`${base}/health`);
        if (health && health.status === 200 && health.json && health.json.version) return String(health.json.version);
    } catch (_) { /* older hub without a version field */ }
    try {
        const res = await io.http.fetchText(`${base}/installer`);
        const text = res && res.status === 200 ? String(res.text || res.body || '') : '';
        const m = /ANIMASTOR_HUB_VERSION="?([0-9][^"\n]*)"?/.exec(text);
        if (m) return m[1].trim();
    } catch (_) { /* offline — the banner falls back to "unknown" */ }
    return null;
}

/**
 * Decisions of a previous run that are reused as the STARTING point of this
 * one: a re-run does not ask again about steps the user already answered
 * (optional workflows declined once stay declined — also for `doctor --yes`
 * on every boot). Secret-related facts are never stored, so nothing leaked
 * can be reused here.
 */
const REUSED_DECISION_KEYS = ['comfyui_update', 'install_custom_nodes', 'install_models', 'workflows', 'worker_setup', 'accept_reference_runtime', 'accept_runtime_change'];
function priorReusableDecisions(state) {
    const out = {};
    const d = state && state.decisions;
    if (!d) return out;
    for (const k of REUSED_DECISION_KEYS) if (d[k] !== undefined) out[k] = d[k];
    return out;
}

/**
 * The boot script (`animastor doctor --yes`, no TTY): one line of output and
 * an exit code, nothing else. `ANIMASTOR_BOOT=1` forces it on a TTY too.
 */
function isBootRun(flags, doctor) {
    if (!doctor || flags.yes !== true) return false;
    if (process.env.ANIMASTOR_BOOT === '1') return true;
    return !process.stdout.isTTY;
}

/** Host packages the boot path must restore when the image dropped them. */
function missingRequiredHostPackages(io) {
    const out = [];
    if (!probeMod.pickNodeBinary(io)) out.push('nodejs');
    return out;
}

/**
 * Wait for the platform's ComfyUI (boot: it starts after the installer).
 * Re-resolves the ownership facts on every poll — the port and the notebook
 * prefix are read from the process each time, never remembered.
 */
async function waitForPlatformComfy(io, { state = null, root = null, timeoutMs = 180000, intervalMs = 3000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let inst = await comfyOwner.resolveComfyOwner(io, { state, root });
    while (inst.owner === 'none' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, intervalMs));
        inst = await comfyOwner.resolveComfyOwner(io, { state, root });
    }
    return inst;
}

/** The `animastor` command recorded for this installation (fix lines). */
function toolCommand(flags) {
    const tool = path.join(resolveToolsDir(flags), 'animastor');
    const linked = path.join(management.defaultLinkDir() || '', 'animastor');
    if (fs.existsSync(linked) && String(process.env.PATH || '').split(path.delimiter).includes(path.dirname(linked))) return 'animastor';
    if (fs.existsSync(tool)) return tool;
    return 'animastor';
}

/** Secret values collected interactively — memory-only, never persisted. */
function makeSecretProvider(secrets) {
    if (!secrets || Object.keys(secrets).length === 0) return null;
    return async (name) => (Object.prototype.hasOwnProperty.call(secrets, name) ? secrets[name] : null);
}

async function cmdDetect(flags) {
    const root = resolveRoot(flags);
    const workerDir = resolveWorkerDir(flags);
    const io = createRealIo();
    const env = probeEnvironment(io, { root, workerDir, crypto: require('crypto') });
    console.log(renderDetection(env));
}
async function cmdPlan(flags) {
    if (flags.profiles.length === 0) {
        console.error('error: --profile is required');
        process.exit(1);
    }
    const root = resolveRoot(flags);
    const workerDir = resolveWorkerDir(flags);
    const hubUrl = resolveHubUrl(flags);
    const repoRoot = resolveRepoRoot(flags);
    const io = createRealIo();
    const crypto = require('crypto');
    const env = probeEnvironment(io, { root, workerDir, crypto, workerType: null });

    const loadedManifests = flags.profiles.map((p) => manifest.loadManifest(p));
    const mode = flags.mode || (env.comfyui && env.comfyui.present ? 'existing' : 'managed');
    const { plan } = resolveAndPlan({ manifests: loadedManifests, env, mode, decisions: {} });
    console.log(plan.plan_text);
}

/**
 * The shared terminal renderer for an install run: ONE stream for installer
 * status (logger sink), the download progress line and the busy spinner, so
 * log lines erase and redraw around the live status instead of overwriting
 * it. Terminals with a non-UTF-8 locale get an ASCII spinner fallback.
 */
function createScreen() {
    const locale = String(process.env.LC_ALL || process.env.LANG || '');
    const ascii = locale !== '' && !/utf-?8/i.test(locale);
    return createTermRenderer({
        isTTY: !!process.stdout.isTTY,
        write: (s) => { process.stdout.write(s); },
        ascii,
    });
}

async function cmdInstall(flags, { doctor = false } = {}) {
    const realIo = createRealIo();
    // doctor = the same idempotent install for the RECORDED installation:
    // profiles come from install-state.json unless given explicitly. The
    // recorded MODE is not applied: the mode follows the machine (see
    // engine/comfy-owner.js) — a contradiction is shown and corrected.
    const statePathEarly = resolveStatePath(flags);
    let recorded = null;
    if (doctor) {
        recorded = stateStore.loadState(realIo, statePathEarly);
        if (!recorded || !Array.isArray(recorded.profiles) || recorded.profiles.length === 0) {
            console.error(`No Animastor installation found (state: ${statePathEarly}). Run the install command from the Animastor setup page first.`);
            process.exit(2);
        }
        if (flags.profiles.length === 0) flags.profiles = recorded.profiles.slice();
    }
    if (flags.profiles.length === 0) {
        console.error('error: --profile is required');
        process.exit(1);
    }
    // Recorded facts reused as the starting point: previous non-secret
    // decisions (no repeated questions) and the hub version for the banner.
    const priorState = recorded || stateStore.loadState(realIo, statePathEarly);
    const boot = isBootRun(flags, doctor);
    // ComfyUI root: --root > ~/ComfyUI (when it holds a ComfyUI) > the root
    // of the user's running ComfyUI process > ~/ComfyUI (managed creates it).
    const runningComfy = probeMod.detectRunningComfyUI(realIo);
    const rootPick = probeMod.resolveComfyRoot(realIo, { explicit: flags.root || null, defaultRoot: DEFAULT_ROOT, running: runningComfy });
    flags.root = rootPick.root;
    const root = rootPick.root;
    const workerDir = resolveWorkerDir(flags);
    const hubUrl = resolveHubUrl(flags);
    const repoRoot = resolveRepoRoot(flags);
    const statePath = statePathEarly;
    const dryRun = flags['dry-run'] || false;
    const yes = flags.yes || false;
    const crypto = require('crypto');

    // Probing is read-only and always runs against the REAL io. In dry-run
    // mode the guarded io is used ONLY inside the engine, where every
    // mutating operation would throw a "dry-run violation".
    const screen = createScreen();
    const logger = createLogger({ io: realIo, sink: (line) => screen.print(line) });
    const loadedManifests = flags.profiles.map((p) => manifest.loadManifest(p));
    const hubVersion = doctor
        ? await detectHubVersion(realIo, hubUrl, { known: process.env.ANIMASTOR_HUB_VERSION || (priorState && priorState.hub_version) || null })
        : (process.env.ANIMASTOR_HUB_VERSION || null);

    if (!boot) {
        console.log(renderBanner(bannerVersions(loadedManifests, flags, { hub: hubVersion })));
        if (doctor) console.log('animastor doctor — re-checking the installation and fixing what can be fixed\n');
    }

    // ONE prompt object for the whole run; every question reads /dev/tty
    // when stdin is the `curl | bash` pipe. Created BEFORE the ownership
    // questions below.
    const prompt = createPrompt();

    // Restore the PATH block before anything else: the dotfiles are reset on
    // every node boot while ~/.local/bin/animastor survives.
    const pathEntry = management.restoreCommandPath(realIo, { linkDir: management.defaultLinkDir(), home: homeDir() });
    if (!boot && pathEntry.updated.length > 0) console.log(`PATH block restored: ${pathEntry.updated.join(', ')}`);

    // Host packages that disappeared with the image restart (boot path).
    if (doctor) {
        const missingPkgs = missingRequiredHostPackages(realIo);
        if (missingPkgs.length > 0) {
            const r = await prereq.installMissingHostPackages(realIo, {
                packages: missingPkgs, prompt: boot ? null : prompt, yes, log: logger,
            });
            if (r.installed.length > 0 && !boot) console.log(`✓ installed ${r.installed.join(' ')}`);
            else if (!r.ok && !boot) console.log(`! ${r.message}`);
        }
    }

    // ComfyUI ownership BY FACT: a verified ComfyUI process the installer did
    // not start decides the mode (existing) and the worker address; the
    // installer never starts a second one next to it.
    let instance = await comfyOwner.resolveComfyOwner(realIo, { state: priorState, root });
    const comfyWaitMs = flags['comfy-wait-ms'] ? Number(flags['comfy-wait-ms'])
        : (Number(process.env.ANIMASTOR_COMFY_WAIT_MS) || (boot ? 180000 : 0));
    if (comfyWaitMs > 0 && instance.owner === 'none') {
        if (!boot) console.log(`Waiting up to ${Math.round(comfyWaitMs / 1000)} s for the platform's ComfyUI…`);
        instance = await waitForPlatformComfy(realIo, { state: priorState, root, timeoutMs: comfyWaitMs });
    }

    // The machine decides the mode. An explicit --mode that contradicts it is
    // reported, never silently applied: starting a second ComfyUI next to the
    // platform's is exactly the failure this release fixes.
    const mode = instance.mode;
    if (!boot) {
        if (flags.mode && flags.mode !== instance.mode) {
            console.log(`Mode: ${instance.mode} — ${instance.reason}; --mode ${flags.mode} ignored (the machine decides)`);
        } else {
            console.log(`Mode: ${instance.mode} — ${instance.reason}`);
        }
    }
    if (instance.conflicts.length > 0 && !boot) {
        console.log('\nThe recorded installation disagrees with this machine:');
        for (const c of instance.conflicts) console.log(`  ! ${c.message}`);
        console.log('  → corrected for this run and stored in install-state.json');
    }
    if (instance.stop_offer) {
        const pid = instance.stop_offer.pid;
        const question = `Stop the installer's own ComfyUI (pid ${pid})? The platform instance ${instance.foreign.url} is the real one.`;
        let stopIt = false;
        if (yes) stopIt = true;
        else if (prompt.available) stopIt = await prompt.confirm(question, { defaultYes: true });
        else if (!boot) console.log(`  · ${question} (non-interactive — left running; --yes stops it)`);
        if (stopIt) {
            const stopRes = comfyOwner.stopInstallerInstance(realIo, instance.ours);
            if (!boot) console.log(stopRes.stopped ? `✓ installer ComfyUI stopped (pid ${pid})` : `! ${stopRes.reason}`);
        }
    }

    const env = probeEnvironment(realIo, {
        root, workerDir, crypto,
        workerType: loadedManifests.length === 1 ? (loadedManifests[0].worker_bundle || {}).worker_type : null,
    });

    // The dry-run guard wraps everything handed to the engine so any
    // accidental mutation throws "dry-run violation" instead of executing.
    const io = dryRun ? createDryRunIo(realIo) : realIo;

    // The plan comes FIRST: the prerequisite check must know whether the
    // Python runtime/venv is used at all (a working `existing` ComfyUI with
    // its models already in place needs none). Previously answered steps
    // (a declined optional workflow, a declined model download) are not
    // asked again.
    const priorDecisions = priorReusableDecisions(priorState);
    const { plan, report: planReport } = await resolveAndPlanWithSizes({ io: realIo, manifests: loadedManifests, env, mode, decisions: priorDecisions });

    // Prerequisites & ownership BEFORE any prompt/change: a missing
    // python3.X-venv is reported/installed up front (when the plan uses the
    // runtime), not after the user has answered every question.
    await runHostGates(realIo, {
        paths: [root, workerDir, statePath, resolveToolsDir(flags)].filter(Boolean),
        dryRun,
        venvDir: path.join(root, 'venv'),
        needVenv: planNeedsPythonRuntime({ plan, report: planReport, mode }),
        prompt,
        yes,
        log: logger,
    });

    // Mode was printed above with its reason; the questions are asked below
    // one by one — neither is repeated in the plan text.
    if (!boot) {
        console.log(`Profile: ${plan.profiles.join(' + ')}\n`);
        console.log(renderPlanText(plan, planReport, { questions: false, header: false }));
    }

    const needPrompt = () => {
        if (!prompt.available) {
            console.error('');
            console.error(require('./engine/tty').NO_TTY_MESSAGE);
            process.exit(3);
        }
        return prompt;
    };

    try {
        // CPU-only mode is always announced explicitly and confirmed before any
        // change: the user must see that performance will be significantly lower.
        const device = env.device || (env.gpu ? 'cuda' : 'cpu');
        if (device === 'cpu' && !dryRun) {
            console.log('\n=========================================================================');
            console.log('  CPU-ONLY MODE: no supported GPU was detected.');
            console.log('  A CPU build of PyTorch will be installed and ComfyUI will run');
            console.log('  with --cpu. Performance will be SIGNIFICANTLY lower.');
            console.log('  This mode is intended for the TTS/audio profile test scenario.');
            console.log('=========================================================================');
            if (!yes) {
                const proceed = await needPrompt().confirm('Continue with the CPU-only installation?');
                if (!proceed) {
                    console.log('Aborted — nothing was changed.');
                    process.exit(0);
                }
            }
        }

        if (dryRun) {
            console.log('\n[dry-run] zero mutations performed');
            return;
        }

        if (plan.blocked.length > 0) {
            printFinal({ blocked: plan.blocked, tool: toolCommand(flags), mode });
            process.exitCode = 1;
            return;
        }

        // Auto-fix: one list, one question — instead of warnings. The ComfyUI
        // address comes from the running process (comfy-owner), verified by
        // GET /system_stats, and is recomputed on EVERY run: port and notebook
        // prefix change between boots, so the remembered .env is not trusted.
        const nodePick = probeMod.pickNodeBinary(realIo);
        const port = flags['comfy-port'] ? Number(flags['comfy-port']) : (instance.port || null);
        let probedUrl = instance.url || null;
        if (!probedUrl && (port || mode !== 'managed')) {
            const envNow = workerMod.readEnvValues(realIo, workerDir);
            const pr = await probeMod.probeComfyUrl(realIo, {
                port: port || Number(envNow.COMFY_PORT) || 8188,
                prefixes: [envNow.NOTEBOOK_PATH, runningComfy && runningComfy.baseurl].filter(Boolean),
            });
            probedUrl = pr.url;
        }
        const desired = engineMod.desiredEnvWiring({
            manifests: loadedManifests,
            nodeBin: nodePick ? nodePick.bin : null,
            comfyUrl: probedUrl,
            comfyPort: port,
            hubUrl,
            hubUrlExplicit: !!flags['hub-url'],
        });
        const fixPlan = fixes.planFixes(realIo, {
            workerDir, desired,
            sourceBundleDir: resolveRepoBundleDir(fs, repoRoot),
            sourceVersion: process.env.ANIMASTOR_WORKER_BUNDLE_VERSION || null, // served by the hub (bootstrap)
        });
        let applyFixes = true;
        if (fixPlan.additions.length > 0 && !boot) {
            console.log(`\nWorker settings to add: ${fixPlan.additions.join(', ')}`);
        }
        if (fixPlan.items.length > 0) {
            if (!boot) {
                console.log('\nThe installer will fix:');
                fixPlan.items.forEach((f, i) => console.log(`  ${i + 1}. ${f.title}`));
            }
            if (flags['no-fix']) applyFixes = false;
            else if (!yes) applyFixes = await needPrompt().confirm(`Fix ${fixPlan.items.length === 1 ? 'it' : `all ${fixPlan.items.length}`}?`, { defaultYes: true });
            if (!applyFixes && !boot) console.log('Not fixing — the remaining problems are listed in the result.');
        }

        const decisions = { ...priorDecisions, apply_fixes: applyFixes };
        // Management tools (the `animastor` command): part of a normal
        // installation; --no-tools opts out, a recorded decision is kept.
        decisions.install_management_tools = await resolveToolsDecision({
            flags, prompt: null, prior: priorToolsDecision(realIo, statePath),
        });
        if (flags['accept-reference-runtime']) decisions.accept_reference_runtime = true;
        if (flags['accept-runtime-change']) decisions.accept_runtime_change = true;
        // Secret VALUES live only in this closure — never in decisions, logs,
        // state, or argv. The engine receives them via secretProvider.
        const secrets = {};

        if (yes) {
            // --yes answers everything EXCEPT steps the user already declined:
            // a "no" to the optional workflows (and to model/node downloads)
            // is remembered, so a boot-time `doctor --yes` never installs them
            // behind the user's back.
            const yd = yesDecisions();
            for (const k of ['workflows', 'install_models', 'install_custom_nodes']) {
                if (priorDecisions[k] !== undefined) yd[k] = priorDecisions[k];
            }
            Object.assign(decisions, yd);
        } else if (plan.awaiting_decisions.length > 0) {
            for (const stepId of plan.awaiting_decisions) {
                const step = plan.steps.find((s) => s.id === stepId);
                if (!step || !step.prompt) continue;
                if (stepId === 'worker-key' && decisions.worker_setup === false) {
                    // worker setup was declined — the key prompt is skipped too
                    decisions.worker_key_provided = false;
                    continue;
                }
                if (step.kind === 'secret-prompt') {
                    // Re-install over an already configured worker: the key is
                    // in .env — never ask for it again (a key that the hub
                    // REJECTED is replaced via --new-key, not by re-asking).
                    if (stepId === 'worker-key' && !flags['new-key']
                        && workerMod.hasEnvKey(realIo, workerDir, 'ANIMASTOR_WORKER_TOKEN')) {
                        console.log(`Worker Key: kept from ${path.join(workerDir, '.env')} (already configured — not asked again; use --new-key to replace it)`);
                        decisions.worker_key_provided = true;
                        continue;
                    }
                    // Worker Key step: real hidden input (never a Yes/No confirm —
                    // a typed token must not be misread as an answer). Only the
                    // boolean fact "provided" enters the decisions; the value
                    // itself is handed to the engine through secretProvider.
                    let provided = false;
                    for (const key of step.secret_keys || []) {
                        const value = await needPrompt().secret(`Paste the Worker Key from the Animastor page (${key}, hidden input)`);
                        if (value) {
                            secrets[key] = value;
                            logger.registerSecret(value); // redact from ALL further output
                            provided = true;
                        }
                    }
                    decisions.worker_key_provided = provided;
                    continue;
                }
                // "Cannot be determined automatically — review": there is
                // nothing to choose; continue with the user's ComfyUI as is.
                if (stepId === 'comfyui-update' && (step.prompt.options || [])[0] === 'Review') {
                    console.log(`${String(step.prompt.question).split('\n')[0]} — continuing with the installed ComfyUI as is.`);
                    decisions.comfyui_update = 'yes';
                    continue;
                }
                const answer = await needPrompt().confirm(stepQuestion(step), { defaultYes: true });
                if (step.consent === 'accept_reference_runtime') {
                    decisions.accept_reference_runtime = answer;
                    continue;
                }
                if (stepId === 'comfyui-update') decisions.comfyui_update = answer ? 'yes' : 'no';
                else if (stepId === 'custom-nodes') decisions.install_custom_nodes = answer;
                else if (stepId === 'models') decisions.install_models = answer;
                else if (stepId === 'workflows') decisions.workflows = answer ? 'all' : 'none';
                else if (stepId === 'worker-setup') decisions.worker_setup = answer;
                else if (stepId === 'worker-key') decisions.worker_key_provided = answer;
            }
        }
        if (decisions.worker_setup === undefined) decisions.worker_setup = true;

        // doctor --new-key: the current key was rejected — ask for the new one.
        let replaceWorkerKey = false;
        if (flags['new-key']) {
            const value = await needPrompt().secret('Paste the NEW Worker Key from Animastor → Settings → Workers (hidden input)');
            if (value) {
                secrets.ANIMASTOR_WORKER_TOKEN = value;
                logger.registerSecret(value);
                replaceWorkerKey = true;
            }
        }

        // Re-resolve and rebuild the plan with the recorded decisions — one
        // call shape, so the rebuilt plan always has a resolution report.
        const { plan: plan2 } = resolveAndPlan({ manifests: loadedManifests, env, mode, decisions });
        if (plan2.awaiting_decisions.length > 0) {
            console.error(`\nStill awaiting decisions after prompts (${plan2.awaiting_decisions.join(', ')}) — cannot proceed`);
            process.exit(1);
        }
        if (plan2.blocked.length > 0) {
            printFinal({ blocked: plan2.blocked, tool: toolCommand(flags), mode });
            process.exitCode = 1;
            return;
        }

        const result = await runInstallation({
            manifests: loadedManifests, mode, io,
            roots: { comfyuiRoot: root, workerDir, statePath, repoRoot, hubUrl, toolsDir: resolveToolsDir(flags) },
            decisions, secretProvider: makeSecretProvider(secrets),
            logger, crypto, env, dryRun,
            options: {
                ...installOptions(flags, { doctor }), term: screen,
                runningComfy: mode !== 'managed' ? runningComfy : null,
                hubUrlExplicit: !!flags['hub-url'],
                nodeBinary: nodePick,
                replaceWorkerKey,
                comfyOwner: instance,
                hubVersion,
            },
        });
        printResult(result, { flags, mode, boot, hubVersion });
    } catch (err) {
        if (err instanceof NoTerminalError) {
            console.error('');
            console.error(err.message);
            process.exit(3);
        }
        throw err;
    } finally {
        prompt.close();
    }
}

function installOptions(flags, { doctor = false } = {}) {
    return {
        // Managed mode starts services by default (engine); these flags only
        // carry an explicit ON (--start-comfy) or OFF (--no-start-comfy).
        startComfyui: flags['start-comfy'] === true ? true : flags['no-start-comfy'] === true ? false : undefined,
        comfyPort: flags['comfy-port'] ? Number(flags['comfy-port']) : undefined,
        verifyTimeoutMs: flags['verify-timeout-ms'] ? Number(flags['verify-timeout-ms']) : undefined,
        // --start-worker: launch the installed worker (node worker.cjs) as a
        // detached daemon after the bundle+.env steps and check it is alive
        // during verification. Without it the worker stays stopped (the
        // installer never starts background services unprompted) — EXCEPT in
        // `doctor`, whose job after a node reboot is to bring the worker back.
        startWorker: flags['start-worker'] === true ? true
            : flags['no-start-worker'] === true ? false
                : (doctor ? true : undefined),
    };
}

/**
 * resume — continue an interrupted installation from install-state.json.
 *
 * The state file is the source of "what has been attempted"; disk truth is
 * re-verified for every artifact. If there is NO state file, resume does NOT
 * silently start a new installation.
 */
async function cmdResume(flags) {
    const root = resolveRoot(flags);
    const workerDir = resolveWorkerDir(flags);
    const hubUrl = resolveHubUrl(flags);
    const repoRoot = resolveRepoRoot(flags);
    const statePath = resolveStatePath(flags);
    const crypto = require('crypto');

    const io = createRealIo();
    const check = loadResumableState(io, statePath);
    if (!check.ok) {
        console.log('No resumable installation state found.');
        if (check.reason === 'state-has-no-profiles') {
            console.log(`(state file at ${statePath} exists but records no profiles — cannot resume)`);
        }
        process.exit(1);
    }

    const st = check.state;
    console.log(`Resuming installation of ${st.profiles.join(' + ')}`);
    for (const line of renderResumeSummary(st)) console.log(line);

    // Resume/state semantics after a UID change: an installation created by
    // another user must never be continued under the current one (that is
    // how root-owned files end up inside a user's home).
    await runHostGates(io, {
        paths: [root, statePath, workerDir, resolveToolsDir(flags)].filter(Boolean),
        dryRun: false,
        venvDir: path.join(root, 'venv'),
        needVenv: true,
        prompt: createPrompt(),
        yes: !!flags.yes,
        stateUid: st.owner_uid != null ? st.owner_uid : null,
    });

    let loadedManifests;
    try {
        loadedManifests = st.profiles.map((p) => manifest.loadManifest(p));
    } catch (err) {
        console.error(`fatal: cannot load profile manifests recorded in state: ${err.message}`);
        process.exit(1);
    }

    const mode = st.mode || flags.mode || 'managed';
    const screen = createScreen();
    const logger = createLogger({ io, sink: (line) => screen.print(line) });
    const env = probeEnvironment(io, {
        root, workerDir, crypto,
        workerType: loadedManifests.length === 1 ? (loadedManifests[0].worker_bundle || {}).worker_type : null,
    });

    // restored non-secret decisions from state; CLI --yes can still widen them.
    // Explicit consent flags keep their parity with `install` on resume too —
    // a blocked runtime/reference decision must be resolvable via resume.
    const decisions = { ...(st.decisions || {}), ...(flags.yes ? yesDecisions() : {}) };
    if (flags['accept-reference-runtime']) decisions.accept_reference_runtime = true;
    if (flags['accept-runtime-change']) decisions.accept_runtime_change = true;
    // --no-tools / --install-tools override a previously recorded decision on
    // resume too; otherwise the recorded decision (or install default) applies.
    decisions.install_management_tools = await resolveToolsDecision({
        flags, prompt: null, prior: priorToolsDecision(io, statePath),
    });

    const result = await runInstallation({
        manifests: loadedManifests, mode, io,
        roots: { comfyuiRoot: root, workerDir, statePath, repoRoot, hubUrl, toolsDir: resolveToolsDir(flags) },
        decisions,
        secretProvider: null, // secrets are never persisted; enter them via a fresh `install` if truly required
        logger, crypto, env, initialState: st,
        options: { ...installOptions(flags), term: screen },
    });
    printResult(result);
}

function yesDecisions() {
    return {
        comfyui_update: 'yes',
        install_custom_nodes: true,
        install_models: true,
        workflows: 'all',
        worker_setup: true,
        worker_key_provided: true,
    };
}

/**
 * uninstall — remove what the Animastor installer installed, guided by the
 * installation state/manifest. Components that existed before the installer
 * ran are recorded as not-owned and are never removed.
 *
 * Interactive: full-uninstall or per-group Да/Нет questions, with a summary
 * of the exact deletion list shown before anything is removed.
 */
async function cmdUninstall(flags) {
    const io = createRealIo();
    const statePath = resolveStatePath(flags);
    const home = flags.home || homeDir() || null;
    const dryRun = flags['dry-run'] || false;
    const yes = flags.yes || false;
    const full = flags.all || false;

    const record = uninstaller.loadInstallRecord(io, statePath);
    if (!record) {
        console.log(`No Animastor installation state found at ${statePath}.`);
        console.log('Without the install manifest the uninstaller cannot determine');
        console.log('what was installed by Animastor — and will not guess or delete');
        console.log('anything by name. Remove leftover directories manually if needed.');
        process.exit(1);
    }
    if (record.corrupt) {
        console.error(`Install state at ${statePath} is unreadable (${record.error}).`);
        console.error('Refusing to uninstall without a valid manifest — nothing was removed.');
        process.exit(1);
    }

    // Ownership note: an install created under sudo carries root-owned files.
    // Removing those legitimately requires root — warn instead of blocking.
    const uninstallUid = prereq.currentUid();
    if (record.owner_uid != null && uninstallUid != null && record.owner_uid !== uninstallUid) {
        const ownerDesc = record.owner_uid === 0 ? 'root' : `uid ${record.owner_uid}`;
        console.warn(`Warning: this installation was created by ${ownerDesc}, but you are running as uid ${uninstallUid}.`);
        console.warn('Removal of root-owned files will fail without elevated privileges (sudo).');
    }

    const plan = uninstaller.buildUninstallPlan(io, { state: record, statePath, home });
    console.log(uninstaller.renderUninstallPlan(plan, { state: record }));
    console.log('');

    if (plan.removable_count === 0) {
        console.log('Nothing recorded as installed by Animastor was found on disk — nothing to remove.');
        process.exit(0);
    }

    const answers = {};
    const prompt = createPrompt();
    if (full || yes) {
        for (const g of uninstaller.GROUPS) answers[g.key] = true;
        console.log(full ? 'Mode: FULL uninstall — every removable component listed above will be deleted.' : 'Mode: auto-confirmed (--yes) — every removable component will be deleted.');
    } else {
        const mode = await prompt.select(
            'Choose uninstall mode:',
            [
                'Full uninstall — remove EVERYTHING installed by Animastor',
                'Selective — decide per component',
            ],
        );
        if (mode.startsWith('Full')) {
            for (const g of uninstaller.GROUPS) answers[g.key] = true;
        } else {
            for (const g of uninstaller.GROUPS) {
                // only ask about groups that actually have removable items
                const group = plan.groups.find((x) => x.key === g.key);
                if (!group || !group.items.some((i) => i.removable)) continue;
                answers[g.key] = await prompt.confirm(`Remove ${g.title}?`);
            }
        }
    }

    // Final confirmation: show exactly what will be removed
    const willRemove = [];
    for (const g of plan.groups) {
        if (answers[g.key] !== true) continue;
        for (const it of g.items) {
            if (it.removable) willRemove.push(it.path);
        }
    }
    if (willRemove.length === 0) {
        console.log('\nNothing selected for removal — exiting.');
        prompt.close();
        process.exit(0);
    }
    console.log('\nThe following paths will be REMOVED:');
    for (const p of willRemove) console.log(`  - ${p}`);
    if (!yes) {
        const proceed = await prompt.confirm('\nExecute the uninstall now?');
        if (!proceed) {
            console.log('Aborted — nothing was removed.');
            prompt.close();
            process.exit(0);
        }
    }
    prompt.close();

    const outcome = uninstaller.runUninstallation(io, {
        plan, answers, statePath, dryRun,
        log: createLogger({ io }),
    });
    console.log('');
    console.log(uninstaller.renderUninstallResult(outcome));
    process.exit(outcome.failed > 0 ? 1 : 0);
}

async function cmdVerify(flags) {
    const root = resolveRoot(flags);
    const workerDir = resolveWorkerDir(flags);
    const hubUrl = resolveHubUrl(flags);
    const crypto = require('crypto');
    const io = createRealIo();

    const loadedManifests = flags.profiles.length > 0
        ? flags.profiles.map((p) => manifest.loadManifest(p))
        : [manifest.loadManifest('image/qwen-image')]; // default

    const env = probeEnvironment(io, { root, workerDir, crypto, workerType: loadedManifests[0].worker_bundle.worker_type });
    const report = resolver.resolveInstallation({ manifests: loadedManifests, environment: env, mode: 'existing' });
    const { buildVerificationReport } = require('./verification-report');
    const ver = buildVerificationReport({ report, live: {} });
    console.log(ver.text);
}

/**
 * Final block of an install/doctor run: warnings, then ONE result section —
 * either every check ✓ and "Done", or one line of cause + one exact fix
 * command per ✗ (no "scroll up").
 */
/** Blocked steps + host remediation as summary items (shared by both outputs). */
function resultExtras(result, tool) {
    const extra = [];
    for (const b of result.blocked || []) {
        let fix = result.remediation && result.remediation.command ? `${result.remediation.command} && ${tool} doctor` : `${tool} doctor`;
        if (/accept_runtime_change/.test(b.reason || '')) fix = `if ComfyUI already works, this can be ignored; to let the installer replace the runtime run: ${tool} doctor --accept-runtime-change`;
        else if (/accept_reference_runtime/.test(b.reason || '')) fix = `${tool} doctor --accept-reference-runtime`;
        extra.push({ ok: false, label: `Step "${b.step}"`, detail: b.reason, fix });
    }
    if (result.remediation && (result.blocked || []).length === 0) {
        extra.push({
            ok: false,
            label: 'Host prerequisite',
            detail: `${result.remediation.summary || result.remediation.code}${result.remediation.package ? ` (package ${result.remediation.package})` : ''}`,
            fix: result.remediation.command ? `${result.remediation.command} && ${tool} doctor` : `${tool} doctor`,
        });
    }
    return extra;
}

/**
 * Boot script output: EXACTLY one line plus the exit code — a node that
 * reboots must not need a human to read a 200-line plan, and the one line
 * must say whether the worker is back. `--yes` means zero questions.
 */
function printOneLineSummary(result, { flags = {}, mode = null } = {}) {
    const tool = toolCommandPath(flags);
    const summary = renderFinalSummary({
        verification: result.verification, e2e: result.e2e || [],
        extra: resultExtras(result, tool), tool, mode: mode || result.mode,
    });
    const owner = result.results && result.results.comfy_owner;
    const worker = ((result.results && result.results.worker) || []).find((w) => w.id === 'worker-process');
    const what = [
        `mode ${mode || result.mode}`,
        owner && owner.url ? `ComfyUI ${owner.url}` : 'ComfyUI not reachable',
        worker && worker.started ? `worker pid ${worker.pid}` : 'worker not started',
    ].join(', ');
    const head = summary.ok ? 'OK' : `FAILED — ${summary.failures.length} problem(s)`;
    console.log(`animastor doctor: ${head} — ${what} (${tool})`);
    if (!summary.ok) {
        for (const f of summary.failures) console.log(`  ✗ ${f.label}: ${f.detail || ''}${f.fix ? ` — fix: ${f.fix}` : ''}`);
        process.exitCode = 1;
    }
}

function printResult(result, { flags = {}, mode = null, boot = false } = {}) {
    if (boot) {
        printOneLineSummary(result, { flags, mode });
        return;
    }
    if (result.warnings.length > 0) {
        console.log('\nWarnings:');
        for (const w of result.warnings) console.log(`  ! ${w}`);
    }
    const tool = (result.results && result.results.management_tools && result.results.management_tools.command) || toolCommand(flags);
    const extra = resultExtras(result, tool);
    const summary = renderFinalSummary({ verification: result.verification, e2e: result.e2e || [], extra, tool, mode: mode || result.mode });
    console.log(summary.text);
    // The full path is printed even when ~/.local/bin is already in PATH:
    // after a node reboot the PATH block is gone, and a copy-pasted relative
    // `animastor` must not be the only way to run the command.
    console.log(`\nAnimastor command: ${toolCommandPath(flags)}`);
    // A failed/blocked installation must be visible in the exit code so
    // scripts (and the E2E smoke test) can react.
    if (!summary.ok || result.status === 'failed' || result.status === 'blocked') process.exitCode = 1;
}

/** Result block for a plan that is blocked before anything ran. */
function printFinal({ blocked = [], tool = 'animastor', mode = null }) {
    const extra = blocked.map((b) => ({ ok: false, label: `Step "${b.step || b.id || 'plan'}"`, detail: b.reason, fix: `${tool} doctor` }));
    console.log(renderFinalSummary({ extra, tool, mode }).text);
}

/**
 * validate-manifests — check all manifests for completeness and readiness.
 *
 * Validates:
 *   - JSON schema compliance
 *   - All required dependencies have confirmed sources
 *   - Download planner reports READY for all required models
 *   - Auth requirements are documented
 *   - Checksums are present where possible
 */
async function cmdValidateManifests(flags) {
    const loadedManifests = manifest.loadAllManifests();
    const profiles = Object.keys(loadedManifests);
    let allReady = true;
    const hasHfToken = !!(process.env.HF_TOKEN || process.env.HUGGINGFACE_HUB_TOKEN);

    console.log('Installer Manifest Validation');
    console.log(`Profiles found: ${profiles.length}`);
    console.log(`System HF token: ${hasHfToken ? 'available' : 'not set'}`);
    console.log('');

    for (const profileId of profiles) {
        const m = loadedManifests[profileId];
        const validation = m._validation;
        console.log(`${m.profile.id}`);
        console.log(`  Status: ${m.status}`);
        console.log(`  Revision: ${m.revision}`);

        // Show validation errors/warnings
        if (validation && validation.errors.length > 0) {
            console.log(`  ERRORS: ${validation.errors.length}`);
            for (const e of validation.errors) console.log(`    - ${e}`);
        }
        if (validation && validation.warnings.length > 0) {
            console.log(`  Warnings: ${validation.warnings.length}`);
            for (const w of validation.warnings) console.log(`    - ${w}`);
        }

        // Check dependencies
        const deps = m.dependencies || [];
        const requiredModels = deps.filter((d) => (d.kind === 'model' || d.kind === 'model_repo') && d.requirement === 'required');
        const requiredNodes = deps.filter((d) => d.kind === 'custom_node' && d.requirement === 'required');

        console.log(`  Required models: ${requiredModels.length}`);
        console.log(`  Required nodes: ${requiredNodes.length}`);

        // Check each model source
        let profileReady = true;
        for (const dep of requiredModels) {
            const src = dep.source || {};
            const hasRepo = !!src.repository;
            const hasFilePath = !!src.file_path || dep.kind === 'model_repo';
            const verified = src.verification === 'confirmed';
            const hasChecksum = !!(dep.checksum && dep.checksum.value);
            const gated = !!src.gated;

            let status = 'READY';
            if (!hasRepo || !verified) {
                status = 'BLOCKED — source not verified';
                profileReady = false;
            } else if (gated && !hasHfToken) {
                status = 'BLOCKED — gated model, no HF token';
                profileReady = false;
            }

            const check = hasRepo ? '\u2713' : '\u2717';
            const gatedMark = gated ? ' (gated)' : '';
            const checksumMark = hasChecksum ? '' : ' [no sha256]';
            console.log(`    ${check} ${dep.id}${gatedMark}: ${status}${checksumMark}`);
        }

        // Check custom nodes
        for (const dep of requiredNodes) {
            const src = (dep.install || {}).source || {};
            const hasRepo = !!src.repository;
            const hasCommit = !!src.commit;
            const verified = src.verification === 'confirmed';
            let status = 'READY';
            if (!hasRepo || !hasCommit || !verified) {
                status = 'BLOCKED — commit not pinned';
                profileReady = false;
            }
            const check = (hasRepo && hasCommit) ? '\u2713' : '\u2717';
            console.log(`    ${check} ${dep.id}: ${status}`);
        }

        // Check workflows
        const workflows = (m.workflows || {}).artifacts || [];
        console.log(`  Workflows: ${workflows.length}`);
        for (const wf of workflows) {
            const check = wf.baseline_sha256 ? '\u2713' : '\u2717';
            console.log(`    ${check} ${wf.id}${wf.baseline_sha256 ? '' : ' [no sha256]'}`);
        }

        if (!profileReady) allReady = false;
        console.log('');
    }

    console.log(`\nOVERALL: ${allReady ? 'READY' : 'BLOCKED'}`);
    if (!allReady) {
        console.log('Some profiles have unresolved dependencies. See above for details.');
        process.exit(1);
    }
}

// ---------------------------------------------------------------------------
// Management tools — status / monitor / reboot (shared runtime logic lives in
// management.js; these handlers only resolve targets, guard access, render
// through the shared terminal renderer and set exit codes)
// ---------------------------------------------------------------------------

/** Resolve targets for a tool command; exit 2 when no installation is found. */
function managementTargetsOrExit(io, flags, label) {
    const targets = managementTargets(io, flags);
    if (!targets.found) {
        console.log(`${label}`);
        console.log('');
        console.log('✗ installation not found');
        console.log(`  (looked for state at ${targets.statePath || '—'}, root ${targets.comfyuiRoot || '—'}, worker ${targets.workerDir || '—'})`);
        process.exitCode = 2;
        return null;
    }
    return targets;
}

async function cmdStatus(flags) {
    const io = createRealIo();
    const targets = managementTargetsOrExit(io, flags, 'Animastor status');
    if (!targets) return;
    if (!guardManagementAccess(io, targets)) return;
    const screen = createScreen();
    const snapshot = await management.collectStatus(io, targets);
    for (const line of management.renderStatus(snapshot).split('\n')) screen.print(line);
    process.exitCode = management.statusExitCode(snapshot);
}

async function cmdMonitor(flags) {
    const io = createRealIo();
    const targets = managementTargetsOrExit(io, flags, 'Animastor ComfyUI Monitor');
    if (!targets) return;
    if (!guardManagementAccess(io, targets)) return;
    const screen = createScreen();
    const data = await management.collectMonitor(io, targets, {
        historyMax: flags['history-max'] ? Number(flags['history-max']) : 24,
    });
    for (const line of management.renderMonitor(data).split('\n')) screen.print(line);
    process.exitCode = data.api.ok ? 0 : 1;
}

async function cmdRebootWorker(flags) {
    const io = createRealIo();
    const targets = managementTargetsOrExit(io, flags, 'Animastor Worker restart');
    if (!targets) return;
    if (!guardManagementAccess(io, targets)) return;
    const screen = createScreen();
    let res;
    try {
        res = await management.restartWorker(io, targets, { term: screen });
    } catch (err) {
        screen.print(`[✗] Worker restart failed: ${err.message}`);
        process.exitCode = 1;
        return;
    }
    if (res.ok && res.healthy) {
        screen.print('[✓] Worker is healthy');
        process.exitCode = 0;
    } else {
        screen.print(`[✗] Worker restart failed: ${res.detail || 'unknown reason'}`);
        process.exitCode = 1;
    }
}

async function cmdRebootComfyUI(flags) {
    const io = createRealIo();
    const targets = managementTargetsOrExit(io, flags, 'Animastor ComfyUI restart');
    if (!targets) return;
    if (!guardManagementAccess(io, targets)) return;
    const screen = createScreen();
    let res;
    try {
        res = await management.restartComfyUI(io, targets, {
            term: screen,
            verifyTimeoutMs: flags['verify-timeout-ms'] ? Number(flags['verify-timeout-ms']) : 120000,
        });
    } catch (err) {
        screen.print(`[✗] ComfyUI restart failed: ${err.message}`);
        process.exitCode = 1;
        return;
    }
    if (res.ok && res.up !== false) {
        screen.print(`[✓] API ready on :${res.port}`);
        process.exitCode = 0;
    } else if (res.ok) {
        screen.print(`[!] ComfyUI restarted but the API is not ready: ${res.detail || 'unknown reason'}`);
        process.exitCode = 1;
    } else {
        screen.print(`[✗] ComfyUI restart failed: ${res.detail || 'unknown reason'}`);
        process.exitCode = 1;
    }
}

// ---------------------------------------------------------------------------
// animastor start | stop | logs | doctor
// ---------------------------------------------------------------------------

/** True when this installation owns its ComfyUI (managed mode). */
function ownsComfyUI(targets) {
    const st = targets.state;
    return !!(st && ((st.components && st.components.comfyui && st.components.comfyui.owned) || st.mode === 'managed'));
}

/**
 * animastor start — bring the installation up and PROVE it: the managed
 * ComfyUI (never the user's own), then the worker; READY only after the
 * worker logged "ComfyUI ready" and the hub confirmed the heartbeat.
 */
async function cmdStart(flags) {
    const io = createRealIo();
    const targets = managementTargetsOrExit(io, flags, 'Animastor start');
    if (!targets) return;
    if (!guardManagementAccess(io, targets)) return;
    const screen = createScreen();
    // PATH is re-applied on EVERY start: E2E nodes reset ~/.bashrc and
    // ~/.profile on boot while ~/.local/bin/animastor survives.
    const pathEntry = management.restoreCommandPath(io, { linkDir: management.defaultLinkDir(), home: homeDir() });
    if (pathEntry.updated.length > 0) screen.print(`PATH block restored: ${pathEntry.updated.join(', ')}`);
    const envVals = workerMod.readEnvValues(io, targets.workerDir);
    // ComfyUI: mode and address come from the MACHINE (comfy-owner), not from
    // the remembered .env — the platform's port/prefix change between boots.
    const instance = await comfyOwner.resolveComfyOwner(io, { state: targets.state, root: targets.comfyuiRoot });
    const managed = instance.mode === 'managed';
    const port = instance.port || targets.port || Number(envVals.COMFY_PORT) || 8188;
    let comfyUrl = instance.url || envVals.COMFY_URL || `http://127.0.0.1:${port}`;
    let stats = instance.present ? await comfyuiMod.systemStats(io, comfyUrl) : null;
    if (!stats && managed && targets.comfyuiRoot && io.fs.existsSync(targets.comfyuiRoot)) {
        await screen.withBusy('Starting ComfyUI', async () => {
            comfyuiMod.startComfyUI(io, { root: targets.comfyuiRoot, port, device: targets.device });
            const up = await comfyuiMod.waitForApi(io, `http://127.0.0.1:${port}`, { timeoutMs: flags['verify-timeout-ms'] ? Number(flags['verify-timeout-ms']) : 120000 });
            if (up.ok) comfyUrl = `http://127.0.0.1:${port}`;
        });
        stats = await comfyuiMod.systemStats(io, comfyUrl);
    }
    if (!stats && instance.owner === 'foreign') {
        screen.print(`! the platform's ComfyUI (pid ${instance.pid}) does not answer at ${comfyUrl} yet`);
    }
    // Autostart entry kept in sync with the current command (old script → .bak).
    const wrap = management.ensureStartWorkerWrapper(io, { workerDir: targets.workerDir, animastorPath: toolCommandPath(flags) });
    if (wrap.status === 'replaced' || wrap.status === 'created') {
        screen.print(`autostart: ${wrap.path} → animastor start${wrap.backup ? ` (old script: ${wrap.backup})` : ''}`);
    }
    let start = null;
    let ready = null;
    if (stats) {
        start = workerMod.startWorker(io, { workerDir: targets.workerDir });
        if (start.started && start.alive) {
            if (start.already_running) screen.print(`worker already running (pid ${start.pid})`);
            ready = await screen.withBusy('Waiting for the worker (ComfyUI ready → hub heartbeat)', () => workerMod.waitForWorkerReady(io, {
                workerDir: targets.workerDir, pid: start.pid, logFile: start.logFile, logOffset: start.logOffset || 0,
            }));
        }
    }
    const checks = await engineMod.endToEndChecks(io, {
        mode: managed ? 'managed' : 'existing', comfyUrl: stats ? comfyUrl : null, comfyPort: port,
        hubUrl: envVals.HUB_URL || resolveHubUrl(flags), workerWanted: !!stats, workerStart: start, workerReady: ready,
        tool: toolCommand(flags),
    });
    const summary = renderFinalSummary({ e2e: checks, tool: toolCommand(flags), mode: managed ? 'managed' : 'existing' });
    for (const line of summary.text.split('\n')) screen.print(line);
    screen.print(`\nAnimastor command: ${toolCommandPath(flags)}`);
    process.exitCode = summary.ok ? 0 : 1;
}

/** animastor stop — stop this installation's worker (and its managed ComfyUI; never the user's own). */
async function cmdStop(flags) {
    const io = createRealIo();
    const targets = managementTargetsOrExit(io, flags, 'Animastor stop');
    if (!targets) return;
    if (!guardManagementAccess(io, targets)) return;
    const w = await workerMod.stopManagedWorker(io, { workerDir: targets.workerDir });
    console.log(w.stopped ? `✓ worker stopped (pid ${w.pid})` : `· worker: ${w.reason}`);
    if (ownsComfyUI(targets) && targets.comfyuiRoot) {
        const pids = comfyuiMod.findManagedComfyUIPids(io, { root: targets.comfyuiRoot });
        for (const pid of pids) {
            try { process.kill(pid, 'SIGTERM'); console.log(`✓ ComfyUI stopped (pid ${pid})`); } catch (_) { /* gone */ }
        }
        if (pids.length === 0) console.log('· ComfyUI: not running');
    } else {
        console.log('· ComfyUI: not managed by Animastor — left running');
    }
}

/** animastor logs [-f] [--lines N] — the worker log of this installation. */
async function cmdLogs(flags) {
    const io = createRealIo();
    const targets = managementTargetsOrExit(io, flags, 'Animastor logs');
    if (!targets) return;
    const file = workerMod.workerLogPath(targets.workerDir);
    if (!fs.existsSync(file)) {
        console.log(`no worker log yet (${file}) — start the worker: ${toolCommand(flags)} start`);
        process.exitCode = 1;
        return;
    }
    const n = String(Number(flags.lines) > 0 ? Number(flags.lines) : 100);
    console.error(`==> ${file}`);
    const { spawn } = require('child_process');
    await new Promise((resolve) => {
        const child = spawn('tail', flags.follow ? ['-n', n, '-F', file] : ['-n', n, file], { stdio: 'inherit' });
        child.on('close', (code) => { process.exitCode = code || 0; resolve(); });
    });
}

async function cmdDoctor(flags) {
    return cmdInstall(flags, { doctor: true });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const args = parseArgs(process.argv);
    const pkg = require('../../package.json');
    // install/doctor print the full banner; the everyday tool commands stay quiet.
    if (!['install', 'doctor', 'start', 'stop', 'logs', 'status'].includes(args.command)) {
        console.log(`animastor-installer v${pkg.version} (platform: ${PLATFORM_RUNTIME.platform}, deployment: ${PLATFORM_RUNTIME.deployment})`);
    }
    printPlatformNotices();
    switch (args.command) {
        case 'start':
            await cmdStart(args.flags);
            break;
        case 'stop':
            await cmdStop(args.flags);
            break;
        case 'logs':
            await cmdLogs(args.flags);
            break;
        case 'doctor':
            await cmdDoctor(args.flags);
            break;
        case 'detect':
            await cmdDetect(args.flags);
            break;
        case 'plan':
            await cmdPlan(args.flags);
            break;
        case 'install':
            await cmdInstall(args.flags);
            break;
        case 'verify':
            await cmdVerify(args.flags);
            break;
        case 'validate':
            await cmdValidateManifests(args.flags);
            break;
        case 'resume':
            await cmdResume(args.flags);
            break;
        case 'uninstall':
            await cmdUninstall(args.flags);
            break;
        case 'status':
            await cmdStatus(args.flags);
            break;
        case 'monitor':
            await cmdMonitor(args.flags);
            break;
        case 'reboot-worker':
            await cmdRebootWorker(args.flags);
            break;
        case 'reboot-comfyui':
            await cmdRebootComfyUI(args.flags);
            break;
        default:
            console.error('Usage: animastor-installer <detect|plan|install|verify|validate|resume|uninstall|start|stop|status|logs|doctor|monitor|reboot-worker|reboot-comfyui> [options]');
            console.error('  --profile P[,P2]   Generation profile id');
            console.error('  --mode MODE        managed | existing | shared');
            console.error('  --root PATH        ComfyUI root (default: ~/ComfyUI)');
            console.error('  --worker-dir PATH  Worker bundle dir');
            console.error('  --hub-url URL      GPU Hub URL');
            console.error('  --yes              Auto-confirm all prompts');
            console.error('  --dry-run          Show plan only; zero mutations');
            console.error('  managed mode starts ComfyUI + worker automatically and picks');
            console.error('  a free port when 8188 is taken; opt out:');
            console.error('    --no-start-comfy  --no-start-worker  --comfy-port N');
            console.error('  management (the `animastor` command in PATH):');
            console.error('    animastor start | stop | status | logs [-f] | doctor [--new-key]');
            console.error('    (also: monitor | reboot-worker | reboot-comfyui)');
            console.error('    (--state/--root/--worker-dir/--port override discovery)');
            console.error('    installer flags: --install-tools / --no-tools / --tools-dir PATH');
            console.error('  uninstall flags:');
            console.error('    --all            Full uninstall (remove everything recorded as installed by Animastor)');
            console.error('    --state PATH     Install state file path');
            process.exit(1);
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(`fatal: ${err.message}`);
        process.exit(1);
    });
}

module.exports = {
    stepQuestion, parseArgs, cmdDetect, cmdPlan, cmdInstall, cmdStart, cmdStop, cmdLogs, cmdDoctor,
    printResult, printOneLineSummary, resultExtras, cmdVerify, cmdValidateManifests, cmdResume,
    cmdUninstall, cmdStatus, cmdMonitor, cmdRebootWorker, cmdRebootComfyUI, resolveAndPlan,
    makeSecretProvider, resolveToolsDecision, resolveToolsDir, installOptions, runHostGates,
    PLATFORM_RUNTIME, printPlatformNotices, homeDir,
    toolCommand, toolCommandPath, detectHubVersion, priorReusableDecisions, isBootRun,
    missingRequiredHostPackages, waitForPlatformComfy,
};
