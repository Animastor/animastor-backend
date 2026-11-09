// ======================================================
// orchestration-v2/audio-ports — host ports of the gen core for AUDIO (ADR §5)
// ======================================================
// Every port CALLS existing category-B code; no workflow / naming / merge
// logic is copied here:
//   planUnits     ← vbook-runtime collectScenes + audio/segments.buildSegments
//                   + audio/generation.buildMergedDialogueWorkflow / buildSegmentWorkflow
//   buildPayload  ← the workflow snapshot taken by planUnits (input.workflow_json)
//   artifactPath  ← @animastor/generation artifactNaming + audio/helpers.getOutputPath
//   runLocal      ← audio/generation.trimPaddedSceneAudio + audio/pipeline.buildSceneAudio;
//                   1.3.0: measures every chunk before the merge (audio/ffmpeg.probeDuration,
//                   the last one also after the tail-only trim — as trackChunkDurations) and
//                   returns the records as meta
//   onArtifactPlaced ← audio/placeholder-marker.clearPlaceholderMarker; 1.3.0 (ADR §13 п.11 п.7):
//                   audio_merge recalculates the IU timings of the scene IN the acceptance
//                   transaction (orchestration-v2/iu-timings — the legacy IU-RECALC formulas)
// The unit grammar mirrors the legacy path exactly: a pure-dialogue scene is
// ONE merged chunk (0001); otherwise one chunk per segment, NNNN = segment
// order (1-based, padded to 4).

'use strict';

