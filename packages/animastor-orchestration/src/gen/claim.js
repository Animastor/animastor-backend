// ======================================================
// gen/claim — hand work to a worker (ADR §8.1) + beacon (§8.3)
// ======================================================
// One SQL statement picks and takes the job: FOR UPDATE SKIP LOCKED, so two
// concurrent claims never get the same row. Order: the worker's own lane
// first (private → borrowed share lane, as gpu-hub pop), then fairness —
// the workspace with the fewest running jobs — then age.
//
// shared_limit (§10, §13.3): how many jobs of ONE workspace may run at once
// on shared GPUs (lanes system/policy). NULL = off. Private lanes: no limit.

'use strict';

const {
    GenError, withTx, requireUuid, isUuid, issueUploadToken, notifyProgress, KINDS, WORKER_TYPES,
} = require('./util');

const MODES = Object.freeze(['private', 'share', 'system']);

function createClaim({ pool, ports, uploadSecret, accept, sharedLimit = null, tokenGraceMs = 15 * 60_000 }) {
    const timeoutsJson = JSON.stringify(Object.fromEntries(KINDS.map((k) => [k, ports.timeoutFor(k)])));

    /**
     * @param {object} p
     * @param {string} p.workerId
     * @param {'audio'|'image'|'video'} p.workerType
     * @param {'private'|'share'|'system'} p.mode
     * @param {string|null} [p.workspaceId]  required for mode=private
     * @param {string[]} [p.policyIds]       users-share policies the worker serves (borrowed lane)
     * @param {boolean} [p.sharePublic]      private worker with a public share policy borrows the system lane
     * @param {number|null} [p.sharedLimit]  overrides the module setting for this call
     * @returns {Promise<{task:null}|{task:object}>}
     */
    async function claim(p = {}) {
        const workerId = requireUuid(p.workerId, 'workerId');
        if (!WORKER_TYPES.includes(p.workerType)) throw new GenError('bad_request', 400, 'workerType must be audio|image|video');
        if (!MODES.includes(p.mode)) throw new GenError('bad_request', 400, 'mode must be private|share|system');
        const workspaceId = p.mode === 'private' ? requireUuid(p.workspaceId, 'workspaceId') : null;
        const policyIds = Array.isArray(p.policyIds) ? p.policyIds.filter(isUuid) : [];
        const limit = p.sharedLimit !== undefined ? p.sharedLimit : sharedLimit;
        if (limit !== null && !(Number.isInteger(limit) && limit >= 0)) throw new GenError('bad_request', 400, 'sharedLimit must be NULL or an integer >= 0');
        const executor = `gpu:${p.workerType}`;

        // lane predicate + rank (0 = own lane, 1 = borrowed spare capacity)
        let laneSql;
        let rankSql;
        if (p.mode === 'private') {
            const borrow = [];
            if (policyIds.length) borrow.push(`(j.lane->>'kind' = 'policy' AND j.lane->>'policy_id' = ANY($5::text[]))`);
            if (p.sharePublic === true) borrow.push(`(j.lane->>'kind' = 'system')`);
            laneSql = `((j.lane->>'kind' = 'private' AND j.lane->>'workspace_id' = $4::text)${borrow.length ? ' OR ' + borrow.join(' OR ') : ''})`;
            rankSql = `(CASE WHEN j.lane->>'kind' = 'private' THEN 0 ELSE 1 END)`;
        } else {
            laneSql = policyIds.length
                ? `(j.lane->>'kind' = 'system' OR (j.lane->>'kind' = 'policy' AND j.lane->>'policy_id' = ANY($5::text[])))`
                : `(j.lane->>'kind' = 'system')`;
            rankSql = '(0)::int';
        }

        const job = await withTx(pool, async (client) => {
            // the count-then-take of shared_limit must not race with a twin claim
            if (limit !== null) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`animastor:gen-v2:claim:${executor}`]);
            const r = await client.query(
                `WITH cand AS (
                    SELECT j.job_id
                    FROM gen_jobs j
                    WHERE j.status = 'queued'
                      AND j.executor = $1
                      AND j.not_before <= now()
                      AND ${laneSql}
                      AND ($4::text IS NULL OR $4::text IS NOT NULL)      -- bind every parameter's type
                      AND ($5::text[] IS NULL OR $5::text[] IS NOT NULL)
                      AND ($3::int IS NULL OR j.lane->>'kind' = 'private' OR
                           (SELECT count(*) FROM gen_jobs r
                             WHERE r.workspace_id = j.workspace_id AND r.status = 'running'
                               AND r.executor = j.executor AND r.lane->>'kind' <> 'private') < $3::int)
                    ORDER BY ${rankSql},
                             (SELECT count(*) FROM gen_jobs r WHERE r.workspace_id = j.workspace_id AND r.status = 'running'),
                             j.created_at, j.job_id
                    LIMIT 1
                    FOR UPDATE OF j SKIP LOCKED
                 )
                 UPDATE gen_jobs j
                    SET status = 'running', attempt = j.attempt + 1, worker_id = $2,
                        claimed_at = now(),
                        deadline = now() + make_interval(secs => (($6::jsonb)->>j.kind)::numeric / 1000)
                   FROM cand
                  WHERE j.job_id = cand.job_id
                 RETURNING j.*`,
                [executor, workerId, limit, workspaceId, policyIds, timeoutsJson]);
            const row = r.rows[0];
            if (!row) return null;
            await client.query(
                `UPDATE workers SET current_job_id = $2, last_seen = floor(extract(epoch from now()))::bigint
                 WHERE worker_id = $1 AND revoked_at IS NULL`, [workerId, row.job_id]);
            await notifyProgress(client, row.book_id, row.command_id);
            return row;
        });
        if (!job) return { task: null };

        let payload;
        try {
            payload = await ports.buildPayload(job);
        } catch (err) {
            // the payload cannot be built → this attempt fails deterministically (no silent loss)
            await accept.failAttempt(job.job_id, job.attempt, 'deterministic', `build_payload: ${err && err.message}`);
            return { task: null };
        }
        const deadlineMs = new Date(job.deadline).getTime();
        const exp = deadlineMs + tokenGraceMs;
        return {
            task: {
                job_id: job.job_id,
                attempt: job.attempt,
                kind: job.kind,
                book_id: job.book_id,
                chapter_id: job.chapter_id,
                scene_id: job.scene_id,
                unit_key: job.unit_key,
                params: payload,
                timeout_ms: ports.timeoutFor(job.kind),
                deadline: new Date(deadlineMs).toISOString(),
                upload_token: issueUploadToken(uploadSecret, job.job_id, job.attempt, exp),
            },
        };
    }

    /**
     * Worker liveness (ADR §8.3): last_seen + current_job_id; answer = jobs to stop.
     * cancel = this worker's jobs cancelled in the last hour + the reported
     * current job when it is no longer running for this worker.
     * @returns {Promise<{cancel:string[], known:boolean}>}
     */
    async function beacon(workerId, body = {}) {
        requireUuid(workerId, 'workerId');
        const current = isUuid(body.current_job_id) ? body.current_job_id : null;
        return withTx(pool, async (client) => {
            const upd = await client.query(
                `UPDATE workers SET last_seen = floor(extract(epoch from now()))::bigint, status = 'online', current_job_id = $2
                 WHERE worker_id = $1 AND revoked_at IS NULL`, [workerId, current]);
            const r = await client.query(
                `SELECT job_id FROM gen_jobs
                  WHERE worker_id = $1 AND status = 'cancelled' AND finished_at > now() - interval '1 hour'
                 UNION
                 SELECT job_id FROM gen_jobs
                  WHERE job_id = $2::uuid AND NOT (status = 'running' AND worker_id = $1)`,
                [workerId, current]);
            return { cancel: r.rows.map((x) => x.job_id), known: upd.rowCount > 0 };
        });
    }

    return { claim, beacon };
}

module.exports = { createClaim, MODES };
