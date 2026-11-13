// ======================================================
// Book Deletion / Purge boundary (Phase 4)
// ======================================================
// Single architectural seam for deleting a book. Route controllers must NOT
// implement book deletion cascade themselves — they call deleteBook() and
// map its result/errors to HTTP. The full cascade/purge knowledge lives
// here (moved verbatim from core-routes.cjs DELETE handler — behavior
// preserved; internal detail is now hidden behind the contract).
//
// Deletion ORDER (corrected Phase 4 contract) — the cancellation signal is
// sent FIRST, before ANY canonical/runtime state is touched. Even if a
// later cleanup step (resetBook, Redis, PG, snapshot) fails, cancellation
// is already delivered to the running worker/agent.
//   1. Cancellation signal — Redis cancelled-workers set + PG agent-session
//      status cancel (agent observes it on its next checkCancelled()).
//   2. Canonical cleanup   — disk bundle removal (book.resetBook) + snapshot.
//   3. Build artifacts     — output-dir removal (build_ids come from Redis
//      chunk keys, so this runs before the Redis purge below).
//   4. Runtime (Redis)     — scene-window cancel flag, active audio/image/
//      video keys, all book-keyed key families (cleanBookRedisKeys).
//   5. Derived/PG cleanup  — per-table deletes (… books LAST for FK order).
//   6. GPU-hub queue clear (best-effort, external runtime).
//   7. Final result.
//
// This file owns the ORDER (cancellation → cleanup) so future decomposition
// only changes internals, not the contract.

const fs = require('fs');
const path = require('path');

// TTL сигнала animastor:cancelled-workers:{bookId}. Сигнал должен пережить
// работающий агент (он увидит его на следующем checkCancelled() LEVEL 3),
// а затем исчезнуть — иначе ключ удалённой книги остаётся в Redis навсегда.
// Совпадает с TTL, который ставит cancel-worker (generation-routes).
const CANCELLED_WORKERS_TTL_SEC = 3600;

/**
 * @param {Object} deps - injected adapters:
 *   book            - canonical book module (resetBook)
 *   redis           - ioredis client
 *   storage         - { postgres: { query } }
 *   config          - runtime config (BOOKS_DIR, OUTPUT_DIR)
 *   getAllChunks    - redis helper
 *   getChunk        - redis helper
 *   cleanBookRedisKeys - redis purge helper (book-keyed key families)
 *   log             - logger (optional)
 *   setCancelFlag   - runtime scene-window cancel flag adapter (required;
 *                     injected from backend.cjs, keeps the book layer free
 *                     of direct runtime-module requires)
 *   agentSessionControl - VBook agent-session cancel port (required; the
 *                     cascade must not own the agent_sessions SQL — the
 *                     same frozen port implementation serves cancel-worker
 *                     and the generation routes)
 *   removeBookArtifacts - scoped output cleanup port (services/book-artifacts;
 *                     injected from backend.cjs). Without it the cascade
 *                     leaves build output on disk (never removes blindly).
 *   purgeAssistantForBook - Assistant-data purge port (required; the
 *                     cascade must not know the ai_chat_sessions table —
 *                     the future @animastor/assistant owns that data)
 */
