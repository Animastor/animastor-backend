// ======================================================
// orchestration-v2/image-ports — host ports of the gen core for IMAGES (ADR §5, §12 этап 2a)
// ======================================================
// Every port CALLS existing category-B code; no prompt / workflow / naming
// logic is copied here:
//   planUnits     ← vbook-runtime collectScenes + image/registry.collectSceneUnits
//                   + image/iu-processor.buildIUWorkflow (the same function the
//                   legacy dispatch uses → byte-for-byte the same workflow)
//   buildPayload  ← the workflow snapshot taken by planUnits (input.workflow_json)
//   artifactPath  ← @animastor/generation artifactNaming.sceneImageName + getOutputPath
//                   ({OUTPUT_DIR}/{build}/{book}_{chapter}_{scene}_{unit_id}.png — the
//                   canonical IU file every reader serves, разведка §2.1)
//   onArtifactPlaced ← drops the derived preview {prefix}_pr{id}.png of the IU (the
//                   backend rebuilds it lazily on the next GET /preview, разведка §2.2);
//                   same invalidation as the legacy result publication
// Unit grammar (one job per image unit of the scene, legacy order units[] then
// dialogue_blocks[].units[]):
//   unit_key        = unit.id (iu-<hex> / legacy iu0001)
//   input.part_hash = 'iu-v2:' + sha256(workflow_json)  — prompt + negative + the whole
//                     template (seed, size, steps, LoRA): «готово для текущего контента»
//   scene_hash      = 'image-v2:' + sha256 of the scene's (unit_key:part_hash) list
//   input.scene_parts = that list — the core marks the scene image ready when all are in
// No side effects: planning writes nothing (legacy saveIUMetadata / iu-registry /
// in-flight markers are not used by v2; the storyboard self-heals image_units).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { inScope } = require('./audio-ports');

/** A unit id that is safe as a file-name component (no separators, no traversal). */
const SAFE_UNIT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function deps(overrides = {}) {
    return {
        book: overrides.book || (() => { throw new Error('image-ports: deps.book (loadBook/collectScenes) is required'); })(),
        iuProcessor: overrides.iuProcessor || require('../image/iu-processor'),
        registry: overrides.registry || require('../image/registry'),
        helpers: overrides.helpers || require('../image/helpers'),
        artifactNaming: overrides.artifactNaming || require('@animastor/generation').artifactNaming,
    };
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createImagePorts(opts = {}) {
    const d = deps(opts.deps);
    const log = opts.log || ((m) => console.log(m));

    /** The image units of one scene, exactly as the legacy dispatch would send them. */
    function sceneUnits(loadedBook, sceneData, buildId) {
        const chapterId = sceneData.chapter_id;
        const sceneId = sceneData.scene_id;
        const seen = new Set();
        const parts = [];
        for (const unit of d.registry.collectSceneUnits(sceneData.payload)) {
            const id = unit && unit.id != null ? String(unit.id) : '';
            if (!SAFE_UNIT_ID.test(id)) {
                log(`[ORCH-V2] image ${chapterId}/${sceneId}: unit id ${JSON.stringify(id)} skipped (not a safe file name)`);
                continue;
            }
            if (seen.has(id)) continue;                     // same id twice → one file, one job
            seen.add(id);
            // the snapshot is kept as a JSON STRING: JSONB would reorder the keys —
            // the worker must receive byte-for-byte the legacy payload
            const workflowJson = JSON.stringify(d.iuProcessor.buildIUWorkflow(unit, sceneData, loadedBook).workflow);
            parts.push({ unit_key: id, part_hash: 'iu-v2:' + sha(workflowJson).slice(0, 32), workflow_json: workflowJson });
        }
        if (!parts.length) return [];
        const sceneParts = parts.map((p) => ({ unit_key: p.unit_key, part_hash: p.part_hash }));
        const sceneHash = 'image-v2:' + sha(sceneParts.map((p) => `${p.unit_key}:${p.part_hash}`).join('\n')).slice(0, 32);
        return parts.map((p, i) => ({
            chapter_id: chapterId,
            scene_id: sceneId,
            kind: 'iu_image',
            unit_key: p.unit_key,
            build_id: buildId,
            scene_hash: sceneHash,
            input: {
                workflow_json: p.workflow_json,
                workflow_name: 'img-qwen-image',
                scene_type: sceneData.scene_type,
                part_hash: p.part_hash,
                scene_parts: sceneParts,
                part_meta: { unit_index: i, unit_count: parts.length },
            },
        }));
    }

    async function planUnits(bookRef, scope, layer) {
        if (layer !== 'image') return [];
        const loadedBook = d.book.loadBook(bookRef.bookId);
        if (!loadedBook) throw Object.assign(new Error(`book ${bookRef.bookId} not found`), { status: 404 });
        const buildId = loadedBook.manifest?.build_id || 'default';
        const out = [];
        for (const s of d.book.collectScenes(loadedBook)) {
            if (!s.chapter_id || !s.scene_id || !inScope(scope, s)) continue;
            let units = sceneUnits(loadedBook, s, buildId);
            if (scope.level === 'unit') units = units.filter((u) => u.unit_key === scope.unit_id);
            out.push(...units);
        }
        log(`[ORCH-V2] planUnits ${bookRef.bookId} scope=${scope.level}${scope.level === 'scenes' ? `[${scope.scene_ids.length}]` : ''}${scope.chapter_id ? '/' + scope.chapter_id : ''}${scope.scene_id ? '/' + scope.scene_id : ''}${scope.unit_id ? '/' + scope.unit_id : ''}: ${out.length} image unit(s)`);
        return out;
    }

    async function buildPayload(job) {
        if (!job.input || typeof job.input.workflow_json !== 'string') throw Object.assign(new Error('image job without workflow snapshot'), { error_class: 'deterministic' });
        return JSON.parse(job.input.workflow_json);
    }

    function artifactPath(job) {
        if (job.kind !== 'iu_image') throw Object.assign(new Error(`image-ports: kind ${job.kind}`), { error_class: 'deterministic' });
        if (!SAFE_UNIT_ID.test(String(job.unit_key))) throw Object.assign(new Error(`unsafe unit_key ${job.unit_key}`), { error_class: 'deterministic' });
        return d.helpers.getOutputPath(job.build_id, d.artifactNaming.sceneImageName(job.book_id, job.chapter_id, job.scene_id, job.unit_key));
    }

    /** Inside the acceptance tx after the rename: the IU picture is new → its thumbnail is stale. */
    function onArtifactPlaced(job, finalPath) {
        if (job.kind !== 'iu_image') return;
        const preview = path.join(path.dirname(finalPath),
            d.artifactNaming.sceneImagePreviewName(job.book_id, job.chapter_id, job.scene_id, job.unit_key));
        try {
            fs.unlinkSync(preview);
            log(`[ORCH-V2] preview invalidated: ${path.basename(preview)}`);
        } catch (err) {
            if (err && err.code !== 'ENOENT') log(`[ORCH-V2] preview invalidation failed for ${path.basename(preview)}: ${err.message} (result kept)`);
        }
    }

    return { planUnits, buildPayload, artifactPath, onArtifactPlaced, _sceneUnits: sceneUnits, SAFE_UNIT_ID };
}

module.exports = { createImagePorts, SAFE_UNIT_ID };
