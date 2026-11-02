'use strict';

/**
 * Version replacements made by the persistent node-deps overlay
 * (installer 0.2.6, ADR in animastor-docs INSTALLER_ARCHITECTURE
 * §node deps → "One GPU node — one profile").
 *
 * E2E 02.11 (TIR, audio/qwen-tts): qwen-tts pins transformers==4.57.3, so pip
 * put into ~/animastor/pydeps not only the missing packages but also
 * transformers 4.57.3 (platform 5.0.0), huggingface_hub 0.36.2 (platform
 * 1.3.5) and cryptography 50.0.2 (platform 3.4.8). The overlay is FIRST in
 * sys.path of the whole ComfyUI (prestartup script), so these versions apply
 * to ComfyUI itself and to every other custom node — silently.
 *
 *   1. after the deps are in place the overlay is compared with the platform
 *      Python (`python -I`, importlib.metadata, the overlay NOT on sys.path):
 *      every package present in both with different versions is a
 *      replacement; it is attributed to the node(s) that forced it — a node
 *      whose requirement closure (requirements.txt + Requires-Dist, as
 *      ComfyUI sees the packages: overlay first) excludes the platform
 *      version;
 *   2. a replacement touching a package that ANOTHER profile on this ComfyUI
 *      uses (a node of that profile that did not force it), or — with more
 *      than one profile — a ComfyUI core requirement (<root>/requirements.txt)
 *      whose range excludes the overlay version, is a conflict: it needs
 *      consent (interactive question or --accept-node-deps-overrides); boot
 *      and --yes never consent.
 */

const path = require('path');

/**
 * Python run with `-I -c` in the PLATFORM interpreter:
 *   argv[1] overlay site-packages, argv[2] ComfyUI requirements.txt ('' = none),
 *   argv[3] JSON [{ key, req }] — requirements.txt of the custom nodes.
 * Prints ONE JSON line:
 *   { overrides: [{ name, key, platform, overlay }],
 *     nodes: [{ key, uses: { <pkg key>: { specs, accepts_platform, accepts_overlay } } }],
 *     core: { <pkg key>: { spec, accepts_overlay } } }
 */
