// ======================================================
// orchestration-v2/video-ports — host ports of the gen core for VIDEO (ADR §5, §6.5, §13 п.11; этап 3)
// ======================================================
// Every port CALLS existing category-B code; no workflow / naming / merge logic
// is copied here:
//   planUnits   ← vbook-runtime collectScenes / collectSceneUnits (the legacy video
//                 unit order) + workflows/video/video-workflows.buildGroupWorkflows (the
//                 legacy DP composition, totalFrames, LTXVAddGuide frame_idx, prompt time
//                 codes — fed with REAL durations, iu-timings.realUnitDurations) +
//                 image-ports (the current image workflow hash of every IU)
//   buildPayload← the workflow snapshot taken by planUnits (input.workflow_json)
//   inputFiles  ← the IU frames of the group (input.inputs): canonical IU PNG + sha256
//                 of the accepted part (scene_assets image gen_parts) — served by
//                 GET /internal/gen/jobs/:id/input/:name, no base64 (ADR §8.1)
//   artifactPath← @animastor/generation artifactNaming: group {prefix}_gN.mp4 (N = the
//                 group's place in the plan — the names the player timeline, the export
//                 and the cleanup read), scene {prefix}.mp4 (player + export)
//   runLocal    ← video/video-merge (trimVideoToFrames, concatVideos,
//                 forceKeyframesAtUnitBoundaries with durationsOverride, encodePlaybackProfile):
//                 the legacy scene merge, without its Redis lock and without the
//                 image_units estimate lookup. NO audio is muxed (sound joins the picture
//                 only in /book/:id/export → muxVideoAudio; the player syncs by itself).
//   onArtifactPlaced ← keeps scene_assets(video).metadata.gen_parts truthful when a group
//                 file name is reused by another plan; after the merge drops group files /
//                 entries the current plan does not have.
//
// Readiness of a scene for video (§6.5, §13 п.11 пп.3–4), decided on the CALLER's
// transaction (ctx.db: command tx or acceptance tx):
//   audio   — scene_assets audio of the build `ready`, file present, no placeholder
//             marker; audio_chunk / audio_merge of the scene in work → wait; otherwise
//             skipped_needs_audio. The layer switch of audio does not matter.
//   images  — an IU is clean when gen_parts[iu].part_hash == the current image workflow
//             hash (image-ports); dirty → skipped_image_dirty; no gen_parts entry (also
//             legacy pictures, build NULL) → skipped_needs_image; iu_image in work → wait.
//   timings — real end_ms − start_ms of image_units; a unit of zero duration is not in
//             the video (no frame, no guide); no timing → skipped_needs_audio.
// Hashes:
//   group  part_hash = 'vg-v2:' + sha256({frames: ordered sha256 of the IU frames,
//                      workflow: the video workflow snapshot, durations_ms})
//   scene  scene_hash = 'video-v2:' + sha256({groups: [{unit_key, part_hash}], durations_ms})
//          — the video_merge hash: new audio (durations) or new frames → the video is
//          stale; it is redone only by a user command (mode missing), never by itself.
// unit_key of a group = 'g-' + its IU ids joined by '+' (stable across re-parsing).

'use strict';

