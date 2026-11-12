// ======================================================
// Audio Generation
// ======================================================

const fs = require('fs');
const path = require('path');
// S-3: the generation provider seam is the ONLY Generation → ComfyUI/GPU
// boundary. No gpu-dispatcher / workflow-connector imports in executors.
const provider = require('@animastor/generation').comfyuiProvider;
const { resolveAssembly } = require('@animastor/generation').promptProfiles.assemblyProfile;
const profileOverride = require('../services/profile-override');
const helpers = require('./helpers');
// S-4: filename grammar composed from the canonical owner (bytes unchanged)
const artifactNaming = require('@animastor/generation').artifactNaming;
const validation = require('./validation');
const ffmpeg = require('./ffmpeg');
const voicePort = require('@animastor/vbook-runtime/voice');
const { qwenLanguage } = require('./voice-references');

const WORKFLOW_NARRATION = 'tts-qwen-narrator';
const WORKFLOW_DIALOGUE = 'tts-qwen-dialogue';

/**
 * Resolve the active audio assembly profile (ai/profiles/audio/{profile}.json).
 * A user override (global settings choice) wins; otherwise the TTS connector's
 * profile.audioProfile ('qwen-tts'); falls back to the built-in audio
 * assembly when unset (there is no 'default' profile). Its defaults
 * drive programmatic values like the dialogue workflow's defaultInstruct.
 * @returns {object} — normalized assembly { profileName, type, sections, suppress, defaults }
 */
function resolveAudioAssembly() {
    const connector = provider.getConnector(WORKFLOW_DIALOGUE) || provider.getConnector(WORKFLOW_NARRATION);
    return resolveAssembly('audio', profileOverride.getOverride('audio') || provider.profileNameFromConnector(connector, 'audio'));
}

// ══════════════════════════════════════════════════════
//  VOICES OF A SCENE (VOICE_REFERENCES.md)
// ══════════════════════════════════════════════════════
// Every chunk is cloned from a LOCKED voice reference (LoadAudio → VoiceClonePrompt).
// Speaker label = text before the first ": " of a dialogue line: a character_id
// with a voice entry → that voice; otherwise an episodic speaker ("женщина в
// будочке") → the narrator voice of the scene. Narration → the narrator voice.
// There is no VoiceDesign-per-chunk path and no fallback to it.

const SPEAKER_RE = /^([^:\n]+?):\s/;

function speakerLabel(seg) {
    const m = String(seg.text || '').match(SPEAKER_RE);
    return m ? m[1].trim() : null;
}

function voiceIdForSpeaker(label, sceneData, loadedBook) {
    if (label && voicePort.getCharacterVoice(loadedBook, label)) return label;
    return voicePort.narratorVoiceId(sceneData && (sceneData.payload || sceneData.scene), loadedBook);
}

/** Voice ids a scene needs (narrator for narration / episodic speakers, characters for their lines). */
function requiredVoiceIds(segList, sceneData, loadedBook) {
    const ids = new Set();
    for (const seg of segList) {
        if (seg.segment_type === 'dialogue') ids.add(voiceIdForSpeaker(speakerLabel(seg), sceneData, loadedBook));
        else ids.add(voicePort.narratorVoiceId(sceneData && (sceneData.payload || sceneData.scene), loadedBook));
    }
    return [...ids];
}

/** speakers + worker inputs of a dialogue script; null when > MAX speakers */
function dialogueSpeakers(lines, sceneData, loadedBook, voiceRefs) {
    const labels = [];
    for (const seg of lines) {
        const l = speakerLabel(seg) || 'speaker';
        if (!labels.includes(l)) labels.push(l);
    }
    if (labels.length > provider.MAX_DIALOGUE_SPEAKERS) return null;
    const inputs = new Map();
    const speakers = labels.map((label) => {
        const ref = voiceRefs.referenceInput(loadedBook, voiceIdForSpeaker(label, sceneData, loadedBook));
        inputs.set(ref.name, ref);
        return { name: label, referenceFile: ref.name, referenceText: ref.ref_text };
    });
    return { speakers, inputs: [...inputs.values()] };
}

const toInputFiles = (refs) => refs.map((r) => ({ name: r.name, path: r.path, sha256: r.sha256, bytes: r.bytes }));

/**
 * Merged pure-dialogue scene: ALL dialogue lines in one AdvancedDialogue run.
 * @returns {null|{workflow:object, input_files:Array}} null when > 3 speakers (per-segment then)
 * @throws voice_reference_required (409) when a speaker has no locked reference
 */
