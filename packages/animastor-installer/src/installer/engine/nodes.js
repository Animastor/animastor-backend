'use strict';

/**
 * Custom node installation — Private Worker Installer Phase 2.
 *
 * Per required node:
 *   1. check presence (the resolver already did; the engine re-checks);
 *   2. if missing — git clone from the canonical manifest source;
 *   3. pin the manifest revision when one is declared;
 *   4. install the node's Python dependencies (requirements.txt) if present;
 *   5. re-check presence.
 *
 * Already-installed compatible nodes are KEPT — never reinstalled without
 * need. Incompatible nodes stop their step pending a user decision; no
 * destructive replacement happens automatically.
 */

const path = require('path');

function findManifestDep(manifests, depId) {
    for (const m of manifests) {
        const dep = (m.dependencies || []).find((d) => d.id === depId);
        if (dep) return dep;
    }
    return null;
}

/**
 * Node python deps are installed with the runtime's torch constraint:
 * requirements.txt carries UNPINNED torch edges — without a constraint pip
 * would happily REPLACE the installed (CPU-flavored) torch with the newest
 * CUDA build from PyPI (a multi-GB download that breaks a CPU-only host).
 * Idempotent: pip skips already-satisfied requirements.
 */
function pipInstallRequirements(io, { root, reqPath, python, torchSpec, log = null }) {
    const args = ['-m', 'pip', 'install', '-r', reqPath];
    if (torchSpec && torchSpec.pin) {
        const constraintFile = path.join(root, 'venv', '.animastor-torch-constraints.txt');
        io.fs.writeFileSync(constraintFile, `torch==${String(torchSpec.pin).split('+')[0]}\n`);
        args.push('-c', constraintFile);
    }
    const r = io.exec(python, args, { timeout: 60 * 60 * 1000 });
    if (r.code !== 0) {
        if (log) log.warn(`pip install -r requirements.txt failed: ${String(r.stderr).slice(-300)}`);
        return false;
    }
    return true;
}

/**
 * Install one missing custom node.
 * `origin` distinguishes what the installer actually created ('installed')
 * from what was already on disk ('pre-existing') — the uninstaller removes
 * only 'installed' directories.
 * `retryDeps` re-runs pip for an ALREADY-present node whose python
 * dependencies were left incomplete by an earlier run (idempotent; needed
 * because the resolver keys node presence off the directory, so without a
 * retry a broken deps state would never heal).
 * @returns {{ status: 'installed'|'blocked'|'failed', origin?, reason?, directory? }}
 */
/** marker written into a node installed from a repository subdirectory (probe reads it) */
const SOURCE_MARKER = '.animastor-source.json';

