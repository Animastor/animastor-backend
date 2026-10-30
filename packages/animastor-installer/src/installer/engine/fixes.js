'use strict';

/**
 * Auto-fix planning: everything wrong with an EXISTING worker installation
 * that the installer can repair by itself, collected into one list so the
 * user answers ONE question ("Fix all?") instead of reading warnings.
 *
 * Fixable (non-secret, installer-owned):
 *   - .env wiring that differs from this run: WORKER_TYPE (from the profile),
 *     NODE_BIN (Node.js >= 20), COMFY_URL (probed), COMFY_PORT, HUB_URL;
 *   - an outdated worker bundle (version differs from the bundled source);
 *   - bundle dependencies that are declared but not installed (npm ci).
 * The Worker Key is never part of it (`doctor --new-key` asks explicitly).
 */

const path = require('path');
const workerMod = require('./worker');
const probe = require('./probe');

/** Keys the installer owns in the worker .env (never secrets). */
const FIXABLE_ENV_KEYS = Object.freeze(['WORKER_TYPE', 'NODE_BIN', 'COMFY_URL', 'NOTEBOOK_PATH', 'COMFY_PORT', 'HUB_URL']);

const WHY = {
    WORKER_TYPE: 'must match the profile',
    NODE_BIN: 'the worker needs Node.js >= 20',
    COMFY_URL: 'the address where ComfyUI actually answers',
    NOTEBOOK_PATH: 'follows the probed ComfyUI address',
    COMFY_PORT: 'the port of this installation\'s ComfyUI',
    HUB_URL: 'the hub this installer was downloaded from',
};

/**
 * Differences between the current .env values and the desired wiring.
 * Pure. Missing keys are NOT fixes (they are always added).
 * @returns {Array<{ id, key, from, to, title }>}
 */
function planEnvFixes(current, desired) {
    const out = [];
    for (const key of FIXABLE_ENV_KEYS) {
        if (desired[key] === undefined || desired[key] === null) continue;
        if (current[key] === undefined) continue;
        const from = String(current[key]);
        const to = String(desired[key]);
        if (from === to) continue;
        out.push({ id: `env:${key}`, key, from, to, title: `${key}: ${from || '(empty)'} → ${to || '(empty)'} (${WHY[key]})` });
    }
    return out;
}

/**
 * Collect the fix list for the installation at workerDir.
 * @param {object} io
 * @param {object} opts { workerDir, sourceBundleDir, desired: {KEY: value} }
 * @returns {{ items: Array<{ id, title }>, additions: string[] }}
 */
function planFixes(io, { workerDir, sourceBundleDir = null, sourceVersion = null, desired = {} }) {
    const items = [];
    const additions = [];
    if (!workerDir || !io.fs.existsSync(path.join(workerDir, 'worker.cjs'))) return { items, additions };

    const installed = workerMod.readPkgVersion(io, workerDir);
    const source = (sourceBundleDir ? workerMod.readPkgVersion(io, sourceBundleDir) : null) || sourceVersion;
    if (installed && source && installed !== source) {
        items.push({ id: 'bundle', title: `worker bundle ${installed} → ${source} (worker files only; .env is kept)` });
    }

    const deps = Object.keys(workerMod.declaredDependencies(io, workerDir));
    if (deps.length > 0 && !io.fs.existsSync(path.join(workerDir, 'node_modules'))) {
        items.push({ id: 'deps', title: `install worker dependencies (${deps.join(', ')}): npm ci in ${workerDir}` });
    }

    if (io.fs.existsSync(path.join(workerDir, '.env'))) {
        const current = workerMod.readEnvValues(io, workerDir);
        for (const f of planEnvFixes(current, desired)) items.push(f);
        for (const key of FIXABLE_ENV_KEYS) {
            if (desired[key] !== undefined && desired[key] !== '' && current[key] === undefined) additions.push(`${key}=${desired[key]}`);
        }
        if (current.NODE_BIN && probe.nodeMajor(probe.nodeBinaryVersion(io, current.NODE_BIN)) < 20 && !items.some((i) => i.key === 'NODE_BIN') && desired.NODE_BIN) {
            items.push({ id: 'env:NODE_BIN', key: 'NODE_BIN', from: current.NODE_BIN, to: desired.NODE_BIN, title: `NODE_BIN: ${current.NODE_BIN} is missing or older than Node.js 20 → ${desired.NODE_BIN}` });
        }
    }
    // ONE entry per fix: two rules can describe the same key (a stale
    // NODE_BIN and the generic env diff) — the list the user confirms and the
    // list the engine applies must be the same, and neither may show a
    // change that is not going to happen.
    const seen = new Set();
    const unique = items.filter((i) => {
        const id = i.id || i.key;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    });
    return { items: unique, additions };
}

module.exports = { FIXABLE_ENV_KEYS, planEnvFixes, planFixes };
