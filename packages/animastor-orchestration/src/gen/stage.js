// ======================================================
// gen/stage — helpers shared by command creation and stage transitions
// (1.3.0: video, ADR §6.3, §6.5, §13 п.11)
// ======================================================
// Everything here runs on the caller's transaction client (command tx or
// acceptance tx) and never UPDATEs gen_commands (acceptance holds those rows
// FOR SHARE).

'use strict';

const { GenError, LAYER_OF_KIND, LIVE } = require('./util');

/** part kind → its merge kind (a part kind with input.merge_parts ends in this local job) */
const MERGE_OF_PART = Object.freeze({ video_group: 'video_merge', audio_chunk: 'audio_merge' });
/** kinds a waiting video command joins in its scene (images + audio, §6.5, §13 п.11 п.3) */
const VIDEO_WAIT_KINDS = Object.freeze(['iu_image', 'audio_chunk', 'audio_merge']);
const SKIP_REASON_RE = /^skipped_[a-z_]{1,48}$/;

/** input.merge_parts → [{unit_key, part_hash}] (non-empty, string fields) or null. */
function mergePartsOf(input) {
    const v = input && input.merge_parts;
    if (!Array.isArray(v) || v.length === 0) return null;
    const out = [];
    for (const p of v) {
        if (!p || typeof p.unit_key !== 'string' || !p.unit_key || typeof p.part_hash !== 'string' || !p.part_hash) return null;
        out.push({ unit_key: p.unit_key, part_hash: p.part_hash });
    }
    return out;
}

/**
 * planUnits result → {units, waits, skipped}. A plain array (every layer before
 * 1.3.0, audio / image now) is {units: array}. Video may return the object form:
 *   units   — first-stage units (video_group)
 *   waits   — [{chapter_id, scene_id}] scenes waiting for live images / audio: the
 *             command joins those live jobs; the video stage follows their acceptance
 *   skipped — [{chapter_id, scene_id, reason: 'skipped_*'}]
 */
function normalisePlan(planned, layer) {
    if (Array.isArray(planned)) return { units: planned, waits: [], skipped: [] };
    if (!planned || typeof planned !== 'object' || !Array.isArray(planned.units)) {
        throw new GenError('bad_plan', 500, `planUnits(${layer}) must return an array or {units, waits?, skipped?}`);
    }
    const scene = (x) => x && typeof x.chapter_id === 'string' && x.chapter_id && typeof x.scene_id === 'string' && x.scene_id;
    const waits = Array.isArray(planned.waits) ? planned.waits : [];
    const skipped = Array.isArray(planned.skipped) ? planned.skipped : [];
    if (!waits.every(scene)) throw new GenError('bad_plan', 500, `planUnits(${layer}): waits[] entries need chapter_id, scene_id`);
    if (!skipped.every((s) => scene(s) && typeof s.reason === 'string' && SKIP_REASON_RE.test(s.reason))) {
        throw new GenError('bad_plan', 500, `planUnits(${layer}): skipped[] entries need chapter_id, scene_id, reason skipped_*`);
    }
    return {
        units: planned.units,
        waits: waits.map((w) => ({ chapter_id: w.chapter_id, scene_id: w.scene_id })),
        skipped: skipped.map((s) => ({ chapter_id: s.chapter_id, scene_id: s.scene_id, reason: s.reason })),
    };
}

/**
 * Units whose part is already accepted for the current content: the scene asset
 * of the same build records gen_parts[unit_key].part_hash = input.part_hash
 * (row pending / ready — a 'stale' row proves nothing). 1.1.0 rule, shared.
 * @returns {Promise<Set<object>>} subset of `units` (by identity)
 */
async function readyParts(client, bookId, units) {
    const parted = units.filter((u) => u.input && typeof u.input.part_hash === 'string' && u.input.part_hash);
    if (!parted.length) return new Set();
    const r = await client.query(
        `SELECT t.ord FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
                WITH ORDINALITY AS t(chapter_id, scene_id, asset_type, build_id, unit_key, part_hash, ord)
         WHERE EXISTS (SELECT 1 FROM scene_assets a
                       WHERE a.book_id = $1 AND a.chapter_id = t.chapter_id AND a.scene_id = t.scene_id
                         AND a.asset_type = t.asset_type AND a.build_id = t.build_id
                         AND a.status IN ('pending', 'ready')
                         AND jsonb_typeof(a.metadata->'gen_parts') = 'object'
                         AND a.metadata->'gen_parts'->t.unit_key->>'part_hash' = t.part_hash)`,
        [bookId, parted.map((u) => u.chapter_id), parted.map((u) => u.scene_id), parted.map((u) => LAYER_OF_KIND[u.kind]),
            parted.map((u) => u.build_id), parted.map((u) => u.unit_key), parted.map((u) => u.input.part_hash)]);
    return new Set(r.rows.map((row) => parted[Number(row.ord) - 1]));
}

/**
 * For every listed part: the latest DONE job of that unit_key with that part_hash
 * (same build). Returned in `parts` order; `missing` = parts without such a job.
 */
