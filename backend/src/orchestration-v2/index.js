// ======================================================
// orchestration-v2 — composition of the gen core into the backend host
// ======================================================
// ADR animastor-docs architecture/ORCHESTRATION_V2.md (этап 1: аудио; этап 2a:
// изображения IU; этап 3: видео — video_group + video_merge; этап 4 — все книги).
//
// Ports are routed by job kind EXPLICITLY (PORT_OF_KIND); an unknown kind is a
// deterministic error, never the audio port. Video needs core >= 1.3.0 (ctx.db
// for the planner, input files, merge_parts); an older core → the video layer is
// refused (409 v2_video_unavailable), audio / image unaffected.
//
// Image layer (2a) is fail-closed: it is refused (409 at the command) when the
// gen core lacks the 1.1.0 PNG check. (The IU_IMAGE_VERSIONED refusal is gone
// with the versioned pointer layer — 2026-11-28, этап 4.)
//
// Master flag ORCH_V2_ENABLED (unset / not 1|true = OFF): nothing of v2 runs —
// no migration, no sweeper, no local runner, the /internal/gen/* routes answer
// 503 and v2 books refuse generation commands (409 orch_v2_disabled).
// ON: requires ORCH_V2_UPLOAD_SECRET (>= 32 bytes) and the ffmpeg binary
// (silence check + merge); missing either → logged, v2 stays OFF.
//
// Since 2026-11-28 (этап 4) every book is on v2: there is no legacy/v2 split
// predicate any more (book-flag removed).

'use strict';

const { spawnSync } = require('child_process');
const { createAudioPorts } = require('./audio-ports');
const { createImagePorts } = require('./image-ports');
const { createVideoPorts } = require('./video-ports');
const { createVoicePorts } = require('./voice-ports');
const { createVoiceReferences } = require('../audio/voice-references');

/** job kind → the host port family that owns it (ADR §5). */
const PORT_OF_KIND = Object.freeze({
    audio_chunk: 'audio', audio_merge: 'audio',
    iu_image: 'image',
    video_group: 'video', video_merge: 'video',
    voice_reference: 'voice',        // 1.4.0 — VOICE_REFERENCES.md
});
function unknownKind(kind) {
    return Object.assign(new Error(`orchestration v2: unknown job kind ${JSON.stringify(kind)}`), { error_class: 'deterministic' });
}
const { createProgressAdapter } = require('./progress-adapter');
const { createProgressHub } = require('./progress-hub');

function flagOn(v) { return v === '1' || v === 'true' || v === 'yes'; }

function hasFfmpeg(bin = 'ffmpeg') {
    try { return spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 10_000 }).status === 0; } catch (_) { return false; }
}

/**
 * @param {object} o
 * @param {object} o.env             process.env
 * @param {Function} o.getPool       () => pg Pool (storage/postgres/database.getPool)
 * @param {object} o.redis
 * @param {object} o.layerConfig     services/layer-config (get(bookId), PG)
 * @param {object} o.gpuDispatcher   runtime/gpu-dispatcher (lane lookups) — injected, never required here
 * @param {object} o.book            vbook-runtime facade (loadBook / collectScenes) — injected
 * @param {boolean} [o.listen]     false → no LISTEN gen_progress (tests drive hub.onNotify)
 * @param {number[]} [o.listenDelaysMs] re-LISTEN pauses after a lost connection (tests; core default 1→2→5→10→30 s)
 * @param {string} o.outputDir
 * @param {Function} [o.log]
 * @param {object} [o.gen]           @animastor/orchestration .gen (test override)
 * @param {object} [o.portOverrides] (tests)
 */
