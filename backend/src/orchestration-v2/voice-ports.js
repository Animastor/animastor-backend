// ======================================================
// orchestration-v2/voice-ports — host ports for kind voice_reference
// ======================================================
// VOICE_REFERENCES.md. A voice_reference command (explicit user click) plans
// one job per candidate:
//   design  — VoiceDesign(timbre[+manner], template phrase, seed) →
//             SaveAudioAnimastorReference (normalise + faster-whisper)
//   upload  — LoadAudio(user sample, delivered as an input file) → the same node
// artifactPath  → build_<id>/voices/<character_id>/<candidate_id>.wav
// onArtifactPlaced → canonical WAV (LIST cut), sha256, strict transcript check,
//                  candidate metadata JSON (audio/voice-references.onCandidatePlaced)

'use strict';

const path = require('path');

function createVoicePorts(opts = {}) {
    const d = opts.deps || {};
    const book = d.book || (() => { throw new Error('voice-ports: deps.book is required'); })();
    const voiceRefs = d.voiceRefs || (() => { throw new Error('voice-ports: deps.voiceRefs is required'); })();
    const provider = d.provider || require('@animastor/generation').comfyuiProvider;
    const outputDir = d.outputDir || (() => { throw new Error('voice-ports: deps.outputDir is required'); })();
    const log = opts.log || ((m) => console.log(m));

    async function planUnits(bookRef, scope) {
        const loadedBook = book.loadBook(bookRef.bookId);
        if (!loadedBook) throw Object.assign(new Error(`book ${bookRef.bookId} not found`), { status: 404 });
        const units = voiceRefs.planCandidates(loadedBook, bookRef.bookId, scope.voice || {}, provider);
        log(`[ORCH-V2] voice_reference ${bookRef.bookId} mode=${(scope.voice || {}).mode}: ${units.length} candidate job(s)`);
        return units;
    }

    async function buildPayload(job) {
        if (!job.input || typeof job.input.workflow_json !== 'string') throw Object.assign(new Error('voice_reference job without workflow snapshot'), { error_class: 'deterministic' });
        return JSON.parse(job.input.workflow_json);
    }

    function artifactPath(job) {
        return voiceRefs.paths.candidateWav(job.build_id, job.scene_id, job.unit_key);
    }

    function inputFiles(job) {
        return voiceRefs.jobInputFiles(job);
    }

    async function onArtifactPlaced(job, finalPath) {
        if (path.resolve(finalPath) !== path.resolve(artifactPath(job))) throw new Error('voice_reference placed at an unexpected path');
        voiceRefs.onCandidatePlaced(job, finalPath);
    }

    return { planUnits, buildPayload, artifactPath, inputFiles, onArtifactPlaced, outputDir };
}

module.exports = { createVoicePorts };
