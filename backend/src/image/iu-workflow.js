// ======================================================
// IU workflow + scene duration (image units)
// ======================================================
// 2026-11-28 (ORCHESTRATION_V2 §12 этап 4, шаг 7): the two live functions of
// the deleted image/iu-processor.js (legacy IU dispatch, iu-in-flight /
// iu-registry Redis families), moved verbatim:
//   buildIUWorkflow   — orchestration v2 image port (orchestration-v2/image-ports.js)
//   getSceneDuration  — the player (@animastor/player scene-data / iu-media,
//                       through the image facade)

'use strict';

const fs = require('fs');
// S-3: the generation provider seam is the ONLY Generation → ComfyUI/GPU boundary.
const provider = require('@animastor/generation').comfyuiProvider;
const profileOverride = require('../services/profile-override');
const helpers = require('./helpers');
// S-4: filename grammar composed from the canonical owner (bytes unchanged)
const artifactNaming = require('@animastor/generation').artifactNaming;
const promptBuilder = require('./prompt-builder');
const assemblyProfile = require('@animastor/generation').promptProfiles.assemblyProfile;

async function getSceneDuration(buildId, bookId, chapterId, sceneId) {
    // Priority 1: Real audio file on disk (GROUND TRUTH)
    const audioPath = helpers.getOutputPath(buildId, artifactNaming.sceneAudioName(bookId, chapterId, sceneId));
    if (fs.existsSync(audioPath)) {
        try {
            const mm = require('music-metadata');
            const metadata = await mm.parseFile(audioPath);
            if (metadata.format.duration > 0) return metadata.format.duration;
        } catch {}
    }

    // Priority 2: scene_assets with status='ready' (real audio registered in DB)
    try {
        const { query } = require('../storage/postgres/database');
        const result = await query(`
            SELECT duration_sec FROM scene_assets
            WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
              AND asset_type = 'audio' AND build_id = $4 AND status = 'ready'
            LIMIT 1
        `, [bookId, chapterId, sceneId, buildId]);
        if (result.rows.length > 0 && result.rows[0].duration_sec > 0) return result.rows[0].duration_sec;
    } catch {}

    // Priority 3: image_units.scene_duration_sec (may be stale placeholder-based value)
    try {
        const { query } = require('../storage/postgres/database');
        const result = await query(`
            SELECT scene_duration_sec FROM image_units
            WHERE build_id = $1 AND book_id = $2 AND chapter_id = $3 AND scene_id = $4
            LIMIT 1
        `, [buildId, bookId, chapterId, sceneId]);
        if (result.rows.length > 0 && result.rows[0].scene_duration_sec > 0) return result.rows[0].scene_duration_sec;
    } catch {}

    // Priority 4: scene_assets with status='placeholder' (original word-count estimate)
    try {
        const { query } = require('../storage/postgres/database');
        const result = await query(`
            SELECT duration_sec FROM scene_assets
            WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
              AND asset_type = 'audio' AND build_id = $4 AND status = 'placeholder'
            LIMIT 1
        `, [bookId, chapterId, sceneId, buildId]);
        if (result.rows.length > 0 && result.rows[0].duration_sec > 0) return result.rows[0].duration_sec;
    } catch {}

    return 0;
}

/**
 * The ComfyUI workflow of ONE image unit, exactly as it is sent to the GPU:
 * the img-qwen-image template with the positive (node 108) and negative
 * (node 109) prompt patched in; seed / size / steps / LoRA stay as in the
 * template. Pure (no Redis / PG / disk writes) — used by the orchestration v2
 * image port (image-ports.js).
 * @returns {{workflow:object, profile:string, prompt:string, negative:string}}
 */
function buildIUWorkflow(unit, sceneData, loadedBook) {
    // Assembly profile for the image workflow — resolved from the connector's
    // profile.imageProfile (e.g. "qwen-image"); falls back to the built-in
    // assembly when unset (there is no 'default' profile). S-3: profile
    // resolution rides the provider seam (override → connector profile).
    const imageProfileName = profileOverride.getOverride('image')
        || provider.profileNameFromConnector(provider.getConnector(provider.WORKFLOW_NAMES.image), 'image');
    const assemblyCfg = assemblyProfile.resolveAssembly('image', imageProfileName);

    const finalPrompt = promptBuilder.buildImagePrompt(unit, sceneData.payload, sceneData.chapter, loadedBook, { profile: imageProfileName });

    const wfImg = provider.loadWorkflow(provider.WORKFLOW_NAMES.image);
    const baseNegative = assemblyCfg.defaults.negativeBase || 'blurry, low quality, artifacts';
    const customNegative = promptBuilder.resolveNegativePrompt(unit, sceneData.payload);
    const negative = customNegative ? `${customNegative}, ${baseNegative}` : baseNegative;

    provider.applyValue(wfImg, provider.WORKFLOW_NAMES.image, 'positivePrompt', finalPrompt);
    provider.applyValue(wfImg, provider.WORKFLOW_NAMES.image, 'negativePrompt', negative);
    return { workflow: wfImg, profile: imageProfileName, prompt: finalPrompt, negative };
}

module.exports = { buildIUWorkflow, getSceneDuration };