const OVERRIDES_SCRIPT = [
    'import json, re, sys',
    'try:',
    '    from packaging.requirements import Requirement',
    '    from packaging.specifiers import SpecifierSet',
    'except Exception:',
    '    from pip._vendor.packaging.requirements import Requirement',
    '    from pip._vendor.packaging.specifiers import SpecifierSet',
    'try:',
    '    from importlib import metadata as md',
    'except Exception:',
    '    import importlib_metadata as md',
    'def canon(n):',
    '    return re.sub(r"[-_.]+", "-", n).lower()',
    'overlay_sp = sys.argv[1]',
    'core_req = sys.argv[2]',
    'nodes = json.loads(sys.argv[3])',
    'platform_path = list(sys.path)',
    'def dists(paths):',
    '    out = {}',
    '    for d in md.distributions(path=paths):',
    '        try:',
    '            n = d.metadata["Name"]',
    '        except Exception:',
    '            n = None',
    '        if n and canon(n) not in out:',
    '            out[canon(n)] = d',
    '    return out',
    'overlay = dists([overlay_sp])',
    'platform = dists(platform_path)',
    'both = dists([overlay_sp] + platform_path)',
    'overrides = []',
    'for k, d in sorted(overlay.items()):',
    '    p = platform.get(k)',
    '    if p is None or p.version == d.version:',
    '        continue',
    '    overrides.append({"name": d.metadata["Name"], "key": k, "platform": p.version, "overlay": d.version})',
    'ov = {o["key"]: o for o in overrides}',
    'def parse(path):',
    '    out = []',
    '    try:',
    '        f = open(path, encoding="utf-8", errors="replace")',
    '    except Exception:',
    '        return out',
    '    for raw in f:',
    '        line = raw.split(" #")[0].strip()',
    '        if not line or line.startswith("#") or line.startswith("-"):',
    '            continue',
    '        if "://" in line and "@" not in line:',
    '            continue',
    '        try:',
    '            r = Requirement(line)',
    '        except Exception:',
    '            continue',
    '        if r.marker is not None and not r.marker.evaluate():',
    '            continue',
    '        out.append(r)',
    '    return out',
    'def marker_ok(r, extras):',
    '    if r.marker is None:',
    '        return True',
    '    for e in ("",) + extras:',
    '        try:',
    '            if r.marker.evaluate({"extra": e}):',
    '                return True',
    '        except Exception:',
    '            pass',
    '    return False',
    'def closure(reqs):',
    '    specs = {}',
    '    seen = set()',
    '    queue = list(reqs)',
    '    while queue:',
    '        r = queue.pop(0)',
    '        k = canon(r.name)',
    '        specs.setdefault(k, []).append(str(r.specifier))',
    '        extras = tuple(sorted(r.extras))',
    '        if (k, extras) in seen:',
    '            continue',
    '        seen.add((k, extras))',
    '        d = both.get(k)',
    '        if d is None:',
    '            continue',
    '        for s in (d.requires or []):',
    '            try:',
    '                rr = Requirement(s)',
    '            except Exception:',
    '                continue',
    '            if marker_ok(rr, extras):',
    '                queue.append(rr)',
    '    return specs',
    'def accepts(specs, v):',
    '    for s in specs:',
    '        if s and not SpecifierSet(s).contains(v, prereleases=True):',
    '            return False',
    '    return True',
    'out_nodes = []',
    'for n in nodes:',
    '    specs = closure(parse(n["req"])) if ov else {}',
    '    uses = {}',
    '    for k, o in ov.items():',
    '        if k in specs:',
    '            s = [x for x in specs[k] if x]',
    '            uses[k] = {"specs": s, "accepts_platform": accepts(s, o["platform"]), "accepts_overlay": accepts(s, o["overlay"])}',
    '    out_nodes.append({"key": n["key"], "uses": uses})',
    'core = {}',
    'if core_req and ov:',
    '    for r in parse(core_req):',
    '        k = canon(r.name)',
    '        if k in ov:',
    '            core[k] = {"spec": str(r.specifier), "accepts_overlay": accepts([str(r.specifier)], ov[k]["overlay"])}',
    'print(json.dumps({"overrides": overrides, "nodes": out_nodes, "core": core}))',
].join('\n');

/**
 * Required custom nodes with a requirements.txt of ALL profiles on this
 * ComfyUI, one entry per directory with every profile that uses it.
 * @returns {Array<{ directory, reqPath, profiles: string[] }>}
 */
function nodesOfProfiles(io, { root, manifests }) {
    const byDir = new Map();
    for (const m of manifests || []) {
        const profile = (m && m.profile && m.profile.id) || null;
        for (const dep of (m && m.dependencies) || []) {
            if (dep.kind !== 'custom_node' || dep.requirement !== 'required') continue;
            const dir = (dep.install && dep.install.directory) || dep.name;
            const reqPath = path.join(root, 'custom_nodes', dir, 'requirements.txt');
            if (!io.fs.existsSync(reqPath)) continue;
            const e = byDir.get(dir) || { directory: dir, reqPath, profiles: [] };
            if (profile && !e.profiles.includes(profile)) e.profiles.push(profile);
            byDir.set(dir, e);
        }
    }
    return Array.from(byDir.values());
}

/** Distinct profile ids of the manifests. */
function profileIds(manifests) {
    return Array.from(new Set((manifests || []).map((m) => m && m.profile && m.profile.id).filter(Boolean)));
}

function majorOf(v) {
    const m = /^\s*v?(\d+)/.exec(String(v || ''));
    return m ? Number(m[1]) : null;
}

/** 'up' | 'down' | null — change of the MAJOR version platform → overlay. */
function majorChange(platform, overlay) {
    const a = majorOf(platform);
    const b = majorOf(overlay);
    if (a === null || b === null || a === b) return null;
    return b > a ? 'up' : 'down';
}

/**
 * Run the comparison in the platform Python.
 * @returns {{ ok: boolean, error?: string, overrides: object[], nodes: object[], core: object }}
 */
