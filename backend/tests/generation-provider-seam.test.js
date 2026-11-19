// ======================================================
// Generation Provider Seam — regression tests (S-3)
// ======================================================
// Behavior regression coverage for the S-3 seam migration: all media
// executors dispatch through generation/comfyui-provider.generate —
// these tests pin the contract the executors rely on:
//
//   T1  provider dispatch          — generate() → sendUnified payload 1:1
//   T2  job payload preservation   — extra fields (assets, workflow_name,
//                                  unit_ids, timeout_ms) pass through
//                                  verbatim (video jobSpec path)
//   T3  error propagation          — {sent:false,error} returned as-is;
//                                  transport throws propagate to the caller
//   T4  unknown/invalid response   — malformed specs hit the frozen
//                                  sendUnified validation (Job Protocol v2)
//   T5  cancellation               — cancellation does NOT pass through the
//                                  provider: it is owned by the dispatch
//                                  engine (marker lifecycle + Hub queue
//                                  clear). Guarded by a surface assertion.
//   T6  semantic binding API       — applyValue / assembleMergedDialogue
//                                  produce byte-identical node inputs to
//                                  the pre-S-3 executor logic
// Docs: docs/architecture/generation-module-extraction-reconnaissance.md (§S-3)

const { expect } = require('chai');
const path = require('path');

const provider = require('@animastor/generation').comfyuiProvider;
const gpuDispatcher = require('../src/runtime/gpu-dispatcher');
const wfLoader = require('animastor-comfyui-workflow-connector').workflowLoader;

// Load the real workflows/connectors (host-injected dirs, like backend.cjs)
before(() => {
    wfLoader.configure({
        workflowsDir: path.join(__dirname, '../ai/workflows'),
        connectorsDir: path.join(__dirname, '../ai/connectors'),
    });
    wfLoader.loadWorkflows();
});

// ======================================================
// T1/T2/T3 — dispatch contract (captured transport)
// ======================================================
// The sendUnified capture stub is scoped INSIDE this describe block — a
// top-level hook would leak the stub into other test files.
describe('generation provider seam (captured transport)', () => {
    let captured;
    let originalSendUnified;

    beforeEach(() => {
        captured = [];
        originalSendUnified = gpuDispatcher.sendUnified;
        gpuDispatcher.sendUnified = async (spec) => {
            captured.push(spec);
            return { sent: true, jobId: spec.job_id, dispatchId: spec.dispatch_id };
        };
    });

    afterEach(() => {
        gpuDispatcher.sendUnified = originalSendUnified;
    });

    // ── T1 — provider dispatch ──
    it('maps the camelCase request to the v2 task spec exactly (no stray keys)', async () => {
        const result = await provider.generate({
            jobId: 'book_ch1_sc1_0001:audio',
            workflow: { '108': { inputs: {} } },
            jobType: 'audio',
            buildId: 'build-1',
            dispatchId: 'dispatch-1',
        });
        expect(result).to.deep.equal({ sent: true, jobId: 'book_ch1_sc1_0001:audio', dispatchId: 'dispatch-1' });
        expect(captured).to.have.length(1);
        expect(captured[0]).to.deep.equal({
            job_id: 'book_ch1_sc1_0001:audio',
            params: { '108': { inputs: {} } },
            job_type: 'audio',
            build_id: 'build-1',
            dispatch_id: 'dispatch-1',
        });
    });

    it('dispatches the iu_image job kind through the same seam', async () => {
        await provider.generate({
            jobId: provider.buildJobId('book_ch1_sc1_iu-1', 'iu_image'),
            workflow: {},
            jobType: 'image',
            buildId: 'b',
            dispatchId: 'd',
        });
        expect(captured[0].job_type).to.equal('image');
        expect(captured[0].job_id.endsWith(':iu_image')).to.equal(true);
    });

    // ── T2 — job payload preservation (video jobSpec passthrough) ──
    it('forwards assets, workflow_name, unit_ids and timeout_ms verbatim', async () => {
        const jobSpec = {
            job_id: 'book_ch1_sc1_g1:video',
            params: { '1': { class_type: 'LTXV' } },
            job_type: 'video',
            assets: { images: { 'iu-1': 'aGVsbG8=' } },
            build_id: 'build-1',
            dispatch_id: 'dispatch-1',
            workflow_name: 'video-ltx-2p',
            unit_ids: ['iu-1', 'iu-2'],
            timeout_ms: 123456,
        };
        await provider.generate(jobSpec);
        expect(captured[0]).to.deep.equal(jobSpec);
    });

    it('camelCase timeoutMs maps to timeout_ms without touching an explicit timeout_ms', async () => {
        await provider.generate({ jobId: 'j', workflow: {}, jobType: 'audio', buildId: 'b', dispatchId: 'd', timeoutMs: 42 });
        expect(captured[0].timeout_ms).to.equal(42);

        await provider.generate({ jobId: 'j', workflow: {}, jobType: 'audio', buildId: 'b', dispatchId: 'd', timeout_ms: 99, timeoutMs: 42 });
        expect(captured[1].timeout_ms).to.equal(99);
    });

    it('camelCase sugar keys never reach the wire payload', async () => {
        await provider.generate({ jobId: 'j', workflow: {}, jobType: 'audio', buildId: 'b', dispatchId: 'd' });
        expect(captured[0]).to.not.have.any.keys(['jobId', 'workflow', 'jobType', 'buildId', 'dispatchId', 'timeoutMs']);
    });

    // ── T3 — error propagation ──
    it('{sent:false, error} from the transport is returned unchanged', async () => {
        gpuDispatcher.sendUnified = async () => ({ sent: false, error: 'hub_down' });
        const result = await provider.generate({ jobId: 'j', workflow: {}, jobType: 'audio', buildId: 'b', dispatchId: 'd' });
        expect(result).to.deep.equal({ sent: false, error: 'hub_down' });
    });

    it('transport throws propagate to the caller (marker cleanup semantics preserved)', async () => {
        gpuDispatcher.sendUnified = async () => { throw new Error('hub_unreachable'); };
        let err;
        try {
            await provider.generate({ jobId: 'j', workflow: {}, jobType: 'audio', buildId: 'b', dispatchId: 'd' });
        } catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.equal('hub_unreachable');
    });
});

