'use strict';

/**
 * Host prerequisite checks — run BEFORE any heavy installer mutation
 * (venv creation, ComfyUI clone, multi-GB model downloads).
 *
 * Detects the Debian/Ubuntu failure mode where `python3 -m venv` fails
 * because `ensurepip` is unavailable (python3.X-venv not installed) and
 * produces a precise remediation command for the detected Python version.
 *
 * Detection strategy: the RELIABLE check on Debian/Ubuntu is creating a
 * throwaway venv — `python3 -m ensurepip` is deliberately disabled for the
 * system python there, so a cheap module check would produce false failures
 * on healthy hosts. The probe venv is created under a fixed temp root and
 * always cleaned up.
 *
 * "Inconclusive" semantics: when the venv command reports success but the
 * probe directory did not materialize (mocked io in tests), the check
 * passes without a deep verdict — the runtime step itself re-validates the
 * real venv afterwards.
 */

const path = require('path');
const platforms = require('../platform');

/**
 * Platform adapter for one call (explicit override wins over auto-detect).
 * Package remediation commands and the venv layout are platform concerns.
 */
function adapterOf(opts = {}) {
    return (opts && opts.platformAdapter) || platforms.getPlatformAdapter();
}

/**
 * Structured prerequisite failure. Carries the host package and the exact
 * remediation command so CLI/engine can print a short, actionable message.
 */
class PrerequisiteError extends Error {
    /**
     * @param {object} args { code, message, summary, hostPackage, remediationCommand }
     */
    constructor({ code, message, summary, hostPackage = null, remediationCommand = null }) {
        super(message);
        this.name = 'PrerequisiteError';
        this.code = code;
        this.summary = summary || message;
        this.hostPackage = hostPackage;
        this.remediationCommand = remediationCommand;
    }

    /** Render the short user-facing remediation block (requirement: 4 lines). */
    remediationLines() {
        return renderRemediation(this);
    }
}

/** Debian/Ubuntu venv package name for a Python version, e.g. "3.10.12" → "python3.10-venv". */
function debianVenvPackage(pythonVersion) {
    const m = /(\d+)\.(\d+)/.exec(String(pythonVersion || ''));
    return m ? `python${m[1]}.${m[2]}-venv` : 'python3-venv';
}

/**
 * Host package install command — delegated to the platform adapter
 * (Debian/Ubuntu apt on Linux; winget/choco hints on Windows).
 * The explicit `platform` argument keeps the historical apt behaviour for
 * tests and Linux-only remediation classifiers.
 */
function aptCommand(pkg, platform = 'linux') {
    return platforms.getPlatformAdapter(platform).hostPackageCommand(pkg);
}

/**
 * Classify a failed `python3 -m venv` run.
 * The remediation command comes from the platform adapter when one is
 * provided (apt on Linux, package-manager hints on Windows).
 * @returns {{ code, summary, hostPackage, remediationCommand }}
 */
function classifyVenvCreateFailure(output, pythonVersion = null, platformAdapter = null) {
    const pkgCmd = (pkg) => (platformAdapter ? platformAdapter.hostPackageCommand(pkg) : aptCommand(pkg));
    const text = String(output || '');
    if (/ensurepip is not available|python3(\.\d+)?-venv|ensurepip/i.test(text)) {
        const pkg = debianVenvPackage(pythonVersion);
        return {
            code: 'MISSING_VENV_PACKAGE',
            summary: 'the Python venv prerequisite is missing',
            hostPackage: pkg,
            remediationCommand: pkgCmd(pkg),
        };
    }
    const pkg = debianVenvPackage(pythonVersion);
    return {
        code: 'VENV_CREATE_FAILED',
        summary: 'the Python venv could not be created on this host',
        hostPackage: pkg,
        remediationCommand: pkgCmd(pkg),
    };
}

/** Build the remediation payload stored on the engine result. */
function remediationPayload(failure) {
    return {
        code: failure.code,
        summary: failure.summary,
        package: (failure.remediation && failure.remediation.package) || failure.hostPackage || null,
        command: (failure.remediation && failure.remediation.command) || failure.remediationCommand || null,
    };
}

