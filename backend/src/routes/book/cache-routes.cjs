// Book cache inspection + teardown routes.
//
// Split out of book-routes.cjs (Architectural Debt #3, sub-registrar pattern).
//
// ctx fields used here:
//   { redis, config, storage, path, fs, getAllChunks, getChunk,
//     cleanBookRedisKeys, purgeAssistantForBook, log }
//
// Assistant boundary: Assistant data (chat sessions) is purged through the
// purgeAssistantForBook port — this route must not know the Assistant's
// storage details.

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

    // DELETE /api/v1/book/:bookId/cache — wipe build dirs, Redis keys, PG cache rows, hub queue.
    app.delete('/api/v1/book/:bookId/cache', async (req, res) => {
        try {
            const { bookId } = req.params;

            // Get build IDs from chunks
            const chunkIds = await getAllChunks(bookId);
            const buildIds = new Set();
            for (const cid of chunkIds) {
                try {
                    const chunk = await getChunk(cid);
                    if (chunk?.build_id) buildIds.add(chunk.build_id);
                } catch (_) {}
            }

            // Clean up build directories
            const OUTPUT_DIR = config.OUTPUT_DIR;
            for (const buildId of buildIds) {
                const buildPath = path.join(OUTPUT_DIR, buildId);
                if (fs.existsSync(buildPath)) {
                    try { fs.rmSync(buildPath, { recursive: true, force: true }); } catch (e) {
                        console.warn('[CACHE] Failed to delete build dir:', buildPath);
                    }
                }
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
                'asset_states',
                'asset_dependencies',
                'generation_tasks',
                'reconciliation_events',
                'output_manifests',
                'cache_entries',
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
            // Stage 143a — versioned iu_image contour (GC of the pointers and
            // the durable fence reservations when a book's cache is wiped, so
            // no pointer survives its files). Flag-gated: a flag-OFF process
            // never queries tables that do not exist (condition 2).
            try {
                if (require('../../storage/postgres/repositories/iu-image-pointer-repo').versionedEnabled()) {
                    pgTables.push('iu_image_fence_reservations', 'iu_image_pointers');
                }
            } catch (flagErr) {
                console.warn(`[CACHE] versioned iu_image flag check failed: ${flagErr.message}`);
            }
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

            // ── Clear gpu-hub queue ──
            // Stage 118 (B4): the hub lane is cleared FIRST; the backend-side
            // claims are released ONLY after the hub confirmed. The Stage 116
            // order (release → clear) opened a duplicate window: when the hub
            // call failed, the claims were already free while the lane
            // entries survived ⇒ the next dispatch enqueued a SECOND copy of
            // a task that was still queued. On a hub failure the claims are
            // kept — the safe direction (no duplicates).
            let hubCleared = false;
            try {
                const HUB_URL = process.env.HUB_URL || 'https://animastor.org/gpu';
                const hubHeaders = { method: 'DELETE' };
                const apiKey = config.GPU_HUB_API_KEY || process.env.GPU_HUB_API_KEY;
                if (apiKey) {
                    hubHeaders.headers = { 'x-api-key': apiKey };
                }
                const hubRes = await fetch(`${HUB_URL}/queue/clear?book_id=${bookId}`, hubHeaders).catch(() => null);
                hubCleared = !!(hubRes && hubRes.ok);
            } catch (_) {}

            if (hubCleared) {
                // Stage 116 (D4) / Stage 118 (B1): the hub lane entries of
                // this book are cleared; the backend-side pending claims must
                // go with them, otherwise the next run of the same book would
                // be suppressed as a duplicate until the claim TTL expires.
                // The release also frees the COMPLETION MARKERS (B1): the
                // cache was wiped on purpose, so the previous "already
                // completed" no longer applies.
                try {
                    const qidem = ctx.queueIdempotency;
                    if (qidem) {
                        const released = await qidem.releaseClaimsForBook(redis, bookId);
                        log('[CACHE] Released', released.released, 'idempotency claim(s) and', released.done, 'completion marker(s) for', bookId);
                    }
                    // The capacity backoff must not survive an explicit cache
                    // teardown — the user asked for the work to run again.
                    if (ctx.clearDeferrals) {
                        await ctx.clearDeferrals.book(bookId);
                    }
                } catch (claimErr) {
                    console.warn(`[CACHE] Failed to release idempotency claims for ${bookId}: ${claimErr.message}`);
                }
                // Stage 120 (M-b): a dispatch that lands BETWEEN the lane
                // clear above and the release just above re-creates a claim
                // and appends a lane entry; the release then deleted that
                // claim, leaving an ORPHAN lane entry with no claim — the next
                // dispatch would enqueue a SECOND copy (the mirror of the
                // Stage 116 lost-task race). A SECOND lane-clear pass removes
                // any such orphan entry so the state stays consistent.
                try {
                    const HUB_URL = process.env.HUB_URL || 'https://animastor.org/gpu';
                    const hubHeaders = { method: 'DELETE' };
                    const apiKey = config.GPU_HUB_API_KEY || process.env.GPU_HUB_API_KEY;
                    if (apiKey) hubHeaders.headers = { 'x-api-key': apiKey };
                    const sweep = await fetch(`${HUB_URL}/queue/clear?book_id=${bookId}`, hubHeaders).catch(() => null);
                    if (!(sweep && sweep.ok)) {
                        console.warn(`[CACHE] Post-release lane sweep failed for ${bookId} — an orphan entry may survive (bounded by claim TTL)`);
                    }
                } catch (_) {}
            } else {
                console.warn(`[CACHE] GPU hub queue clear failed for ${bookId} — the idempotency claims are KEPT (no duplicate window)`);
            }

            log('[CACHE] Cache cleared for', bookId);
            // Stage 120 (M-a): the response must not claim success it cannot
            // confirm. When the hub lane clear FAILED the claims/markers were
            // KEPT (the safe direction) and the book will NOT auto-regenerate
            // until they expire — report that honestly instead of {cleared:true}.
            if (!hubCleared) {
                return res.json({
                    cleared: false,
                    hub_cleared: false,
                    claims_kept: true,
                    book_id: bookId,
                    builds_removed: buildIds.size,
                    error: 'hub_queue_clear_failed',
                });
            }
            res.json({ cleared: true, hub_cleared: true, claims_released: true, book_id: bookId, builds_removed: buildIds.size });
        } catch (err) {
            console.error('[CACHE] Delete error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    log('[ROUTES] Book cache routes loaded');
};
