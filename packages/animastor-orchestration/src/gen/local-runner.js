// ======================================================
// gen/local-runner — executor='local' jobs (merge), ADR §5
// ======================================================
// Takes a queued local job exactly like a worker claim (SKIP LOCKED, attempt
// +1, deadline), runs the host port runLocal(job) → {path}, and accepts the
// produced file through the SAME acceptance transaction as GPU results.
// A backend restart mid-run leaves the job running; its deadline expires and
// the sweeper re-queues it (§9) — nothing is lost, nothing new is created.

'use strict';

const { withTx, notifyProgress } = require('./util');

function createLocalRunner({ pool, ports, accept, logger = null }) {
    const timeoutsJson = JSON.stringify({
        audio_merge: ports.timeoutFor('audio_merge'),
        video_merge: ports.timeoutFor('video_merge'),
    });

    /** @returns {Promise<null|{job_id:string, attempt:number, status:number, job_status?:string, code?:string}>} */
    async function runLocalOnce() {
        const job = await withTx(pool, async (client) => {
            const r = await client.query(
                `UPDATE gen_jobs j
                    SET status = 'running', attempt = j.attempt + 1, worker_id = NULL, claimed_at = now(),
                        deadline = now() + make_interval(secs => (($1::jsonb)->>j.kind)::numeric / 1000)
                  WHERE j.job_id = (
                        SELECT job_id FROM gen_jobs
                         WHERE executor = 'local' AND status = 'queued' AND not_before <= now()
                         ORDER BY created_at, job_id
                         LIMIT 1 FOR UPDATE SKIP LOCKED)
                 RETURNING j.*`, [timeoutsJson]);
            if (r.rows[0]) await notifyProgress(client, r.rows[0].book_id, r.rows[0].command_id);
            return r.rows[0] || null;
        });
        if (!job) return null;
        let out;
        try {
            out = await ports.runLocal(job);
            if (!out || typeof out.path !== 'string') throw Object.assign(new Error('runLocal must return {path}'), { error_class: 'deterministic' });
        } catch (err) {
            const r = await accept.failAttempt(job.job_id, job.attempt, (err && err.error_class) || 'unknown', `run_local: ${err && err.message}`);
            return { job_id: job.job_id, attempt: job.attempt, ...r };
        }
        const r = await accept.acceptLocalFile(job, out.path);
        return { job_id: job.job_id, attempt: job.attempt, ...r };
    }

    let timer = null;
    let running = false;
    let stopped = true;
    /** Drain local jobs every intervalMs (one at a time). */
    function startLocalRunner(intervalMs = 2_000) {
        if (!stopped) return;
        stopped = false;
        const tick = async () => {
            if (stopped) return;
            if (!running) {
                running = true;
                try {
                    while (!stopped && await runLocalOnce()) { /* drain */ }
                } catch (err) {
                    logger && logger.error && logger.error(`[gen-v2] local runner: ${err && err.message}`);
                } finally { running = false; }
            }
            if (!stopped) { timer = setTimeout(tick, intervalMs); if (timer.unref) timer.unref(); }
        };
        timer = setTimeout(tick, 0);
        if (timer.unref) timer.unref();
    }
    function stopLocalRunner() {
        stopped = true;
        if (timer) clearTimeout(timer);
        timer = null;
    }

    return { runLocalOnce, startLocalRunner, stopLocalRunner };
}

module.exports = { createLocalRunner };
