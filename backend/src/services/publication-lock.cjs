'use strict';
// ======================================================
// ANIMASTOR BACKEND — CROSS-PROCESS PUBLICATION LOCK
// (Stage 137 · audit 136 P1-A)
// ======================================================
//
// The canonical artifact path is shared by every generation of a logical task
// (book/chapter/scene/job). Redis can order the INTENT of those generations,
// but the staged→canonical rename is a filesystem operation and Redis and the
// filesystem are not one transaction. Stage 136 proved the consequence:
//
//   F1 checks intent (current) → pauses → F2 supersedes and publishes →
//   F1 resumes and renames its stale bytes over F2.
//
// The only way to prevent that without a distributed filesystem CAS is to
// make the whole "re-read intent + rename + verify" critical section mutually
// exclusive between PROCESSES, not just within one Node.js event loop. This
// module provides that mutual exclusion with a filesystem lock:
//
//   {OUTPUT_DIR}/.publication-locks/{sha256(task)}.lock/owner.json
//
// Ownership:
//   · the lock is a directory created with `mkdir` (atomic on POSIX);
//   · `owner.json` carries {token, pid, host, created_at};
//   · only the token owner may release the lock (compare-and-delete);
//   · a live owner is NEVER expired by wall-clock time — a paused owner keeps
//     its lock, so it can never lose the lock and rename later;
//   · crash recovery: an owner whose PID is no longer alive on the SAME host
//     is reclaimed (the dead process cannot rename anything);
//   · an owner on ANOTHER host is not reclaimed automatically — the acquirer
//     fails closed with `publication_lock_timeout` (operator/agent action),
//     because PID liveness cannot be proven cross-host;
//   · Redis loss does NOT affect the lock itself; the publication fails
//     closed before/after the rename because the intent read fails.
//
// Lock loss (external deletion / stale reclamation) is handled by the caller:
// `publishCommittedFence` re-verifies the token immediately before the rename
// and again after it, and refuses to report success if it no longer owns the
// lock.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const LOCK_DIR_NAME = '.publication-locks';
const OWNER_FILE = 'owner.json';
const DEFAULT_WAIT_MS = 30000;
const POLL_MS = 25;
/** A lock dir without a readable owner is reclaimed only after this grace. */
const ORPHAN_GRACE_MS = 5000;
/** Suffix of the quarantine name used while reclaiming a dead owner's lock. */
const STALE_INFIX = '.stale-';

