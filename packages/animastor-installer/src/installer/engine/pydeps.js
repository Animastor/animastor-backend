'use strict';

/**
 * Persistent custom-node Python dependencies for a PLATFORM ComfyUI
 * (installer 0.2.5, ADR in animastor-docs INSTALLER_ARCHITECTURE §node deps).
 *
 * E2E 02.11 (TIR, type A): the platform runs ComfyUI as root with
 * /usr/bin/python3; `pip install` as root writes to
 * /usr/local/lib/python3.10/dist-packages (Debian `posix_local` scheme), and
 * only /home survives a node restart — so the packages of qwen3-tts were gone
 * after every restart, and every boot needed a reinstall plus a restart of
 * the platform's ComfyUI.
 *
 * Instead the packages go into an OVERLAY venv under the installation:
 *
 *   ~/animastor/pydeps/py3.10/          python -m venv --without-pip --system-site-packages
 *   ~/animastor/pydeps/py3.10/lib/python3.10/site-packages   ← only what is MISSING
 *
 * `--system-site-packages` makes pip (the platform's own pip module, run by
 * the overlay interpreter) see everything the platform already has: torch &
 * co. are "already satisfied" and never copied. `--without-pip` needs no
 * ensurepip / python3.X-venv.
 *
 * The platform's ComfyUI sees the overlay through a generated custom node
 * whose `prestartup_script.py` runs inside main.py BEFORE any custom node is
 * imported (ComfyUI execute_prestartup_script). It prepends the overlay
 * site-packages (site.addsitedir → .pth files honoured). Everything lives in
 * /home: after a node restart the platform starts its ComfyUI and the node
 * classes load — no reinstall, no restart.
 */

const path = require('path');

/** Directory of the generated custom node (custom_nodes/<this>). */
const PYDEPS_NODE_DIR = 'animastor-pydeps';
const PRESTARTUP_MARKER = '# animastor: generated prestartup — persistent node dependencies';

/** ~/animastor/pydeps for <workerDir> = ~/animastor/worker. */
function overlayBase(workerDir) {
    return path.join(path.dirname(path.resolve(workerDir)), 'pydeps');
}

