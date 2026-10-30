'use strict';

/**
 * Installer banner and the final result block.
 *
 * The final block is the ONLY thing a user has to read after a run: either
 * every check is ✓ and "Done — return to the Animastor page", or every ✗ is
 * one line of cause plus one exact fix command. Nothing refers to output
 * "above".
 */

const BANNER = [
    '    _    _   _ ___ __  __    _    ____ _____ ___  ____  ',
    '   / \\  | \\ | |_ _|  \\/  |  / \\  / ___|_   _/ _ \\|  _ \\ ',
    '  / _ \\ |  \\| || || |\\/| | / _ \\ \\___ \\ | || | | | |_) |',
    ' / ___ \\| |\\  || || |  | |/ ___ \\ ___) || || |_| |  _ < ',
    '/_/   \\_\\_| \\_|___|_|  |_/_/   \\_\\____/ |_| \\___/|_| \\_\\',
];

/**
 * @param {object} v { installer, worker, profile, profileRevision, hub, bootstrap, platform }
 * @returns {string}
 */
function renderBanner(v = {}) {
    const val = (x) => (x ? String(x) : 'unknown');
    const profile = v.profile ? `${v.profile}${v.profileRevision ? ` (${v.profileRevision})` : ''}` : '—';
    return [
        ...BANNER,
        '',
        `  GPU worker installer ${val(v.installer)}${v.platform ? ` · ${v.platform}` : ''}`,
        `  worker bundle ${val(v.worker)} · profile ${profile}`,
        `  hub ${val(v.hub)}${v.bootstrap ? ` · bootstrap ${v.bootstrap}` : ''}`,
        '',
    ].join('\n');
}

/**
 * Exact fix for a failed verification check (label from
 * verification-report.js). `tool` is the `animastor` command (or its
 * absolute path when not in PATH).
 */
function fixForCheck(check, { tool = 'animastor', mode = null } = {}) {
    switch (check.label) {
        case 'GPU':
            return 'install the NVIDIA driver so that `nvidia-smi` works, then run: ' + `${tool} doctor`;
        case 'VRAM':
            return 'use a GPU with more VRAM (see the profile minimum on the Animastor setup page)';
        case 'ComfyUI running':
        case 'ComfyUI API':
            return mode === 'managed' ? `${tool} start` : `start your ComfyUI, then run: ${tool} doctor`;
        case 'Worker registration':
        case 'GPU Hub registration':
            return `create a new Worker Key in Animastor → Settings → Workers, then run: ${tool} doctor --new-key`;
        case 'Worker process':
            return `${tool} start`;
        case 'Runtime':
            return /incompatible|version_mismatch/.test(String(check.detail || ''))
                ? `if ComfyUI already works, this can be ignored; to let the installer replace the torch/python runtime run: ${tool} doctor --accept-runtime-change`
                : `${tool} doctor`;
        default:
            return `${tool} doctor`;
    }
}

/** Verification labels already covered by the end-to-end checks. */
const COVERED_BY_E2E = new Set(['ComfyUI running', 'ComfyUI API', 'Worker process']);

/**
 * Build the final block.
 * @param {object} args
 * @param {object|null} args.verification - buildVerificationReport() result
 * @param {Array} [args.e2e] - engine endToEndChecks() result
 * @param {Array} [args.extra] - additional { ok, label, detail, fix } items (blocked steps, remediation)
 * @returns {{ ok: boolean, text: string, failures: Array }}
 */
function renderFinalSummary({ verification = null, e2e = [], extra = [], tool = 'animastor', mode = null } = {}) {
    const items = [];
    for (const c of extra || []) items.push(c);
    const e2eIds = new Set((e2e || []).map((c) => c.label));
    for (const c of (verification && verification.checks) || []) {
        if (c.verdict !== false) continue;
        if (COVERED_BY_E2E.has(c.label) && e2e && e2e.length > 0) continue;
        if (e2eIds.has(c.label)) continue;
        items.push({ ok: false, label: c.label, detail: c.detail, fix: fixForCheck(c, { tool, mode }) });
    }
    for (const c of e2e || []) items.push(c);

    const failures = items.filter((c) => c.ok === false);
    const lines = ['', '==================== RESULT ===================='];
    for (const c of items) {
        const mark = c.ok === true ? '✓' : c.ok === false ? '✗' : '·';
        lines.push(`${mark} ${c.label}${c.detail ? `: ${oneLine(c.detail)}` : ''}`);
        if (c.ok === false && c.fix) lines.push(`    fix: ${c.fix}`);
    }
    lines.push('');
    if (failures.length === 0) {
        lines.push('Done — return to the Animastor page: the worker shows ONLINE.');
    } else {
        lines.push(`${failures.length} problem(s) left — run the fix command(s) above; \`${tool} doctor\` re-checks and fixes what it can.`);
    }
    return { ok: failures.length === 0, text: lines.join('\n'), failures };
}

function oneLine(s) {
    return String(s).replace(/\s+/g, ' ').trim();
}

module.exports = { renderBanner, renderFinalSummary, fixForCheck, BANNER };