function buildMergedDialogueWorkflow(segList, loadedBook, sceneData, voiceRefs) {
    const lines = segList.filter((s) => s.segment_type === 'dialogue');
    if (!lines.length) return null;
    const sp = dialogueSpeakers(lines, sceneData, loadedBook, voiceRefs);
    if (!sp) {
        helpers.warn(`buildMergedDialogueWorkflow: more than ${provider.MAX_DIALOGUE_SPEAKERS} speakers — per-segment`);
        return null;
    }
    const workflow = provider.assembleMergedDialogueWorkflow({
        script: lines.map((s) => s.text).join('\n'),
        defaultInstruct: resolveAudioAssembly().defaults.defaultInstruct || '',
        speakers: sp.speakers,
    });
    if (!workflow) throw new Error('dialogue workflow / connector unavailable');
    return { workflow, input_files: toInputFiles(sp.inputs) };
}

/**
 * ONE audio segment (narration chunk or one dialogue line).
 * @returns {{workflow:object, input_files:Array}}
 */
function buildSegmentWorkflow(segment, sceneData, loadedBook, voiceRefs) {
    if (segment.segment_type === 'dialogue') {
        const sp = dialogueSpeakers([segment], sceneData, loadedBook, voiceRefs);
        const workflow = provider.assembleMergedDialogueWorkflow({
            script: segment.text,
            defaultInstruct: resolveAudioAssembly().defaults.defaultInstruct || '',
            speakers: sp.speakers,
        });
        if (!workflow) throw new Error('dialogue workflow / connector unavailable');
        return { workflow, input_files: toInputFiles(sp.inputs) };
    }
    const ref = voiceRefs.referenceInput(loadedBook, voicePort.narratorVoiceId(sceneData && (sceneData.payload || sceneData.scene), loadedBook));
    const workflow = provider.assembleNarrationWorkflow({
        text: segment.text, referenceFile: ref.name, referenceText: ref.ref_text, language: qwenLanguage(loadedBook),
    });
    if (!workflow) throw new Error('narration workflow / connector unavailable');
    return { workflow, input_files: toInputFiles([ref]) };
}

// ══════════════════════════════════════════════════════
//  PADDED-TEXT TRIM
// ══════════════════════════════════════════════════════

async function trimPaddedSceneAudio(filePath, originalTextLength) {
    const basename = path.basename(filePath);

    const duration = await ffmpeg.probeDuration(filePath);
    if (!duration || duration < 0.5) {
        helpers.log(`✂️ trimPaddedSceneAudio: ${basename} duration=${duration}s too short, skipping`);
        return;
    }

    let cutTime;
    if (originalTextLength && originalTextLength > 0) {
        // Ratio-based cut: padShortText produces `text + " " + text`
        // Keep only the first copy. Ratio = original_len / (original_len * 2 + 1).
        const paddedLength = originalTextLength * 2 + 1;
        const ratio = originalTextLength / paddedLength;
        cutTime = duration * ratio;
        helpers.log(`✂️ trimPaddedSceneAudio: ${basename} ratio-based cut: ${originalTextLength}/${paddedLength} = ${ratio.toFixed(3)} of ${duration.toFixed(2)}s → cut at ${cutTime.toFixed(2)}s`);
    } else {
        // Fallback: silence detection for legacy padded chunks without original_text_length
        const quietest = await ffmpeg.findQuietestPoint(filePath, 0.40, 0.60);
        cutTime = (quietest > 0.3) ? quietest : (duration / 2);
        helpers.log(`✂️ trimPaddedSceneAudio: ${basename} silence-based fallback: quietest=${quietest.toFixed(3)}s → cut at ${cutTime.toFixed(2)}s`);
    }

    const safetyMargin = 0.10;
    cutTime = Math.min(cutTime + safetyMargin, duration * 0.55);

    const tempPath = filePath + '.trim.mp3';
    const ok = await ffmpeg.cutFirstHalf(filePath, tempPath, cutTime);
    if (ok) {
        try {
            fs.renameSync(tempPath, filePath);
            helpers.log(`✂️ trimPaddedSceneAudio: trimmed ${basename} → kept first ${cutTime.toFixed(1)}s (original ${duration.toFixed(1)}s)`);
        } catch (e) {
            helpers.log(`⚠️ trimPaddedSceneAudio: rename failed for ${basename}: ${e.message}`);
        }
    } else {
        helpers.log(`⚠️ trimPaddedSceneAudio: ffmpeg cut failed for ${basename}, file unchanged`);
    }
}

/**
 * Trim a padded TTS chunk IN MEMORY, before its fenced commit.
 *
 * GPU E2E 2026-11-02 (§6.2): the merge used to trim the canonical chunk file
 * AFTER the fenced commit, so the canonical bytes stopped matching the
 * committed manifest (`canonical_content_mismatch` every 60 s, forever).
 * Invariant now: the canonical artifact never changes outside a fence — the
 * trim runs on a private temp copy of the GPU bytes and the TRIMMED bytes are
 * what gets staged, committed (manifest sha256/bytes) and published.
 *
 * Deterministic for the same input (ffmpeg stream copy), so a redelivery of
 * the same fence stages identical bytes. Never throws: on any failure the
 * original bytes are returned untouched (`trimmed:false`).
 *
 * @returns {Promise<{buffer: Buffer, trimmed: boolean}>}
 */