function installCustomNode(io, { root, dep, python = null, torchSpec = null, retryDeps = false, log = null }) {
    const src = (dep.install && dep.install.source) || {};
    const dirName = (dep.install && dep.install.directory) || dep.name;
    const target = path.join(root, 'custom_nodes', dirName);

    if (!src.repository) {
        return {
            status: 'blocked',
            reason: `no canonical repository for ${dep.id} in the manifest — the installer never invents sources (D4 research pending)`,
        };
    }

    if (io.fs.existsSync(target)) {
        // present — the resolver decides compatibility; the engine does not
        // replace an existing node automatically. Only the python deps may
        // be completed (pip is idempotent and never removes anything).
        if (retryDeps && python) {
            const req = path.join(target, 'requirements.txt');
            if (io.fs.existsSync(req) && pipInstallRequirements(io, { root, reqPath: req, python, torchSpec, log })) {
                return { status: 'installed', origin: 'pre-existing', directory: dirName, reason: null };
            }
            return { status: 'installed', origin: 'pre-existing', directory: dirName, reason: 'already present; python dependencies incomplete — see warnings' };
        }
        return { status: 'installed', origin: 'pre-existing', directory: dirName, reason: 'already present — kept as-is' };
    }

    if (src.subdirectory) {
        // 0.2.11 — a node that lives in a SUBDIRECTORY of a repository (e.g.
        // animastor-worker/comfyui-nodes/animastor-voice-ref): clone OUTSIDE
        // custom_nodes (ComfyUI would load the whole checkout as a node),
        // check out the pin, copy the subdirectory, record the source.
        const sub = String(src.subdirectory);
        if (path.isAbsolute(sub) || sub.split(/[\\/]/).includes('..')) {
            return { status: 'blocked', reason: `bad subdirectory ${JSON.stringify(sub)} for ${dep.id}` };
        }
        if (!src.commit) {
            return { status: 'blocked', reason: `${dep.id}: a subdirectory source needs a pinned commit` };
        }
        const staging = path.join(root, '.animastor-node-sources', dirName);
        io.fs.rmSync(staging, { recursive: true, force: true });
        io.fs.mkdirSync(path.dirname(staging), { recursive: true });
        let c = io.exec('git', ['clone', src.repository, staging]);
        if (c.code !== 0) {
            io.fs.rmSync(staging, { recursive: true, force: true });
            return { status: 'failed', reason: `git clone ${src.repository} failed: ${String(c.stderr || c.error).slice(-300)}` };
        }
        c = io.exec('git', ['-C', staging, 'checkout', src.commit]);
        if (c.code !== 0) {
            io.fs.rmSync(staging, { recursive: true, force: true });
            return { status: 'failed', reason: `git checkout ${src.commit} failed: ${String(c.stderr).slice(-300)}` };
        }
        const from = path.join(staging, sub);
        if (!io.fs.isDirectory(from)) {
            io.fs.rmSync(staging, { recursive: true, force: true });
            return { status: 'failed', reason: `subdirectory ${sub} not found in ${src.repository}@${src.commit}` };
        }
        c = io.exec('cp', ['-a', from, target]);
        io.fs.rmSync(staging, { recursive: true, force: true });
        if (c.code !== 0) return { status: 'failed', reason: `copy of ${sub} failed: ${String(c.stderr || c.error).slice(-300)}` };
        io.fs.writeFileSync(path.join(target, SOURCE_MARKER), JSON.stringify({ repository: src.repository, commit: src.commit, subdirectory: sub }, null, 2) + '\n');
    } else {
        let r = io.exec('git', ['clone', src.repository, target]);
        if (r.code !== 0) {
            return { status: 'failed', reason: `git clone ${src.repository} failed: ${String(r.stderr || r.error).slice(-300)}` };
        }

        if (src.commit) {
            r = io.exec('git', ['-C', target, 'checkout', src.commit]);
            if (r.code !== 0) {
                return { status: 'failed', reason: `git checkout ${src.commit} failed: ${String(r.stderr).slice(-300)}` };
            }
        }
    }

    const req = path.join(target, 'requirements.txt');
    if (io.fs.existsSync(req) && python) {
        if (!pipInstallRequirements(io, { root, reqPath: req, python, torchSpec, log })) {
            return { status: 'installed', origin: 'installed', directory: dirName, reason: 'cloned; python dependencies incomplete — see warnings' };
        }
    }

    if (!io.fs.existsSync(target)) {
        return { status: 'failed', reason: 'clone reported success but the directory is missing' };
    }
    if (log) log.info(`custom node installed: ${dirName}${src.commit ? ` @ ${src.commit}` : ''}`);
    return { status: 'installed', origin: 'installed', directory: dirName };
}

/**
 * Install all missing required custom nodes listed in the plan step.
 * Incompatible existing nodes are surfaced as review items — the step stops
 * for them until the user decides (git-safe checkout to the pinned revision
 * is a consent-gated op). `retryDeps` carries the ids of nodes whose python
 * dependencies an earlier run left incomplete.
 */
function installCustomNodes(io, { root, manifests, planStep, python = null, torchSpec = null, retryDeps = [], log = null }) {
    const results = [];
    for (const item of planStep.missing || []) {
        const dep = findManifestDep(manifests, item.id);
        if (!dep) {
            results.push({ id: item.id, status: 'blocked', reason: 'not found in any manifest' });
            continue;
        }
        results.push({
            id: item.id,
            ...installCustomNode(io, { root, dep, python, torchSpec, retryDeps: retryDeps.includes(item.id), log }),
        });
    }
    for (const item of planStep.review || []) {
        results.push({
            id: item.id,
            status: 'needs-user-decision',
            reason: `${item.reason || 'incompatible'} — not changed automatically; a git-safe checkout to the pinned revision is available with explicit consent`,
        });
    }
    return results;
}

module.exports = {
    installCustomNode,
    installCustomNodes,
};
