// ======================================================
// orchestration-v2/progress-adapter — gen.progress → the CURRENT front contract
// ======================================================
// The old progress-stream SSE of a v2 book (kept until task H): every NOTIFY →
// {type:'progress', layer, command_id, ready, total}; a command reaching a
// terminal status → {type:'generation_complete'} once. The legacy panel rows
// (GET /progress-panel) were removed 2026-11-28 with the route (ADR §11.3).
//
// aggregate() (2026-11-27, generate API v2, ADR §9 / §11.1) — the NEW format of
// GET /generate/progress and GET /generate/stream: the gen.progress rows as they
// are (command × layer × scene: queued / running / done / failed / cancelled)
// plus per layer ready / total / percent (the same counting as the panel rows)
// and the scope labels. No legacy grammar, no build_id.

'use strict';

const FINISHED_VISIBLE_MS = 10 * 60_000;
const MERGED_LAYERS = new Set(['audio', 'video']);

const COUNTERS = ['queued', 'running', 'done', 'failed', 'cancelled', 'retrying', 'joined_queued', 'joined_running'];

/** Chapter / scene labels of a loaded book. */
function labelsOf(bookData, chapterId, sceneId) {
    const out = { chapter_label: null, scene_label: null };
    if (!bookData || !chapterId) return out;
    const ch = (bookData.chapters || []).find((c) => (c.chapter_id ?? c.chapter) === chapterId);
    if (!ch) return out;
    const title = typeof ch.chapter_title === 'string' && ch.chapter_title.trim() ? ch.chapter_title.trim() : null;
    if (ch.display_number != null) out.chapter_label = title ? `Chapter ${ch.display_number} — ${title}` : `Chapter ${ch.display_number}`;
    else out.chapter_label = title;
    if (!sceneId) return out;
    const sc = (ch.scenes || []).find((x) => x.scene_id === sceneId);
    if (!sc) return out;
    const scTitle = typeof sc.scene_title === 'string' && sc.scene_title.trim() ? sc.scene_title.trim() : null;
    if (sc.display_index > 0) out.scene_label = scTitle ? `Scene ${sc.display_index} — ${scTitle}` : `Scene ${sc.display_index}`;
    else if (scTitle) out.scene_label = scTitle;
    else if (sc.type === 'cover') out.scene_label = 'Cover';
    return out;
}

/** ready / total of one layer of a command (audio / video: + one merge per scene). */
function layerCounts(c, layer) {
    const t = c.by_layer[layer] || {};
    const scenes = c.scenes.filter((s) => s.layer === layer);
    const all = (t.queued || 0) + (t.running || 0) + (t.done || 0) + (t.failed || 0) + (t.cancelled || 0);
    const merges = (c.merges && c.merges[layer]) || 0;
    const total = all + (MERGED_LAYERS.has(layer) ? Math.max(0, scenes.length - merges) : 0);
    const done = c.status === 'done';
    const ready = done ? total : (t.done || 0);
    return { ready, total, percent: done ? 100 : Math.round(ready * 100 / Math.max(1, total)), scenes: scenes.length };
}

function sceneOf(scope) {
    if (!scope) return { chapter_id: null, scene_id: null };
    if (scope.level === 'scenes') return { chapter_id: null, scene_id: Array.isArray(scope.scene_ids) ? scope.scene_ids[0] || null : null };
    return { chapter_id: scope.chapter_id || null, scene_id: scope.scene_id || null };
}

function createProgressAdapter({ orch, book = null }) {
    const announced = new Map();      // command_id → ts (terminal event sent)

    /**
     * ADR §9 aggregate of the book (GET /generate/progress, GET /generate/stream).
     * Active commands plus those finished within the last 10 minutes.
     */
    async function aggregate(bookId) {
        const p = await orch.progress(bookId, { finishedWithinMs: FINISHED_VISIBLE_MS });
        let bookData = null;
        if (p.commands.length && book && typeof book.loadBook === 'function') {
            try { bookData = book.loadBook(bookId); } catch (_) { bookData = null; }
        }
        const pick = (o) => { const x = {}; for (const k of COUNTERS) x[k] = (o && o[k]) || 0; return x; };
        const findChapter = (sceneId) => {
            if (!bookData || !sceneId) return null;
            const ch = (bookData.chapters || []).find((c) => (c.scenes || []).some((s) => s.scene_id === sceneId));
            return ch ? (ch.chapter_id ?? ch.chapter) : null;
        };
        const commands = p.commands.map((c) => {
            const scope = c.scope || { level: 'book' };
            const at = sceneOf(scope);
            const chapterId = at.chapter_id || findChapter(at.scene_id);
            const lab = labelsOf(bookData, chapterId, scope.level === 'chapter' ? null : at.scene_id);
            const byLayer = {};
            for (const layer of c.layers) byLayer[layer] = { ...pick(c.by_layer[layer]), ...layerCounts(c, layer) };
            return {
                command_id: c.command_id,
                kind: c.kind,
                status: c.status,
                mode: c.force ? 'all' : 'missing',
                scope,
                layers: c.layers,
                created_at: c.created_at,
                finished_at: c.finished_at,
                error: c.error || null,
                summary: c.summary || null,
                skipped: c.skipped || {},
                labels: { chapter_label: lab.chapter_label, scene_label: lab.scene_label, scene_count: scope.level === 'scenes' ? (scope.scene_ids || []).length : null },
                totals: pick(c.totals),
                by_layer: byLayer,
                scenes: c.scenes.map((s) => ({ chapter_id: s.chapter_id, scene_id: s.scene_id, layer: s.layer, ...pick(s) })),
            };
        });
        return {
            book_id: bookId,
            orchestration: 'v2',
            generated_at: new Date().toISOString(),
            active: commands.some((c) => c.status === 'active'),
            totals: pick(p.totals),
            commands,
        };
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

    return { aggregate, onNotify };
}

module.exports = { createProgressAdapter, labelsOf };