/** "3.10" — major.minor of `python`, or null. */
function pythonTag(io, python) {
    let r = null;
    try { r = io.exec(python, ['-I', '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { timeout: 30000 }); } catch (_) { r = null; }
    const m = r && r.code === 0 ? /^(\d+\.\d+)\s*$/.exec(String(r.stdout || '').trim()) : null;
    return m ? m[1] : null;
}

/** Layout of the overlay for one Python X.Y. */
function overlayPaths(base, tag) {
    const dir = path.join(base, `py${tag}`);
    return {
        dir,
        python: path.join(dir, 'bin', 'python'),
        sitePackages: path.join(dir, 'lib', `python${tag}`, 'site-packages'),
        cfg: path.join(dir, 'pyvenv.cfg'),
    };
}

/**
 * Does this ComfyUI run custom_nodes/<node>/prestartup_script.py before the
 * node imports? (main.py execute_prestartup_script, ComfyUI since 2023.)
 */
function supportsPrestartup(io, root) {
    try {
        return /prestartup_script/.test(String(io.fs.readFileSync(path.join(root, 'main.py'), 'utf8')));
    } catch (_) { return false; }
}

/** The generated prestartup script (Python), with the overlay base baked in. */
function renderPrestartupScript(base) {
    return [
        PRESTARTUP_MARKER,
        '# (animastor installer 0.2.5). Do not edit: `animastor doctor` rewrites this file.',
        '# Puts the overlay site-packages of the Animastor installation in front of',
        '# sys.path before ComfyUI imports the custom nodes. The overlay holds ONLY',
        '# the packages the platform Python lacks; it lives in /home and survives',
        '# a node restart. A missing overlay (other Python X.Y) is a no-op.',
        'import os',
        'import site',
        'import sys',
        '',
        `_ANIMASTOR_PYDEPS = ${JSON.stringify(base)}`,
        '',
        '',
        'def _animastor_pydeps():',
        '    tag = "%d.%d" % sys.version_info[:2]',
        '    sp = os.path.join(_ANIMASTOR_PYDEPS, "py" + tag, "lib", "python" + tag, "site-packages")',
        '    if not os.path.isdir(sp) or sp in sys.path:',
        '        return',
        '    before = list(sys.path)',
        '    site.addsitedir(sp)',
        '    added = [p for p in sys.path if p not in before]',
        '    sys.path[:] = added + [p for p in sys.path if p not in added]',
        '    print("[animastor] node dependencies: %s" % sp)',
        '',
        '',
        'try:',
        '    _animastor_pydeps()',
        'except Exception as e:  # never break the ComfyUI start',
        '    print("[animastor] node dependencies not added: %s" % e)',
        '',
    ].join('\n');
}

const INIT_PY = [
    '# animastor: generated — see prestartup_script.py. No nodes of its own.',
    'NODE_CLASS_MAPPINGS = {}',
    'NODE_DISPLAY_NAME_MAPPINGS = {}',
    '',
].join('\n');

/**
 * Write custom_nodes/animastor-pydeps/{prestartup_script.py,__init__.py}.
 * Idempotent: unchanged bytes → 'unchanged' (a running ComfyUI needs no
 * restart for it); a foreign directory of the same name is never touched.
 * @returns {{ status: 'created'|'updated'|'unchanged'|'foreign'|'failed', dir: string, reason?: string }}
 */
function ensurePrestartupNode(io, { root, base }) {
    const dir = path.join(root, 'custom_nodes', PYDEPS_NODE_DIR);
    const script = path.join(dir, 'prestartup_script.py');
    const init = path.join(dir, '__init__.py');
    const wanted = renderPrestartupScript(base);
    let current = null;
    try { current = io.fs.existsSync(script) ? String(io.fs.readFileSync(script, 'utf8')) : null; } catch (_) { current = null; }
    if (current !== null && !current.startsWith(PRESTARTUP_MARKER)) {
        return { status: 'foreign', dir, reason: `${script} was not generated by the installer — left untouched` };
    }
    let initCurrent = null;
    try { initCurrent = io.fs.existsSync(init) ? String(io.fs.readFileSync(init, 'utf8')) : null; } catch (_) { initCurrent = null; }
    if (current === wanted && initCurrent === INIT_PY) return { status: 'unchanged', dir };
    try {
        io.fs.mkdirSync(dir, { recursive: true });
        io.fs.writeFileSync(init, INIT_PY);
        io.fs.writeFileSync(script, wanted);
    } catch (err) {
        return { status: 'failed', dir, reason: err.message };
    }
    return { status: current === null ? 'created' : 'updated', dir };
}

/**
 * Create the overlay venv for `python` (idempotent).
 * @returns {{ ok: boolean, created: boolean, paths: object|null, tag: string|null, reason: string|null }}
 */
function ensureOverlayVenv(io, { python, base }) {
    const tag = pythonTag(io, python);
    if (!tag) return { ok: false, created: false, paths: null, tag: null, reason: `cannot read the version of ${python}` };
    const p = overlayPaths(base, tag);
    if (io.fs.existsSync(p.cfg) && io.fs.existsSync(p.python)) return { ok: true, created: false, paths: p, tag, reason: null };
    try { io.fs.mkdirSync(base, { recursive: true }); } catch (err) {
        return { ok: false, created: false, paths: p, tag, reason: `cannot create ${base}: ${err.message}` };
    }
    let r = null;
    try { r = io.exec(python, ['-m', 'venv', '--without-pip', '--system-site-packages', p.dir], { timeout: 120000 }); } catch (err) { r = { code: 1, stderr: err.message }; }
    if (!r || r.code !== 0) {
        return { ok: false, created: false, paths: p, tag, reason: `${python} -m venv failed: ${String((r && (r.stderr || r.error)) || '').trim().slice(-300)}` };
    }
    // pip itself comes from the platform's site-packages (system-site-packages).
    let pip = null;
    try { pip = io.exec(p.python, ['-m', 'pip', '--version'], { timeout: 60000 }); } catch (err) { pip = { code: 1, stderr: err.message }; }
    if (!pip || pip.code !== 0) {
        return { ok: false, created: true, paths: p, tag, reason: `pip is not available to ${python} (${String((pip && pip.stderr) || '').trim().slice(-200)})` };
    }
    return { ok: true, created: true, paths: p, tag, reason: null };
}

/**
 * Decide where the node dependencies of a platform ComfyUI go.
 *   overlay — the ComfyUI runs prestartup scripts and the overlay venv works;
 *   system  — fallback (old ComfyUI / no venv module): the 0.2.4 behaviour,
 *             packages vanish with a node restart, boot reinstalls them.
 * Nothing is created when `create` is false (read-only check).
 * @returns {{ kind: 'overlay'|'system', base, paths: object|null, sitePackages: string|null, reason: string|null, venv?: object }}
 */
function planPersistence(io, { python, root, base, create = true }) {
    if (!base) return { kind: 'system', base: null, paths: null, sitePackages: null, reason: 'no installation directory for the overlay' };
    if (!supportsPrestartup(io, root)) {
        return { kind: 'system', base, paths: null, sitePackages: null, reason: `${path.join(root, 'main.py')} has no prestartup_script support (ComfyUI too old)` };
    }
    if (!create) {
        const tag = pythonTag(io, python);
        const p = tag ? overlayPaths(base, tag) : null;
        return { kind: 'overlay', base, paths: p, sitePackages: p ? p.sitePackages : null, reason: null };
    }
    const venv = ensureOverlayVenv(io, { python, base });
    if (!venv.ok) return { kind: 'system', base, paths: null, sitePackages: null, reason: venv.reason, venv };
    return { kind: 'overlay', base, paths: venv.paths, sitePackages: venv.paths.sitePackages, reason: null, venv };
}

module.exports = {
    PYDEPS_NODE_DIR,
    PRESTARTUP_MARKER,
    overlayBase,
    pythonTag,
    overlayPaths,
    supportsPrestartup,
    renderPrestartupScript,
    ensurePrestartupNode,
    ensureOverlayVenv,
    planPersistence,
};