async function donePartsFor(client, { bookId, chapterId, sceneId, buildId, kind }, parts) {
    const r = await client.query(
        `SELECT DISTINCT ON (j.unit_key) j.unit_key, j.job_id, j.result_path, j.result_sha256,
                j.input->'part_meta' AS meta, j.input->>'part_hash' AS part_hash
         FROM gen_jobs j
         JOIN unnest($6::text[], $7::text[]) AS t(uk, ph) ON j.unit_key = t.uk AND j.input->>'part_hash' = t.ph
         WHERE j.book_id = $1 AND j.chapter_id = $2 AND j.scene_id = $3 AND j.kind = $4 AND j.build_id = $5
           AND j.status = 'done'
         ORDER BY j.unit_key, j.finished_at DESC`,
        [bookId, chapterId, sceneId, kind, buildId, parts.map((p) => p.unit_key), parts.map((p) => p.part_hash)]);
    const by = new Map(r.rows.map((x) => [x.unit_key, x]));
    const done = [];
    const missing = [];
    for (const p of parts) {
        const x = by.get(p.unit_key);
        if (!x) { missing.push(p); continue; }
        done.push({ unit_key: x.unit_key, job_id: x.job_id, path: x.result_path, sha256: x.result_sha256, part_hash: x.part_hash, meta: x.meta || null });
    }
    return { done, missing };
}

/** Is any job of these unit_keys of the scene live (queued / running)? */
async function anyLive(client, { bookId, chapterId, sceneId, kind }, unitKeys) {
    const r = await client.query(
        `SELECT 1 FROM gen_jobs WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3 AND kind = $4
           AND unit_key = ANY($5::text[]) AND status = ANY($6::text[]) LIMIT 1`,
        [bookId, chapterId, sceneId, kind, unitKeys, LIVE]);
    return r.rowCount > 0;
}

/**
 * The merge unit of a scene whose parts (input.merge_parts of its part units) are
 * all done: {kind: merge, unit_key: 'scene', input: {scene_hash, parts}} or null.
 */
async function mergeUnitFor(client, bookId, partUnit) {
    const parts = mergePartsOf(partUnit.input);
    const mergeKind = MERGE_OF_PART[partUnit.kind];
    if (!parts || !mergeKind) return null;
    const where = { bookId, chapterId: partUnit.chapter_id, sceneId: partUnit.scene_id, buildId: partUnit.build_id, kind: partUnit.kind };
    if (await anyLive(client, where, parts.map((p) => p.unit_key))) return null;
    const { done, missing } = await donePartsFor(client, where, parts);
    if (missing.length) return null;
    const sceneHash = partUnit.scene_hash ?? partUnit.input.scene_hash ?? null;
    return {
        chapter_id: partUnit.chapter_id, scene_id: partUnit.scene_id, kind: mergeKind, unit_key: 'scene',
        build_id: partUnit.build_id, scene_hash: sceneHash,
        input: { scene_hash: sceneHash, parts: done, merge_parts: parts },
    };
}

/** Link commands to every live job of `kinds` in the given scenes (a waiting command joins them). */
async function linkSceneLive(client, commandIds, bookId, scenes, kinds = VIDEO_WAIT_KINDS) {
    if (!commandIds.length || !scenes.length) return 0;
    const r = await client.query(
        `INSERT INTO gen_command_jobs (command_id, job_id)
         SELECT c, j.job_id
         FROM gen_jobs j
         JOIN unnest($2::text[], $3::text[]) AS s(ch, sc) ON j.chapter_id = s.ch AND j.scene_id = s.sc
         CROSS JOIN unnest($4::uuid[]) AS c
         WHERE j.book_id = $1 AND j.kind = ANY($5::text[]) AND j.status IN ('queued','running')
         ON CONFLICT DO NOTHING`,
        [bookId, scenes.map((s) => s.chapter_id), scenes.map((s) => s.scene_id), commandIds, kinds]);
    return r.rowCount;
}

/** Record skip reasons for commands (insert-only, idempotent). */
async function recordSkips(client, commandIds, skipped) {
    if (!commandIds.length || !skipped.length) return 0;
    const rows = [];
    for (const c of commandIds) for (const s of skipped) rows.push([c, s.chapter_id, s.scene_id, s.reason]);
    const r = await client.query(
        `INSERT INTO gen_command_skips (command_id, chapter_id, scene_id, reason)
         SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[])
         ON CONFLICT DO NOTHING`,
        [rows.map((x) => x[0]), rows.map((x) => x[1]), rows.map((x) => x[2]), rows.map((x) => x[3])]);
    return r.rowCount;
}

/** skipped[] → {skipped_x: [scene_id…]} for the command summary. */
function skipSummary(skipped) {
    const out = {};
    for (const s of skipped) {
        if (!out[s.reason]) out[s.reason] = [];
        if (!out[s.reason].includes(s.scene_id)) out[s.reason].push(s.scene_id);
    }
    return out;
}

module.exports = {
    MERGE_OF_PART,
    VIDEO_WAIT_KINDS,
    mergePartsOf,
    normalisePlan,
    readyParts,
    donePartsFor,
    anyLive,
    mergeUnitFor,
    linkSceneLive,
    recordSkips,
    skipSummary,
};
