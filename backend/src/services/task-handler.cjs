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

    // ── Stage 143a — versioned iu_image publication (contract B1/B4/B6) ──
    //
    // Admission chain, in order, BEFORE anything is written:
    //   1. immutable hex receipt  — proven by the ROUTE (opts.fence) / above;
    //   2. durable reservation    — idem_key → integer fence + resource
    //                               identity (PG, must match this job/build);
    //   3. active intent          — readIntentStrict: state='active' and the
    //                               current fence equals THIS receipt;
    //   4. file immutability      — temp → O_EXCL copy (existing bytes of a
    //                               version are never overwritten);
    //   5. pointer UPDATE         — `publish_fence <= EXCLUDED` in PG is the
    //                               sole ordering authority (Redis never
    //                               orders publications).
    // A reject at 2/3/5 throws a FENCE_COMMIT_REJECTED code (the route
    // answers `rejected:true` and keeps the dedup marker); at 5 only THIS
    // writer's temp file is removed — the immutable file stays for the
    // age-based GC, and the pointer is untouched.
    function iuImageVersionedEnabled() {
        return require('../storage/postgres/repositories/iu-image-pointer-repo').versionedEnabled();
    }

    async function publishVersionedIuImage({ parsed, jobId, buildId, buffer, hexFence, assetId }) {
        const pointerRepo = require('../storage/postgres/repositories/iu-image-pointer-repo');

        // 2 — durable reservation: hex receipt → integer fence + identity.
        const admission = await pointerRepo.resolveCallbackFence({
            idemKey: hexFence,
            bookId: parsed.bookId,
            chapterId: parsed.chapterId,
            sceneId: parsed.sceneId,
            iuId: parsed.iuId,
            buildId,
        });
        if (!admission.ok) {
            const err = new Error(`Rejected task result: ${admission.reason} (durable fence reservation unavailable for job=${jobId}, fence=${String(hexFence).slice(0, 12)})`);
            err.code = admission.reason === 'reservation_mismatch' ? 'invalid_fence' : 'intent_missing';
            throw err;
        }

        // 3 — the intent must still be active for THIS receipt.
        const intent = await queueIdempotency.readIntentStrict(redis, {
            bookId: parsed.bookId,
            chapterId: parsed.chapterId,
            sceneId: parsed.sceneId,
            jobId,
        });
        if (intent.status === 'error') {
            const err = new Error(`Intent re-check failed for ${jobId} (${intent.error}) — retryable`);
            err.code = 'fence_lookup_unavailable';
            throw err;
        }
        if (intent.status !== 'ok'
            || String(intent.fence).toLowerCase() !== String(hexFence).toLowerCase()
            || intent.state !== 'active') {
            const err = new Error(`Rejected task result: stale_intent (fence=${String(hexFence).slice(0, 12)} is not the active intent, status=${intent.status}, state=${intent.state || 'none'})`);
            err.code = 'stale_intent';
            throw err;
        }

        const fenceInt = admission.fence;
        const relFinal = pointerRepo.versionedRelPath(buildId, assetId, fenceInt);
        const relTemp = pointerRepo.stagingRelPath(buildId, assetId, fenceInt);
        if (!relFinal || !relTemp) {
            const err = new Error(`Rejected task result: invalid_fence (unsafe versioned path for job=${jobId})`);
            err.code = 'invalid_fence';
            throw err;
        }
        const absFinal = pointerRepo.resolveOutputPath(OUTPUT_DIR, relFinal);
        const absTemp = pointerRepo.resolveOutputPath(OUTPUT_DIR, relTemp);
        if (!absFinal.ok || !absTemp.ok) {
            const err = new Error(`Versioned path rejected for ${jobId}: final=${absFinal.ok ? 'ok' : absFinal.reason} temp=${absTemp.ok ? 'ok' : absTemp.reason}`);
            err.code = 'publish_failed';
            throw err;
        }

        // 4 — bytes: temp file first, then an EXCLUSIVE copy into the
        // immutable versioned path (EEXIST = this version already exists —
        // keep the first bytes, never overwrite).
        try {
            fs.mkdirSync(path.dirname(absTemp.path), { recursive: true });
            fs.writeFileSync(absTemp.path, buffer);
            try {
                fs.copyFileSync(absTemp.path, absFinal.path, fs.constants.COPYFILE_EXCL);
            } catch (copyErr) {
                if (copyErr.code !== 'EEXIST') throw copyErr;
                log(`Versioned file already present (idempotent replay): ${absFinal.path}`);
            }
            try { fs.unlinkSync(absTemp.path); } catch (_) { /* GC collects staging */ }
        } catch (writeErr) {
            const err = new Error(`Versioned write failed for ${jobId}: ${writeErr.message}`);
            err.code = 'publish_failed';
            throw err;
        }

        // 5 — pointer UPDATE: PG decides the ordering (fence <= current ⇒
        // stale/replay; replay of the SAME fence is idempotent-success).
        let pub;
        try {
            pub = await pointerRepo.publishIuImagePointer({
                bookId: parsed.bookId,
                chapterId: parsed.chapterId,
                sceneId: parsed.sceneId,
                iuId: parsed.iuId,
                buildId,
                relPath: relFinal,
                fence: fenceInt,
            });
        } catch (pgErr) {
            const err = new Error(`Pointer publication failed for ${jobId} (${pgErr.message}) — retryable`);
            err.code = 'publish_failed';
            throw err;
        }
        if (!pub.published) {
            const err = new Error(`Rejected task result: stale_intent (fence=${fenceInt} lost to publish_fence=${pub.current} for ${jobId})`);
            err.code = 'stale_intent';
            throw err;
        }

        log(`💾 Versioned publication: ${relFinal} (fence=${fenceInt}, job=${jobId})`);
        return {
            published: true,
            publication: 'versioned_pointer',
            fence: fenceInt,
            path: absFinal.path,
            relPath: relFinal,
        };
    }

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
        // The fence of THIS result is proven by the immutable dispatch
        // receipt (Stage 127, written atomically BEFORE the hub POST); the
        // caller (result route / debug recovery) may pass its own resolution
        // in opts.fence.
        //
        // Stage 133 (audit 132 · B1/B5): a missing receipt is NOT a reason to
        // use the legacy direct-write path — the generation of such a result
        // is unprovable and the result is rejected BEFORE any file, manifest
        // or ready-metadata write. A Redis read error is retryable and writes
        // nothing either. The only remaining legacy writer is the explicit
        // `GPU_FENCING_MODE=off` kill-switch (contract 126 §6).
        const fencingMode = typeof config.resultFencingMode === 'function'
            ? config.resultFencingMode()
            : String(config.RESULT_FENCING_MODE || 'observe');
        let fence = opts.fence ? String(opts.fence) : null;
        if (!fence && fencingMode !== 'off') {
            const resolution = await queueIdempotency.resolveDispatchFence(redis, {
                dispatchId: dispatch_id, jobId: job_id,
            });
            if (resolution.status === 'error') {
                const err = new Error(`Fence resolution failed for ${job_id} (${resolution.error}) — retryable`);
                err.code = 'fence_lookup_unavailable';
                throw err;
            }
            if (resolution.status !== 'ok') {
                const gateReason = resolution.status === 'corrupt' ? 'receipt_corrupt' : 'receipt_missing';
                queueIdempotency.observeFenceGateReject(gateReason);
                const err = new Error(`Rejected task result: ${gateReason} (no immutable dispatch receipt for job=${job_id})`);
                err.code = gateReason;
                throw err;
            }
            fence = resolution.fence;
        }

        let commitStatus = null;
        let publication = null;
        // ── Stage 143a — versioned iu_image publication (flag-gated) ────
        // With IU_IMAGE_VERSIONED on, an `iu_image` result is NOT committed
        // through the legacy canonical path: it goes through the admission
        // chain (receipt → durable reservation → active intent), lands in an
        // immutable versioned file (temp → O_EXCL) and moves the PostgreSQL
        // pointer. Flag OFF ⇒ this branch is never taken and the legacy
        // fenced/legacy flow below runs byte-identically (condition 2).
        const versionedIuPublication = asset.type === 'iu_image' && iuImageVersionedEnabled();
        if (versionedIuPublication) {
            if (!fence) {
                const err = new Error(`Rejected task result: receipt_missing (no immutable dispatch receipt for job=${job_id})`);
                err.code = 'receipt_missing';
                throw err;
            }
            publication = await publishVersionedIuImage({ parsed, jobId: job_id, buildId: build_id, buffer: resultBuffer, hexFence: fence, assetId: path.basename(asset.fullPath, `.${asset.extension}`) });
        } else if (fence && fencingMode !== 'off') {
            // NEW results go to staging first. The canonical artifact path
            // is only replaced after the ATOMIC fence commit confirms this
            // fence is still the current, active intent (Redis Lua —
            // queue-idempotency.fenceCommitResult). A stale / missing /
            // corrupt intent discards ONLY this fence's staged bytes and
            // throws a terminal error: no metadata, no ready, no canonical.
            // A failed staged→canonical rename throws `publish_failed` —
            // never a false success; the retry/resume replays the rename.
            const publicationResult = await resultPublication.commitFencedResult(redis, config, {
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
            publication = publicationResult;
            commitStatus = publication.status;
            if (!FENCED_PUBLISHED.has(commitStatus)) {
                // Terminal rejects throw with a classified code (the route
                // answers `rejected:true`); `unavailable` throws retryable
                // (staged bytes + claim stay for a retry / the reconciler).
                const err = new Error(`Rejected task result: ${commitStatus} (fenced commit, job=${job_id})`);
                err.code = commitStatus;
                throw err;
            }
            // Stage 137 — a commit verdict is not a publication success. The
            // canonical rename must have been proven (or be a content-verified
            // idempotent replay); otherwise the ready chain must not run.
            if (!publication.published && publication.publication !== 'already_published') {
                const err = new Error(`Publication of ${job_id} was not confirmed (fence=${fence.slice(0, 12)})`);
                err.code = 'publish_failed';
                throw err;
            }
            // Re-read the authority once more before any ready metadata is
            // written: a fence superseded after its (valid) publication must
            // not mark the new generation ready.
            const currentIntent = await queueIdempotency.readIntentStrict(redis, {
                bookId: parsed.bookId, chapterId: parsed.chapterId, sceneId: parsed.sceneId, jobId: job_id,
            });
            if (currentIntent.status === 'error') {
                const err = new Error(`Intent re-check failed for ${job_id} (${currentIntent.error}) — retryable`);
                err.code = 'fence_lookup_unavailable';
                throw err;
            }
            if (currentIntent.status !== 'ok'
                || String(currentIntent.fence).toLowerCase() !== String(fence).toLowerCase()
                || currentIntent.state !== 'active') {
                const err = new Error(`Rejected task result: stale_intent (fence=${fence.slice(0, 12)} is no longer current)`);
                err.code = 'stale_intent';
                throw err;
            }
            log(`💾 Fenced commit ${commitStatus}: ${asset.fullPath} (${resultBuffer.length} bytes, job=${job_id}, fence=${fence.slice(0, 12)})`);
        } else {
            // Save result to filesystem — ONLY reachable through the explicit
            // `GPU_FENCING_MODE=off` kill-switch (contract 126 §6). Every
            // automatic mode resolves a receipt first and throws above when it
            // is missing, so no unproven result can reach this branch.
            if (fencingMode !== 'off') {
                const err = new Error(`Fence missing for ${job_id} in mode ${fencingMode} — refusing a direct canonical write`);
                err.code = 'receipt_missing';
                throw err;
            }
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
                    const scenePrefix = artifactNaming.scenePrefix(bookId, chapterId, sceneId);
                    let iuFiles = [];
                    try {
                        iuFiles = fs.readdirSync(outputDir).filter(f => f.startsWith(iuPrefix) && f.endsWith('.png'));
                    } catch (_) {}
                    // Stage 143a: "ready" = the set of IU ids proven by the
                    // canonical file OR by the published pointer — versioned
                    // files live under .versions/ and are invisible to the
                    // disk scan. Flag OFF ⇒ no PG call, set == file count.
                    const readyIds = new Set();
                    for (const f of iuFiles) {
                        readyIds.add(f.startsWith(`${scenePrefix}_`) ? f.slice(scenePrefix.length + 1, -4) : f);
                    }
                    if (iuImageVersionedEnabled()) {
                        // A PG failure here lands in the catch below — the
                        // same "defer to reconciliation" posture as a failed
                        // units read (never mask an error with a completion).
                        const publishedIds = await require('../storage/postgres/repositories/iu-image-pointer-repo')
                            .listPublishedIuIds({ bookId, chapterId, sceneId, buildId: build_id });
                        for (const id of publishedIds) readyIds.add(id);
                    }
                    const readyCount = readyIds.size;
                    log(`📊 IU progress: ${readyCount}/${totalIUs} images for scene ${chapterId}/${sceneId}`);

                    if (readyCount >= totalIUs && totalIUs > 0) {
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
        return {
            fenced: commitStatus != null,
            versioned: versionedIuPublication,
            fence,
            commit: commitStatus,
            published: publication ? publication.published : false,
            publication: publication ? publication.publication : null,
        };
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
