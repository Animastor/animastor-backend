// ======================================================
// ComfyUIProvider — generation provider seam (S-3)
// ======================================================
// The SINGLE Generation → ComfyUI/GPU seam (S-3): media executors
// (audio/generation.js, image/iu-processor.js, video/video-service.js,
// orchestration/scene-orchestrator.js) depend on THIS semantic contract —
// they never touch the workflow-connector package or the GPU dispatcher
// directly.
//
//   Generation media executor
//       ↓
//   this provider contract (semantic: workflow names, entity keys, job spec)
//       ↓
//   animastor-comfyui-workflow-connector (workflow JSON + connectors)
//   generation/ports/dispatch-transport → runtime/gpu-dispatcher.sendUnified
//                                         (Job Protocol v2 → GPU Hub POST /task)
//       ↓
//   GPU Hub / Worker (external packages)
//
// ALL ComfyUI-specific knowledge of the generation domain is centralized
// here (S3-C/S3-D): workflow names, connector resolution, entity-key →
// node-id/field binding, workflow JSON assembly (merged dialogue RoleBank),
// and the dispatch transport call. Nothing in this module touches the LLM
// transports (agent callAI / chat SSE / connector WS / shared-pool).
//
// Cancellation deliberately does NOT pass through this seam: job
// cancellation is owned by the dispatch engine (marker/lease lifecycle +
// Hub queue clear) — documented residual seam (reconnaissance §9).
//
// Jobs built/dispatched here follow Job Protocol v2 (@animastor/contracts,
// the frozen protocol package — the backend/src/runtime/job-schema.js facade
// is a zero-logic re-export of it; the package consumes the canonical package
// directly so it has no host require) — the payload semantics (job_id, params,
// job_type, build_id, dispatch_id, assets, timeout_ms, extra pass-through
// fields) are preserved 1:1 with the former direct gpu.send / gpu.sendUnified
// call sites.

const wfLoader = require('animastor-comfyui-workflow-connector').workflowLoader;
const connectorLoader = require('animastor-comfyui-workflow-connector').connectorLoader;
// Job Protocol v2 — canonical frozen protocol package (S-7: the package
// requires @animastor/contracts directly; the backend job-schema facade is a
// zero-logic re-export of exactly this object, so behavior is byte-identical).
const jobSchema = require('@animastor/contracts').jobProtocolV2;
// S-6: dispatch goes through the Generation-owned DispatchTransport port —
// Core must not know the concrete gpu-dispatcher (the host adapter wires
// runtime/gpu-dispatcher.sendUnified behind the port at the composition
// root; routing policy stays host-side, reconnaissance §24.6).
const { dispatch } = require('../ports/dispatch-transport');

// ── provider identity ───────────────────────────────────────────────────
const PROVIDER_NAME = 'comfyui';

// Workflow names currently exercised by the generation domain (the same
// ids the workflow loader resolves from backend/ai/workflows/*.json).
// Media executors may SELECT a workflow by name (semantic knowledge) but
// must load/patch it only through this provider (S3-C).
const WORKFLOW_NAMES = {
    narration: 'tts-qwen-narrator',
    dialogue: 'tts-qwen-dialogue',
    voiceReference: 'tts-qwen-voice-reference',
    voiceTranscribe: 'tts-qwen-voice-transcribe',
    image: 'img-qwen-image',
    videoFamily: 'video-ltx',
};

// ── workflow / connector knowledge ──────────────────────────────────────

/**
 * Load a fresh deep copy of a ComfyUI workflow by name.
 * Returns the workflow JSON (mutable clone — callers patch node inputs,
 * exactly as the workflow connector package's getWorkflow does today).
 * @param {string} name - workflow name (see WORKFLOW_NAMES)
 * @returns {object} workflow JSON clone
 * @throws when the workflow is not loaded
 */
function loadWorkflow(name) {
    return wfLoader.getWorkflow(name);
}

/** Resolve the ComfyUI connector (node-id/field mapping) for a workflow. */
function getConnector(name) {
    return wfLoader.getConnector(name);
}

/** Computed sha256 of the loaded workflow (installer/hub traceability). */
function getWorkflowHash(name) {
    return wfLoader.getWorkflowHash(name);
}

/** All loaded workflows (name → JSON). Callers must NOT patch these
 *  objects directly — take a mutable copy via loadWorkflow(name). */
function listWorkflows() {
    return wfLoader.workflows;
}

/**
 * Apply one entity value to a workflow via its connector binding
 * (entityKey → nodeId/field resolution — the ONLY node-id knowledge home).
 * Returns false when the connector is absent (connectors are mandatory at
 * startup — backend exits fatally without them — so this is a hard
 * invariant, not a recoverable state).
 * @param {object} workflow - mutable workflow clone (from loadWorkflow)
 * @param {string} workflowName - workflow name the connector is resolved for
 * @param {string} entityKey - semantic connector entity key (e.g. 'dialogueScript')
 * @param {*} value
 * @returns {boolean} applied
 */
