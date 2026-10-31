// ======================================================
// Startup — interrupted generation is NOT resumed automatically
// ======================================================
// Command-only generation (2026-10-31, owner rule; animastor-docs
// architecture/COMMAND_ONLY_GENERATION.md): a backend start creates no work.
// What was running when the backend stopped is marked INTERRUPTED and stays
// visible; the user resumes it with a button (a new explicit command).
//
// Formerly this module re-ran every `generating`/`pending` window session in
// the background on startup (Phase C5 resume) — a generation start without a
// user command.
//
//   interruptIncompleteSessions — window sessions generating/pending →
//       failed (error 'interrupted', resumable by the VBook button). Queued
//       sessions are left for the explicit flow.
//   interruptActiveGenerationTasks — task registry (Redis) active →
//       interrupted; PG generation_tasks queued/running → interrupted;
//       active index entries without a command-authorized stage → removed.
// ======================================================

const genSessionRepo = require('./storage/postgres/repositories/gen-session-repo');

const INTERRUPTED_ERROR = 'interrupted: backend restart — resume with the Generate button';

/**
 * Phase C5 (startup): mark window sessions that were running at shutdown as
 * interrupted. Never resumes them.
 * @param {Function} log
 * @returns {Promise<number>} sessions marked interrupted.
 */
async function interruptIncompleteSessions(log) {
    const say = typeof log === 'function' ? log : () => {};
    try {
        const activeSessions = (await genSessionRepo.getActiveSessions())
            .filter(ses => ses.status === 'generating' || ses.status === 'pending');
        if (activeSessions.length === 0) {
            say('[STARTUP-RESUME] No interrupted generation sessions');
            return 0;
        }
        let marked = 0;
        for (const ses of activeSessions) {
            try {
                await genSessionRepo.updateSession(ses.id, {
                    status: 'failed',
                    error: INTERRUPTED_ERROR,
                    progress_msg: '⏸ Interrupted by a backend restart — press Generate to continue',
                });
                marked++;
                say(`[STARTUP-RESUME] ${ses.book_id} window ${ses.window_index} (was ${ses.status}) → interrupted, NOT resumed (command-only generation)`);
            } catch (err) {
                console.warn(`[STARTUP-RESUME] Failed to mark session ${ses.id} interrupted: ${err.message}`);
            }
        }
        return marked;
    } catch (err) {
        console.error('[STARTUP-RESUME] Error:', err.message);
        return 0;
    }
}

/**
 * Backend start, BEFORE the scheduler loop runs: every command that was in
 * flight is interrupted, so the scheduler finds nothing to dispatch.
 *
 * @param {object} redis
 * @param {object} deps — { generationProgress, taskRepo, scheduler, log }
 * @returns {Promise<{books:number, tasks:number, pgRows:number, removedFromIndex:number}>}
 */
async function interruptActiveGenerationTasks(redis, deps = {}) {
    const generationProgress = deps.generationProgress || require('./services/generation-progress');
    const taskRepo = deps.taskRepo || require('./storage/postgres/repositories/task-repo');
    const scheduler = deps.scheduler || require('@animastor/orchestration').runtime.scheduler;
    const say = typeof deps.log === 'function' ? deps.log : (m => console.log(m));
    const out = { books: 0, tasks: 0, pgRows: 0, removedFromIndex: 0 };

    try {
        for (const bookId of await generationProgress.listBooksWithTasks(redis)) {
            const interrupted = await generationProgress.interruptActiveTasks(redis, bookId);
            if (interrupted.length > 0) {
                out.books++;
                out.tasks += interrupted.length;
                say(`[STARTUP] ${bookId}: ${interrupted.length} generation task(s) → interrupted (resume by button)`);
            }
        }
    } catch (err) {
        console.warn(`[STARTUP] Task registry interruption failed: ${err.message}`);
    }

    try {
        out.pgRows = await taskRepo.interruptActiveTasks();
    } catch (err) {
        console.warn(`[STARTUP] PG generation_tasks interruption failed: ${err.message}`);
    }

    // With every task interrupted no scene×stage is authorized — drain the
    // active index now instead of waiting for the first scheduler tick.
    try {
        const commandGate = require('@animastor/orchestration').runtime.commandGate;
        for (const sceneKey of await scheduler.getActiveSceneKeys(redis)) {
            const parsed = scheduler.parseSceneKey(sceneKey);
            if (!parsed) continue;
            const auth = await commandGate.getAuthorizedStages(redis, parsed.bookId, parsed.chapterId, parsed.sceneId);
            if (auth.stages.size > 0) continue;
            const r = await scheduler.removeSceneFromActiveIndex(redis, parsed.bookId, parsed.chapterId, parsed.sceneId);
            if (r && r.removed) out.removedFromIndex++;
        }
    } catch (err) {
        console.warn(`[STARTUP] Active index drain failed: ${err.message}`);
    }

    say(`[STARTUP] Command-only generation: ${out.tasks} task(s) in ${out.books} book(s) interrupted, ${out.pgRows} PG row(s) interrupted, ${out.removedFromIndex} scene(s) removed from the active index — nothing resumed`);
    return out;
}

module.exports = { interruptIncompleteSessions, interruptActiveGenerationTasks, INTERRUPTED_ERROR };
