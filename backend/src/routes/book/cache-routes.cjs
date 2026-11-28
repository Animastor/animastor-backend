// Book cache inspection + teardown routes.
//
// Split out of book-routes.cjs (Architectural Debt #3, sub-registrar pattern).
//
// ctx fields used here:
//   { redis, config, storage, path, fs, getAllChunks, getChunk,
//     cleanBookRedisKeys, purgeAssistantForBook, orchV2, log,
//     getBookManifest (injected: book-model.getBookManifest, backend.cjs) }
//
// Orchestration v2 (ADR §13 п.8, stage 1c): the teardown never calls the hub
// (no /queue/clear, no legacy claim release) — the book's gen commands / jobs
// are cancelled in the gen core. Since 2026-11-28 (этап 4) every book is v2:
// the legacy branch (hub /queue/clear + idempotency claim release) is removed.
//
// Assistant boundary: Assistant data (chat sessions) is purged through the
// purgeAssistantForBook port — this route must not know the Assistant's
// storage details.

const { PRESERVED_ENTRIES } = require('../../utils/build-dir');

module.exports = function registerCacheRoutes(app, ctx) {
    const { redis, config, storage, path, fs, getAllChunks, getChunk, cleanBookRedisKeys, purgeAssistantForBook, log } = ctx;

    // GET /api/v1/book/:bookId/cache — report per-scene asset cache status.
    //
    // Phase 2 (PostgreSQL boundary cleanup): the historical read of the
    // `scene_assets_cache` table is removed — that table is created NOWHERE
    // (ghost of a dropped schema; audit §9 L14). On every real database the
    // query failed and produced exactly the empty shape below, so the
    // response is unchanged. Cache status now reports the empty (idle)
    // summary; per-scene truth lives in scene_assets (see /versions).
    app.get('/api/v1/book/:bookId/cache', async (req, res) => {
        try {
            const { bookId } = req.params;
            const cacheStatus = {};
            const totalStale = Object.values(cacheStatus).reduce((acc, ch) =>
                acc + Object.values(ch).reduce((acc2, sc) => acc2 + sc.filter(s => s.status === 'stale').length, 0), 0);
            const totalPending = Object.values(cacheStatus).reduce((acc, ch) =>
                acc + Object.values(ch).reduce((acc2, sc) => acc2 + sc.filter(s => s.status === 'pending').length, 0), 0);
            const totalReady = Object.values(cacheStatus).reduce((acc, ch) =>
                acc + Object.values(ch).reduce((acc2, sc) => acc2 + sc.filter(s => s.status === 'ready').length, 0), 0);
            res.json({ book_id: bookId, chapters: cacheStatus, summary: { stale: totalStale, pending: totalPending, ready: totalReady } });
        } catch (err) {
            console.error('[CACHE] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // DELETE /api/v1/book/:bookId/cache — stop the book's v2 work, wipe build dirs, Redis chunk keys, PG derived rows.
    app.delete('/api/v1/book/:bookId/cache', async (req, res) => {
        try {
            const { bookId } = req.params;
            const orchV2 = ctx.orchV2 || null;
            // Stop the book's work FIRST (the hub holds no state of it), so no
            // acceptance can re-create an asset row after the wipe below.
            let v2Stopped = null;
            if (orchV2) {
                try {
                    v2Stopped = await orchV2.cancelBook(bookId, 'cache-clear');
                } catch (cancelErr) {
                    console.warn(`[CACHE] orchestration v2 cancel failed for ${bookId}: ${cancelErr.message}`);
                    return res.status(500).json({ cleared: false, orchestration: 'v2', book_id: bookId, error: 'orch_v2_cancel_failed' });
                }
            }

            // Get build IDs from chunks
            const chunkIds = await getAllChunks(bookId);
            const buildIds = new Set();
            for (const cid of chunkIds) {
                try {
                    const chunk = await getChunk(cid);
                    if (chunk?.build_id) buildIds.add(chunk.build_id);
                } catch (_) {}
            }

            // VBook 4 / orchestration v2 artifacts live in OUTPUT_DIR/<manifest.build_id>/
            // (getOutputPath(job.build_id, …)); a v2 book may have no Redis chunk
            // naming that build, so the manifest's build id is always included
            // («Мои книги», 2026-11-22). Reading the manifest changes nothing.
            try {
                const manifest = typeof ctx.getBookManifest === 'function' ? ctx.getBookManifest(bookId) : null;
                if (manifest && typeof manifest.build_id === 'string' && manifest.build_id) buildIds.add(manifest.build_id);
            } catch (_) { /* no manifest — chunk build ids only */ }

            // Clean up build directories
            const OUTPUT_DIR = config.OUTPUT_DIR;
            // VOICE_REFERENCES.md: voices/ (locked / uploaded references) survives a cache clear
            try {
                require('../../services/book-artifacts.cjs').removeBookArtifacts({
                    outputDir: OUTPUT_DIR, booksDir: config.BOOKS_DIR, bookId, buildIds,
                    buildScoped: PRESERVED_ENTRIES, preserve: PRESERVED_ENTRIES,
                    log: (m) => console.warn(`[CACHE] ${m}`),
                });
            } catch (e) {
                console.warn(`[CACHE] Failed to clean build output for ${bookId}: ${e.message}`);
            }

            // Clean up ALL Redis keys for this book using the comprehensive helper
            await cleanBookRedisKeys(redis, bookId);

            // ── Clean PG tables — each with individual try/catch so one
            //    failure doesn't block the rest. Only generated/cache tables are
            //    cleared — book identity data (book_source, book_snapshots)
            //    and event logs (book_events) are preserved so the book stays
            //    loadable and dedup works on re-import. User chat history
            //    (ai_chat_sessions) is purged separately below through the
            //    Assistant port (historical behavior kept: cache teardown
            //    also clears chat sessions).
            const pgTables = [
                'image_units',
                'scenes',
                'agent_sessions',
                'book_generation_sessions',
                'scene_assets',
                'character_resolution_runs',
                'character_window_candidates',
                'sentence_resolutions',
                'character_mentions',
                'character_aliases',
                'storyboard_elements',
                'audio_layers',
                // NOTE: 'books', 'book_source', 'book_snapshots', 'book_events'
                // are NOT deleted on cache clear — they are book identity data.
            ];
            for (const table of pgTables) {
                try {
                    await storage.postgres.query(`DELETE FROM ${table} WHERE book_id = $1`, [bookId]);
                } catch (tblErr) {
                    console.warn(`[CACHE] DB cleanup: ${table}: ${tblErr.message}`);
                }
            }

            // ── Assistant data (chat sessions) — via the Assistant port,
            //    not a raw table name (extraction preparation).
            try {
                await purgeAssistantForBook(bookId);
            } catch (assistantErr) {
                console.warn(`[CACHE] Assistant data cleanup failed: ${assistantErr.message}`);
            }

            log('[CACHE] Cache cleared for', bookId, '(orchestration v2, hub not called;',
                v2Stopped ? `${v2Stopped.commands_cancelled} command(s), ${v2Stopped.jobs_cancelled} job(s) cancelled)` : 'v2 disabled — nothing running)');
            return res.json({
                cleared: true, orchestration: 'v2', hub_cleared: false, hub_skipped: true, book_id: bookId, builds_removed: buildIds.size,
                commands_cancelled: v2Stopped ? v2Stopped.commands_cancelled : 0, jobs_cancelled: v2Stopped ? v2Stopped.jobs_cancelled : 0,
            });
        } catch (err) {
            console.error('[CACHE] Delete error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    log('[ROUTES] Book cache routes loaded');
};