function applyValue(workflow, workflowName, entityKey, value) {
    const connector = wfLoader.getConnector(workflowName);
    if (!connector) return false;
    return connectorLoader.setValue(workflow, connector, entityKey, value);
}

/** Resolve the node id bound to a connector entity key (video guide slots). */
function getNodeId(workflowName, entityKey) {
    const connector = wfLoader.getConnector(workflowName);
    if (!connector) return null;
    return connectorLoader.getNodeId(connector, entityKey);
}

/** Resolve the raw connector binding for an entity key (video guideStrength). */
function getBinding(workflowName, entityKey) {
    const connector = wfLoader.getConnector(workflowName);
    if (!connector) return null;
    return connectorLoader.getBinding(connector, entityKey);
}

/**
 * Extract the assembly-profile name for a media type from a connector
 * object (profile.{type}Profile). Pure helper; returns null when absent —
 * callers fall back to the built-in assembly (there is no 'default' profile).
 * @param {object|null} connector
 * @param {('audio'|'image'|'video')} type
 * @returns {string|null}
 */
function profileNameFromConnector(connector, type) {
    return connector?.profile?.[`${type}Profile`] || null;
}

// ── audio workflow assembly (merged dialogue) ───────────────────────────
// MOVED from audio/generation.js in S-3. This is the ONLY home of the
// merged-dialogue node knowledge: script processor node, per-speaker
// VoiceDesign nodes, RoleBank role_name_N / prompt_N wiring, and the
// VoiceClonePrompt node ids. Media executors pass SEMANTIC values only.

// Static topology of the tts-qwen-dialogue workflow (kept 1:1 with the
// pre-S-3 executor logic):
//   script node        108 (Qwen3TTSScriptProcessor)  — script + default_instruct
//   speaker slot 0/1/2  71/80/82 (Qwen3TTSVoiceDesign) — voice_instruction
//   RoleBank node       74 (Qwen3TTSRoleBank)          — role_name_N + prompt_N
//   clone prompt nodes  73/81/83 (Qwen3TTSVoiceClonePrompt) — prompt_N links [id, 0]
const MERGED_DIALOGUE_NODE_IDS = {
    script: '108',
    // VOICE_REFERENCES.md: each speaker slot = LoadAudio(locked reference) → VoiceClonePrompt
    loadAudio: ['71', '80', '82'],
    roleBank: '74',
    clonePrompt: ['73', '81', '83'],
};
const MAX_DIALOGUE_SPEAKERS = MERGED_DIALOGUE_NODE_IDS.loadAudio.length;

/**
 * Assemble the dialogue workflow: N speakers (1..3), each cloned from its
 * locked voice reference. Unused slots (LoadAudio + ClonePrompt + RoleBank
 * entries) are REMOVED from the graph — ComfyUI then neither loads nor runs
 * them. Used for a merged pure-dialogue scene and for a single dialogue line.
 * @param {{script:string, defaultInstruct:string,
 *          speakers: Array<{name:string, referenceFile:string, referenceText:string}>}} spec
 *        referenceFile — the file name in ComfyUI/input (vref_<sha>.wav, delivered as a job input)
 * @returns {object|null} patched workflow clone; null when the base workflow /
 *          connector is unavailable or the speaker count is out of range
 */
function assembleMergedDialogueWorkflow({ script, defaultInstruct, speakers }) {
    if (!Array.isArray(speakers) || speakers.length < 1 || speakers.length > MAX_DIALOGUE_SPEAKERS) return null;
    const wfAudio = loadWorkflow(WORKFLOW_NAMES.dialogue);
    if (!wfAudio) return null;
    if (!getConnector(WORKFLOW_NAMES.dialogue)) return null;

    wfAudio[MERGED_DIALOGUE_NODE_IDS.script].inputs = {
        script,
        default_instruct: defaultInstruct || ""
    };

    const { loadAudio, roleBank, clonePrompt } = MERGED_DIALOGUE_NODE_IDS;
    const bank = { };
    for (let i = 0; i < MAX_DIALOGUE_SPEAKERS; i++) {
        const speaker = speakers[i];
        if (!speaker) {
            delete wfAudio[loadAudio[i]];
            delete wfAudio[clonePrompt[i]];
            continue;
        }
        if (!speaker.referenceFile || !speaker.referenceText) {
            throw Object.assign(new Error(`dialogue speaker ${speaker.name}: voice reference required`), { code: 'voice_reference_required' });
        }
        wfAudio[loadAudio[i]].inputs.audio = speaker.referenceFile;
        wfAudio[clonePrompt[i]].inputs.ref_text = speaker.referenceText;
        bank[`role_name_${i + 1}`] = speaker.name;
        bank[`prompt_${i + 1}`] = [clonePrompt[i], 0];
    }
    wfAudio[roleBank].inputs = bank;
    return wfAudio;
}

/**
 * Narration workflow: the chunk text cloned from the narrator's locked reference.
 * @param {{text:string, referenceFile:string, referenceText:string, language:string}} spec
 */
