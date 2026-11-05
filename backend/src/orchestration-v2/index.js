// ======================================================
// orchestration-v2 — composition of the gen core into the backend host
// ======================================================
// ADR animastor-docs architecture/ORCHESTRATION_V2.md (этап 1: только аудио,
// только книги books.orchestration='v2').
//
// Master flag ORCH_V2_ENABLED (unset / not 1|true = OFF): nothing of v2 runs —
// no migration, no sweeper, no local runner, the /internal/gen/* routes answer
// 503 and v2 books refuse generation commands (409 orch_v2_disabled).
// ON: requires ORCH_V2_UPLOAD_SECRET (>= 32 bytes) and the ffmpeg binary
// (silence check + merge); missing either → logged, v2 stays OFF.
//
// The legacy isolation predicate (book-flag) works regardless of the flag:
// legacy never touches a v2 book.

'use strict';

const { spawnSync } = require('child_process');
const bookFlag = require('./book-flag');
const { createAudioPorts } = require('./audio-ports');
const { createProgressAdapter } = require('./progress-adapter');

function flagOn(v) { return v === '1' || v === 'true' || v === 'yes'; }

function hasFfmpeg(bin = 'ffmpeg') {
    try { return spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 10_000 }).status === 0; } catch (_) { return false; }
}

/**
 * @param {object} o
 * @param {object} o.env             process.env
 * @param {Function} o.getPool       () => pg Pool (storage/postgres/database.getPool)
 * @param {object} o.redis
 * @param {object} o.layerConfig     services/layer-config (get(redis, bookId))
 * @param {object} o.gpuDispatcher   runtime/gpu-dispatcher (lane lookups) — injected, never required here
 * @param {object} o.book            vbook-runtime facade (loadBook / collectScenes) — injected
 * @param {object} o.publishProgress services/progress-pubsub.publishProgress
 * @param {string} o.outputDir
 * @param {Function} [o.log]
 * @param {object} [o.gen]           @animastor/orchestration .gen (test override)
 * @param {object} [o.portOverrides] (tests)
 */
function createOrchV2Host(o) {
    const env = o.env || process.env;
    const log = o.log || ((m) => console.log(m));
    const state = { enabled: false, reason: 'not_started', orch: null, listener: null, started: false };

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
        const audio = createAudioPorts({ log, deps: { book: o.book, ...((o.portOverrides && o.portOverrides.audioDeps) || {}) } });
        const dispatcher = o.gpuDispatcher;           // injected by the composition root (provider-seam guard)
        if (!dispatcher) throw new Error('orchestration v2: gpuDispatcher (lane lookups) is not injected');
        const ports = {
            planUnits: audio.planUnits,
            buildPayload: audio.buildPayload,
            artifactPath: audio.artifactPath,
            runLocal: audio.runLocal,
            onArtifactPlaced: audio.onArtifactPlaced,
            validateResult: gen.defaults.createDefaultValidateResult({
                rmsThresholdDbfs: Number.isFinite(Number(env.ORCH_V2_SILENCE_DBFS)) && env.ORCH_V2_SILENCE_DBFS !== undefined && env.ORCH_V2_SILENCE_DBFS !== ''
                    ? Number(env.ORCH_V2_SILENCE_DBFS) : gen.media.DEFAULT_RMS_THRESHOLD_DBFS,
            }),
            laneFor: gen.defaults.makeLaneFor({
                hasActivePrivateWorker: (ws, type) => dispatcher.workspaceHasPrivateWorker(ws, type),
                grantPolicyLane: (ws, type) => dispatcher.workspaceGrantPolicyLane(ws, type),
            }),
            timeoutFor: gen.defaults.timeoutFor,
            retryPolicy: gen.defaults.retryPolicy,
            isLayerEnabled: async (bookId, layer) => {
                const cfg = await o.layerConfig.get(o.redis, bookId);
                return cfg[`${layer}_enabled`] !== false;
            },
            ...((o.portOverrides && o.portOverrides.ports) || {}),
        };
        state.orch = gen.createOrchestration({
            pool, ports, uploadSecret: secret, outputDir: o.outputDir, sharedLimit: null,
            maxUploadBytes, logger: console,
        });
        state.progress = createProgressAdapter({ orch: state.orch, book: o.book });
        if (o.publishProgress && o.redis) {
            state.listener = await state.orch.listenProgress((evt) => {
                state.progress.onNotify(evt, (bookId, payload) => o.publishProgress(o.redis, bookId, payload)).catch(() => {});
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

    async function stop() {
        if (state.orch) state.orch.stop();
        if (state.listener) { try { await state.listener.close(); } catch (_) { /* pool closing */ } state.listener = null; }
    }

    return {
        start,
        stop,
        isEnabled: () => state.enabled,
        disabledReason: () => state.reason,
        orch: () => state.orch,
        progress: () => state.progress,
        uploadUrl: (jobId, attempt) => `${publicBaseUrl}/internal/gen/jobs/${jobId}/result?attempt=${attempt}`,
        errorUrl: (jobId, attempt) => `${publicBaseUrl}/internal/gen/jobs/${jobId}/error?attempt=${attempt}`,
        maxUploadBytes,
        isV2Book: bookFlag.isV2BookFailClosed,
        bookFlag,
    };
}

module.exports = { createOrchV2Host, hasFfmpeg };
