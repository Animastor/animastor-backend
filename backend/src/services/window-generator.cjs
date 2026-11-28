// ======================================================
// ANIMASTOR BACKEND — WINDOW GENERATOR
// ======================================================
// Background window generation — processes the next window
// of scenes from the source text, creates chunks + placeholder
// audio, and reports progress.
//
// Command-only generation (2026-10-31, animastor-docs
// architecture/COMMAND_ONLY_GENERATION.md):
//   • scenes of a new window are NEVER registered for GPU work — it starts
//     only by an explicit POST /book/:id/generate command (orchestration v2);
//   • processing the next QUEUED window after this one finishes is an
//     automatic start — behind WINDOW_AUTO_NEXT_ENABLED, default OFF.

const { log } = require('../helpers/utils.cjs');
const { isBookCancelled } = require('./agent-session');

module.exports = function({ redis, txtImporter, genSessionRepo, placeholderAudio, config }) {
    /**
     * Run background generation for the next text window.
     * Creates chunks + placeholder audio + registers scenes for GPU scheduler.
     * Reports progress via genSessionRepo.progress_msg (visible via /agent-status).
     */
    async function runBackgroundWindowGeneration(bookId, sessionId, options = {}) {
        const { buildId = 'default' } = options;
        const bgLog = (msg) => log(`[BG-GEN][${bookId}:${sessionId}] ${msg}`);
        bgLog(`🚀 === BACKGROUND WINDOW GENERATION START ===`);

        try {
            // — 1. Mark session as generating + set initial progress —
            await genSessionRepo.updateSession(sessionId, { status: 'generating' });
            bgLog(`✅ Session ${sessionId} marked as 'generating'`);

            // Progress callback: handles both string and { stage, message } formats
            // The agent-service passes { stage, message } objects via txtImporter.bootstrapNextWindow
            const progress = async (msgOrObj) => {
                const msg = typeof msgOrObj === 'string' ? msgOrObj : (msgOrObj?.message || 'Working...');
                try {
                    await genSessionRepo.updateSession(sessionId, {
                        progress_msg: msg,
                    });
                    bgLog(`📊 PROGRESS: "${msg}"`);
                } catch (_) { /* non-fatal */ }
            };

            await progress('⟳ Processing next window...');

            // — 2. Bootstrap the next window from source text —
            bgLog(`📖 Calling txtImporter.bootstrapNextWindow...`);
            // Pass redis and publishProgress so bootstrapNextWindow can check cancellation
            const result = await txtImporter.bootstrapNextWindow(bookId, progress, null, redis);
            bgLog(`📖 bootstrapNextWindow result: all_done=${result.all_done} added_scenes=${result.added_scenes} cached=${result.cached}`);

            if (result.all_done) {
                bgLog(`📗 All text processed — marking session completed`);
                await genSessionRepo.updateSession(sessionId, {
                    status: 'completed',
                    progress_msg: '✓ All text processed',
                });
                await genSessionRepo.setBookCompletionStatus(bookId, 'completed');
                bgLog(`✅ completion_status=completed`);
            } else {
                const sceneCount = result.added_scenes || 0;
                await progress(`⟳ Creating ${sceneCount} scenes...`);

                // — 3. Scenes of the new window (no Redis chunk records) —
                const chunkCount = 0;
                if (result.chapter && result.chapter.scenes && !result.chapter.chapter_id) {
                    console.warn(`[BG-GEN] window result for ${bookId} has no chapter.chapter_id — chunks skipped`);
                } else if (result.chapter && result.chapter.scenes) {
                    // Orchestration v2 (1b/E; since 2026-11-28 every book): no legacy
                    // Redis chunk records / scene counters — only the placeholder (ADR §4.3).
                    // The chapter object of lazy-book carries chapter_id (there is no
                    // `chapter` field — `.chapter.chapter` gave "undefined" in chunk
                    // and audio names, ba_1795695606197).
                    const chapterId = result.chapter.chapter_id;
                    const phScenes = result.chapter.scenes.map((scene) => ({ chapter_id: chapterId, scene_id: scene.scene_id }));

                    // — 4. Generate placeholder audio —
                    if (phScenes.length > 0) {
                        bgLog(`🔊 Generating placeholder audio for ${phScenes.length} scenes...`);
                        try {
                            const phResult = await placeholderAudio.ensureAllPlaceholderAudio(buildId, bookId, phScenes);
                            bgLog(`🔊 Placeholder audio: ${phResult.created} created, ${phResult.skipped} skipped`);
                        } catch (phErr) {
                            console.warn(`[BG-GEN] Placeholder audio failed: ${phErr.message}`);
                        }

                    // — 5. No GPU registration (command-only generation): the
                    //   new scenes wait for an explicit audio/image/video command.
                    bgLog(`⏭️ ${phScenes.length} scene(s) NOT registered for GPU — generation starts only by an explicit command`);
                    }
                }

                const finalMsg = `✓ Added ${result.added_scenes || 0} scenes (${chunkCount} chunks created)`;
                bgLog(`✅ ${finalMsg}`);
                await genSessionRepo.updateSession(sessionId, {
                    status: 'completed',
                    progress_msg: finalMsg,
                });
            }

            // — 6. Next queued session: automatic start → behind the flag —
            const queued = await genSessionRepo.getSessionsByStatus(bookId, 'queued');
            const autoNext = !!(config && typeof config.windowAutoNextEnabled === 'function' && config.windowAutoNextEnabled());
            if (queued.length > 0 && !autoNext) {
                bgLog(`⏸ ${queued.length} queued window(s) left for an explicit command (WINDOW_AUTO_NEXT_ENABLED off)`);
            } else if (queued.length > 0) {
                const nextSession = queued[0];
                bgLog(`🔄 Processing queued window ${nextSession.window_index} (session=${nextSession.id})`);
                await genSessionRepo.updateSession(nextSession.id, { status: 'pending' });
                await runBackgroundWindowGeneration(bookId, nextSession.id);
            } else {
                bgLog(`✅ No queued sessions — done`);
            }
        } catch (err) {
            if (err && err.code === 'bootstrap_in_progress') {
                // Another bootstrap / next-window run holds the book's lock: this
                // window did not run — it goes back to the queue, not to failed.
                bgLog(`⏳ bootstrap lock busy — session back to queued`);
                await genSessionRepo.updateSession(sessionId, {
                    status: 'queued',
                    progress_msg: '⏳ Ждёт завершения текущего окна',
                }).catch(() => {});
                return;
            }
            console.error(`[BG-GEN][${bookId}:${sessionId}] ❌ FAILED:`, err.message);
            // Don't overwrite 'cancelled' status — user requested cancellation
            const isCancelled = err.code === 'SESSION_CANCELLED' || (await isBookCancelled(bookId).catch(() => false));
            if (isCancelled) {
                await genSessionRepo.updateSession(sessionId, {
                    status: 'cancelled',
                    progress_msg: '✗ Генерация VBook остановлена пользователем',
                }).catch(() => {});
                try {
                    const { publishProgress } = require('../services/progress-pubsub.cjs');
                    publishProgress(redis, bookId, {
                        type: 'vbook',
                        stage: 'cancelled',
                        message: '✗ Отменено',
                    });
                } catch (_) {}
            } else {
                await genSessionRepo.updateSession(sessionId, {
                    status: 'failed',
                    error: err.message,
                    progress_msg: `✗ Failed: ${err.message}`,
                }).catch(() => {});
            }
        }
    }

    return {
        runBackgroundWindowGeneration,
    };
};
