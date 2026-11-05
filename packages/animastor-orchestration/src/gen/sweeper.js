// ======================================================
// gen/sweeper — the only background loop of v2 generation (ADR §9)
// ======================================================
//   1. running with deadline < now()             → error 'timeout'        (retry or failed)
//   2. running on a worker silent > offlineAfter → error 'worker_offline' (retry or failed)
//   3. active command with no live job in gen_command_jobs (created + joined + next stages)
//      → done | partial | failed | cancelled
//   4. .incoming/*.tmp older than incomingMaxAge → deleted
// Idempotent. I1: it never INSERTs into gen_jobs — a retry re-queues the
// SAME row (attempt is kept, the next claim increments it).

'use strict';

const fs = require('fs');
const path = require('path');
const { withTx, notifyProgress } = require('./util');

const BATCH = 200;

function createSweeper({ pool, accept, outputDir = null, offlineAfterMs = 60_000, incomingMaxAgeMs = 60 * 60_000, logger = console }) {
    const offlineAfterS = Math.max(1, Math.round(offlineAfterMs / 1000));

    async function failMany(rows, cls, reason) {
        let n = 0;
        for (const row of rows) {
            const r = await accept.failAttempt(row.job_id, row.attempt, cls, reason);
            if (r.status === 200) n += 1;
        }
        return n;
    }

    const NOTHING_LIVE_SQL = `
        NOT EXISTS (SELECT 1 FROM gen_command_jobs l JOIN gen_jobs j ON j.job_id = l.job_id
                    WHERE l.command_id = c.command_id AND j.status IN ('queued','running'))`;

    async function finishCommands() {
        const cand = await pool.query(
            `SELECT c.command_id FROM gen_commands c WHERE c.status = 'active' AND ${NOTHING_LIVE_SQL} LIMIT ${BATCH}`);
        let n = 0;
        for (const { command_id: id } of cand.rows) {
            const done = await withTx(pool, async (client) => {
                const c = (await client.query(
                    `SELECT c.* FROM gen_commands c WHERE c.command_id = $1 AND c.status = 'active' AND ${NOTHING_LIVE_SQL}
                     FOR UPDATE OF c SKIP LOCKED`, [id])).rows[0];
                if (!c) return false;
                const k = (await client.query(
                    `SELECT count(*) FILTER (WHERE status = 'done')::int AS done,
                            count(*) FILTER (WHERE status = 'failed')::int AS failed,
                            count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
                     FROM gen_command_jobs l JOIN gen_jobs j ON j.job_id = l.job_id
                     WHERE l.command_id = $1`, [id])).rows[0];
                let status;
                if (k.failed === 0 && k.cancelled === 0) status = 'done';
                else if (k.done > 0) status = 'partial';
                else if (k.failed > 0) status = 'failed';
                else status = 'cancelled';
                const err = k.failed || k.cancelled ? `failed=${k.failed} cancelled=${k.cancelled}` : null;
                await client.query(
                    `UPDATE gen_commands SET status = $2, finished_at = now(), error = $3 WHERE command_id = $1`,
                    [id, status, err]);
                await notifyProgress(client, c.book_id, id);
                return true;
            });
            if (done) n += 1;
        }
        return n;
    }

    async function cleanIncoming() {
        if (!outputDir) return 0;
        let removed = 0;
        let builds;
        try { builds = await fs.promises.readdir(outputDir, { withFileTypes: true }); } catch (_) { return 0; }
        const cutoff = Date.now() - incomingMaxAgeMs;
        for (const d of builds) {
            if (!d.isDirectory()) continue;
            const dir = path.join(outputDir, d.name, '.incoming');
            let files;
            try { files = await fs.promises.readdir(dir); } catch (_) { continue; }
            for (const f of files) {
                if (!f.endsWith('.tmp')) continue;
                const p = path.join(dir, f);
                try {
                    const st = await fs.promises.stat(p);
                    if (st.isFile() && st.mtimeMs < cutoff) { await fs.promises.unlink(p); removed += 1; }
                } catch (_) { /* raced with acceptance */ }
            }
        }
        return removed;
    }

    /** One pass. @returns {Promise<{timeouts:number, offline:number, commands_finished:number, tmp_removed:number}>} */
    async function sweepOnce() {
        const expired = await pool.query(
            `SELECT job_id, attempt FROM gen_jobs WHERE status = 'running' AND deadline < now()
             ORDER BY deadline LIMIT ${BATCH}`);
        const timeouts = await failMany(expired.rows, 'timeout', 'deadline exceeded');

        const silent = await pool.query(
            `SELECT j.job_id, j.attempt FROM gen_jobs j
               LEFT JOIN workers w ON w.worker_id = j.worker_id
              WHERE j.status = 'running' AND j.executor <> 'local'
                AND (w.worker_id IS NULL OR w.last_seen IS NULL
                     OR w.last_seen < floor(extract(epoch from now()))::bigint - $1)
              LIMIT ${BATCH}`, [offlineAfterS]);
        const offline = await failMany(silent.rows, 'worker_offline', `worker silent > ${offlineAfterS}s`);

        const commandsFinished = await finishCommands();
        const tmpRemoved = await cleanIncoming();
        return { timeouts, offline, commands_finished: commandsFinished, tmp_removed: tmpRemoved };
    }

    let timer = null;
    let busy = false;
    let stopped = true;
    function startSweeper(intervalMs = 10_000) {
        if (!stopped) return;
        stopped = false;
        const tick = async () => {
            if (stopped) return;
            if (!busy) {
                busy = true;
                try { await sweepOnce(); } catch (err) {
                    logger.error && logger.error(`[gen-v2] sweeper: ${err && err.message}`);
                } finally { busy = false; }
            }
            if (!stopped) { timer = setTimeout(tick, intervalMs); if (timer.unref) timer.unref(); }
        };
        timer = setTimeout(tick, intervalMs);
        if (timer.unref) timer.unref();
    }
    function stopSweeper() {
        stopped = true;
        if (timer) clearTimeout(timer);
        timer = null;
    }

    return { sweepOnce, startSweeper, stopSweeper };
}

module.exports = { createSweeper };