function createBookDeletion(deps) {
    const {
        book, redis, storage, config,
        getAllChunks, getChunk, cleanBookRedisKeys,
        log = console.log,
        setCancelFlag = null,
        agentSessionControl = null,
        purgeAssistantForBook = null,
        removeBookArtifacts = null,
    } = deps;

    /**
     * Delete a book and everything derived from it.
     * @param {string} bookId
     * @param {{ onEvent?: (msg: string) => void }} [options]
     * @returns {Promise<{ deleted: boolean, book_id: string }>}
     *   Throws only on unexpected top-level failures; every individual
     *   cascade step is best-effort (warn + continue), matching the
     *   historical route behavior.
     */
    // Orchestration v2 hooks (composition root, after routeDeps): {isV2Book, purgeGenV2}
    const v2 = { isV2Book: deps.isV2Book || null, purgeGenV2: deps.purgeGenV2 || null };
    function configureOrchV2(hooks = {}) {
        if (typeof hooks.isV2Book === 'function') v2.isV2Book = hooks.isV2Book;
        if (typeof hooks.purgeGenV2 === 'function') v2.purgeGenV2 = hooks.purgeGenV2;
    }

    async function deleteBook(bookId, options = {}) {
        const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
        // Orchestration v2: decided BEFORE the books row goes (the flag lives there).
        let isV2 = false;
        if (typeof v2.isV2Book === 'function') {
            try { isV2 = await v2.isV2Book(bookId); } catch (_) { isV2 = true; }
        }

        // ── 1. Cancellation signal FIRST — before ANY canonical/runtime
        //    state is deleted. КРИТИЧЕСКИ важно: сначала ОТМЕНИТЬ активные
        //    agent-сессии, потом чистить. Если сначала почистить Redis, PG
        //    или canonical bundle, running agent никогда не узнает об отмене:
        //      - DELETE agent_sessions удалит все сессии
        //      - resetBook удалит саму книгу
        //    Агент продолжит работу — он не может обнаружить отмену.
        //    Ключ animastor:cancelled-workers:{bookId} входит в список
        //    паттернов cleanBookRedisKeys (шаг 4 его удаляет), поэтому сигнал
        //    ставится здесь, ДО чистки, и повторно взводится сразу после неё
        //    (шаг 4) — так он гарантированно переживёт каскад и истечёт сам по
        //    CANCELLED_WORKERS_TTL_SEC. Поэтому сигнализируем агенту через
        //    cancelled-workers (Redis) и статус сессий (PG) ДО удаления любого
        //    book state: агент увидит отмену на следующем checkCancelled().
        //    Даже если последующие шаги (resetBook / Redis / PG / snapshot
        //    cleanup) упадут — cancellation уже отправлен.
        try {
            await redis.sadd(`animastor:cancelled-workers:${bookId}`, 'vbook');
            await redis.expire(`animastor:cancelled-workers:${bookId}`, CANCELLED_WORKERS_TTL_SEC);
            log(`[DELETE-BOOK] Set cancelled-workers for ${bookId} — VBook agent will be stopped`);
        } catch (redisErr) {
            console.warn(`[DELETE-BOOK] Failed to set cancelled-workers: ${redisErr.message}`);
        }
        try {
            if (!agentSessionControl || typeof agentSessionControl.cancelSessions !== 'function') {
                throw new Error('bookDeletion: agentSessionControl adapter is required');
            }
            await agentSessionControl.cancelSessions(bookId);
        } catch (pgErr) {
            console.warn(`[DELETE-BOOK] Failed to cancel agent sessions: ${pgErr.message}`);
        }

        // ── 2. Canonical: remove the disk bundle + snapshot file ──
        await book.resetBook(bookId);
        const snapshotPath = path.join(config.BOOKS_DIR, `${bookId}.snapshot.json`);
        if (fs.existsSync(snapshotPath)) {
            try { fs.unlinkSync(snapshotPath); } catch (_) {}
        }

        // ── 3. Build output dirs (runtime artifacts on disk) ──
        // NOTE: must run before the Redis purge below — build_ids are derived
        // from chunk keys that cleanBookRedisKeys removes.
        const OUTPUT_DIR = config.OUTPUT_DIR;
        const chunkIds = await getAllChunks(bookId).catch(() => []);
        const buildIds = new Set();
        for (const cid of chunkIds) {
            try {
                const chunk = await getChunk(cid);
                if (chunk?.build_id) buildIds.add(chunk.build_id);
            } catch (_) {}
        }
        // Scoped removal: validated build ids, only this book's artifacts
        // (never another book's files in a shared or same-prefix location).
        try {
            if (typeof removeBookArtifacts !== 'function') throw new Error('removeBookArtifacts port not injected');
            removeBookArtifacts({
                outputDir: OUTPUT_DIR, booksDir: config.BOOKS_DIR, bookId, buildIds, log,
            });
        } catch (artErr) {
            console.warn(`[DELETE-BOOK] artifact cleanup failed for ${bookId}: ${artErr.message}`);
        }

        // ── 4. Runtime / ephemeral state (Redis) ──
        // setCancelFlag is injected (runtime scene-window adapter) — the book
        // layer itself does not require runtime modules (see
        // tests/architecture/dependency-guardrails.test.js BOOK_ALLOWLIST).
        if (typeof setCancelFlag !== 'function') {
            throw new Error('bookDeletion: setCancelFlag adapter is required');
        }
        await setCancelFlag(redis, bookId);
        await redis.del('animastor:runtime:active-audio');
        await redis.del('animastor:runtime:active-image');
        await redis.del('animastor:runtime:active-video');
        // releaseClaims: the book is being destroyed, so its idempotency
        // ownership refs go with it — ref + claim + completion marker together
        // through the owner module (a raw ref DEL would orphan every done
        // marker; see helpers/redis-helpers.cjs). The cache-clear route keeps
        // the default and releases after the hub lane clear instead.
        const cleanResult = await cleanBookRedisKeys(redis, bookId, { releaseClaims: true });
        // Re-arm the cancellation signal the purge has just removed: a running
        // VBook agent must still observe it on its next checkCancelled() (the
        // cascade can take seconds), and the key then expires on its own.
        try {
            await redis.sadd(`animastor:cancelled-workers:${bookId}`, 'vbook');
            await redis.expire(`animastor:cancelled-workers:${bookId}`, CANCELLED_WORKERS_TTL_SEC);
            log(`[DELETE-BOOK] Re-armed cancelled-workers for ${bookId} (TTL ${CANCELLED_WORKERS_TTL_SEC}s)`);
        } catch (redisErr) {
            console.warn(`[DELETE-BOOK] Failed to re-arm cancelled-workers: ${redisErr.message}`);
        }
        if (cleanResult && cleanResult.claims_released) {
            log(`[DELETE-BOOK] ${bookId}: released ${cleanResult.claims_released} idempotency claim(s), ${cleanResult.markers_released} completion marker(s)`);
        }

        // ── 5. Derived PostgreSQL state — clean ALL PG tables, each with an
        //    individual try/catch so one failure (e.g. table doesn't exist in
        //    an older schema) doesn't block cleanup of the remaining tables ──
        //    Assistant data (ai_chat_sessions) is NOT purged here: it goes
        //    through the purgeAssistantForBook port (the cascade must not
        //    know the Assistant's table).
        const pgTables = [
            // Per-layer & asset tables (book_id as plain TEXT, no FK)
            'image_units',
            'scenes',
            'asset_states',
            'asset_dependencies',
            'generation_tasks',
            'reconciliation_events',
            'output_manifests',
            'cache_entries',
            'book_source',
            'agent_sessions',
            'book_generation_sessions',
            'generation_cancellations',
            'book_events',
            'scene_assets',
            // Coreference resolution tables
            'character_resolution_runs',
            'character_window_candidates',
            'sentence_resolutions',
            'character_mentions',
            'character_aliases',
            // Tables with FK to books — delete before books
            'storyboard_elements',
            'audio_layers',
            'book_snapshots',
            // books LAST (may have FK cascades)
            'books',
        ];
        // Orchestration v2: gen_command_jobs / gen_jobs / gen_commands + this book's .incoming files
        if (typeof v2.purgeGenV2 === 'function') {
            try {
                const g = await v2.purgeGenV2(bookId);
                if (g && !g.skipped) log(`[DELETE-BOOK] ${bookId}: orchestration v2 rows removed — commands=${g.commands} jobs=${g.jobs} links=${g.links} incoming=${g.incoming_removed}`);
            } catch (genErr) {
                console.warn(`[DELETE-BOOK] orchestration v2 cleanup failed for ${bookId}: ${genErr.message}`);
            }
        }
        for (const table of pgTables) {
            try {
                await storage.postgres.query(`DELETE FROM ${table} WHERE book_id = $1`, [bookId]);
            } catch (tblErr) {
                // Table may not exist in older schemas — non-fatal
                console.warn(`[DELETE-BOOK] DB cleanup: ${table}: ${tblErr.message}`);
            }
        }

        // ── 5b. Assistant data — purged through the Assistant port ──
        if (typeof purgeAssistantForBook !== 'function') {
            throw new Error('bookDeletion: purgeAssistantForBook adapter is required');
        }
        try {
            await purgeAssistantForBook(bookId);
        } catch (assistantErr) {
            console.warn(`[DELETE-BOOK] Assistant data cleanup failed: ${assistantErr.message}`);
        }

        // ── 6. GPU-hub queue clear (best-effort, external runtime) ──
        // Stage 118 (B4): the hub lane is cleared FIRST; the backend-side
        // claims are released ONLY after the hub confirmed. The Stage 116
        // order (release → clear) opened a duplicate window: when the hub
        // call failed, the claims were already free while the lane entries
        // survived ⇒ a later run of the same book could enqueue a SECOND
        // copy of a task that was still queued. On a hub failure the claims
        // are kept — the safe direction (no duplicates).
        let hubCleared = false;
        if (isV2) {
            // a v2 book has no hub queues (ADR §8.4) — the hub is not touched
            log(`[DELETE-BOOK] Book completely deleted: ${bookId} (orchestration v2)`);
            if (onEvent) onEvent(`Book completely deleted: ${bookId}`);
            return { deleted: true, book_id: bookId };
        }
        try {
            const HUB_URL = process.env.HUB_URL || 'https://animastor.org/gpu';
            const hubHeaders = { method: 'DELETE' };
            const apiKey = process.env.GPU_HUB_API_KEY;
            if (apiKey) {
                hubHeaders.headers = { 'x-api-key': apiKey };
            }
            const hubRes = await fetch(`${HUB_URL}/queue/clear?book_id=${bookId}`, hubHeaders).catch(() => null);
            hubCleared = !!(hubRes && hubRes.ok);
        } catch (_) {}

        if (hubCleared) {
            // Stage 116 (D4) / Stage 118 (B1): the hub lane entries of this
            // book are removed; the backend-side pending claims must go with
            // them, otherwise a later run of the same book would be
            // suppressed as a duplicate. The release also frees the COMPLETION
            // MARKERS (B1) — the book is gone, its "already completed"
            // markers must not survive it.
            try {
                const qidem = deps.queueIdempotency;
                if (qidem) {
                    const released = await qidem.releaseClaimsForBook(redis, bookId);
                    console.log(`[DELETE-BOOK] ${bookId}: released ${released.released} idempotency claim(s), ${released.done} completion marker(s)`);
                }
                if (deps.clearDeferrals && deps.clearDeferrals.book) {
                    await deps.clearDeferrals.book(bookId);
                }
            } catch (claimErr) {
                console.warn(`[DELETE-BOOK] Failed to release idempotency claims for ${bookId}: ${claimErr.message}`);
            }
            // Stage 120 (M-b): sweep the lane AGAIN after the release — a
            // dispatch landing between the clear above and the release would
            // leave an ORPHAN lane entry whose claim was just deleted (the
            // next run would enqueue a second copy). The sweep removes it.
            try {
                const HUB_URL = process.env.HUB_URL || 'https://animastor.org/gpu';
                const hubHeaders = { method: 'DELETE' };
                const apiKey = process.env.GPU_HUB_API_KEY;
                if (apiKey) hubHeaders.headers = { 'x-api-key': apiKey };
                const sweep = await fetch(`${HUB_URL}/queue/clear?book_id=${bookId}`, hubHeaders).catch(() => null);
                if (!(sweep && sweep.ok)) {
                    console.warn(`[DELETE-BOOK] Post-release lane sweep failed for ${bookId} — an orphan entry may survive (bounded by claim TTL)`);
                }
            } catch (_) {}
        } else {
            console.warn(`[DELETE-BOOK] GPU hub queue clear failed for ${bookId} — the idempotency claims are KEPT (no duplicate window)`);
        }

        log(`[DELETE-BOOK] Book completely deleted: ${bookId}`);
        if (onEvent) onEvent(`Book completely deleted: ${bookId}`);
        return { deleted: true, book_id: bookId };
    }

    return { deleteBook, configureOrchV2 };
}

module.exports = { createBookDeletion };
