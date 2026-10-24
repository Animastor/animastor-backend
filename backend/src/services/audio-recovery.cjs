// ======================================================
// ANIMASTOR BACKEND — AUDIO RECOVERY SERVICE
// ======================================================
// Periodically scans Redis for pending audio/image results
// and recovers them to disk.

const path = require('path');
// S-4: filename grammar composed from the canonical owner (bytes unchanged)
const artifactNaming = require('@animastor/generation').artifactNaming;
const fs = require('fs');
const qidem = require('../helpers/queue-idempotency.cjs');

/**
 * Publication-gate rejects (Stage 133): the result's generation cannot be
 * proven, so it may never be published — not by a retry either.
 */
function _isTerminalGateCode(code) {
    return qidem.FENCE_COMMIT_REJECTED.has(code) || qidem.FENCE_IDENTITY_REJECTED.has(code);
}

module.exports = function(redis, config, deps) {
    const { audio, image, state, book, orchestrator, taskHandler, getChunk, saveChunk, saveIURegistry } = deps;
    const { log } = deps.utils;

    /**
     * Scan-based replay (kept for the trigger-based CLI/operator contour).
     *
     * Stage 133 (audit 132 · B3): this loop used to write the canonical chunk
     * file and `audio_status: 'ready'` BEFORE calling the handler — a gated
     * reject (`missing_dispatch_id`) arrived after the bytes were published.
     * It now resolves every scene through the SAME gated per-scene path
     * (`recoverAudioForScene`): no file and no metadata is touched before the
     * fence is proven, and a result whose generation cannot be proven is left
     * in Redis for an operator instead of being replayed.
     *
     * Image results are handled by the reconciliation Phase A
     * (`recoverResultKeys`), which already requires dispatch identity.
     */
    async function recoverAudioResults() {
        try {
            const resultKeys = [];
            let cursor = 0;

            do {
                const result = await redis.scan(cursor, 'MATCH', 'animastor:result:*', 'COUNT', 200);
                cursor = parseInt(result[0], 10);
                resultKeys.push(...result[1]);
            } while (cursor !== 0);

            if (resultKeys.length === 0) return;

            for (const key of resultKeys) {
                // animastor:result:<buildId>:<bookId>:<chapterId>:<sceneId>:<type>
                const keyParts = String(key).split(':');
                if (keyParts.length < 7) continue;          // legacy key: no provable scene
                if (keyParts[6] !== 'audio') continue;       // images: reconciliation Phase A
                const [, , resultBuildId, bookId, chapterId, sceneId] = keyParts;
                if (!bookId || !chapterId || !sceneId) continue;
                try {
                    const out = await recoverAudioForScene(bookId, chapterId, sceneId, resultBuildId || 'default');
                    log(`🔁 Recovery ${bookId}/${chapterId}/${sceneId}: ${out.reason}`);
                } catch (itemErr) {
                    console.warn('⚠️ Failed to process recovery item:', itemErr.message);
                }
            }
        } catch (err) {
            console.error('❌ Audio recovery error:', err.message);
        }
    }

    /**
     * Per-scene audio recovery — trigger-based approach.
     * Filters results for a specific scene only, instead of scanning all keys.
     * Use this for manual/on-demand recovery when a callback was missed.
     *
     * Stage 133 (audit 132 · B3) — the fence gate comes FIRST:
     *
     *   1. the result must carry a dispatch identity (its own `dispatch_id`
     *      or an operator-supplied one);
     *   2. that dispatch must own an immutable receipt;
     *   3. only then are the bytes handed to the production handler, which
     *      stages them and publishes through the atomic fenced commit.
     *
     * A result that cannot be bound to a proven fence is NEVER written: the
     * old flow wrote the canonical file and `audio_status:'ready'` first and
     * only then learned from `handleTaskResult` that the identity was missing.
     *
     * @param {string} bookId
     * @param {string} chapterId
     * @param {string} sceneId
     * @param {string} [buildId='default']
     * @param {{dispatchId?:string}} [opts] operator-supplied dispatch identity
     * @returns {Promise<{recovered: boolean, reason: string, gated?: boolean}>}
     */
    async function recoverAudioForScene(bookId, chapterId, sceneId, buildId = 'default', opts = {}) {
        const sceneResultKey = `animastor:result:${buildId}:${bookId}:${chapterId}:${sceneId}:audio`;

        try {
            const raw = await redis.get(sceneResultKey);
            if (!raw) {
                return { recovered: false, reason: 'no_result_key' };
            }

            let job_id, result_base64, dispatch_id = null;

            if (raw.startsWith('{')) {
                try {
                    const data = JSON.parse(raw);
                    job_id = data.job_id;
                    result_base64 = data.result_base64;
                    dispatch_id = data.dispatch_id || null;
                } catch (e) {
                    return { recovered: false, reason: 'parse_failed' };
                }
            } else {
                // Direct data URL format — it carries no dispatch identity at
                // all, so it can never be bound to a generation (fail closed).
                result_base64 = raw;
                job_id = `${artifactNaming.scenePrefix(bookId, chapterId, sceneId)}:audio`;
            }

            if (opts && opts.dispatchId) dispatch_id = String(opts.dispatchId);

            if (!result_base64) {
                return { recovered: false, reason: 'no_result_data' };
            }
            if (!job_id) {
                return { recovered: false, reason: 'missing_job_id' };
            }

            // ── GATE (before ANY write) ────────────────────────────────
            if (!dispatch_id) {
                // Same class as an absent receipt: the result carries no proof
                // of its generation. Counted on the publication gate metric.
                qidem.observeFenceGateReject('receipt_missing');
                log(`⚠️ Recovery refused for ${bookId}/${chapterId}/${sceneId}: missing_dispatch_id (nothing written)`);
                return { recovered: false, reason: 'missing_dispatch_id', gated: true };
            }
            const resolution = await qidem.resolveDispatchFence(redis, { dispatchId: dispatch_id, jobId: job_id });
            if (resolution.status === 'error') {
                // Redis outage ≠ "no receipt": retryable, nothing written.
                return { recovered: false, reason: 'fence_lookup_unavailable', gated: true };
            }
            if (resolution.status !== 'ok') {
                const gateReason = resolution.status === 'corrupt' ? 'receipt_corrupt' : 'receipt_missing';
                qidem.observeFenceGateReject(gateReason);
                log(`⚠️ Recovery refused for ${bookId}/${chapterId}/${sceneId}: ${gateReason} (nothing written)`);
                return { recovered: false, reason: gateReason, gated: true };
            }
            const fence = resolution.fence;

            // Idempotency short-circuits (read-only checks; they only drop the
            // replay key of an already satisfied scene).
            const baseId = artifactNaming.scenePrefix(bookId, chapterId, sceneId);
            const buildDir = path.join(config.OUTPUT_DIR, buildId);
            const canonicalAudioPath = path.join(buildDir, `${baseId}.mp3`);

            if (fs.existsSync(canonicalAudioPath)) {
                log(`🔁 Audio already on disk: ${canonicalAudioPath} — cleaning up result key`);
                await redis.del(sceneResultKey);
                return { recovered: true, reason: 'already_on_disk' };
            }

            const chunkId = artifactNaming.sceneChunkAudioName(bookId, chapterId, sceneId, 1).replace(/\.mp3$/, '');
            const chunk = await getChunk(chunkId);
            if (chunk && chunk.audio && chunk.audio_status === 'ready') {
                log(`🔁 Audio already marked ready — cleaning up result key`);
                await redis.del(sceneResultKey);
                return { recovered: true, reason: 'already_ready' };
            }

            const sceneAudioReady = await audio.isSceneAudioReady(buildId, bookId, chapterId, sceneId);
            if (sceneAudioReady) {
                log(`🔁 Scene audio already ready — cleaning up result key`);
                await redis.del(sceneResultKey);
                return { recovered: true, reason: 'already_ready_pg' };
            }

            // Gated publication: the handler stages the bytes, commits the
            // fence atomically and only then renames them into the canonical
            // path + writes chunk/ready metadata. On a terminal reject nothing
            // was written and the replay key is dropped (it can never publish).
            try {
                await taskHandler.handleTaskResult(job_id, result_base64, buildId, dispatch_id, { fence });
            } catch (mergeErr) {
                const code = (mergeErr && mergeErr.code) || 'handler_failed';
                if (_isTerminalGateCode(code)) {
                    await redis.del(sceneResultKey);
                }
                log(`⚠️ Recovery handler rejected ${bookId}/${chapterId}/${sceneId}: ${code}`);
                return { recovered: false, reason: code, gated: true, detail: mergeErr.message };
            }

            await redis.del(sceneResultKey);
            log(`🔁 Audio recovered and processed: ${bookId}/${chapterId}/${sceneId}`);
            return { recovered: true, reason: 'success' };
        } catch (err) {
            console.error('❌ Audio recovery error:', err.message);
            return { recovered: false, reason: `error: ${err.message}` };
        }
    }

    return {
        recoverAudioResults,
        recoverAudioForScene,
    };
};
