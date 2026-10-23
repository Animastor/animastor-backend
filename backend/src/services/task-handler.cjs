// ======================================================
// ANIMASTOR BACKEND — TASK HANDLER
// ======================================================
// GPU task result handling, audio merge, and book snapshot
// management.

const path = require('path');
const fs = require('fs');
const { publishProgress } = require('./progress-pubsub.cjs');
const jobSchema = require('../runtime/job-schema');
// S-4: filename grammar composed from the canonical owner (bytes unchanged)
const artifactNaming = require('@animastor/generation').artifactNaming;

module.exports = function(redis, config, deps) {
    const { audio, image, video, state, book, orchestrator, activeScenes, placeholderAudio, cleanupService, utils, bookDiff } = deps;
    const { log } = utils;
    const { resolveAssetPath } = cleanupService;
    const OUTPUT_DIR = config.OUTPUT_DIR;
    const queueIdempotency = require('../helpers/queue-idempotency.cjs');
    const resultPublication = require('./result-publication.cjs');
    // AUDIO_MERGE_RETRY_* removed (T7) — now in audioOrch.completeChunk

    /** Fence-commit verdicts after which the staged bytes may be published. */
    const FENCED_PUBLISHED = new Set(['committed', 'duplicate_same_fence']);
    // NOTE: terminal fence verdicts (stale_intent / intent_missing /
    // intent_corrupt / invalid_fence) are classified by the ROUTE via
    // queue-idempotency.FENCE_COMMIT_REJECTED — the single source of truth
    // shared with the commit script. This file throws them with `err.code`.

    // ── Handle GPU task result ────────────────────────
    async function handleTaskResult(job_id, result_base64, build_id, dispatch_id, opts = {}) {
        log('🎬 Handling task result:', job_id, 'build:', build_id);

        // Единый разбор job_id (runtime/job-schema.js)
        const parsed = jobSchema.parseJobId(job_id);
        const stage = parsed ? jobSchema.STAGE_BY_KIND[parsed.kind] : null;
        if (!parsed || !stage) {
            throw new Error(`Invalid job_id: ${job_id}`);
        }

        const dispatchEngine = require('@animastor/orchestration').runtime.dispatch;
        const identity = await dispatchEngine.verifyDispatchIdentity(
            redis,
            parsed.bookId,
            parsed.chapterId,
            parsed.sceneId,
            stage,
            dispatch_id
        );
        if (!identity.valid) {
            // 🔧 FIX: Allow stale dispatch for audio chunks if scene is still
            // in WAITING_CHUNKS (batch dispatch reorder: dialogue chunks come later).
            // VIDEO: то же самое — группы сцены приходят последовательно, и после
            // re-dispatch (FAILED → scheduler) поздние группы от старого dispatch
            // должны приниматься, пока video-orch в WAITING_CHUNKS/MERGING.
            if ((stage === 'audio' || stage === 'video') && identity.reason === 'stale_dispatch') {
                const orchMod = stage === 'audio' ? require('./audio-orchestrator') : require('./video-orchestrator');
                const orchState = await orchMod.getState(redis, parsed.bookId, parsed.chapterId, parsed.sceneId);
                if (orchState && (orchState.phase === orchMod.PHASES.WAITING_CHUNKS || orchState.phase === orchMod.PHASES.MERGING)) {
                    log(`Stale dispatch accepted for ${stage} chunk ${parsed.assetId} (scene still ${orchState.phase})`);
                } else {
                    const err = new Error(`Rejected task result: ${identity.reason} (scene phase=${orchState?.phase || 'none'})`);
                    err.code = identity.reason;
                    throw err;
                }
            } else {
                const err = new Error(`Rejected task result: ${identity.reason}`);
                err.code = identity.reason;
                throw err;
            }
        }

        // Resolve asset path
        const asset = resolveAssetPath(job_id, build_id);
        if (!asset) {
            console.warn('⚠️ Unknown asset type for job_id:', job_id);
            return null;
        }

        log('📁 Resolved asset:', asset.type, '→', asset.fullPath);
        const outputDir = path.dirname(asset.fullPath);

        // Strip data URL prefix if present (e.g. "data:audio/mp3;base64,")
        const cleanBase64 = result_base64.includes(',')
            ? result_base64.split(',')[1]
            : result_base64;
        const resultBuffer = Buffer.from(cleanBase64, 'base64');

        // ── Stage 131 — staged artifacts & fenced commit ──────────────────
        // The fence of THIS callback: the immutable dispatch receipt
        // (Stage 127, written atomically BEFORE the hub POST) is
        // authoritative; the caller (result route) may pass its own
        // resolution in opts.fence. A result with NO fence evidence (a
        // legacy dispatch without a receipt — e.g. the audio-recovery replay
        // that carries no dispatch_id) keeps the legacy direct-write path
        // below: it stays gated by verifyDispatchIdentity exactly as before
        // (fencing rollout observe mode, contract 126 §5 phase 1).
        const fencingMode = typeof config.resultFencingMode === 'function'
            ? config.resultFencingMode()
            : String(config.RESULT_FENCING_MODE || 'observe');
        let fence = opts.fence ? String(opts.fence) : null;
        if (!fence && dispatch_id) {
            fence = await queueIdempotency.readDispatchReceipt(redis, dispatch_id, job_id);
        }

        let commitStatus = null;
        if (fence && fencingMode !== 'off') {
            // NEW results go to staging first. The canonical artifact path
            // is only replaced after the ATOMIC fence commit confirms this
            // fence is still the current, active intent (Redis Lua —
            // queue-idempotency.fenceCommitResult). A stale / missing /
            // corrupt intent discards ONLY this fence's staged bytes and
            // throws a terminal error: no metadata, no ready, no canonical.
            // A failed staged→canonical rename throws `publish_failed` —
            // never a false success; the retry/resume replays the rename.
            const publication = await resultPublication.commitFencedResult(redis, config, {
                bookId: parsed.bookId,
                chapterId: parsed.chapterId,
                sceneId: parsed.sceneId,
                jobId: job_id,
                buildId: build_id,
                fence,
                buffer: resultBuffer,
                extension: `.${asset.extension}`,
                canonicalPath: asset.fullPath,
            });
            commitStatus = publication.status;
            if (!FENCED_PUBLISHED.has(commitStatus)) {
                // Terminal rejects throw with a classified code (the route
                // answers `rejected:true`); `unavailable` throws retryable
                // (staged bytes + claim stay for a retry / the reconciler).
                const err = new Error(`Rejected task result: ${commitStatus} (fenced commit, job=${job_id})`);
                err.code = commitStatus;
                throw err;
            }
            log(`💾 Fenced commit ${commitStatus}: ${asset.fullPath} (${resultBuffer.length} bytes, job=${job_id}, fence=${fence.slice(0, 12)})`);
        } else {
            // Save result to filesystem (legacy direct-write path —
            // byte-for-byte the pre-Stage-131 behaviour, contract 126 §6
            // kill-switch `GPU_FENCING_MODE=off`).
            const outputDir = path.dirname(asset.fullPath);
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }
            if (resultBuffer.length === 0) {
                console.warn(`EMPTY RESULT from GPU for ${job_id} — writing 0-byte file!`);
            }
            fs.writeFileSync(asset.fullPath, resultBuffer);
            log(`Saved result to disk: ${asset.fullPath} (${resultBuffer.length} bytes, job=${job_id})`);
        }

        // Route by asset type
        switch (asset.type) {
            case 'iu_image': {
                if (!parsed || parsed.kind !== 'iu_image') {
                    console.warn('⚠️ Invalid IU image job_id format:', job_id);
                    break;
                }
                const { iuId, sceneId, chapterId, bookId } = parsed;

                // Register IU in Redis
                try {
                    await deps.saveIURegistry(iuId, build_id);
                } catch (registryErr) {
                    console.warn('⚠️ Failed to register IU in Redis:', registryErr.message);
                }

                // Increment per-IU progress counter (used by assets-state endpoint
                // instead of filesystem listing, which includes stale PNGs).
                try {
                    const progKey = `animastor:iu-progress:${bookId}:${chapterId}:${sceneId}:image`;
                    const ready = await redis.incr(progKey);
                    await redis.expire(progKey, 14400);
                    // Push an immediate increment to any open SSE stream so the
                    // UI advances without waiting for the next poll tick.
                    await publishProgress(redis, bookId, {
                        layer: 'image', chapterId, sceneId, ready,
                    });
                } catch (progErr) {
                    console.warn(`⚠️ Failed to increment IU progress counter: ${progErr.message}`);
                }

                // T1.9: Проверка IU completion — только при подтверждённом PG
                // Если PG недоступен или IUs не зарегистрированы, не форсируем completeStage.
                // Reconciliation подберёт незавершённые сцены.
                try {
                    const pgRows = await deps.iuRepo.getImageUnitsForScene(build_id, bookId, chapterId, sceneId);
                    const totalIUs = pgRows.length;
                    const iuPrefix = artifactNaming.iuImagePrefix(bookId, chapterId, sceneId);
                    let iuFiles = [];
                    try {
                        iuFiles = fs.readdirSync(outputDir).filter(f => f.startsWith(iuPrefix) && f.endsWith('.png'));
                    } catch (_) {}
                    log(`📊 IU progress: ${iuFiles.length}/${totalIUs} images for scene ${chapterId}/${sceneId}`);

                    if (iuFiles.length >= totalIUs && totalIUs > 0) {
                        log('🎯 All IUs complete for scene — triggering image completed');
                        await orchestrator.completeStage(redis, bookId, chapterId, sceneId, 'image', build_id, dispatch_id);
                    } else if (totalIUs === 0) {
                        // T1.9: Не завершаем stage без подтверждённых IU — reconciliation подберёт
                        log('⚠️ No IUs registered in PG for scene — deferring to reconciliation');
                    }
                } catch (err) {
                    // T1.9: Не маскируем PG ошибку completeStage'ом
                    console.error('❌ Failed to check IU completion:', err.message);
                    log('⚠️ PG error checking IU completion — deferring to reconciliation');
                }
                break;
            }

            case 'audio_chunk': {
                if (!parsed || parsed.kind !== 'audio_chunk') {
                    console.warn('⚠️ Invalid chunk ID in job_id:', job_id);
                    break;
                }
                const chunkId = parsed.assetId;
                const { bookId, chapterId, sceneId, chunkIndex } = parsed;
                log(`🎧 audio_chunk result: ${job_id} chunk=${chunkIndex} scene=${bookId}/${chapterId}/${sceneId} size=${(resultBuffer.length / 1024).toFixed(0)}KB`);

                // Update chunk metadata in Redis (thin: только metadata, routing)
                try {
                    const existing = await deps.getChunk(chunkId) || {};
                    await deps.saveChunk(chunkId, {
                        ...existing,
                        build_id: existing.build_id || build_id,
                        book_id: existing.book_id || bookId,
                        chapter_id: existing.chapter_id || chapterId,
                        scene_id: existing.scene_id || sceneId,
                        chunk_index: existing.chunk_index || chunkIndex,
                        audio: true,
                        audio_status: 'ready',
                    });
                    log('✅ Chunk metadata updated for', chunkId);
                } catch (chunkErr) {
                    console.error('❌ Failed to update chunk metadata:', chunkErr.message);
                }

                // T7: Делегируем merge-оркестрацию в audio-orchestrator.completeChunk
                const audioOrch = require('./audio-orchestrator');
                try {
                    await audioOrch.completeChunk(redis, bookId, chapterId, sceneId, chunkIndex, build_id, {
                        audio,
                        orchestrator,
                        getChunk: deps.getChunk,
                        saveChunk: deps.saveChunk,
                        dispatchId: dispatch_id,
                    });
                } catch (orchErr) {
                    console.error('❌ audioOrch.completeChunk failed:', orchErr.message);
                }
                break;
            }

            case 'scene_video': {
                if (!parsed || parsed.kind !== 'scene_video') {
                    console.warn('⚠️ Invalid video job_id format:', job_id);
                    break;
                }
                // VIDEO-ORCH: результат одной группы сцены. completeStage вызывается
                // ТОЛЬКО после прихода всех групп (склейка для плеера), а не на
                // первый результат — это фикс потери чанков _g2.._gN.
                const videoOrch = require('./video-orchestrator');
                log(`[VIDEO-RESULT] scene_video: job=${job_id} group='${parsed.groupSuffix || '(base)'}' bytes=${resultBuffer.length} → completeGroup`);
                try {
                    await videoOrch.completeGroup(redis, parsed.bookId, parsed.chapterId, parsed.sceneId, parsed.groupSuffix, build_id, {
                        orchestrator,
                        dispatchId: dispatch_id,
                    });
                } catch (orchErr) {
                    console.error('❌ videoOrch.completeGroup failed:', orchErr.message);
                }
                break;
            }

            case 'scene_image': {
                if (!parsed || parsed.kind !== 'scene_image') {
                    console.warn('⚠️ Invalid scene image job_id format:', job_id);
                    break;
                }
                log(`⚠️ SCENE_IMAGE (legacy) callback: ${parsed.bookId}/${parsed.chapterId}/${parsed.sceneId}`);
                await orchestrator.completeStage(
                    redis,
                    parsed.bookId,
                    parsed.chapterId,
                    parsed.sceneId,
                    'image',
                    build_id,
                    dispatch_id
                );
                break;
            }

            default:
                console.warn('⚠️ Unhandled asset type:', asset.type);
        }

        // Stage 131 — report how the artifact reached its canonical path, so
        // the route never runs the legacy settlement for a fenced publication
        // (the commit already wrote the done marker + released the claim).
        return { fenced: commitStatus != null, fence, commit: commitStatus };
    }

    // ── Book snapshot ─────────────────────────────────
    async function saveBookSnapshot(bookId) {
        try {
            const bookData = book.loadBook(bookId);
            if (!bookData) {
                log(`⚠️ saveBookSnapshot: book ${bookId} not found`);
                return null;
            }
            const snapshotPath = path.join(config.BOOKS_DIR, `${bookId}.snapshot.json`);
            fs.writeFileSync(snapshotPath, JSON.stringify(bookData, null, 2));
            log(`💾 Book snapshot saved: ${bookId}`);
            return snapshotPath;
        } catch (err) {
            console.error(`❌ saveBookSnapshot failed for ${bookId}:`, err.message);
            return null;
        }
    }

    async function loadBookSnapshot(bookId) {
        try {
            const snapshotPath = path.join(config.BOOKS_DIR, `${bookId}.snapshot.json`);
            if (!fs.existsSync(snapshotPath)) {
                log(`⚠️ loadBookSnapshot: no snapshot found for ${bookId}`);
                return null;
            }
            const data = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
            log(`📖 Book snapshot loaded: ${bookId}`);
            return data;
        } catch (err) {
            console.error(`❌ loadBookSnapshot failed for ${bookId}:`, err.message);
            return null;
        }
    }

    return {
        handleTaskResult,
        // triggerAudioMerge: dead — replaced by audioOrch.completeChunk (T7)
        saveBookSnapshot,
        loadBookSnapshot,
    };
};
