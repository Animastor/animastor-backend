// ======================================================
// Fresh worker logs — on-disk store (ORCHESTRATION_V2 §8.5)
// ======================================================
// The backend is the ONLY writer of these files. One directory per worker:
//
//   {WORKER_LOGS_DIR}/{worker_id}/current.log    newest lines
//   {WORKER_LOGS_DIR}/{worker_id}/current.log.1  previous 5 MB block
//
// Contract:
//   - worker_id is validated as a UUID BEFORE it touches the filesystem —
//     a request body can never inject a path;
//   - directory 0700, files 0600;
//   - append-only; when current.log grows past MAX_BYTES it is rotated to
//     current.log.1 and any older .1 is deleted (exactly two files per
//     worker, bounded disk usage);
//   - each line is written as `ts level msg` (one physical line per entry —
//     newlines inside msg are escaped), so an operator/`tail` sees a stable
//     shape;
//   - writes are serialized per worker (append+stat+rotate is atomic from
//     this process's point of view) but the returned promise is the only
//     thing a caller can await — the HTTP request that triggered it is not
//     blocked by any other worker's I/O.
//
// The store never reads the DB: the route resolves the worker row (identity
// + log_shipping opt-in) and calls in here only after that check.

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('../config/runtime-config');

const MAX_BYTES = 5 * 1024 * 1024; // rotate > 5 MB
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const CURRENT = 'current.log';
const PREVIOUS = 'current.log.1';
const MAX_MSG_CHARS = 8192;
const DEFAULT_TAIL = 200;
const MAX_TAIL = 2000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'warning', 'error', 'fatal', 'comfy']);

// WORKER_LOGS_DIR is read lazily so tests can point the store at a temp
// directory after runtime-config has already been loaded.
function rootDir() {
    return process.env.WORKER_LOGS_DIR || config.WORKER_LOGS_DIR;
}

function workerDir(workerId) {
    return path.join(rootDir(), workerId);
}

function currentFile(workerId) {
    return path.join(workerDir(workerId), CURRENT);
}

function previousFile(workerId) {
    return path.join(workerDir(workerId), PREVIOUS);
}

function isUuid(value) {
    return UUID_RE.test(String(value == null ? '' : value));
}

/** One wire line → one physical file line. Never throws. */
function formatLine(line) {
    const src = line && typeof line === 'object' ? line : {};
    const ts = typeof src.ts === 'string' && /^[0-9A-Za-z:.,+\- ]{8,64}$/.test(src.ts)
        ? src.ts
        : new Date().toISOString();
    const rawLevel = String(src.level == null ? 'info' : src.level).toLowerCase();
    const level = ALLOWED_LEVELS.has(rawLevel) ? rawLevel : 'info';
    let msg = src.msg == null ? '' : String(src.msg);
    // Keep the file line-oriented: an embedded newline would let a worker
    // forge extra log records.
    msg = msg.replace(/\r\n/g, '\\n').replace(/[\r\n]/g, '\\n').slice(0, MAX_MSG_CHARS);
    return `${ts} ${level} ${msg}\n`;
}

// ── per-worker serialization ─────────────────────────────────────────────
// append → stat → maybe rotate must not interleave for the same worker.
const chains = new Map();

function serialize(workerId, task) {
    const prev = chains.get(workerId) || Promise.resolve();
    const run = prev.then(task, task);
    chains.set(workerId, run);
    // Drop the tail reference once settled; `run.catch` keeps an unhandled
    // rejection from surfacing on the cleanup branch only.
    run.catch(() => {}).then(() => {
        if (chains.get(workerId) === run) chains.delete(workerId);
    });
    return run;
}

/**
 * Append one batch of wire lines for a worker.
 * @param {string} workerId - UUID (validated; path injection is impossible)
 * @param {Array<{ts?:string,level?:string,msg?:string}>} lines
 * @returns {Promise<{written:number, rotated:boolean}>}
 */
function writeLines(workerId, lines) {
    if (!isUuid(workerId)) {
        return Promise.reject(Object.assign(new Error('worker_id must be a UUID'), { code: 'bad_worker_id' }));
    }
    const batch = Array.isArray(lines) ? lines : [];
    if (batch.length === 0) return Promise.resolve({ written: 0, rotated: false });
    const text = batch.map(formatLine).join('');
    return serialize(workerId, async () => {
        const dir = workerDir(workerId);
        await fsp.mkdir(dir, { recursive: true, mode: DIR_MODE });
        await fsp.chmod(dir, DIR_MODE).catch(() => {});
        const file = currentFile(workerId);
        await fsp.appendFile(file, text, { encoding: 'utf8', mode: FILE_MODE });
        await fsp.chmod(file, FILE_MODE).catch(() => {});
        const stat = await fsp.stat(file);
        let rotated = false;
        if (stat.size > MAX_BYTES) {
            const prev = previousFile(workerId);
            await fsp.rm(prev, { force: true });
            await fsp.rename(file, prev);
            rotated = true;
        }
        return { written: batch.length, rotated };
    });
}

async function readFileLines(file) {
    let raw;
    try {
        raw = await fsp.readFile(file, 'utf8');
    } catch (err) {
        if (err && err.code === 'ENOENT') return [];
        throw err;
    }
    return raw.split('\n').filter((l) => l.length > 0);
}

/**
 * Tail of a worker's log. The current file is preferred; when it holds
 * fewer than N lines the tail of the rotated file is prepended (still the
 * newest N lines overall).
 * @param {string} workerId - UUID
 * @param {number} [lineCount] - 1..2000 (default 200)
 * @returns {Promise<string[]>}
 */
async function readTail(workerId, lineCount = DEFAULT_TAIL) {
    if (!isUuid(workerId)) {
        throw Object.assign(new Error('worker_id must be a UUID'), { code: 'bad_worker_id' });
    }
    const n = Math.max(1, Math.min(MAX_TAIL, Number(lineCount) || DEFAULT_TAIL));
    const current = await readFileLines(currentFile(workerId));
    if (current.length >= n) return current.slice(-n);
    const previous = await readFileLines(previousFile(workerId));
    return previous.slice(-(n - current.length)).concat(current);
}

module.exports = {
    MAX_BYTES,
    DEFAULT_TAIL,
    MAX_TAIL,
    isUuid,
    formatLine,
    writeLines,
    readTail,
    rootDir,
};