async function trimPaddedAudioBuffer(buffer, originalTextLength, { extension = '.mp3' } = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { buffer, trimmed: false };
    const os = require('os');
    let dir = null;
    try {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animastor-trim-'));
        const file = path.join(dir, 'chunk' + extension);
        fs.writeFileSync(file, buffer);
        await trimPaddedSceneAudio(file, originalTextLength);
        const out = fs.readFileSync(file);
        if (out.length === 0) return { buffer, trimmed: false };
        return { buffer: out, trimmed: !out.equals(buffer) };
    } catch (err) {
        helpers.log(`⚠️ trimPaddedAudioBuffer: ${err.message} — committing untrimmed bytes`);
        return { buffer, trimmed: false };
    } finally {
        if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
    }
}

// ══════════════════════════════════════════════════════
//  LEGACY ORCHESTRATION
// ══════════════════════════════════════════════════════
// Audio is generated ONLY by orchestration v2 (job input files deliver the
// voice references to the worker; protocol 2 cannot). A legacy book gets a
// clear refusal — nothing is sent (VOICE_REFERENCES.md, owner decision 2026-11-12).
async function generateSceneAudio(_redis, sceneData, _loadedBook, _buildId, bookId) {
    helpers.warn(`generateSceneAudio: ${bookId}/${sceneData && sceneData.scene_id} — legacy orchestration has no audio (voice references need orchestration v2)`);
    return { generated: false, reason: 'voice_references_require_v2' };
}

async function mergeBookAudio(buildId, bookId, scenes) {
    if (!scenes || scenes.length === 0) {
        helpers.warn(`mergeBookAudio: no scenes for book ${bookId}`);
        return null;
    }

    const finalPath = helpers.getOutputPath(buildId, artifactNaming.bookAudioName(bookId));
    helpers.log(`mergeBookAudio: ${bookId} (${scenes.length} scenes) -> ${finalPath}`);

    if (fs.existsSync(finalPath)) {
        try {
            const isValid = await validation.validateCanonicalAudio(finalPath);
            if (isValid) {
                helpers.log(`Book audio already exists and is valid: ${path.basename(finalPath)}`);
                return finalPath;
            }
            helpers.log(`Book audio exists but invalid, regenerating`);
            try { fs.unlinkSync(finalPath); } catch (e) {}
        } catch (err) {
            helpers.warn(`Book audio validation error, regenerating: ${err.message}`);
            try { fs.unlinkSync(finalPath); } catch (e) {}
        }
    }

    const audioPaths = [];
    for (const scene of scenes) {
        const scenePath = helpers.getOutputPath(buildId, artifactNaming.sceneAudioName(bookId, scene.chapter_id, scene.scene_id));
        if (fs.existsSync(scenePath)) {
            audioPaths.push(scenePath);
        } else {
            helpers.warn(`Scene audio not found: ${scenePath}`);
        }
    }

    if (audioPaths.length === 0) {
        helpers.warn(`mergeBookAudio: no scene audio files found for book ${bookId}`);
        return null;
    }

    if (audioPaths.length === 1) {
        fs.copyFileSync(audioPaths[0], finalPath);
        helpers.log(`Book audio: single scene, copied.`);
        return finalPath;
    }

    const concatPath = path.join('/tmp', `aconcat_${bookId}_${Date.now()}.txt`);
    const concatContent = audioPaths.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(concatPath, concatContent);

    try {
        const args = ['-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', finalPath, '-y'];
        await ffmpeg.runFFmpegMerge(args);
        helpers.log(`Book audio merged: ${path.basename(finalPath)}`);
        return finalPath;
    } catch (err) {
        helpers.error(`Book audio merge failed: ${err.message}`);
        if (fs.existsSync(finalPath)) {
            try { fs.unlinkSync(finalPath); } catch (e) {}
        }
        return null;
    } finally {
        if (fs.existsSync(concatPath)) {
            try { fs.unlinkSync(concatPath); } catch (e) {}
        }
    }
}

module.exports = {
    generateSceneAudio,
    mergeBookAudio,
    trimPaddedSceneAudio,
    trimPaddedAudioBuffer,
    buildMergedDialogueWorkflow,
    buildSegmentWorkflow,
    requiredVoiceIds,
    voiceIdForSpeaker,
    resolveAudioAssembly,
    WORKFLOW_NARRATION,
    WORKFLOW_DIALOGUE,
};
