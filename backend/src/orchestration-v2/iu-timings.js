// ======================================================
// orchestration-v2/iu-timings — real IU durations (ADR §13 п.11 пп.5, 7)
// ======================================================
// ONE source of IU durations for video on orchestration v2:
//   realUnitDurations(units, rows) — end_ms − start_ms of image_units, nothing
//     else (no estimated_duration_sec fallback). The SAME list feeds the group
//     plan (DP composition, totalFrames, LTXVAddGuide frame_idx, prompt time
//     codes), the group part_hash, the merge hash and the merge itself
//     (trim targets + unit-boundary keyframes, durationsOverride).
// And the v2 counterpart of the legacy IU-RECALC
// (packages/animastor-orchestration/src/legacy/orchestration/scene-callbacks.js:215–269):
//   computeUnitTimings(units, realDurationSec, records) — the same formulas:
//     records with unit_id (measured audio chunks) → actual per-unit sums, the
//     last chunk counted by its tail duration; a unit without a chunk keeps zero
//     width; no per-unit data → split of the merged duration by text length
//     (min 200 ms, clamped to the scene end).
//   writeUnitTimings(db, …) — written inside the audio_merge acceptance
//     transaction (start_ms, end_ms, estimated_duration_sec, scene_duration_sec,
//     text_proportion; 0 is stored as 0).

'use strict';

/**
 * @param {Array<{id:string}>} units scene units in book order
 * @param {Array<{unit_id:string, start_ms:number|null, end_ms:number|null}>} rows image_units of the scene (same build)
 * @returns {{ok:true, durations:Array<{unit_id:string, ms:number}>}|{ok:false, reason:string, unit_id?:string}}
 *          every unit of the scene with its real duration in ms (0 allowed); ok:false when a unit has no timing
 */
function realUnitDurations(units, rows) {
    const by = new Map((rows || []).map((r) => [String(r.unit_id), r]));
    const out = [];
    for (const u of units) {
        const r = by.get(String(u.id));
        const s = r && r.start_ms != null ? Number(r.start_ms) : null;
        const e = r && r.end_ms != null ? Number(r.end_ms) : null;
        if (s == null || e == null || !Number.isFinite(s) || !Number.isFinite(e) || e < s) return { ok: false, reason: 'no_timing', unit_id: String(u.id) };
        out.push({ unit_id: String(u.id), ms: Math.round(e - s) });
    }
    return { ok: true, durations: out };
}

const textLen = (u) => {
    if (Number.isFinite(u.text_length) && u.text_length > 0) return u.text_length;
    return typeof u.text === 'string' ? u.text.length : 0;
};

/**
 * Legacy IU-RECALC formulas.
 * @param {Array<{unit_id:string, text_length?:number, text?:string}>} units scene units in order
 * @param {number} realDurationSec duration of the merged scene audio
 * @param {Array<{chunk_index:number, unit_id:string|null, raw_duration_sec:number, tail_duration_sec:number}>|null} records
 * @returns {Array<{unit_id, scene_order, start_ms, end_ms, estimated_duration_sec, text_proportion, scene_duration_sec, mode}>}
 */
function computeUnitTimings(units, realDurationSec, records) {
    if (!Array.isArray(units) || !units.length || !(realDurationSec > 0)) return [];
    const recs = Array.isArray(records) ? records : [];
    const lastIdx = recs.length ? Math.max(...recs.map((r) => r.chunk_index)) : null;
    const perUnit = {};
    for (const r of recs) {
        if (!r.unit_id) continue;
        const dur = r.chunk_index === lastIdx && r.tail_duration_sec ? r.tail_duration_sec : r.raw_duration_sec;
        perUnit[r.unit_id] = (perUnit[r.unit_id] || 0) + (Number(dur) || 0);
    }
    const out = [];
    if (Object.keys(perUnit).length > 0) {
        let cursor = 0;
        units.forEach((u, i) => {
            const actual = perUnit[u.unit_id] ?? null;
            const start = cursor;
            let end; let est;
            if (actual != null && actual > 0) { end = cursor + Math.round(actual * 1000); est = parseFloat(actual.toFixed(3)); }
            else { end = cursor; est = 0; }                         // no chunk for this unit → zero width
            cursor = end;
            out.push({ unit_id: u.unit_id, scene_order: i, start_ms: start, end_ms: end, estimated_duration_sec: est,
                text_proportion: 0, scene_duration_sec: realDurationSec, mode: 'actual' });
        });
        return out;
    }
    const total = units.reduce((s, u) => s + textLen(u), 0);
    const sceneMs = Math.round(realDurationSec * 1000);
    let cursor = 0;
    units.forEach((u, i) => {
        const proportion = total > 0 ? textLen(u) / total : 1 / units.length;
        const durMs = Math.max(200, Math.round(realDurationSec * proportion * 1000));
        const start = cursor;
        let end = cursor + durMs;
        if (end > sceneMs) end = sceneMs;
        cursor = end;
        out.push({ unit_id: u.unit_id, scene_order: i, start_ms: start, end_ms: end,
            estimated_duration_sec: parseFloat((realDurationSec * proportion).toFixed(3)),
            text_proportion: parseFloat(proportion.toFixed(6)), scene_duration_sec: realDurationSec, mode: 'proportional' });
    });
    return out;
}

/** Upsert the timings of one scene (inside the caller's transaction). @returns rows written */
async function writeUnitTimings(db, { buildId, bookId, chapterId, sceneId, sceneAudioFile }, rows, units) {
    if (!rows.length) return 0;
    const textOf = new Map((units || []).map((u) => [u.unit_id, u]));
    let n = 0;
    for (const r of rows) {
        const u = textOf.get(r.unit_id) || {};
        const res = await db.query(
            `INSERT INTO image_units (build_id, book_id, chapter_id, scene_id, unit_id, scene_order, text, text_length,
                                      text_proportion, scene_duration_sec, estimated_duration_sec, scene_audio_file, start_ms, end_ms)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             ON CONFLICT (build_id, book_id, chapter_id, scene_id, unit_id) DO UPDATE SET
                 scene_order = EXCLUDED.scene_order,
                 text_proportion = EXCLUDED.text_proportion,
                 scene_duration_sec = EXCLUDED.scene_duration_sec,
                 estimated_duration_sec = EXCLUDED.estimated_duration_sec,
                 scene_audio_file = COALESCE(EXCLUDED.scene_audio_file, image_units.scene_audio_file),
                 start_ms = EXCLUDED.start_ms,
                 end_ms = EXCLUDED.end_ms`,
            [buildId, bookId, chapterId, sceneId, r.unit_id, r.scene_order, u.text || null, textLen(u),
                r.text_proportion, r.scene_duration_sec, r.estimated_duration_sec, sceneAudioFile || null, r.start_ms, r.end_ms]);
        n += res.rowCount;
    }
    return n;
}

module.exports = { realUnitDurations, computeUnitTimings, writeUnitTimings };
