// ======================================================
// gen/accept — result / error acceptance (ADR §7, transitions §6.3)
// ======================================================
// I2: the job status lives only in gen_jobs; scene_assets is written only
//     here (the acceptance transaction).
// I4: a result is accepted only for the CURRENT attempt of a running job;
//     anything else → 409 stale_attempt and the uploaded file is discarded.
// I5: `ready` only after a real result with sha256 has been renamed into place.
//
// Lock order everywhere: gen_commands rows linked to the job (FOR SHARE /
// UPDATE) → gen_jobs row (FOR UPDATE) → scene advisory lock. cancel() takes
// the same order. Stage transitions follow gen_command_jobs (§4.2a, §6.3).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
    GenError, withTx, isUuid, notifyProgress, verifyUploadToken, linkJobs,
    EXECUTOR_OF_KIND, LAYER_OF_KIND, LIVE,
} = require('./util');
const { checkLane } = require('./ports');
const { msBetween } = require('./log');
const {
    normalisePlan, readyParts, mergePartsOf, mergeUnitFor, linkSceneLive, recordSkips,
} = require('./stage');

const NOOP_LOG = Object.freeze({ event() {} });
/** Mode of an accepted artifact: world-readable like the legacy outputs (О3; the tmp file is 0640). */
const ARTIFACT_MODE = 0o644;
const dim = (v) => (Number.isInteger(v) && v > 0 ? v : null);

const PART_KINDS = new Set(['audio_chunk', 'iu_image', 'video_group']);
const FINAL_FORMAT = { audio_merge: 'mp3', video_merge: 'mp4' };
const PART_FORMAT = { iu_image: 'png' };

/** input.scene_parts → [{unit_key, part_hash}] (non-empty, string fields) or null. */
function partsManifest(v) {
    if (!Array.isArray(v) || v.length === 0) return null;
    const out = [];
    for (const p of v) {
        if (!p || typeof p.unit_key !== 'string' || !p.unit_key || typeof p.part_hash !== 'string' || !p.part_hash) return null;
        out.push({ unit_key: p.unit_key, part_hash: p.part_hash });
    }
    return out;
}
const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

function epochS() { return Math.floor(Date.now() / 1000); }

async function unlinkQuiet(p) {
    if (!p) return;
    try { await fs.promises.unlink(p); } catch (_) { /* already gone */ }
}

async function drain(stream) {
    if (!stream || typeof stream.resume !== 'function') return;
    try { stream.resume(); } catch (_) { /* ignore */ }
}