// ======================================================
// T4 — unknown/invalid request handling
// ======================================================
// NOTE: these cases exercise the provider passthrough; the dispatcher
// validation runs against the REAL gpu-dispatcher (no stub) since it is
// part of the frozen Job Protocol surface the provider rides.
describe('provider invalid request handling (frozen dispatcher validation)', () => {
    it('missing dispatch_id hits the sendUnified validation (dispatch_id is required)', async () => {
        let err;
        try {
            await provider.generate({ jobId: 'j', workflow: {}, jobType: 'audio', buildId: 'b' });
        } catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.include('dispatch_id is required');
    });

    it('unknown job_type hits the frozen dispatcher validation (Invalid job type)', async () => {
        let err;
        try {
            await provider.generate({ jobId: 'b_c_s_x:audio', workflow: {}, jobType: 'unknown_media', buildId: 'b', dispatchId: 'd' });
        } catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.include('Invalid job type');
    });
});

// ======================================================
// T5 — cancellation surface
// ======================================================
describe('cancellation does not pass through the provider (S-3 decision)', () => {
    it('the provider exposes no cancel surface — cancellation is owned by the dispatch engine', () => {
        // Job cancellation flows: dispatch-engine markers/leases + Hub queue
        // clear (runtime HTTP) — deliberately OUTSIDE the provider seam.
        expect(provider).to.not.have.property('cancel');
    });
});

