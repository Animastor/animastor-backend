// ======================================================
// gen/log — one-line info events of the v2 core (О3)
// ======================================================
// reports/2026-11-07/orch-v2-image-scene-run.md О3: claim, acceptance and the
// end of a command left no trace in the backend log; the run had to be
// reconstructed from HTTP lines, PG and the worker's own log.
//
//   [gen-v2] <event> key=value key=value ...
//
// Events: command-created | claim | accept | error | requeue | command-finished.
// The logger is the host's port (createOrchestration({ logger })); the core
// never calls console itself. Only ALLOWLISTED fields are printed — never an
// upload token, a path or a payload (those may carry secrets or user text).

'use strict';

const FIELDS = Object.freeze([
    'book_id', 'command_id', 'job_id', 'kind', 'unit_key', 'attempt', 'max_attempts', 'worker_id', 'executor', 'source',
    'status', 'job_status', 'code', 'error_class', 'retry', 'delay_ms',
    'sha256', 'bytes', 'width', 'height', 'idempotent', 'stage_jobs_created',
    'layers', 'scope', 'existing', 'jobs_created', 'joined', 'skipped_ready', 'done', 'failed', 'cancelled',
    'ms', 'run_ms',
]);
const ALLOWED = new Set(FIELDS);

function fmt(v) {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v.map(String).join(',');
    if (typeof v === 'object') return JSON.stringify(v);
    const s = String(v);
    return /[\s"=]/.test(s) ? JSON.stringify(s) : s;
}

/** Pure: event name + fields → the log line (allowlisted keys, stable order). */
function formatGenEvent(event, fields = {}) {
    const parts = [`[gen-v2] ${event}`];
    for (const k of FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(fields, k)) continue;
        const v = fmt(fields[k]);
        if (v !== null) parts.push(`${k}=${v}`);
    }
    return parts.join(' ');
}

/** @param {object|null|undefined} logger host logger port ({info?, log?, warn?, error?}) */
function createGenLog(logger) {
    const sink = logger && (typeof logger.info === 'function' ? logger.info.bind(logger)
        : typeof logger.log === 'function' ? logger.log.bind(logger) : null);
    function event(name, fields) {
        if (!sink) return;
        try { sink(formatGenEvent(name, fields)); } catch (_) { /* logging never breaks the core */ }
    }
    return { event };
}

/** Milliseconds between two timestamps (Date | string | number); null when unknown. */
function msBetween(from, to = Date.now()) {
    const a = from instanceof Date ? from.getTime() : (from == null ? NaN : new Date(from).getTime());
    const b = to instanceof Date ? to.getTime() : new Date(to).getTime();
    return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round(b - a)) : null;
}

module.exports = { createGenLog, formatGenEvent, msBetween, FIELDS, ALLOWED };