function _err(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

function _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function _isInside(base, target) {
    const rel = path.relative(base, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Lock root of one OUTPUT_DIR (hidden sibling of the build dirs). */
function lockRootFor(config) {
    if (!config || !config.OUTPUT_DIR) return null;
    const outRoot = path.resolve(config.OUTPUT_DIR);
    const root = path.join(outRoot, LOCK_DIR_NAME);
    return _isInside(outRoot, root) ? root : null;
}

/** Stable lock name of one LOGICAL task (the manifest/marker key dimensions). */
function taskLockName({ bookId, chapterId, sceneId, jobId }) {
    const key = JSON.stringify([
        String(bookId), String(chapterId), String(sceneId), String(jobId),
    ]);
    return `${crypto.createHash('sha256').update(key).digest('hex')}.lock`;
}

function lockPathFor(config, task) {
    const root = lockRootFor(config);
    if (!root || !task || !task.bookId || !task.chapterId || !task.sceneId || !task.jobId) return null;
    const lockPath = path.join(root, taskLockName(task));
    return _isInside(root, lockPath) ? lockPath : null;
}

function _ownerPath(lockDir) {
    return path.join(lockDir, OWNER_FILE);
}

function _readOwner(fsImpl, lockDir) {
    try {
        const parsed = JSON.parse(fsImpl.readFileSync(_ownerPath(lockDir), 'utf8'));
        if (!parsed || typeof parsed !== 'object' || !parsed.token || !parsed.pid) return null;
        return {
            token: String(parsed.token),
            pid: Number(parsed.pid),
            host: String(parsed.host || ''),
            created_at: Number(parsed.created_at) || 0,
        };
    } catch (_) {
        return null;
    }
}

function _writeOwner(fsImpl, lockDir, owner) {
    // A plain write is deliberate: the atomic mkdir already made this directory
    // exclusive, and a rename here would make the lock interfere with the
    // publication-rename failure injection used by the consistency tests.
    // A partially written owner is reclaimed through the orphan grace below.
    fsImpl.writeFileSync(_ownerPath(lockDir), JSON.stringify(owner));
}

/** Is the owner process alive? Only provable on the same host. */
function _ownerAlive(owner, { hostname, kill }) {
    if (!owner || owner.host !== hostname) return false;
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
    try {
        kill(owner.pid, 0);
        return true;
    } catch (err) {
        // EPERM means the process exists but belongs to another user.
        return !!(err && err.code === 'EPERM');
    }
}

function _statSafe(fsImpl, p) {
    try { return fsImpl.statSync(p); } catch (_) { return null; }
}

/**
 * Acquire the publication lock of one logical task.
 *
 * @returns {Promise<{dir:string, token:string, verify:()=>boolean, release:()=>Promise<boolean>}>}
 * @throws code `publication_lock_timeout` (held by a live/foreign owner),
 *         `publication_lock_failed` (filesystem error).
 */
async function acquirePublicationLock(config, task, opts = {}) {
    const fsImpl = opts.fs || fs;
    const hostname = opts.hostname || os.hostname();
    const kill = opts.kill || process.kill;
    const pid = Number.isInteger(opts.pid) ? opts.pid : process.pid;
    const waitMs = Number.isFinite(opts.waitMs) ? Number(opts.waitMs) : DEFAULT_WAIT_MS;
    const now = typeof opts.now === 'function' ? opts.now : Date.now;
    const lockDir = lockPathFor(config, task);
    if (!lockDir) throw _err('publication_lock_failed', 'unsafe publication lock path');
    const root = lockRootFor(config);
    try {
        fsImpl.mkdirSync(root, { recursive: true });
    } catch (err) {
        throw _err('publication_lock_failed', `cannot create lock root: ${err.message}`);
    }

    const token = crypto.randomBytes(16).toString('hex');
    const started = now();
    for (;;) {
        try {
            fsImpl.mkdirSync(lockDir);
            const owner = { token, pid, host: hostname, created_at: Date.now() };
            try {
                _writeOwner(fsImpl, lockDir, owner);
            } catch (err) {
                try { fsImpl.rmSync(lockDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
                throw _err('publication_lock_failed', `cannot write lock owner: ${err.message}`);
            }
            const verify = () => {
                const current = _readOwner(fsImpl, lockDir);
                return !!(current && current.token === token);
            };
            const release = async () => {
                const current = _readOwner(fsImpl, lockDir);
                if (!current || current.token !== token) return false;
                try { fsImpl.rmSync(lockDir, { recursive: true, force: true }); return true; } catch (_) { return false; }
            };
            return { dir: lockDir, token, verify, release };
        } catch (err) {
            if (err && err.code !== 'EEXIST') throw err;
        }

        // Contended: inspect the owner. Only a provably dead same-host owner
        // (or a long-lived owner-less dir) may be reclaimed.
        const owner = _readOwner(fsImpl, lockDir);
        const st = _statSafe(fsImpl, lockDir);
        if (!st) continue; // released between mkdir and stat — retry
        const age = Math.max(0, now() - (owner && owner.created_at ? owner.created_at : st.mtimeMs));
        const reclaimable = owner
            ? (owner.host === hostname && !_ownerAlive(owner, { hostname, kill }))
            : age >= ORPHAN_GRACE_MS;

        if (reclaimable) {
            const tomb = `${lockDir}${STALE_INFIX}${crypto.randomBytes(8).toString('hex')}`;
            try {
                fsImpl.renameSync(lockDir, tomb);
            } catch (_) {
                // Somebody else reclaimed/recreated it — retry from scratch.
                continue;
            }
            const moved = _readOwner(fsImpl, tomb);
            const sameOwner = owner
                ? (moved && moved.token === owner.token)
                : (!moved || moved.token === token);
            if (!sameOwner) {
                // We raced with another reclaimer and moved a NEW live lock.
                // Put it back if the path is still free; otherwise the true
                // owner will observe the loss and fail closed (it re-verifies
                // the token before and after the rename).
                try {
                    if (!fsImpl.existsSync(lockDir)) fsImpl.renameSync(tomb, lockDir);
                } catch (_) { /* ignore */ }
            } else {
                try { fsImpl.rmSync(tomb, { recursive: true, force: true }); } catch (_) { /* ignore */ }
            }
            continue;
        }

        if (now() - started >= waitMs) {
            throw _err('publication_lock_timeout',
                `publication lock is held by another process (${owner ? `pid=${owner.pid} host=${owner.host}` : 'unknown owner'})`);
        }
        await _sleep(POLL_MS);
    }
}

/** Run `fn(lock)` under the publication lock, always releasing it. */
async function withPublicationLock(config, task, fn, opts = {}) {
    const lock = await acquirePublicationLock(config, task, opts);
    try {
        return await fn(lock);
    } finally {
        await lock.release();
    }
}

module.exports = {
    LOCK_DIR_NAME,
    DEFAULT_WAIT_MS,
    ORPHAN_GRACE_MS,
    lockRootFor,
    lockPathFor,
    taskLockName,
    acquirePublicationLock,
    withPublicationLock,
};