/** units of a scene payload: the injected facade's collectSceneUnits, else vbook-runtime's (same function) */
function collectUnits(book) {
    return typeof book.collectSceneUnits === 'function' ? book.collectSceneUnits : require('@animastor/vbook-runtime').collectSceneUnits;
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { inScope } = require('./audio-ports');

const SAFE_UNIT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const det = (msg) => Object.assign(new Error(msg), { error_class: 'deterministic' });

function deps(overrides = {}) {
    return {
        book: overrides.book || (() => { throw new Error('video-ports: deps.book (loadBook/collectScenes/collectSceneUnits) is required'); })(),
        imagePorts: overrides.imagePorts || (() => { throw new Error('video-ports: deps.imagePorts is required'); })(),
        videoWorkflows: overrides.videoWorkflows || require('../workflows/video/video-workflows'),
        listWorkflows: overrides.listWorkflows || (() => require('@animastor/generation').comfyuiProvider.listWorkflows()),
        videoMerge: overrides.videoMerge || require('../video/video-merge'),
        helpers: overrides.helpers || require('../image/helpers'),
        marker: overrides.marker || require('../audio/placeholder-marker'),
        iuTimings: overrides.iuTimings || require('./iu-timings'),
        artifactNaming: overrides.artifactNaming || require('@animastor/generation').artifactNaming,
        fps: overrides.fps || parseInt(process.env.VIDEO_FPS || '24', 10),
        query: overrides.query || null,                 // fallback db when the core passes no ctx.db
    };
}

function createVideoPorts(opts = {}) {
    const d = deps(opts.deps);
    const log = opts.log || ((m) => console.log(m));
    const dbOf = (ctx) => {
        if (ctx && ctx.db && typeof ctx.db.query === 'function') return ctx.db;
        if (d.query) return { query: d.query };
        // core >= 1.3.0 always passes the transaction; without it the readiness would be read
        // outside the deciding transaction — refuse instead of guessing
        throw det('video planner needs ctx.db (@animastor/orchestration >= 1.3.0)');
    };

    /** units of the scene in the legacy video order (collectSceneUnits: units with an id) */
    function videoUnits(sceneData) {
        return (collectUnits(d.book)(sceneData.payload || sceneData.scene) || [])
            .filter((u) => u && u.id != null && SAFE_UNIT_ID.test(String(u.id)));
    }

    /**
     * Decide one scene: {groups:[unit…]} | {wait:true} | {skip:'skipped_*'}.
     * Read-only on db (the caller's transaction).
     */
    async function planScene(db, bookId, loadedBook, sceneData, buildId) {
        const ch = sceneData.chapter_id;
        const sc = sceneData.scene_id;
        const units = videoUnits(sceneData);
        if (!units.length) return { skip: 'skipped_needs_image', why: 'no units' };

        const live = (await db.query(
            `SELECT kind, unit_key, input->>'scene_hash' AS scene_hash FROM gen_jobs
             WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3 AND status IN ('queued','running')`,
            [bookId, ch, sc])).rows;
        const audioLive = live.some((j) => j.kind === 'audio_chunk' || j.kind === 'audio_merge');
        const liveIU = new Set(live.filter((j) => j.kind === 'iu_image').map((j) => j.unit_key));

        const assets = (await db.query(
            `SELECT asset_type, status, path, metadata FROM scene_assets
             WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3 AND build_id = $4 AND asset_type IN ('audio','image')`,
            [bookId, ch, sc, buildId])).rows;
        const audio = assets.find((a) => a.asset_type === 'audio');
        const image = assets.find((a) => a.asset_type === 'image');
        const parts = image && image.metadata && typeof image.metadata.gen_parts === 'object' && image.metadata.gen_parts ? image.metadata.gen_parts : {};
        const audioReady = !!(audio && audio.status === 'ready' && audio.path && fs.existsSync(audio.path)
            && !d.marker.isPlaceholderAudioFile(audio.path));

        // which IUs the video needs: those with own audio; while audio is in work — all of them
        let needed = units;
        let durations = null;
        if (!audioLive && audioReady) {
            const rows = (await db.query(
                `SELECT unit_id, start_ms, end_ms FROM image_units
                 WHERE build_id = $1 AND book_id = $2 AND chapter_id = $3 AND scene_id = $4`, [buildId, bookId, ch, sc])).rows;
            const real = d.iuTimings.realUnitDurations(units, rows);
            if (!real.ok) return { skip: 'skipped_needs_audio', why: `no timing for ${real.unit_id}` };
            durations = real.durations;
            const used = new Set(durations.filter((x) => x.ms > 0).map((x) => x.unit_id));
            needed = units.filter((u) => used.has(String(u.id)));
            if (!needed.length) return { skip: 'skipped_needs_audio', why: 'no unit has audio duration' };
        }

        // images: clean / dirty / missing / in work (current workflow hash from image-ports)
        const current = new Map(d.imagePorts._sceneUnits(loadedBook, sceneData, buildId).map((u) => [u.unit_key, u.input.part_hash]));
        let missing = 0; let dirty = 0; let inWork = 0;
        for (const u of needed) {
            const id = String(u.id);
            if (liveIU.has(id)) { inWork += 1; continue; }
            const p = parts[id];
            if (!p || !p.sha256 || !p.path) { missing += 1; continue; }
            if (!current.has(id) || p.part_hash !== current.get(id)) dirty += 1;
        }
        // reasons in the order of resources: audio → images → video (§13 п.11)
        if (!audioLive && !audioReady) return { skip: 'skipped_needs_audio', why: audio ? `audio ${audio.status}` : 'no audio' };
        if (missing) return { skip: 'skipped_needs_image', why: `${missing} IU without a v2 picture` };
        if (dirty) return { skip: 'skipped_image_dirty', why: `${dirty} IU changed after its picture` };
        if (audioLive || inWork) return { wait: true, why: `${audioLive ? 'audio' : ''}${audioLive && inWork ? ' + ' : ''}${inWork ? `${inWork} IU` : ''} in work` };

        // groups over the real durations of the units that have any
        const ms = new Map(durations.map((x) => [x.unit_id, x.ms]));
        const secs = needed.map((u) => ms.get(String(u.id)) / 1000);
        const built = d.videoWorkflows.buildGroupWorkflows(sceneData, loadedBook, buildId, d.listWorkflows(), needed, secs);
        if (!built.success) throw det(`video workflow for ${ch}/${sc}: ${built.reason}`);
        const groups = built.workflows.map((g, i) => {
            const ids = g.units.map((u) => String(u.id));
            const durationsMs = ids.map((id) => ms.get(id));
            const workflowJson = JSON.stringify(g.workflow);
            const frames = ids.map((id) => parts[id].sha256);
            const frameCounts = d.videoWorkflows.calculateFrames(g.durations).frameCounts;
            return {
                unit_key: 'g-' + ids.join('+'), ids, index: i + 1, workflowJson, workflowName: g.workflowName, durationsMs, frameCounts,
                part_hash: 'vg-v2:' + sha(JSON.stringify({ frames, workflow: workflowJson, durations_ms: durationsMs })).slice(0, 32),
                inputs: ids.map((id) => ({ name: d.artifactNaming.sceneImageName(bookId, ch, sc, id), path: parts[id].path, sha256: parts[id].sha256, bytes: parts[id].bytes })),
            };
        });
        const mergeParts = groups.map((g) => ({ unit_key: g.unit_key, part_hash: g.part_hash }));
        const sceneHash = 'video-v2:' + sha(JSON.stringify({ groups: mergeParts, durations_ms: needed.map((u) => ms.get(String(u.id))) })).slice(0, 32);
        // a different plan of this scene still rendering would write the same _gN names
        const foreign = live.find((j) => j.kind === 'video_group' && j.scene_hash !== sceneHash);
        if (foreign) return { skip: 'skipped_video_in_work', why: 'video of an older plan is rendering' };
        return {
            groups: groups.map((g) => ({
                chapter_id: ch, scene_id: sc, kind: 'video_group', unit_key: g.unit_key, build_id: buildId, scene_hash: sceneHash,
                input: {
                    workflow_json: g.workflowJson,
                    workflow_name: g.workflowName,
                    part_hash: g.part_hash,
                    merge_parts: mergeParts,
                    inputs: g.inputs,
                    part_meta: {
                        group_index: g.index, group_count: groups.length, unit_ids: g.ids,
                        durations_ms: g.durationsMs, frame_counts: g.frameCounts,
                    },
                },
            })),
        };
    }

    async function planUnits(bookRef, scope, layer, ctx) {
        if (layer !== 'video') return [];
        const db = dbOf(ctx);
        const loadedBook = d.book.loadBook(bookRef.bookId);
        if (!loadedBook) throw Object.assign(new Error(`book ${bookRef.bookId} not found`), { status: 404 });
        const buildId = loadedBook.manifest?.build_id || 'default';
        const out = { units: [], waits: [], skipped: [] };
        const notes = [];
        for (const s of d.book.collectScenes(loadedBook)) {
            if (!s.chapter_id || !s.scene_id || !inScope(scope, s)) continue;
            const r = await planScene(db, bookRef.bookId, loadedBook, s, buildId);
            const at = { chapter_id: s.chapter_id, scene_id: s.scene_id };
            if (r.groups) { out.units.push(...r.groups); notes.push(`${s.scene_id}: ${r.groups.length} group(s)`); }
            else if (r.wait) { out.waits.push(at); notes.push(`${s.scene_id}: wait (${r.why})`); }
            else { out.skipped.push({ ...at, reason: r.skip }); notes.push(`${s.scene_id}: ${r.skip} (${r.why})`); }
        }
        log(`[ORCH-V2] planUnits video ${bookRef.bookId} scope=${scope.level}${scope.scene_id ? '/' + scope.scene_id : ''}: ${out.units.length} group(s), ${out.waits.length} waiting, ${out.skipped.length} skipped${notes.length && notes.length <= 20 ? ' — ' + notes.join('; ') : ''}`);
        return out;
    }

    async function buildPayload(job) {
        if (job.kind !== 'video_group' || !job.input || typeof job.input.workflow_json !== 'string') throw det('video job without workflow snapshot');
        return JSON.parse(job.input.workflow_json);
    }

    function inputFiles(job) {
        if (job.kind !== 'video_group') return [];
        return Array.isArray(job.input && job.input.inputs) ? job.input.inputs : [];
    }

    function groupIndex(job) {
        const n = job.input && job.input.part_meta && job.input.part_meta.group_index;
        if (!Number.isInteger(n) || n < 1 || n > 999) throw det(`video_group ${job.unit_key} without group_index`);
        return n;
    }

    function artifactPath(job) {
        const n = d.artifactNaming;
        if (job.kind === 'video_group') {
            return d.helpers.getOutputPath(job.build_id, n.sceneVideoGroupName(job.book_id, job.chapter_id, job.scene_id, `_g${groupIndex(job)}`));
        }
        if (job.kind === 'video_merge') return d.helpers.getOutputPath(job.build_id, n.sceneVideoName(job.book_id, job.chapter_id, job.scene_id));
        throw det(`video-ports: kind ${job.kind}`);
    }

    /** video_merge: the legacy scene merge over private copies of the accepted groups (no audio). */
    async function runLocal(job) {
        if (job.kind !== 'video_merge') throw det(`video-ports.runLocal: kind ${job.kind}`);
        const parts = [...(job.input.parts || [])].sort((a, b) => ((a.meta && a.meta.group_index) || 0) - ((b.meta && b.meta.group_index) || 0));
        if (!parts.length) throw det('video_merge without parts');
        const vm = d.videoMerge;
        const finalPath = artifactPath(job);
        const incoming = path.join(path.dirname(finalPath), '.incoming');
        const work = path.join(incoming, `merge-${job.job_id}.${job.attempt}`);
        fs.mkdirSync(work, { recursive: true });
        try {
            const copies = [];
            const durationsSec = [];
            const targets = [];
            for (const p of parts) {
                if (!p.path || !fs.existsSync(p.path)) throw det(`group ${p.unit_key} missing on disk`);
                const copy = path.join(work, `${String((p.meta && p.meta.group_index) || copies.length + 1).padStart(3, '0')}.mp4`);
                fs.copyFileSync(p.path, copy);
                const got = sha(fs.readFileSync(copy));
                if (p.sha256 && got !== p.sha256) throw det(`group ${p.unit_key}: file changed after acceptance (another plan wrote ${path.basename(p.path)})`);
                const meta = p.meta || {};
                const fc = Array.isArray(meta.frame_counts) ? meta.frame_counts : [];
                targets.push(fc.reduce((s, x) => s + x, 0));
                for (const f of fc) durationsSec.push(f / d.fps);   // the video timeline the guides were placed on
                copies.push(copy);
            }
            const profile = vm.resolveVideoProfileMeta();
            const out = path.join(incoming, `${job.job_id}.${job.attempt}.merge.mp4`);
            const keyframes = !profile || profile.requiresKeyframeForcing !== false;
            const aligned = [];
            for (let i = 0; i < copies.length; i++) {
                aligned.push(profile && profile.requiresTrim === false ? copies[i] : await vm.trimVideoToFrames(copies[i], targets[i]));
            }
            // concat (one group: a plain copy) → unit-boundary keyframes, which re-encode into the
            // playback profile; without boundaries (one unit) or when forcing fails → the playback
            // profile as the legacy single-group branch (bitrate cap + faststart)
            const merged = await vm.concatVideos(aligned, out);
            if (!merged) throw Object.assign(new Error('concat produced no output'), { error_class: 'transient' });
            let encoded = false;
            if (keyframes && durationsSec.length > 1) {
                encoded = await vm.forceKeyframesAtUnitBoundaries(out, job.build_id, job.book_id, job.chapter_id, job.scene_id, durationsSec, null);
                if (!encoded) log(`[ORCH-V2] video_merge ${job.scene_id}: unit-boundary keyframes not forced — seek may land one unit early`);
            }
            if (!encoded) {
                const tmp = `${out}.single.mp4`;
                try { await vm.encodePlaybackProfile(out, tmp); fs.renameSync(tmp, out); } catch (err) {
                    try { fs.unlinkSync(tmp); } catch (_) { /* absent */ }
                    log(`[ORCH-V2] video_merge ${job.scene_id}: playback encode failed (${err.message}) — faststart remux`);
                    await vm.faststartRemux(out, tmp); fs.renameSync(tmp, out);
                }
            }
            if (!fs.existsSync(out)) throw Object.assign(new Error('video merge produced no output'), { error_class: 'transient' });
            return { path: out, meta: { groups: parts.length, units: durationsSec.length } };
        } finally {
            try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) { /* best effort */ }
        }
    }

    /**
     * Inside the acceptance tx (ctx.db):
     *  video_group — the file {prefix}_gN.mp4 now holds THIS group: any other gen_parts entry
     *                pointing at the same path (a group of another plan) is dropped, so a
     *                part_hash match always means «this very file».
     *  video_merge — the scene video is this plan: gen_parts keeps only the plan's groups,
     *                group files {prefix}_gN.mp4 beyond the plan (older plans, legacy) are
     *                removed — the export and the player timeline read every _gN of the scene.
     */
    async function onArtifactPlaced(job, finalPath, ctx = {}) {
        if (job.kind !== 'video_group' && job.kind !== 'video_merge') return;
        const db = ctx && ctx.db;
        if (job.kind === 'video_group') {
            if (!db) return;
            await db.query(
                `UPDATE scene_assets SET metadata = jsonb_set(metadata, '{gen_parts}',
                        COALESCE((SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(metadata->'gen_parts') AS e
                                  WHERE e.value->>'path' IS DISTINCT FROM $6 OR e.key = $7), '{}'::jsonb))
                 WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3 AND asset_type = 'video' AND build_id = $4
                   AND jsonb_typeof(metadata->'gen_parts') = 'object'
                   AND EXISTS (SELECT 1 FROM jsonb_each(metadata->'gen_parts') AS x WHERE x.value->>'path' = $6 AND x.key <> $7)
                   AND $5::text IS NOT NULL`,
                [job.book_id, job.chapter_id, job.scene_id, job.build_id, job.job_id, finalPath, job.unit_key]);
            return;
        }
        const keep = (job.input.merge_parts || job.input.parts || []).map((p) => p.unit_key);
        const count = keep.length;
        if (db && count) {
            await db.query(
                `UPDATE scene_assets SET metadata = jsonb_set(metadata, '{gen_parts}',
                        COALESCE((SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(metadata->'gen_parts') AS e
                                  WHERE e.key = ANY($5::text[])), '{}'::jsonb))
                 WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3 AND asset_type = 'video' AND build_id = $4
                   AND jsonb_typeof(metadata->'gen_parts') = 'object'`,
                [job.book_id, job.chapter_id, job.scene_id, job.build_id, keep]);
        }
        const dir = path.dirname(finalPath);
        const prefix = d.artifactNaming.scenePrefix(job.book_id, job.chapter_id, job.scene_id);
        const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_g(\\d+)\\.mp4$`);
        let names = [];
        try { names = fs.readdirSync(dir); } catch (_) { return; }
        const removed = [];
        for (const f of names) {
            const m = f.match(re);
            if (!m || Number(m[1]) <= count) continue;
            try { fs.unlinkSync(path.join(dir, f)); removed.push(f); } catch (_) { /* gone */ }
        }
        if (removed.length) log(`[ORCH-V2] video ${job.chapter_id}/${job.scene_id}: group files beyond the plan (${count}) removed: ${removed.join(', ')}`);
    }

    return { planUnits, buildPayload, inputFiles, artifactPath, runLocal, onArtifactPlaced, _planScene: planScene };
}

module.exports = { createVideoPorts };
