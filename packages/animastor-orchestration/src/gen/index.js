// ======================================================
// @animastor/orchestration · gen — orchestration v2 core (1.1.0)
// ======================================================
// ADR: animastor-docs architecture/ORCHESTRATION_V2.md. The single source of
// truth is PG (gen_commands, gen_jobs). This namespace depends ONLY on the
// pg pool handed in by the host and on the host ports (ports.js). It never
// requires src/legacy, Redis, Express or ComfyUI.
//
//   const { gen } = require('@animastor/orchestration');
//   await gen.migrate(pool);
//   const orch = gen.createOrchestration({ pool, ports, uploadSecret, outputDir });
//   orch.createCommand(...), orch.cancel(...), orch.purgeBook(bookId), orch.claim(...), orch.acceptResult(...),
//   orch.acceptError(...), orch.beacon(...), orch.sweepOnce(), orch.startSweeper(ms),
//   orch.stop(), orch.progress(bookId), orch.listenProgress(fn), orch.runLocalOnce()

'use strict';

const { migrate, MIGRATIONS } = require('./sql');
const portsMod = require('./ports');
const media = require('./validate-media');
const util = require('./util');
const { createCommands, purgeBookRows } = require('./commands');
const { createClaim } = require('./claim');
const { createAccept } = require('./accept');
const { createSweeper } = require('./sweeper');
const { createProgress } = require('./progress');
const { createLocalRunner } = require('./local-runner');

/**
 * @param {object} o
 * @param {{connect:Function, query:Function}} o.pool  pg Pool supplied by the host
 * @param {object} o.ports                             host ports (see ports.js)
 * @param {string|Buffer} o.uploadSecret                HMAC secret for upload tokens (>= 32 bytes)
 * @param {string} [o.outputDir]                        root of {build}/.incoming (sweeper cleanup)
 * @param {number|null} [o.sharedLimit=null]            §10; NULL = off
 * @param {number} [o.offlineAfterMs=60000]             §9 п.2
 * @param {number} [o.incomingMaxAgeMs=3600000]         §9 п.4
 * @param {number} [o.tokenGraceMs=900000]              upload token validity after the deadline
 * @param {number} [o.maxUploadBytes]
 * @param {object} [o.logger=console]
 */
function createOrchestration(o = {}) {
    const { pool } = o;
    if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
        throw new util.GenError('bad_config', 500, 'pool (pg Pool) is required');
    }
    const secret = o.uploadSecret;
    if (!(typeof secret === 'string' || Buffer.isBuffer(secret)) || Buffer.byteLength(secret) < 32) {
        throw new util.GenError('bad_config', 500, 'uploadSecret must be at least 32 bytes');
    }
    if (o.sharedLimit != null && !(Number.isInteger(o.sharedLimit) && o.sharedLimit >= 0)) {
        throw new util.GenError('bad_config', 500, 'sharedLimit must be null or an integer >= 0');
    }
    const ports = portsMod.validatePorts(o.ports);
    const logger = o.logger || console;

    const accept = createAccept({ pool, ports, uploadSecret: secret, maxUploadBytes: o.maxUploadBytes });
    const commands = createCommands({ pool, ports });
    const claim = createClaim({ pool, ports, uploadSecret: secret, accept, sharedLimit: o.sharedLimit ?? null, tokenGraceMs: o.tokenGraceMs });
    const sweeper = createSweeper({ pool, accept, outputDir: o.outputDir || null, offlineAfterMs: o.offlineAfterMs, incomingMaxAgeMs: o.incomingMaxAgeMs, logger });
    const progress = createProgress({ pool });
    const local = createLocalRunner({ pool, ports, accept, logger });

    return Object.freeze({
        createCommand: commands.createCommand,
        cancel: commands.cancel,
        purgeBook: commands.purgeBook,
        claim: claim.claim,
        beacon: claim.beacon,
        acceptResult: accept.acceptResult,
        acceptError: accept.acceptError,
        sweepOnce: sweeper.sweepOnce,
        startSweeper: sweeper.startSweeper,
        stopSweeper: sweeper.stopSweeper,
        runLocalOnce: local.runLocalOnce,
        startLocalRunner: local.startLocalRunner,
        stopLocalRunner: local.stopLocalRunner,
        progress: progress.progress,
        listenProgress: progress.listenProgress,
        /** stop every timer this instance started */
        stop() { sweeper.stopSweeper(); local.stopLocalRunner(); },
    });
}

module.exports = Object.freeze({
    createOrchestration,
    migrate,
    /** purgeBook(pool, bookId) — book deletion without an instance */
    purgeBook: purgeBookRows,
    MIGRATIONS,
    validatePorts: portsMod.validatePorts,
    REQUIRED_PORTS: portsMod.REQUIRED_PORTS,
    OPTIONAL_PORTS: portsMod.OPTIONAL_PORTS,
    defaults: Object.freeze({
        ...portsMod.defaults,
        createDefaultValidateResult: media.createDefaultValidateResult,
        createAudioValidator: media.createAudioValidator,
        createPngValidator: media.createPngValidator,
    }),
    media: Object.freeze({
        inspectMp3: media.inspectMp3,
        rmsDbfs: media.rmsDbfs,
        ffmpegDecodePcm: media.ffmpegDecodePcm,
        DEFAULT_RMS_THRESHOLD_DBFS: media.DEFAULT_RMS_THRESHOLD_DBFS,
        inspectPng: media.inspectPng,
        DEFAULT_MIN_LUMA_STDDEV: media.DEFAULT_MIN_LUMA_STDDEV,
    }),
    GenError: util.GenError,
    PROGRESS_CHANNEL: util.PROGRESS_CHANNEL,
});