function assembleNarrationWorkflow({ text, referenceFile, referenceText, language }) {
    const wf = loadWorkflow(WORKFLOW_NAMES.narration);
    if (!wf || !getConnector(WORKFLOW_NAMES.narration)) return null;
    if (!referenceFile || !referenceText) {
        throw Object.assign(new Error('narration: voice reference required'), { code: 'voice_reference_required' });
    }
    applyValue(wf, WORKFLOW_NAMES.narration, 'narrationText', text);
    applyValue(wf, WORKFLOW_NAMES.narration, 'referenceAudio', referenceFile);
    applyValue(wf, WORKFLOW_NAMES.narration, 'referenceText', referenceText);
    if (language) applyValue(wf, WORKFLOW_NAMES.narration, 'language', language);
    return wf;
}

/**
 * Voice-reference candidate: VoiceDesign(description, template phrase, seed) →
 * SaveAudioAnimastorReference (normalise + Whisper).
 */
function assembleVoiceReferenceWorkflow({ description, phrase, language, seed, whisperModel = 'small', filenamePrefix }) {
    const name = WORKFLOW_NAMES.voiceReference;
    const wf = loadWorkflow(name);
    if (!wf || !getConnector(name)) return null;
    applyValue(wf, name, 'voiceInstruction', description);
    applyValue(wf, name, 'referencePhrase', phrase);
    applyValue(wf, name, 'language', language);
    applyValue(wf, name, 'asrLanguage', language);
    applyValue(wf, name, 'seed', seed);
    applyValue(wf, name, 'whisperModel', whisperModel);
    if (filenamePrefix) applyValue(wf, name, 'outputFilenamePrefix', filenamePrefix);
    return wf;
}

/** Uploaded sample: LoadAudio → SaveAudioAnimastorReference (normalise + Whisper). */
function assembleVoiceTranscribeWorkflow({ inputFile, language, whisperModel = 'small', filenamePrefix }) {
    const name = WORKFLOW_NAMES.voiceTranscribe;
    const wf = loadWorkflow(name);
    if (!wf || !getConnector(name)) return null;
    applyValue(wf, name, 'referenceAudio', inputFile);
    applyValue(wf, name, 'asrLanguage', language);
    applyValue(wf, name, 'whisperModel', whisperModel);
    if (filenamePrefix) applyValue(wf, name, 'outputFilenamePrefix', filenamePrefix);
    return wf;
}

// ── dispatch transport (the single Generation → GPU transport seam) ─────

/**
 * Dispatch a built ComfyUI workflow as a GPU Hub job (Job Protocol v2).
 * Accepts the semantic request shape:
 *   { jobId, workflow, jobType, buildId, dispatchId }          (camelCase)
 * and/or the v2 task-spec fields verbatim (job_id, params, job_type,
 * build_id, dispatch_id) plus pass-through fields (assets, timeout_ms,
 * workflow_name, unit_ids, …). Every extra field is forwarded unchanged —
 * payload semantics are 1:1 with the former direct gpu.send/sendUnified
 * call sites (S-3 payload preservation).
 * @returns {Promise<{sent:boolean, jobId?:string, dispatchId?:string, error?:string}>}
 */
async function generate(request) {
    const {
        // camelCase semantic sugar (stripped — never reaches the wire)
        jobId, workflow, jobType, buildId, dispatchId, timeoutMs,
        // everything else passes through verbatim (payload preservation)
        ...extras
    } = request || {};

    const taskSpec = {
        ...extras,
        job_id: jobId ?? extras.job_id,
        params: workflow ?? extras.params,
        job_type: jobType ?? extras.job_type,
        build_id: buildId ?? extras.build_id,
        dispatch_id: dispatchId ?? extras.dispatch_id,
    };
    if (timeoutMs !== undefined && taskSpec.timeout_ms === undefined) {
        taskSpec.timeout_ms = timeoutMs;
    }

    // S-6: the v2 task spec flows through the DispatchTransport port —
    // payload/result/error semantics are 1:1 with the former direct
    // gpuDispatcher.sendUnified call (the host adapter IS sendUnified).
    return dispatch(taskSpec);
}

/**
 * Convenience helper used by generation call sites: build the v2 job id.
 */
function buildJobId(imageIUId, kind) {
    return jobSchema.buildJobId(imageIUId, kind);
}

module.exports = {
    PROVIDER_NAME,
    WORKFLOW_NAMES,

    // workflow / connector knowledge
    loadWorkflow,
    getConnector,
    getWorkflowHash,
    listWorkflows,
    applyValue,
    getNodeId,
    getBinding,
    profileNameFromConnector,
    assembleMergedDialogueWorkflow,
    assembleNarrationWorkflow,
    assembleVoiceReferenceWorkflow,
    assembleVoiceTranscribeWorkflow,
    MAX_DIALOGUE_SPEAKERS,

    // dispatch
    generate,
    buildJobId,
};
