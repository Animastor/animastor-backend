// ======================================================
// Test helper: drive orchestration v2 through the generate API (ADR §11.1)
// ======================================================
// The v2 integration suites used to create commands with the removed
// POST /book/:id/regenerate and read GET /progress-panel rows (both removed
// 2026-11-28, ADR §11.3). They now go through POST /book/:id/generate and
// GET /book/:id/generate/progress. commandBody() keeps the suites' compact
// call shape: { layers, scope: 'book'|'chapter'|'scene'|'from_current_scene',
// chapter_id, scene_id, all, client_action_id }.

'use strict';

const crypto = require('crypto');

/** compact test body → POST /generate body */
function commandBody(b = {}) {
    const out = {
        layers: b.layers,
        mode: b.all === true ? 'all' : 'missing',
        client_action_id: b.client_action_id || crypto.randomUUID(),
    };
    if (b.scope !== undefined) {
        if (typeof b.scope === 'object') out.scope = b.scope;
        else {
            out.scope = { level: b.scope };
            if (b.chapter_id) out.scope.chapter_id = b.chapter_id;
            if (b.scene_id && (b.scope === 'scene' || b.scope === 'from_current_scene')) out.scope.scene_id = b.scene_id;
        }
    }
    return out;
}

/**
 * GET /generate/progress aggregate → one row per command × layer:
 * { command_id, layer, status, ready, total, percent, skipped }.
 */
function progressRows(agg) {
    const rows = [];
    for (const c of (agg && agg.commands) || []) {
        for (const layer of c.layers) {
            const l = c.by_layer[layer] || {};
            rows.push({ command_id: c.command_id, layer, status: c.status, ready: l.ready, total: l.total, percent: l.percent, skipped: c.skipped || {} });
        }
    }
    return rows;
}

module.exports = { commandBody, progressRows };
