// ======================================================
// services/window-sessions-startup — VBook window sessions on a backend start
// ======================================================
// Command-only generation (2026-10-31, owner rule; animastor-docs
// architecture/COMMAND_ONLY_GENERATION.md): a backend start creates no work.
// A VBook window session that was running when the backend stopped is marked
// interrupted (failed, resumable by the VBook button); queued sessions are
// left for the explicit flow.
//
// 2026-11-28 (ORCHESTRATION_V2 этап 4, шаг 7): moved verbatim out of the
// deleted startup-resume.js (its other half interrupted the legacy task
// registry / generation_tasks). Formerly run as reconcile phase C5; now called
// once by the composition root after listen. Stays until task H.

'use strict';

const genSessionRepo = require('../storage/postgres/repositories/gen-session-repo');

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

module.exports = { interruptIncompleteSessions, INTERRUPTED_ERROR };