function createAccept({ pool, ports, uploadSecret, maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES, genLog = NOOP_LOG }) {
    const sceneLockKey = (j) => `animastor:gen-v2:scene:${JSON.stringify([j.book_id, j.chapter_id, j.scene_id])}`;

    // ── shared: a failed attempt → retry with backoff or failed (§7 «Ошибка», §9 пп.1–2)
    async function failAttemptTx(client, job, errorClass, reason) {
        const policy = ports.retryPolicy(job.kind, errorClass, job.attempt, { previousErrorClass: job.error_class || null }) || { retry: false, delay_ms: 0 };
        const retry = policy.retry === true && job.attempt < job.max_attempts;
        const delay = Math.max(0, Number(policy.delay_ms) || 0);
        const r = retry
            ? await client.query(
                `UPDATE gen_jobs SET status = 'queued', not_before = now() + make_interval(secs => $2::numeric / 1000),
                        worker_id = NULL, deadline = NULL, error_class = $3, error = $4
                 WHERE job_id = $1 RETURNING status, not_before`,
                [job.job_id, delay, errorClass, reason])
            : await client.query(
                `UPDATE gen_jobs SET status = 'failed', finished_at = now(), deadline = NULL, error_class = $2, error = $3
                 WHERE job_id = $1 RETURNING status, not_before`,
                [job.job_id, errorClass, reason]);
        if (job.worker_id) {
            await client.query(
                'UPDATE workers SET current_job_id = NULL WHERE worker_id = $1 AND current_job_id = $2',
                [job.worker_id, job.job_id]);
        }
        await notifyProgress(client, job.book_id, job.command_id);
        return { status: r.rows[0].status, not_before: r.rows[0].not_before, retry, delay_ms: retry ? delay : undefined };
    }

    /**
     * Fail the given attempt (one transaction). 409 when it is not the current running attempt.
     * @returns {Promise<{status:number, job_status?:string, retry?:boolean, code?:string}>}
     */
    async function failAttempt(jobId, attempt, errorClass, reason) {
        const cls = typeof errorClass === 'string' && errorClass ? errorClass.slice(0, 64) : 'unknown';
        const why = reason == null ? null : String(reason).slice(0, 2000);
        let job = null;
        let out = null;
        const r = await withTx(pool, async (client) => {
            job = (await client.query('SELECT * FROM gen_jobs WHERE job_id = $1 FOR UPDATE', [jobId])).rows[0];
            if (!job) return { status: 404, code: 'not_found' };
            if (job.status !== 'running' || job.attempt !== attempt) return { status: 409, code: 'stale_attempt' };
            out = await failAttemptTx(client, job, cls, why);
            return { status: 200, job_status: out.status, retry: out.retry };
        });
        // О3, after commit: `error` for every failed attempt, `requeue` when it goes back to the queue
        const ids = job ? {
            book_id: job.book_id, command_id: job.command_id, job_id: job.job_id, kind: job.kind, unit_key: job.unit_key,
            worker_id: job.worker_id,
        } : { job_id: jobId };
        if (r.status !== 200) {
            genLog.event('error', { ...ids, attempt, error_class: cls, code: r.code });
        } else {
            genLog.event('error', {
                ...ids, attempt, max_attempts: job.max_attempts, error_class: cls, job_status: out.status, retry: out.retry,
                run_ms: msBetween(job.claimed_at),
            });
            if (out.retry) genLog.event('requeue', { ...ids, attempt, max_attempts: job.max_attempts, error_class: cls, delay_ms: out.delay_ms });
        }
        return r;
    }

    // ── scene_assets (§4.3: written only by acceptance) ──────────────────────
    async function upsertSceneAsset(client, job, finalPath, sha, bytes, validation) {
        const assetType = job.layer;
        const build = job.build_id;
        const sceneHash = job.input.scene_hash || null;
        if (PART_KINDS.has(job.kind)) {
            // a part (chunk / IU / group) is recorded, the scene asset is not ready yet
            const entry = { kind: job.kind, path: finalPath, sha256: sha, bytes, job_id: job.job_id, attempt: job.attempt };
            // О3: the PNG validator knows the size — keep it with the part (scene_assets.width/height below)
            if (validation && dim(validation.width) && dim(validation.height)) { entry.width = validation.width; entry.height = validation.height; }
            if (typeof job.input.part_hash === 'string' && job.input.part_hash) entry.part_hash = job.input.part_hash;
            const part = { [job.unit_key]: entry };
            const sceneParts = partsManifest(job.input.scene_parts);
            if (sceneParts) {
                // 1.1.0 — a part kind WITHOUT a merge stage (iu_image): the scene asset is
                // `ready` exactly when every part the planner listed for the scene
                // (input.scene_parts = [{unit_key, part_hash}] in scene order) has an
                // accepted entry with that part_hash; the acceptance that completes the
                // set writes ready + sha256 (of the parts manifest «unit_key:sha256» per
                // line, scene order) + job_id + path (the first part's file). Not complete
                // → 'pending' (a half-regenerated scene is not ready for the new content).
                // The row lock taken by the upsert serialises two IUs of one scene accepted
                // in parallel; the second one sees the first one's part (READ COMMITTED
                // re-reads the committed row on conflict).
                const up = (await client.query(
                    `INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, build_id, scene_hash, status, metadata, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6, 'pending', jsonb_build_object('gen_parts', $7::jsonb), $8)
                     ON CONFLICT (book_id, chapter_id, scene_id, asset_type, build_id) DO UPDATE SET
                         metadata = jsonb_set(
                             CASE WHEN jsonb_typeof(scene_assets.metadata) = 'object' THEN scene_assets.metadata ELSE '{}'::jsonb END,
                             '{gen_parts}',
                             COALESCE(CASE WHEN jsonb_typeof(scene_assets.metadata->'gen_parts') = 'object'
                                           THEN scene_assets.metadata->'gen_parts' END, '{}'::jsonb) || $7::jsonb),
                         updated_at = EXCLUDED.updated_at
                     RETURNING id, metadata->'gen_parts' AS parts`,
                    [job.book_id, job.chapter_id, job.scene_id, assetType, build, sceneHash, JSON.stringify(part), epochS()])).rows[0];
                const parts = up.parts && typeof up.parts === 'object' ? up.parts : {};
                const complete = sceneParts.every((p) => parts[p.unit_key] && parts[p.unit_key].part_hash === p.part_hash);
                if (complete) {
                    const manifest = sceneParts.map((p) => `${p.unit_key}:${parts[p.unit_key].sha256 || ''}`).join('\n');
                    const first = parts[sceneParts[0].unit_key];
                    // width/height = those of the file `path` points at (the first part)
                    await client.query(
                        `UPDATE scene_assets SET scene_hash = $2, status = 'ready', error = NULL, sha256 = $3, job_id = $4,
                                path = $5, format = $6, width = $7, height = $8
                         WHERE id = $1`,
                        [up.id, sceneHash, crypto.createHash('sha256').update(manifest).digest('hex'), job.job_id,
                            first.path || finalPath, PART_FORMAT[job.kind] || null, dim(first.width), dim(first.height)]);
                } else {
                    await client.query(
                        `UPDATE scene_assets SET scene_hash = $2, status = 'pending', sha256 = NULL, job_id = NULL WHERE id = $1`,
                        [up.id, sceneHash]);
                }
                return;
            }
            await client.query(
                `INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, build_id, scene_hash, status, metadata, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, 'pending', jsonb_build_object('gen_parts', $7::jsonb), $8)
                 ON CONFLICT (book_id, chapter_id, scene_id, asset_type, build_id) DO UPDATE SET
                     metadata = jsonb_set(
                         CASE WHEN jsonb_typeof(scene_assets.metadata) = 'object' THEN scene_assets.metadata ELSE '{}'::jsonb END,
                         '{gen_parts}',
                         COALESCE(CASE WHEN jsonb_typeof(scene_assets.metadata->'gen_parts') = 'object'
                                       THEN scene_assets.metadata->'gen_parts' END, '{}'::jsonb) || $7::jsonb),
                     updated_at = EXCLUDED.updated_at`,
                [job.book_id, job.chapter_id, job.scene_id, assetType, build, sceneHash, JSON.stringify(part), epochS()]);
            return;
        }
        const duration = validation && Number.isFinite(validation.durationSec) ? validation.durationSec : null;
        const width = validation ? dim(validation.width) : null;
        const height = validation ? dim(validation.height) : null;
        await client.query(
            `INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, path, build_id, scene_hash, status,
                                       job_id, sha256, duration_sec, format, updated_at, width, height)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'ready', $8, $9, $10, $11, $12, $13, $14)
             ON CONFLICT (book_id, chapter_id, scene_id, asset_type, build_id) DO UPDATE SET
                 path = EXCLUDED.path, scene_hash = EXCLUDED.scene_hash, status = 'ready', error = NULL,
                 job_id = EXCLUDED.job_id, sha256 = EXCLUDED.sha256,
                 duration_sec = COALESCE(EXCLUDED.duration_sec, scene_assets.duration_sec),
                 width = COALESCE(EXCLUDED.width, scene_assets.width),
                 height = COALESCE(EXCLUDED.height, scene_assets.height),
                 format = EXCLUDED.format, updated_at = EXCLUDED.updated_at`,
            [job.book_id, job.chapter_id, job.scene_id, assetType, finalPath, build, sceneHash,
                job.job_id, sha, duration, FINAL_FORMAT[job.kind], epochS(), width, height]);
    }

    // ── stage transitions (§6.3) — same transaction as the finished job ─────
    /** Insert (or join) next-stage jobs and link them to every qualifying command. */
    async function insertStageJobs(client, cmds, units) {
        let created = 0;
        const owner = cmds[0];
        const ids = cmds.map((c) => c.command_id);
        for (const u of units) {
            const executor = EXECUTOR_OF_KIND[u.kind];
            let lane = null;
            if (executor !== 'local') {
                lane = await ports.laneFor(owner.workspace_id, executor.slice(4));
                if (!checkLane(lane)) throw new GenError('bad_lane', 500, 'laneFor returned an invalid lane');
            }
            const r = await client.query(
                `INSERT INTO gen_jobs (command_id, workspace_id, user_id, book_id, chapter_id, scene_id, unit_key,
                                       kind, executor, layer, build_id, lane, max_attempts, input, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14::jsonb, clock_timestamp())
                 ON CONFLICT (book_id, chapter_id, scene_id, kind, unit_key) WHERE status IN ('queued','running')
                 DO NOTHING RETURNING job_id`,
                [owner.command_id, owner.workspace_id, owner.user_id, owner.book_id, u.chapter_id, u.scene_id, u.unit_key,
                    u.kind, executor, LAYER_OF_KIND[u.kind], u.build_id, lane ? JSON.stringify(lane) : null,
                    ports.maxAttemptsFor(u.kind), JSON.stringify(u.input)]);
            created += r.rowCount;
            const live = await client.query(
                `SELECT job_id FROM gen_jobs WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3 AND kind = $4
                   AND unit_key = $5 AND status IN ('queued','running')`,
                [owner.book_id, u.chapter_id, u.scene_id, u.kind, u.unit_key]);
            await linkJobs(client, ids, live.rows.map((x) => x.job_id));
        }
        return created;
    }

    /**
     * Stage complete for the scene: nothing of `kind` live for the scene, and every unit of
     * `kind` the qualifying commands wait for has its LATEST job (same build + content) done.
     */
    async function sceneStageComplete(client, job, kind, commandIds) {
        const live = await client.query(
            `SELECT 1 FROM gen_jobs WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3 AND kind = $4
               AND status = ANY($5::text[]) LIMIT 1`,
            [job.book_id, job.chapter_id, job.scene_id, kind, LIVE]);
        if (live.rowCount) return false;
        const r = await client.query(
            `WITH units AS (
                SELECT DISTINCT j.unit_key FROM gen_jobs j JOIN gen_command_jobs l ON l.job_id = j.job_id
                WHERE l.command_id = ANY($6::uuid[]) AND j.book_id = $1 AND j.chapter_id = $2 AND j.scene_id = $3 AND j.kind = $4
             ), latest AS (
                SELECT DISTINCT ON (j.unit_key) j.unit_key, j.status FROM gen_jobs j JOIN units u ON u.unit_key = j.unit_key
                WHERE j.book_id = $1 AND j.chapter_id = $2 AND j.scene_id = $3 AND j.kind = $4 AND j.build_id = $5
                ORDER BY j.unit_key, j.created_at DESC
             )
             SELECT (SELECT count(*) FROM units)::int AS units,
                    (SELECT count(*) FROM latest WHERE status = 'done')::int AS done`,
            [job.book_id, job.chapter_id, job.scene_id, kind, job.build_id, commandIds]);
        return r.rows[0].units > 0 && r.rows[0].units === r.rows[0].done;
    }

    /** Latest done part of every unit of the scene for this build/content (merge input snapshot). */
    async function doneParts(client, job, kind) {
        const r = await client.query(
            `SELECT DISTINCT ON (unit_key) unit_key, job_id, result_path, result_sha256, input->'part_meta' AS meta
             FROM gen_jobs
             WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3 AND kind = $4 AND status = 'done'
               AND build_id = $5 AND (input->>'scene_hash') IS NOT DISTINCT FROM $6
             ORDER BY unit_key, finished_at DESC`,
            [job.book_id, job.chapter_id, job.scene_id, kind, job.build_id, job.input.scene_hash ?? null]);
        return r.rows.map((x) => ({ unit_key: x.unit_key, job_id: x.job_id, path: x.result_path, sha256: x.result_sha256, meta: x.meta || null }));
    }

    /** Is the scene asset of this layer already ready for exactly this content? */
    async function sceneReady(client, job, layer, sceneHash) {
        if (!sceneHash) return false;
        const r = await client.query(
            `SELECT 1 FROM scene_assets WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3 AND asset_type = $4
               AND build_id = $5 AND status = 'ready' AND scene_hash = $6 LIMIT 1`,
            [job.book_id, job.chapter_id, job.scene_id, layer, job.build_id, sceneHash]);
        return r.rowCount > 0;
    }

    /**
     * 1.3.0 — the video stage of one scene (§6.3, §6.5, §13 п.11): asked after the last
     * IU of the scene and after its audio merge. The host video planner, run on THIS
     * transaction, decides: groups now / wait (join the live images or audio) / skip
     * with a reason (recorded for the commands, insert-only).
     */
    async function videoStage(client, qualifying, job) {
        const owner = qualifying[0];
        const ids = qualifying.map((c) => c.command_id);
        const force = qualifying.some((c) => c.force === true);
        const plan = normalisePlan(await ports.planUnits(
            { bookId: owner.book_id, workspaceId: owner.workspace_id, userId: owner.user_id },
            { level: 'scene', chapter_id: job.chapter_id, scene_id: job.scene_id }, 'video', { db: client }), 'video');
        let units = plan.units.filter((u) => u && u.kind === 'video_group'
            && u.chapter_id === job.chapter_id && u.scene_id === job.scene_id
            && typeof u.unit_key === 'string' && u.unit_key && typeof u.build_id === 'string' && u.build_id
            && u.input && typeof u.input === 'object')
            .map((u) => ({ ...u, input: { ...u.input, scene_hash: u.scene_hash ?? u.input.scene_hash ?? null } }));
        let created = 0;
        if (units.length && !force) {
            const sceneHash = units[0].input.scene_hash;
            if (await sceneReady(client, units[0], 'video', sceneHash)) {
                units = [];                                         // the scene video is current
            } else {
                const done = await readyParts(client, job.book_id, units);
                if (done.size === units.length && mergePartsOf(units[0].input)) {
                    const merge = await mergeUnitFor(client, job.book_id, units[0]);
                    if (merge) { created += await insertStageJobs(client, qualifying, [merge]); units = []; }
                } else if (done.size) {
                    units = units.filter((u) => !done.has(u));
                }
            }
        }
        created += await insertStageJobs(client, qualifying, units);
        if (plan.waits.length) await linkSceneLive(client, ids, job.book_id, plan.waits);
        if (plan.skipped.length) await recordSkips(client, ids, plan.skipped);
        return created;
    }

    /**
     * §6.3: a next stage is created only if at least one command linked to the finished job is
     * active, has the layer and the layer is enabled; the new job is linked to all such commands.
     *   audio_chunk (last of the scene) → audio_merge  — commands with audio, and (1.3.0) video
     *                                                    commands waiting for this audio (§13 п.11 п.3)
     *   iu_image (last of the scene)    → video stage   — commands with video
     *   audio_merge                     → video stage   — commands with video (1.3.0)
     *   video_group (last of the plan)  → video_merge   — by input.merge_parts (1.3.0) or, without
     *                                                    it, every linked group of the scene
     */
    async function transitions(client, cmds, job) {
        const active = cmds.filter((c) => c.status === 'active');
        if (!active.length) return 0;
        const pick = async (layers, enabledLayer) => {
            const out = [];
            for (const c of active) {
                if (layers.some((l) => c.layers.includes(l)) && await ports.isLayerEnabled(c.book_id, enabledLayer)) out.push(c);
            }
            return out;
        };
        const lockScene = () => client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sceneLockKey(job)]);
        const mergeInput = async (kind) => ({
            scene_hash: job.input.scene_hash ?? null,
            parts: await doneParts(client, job, kind),
        });
        const sceneUnit = (kind, input) => ({ chapter_id: job.chapter_id, scene_id: job.scene_id, kind, unit_key: 'scene', build_id: job.build_id, input });

        if (job.kind === 'audio_chunk') {
            const q = await pick(['audio', 'video'], 'audio');
            if (!q.length) return 0;
            await lockScene();
            if (!(await sceneStageComplete(client, job, 'audio_chunk', q.map((c) => c.command_id)))) return 0;
            return insertStageJobs(client, q, [sceneUnit('audio_merge', await mergeInput('audio_chunk'))]);
        }
        if (job.kind === 'video_group') {
            const q = await pick(['video'], 'video');
            if (!q.length) return 0;
            await lockScene();
            if (mergePartsOf(job.input)) {
                const merge = await mergeUnitFor(client, job.book_id, job);
                return merge ? insertStageJobs(client, q, [merge]) : 0;
            }
            if (!(await sceneStageComplete(client, job, 'video_group', q.map((c) => c.command_id)))) return 0;
            return insertStageJobs(client, q, [sceneUnit('video_merge', await mergeInput('video_group'))]);
        }
        if (job.kind === 'iu_image' || job.kind === 'audio_merge') {
            const q = await pick(['video'], 'video');
            if (!q.length) return 0;
            await lockScene();
            if (job.kind === 'iu_image' && !(await sceneStageComplete(client, job, 'iu_image', q.map((c) => c.command_id)))) return 0;
            return videoStage(client, q, job);
        }
        return 0;
    }

    /**
     * Steps 1(validate)–5 of §7 for a file already on disk at tmpPath.
     * @returns {Promise<{status:number, code?:string, reason?:string, idempotent?:boolean, sha256?:string, job_status?:string, stage_jobs_created?:number}>}
     */
    async function finishAccept(pre, attempt, tmpPath, sha, bytes, t0 = Date.now(), localMeta = null) {
        const r = await finishAcceptInner(pre, attempt, tmpPath, sha, bytes, localMeta);
        // О3: `accept` for a committed result (or its idempotent replay); a stale
        // attempt is an `error` line (code stale_attempt); invalid_result is logged by failAttempt.
        const ids = {
            book_id: pre.book_id, command_id: pre.command_id, job_id: pre.job_id, kind: pre.kind, unit_key: pre.unit_key,
            attempt, worker_id: pre.worker_id,
        };
        if (r && r.status === 200) {
            genLog.event('accept', {
                ...ids, sha256: sha, bytes, width: r.width, height: r.height, idempotent: r.idempotent === true ? true : undefined,
                stage_jobs_created: r.stage_jobs_created, ms: Date.now() - t0, run_ms: msBetween(pre.claimed_at),
            });
        } else if (r && r.code === 'stale_attempt') {
            genLog.event('error', { ...ids, code: 'stale_attempt', sha256: sha, bytes });
        }
        if (r) { delete r.width; delete r.height; }
        return r;
    }

    async function finishAcceptInner(pre, attempt, tmpPath, sha, bytes, localMeta = null) {
        const finalPath = ports.artifactPath(pre);
        if (typeof finalPath !== 'string' || !path.isAbsolute(finalPath)) {
            await unlinkQuiet(tmpPath);
            throw new GenError('bad_artifact_path', 500, 'artifactPath(job) must return an absolute path');
        }
        // replay of an already committed attempt — no validation, no writes
        if (pre.status === 'done' && pre.attempt === attempt) {
            await unlinkQuiet(tmpPath);
            return pre.result_sha256 === sha
                ? { status: 200, idempotent: true, sha256: sha, job_status: 'done' }
                : { status: 409, code: 'stale_attempt' };
        }
        const validation = await ports.validateResult(pre, tmpPath);
        if (!validation || validation.ok !== true) {
            await unlinkQuiet(tmpPath);
            const reason = (validation && validation.reason) || 'invalid';
            const r = await failAttempt(pre.job_id, attempt, 'invalid_result', `invalid_result: ${reason}`);
            if (r.status !== 200) return r;
            return { status: 422, code: 'invalid_result', reason, job_status: r.job_status };
        }

        let renamed = false;
        try {
            return await withTx(pool, async (client) => {
                const cmds = (await client.query(
                    `SELECT c.* FROM gen_commands c JOIN gen_command_jobs l ON l.command_id = c.command_id
                     WHERE l.job_id = $1 ORDER BY c.created_at, c.command_id FOR SHARE OF c`, [pre.job_id])).rows;
                const job = (await client.query('SELECT * FROM gen_jobs WHERE job_id = $1 FOR UPDATE', [pre.job_id])).rows[0];
                if (job && job.status === 'done' && job.attempt === attempt && job.result_sha256 === sha) {
                    return { status: 200, idempotent: true, sha256: sha, job_status: 'done' };
                }
                if (!job || job.status !== 'running' || job.attempt !== attempt) {
                    return { status: 409, code: 'stale_attempt' };
                }
                await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
                await fs.promises.rename(tmpPath, finalPath);           // §7 п.3 (atomic, same partition)
                renamed = true;
                await fs.promises.chmod(finalPath, ARTIFACT_MODE).catch(() => {});   // О3: 0644 like legacy outputs
                // e.g. drop the placeholder sidecar; 1.3.0: ctx.db = this transaction, ctx.meta = what runLocal returned
                if (ports.onArtifactPlaced) await ports.onArtifactPlaced(job, finalPath, { db: client, meta: localMeta });
                await client.query(
                    `UPDATE gen_jobs SET status = 'done', result_path = $2, result_sha256 = $3, result_bytes = $4,
                            finished_at = now(), deadline = NULL
                     WHERE job_id = $1`, [job.job_id, finalPath, sha, bytes]);
                if (job.worker_id) {
                    await client.query(
                        'UPDATE workers SET current_job_id = NULL WHERE worker_id = $1 AND current_job_id = $2',
                        [job.worker_id, job.job_id]);
                }
                await upsertSceneAsset(client, job, finalPath, sha, bytes, validation);
                const stage = await transitions(client, cmds, job);
                await notifyProgress(client, job.book_id, job.command_id);
                return {
                    status: 200, sha256: sha, job_status: 'done', stage_jobs_created: stage,
                    width: validation ? dim(validation.width) : null, height: validation ? dim(validation.height) : null,
                };
            });
        } finally {
            if (!renamed) await unlinkQuiet(tmpPath);              // rejected / failed before rename → discard
        }
    }

    async function readJob(jobId) {
        return (await pool.query('SELECT * FROM gen_jobs WHERE job_id = $1', [jobId])).rows[0] || null;
    }

    function checkIds(jobId, attempt) {
        if (!isUuid(jobId)) throw new GenError('not_found', 404, 'unknown job');
        if (!Number.isInteger(attempt) || attempt < 1) throw new GenError('bad_request', 400, 'attempt must be an integer >= 1');
    }

    /**
     * PUT /internal/gen/jobs/:job_id/result?attempt=N (ADR §7).
     * @param {string} jobId
     * @param {number} attempt
     * @param {string} token upload token from claim
     * @param {AsyncIterable<Buffer>} stream raw file body
     */
    async function acceptResult(jobId, attempt, token, stream) {
        const t0 = Date.now();
        checkIds(jobId, attempt);
        if (!verifyUploadToken(uploadSecret, token, jobId, attempt)) {
            await drain(stream);
            throw new GenError('unauthorized', 401, 'bad upload token');
        }
        const pre = await readJob(jobId);
        if (!pre) { await drain(stream); throw new GenError('not_found', 404, 'unknown job'); }
        const current = (pre.status === 'running' || pre.status === 'done') && pre.attempt === attempt;
        if (!current) {
            await drain(stream);
            genLog.event('error', { book_id: pre.book_id, command_id: pre.command_id, job_id: jobId, kind: pre.kind, unit_key: pre.unit_key, attempt, code: 'stale_attempt' });
            return { status: 409, code: 'stale_attempt' };
        }

        const finalPath = ports.artifactPath(pre);
        if (typeof finalPath !== 'string' || !path.isAbsolute(finalPath)) {
            await drain(stream);
            throw new GenError('bad_artifact_path', 500, 'artifactPath(job) must return an absolute path');
        }
        // §7 п.1: stream → {dir}/.incoming/{job_id}.{attempt}.{nonce}.tmp, sha256 + size on the fly, fsync
        const incoming = path.join(path.dirname(finalPath), '.incoming');
        await fs.promises.mkdir(incoming, { recursive: true });
        const tmpPath = path.join(incoming, `${jobId}.${attempt}.${crypto.randomBytes(4).toString('hex')}.tmp`);
        const hash = crypto.createHash('sha256');
        let bytes = 0;
        const fh = await fs.promises.open(tmpPath, 'wx', 0o640);
        try {
            for await (const chunk of stream) {
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                bytes += buf.length;
                if (bytes > maxUploadBytes) throw new GenError('too_large', 413, 'upload exceeds the size limit');
                hash.update(buf);
                await fh.write(buf);
            }
            await fh.sync();
        } catch (err) {
            await fh.close().catch(() => {});
            await unlinkQuiet(tmpPath);
            throw err;
        }
        await fh.close();
        return finishAccept(pre, attempt, tmpPath, hash.digest('hex'), bytes, t0);
    }

    /**
     * POST /internal/gen/jobs/:job_id/error?attempt=N (ADR §7 «Ошибка», §13.2).
     * @param {{error_class?:string, reason?:string}} body
     */
    async function acceptError(jobId, attempt, token, body = {}) {
        checkIds(jobId, attempt);
        if (!verifyUploadToken(uploadSecret, token, jobId, attempt)) throw new GenError('unauthorized', 401, 'bad upload token');
        return failAttempt(jobId, attempt, body.error_class, body.reason);
    }

    /** Accept a file produced by the backend itself (executor='local'); no token. */
    async function acceptLocalFile(job, filePath, meta = null) {
        const hash = crypto.createHash('sha256');
        let bytes = 0;
        for await (const chunk of fs.createReadStream(filePath)) { hash.update(chunk); bytes += chunk.length; }
        return finishAccept(job, job.attempt, filePath, hash.digest('hex'), bytes, Date.now(), meta);
    }

    return { acceptResult, acceptError, failAttempt, acceptLocalFile };
}

module.exports = { createAccept };