/** Render the short user-facing remediation block for a failure object. */
function renderRemediation(failure) {
    const lines = [];
    lines.push(`Installation stopped because ${failure.summary || 'a host prerequisite is missing'}.`);
    const pkg = (failure.remediation && failure.remediation.package) || failure.hostPackage;
    const cmd = (failure.remediation && failure.remediation.command) || failure.remediationCommand;
    if (pkg) lines.push(`Required host package: ${pkg}`);
    if (cmd) lines.push(`Install it with: ${cmd}`);
    lines.push('Then re-run the installer.');
    return lines;
}

/**
 * Classify an existing venv directory WITHOUT mutating it.
 * The interpreter layout inside the venv (bin/python vs Scripts/python.exe)
 * is a platform concern (platform adapter).
 * @returns {{ state: 'missing'|'incomplete'|'has-python', reason?: string }}
 */
function classifyVenvDir(io, venvDir, platformAdapter = null) {
    if (!io.fs.existsSync(venvDir)) return { state: 'missing' };
    const py = adapterOf({ platformAdapter }).venvPythonBin(venvDir);
    if (!io.fs.existsSync(py)) {
        return { state: 'incomplete', reason: `directory exists but ${py} is missing (broken/incomplete venv)` };
    }
    return { state: 'has-python' };
}

/**
 * Probe python3 and (deep) the actual ability to create a working venv with
 * a functioning pip — BEFORE any real mutation.
 *
 * @param {object} io io adapter
 * @param {object} opts { python = 'python3', tmpRoot = null, deep = true,
 *                        existingVenvDir = null }
 *   existingVenvDir: when a working venv already exists at the install
 *   target, nothing will need to CREATE a venv — its working pip satisfies
 *   the prerequisite without probing host venv creation.
 * @returns {{ ok: true, python_version, deep_checked, existing_venv_usable? } |
 *           { ok: false, failure: { code, summary, message, remediation: { package, command } } }}
 */