function inspectOverlay(io, { python, sitePackages, root, nodes }) {
    const coreReq = root ? path.join(root, 'requirements.txt') : '';
    const arg = JSON.stringify((nodes || []).map((n) => ({ key: n.directory, req: n.reqPath })));
    let r = null;
    try {
        r = io.exec(python, ['-I', '-c', OVERRIDES_SCRIPT, sitePackages, coreReq && io.fs.existsSync(coreReq) ? coreReq : '', arg], { timeout: 120000 });
    } catch (err) { r = { code: 1, stderr: err.message }; }
    const empty = { overrides: [], nodes: [], core: {} };
    if (!r || r.code !== 0) return { ok: false, error: String((r && (r.stderr || r.error)) || 'overlay comparison failed').trim().slice(-300), ...empty };
    let parsed = null;
    try { parsed = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch (_) { parsed = null; }
    if (!parsed || !Array.isArray(parsed.overrides)) return { ok: false, error: 'unexpected output of the overlay comparison', ...empty };
    return { ok: true, overrides: parsed.overrides, nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [], core: parsed.core || {} };
}

/**
 * Attribute the replacements and find the conflicts.
 * @param {object} raw inspectOverlay() result
 * @param {Array} nodes nodesOfProfiles() result
 * @param {{ profileCount: number }} opts
 * @returns {{ overrides: object[], conflicts: object[] }}
 */
function analyzeOverrides(raw, nodes, { profileCount = 1 } = {}) {
    const usesOf = new Map((raw.nodes || []).map((n) => [n.key, n.uses || {}]));
    const overrides = [];
    const conflicts = [];
    for (const o of raw.overrides || []) {
        const users = nodes.filter((n) => (usesOf.get(n.directory) || {})[o.key]);
        const causes = users.filter((n) => usesOf.get(n.directory)[o.key].accepts_platform === false);
        const neededBy = causes.length > 0 ? causes : users;
        const causeProfiles = new Set(neededBy.flatMap((n) => n.profiles));
        const entry = {
            package: o.name,
            key: o.key,
            platform: o.platform,
            overlay: o.overlay,
            major: majorChange(o.platform, o.overlay),
            needed_by: neededBy.map((n) => n.directory),
            profiles: Array.from(causeProfiles),
        };
        overrides.push(entry);
        if (causes.length > 0) {
            for (const n of users) {
                if (causes.includes(n)) continue;
                const u = usesOf.get(n.directory)[o.key];
                for (const p of n.profiles) {
                    if (causeProfiles.has(p)) continue;
                    conflicts.push({
                        kind: 'profile', package: o.name, key: o.key, platform: o.platform, overlay: o.overlay,
                        needed_by: entry.needed_by, cause_profiles: entry.profiles,
                        profile: p, node: n.directory, specs: u.specs || [], accepts_overlay: u.accepts_overlay !== false,
                    });
                }
            }
        }
        const core = (raw.core || {})[o.key];
        if (profileCount > 1 && core && core.accepts_overlay === false) {
            conflicts.push({
                kind: 'core', package: o.name, key: o.key, platform: o.platform, overlay: o.overlay,
                needed_by: entry.needed_by, cause_profiles: entry.profiles,
                profile: null, node: 'ComfyUI', specs: core.spec ? [core.spec] : [], accepts_overlay: false,
            });
        }
    }
    return { overrides, conflicts };
}

/** "transformers platform 5.0.0 → overlay 4.57.3 (needed by qwen3-tts)" */
function describeOverride(o) {
    const by = o.needed_by && o.needed_by.length > 0 ? o.needed_by.join(', ') : 'no node of the installed profiles';
    return `${o.package} platform ${o.platform} → overlay ${o.overlay} (needed by ${by})`;
}

/** The warning part for a major change, or ''. */
function majorNote(o) {
    if (!o.major) return '';
    return ` — major version ${o.major === 'up' ? 'UP' : 'DOWN'} (${majorOf(o.platform)} → ${majorOf(o.overlay)}): ComfyUI and every other custom node import this version`;
}

/** One line for a conflict. */
function describeConflict(c) {
    const head = `${c.package} platform ${c.platform} → overlay ${c.overlay} (needed by ${c.needed_by.join(', ') || '?'}${c.cause_profiles.length ? `, profile ${c.cause_profiles.join(', ')}` : ''})`;
    if (c.kind === 'core') {
        return `${head} is outside the range of the ComfyUI core requirement ${c.package}${c.specs[0] || ''} (<ComfyUI>/requirements.txt)`;
    }
    const range = c.specs.length > 0 ? `requires ${c.specs.join(', ')}; the overlay version is ${c.accepts_overlay ? 'inside' : 'OUTSIDE'} that range` : 'any version';
    return `${head} also changes it for profile ${c.profile} (node ${c.node}, ${range})`;
}

/** Key of an accepted conflict in install-state (package@overlay-version:profile). */
function conflictKey(c) {
    return `${c.key || String(c.package).toLowerCase()}@${c.overlay}:${c.profile || 'comfyui-core'}`;
}

/** Conflicts that are not in the recorded consent list. */
function pendingConflicts(conflicts, accepted = []) {
    const ok = new Set((accepted || []).map((a) => (typeof a === 'string' ? a : a && a.key)).filter(Boolean));
    return (conflicts || []).filter((c) => !ok.has(conflictKey(c)));
}

/** Record entry for an accepted conflict. */
function acceptedEntry(c, at) {
    return { key: conflictKey(c), package: c.package, overlay: c.overlay, profile: c.profile || 'comfyui-core', at };
}

/** The install-state record of a replacement (installer_options.nodeDeps.overrides[]). */
function recordOf(o) {
    return { package: o.package, platform: o.platform, overlay: o.overlay, major: o.major, needed_by: o.needed_by, profiles: o.profiles };
}

/** RESULT items: [i] for a replacement, ! for a major change. */
function resultItems(overrides) {
    return (overrides || []).map((o) => ({ ok: o.major ? 'warn' : 'info', label: `${describeOverride(o)}${majorNote(o)}` }));
}

// ---------------------------------------------------------------------------
// Snapshot of the overlay venv (rollback of a refused replacement)
// ---------------------------------------------------------------------------

function snapshotDir(venvDir) {
    return `${venvDir}.pre-install`;
}

/**
 * Copy the overlay venv aside (`cp -a`) before pip changes it. A stale
 * snapshot of an interrupted run is replaced.
 * @returns {{ ok: boolean, dir: string, reason: string|null }}
 */
function snapshotOverlay(io, venvDir) {
    const dir = snapshotDir(venvDir);
    try { if (io.fs.existsSync(dir)) io.fs.rmSync(dir, { recursive: true, force: true }); } catch (err) {
        return { ok: false, dir, reason: `cannot remove the stale snapshot ${dir}: ${err.message}` };
    }
    let r = null;
    try { r = io.exec('cp', ['-a', venvDir, dir], { timeout: 30 * 60 * 1000 }); } catch (err) { r = { code: 1, stderr: err.message }; }
    if (!r || r.code !== 0) return { ok: false, dir, reason: `cp -a ${venvDir} ${dir} failed: ${String((r && (r.stderr || r.error)) || '').trim().slice(-200)}` };
    return { ok: true, dir, reason: null };
}

/** Put the snapshot back in place of the overlay venv. */
function restoreOverlay(io, venvDir) {
    const dir = snapshotDir(venvDir);
    if (!io.fs.existsSync(dir)) return { ok: false, reason: `no snapshot ${dir}` };
    try {
        io.fs.rmSync(venvDir, { recursive: true, force: true });
        io.fs.renameSync(dir, venvDir);
    } catch (err) {
        return { ok: false, reason: `restoring ${venvDir} from ${dir} failed: ${err.message}` };
    }
    return { ok: true, reason: null };
}

/** Remove the snapshot (the change was kept). */
function dropSnapshot(io, venvDir) {
    try { io.fs.rmSync(snapshotDir(venvDir), { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

module.exports = {
    OVERRIDES_SCRIPT,
    nodesOfProfiles,
    profileIds,
    majorChange,
    inspectOverlay,
    analyzeOverrides,
    describeOverride,
    majorNote,
    describeConflict,
    conflictKey,
    pendingConflicts,
    acceptedEntry,
    recordOf,
    resultItems,
    snapshotDir,
    snapshotOverlay,
    restoreOverlay,
    dropSnapshot,
};
