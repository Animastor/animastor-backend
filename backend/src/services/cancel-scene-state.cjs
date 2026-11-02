// ======================================================
// Cancel → per-scene runtime state cleanup (GPU E2E 2026-11-02 §8 п.4)
// ======================================================
// `cancel-generation` (tombstone) and `cancelStage` (cancel-worker,
// layer-config X=false) released leases, dispatch metadata and hub lanes,
// but left the scene FSM records behind. The audio-orch record of a cancelled
// attempt (started_at=11:09) survived 75 minutes and the next command's
// healthy run was failed by the stall watchdog (`chunk_stall_timeout:4619s`).
//
// This routine removes, for the cancelled book / scenes / stages:
//
//   • `animastor:audio-orch:{book}:{ch}:{sc}` and `animastor:video-orch:…`
//     records of NON-terminal phases (PLACEHOLDER_READY, GENERATING,
//     WAITING_CHUNKS, MERGING, FAILED). A DONE record is kept — it describes
//     an accepted result, not work in flight;
//   • immutable dispatch receipts `animastor:dispatch-intent:{dispatch}:{job}`
//     of the cancelled jobs. A late result of a cancelled dispatch is then
//     rejected as `receipt_missing` (terminal, nothing written) instead of
//     being replayed by recovery.
//
// `dispatch-completed:*` markers are intentionally kept until their TTL —
// they let late callbacks be recognised as finalized (dispatch-engine).
// Best effort: every Redis error is counted, never thrown — a cancel must
// not fail on cleanup.
// ======================================================

'use strict';

const jobSchema = require('../runtime/job-schema');
const mediaRegistry = require('@animastor/generation').mediaRegistry;
const qidem = require('../helpers/queue-idempotency.cjs');

const ORCH_PREFIX = { audio: 'animastor:audio-orch', video: 'animastor:video-orch' };
const TERMINAL_PHASES = new Set(['DONE']);

async function scanKeys(redis, pattern) {
    const keys = [];
    let cursor = '0';
    do {
        const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = String(next);
        keys.push(...(batch || []));
    } while (cursor !== '0');
    return keys;
}

function sceneKeyOf(chapterId, sceneId) {
    return `${chapterId}:${sceneId}`;
}

/**
 * @param {object} redis
 * @param {string} bookId
 * @param {object} [opts]
 * @param {string[]|null} [opts.stages]  — stages to clean (default: all media)
 * @param {Array<{chapter_id:string, scene_id:string}>|null} [opts.scenes]
 *        — null = the whole book
 * @returns {Promise<{orchDeleted:number, receiptsDeleted:number, errors:number}>}
 */
async function clearCancelledSceneState(redis, bookId, { stages = null, scenes = null } = {}) {
    const out = { orchDeleted: 0, receiptsDeleted: 0, errors: 0 };
    if (!redis || !bookId || typeof redis.scan !== 'function') return out;
    const stageSet = new Set(stages && stages.length ? stages : mediaRegistry.listMediaTypes());
    const sceneSet = Array.isArray(scenes) ? new Set(scenes.map(s => sceneKeyOf(s.chapter_id, s.scene_id))) : null;

    // 1. FSM records (audio/video only — image has no orchestrator record).
    for (const stage of Object.keys(ORCH_PREFIX)) {
        if (!stageSet.has(stage)) continue;
        const prefix = `${ORCH_PREFIX[stage]}:${bookId}:`;
        let keys = [];
        try {
            if (sceneSet) {
                keys = [...sceneSet].map(k => `${prefix}${k}`);
            } else {
                keys = await scanKeys(redis, `${prefix}*`);
            }
        } catch (_) {
            out.errors++;
            continue;
        }
        for (const key of keys) {
            // The book id may itself contain ':' only in theory — require the
            // exact `{prefix}{chapter}:{scene}` shape (two components).
            const rest = key.slice(prefix.length);
            if (rest.split(':').length !== 2) continue;
            try {
                const raw = await redis.get(key);
                if (!raw) continue;
                let phase = null;
                try { phase = JSON.parse(raw).phase; } catch (_) { phase = null; }
                if (phase && TERMINAL_PHASES.has(phase)) continue;
                await redis.del(key);
                out.orchDeleted++;
            } catch (_) {
                out.errors++;
            }
        }
    }

    // 2. Dispatch receipts of the cancelled jobs. Keys are
    //    `{IDEM_RECEIPT_PREFIX}{enc(dispatch)}:{enc(job)}`; the job id is
    //    parsed and its book compared EXACTLY (no prefix guessing).
    let receiptKeys = [];
    try {
        receiptKeys = await scanKeys(redis, `${qidem.IDEM_RECEIPT_PREFIX}*`);
    } catch (_) {
        out.errors++;
        receiptKeys = [];
    }
    for (const key of receiptKeys) {
        const rest = key.slice(qidem.IDEM_RECEIPT_PREFIX.length);
        const sep = rest.indexOf(':');
        if (sep <= 0) continue;
        let jobId;
        try { jobId = decodeURIComponent(rest.slice(sep + 1)); } catch (_) { continue; }
        const parsed = jobSchema.parseJobId(jobId);
        if (!parsed || parsed.bookId !== bookId) continue;
        const stage = jobSchema.STAGE_BY_KIND[parsed.kind];
        if (!stage || !stageSet.has(stage)) continue;
        if (sceneSet && !sceneSet.has(sceneKeyOf(parsed.chapterId, parsed.sceneId))) continue;
        try {
            await redis.del(key);
            out.receiptsDeleted++;
        } catch (_) {
            out.errors++;
        }
    }
    return out;
}

module.exports = { clearCancelledSceneState };