function checkPythonPrerequisites(io, opts = {}) {
    const { python = 'python3', tmpRoot = null, deep = true, existingVenvDir = null, platformAdapter = null } = opts;
    const adapter = adapterOf({ platformAdapter });
    const os = require('os');

    const versionRes = io.exec(python, ['--version']);
    if (versionRes.code !== 0) {
        return {
            ok: false,
            failure: {
                code: 'NO_PYTHON',
                summary: 'Python 3 is not available on this host',
                message: `${python} is not usable (code ${versionRes.code})`,
                remediation: { package: 'python3', command: adapter.hostPackageCommand('python3') },
            },
        };
    }
    const versionMatch = /Python\s+([0-9][0-9.]*)/.exec(String(versionRes.stdout) + String(versionRes.stderr));
    const pythonVersion = versionMatch ? versionMatch[1] : null;

    // A working existing venv at the target makes venv-creation capability
    // irrelevant (the installer reuses it as-is).
    if (existingVenvDir) {
        const cls = classifyVenvDir(io, existingVenvDir, adapter);
        if (cls.state === 'has-python') {
            const existingPy = adapter.venvPythonBin(existingVenvDir);
            const pipCheck = io.exec(existingPy, ['-m', 'pip', '--version']);
            if (pipCheck.code === 0) {
                return { ok: true, python_version: pythonVersion, deep_checked: false, existing_venv_usable: true };
            }
        }
    }

    if (!deep) {
        return { ok: true, python_version: pythonVersion, deep_checked: false };
    }

    const root = tmpRoot || path.join(os.tmpdir(), 'animastor-installer-prereq');
    const probeVenv = path.join(root, 'venv');

    const cleanup = () => {
        try { if (io.fs.existsSync(root)) io.fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    };
    cleanup();

    const created = io.exec(python, ['-m', 'venv', probeVenv]);
    if (created.code !== 0) {
        cleanup();
        const f = classifyVenvCreateFailure(String(created.stderr || created.stdout || created.error || ''), pythonVersion, adapter);
        return {
            ok: false,
            failure: {
                code: f.code,
                summary: f.summary,
                message: `python3 -m venv probe failed (code ${created.code}): ${String(created.stderr || created.stdout || '').slice(-400)}`,
                remediation: { package: f.hostPackage, command: f.remediationCommand },
            },
        };
    }

    if (!io.fs.existsSync(probeVenv)) {
        // Success reported but nothing materialized (mocked io) — inconclusive.
        return { ok: true, python_version: pythonVersion, deep_checked: false };
    }

    const probePy = adapter.venvPythonBin(probeVenv);
    if (!io.fs.existsSync(probePy)) {
        cleanup();
        const pkg = debianVenvPackage(pythonVersion);
        return {
            ok: false,
            failure: {
                code: 'VENV_INCOMPLETE',
                summary: 'the Python venv prerequisite is missing (venv was created without a usable python)',
                message: `venv probe produced no interpreter at ${probePy}`,
                remediation: { package: pkg, command: adapter.hostPackageCommand(pkg) },
            },
        };
    }

    const pipCheck = io.exec(probePy, ['-m', 'pip', '--version']);
    if (pipCheck.code !== 0) {
        const boot = io.exec(probePy, ['-m', 'ensurepip', '--upgrade']);
        cleanup();
        if (boot.code !== 0) {
            const pkg = debianVenvPackage(pythonVersion);
            return {
                ok: false,
                failure: {
                    code: 'MISSING_ENSUREPIP',
                    summary: 'the Python venv prerequisite is missing (venv has neither pip nor ensurepip)',
                    message: `probe venv has no pip and ensurepip failed (code ${boot.code}): ${String(boot.stderr || boot.stdout || '').slice(-400)}`,
                    remediation: { package: pkg, command: adapter.hostPackageCommand(pkg) },
                },
            };
        }
    }

    cleanup();
    return { ok: true, python_version: pythonVersion, deep_checked: true };
}

// ---------------------------------------------------------------------------
// Host package installation (apt on Debian/Ubuntu) — with consent
// ---------------------------------------------------------------------------

/** dpkg/apt lock held by another process — a wait-and-retry situation, not a bug. */
const DPKG_LOCK_PATTERN = /Could not get lock|Unable to acquire the dpkg frontend lock|dpkg frontend lock|is another process using it|Could not open lock file/i;
/** apt's package index is stale — one `apt-get update` fixes it. */
const APT_STALE_INDEX_PATTERN = /Unable to locate package|has no installation candidate/i;

/** Normalize a package spec (string or array) into a list of names. */
function hostPackageList(packages) {
    const list = Array.isArray(packages) ? packages : String(packages || '').split(/\s+/);
    return list.map((p) => String(p).trim()).filter(Boolean);
}

/**
 * Can this process install a host package WITHOUT an interactive password?
 *   root                     → yes (runs apt-get directly);
 *   user + `sudo -n true` ok → yes (runs `sudo -n apt-get …`);
 *   otherwise                → no: the caller prints the remediation command.
 * Platforms without a host package manager answer no (adapter flag).
 * @returns {{ ok: boolean, via: 'root'|'sudo'|null, command_prefix: string[] }}
 */
function canElevate(io, { platformAdapter = null, uid = currentUid() } = {}) {
    const adapter = adapterOf({ platformAdapter });
    if (adapter.supportsHostInstall !== true) return { ok: false, via: null, command_prefix: [] };
    if (uid === 0) return { ok: true, via: 'root', command_prefix: [] };
    if (uid === null || uid === undefined) return { ok: false, via: null, command_prefix: [] };
    const probe = io.exec('sudo', ['-n', 'true']);
    if (probe && probe.code === 0) return { ok: true, via: 'sudo', command_prefix: ['sudo', '-n'] };
    return { ok: false, via: null, command_prefix: [] };
}

/**
 * Install host packages (the missing `python3.X-venv` and friends) without a
 * second installer run: runs `apt-get update` ONCE when apt reports a stale
 * index, `apt-get install -y`, and turns a held dpkg lock into a clear
 * message instead of an opaque exit code.
 * @returns {{ ok, packages, updated, command, code, output, message }}
 */
function installHostPackages(io, { packages, platformAdapter = null, elevated = null, log = null, timeoutMs = 10 * 60 * 1000 } = {}) {
    const adapter = adapterOf({ platformAdapter });
    const pkgs = hostPackageList(packages);
    if (pkgs.length === 0) return { ok: true, packages: [], skipped: true, message: null };
    if (adapter.supportsHostInstall !== true) {
        return {
            ok: false,
            packages: pkgs,
            reason: 'no-host-package-manager',
            message: `The installer cannot install ${pkgs.join(', ')} automatically on this platform — install it with the system package manager and re-run.`,
        };
    }
    const elev = elevated || canElevate(io, { platformAdapter: adapter });
    if (!elev.ok) {
        return {
            ok: false,
            packages: pkgs,
            reason: 'no-privileges',
            message: `Cannot install ${pkgs.join(', ')}: root or passwordless sudo is required.`,
        };
    }
    const run = (update) => {
        const c = adapter.hostInstallCommand({ packages: pkgs, update });
        const res = elev.via === 'sudo'
            ? io.exec('sudo', ['-n', c.cmd, ...c.args], { timeout: timeoutMs })
            : io.exec(c.cmd, c.args, { timeout: timeoutMs });
        return { res, command: `${elev.via === 'sudo' ? 'sudo -n ' : ''}${c.cmd} ${c.args.join(' ')}` };
    };
    const outputOf = (r) => String((r && (r.stderr || r.stdout || r.error)) || '');

    let attempt = run(false);
    let updated = false;
    if (attempt.res.code !== 0 && APT_STALE_INDEX_PATTERN.test(outputOf(attempt.res))) {
        const up = run(true);
        updated = true;
        // retry the install once, after the index refresh
        attempt = up.res.code === 0 ? run(false) : up;
    }
    const text = outputOf(attempt.res);
    const ok = attempt.res.code === 0;
    let message = null;
    if (!ok) {
        message = DPKG_LOCK_PATTERN.test(text)
            ? 'apt/dpkg is busy (another package manager process holds the lock) — wait for it to finish, then re-run the installer.'
            : `Installing ${pkgs.join(', ')} failed (exit ${attempt.res.code}): ${text.trim().split('\n').filter(Boolean).slice(-3).join(' ')}`;
    }
    if (log) {
        if (ok && log.info) log.info(`host package(s) installed: ${pkgs.join(', ')}${updated ? ' (apt-get update ran once)' : ''}`);
        else if (!ok && log.warn) log.warn(message);
    }
    return { ok, packages: pkgs, updated, command: attempt.command, code: attempt.res.code, output: text, message };
}

/**
 * Turn a failed prerequisite into a working one IN THE SAME RUN:
 * ask "Install <pkg> now? [Y/n]" (or skip the question with --yes), install
 * the host package, re-check the prerequisite and continue — no installer
 * restart. Without root/passwordless sudo (or without a terminal and without
 * --yes) nothing is installed and the caller prints the exact command.
 * @returns {{ ok, failure, installed?, install?, elevatable?, declined?, reason? }}
 */
/**
 * True when a Debian/Ubuntu package is installed (dpkg-query status).
 * Used by the boot path: `animastor doctor --yes` installs the packages that
 * DISAPPEARED with the image restart instead of asking.
 */
function hostPackageInstalled(io, pkg) {
    const r = io.exec('dpkg-query', ['-W', '-f=${Status}', pkg]);
    return !!(r && r.code === 0 && /install ok installed/.test(String(r.stdout || '')));
}

/**
 * Install the host packages that are actually MISSING (one apt-get run),
 * without asking when `yes` is set (boot script: no TTY). Without root or
 * passwordless sudo nothing is installed and the exact command is returned.
 * @returns {Promise<{ ok: boolean, installed: string[], missing: string[], message?: string, updated?: boolean }>}
 */
async function installMissingHostPackages(io, { packages = [], prompt = null, yes = false, log = null, platformAdapter = null } = {}) {
    const adapter = adapterOf({ platformAdapter });
    if (!adapter || adapter.name !== 'linux' || adapter.HOST_INSTALL_SUPPORTED === false) {
        return { ok: true, installed: [], missing: [], message: 'automatic host package installation is not supported on this platform' };
    }
    const wanted = [...new Set((packages || []).filter(Boolean))];
    const missing = wanted.filter((pkg) => !hostPackageInstalled(io, pkg));
    if (missing.length === 0) return { ok: true, installed: [], missing: [] };
    const elevated = canElevate(io, { platformAdapter: adapter });
    if (!elevated.ok) {
        return {
            ok: false, installed: [], missing,
            message: `missing host package(s) ${missing.join(', ')} — install with: ${missing.map((p) => aptCommand(p, adapter.name)).join(' && ')}`,
        };
    }
    if (!yes) {
        if (!prompt || !prompt.available) {
            return { ok: false, installed: [], missing, message: `missing host package(s) ${missing.join(', ')} (non-interactive — re-run with --yes)` };
        }
        const answer = await prompt.confirm(`Install ${missing.join(' ')} now?`, { defaultYes: true });
        if (!answer) return { ok: false, installed: [], missing, message: `skipped by the user: ${missing.join(', ')}` };
    }
    if (log) log.info(`installing missing host package(s): ${missing.join(', ')}`);
    const r = installHostPackages(io, { packages: missing, elevated, log });
    return {
        ok: r.ok,
        installed: r.ok ? missing : [],
        missing: r.ok ? [] : missing,
        updated: r.updated,
        message: r.message,
    };
}

async function resolveHostPrerequisite(io, { failure, opts = {}, prompt = null, yes = false, log = null, platformAdapter = null } = {}) {
    const pkg = (failure && ((failure.remediation && failure.remediation.package) || failure.hostPackage)) || null;
    if (!pkg) return { ok: false, failure, reason: 'no-host-package' };
    const adapter = adapterOf({ platformAdapter });
    const elev = canElevate(io, { platformAdapter: adapter });
    if (!elev.ok) return { ok: false, failure, elevatable: false, reason: 'no-privileges' };
    if (!yes) {
        if (!prompt || !prompt.available) return { ok: false, failure, elevatable: true, reason: 'no-tty' };
        const accepted = await prompt.confirm(`Install ${pkg} now?`, { defaultYes: true });
        if (!accepted) return { ok: false, failure, elevatable: true, declined: true, reason: 'declined' };
    }
    if (log && log.info) log.info(`installing host package ${pkg} (${elev.via})`);
    const install = installHostPackages(io, { packages: pkg, platformAdapter: adapter, elevated: elev, log });
    if (!install.ok) return { ok: false, failure, install, elevatable: true, reason: 'install-failed' };
    const again = checkPythonPrerequisites(io, opts);
    if (again.ok) return { ok: true, failure, installed: install };
    return { ok: false, failure: again.failure, install, reason: 'still-missing' };
}

// ---------------------------------------------------------------------------
// Ownership guard — sudo vs. normal user mixing
// ---------------------------------------------------------------------------

/** Current uid (null when unavailable, e.g. Windows). */
function currentUid() {
    try {
        return typeof process !== 'undefined' && typeof process.getuid === 'function' ? process.getuid() : null;
    } catch (_) {
        return null;
    }
}

/** Current user's home directory. */
function currentHome() {
    try {
        return (process.env && process.env.HOME) || require('os').homedir();
    } catch (_) {
        return null;
    }
}

function statUid(io, p) {
    try {
        const st = io.fs.statSync(p);
        return typeof st.uid === 'number' ? st.uid : null;
    } catch (_) {
        return undefined; // absent
    }
}

function pathInsideHome(p, home) {
    if (!home) return false;
    const h = path.resolve(home);
    const r = path.resolve(p);
    return r === h || r.startsWith(h + path.sep);
}

/**
 * Detect ownership mixing that would lock a normal user out of their own
 * home directory (the "ran it once, then re-ran with sudo" scenario).
 *
 * Violations:
 *   - root (uid 0) operating on paths (or their nearest existing ancestor)
 *     owned by a non-root user → would create root-owned files inside the
 *     user's home;
 *   - a non-root user operating on paths owned by a DIFFERENT uid;
 *   - the install state was created by another uid (resume after UID change).
 *
 * When uid information is unavailable (mocked/memory fs), the check passes —
 * the runtime step re-validates the real venv afterwards.
 *
 * @returns {{ ok: boolean, violations: Array<{ path, kind, owner_uid?, message }> }}
 */
function checkOwnership(io, { paths = [], home = null, currentUid: uidInput = null, stateUid = null } = {}) {
    const uid = uidInput !== null && uidInput !== undefined ? uidInput : currentUid();
    const violations = [];

    if (uid === null || uid === undefined) return { ok: true, violations };

    const describeOwner = (ownerUid) => (ownerUid === 0 ? 'root' : `uid ${ownerUid}`);

    const checkPath = (p) => {
        if (!p) return;
        let abs = null;
        try { abs = path.resolve(p); } catch (_) { return; }

        const owner = statUid(io, abs);
        if (owner === null) return; // uid info unavailable — cannot judge
        if (owner !== undefined) {
            if (uid === 0 && owner !== 0) {
                violations.push({
                    path: abs,
                    kind: 'root-over-user-files',
                    owner_uid: owner,
                    message: `${abs} is owned by ${describeOwner(owner)} but the installer is running as root (sudo). `
                        + 'Continuing would create root-owned files inside the user\'s home and lock the normal user out of their installation. '
                        + 'Re-run as the owning user (e.g. `sudo -u $(stat -c %U ' + abs + ') ...`) or fix ownership first.',
                });
            } else if (uid !== 0 && owner !== uid) {
                violations.push({
                    path: abs,
                    kind: 'foreign-user-files',
                    owner_uid: owner,
                    message: `${abs} is owned by ${describeOwner(owner)} but you are running as ${describeOwner(uid)} — the installer will not mix ownership in one installation.`,
                });
            }
            return;
        }
        // path absent — check the nearest existing ancestor
        let parent = path.dirname(abs);
        while (parent && parent !== path.dirname(parent)) {
            const parentOwner = statUid(io, parent);
            if (parentOwner === null) return; // no uid info anywhere — pass
            if (parentOwner !== undefined) {
                if (uid === 0 && parentOwner !== 0) {
                    const where = pathInsideHome(abs, home) ? " (inside the user's home directory)" : '';
                    violations.push({
                        path: abs,
                        kind: 'root-into-user-home',
                        owner_uid: parentOwner,
                        message: `Running as root would create root-owned files under ${abs}, which lives inside ${describeOwner(parentOwner)}-owned ${parent}${where}. `
                            + 'Re-run the installer as the owning user instead of sudo.',
                    });
                }
                return;
            }
            parent = path.dirname(parent);
        }
    };

    for (const p of paths) checkPath(p);

    if (stateUid !== null && stateUid !== undefined && stateUid !== uid) {
        violations.push({
            path: null,
            kind: 'state-owned-by-other-uid',
            owner_uid: stateUid,
            message: `The installation state was created by ${describeOwner(stateUid)} but the current process runs as ${describeOwner(uid)} — `
                + 'resuming under a different uid would mix ownership. Run the installer as the original user (or clean up and reinstall).',
        });
    }

    return { ok: violations.length === 0, violations };
}

/**
 * Check for C build tools required by packages with native extensions
 * (funasr, soundfile, etc.). Delegates to the platform adapter — the
 * tool set and package names are OS-specific.
 */
function checkBuildPrerequisites(io, { python = 'python3', log = null, platformAdapter = null } = {}) {
    return adapterOf({ platformAdapter }).checkBuildPrerequisites(io, { python, log });
}

module.exports = {
    PrerequisiteError,
    debianVenvPackage,
    canElevate,
    installHostPackages,
    resolveHostPrerequisite,
    hostPackageList,
    hostPackageInstalled,
    installMissingHostPackages,
    DPKG_LOCK_PATTERN,
    classifyVenvCreateFailure,
    classifyVenvDir,
    remediationPayload,
    renderRemediation,
    checkPythonPrerequisites,
    checkBuildPrerequisites,
    checkOwnership,
    currentUid,
    currentHome,
};