function createOrchV2Host(o) {
    const env = o.env || process.env;
    const log = o.log || ((m) => console.log(m));
    const state = { enabled: false, reason: 'not_started', orch: null, listener: null, started: false };
    // VOICE_REFERENCES.md: the voice-reference store of the content folder (OUTPUT_DIR/build_<id>/voices)
    state.voiceRefs = o.outputDir ? createVoiceReferences({ outputDir: o.outputDir, log }) : null;

    const requested = flagOn(String(env.ORCH_V2_ENABLED || '').toLowerCase());
    const secret = env.ORCH_V2_UPLOAD_SECRET || '';
    if (!requested) state.reason = 'ORCH_V2_ENABLED is off';
    else if (Buffer.byteLength(secret) < 32) state.reason = 'ORCH_V2_UPLOAD_SECRET missing or shorter than 32 bytes';
    else if (!(o.hasFfmpeg || hasFfmpeg)()) state.reason = 'ffmpeg binary not found (silence check / merge)';
    else state.reason = null;

    const publicBaseUrl = String(env.ORCH_V2_PUBLIC_URL || 'https://animastor.org').replace(/\/+$/, '');
    const maxUploadBytes = Number(env.ORCH_V2_MAX_UPLOAD_BYTES) > 0 ? Number(env.ORCH_V2_MAX_UPLOAD_BYTES) : 512 * 1024 * 1024;

    async function start() {
        if (state.started) return state;
        state.started = true;
        if (state.reason) {
            log(`[ORCH-V2] disabled: ${state.reason}`);
            return state;
        }
        const gen = o.gen || require('@animastor/orchestration').gen;
        const pool = o.getPool();
        await gen.migrate(pool);
        const voiceRefs = (o.portOverrides && o.portOverrides.voiceRefs) || state.voiceRefs;
        const audio = createAudioPorts({ log, deps: { book: o.book, voiceRefs, ...((o.portOverrides && o.portOverrides.audioDeps) || {}) } });
        const voice = createVoicePorts({ log, deps: { book: o.book, voiceRefs, outputDir: o.outputDir, ...((o.portOverrides && o.portOverrides.voiceDeps) || {}) } });
        const image = createImagePorts({ log, deps: { book: o.book, ...((o.portOverrides && o.portOverrides.imageDeps) || {}) } });
        const video = createVideoPorts({ log, deps: { book: o.book, imagePorts: image, ...((o.portOverrides && o.portOverrides.videoDeps) || {}) } });
        state.coreHasPngCheck = !!(gen.media && typeof gen.media.inspectPng === 'function');
        const families = { audio, image, video, voice };
        const byKind = (kind) => {
            const f = PORT_OF_KIND[kind];
            if (!f) throw unknownKind(kind);
            return families[f];
        };
        const dispatcher = o.gpuDispatcher;           // injected by the composition root (provider-seam guard)
        if (!dispatcher) throw new Error('orchestration v2: gpuDispatcher (lane lookups) is not injected');
        const numEnv = (name, dflt) => (env[name] !== undefined && env[name] !== '' && Number.isFinite(Number(env[name])) ? Number(env[name]) : dflt);
        const ports = {
            planUnits: async (bookRef, scope, layer, planCtx) => {
                // 1.4.0: a voice_reference command plans voice candidates only
                if (planCtx && planCtx.kind === 'voice_reference') return voice.planUnits(bookRef, scope, layer);
                if (layer === 'audio') return audio.planUnits(bookRef, scope, layer);
                if (layer === 'image') {
                    const why = imageUnsupportedReason();
                    if (why) throw Object.assign(new Error(`image layer unavailable: ${why}`), { status: 409, code: 'v2_image_unavailable' });
                    return image.planUnits(bookRef, scope, layer);
                }
                if (layer === 'video') {
                    const why = videoUnsupportedReason();
                    if (why) throw Object.assign(new Error(`video layer unavailable: ${why}`), { status: 409, code: 'v2_video_unavailable' });
                    return video.planUnits(bookRef, scope, layer, planCtx);
                }
                throw Object.assign(new Error(`orchestration v2: unknown layer ${JSON.stringify(layer)}`), { status: 400, code: 'bad_request' });
            },
            buildPayload: (job) => byKind(job.kind).buildPayload(job),
            artifactPath: (job) => byKind(job.kind).artifactPath(job),
            runLocal: (job) => {
                const f = byKind(job.kind);
                if (typeof f.runLocal !== 'function') throw unknownKind(job.kind);
                return f.runLocal(job);
            },
            onArtifactPlaced: (job, finalPath, ctx) => byKind(job.kind).onArtifactPlaced(job, finalPath, ctx),
            inputFiles: (job) => byKind(job.kind).inputFiles ? byKind(job.kind).inputFiles(job) : [],
            validateResult: gen.defaults.createDefaultValidateResult({
                rmsThresholdDbfs: numEnv('ORCH_V2_SILENCE_DBFS', gen.media.DEFAULT_RMS_THRESHOLD_DBFS),
                minLumaStddev: numEnv('ORCH_V2_MIN_LUMA_STDDEV', gen.media.DEFAULT_MIN_LUMA_STDDEV),
            }),
            laneFor: gen.defaults.makeLaneFor({
                hasActivePrivateWorker: (ws, type) => dispatcher.workspaceHasPrivateWorker(ws, type),
                grantPolicyLane: (ws, type) => dispatcher.workspaceGrantPolicyLane(ws, type),
            }),
            timeoutFor: gen.defaults.timeoutFor,
            retryPolicy: gen.defaults.retryPolicy,
            isLayerEnabled: async (bookId, layer) => {
                const cfg = await o.layerConfig.get(bookId);
                return cfg[`${layer}_enabled`] !== false;
            },
            ...((o.portOverrides && o.portOverrides.ports) || {}),
        };
        state.coreHasVideo = gen.MIGRATIONS.some((m) => m.id === '004-command-skips');
        state.orch = gen.createOrchestration({
            pool, ports, uploadSecret: secret, outputDir: o.outputDir, sharedLimit: null,
            maxUploadBytes, logger: console,
        });
        state.progress = createProgressAdapter({ orch: state.orch, book: o.book });
        // ADR §4.3 / §9 (2026-11-27): progress goes ONLY through PG NOTIFY. One
        // LISTEN gen_progress per process; the hub fans events out to the SSE
        // clients of the book in process (/generate/stream, /progress-stream).
        // No Redis pub/sub on this path.
        state.hub = createProgressHub({
            aggregate: (bookId) => state.progress.aggregate(bookId),
            legacyEvents: (evt, publish) => state.progress.onNotify(evt, publish),
            coalesceMs: Number(env.ORCH_V2_PROGRESS_COALESCE_MS) >= 0 && env.ORCH_V2_PROGRESS_COALESCE_MS !== undefined && env.ORCH_V2_PROGRESS_COALESCE_MS !== ''
                ? Number(env.ORCH_V2_PROGRESS_COALESCE_MS) : undefined,
        });
        if (o.listen !== false) {
            // @animastor/orchestration >= 1.4.3: the listener survives a lost PG
            // connection (re-LISTEN with 1→2→5→10→30 s pauses); one log line per
            // drop and one per recovery; on recovery every subscriber gets the
            // current state (NOTIFYs sent while it was down are not lost for the UI).
            // An older core ignores the second argument (no reconnect).
            state.listener = await state.orch.listenProgress((evt) => state.hub.onNotify(evt), {
                onDisconnect: (err) => console.warn(`[ORCH-V2] progress LISTEN lost: ${(err && err.message) || 'connection ended'} — reconnecting`),
                onReconnect: () => {
                    const n = state.hub.resync();
                    console.log(`[ORCH-V2] progress LISTEN restored — fresh progress sent for ${n} book(s)`);
                },
                ...(o.listenDelaysMs ? { delaysMs: o.listenDelaysMs } : {}),
            });
        }
        if (o.timers !== false) {
            state.orch.startSweeper(Number(env.ORCH_V2_SWEEP_MS) > 0 ? Number(env.ORCH_V2_SWEEP_MS) : 10_000);
            state.orch.startLocalRunner(2_000);
        }
        state.enabled = true;
        log(`[ORCH-V2] enabled: migration applied, sweeper + local runner started (upload base ${publicBaseUrl})`);
        return state;
    }

    /** null when v2 may run the image layer, otherwise the reason (fail-closed). */
    function imageUnsupportedReason() {
        if (!state.enabled && state.reason) return state.reason;
        if (state.coreHasPngCheck === false) return '@animastor/orchestration < 1.1.0 (no PNG check)';
        return null;
    }

    /** null when v2 may run the video layer, otherwise the reason (fail-closed). */
    function videoUnsupportedReason() {
        if (!state.enabled && state.reason) return state.reason;
        if (state.coreHasVideo === false) return '@animastor/orchestration < 1.3.0 (no video stage)';
        return null;
    }

    async function stop() {
        if (state.orch) state.orch.stop();
        if (state.hub) state.hub.stop();
        if (state.listener) { try { await state.listener.close(); } catch (_) { /* pool closing */ } state.listener = null; }
    }

    return {
        start,
        stop,
        isEnabled: () => state.enabled,
        disabledReason: () => state.reason,
        imageUnsupportedReason,
        videoUnsupportedReason,
        orch: () => state.orch,
        voiceRefs: () => state.voiceRefs,
        progress: () => state.progress,
        progressHub: () => state.hub || null,
        /** the LISTEN handle (connected(), pid() with core >= 1.4.3) — diagnostics / tests */
        progressListener: () => state.listener || null,
        /** {book_id, force, status} of a command (null: unknown) — /generate/stop {command_id} never stops another book's command. */
        commandRow: async (commandId) => {
            const r = await o.getPool().query('SELECT book_id, force, status FROM gen_commands WHERE command_id = $1', [commandId]);
            return r.rows[0] || null;
        },
        uploadUrl: (jobId, attempt) => `${publicBaseUrl}/internal/gen/jobs/${jobId}/result?attempt=${attempt}`,
        errorUrl: (jobId, attempt) => `${publicBaseUrl}/internal/gen/jobs/${jobId}/error?attempt=${attempt}`,
        inputUrl: (jobId, attempt, name) => `${publicBaseUrl}/internal/gen/jobs/${jobId}/input/${encodeURIComponent(name)}?attempt=${attempt}`,
        maxUploadBytes,
    };
}

module.exports = { createOrchV2Host, hasFfmpeg, PORT_OF_KIND };