// ======================================================
// T6 — semantic binding API (byte-identical node inputs)
// ======================================================
describe('semantic binding API (connector-driven workflow assembly)', () => {
    it('applyValue patches the bound node field via the connector', () => {
        const wf = provider.loadWorkflow(provider.WORKFLOW_NAMES.narration);
        expect(provider.applyValue(wf, provider.WORKFLOW_NAMES.narration, 'narrationText', 'строка')).to.equal(true);
        expect(wf['108'].inputs.target_text).to.equal('строка');
    });

    it('applyValue returns false without a connector (hard invariant, not a recoverable state)', () => {
        expect(provider.applyValue({}, 'workflow-without-connector', 'anyKey', 1)).to.equal(false);
    });

    // VOICE_REFERENCES.md: every speaker slot = LoadAudio(locked reference) → VoiceClonePrompt
    it('assembleMergedDialogueWorkflow: 1 speaker → slot 1 from its reference, slots 2–3 REMOVED, no VoiceDesign', () => {
        const wf = provider.assembleMergedDialogueWorkflow({
            script: 'berlioz: Привет.',
            defaultInstruct: 'instruct',
            speakers: [{ name: 'berlioz', referenceFile: 'vref_aa.wav', referenceText: 'Фраза.' }],
        });
        expect(wf['108'].inputs).to.deep.equal({ script: 'berlioz: Привет.', default_instruct: 'instruct' });
        expect(wf['71']).to.include({ class_type: 'LoadAudio' });
        expect(wf['71'].inputs.audio).to.equal('vref_aa.wav');
        expect(wf['73'].inputs.ref_text).to.equal('Фраза.');
        for (const id of ['80', '81', '82', '83']) expect(wf).to.not.have.property(id);
        expect(wf['74'].inputs).to.deep.equal({ role_name_1: 'berlioz', prompt_1: ['73', 0] });
        expect(Object.values(wf).map((n) => n.class_type)).to.not.include('Qwen3TTSVoiceDesign');
        expect(Object.values(wf).filter((n) => n.class_type === 'Qwen3TTSLoader').map((n) => n.inputs.model_repo))
            .to.deep.equal(['Qwen/Qwen3-TTS-12Hz-1.7B-Base']);
    });

    it('assembleMergedDialogueWorkflow wires all three slots; a speaker without a reference throws', () => {
        const sp = (n) => ({ name: n, referenceFile: `vref_${n}.wav`, referenceText: `t${n}` });
        const wf = provider.assembleMergedDialogueWorkflow({ script: 'a: x\nb: y\nc: z', defaultInstruct: '', speakers: [sp('a'), sp('b'), sp('c')] });
        expect([wf['71'].inputs.audio, wf['80'].inputs.audio, wf['82'].inputs.audio]).to.deep.equal(['vref_a.wav', 'vref_b.wav', 'vref_c.wav']);
        expect([wf['73'].inputs.ref_text, wf['81'].inputs.ref_text, wf['83'].inputs.ref_text]).to.deep.equal(['ta', 'tb', 'tc']);
        expect(wf['74'].inputs.role_name_3).to.equal('c');
        expect(wf['74'].inputs.prompt_3).to.deep.equal(['83', 0]);
        expect(() => provider.assembleMergedDialogueWorkflow({ script: 'a: x', defaultInstruct: '', speakers: [{ name: 'a' }] }))
            .to.throw(/voice reference required/);
        expect(provider.assembleMergedDialogueWorkflow({ script: '', defaultInstruct: '', speakers: [sp('a'), sp('b'), sp('c'), sp('d')] })).to.equal(null);
    });

    it('assembleNarrationWorkflow clones the chunk text from the narrator reference in the book language', () => {
        const wf = provider.assembleNarrationWorkflow({ text: 'Текст главы.', referenceFile: 'vref_n.wav', referenceText: 'Фраза.', language: 'German' });
        expect(wf['108']).to.include({ class_type: 'Qwen3TTSVoiceClone' });
        expect(wf['108'].inputs).to.include({ target_text: 'Текст главы.', target_language: 'German' });
        expect(wf['90'].inputs.audio).to.equal('vref_n.wav');
        expect(wf['91'].inputs.ref_text).to.equal('Фраза.');
        expect(wf['79'].inputs.model_repo).to.equal('Qwen/Qwen3-TTS-12Hz-1.7B-Base');
    });

    it('assembleVoiceReferenceWorkflow: VoiceDesign(description, phrase, seed) → SaveAudioAnimastorReference', () => {
        const wf = provider.assembleVoiceReferenceWorkflow({ description: 'Warm female.', phrase: 'Фраза шаблона.', language: 'Russian', seed: 42, filenamePrefix: 'voices/anna/c1' });
        expect(wf['71'].inputs).to.include({ voice_instruction: 'Warm female.', text: 'Фраза шаблона.', language: 'Russian', seed: 42 });
        expect(wf['1009']).to.include({ class_type: 'SaveAudioAnimastorReference' });
        expect(wf['1009'].inputs).to.include({ language: 'Russian', whisper_model: 'small', filename_prefix: 'voices/anna/c1' });
    });

    it('profileNameFromConnector reads the per-type profile field', () => {
        expect(provider.profileNameFromConnector({ profile: { audioProfile: 'qwen-tts' } }, 'audio')).to.equal('qwen-tts');
        expect(provider.profileNameFromConnector({}, 'video')).to.equal(null);
    });
});
