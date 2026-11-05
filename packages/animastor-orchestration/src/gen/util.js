// ======================================================
// gen/util — shared helpers of the v2 orchestration core
// ======================================================
// No I/O except through the pg pool handed in by the host. No requires of
// src/legacy, Redis, Express or ComfyUI (ADR ORCHESTRATION_V2 §5).

'use strict';

const crypto = require('crypto');

/** Error with an HTTP-ish status and a stable machine code. */
class GenError extends Error {
    constructor(code, status, message, extra) {
        super(message || code);
        this.name = 'GenError';
        this.code = code;
        this.status = status;
        if (extra) Object.assign(this, extra);
    }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }

function requireUuid(v, name) {
    if (!isUuid(v)) throw new GenError('bad_request', 400, `${name} must be a UUID`);
    return v;
}

function requireText(v, name, max = 256) {
    if (typeof v !== 'string' || v.length === 0 || v.length > max) {
        throw new GenError('bad_request', 400, `${name} must be a non-empty string (<= ${max})`);
    }
    return v;
}

/**
 * Run fn(client) inside BEGIN/COMMIT on a dedicated pooled client.
 * Rolls back on throw. The client is always released.
 */
async function withTx(pool, fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* connection gone */ }
        throw err;
    } finally {
        client.release();
    }
}

// ── kinds / executors / layers ───────────────────────────────────────────
const KINDS = Object.freeze(['audio_chunk', 'iu_image', 'video_group', 'audio_merge', 'video_merge']);
const EXECUTOR_OF_KIND = Object.freeze({
    audio_chunk: 'gpu:audio',
    iu_image: 'gpu:image',
    video_group: 'gpu:video',
    audio_merge: 'local',
    video_merge: 'local',
});
const LAYER_OF_KIND = Object.freeze({
    audio_chunk: 'audio',
    audio_merge: 'audio',
    iu_image: 'image',
    video_group: 'video',
    video_merge: 'video',
});
/** Kinds a command may create directly (first stage, ADR §6.1 п.5 / §6.3). */
const FIRST_STAGE_KINDS = Object.freeze(['audio_chunk', 'iu_image', 'video_group']);
const LAYERS = Object.freeze(['audio', 'image', 'video']);
const WORKER_TYPES = LAYERS;
const LIVE = Object.freeze(['queued', 'running']);

// ── upload token (ADR §7: HMAC of job_id, attempt, exp) ──────────────────
function sign(secret, jobId, attempt, exp) {
    return crypto.createHmac('sha256', secret)
        .update(`gen-upload:v1:${jobId}:${attempt}:${exp}`)
        .digest('base64url');
}

function issueUploadToken(secret, jobId, attempt, exp) {
    return `v1.${exp}.${sign(secret, jobId, attempt, exp)}`;
}

/** @returns {boolean} true when the token is a valid, unexpired one for (jobId, attempt). */
function verifyUploadToken(secret, token, jobId, attempt, nowMs = Date.now()) {
    if (typeof token !== 'string') return false;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return false;
    const exp = Number(parts[1]);
    if (!Number.isSafeInteger(exp) || exp < nowMs) return false;
    const expected = Buffer.from(sign(secret, jobId, attempt, exp));
    const got = Buffer.from(parts[2]);
    return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

// ── NOTIFY (ADR §9: payload book_id, command_id; delivered on COMMIT) ─────
const PROGRESS_CHANNEL = 'gen_progress';
async function notifyProgress(client, bookId, commandId) {
    await client.query('SELECT pg_notify($1, $2)', [PROGRESS_CHANNEL,
        JSON.stringify({ book_id: bookId, command_id: commandId || null })]);
}

// SQL: layer of a gen_jobs row (alias j) — mirrors LAYER_OF_KIND
const JOB_LAYER_SQL = (j = 'j') => `(CASE ${j}.kind
    WHEN 'audio_chunk' THEN 'audio' WHEN 'audio_merge' THEN 'audio'
    WHEN 'iu_image' THEN 'image'
    WHEN 'video_group' THEN 'video' WHEN 'video_merge' THEN 'video' END)`;

// SQL: job j is a unit command c «joined» (§6.1 п.4, §9): inside c's scope and
// layers and already existing when c was created (a later job of another
// command is not something c waits for). Granularity for level=unit is the
// scene (unit ids are host-defined).
const IN_SCOPE_SQL = (j = 'j', c = 'c') => `(
    ${j}.book_id = ${c}.book_id
    AND ${j}.created_at <= ${c}.created_at
    AND ${JOB_LAYER_SQL(j)} = ANY(${c}.layers)
    AND (
        ${c}.scope->>'level' = 'book'
        OR (${c}.scope->>'level' = 'chapter' AND ${j}.chapter_id = ${c}.scope->>'chapter_id')
        OR (${c}.scope->>'level' IN ('scene','unit') AND ${j}.scene_id = ${c}.scope->>'scene_id'
            AND (${c}.scope->>'chapter_id' IS NULL OR ${j}.chapter_id = ${c}.scope->>'chapter_id'))
    ))`;

module.exports = {
    PROGRESS_CHANNEL,
    notifyProgress,
    JOB_LAYER_SQL,
    IN_SCOPE_SQL,
    GenError,
    isUuid,
    requireUuid,
    requireText,
    withTx,
    KINDS,
    EXECUTOR_OF_KIND,
    LAYER_OF_KIND,
    FIRST_STAGE_KINDS,
    LAYERS,
    WORKER_TYPES,
    LIVE,
    issueUploadToken,
    verifyUploadToken,
};