/** units of a scene payload: the injected facade's collectSceneUnits, else vbook-runtime's (same function) */
function collectUnits(book) {
    return typeof book.collectSceneUnits === 'function' ? book.collectSceneUnits : require('@animastor/vbook-runtime').collectSceneUnits;
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function deps(overrides = {}) {
    return {
        // the book facade is INJECTED by the composition root (Phase 7 raw-book consumer guard)
        book: overrides.book || (() => { throw new Error('audio-ports: deps.book (loadBook/collectScenes) is required'); })(),
        segments: overrides.segments || require('../audio/segments'),
        generation: overrides.generation || require('../audio/generation'),
        pipeline: overrides.pipeline || require('../audio/pipeline'),
        helpers: overrides.helpers || require('../audio/helpers'),
        marker: overrides.marker || require('../audio/placeholder-marker'),
        ffmpeg: overrides.ffmpeg || require('../audio/ffmpeg'),
        // duration of the merged scene file — music-metadata, as the legacy IU-RECALC
        probeMerged: overrides.probeMerged || (async (p) => {
            try { return Number((await require('music-metadata').parseFile(p)).format.duration) || 0; } catch (_) { return 0; }
        }),
        iuTimings: overrides.iuTimings || require('./iu-timings'),
        tailOnly: overrides.tailOnly !== undefined ? overrides.tailOnly : !!process.env.AUDIO_CLEANUP_TAIL_ONLY,
        artifactNaming: overrides.artifactNaming || require('@animastor/generation').artifactNaming,
    };
}

/** gen scope → does a runtime scene entry fall inside it? */
function inScope(scope, s) {
    if (!scope || scope.level === 'book') return true;
    if (scope.level === 'chapter') return s.chapter_id === scope.chapter_id;
    if (scope.level === 'scenes') return Array.isArray(scope.scene_ids) && scope.scene_ids.includes(s.scene_id);
    return s.scene_id === scope.scene_id && (!scope.chapter_id || s.chapter_id === scope.chapter_id);
}

function createAudioPorts(opts = {}) {
    const d = deps(opts.deps);
    const log = opts.log || ((m) => console.log(m));

    /** The units of one scene, exactly as the legacy dispatch would send them. */
    function sceneUnits(loadedBook, sceneData, bookId, buildId) {
        const chapterId = sceneData.chapter_id;
        const sceneId = sceneData.scene_id;
        const segList = d.segments.buildSegments(sceneData);
        if (!segList.length) return [];
        const ctx = { bookId, chapterId, sceneId };
        const units = [];
        const isPureDialogue = segList.every((seg) => seg.segment_type === 'dialogue');
        const merged = isPureDialogue ? d.generation.buildMergedDialogueWorkflow(segList, loadedBook) : null;
        if (merged) {
            units.push({ index: 1, workflow: merged, workflow_name: 'merged_dialogue',
                meta: { segment_type: 'dialogue', padded: false, original_text_length: null, unit_id: null } });
        } else {
            segList.forEach((segment, i) => {
                units.push({
                    index: i + 1,
                    workflow: d.generation.buildSegmentWorkflow(segment, sceneData, loadedBook, ctx),
                    workflow_name: segment.segment_type === 'dialogue' ? d.generation.WORKFLOW_DIALOGUE : d.generation.WORKFLOW_NARRATION,
                    meta: {
                        segment_type: segment.segment_type,
                        padded: segment.padded === true,
                        original_text_length: segment.original_text_length ?? null,
                        unit_id: segment.unit_id || null,
                    },
                });
            });
        }
        // «ready for the current content» = the exact audio inputs (texts + voices +
        // workflow template) — any change re-renders the scene (ADR §6.1 п.3)
        // the snapshot is kept as a JSON STRING: JSONB would reorder the keys —
        // the worker must receive byte-for-byte the legacy payload
        for (const u of units) u.workflow_json = JSON.stringify(u.workflow);
        const sceneHash = 'audio-v2:' + crypto.createHash('sha256')
            .update(units.map((u) => u.workflow_json).join('\n')).digest('hex').slice(0, 32);
        const expected = units.length;
        return units.map((u) => ({
            chapter_id: chapterId,
            scene_id: sceneId,
            kind: 'audio_chunk',
            unit_key: String(u.index).padStart(4, '0'),
            build_id: buildId,
            scene_hash: sceneHash,
            input: {
                workflow_json: u.workflow_json,
                workflow_name: u.workflow_name,
                scene_type: sceneData.scene_type,
                part_meta: { ...u.meta, chunk_index: u.index, expected_chunk_count: expected },
            },
        }));
    }

    async function planUnits(bookRef, scope, layer) {
        if (layer !== 'audio') return [];
        const loadedBook = d.book.loadBook(bookRef.bookId);
        if (!loadedBook) throw Object.assign(new Error(`book ${bookRef.bookId} not found`), { status: 404 });
        const buildId = loadedBook.manifest?.build_id || 'default';
        const out = [];
        for (const s of d.book.collectScenes(loadedBook)) {
            if (!s.chapter_id || !s.scene_id || !inScope(scope, s)) continue;
            out.push(...sceneUnits(loadedBook, s, bookRef.bookId, buildId));
        }
        log(`[ORCH-V2] planUnits ${bookRef.bookId} scope=${scope.level}${scope.level === 'scenes' ? `[${scope.scene_ids.length}]` : ''}${scope.chapter_id ? '/' + scope.chapter_id : ''}${scope.scene_id ? '/' + scope.scene_id : ''}: ${out.length} audio chunk(s)`);
        return out;
    }

    async function buildPayload(job) {
        if (!job.input || typeof job.input.workflow_json !== 'string') throw Object.assign(new Error('audio job without workflow snapshot'), { error_class: 'deterministic' });
        return JSON.parse(job.input.workflow_json);
    }

    function artifactPath(job) {
        const n = d.artifactNaming;
        if (job.kind === 'audio_chunk') {
            return d.helpers.getOutputPath(job.build_id, n.sceneChunkAudioName(job.book_id, job.chapter_id, job.scene_id, Number(job.unit_key)));
        }
        if (job.kind === 'audio_merge') {
            return d.helpers.getOutputPath(job.build_id, n.sceneAudioName(job.book_id, job.chapter_id, job.scene_id));
        }
        throw Object.assign(new Error(`orchestration v2: kind ${job.kind} not supported yet`), { error_class: 'deterministic' });
    }

    /** audio_merge: the legacy merge on private copies of the accepted chunks. */
    async function runLocal(job) {
        if (job.kind !== 'audio_merge') {
            throw Object.assign(new Error(`runLocal: kind ${job.kind} not supported`), { error_class: 'deterministic' });
        }
        const parts = [...(job.input.parts || [])].sort((a, b) => a.unit_key.localeCompare(b.unit_key));
        if (!parts.length) throw Object.assign(new Error('audio_merge without parts'), { error_class: 'deterministic' });
        const finalPath = artifactPath(job);
        const incoming = path.join(path.dirname(finalPath), '.incoming');
        const work = path.join(incoming, `merge-${job.job_id}.${job.attempt}`);
        fs.mkdirSync(work, { recursive: true });
        try {
            const copies = [];
            for (const p of parts) {
                if (!p.path || !fs.existsSync(p.path)) throw Object.assign(new Error(`chunk ${p.unit_key} missing on disk`), { error_class: 'deterministic' });
                const copy = path.join(work, `${p.unit_key}.mp3`);
                fs.copyFileSync(p.path, copy);
                // padded short text: the legacy result path trims the duplicate before the merge
                if (p.meta && p.meta.padded) await d.generation.trimPaddedSceneAudio(copy, p.meta.original_text_length);
                copies.push(copy);
            }
            // 1.3.0: real chunk durations bound to their unit (the input of the IU timings,
            // same measurement as the legacy trackChunkDurations: raw, + tail-only of the last)
            const records = [];
            for (let i = 0; i < copies.length; i++) {
                const raw = await d.ffmpeg.probeDuration(copies[i]);
                let tail = raw;
                if (d.tailOnly && i === copies.length - 1) {
                    const tmp = copies[i].replace(/\.mp3$/, '.tailonly.mp3');
                    try { await d.ffmpeg.runFFmpegTrim(copies[i], tmp, 0, null, true); tail = await d.ffmpeg.probeDuration(tmp); } catch (_) { tail = raw; }
                    finally { try { fs.unlinkSync(tmp); } catch (_) { /* absent */ } }
                }
                const meta = parts[i].meta || {};
                records.push({ chunk_index: i + 1, unit_id: meta.unit_id || null, raw_duration_sec: Number(raw) || 0, tail_duration_sec: Number(tail) || 0 });
            }
            const out = path.join(incoming, `${job.job_id}.${job.attempt}.merge.mp3`);
            const built = await d.pipeline.buildSceneAudio(copies, out, job.build_id, true);
            if (!built || !fs.existsSync(out)) throw Object.assign(new Error('audio merge produced no output'), { error_class: 'transient' });
            return { path: out, meta: { chunk_records: records, tail_only: !!d.tailOnly } };
        } finally {
            try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) { /* best effort */ }
        }
    }

    /**
     * Inside the acceptance tx after the rename: the scene file is real audio now.
     * 1.3.0 (ADR §13 п.11 п.7): the IU timings of the scene follow this audio — in the SAME
     * transaction (ctx.db), so a video stage planned right after sees them, and a rolled
     * back acceptance leaves the old ones.
     */
    async function onArtifactPlaced(job, finalPath, ctx = {}) {
        if (job.kind !== 'audio_merge') return;
        if (d.marker.clearPlaceholderMarker(finalPath)) log(`[ORCH-V2] placeholder marker cleared: ${path.basename(finalPath)}`);
        if (!ctx || !ctx.db) { log(`[ORCH-V2] IU timings of ${job.chapter_id}/${job.scene_id} not recalculated (core without acceptance db)`); return; }
        const loadedBook = d.book.loadBook(job.book_id);
        const sceneData = loadedBook && d.book.collectScenes(loadedBook).find((s) => s.chapter_id === job.chapter_id && s.scene_id === job.scene_id);
        if (!sceneData) { log(`[ORCH-V2] IU timings: scene ${job.chapter_id}/${job.scene_id} not in the book — skipped`); return; }
        const units = collectUnits(d.book)(sceneData.payload || sceneData.scene)
            .map((u) => ({ unit_id: String(u.id), text: u.text || '', text_length: (u.text || '').length }));
        if (!units.length) return;
        const realSec = Number(await d.probeMerged(finalPath)) || 0;
        let records = ctx.meta && Array.isArray(ctx.meta.chunk_records) ? ctx.meta.chunk_records : null;
        // a chunk that could not be measured (0 s) would zero its unit → no per-unit data at all
        if (records && records.some((r) => !(r.raw_duration_sec > 0))) records = null;
        const rows = d.iuTimings.computeUnitTimings(units, realSec, records);
        const n = await d.iuTimings.writeUnitTimings(ctx.db, {
            buildId: job.build_id, bookId: job.book_id, chapterId: job.chapter_id, sceneId: job.scene_id,
            sceneAudioFile: d.artifactNaming.sceneAudioName(job.book_id, job.chapter_id, job.scene_id),
        }, rows, units);
        log(`[ORCH-V2] IU timings ${job.chapter_id}/${job.scene_id}: ${n} unit(s), ${rows[0] ? rows[0].mode : '-'}, scene ${realSec.toFixed(3)}s — ${rows.map((r) => `${r.unit_id}=${r.end_ms - r.start_ms}ms`).join(', ')}`);
    }

    return { planUnits, buildPayload, artifactPath, runLocal, onArtifactPlaced, _sceneUnits: sceneUnits };
}

module.exports = { createAudioPorts, inScope };
