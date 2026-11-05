// ======================================================
// orchestration-v2/progress-adapter — gen.progress → the CURRENT front contract
// ======================================================
// web (generateStore / animastor-web-generator models.ts) and Android
// (GenerateViewModel) read GET /progress-panel `tasks[]` rows and the SSE
// `type` events (разведка ORCHESTRATION_V2_RECON §7). A v2 book answers in
// exactly that shape, so both fronts show progress without changes:
//   one row per command × layer, task_id = command_id, scope in the legacy
//   grammar (whole_book / current_chapter / current_scene),
//   ready/total = done audio parts + done scene merges / planned parts + scenes.
// SSE: every NOTIFY → {type:'progress', layer, command_id, ready, total};
// a command reaching a terminal status → {type:'generation_complete'} once.

'use strict';

const SCOPE_TO_LEGACY = Object.freeze({ book: 'whole_book', chapter: 'current_chapter', scene: 'current_scene', unit: 'current_scene' });
const FINISHED_VISIBLE_MS = 10 * 60_000;

function createProgressAdapter({ orch }) {
    const announced = new Map();      // command_id → ts (terminal event sent)

    /** @returns {Promise<{book_id, tasks, overall_percent, any_incomplete}>} */
    async function panel(bookId, { resolveLabels = () => ({ scene_label: null, chapter_label: null }) } = {}) {
        const p = await orch.progress(bookId, { finishedWithinMs: FINISHED_VISIBLE_MS });
        const tasks = [];
        for (const c of p.commands) {
            for (const layer of c.layers) {
                const t = c.by_layer[layer] || {};
                const scenes = c.scenes.filter((s) => s.layer === layer);
                const all = (t.queued || 0) + (t.running || 0) + (t.done || 0) + (t.failed || 0) + (t.cancelled || 0);
                // every scene ends with one merge; until it exists it counts as one pending part
                const merges = (c.merges && c.merges[layer]) || 0;
                const total = all + Math.max(0, scenes.length - merges);
                const ready = t.done || 0;
                const cancelled = c.status === 'cancelled';
                const failed = c.status === 'failed' || c.status === 'partial';
                const done = c.status === 'done';
                const percent = done ? 100 : Math.round(ready * 100 / Math.max(1, total));
                const scope = c.scope || { level: 'book' };
                const labels = resolveLabels(scope.chapter_id || null, scope.scene_id || null);
                tasks.push({
                    task_id: c.command_id,
                    type: layer,
                    scope: SCOPE_TO_LEGACY[scope.level] || 'whole_book',
                    chapter_id: scope.chapter_id || null,
                    scene_id: scope.scene_id || null,
                    scene_label: labels.scene_label,
                    chapter_label: labels.chapter_label,
                    end_scene_label: null,
                    end_chapter_label: null,
                    target_count: scenes.length,
                    started_at: c.created_at ? new Date(c.created_at).getTime() : null,
                    ready: done ? total : ready,
                    total,
                    percent,
                    done,
                    visible: true,
                    indeterminate: false,
                    cancelled,
                    status: done ? 'completed' : (cancelled ? 'cancelled' : (failed ? 'failed' : 'active')),
                    blocked: false,
                    blocked_reason: null,
                    interrupted: false,
                    failed,
                    failed_scene: null,
                    error_class: failed ? 'gen_v2' : null,
                    error_code: null,
                    error_message: failed ? (c.error || null) : null,
                    retrying: !failed && !done && !cancelled && (t.retrying || 0) > 0,
                    retry_no: null,
                    retry_max: null,
                    retry_at: null,
                    orchestration: 'v2',
                });
            }
        }
        const anyIncomplete = tasks.some((r) => !r.done && !r.cancelled && !r.blocked && !r.interrupted && !r.failed);
        const overall = tasks.length ? Math.round(tasks.reduce((sum, r) => sum + r.percent, 0) / tasks.length) : 0;
        return { book_id: bookId, tasks, overall_percent: overall, any_incomplete: anyIncomplete };
    }

    /** NOTIFY gen_progress → SSE on the existing progress-stream channel. */
    async function onNotify(evt, publish) {
        if (!evt || !evt.book_id) return;
        const p = await orch.progress(evt.book_id, { finishedWithinMs: FINISHED_VISIBLE_MS });
        for (const c of p.commands) {
            if (evt.command_id && c.command_id !== evt.command_id && c.status === 'active') continue;
            for (const layer of c.layers) {
                const t = c.by_layer[layer] || {};
                const total = (t.queued || 0) + (t.running || 0) + (t.done || 0) + (t.failed || 0) + (t.cancelled || 0);
                await publish(evt.book_id, { type: 'progress', layer, command_id: c.command_id, ready: t.done || 0, total });
            }
            if (c.status !== 'active' && !announced.has(c.command_id)) {
                announced.set(c.command_id, Date.now());
                await publish(evt.book_id, { type: 'generation_complete', command_id: c.command_id, status: c.status });
            }
        }
        if (announced.size > 5000) {
            const cutoff = Date.now() - FINISHED_VISIBLE_MS;
            for (const [k, ts] of announced) if (ts < cutoff) announced.delete(k);
        }
    }

    return { panel, onNotify, SCOPE_TO_LEGACY };
}

module.exports = { createProgressAdapter, SCOPE_TO_LEGACY };
