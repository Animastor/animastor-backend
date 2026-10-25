'use strict';
// ======================================================
// ANIMASTOR BACKEND — CROSS-PROCESS PUBLICATION LOCK
// (Stage 137 · audit 136 P1-A · Stage 139 — D1–D5 fixes)
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
//
// ------------------------------------------------------
// Stage 139 — safe reclaim (defects D1–D5, audit 138C)
// ------------------------------------------------------
// D1/D2 (double ownership during reclaim) are closed with a *claim-gated*
// reclaim protocol. Reclaiming a lock dir now requires, in order:
//
//   1. TRI-STATE owner read — `_readOwnerTri` distinguishes
//      present / absent(ENOENT) / unknown(EIO, EACCES, corrupt JSON).
//      Unknown ownership is NEVER treated as "no owner" (D2). Only an
//      ENOENT-absent owner file may enter the time-grace path, and only a
//      provably dead same-host owner may enter the reclaim path.
//   2. An ATOMIC CLAIM — the reclaimer mkdir's `.reclaim` INSIDE the lock
//      dir. mkdir is atomic on POSIX, so exactly one reclaimer can hold the
//      claim for a given dir instance. A second reclaimer sees EEXIST and
//      must wait (or clean the claim only if its claimant is provably dead
//      and the claim is older than CLAIM_STALE_MS).
//   3. A GATE RE-READ under the claim — the owner is re-read after the
//      claim is held. If ownership became live/unknown/changed, the reclaim
//      is aborted (claim released, no rename).
//   4. rename → tomb, then POST-RENAME IDENTITY CHECK — the tomb must
//      contain OUR claim file AND an owner that matches the gate evidence.
//      Otherwise the dir we moved is not the dir we validated → we put it
//      back (rename tomb → lockDir when the path is free) and fail closed.
//
// Why this is safe (provable for all PRODUCTION actors): while the claim is
// held, the lock dir cannot change identity. Identity change requires the
// path to be removed first; the only production removals are release() by
// the token owner (only reachable for a dead owner in the reclaim path),
// another reclaimer's rename (blocked by the claim), and this reclaimer's
// own rename. Therefore a paused reclaimer always resumes against the SAME
// directory instance it validated — a fresh live lock created by a third
// process cannot exist at that path while the old dir (with our claim
// inside) still exists. The claim file binding the post-rename check turns
// this from a "stat before rename" TOCTOU into an identity proof.
//
// ASSUMPTION / LIMITATION: an EXTERNAL actor that recursively deletes
// `.publication-locks/*.lock` while a reclaim is parked can still swap the
// directory instance under the rename. That case is detected fail-closed by
// the identity check (we restore) and by the owner's verify(), which the
// publication path re-checks before and after its rename. We do not claim
// protection against a hostile rm -rf; we claim protection against the
// concurrent-reclaimer/preemption races D1/D2.
//
// D3 (busy-loop on fs faults): the acquire loop has ONE structure — every
// iteration begins with the `waitMs` deadline check and every retry path
// ends in `_sleep(POLL_MS)`. No `continue` bypasses the deadline or the
// sleep, so persistent rename/stat/owner-read faults converge to
// `publication_lock_timeout` (or `publication_lock_failed` for the
// unrecoverable root/owner-write errors) within waitMs + ε.
//
// D4 (live owner never loses its dir): a live same-host owner is never a
// reclaim candidate at either read (step 1 and step 3), and the claim keeps
// concurrent reclaimers serialized, so a live owner's dir can only be moved
// by an external actor — observed by verify() → fail closed.
//
// D5 (quarantine GC): `.stale-*` tombs left by crashed reclaimers are
// collectable through `collectStaleQuarantine`, which only removes a tomb
// that is older than GC_MIN_AGE_MS AND provably inactive (owner file absent
// or a dead same-host pid, and no live `.reclaim` claimant). Active locks
// (`*.lock`) are never touched by GC.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const LOCK_DIR_NAME = '.publication-locks';
const OWNER_FILE = 'owner.json';
const DEFAULT_WAIT_MS = 30000;
const POLL_MS = 25;
/** A lock dir WITHOUT an owner.json file is reclaimed only after this grace. */
const ORPHAN_GRACE_MS = 5000;
/** Suffix of the quarantine name used while reclaiming a dead owner's lock. */
const STALE_INFIX = '.stale-';
/** Atomic claim dir that serializes reclaimers of one lock dir instance. */
const CLAIM_DIR_NAME = '.reclaim';
const CLAIM_FILE = 'claim.json';
/** A `.reclaim` claim without a readable claimant is stale after this. */
const CLAIM_STALE_MS = ORPHAN_GRACE_MS;
/** GC: a `.stale-*` tomb younger than this is never removed. */
const GC_MIN_AGE_MS = 60000;
/** GC: upper bound of tombs removed per call. */
const GC_LIMIT = 16;

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

function _claimPath(lockDir) {
    return path.join(lockDir, CLAIM_DIR_NAME);
}

function _claimFilePath(lockDir) {
    return path.join(_claimPath(lockDir), CLAIM_FILE);
}

/**
 * TRI-STATE owner read (Stage 139 · D2).
 *
 *   { state: 'present', owner } — valid, fully readable owner
 *   { state: 'absent' }         — owner.json does not exist (ENOENT)
 *   { state: 'unknown', reason } — read error (EIO/EACCES/…) or corrupt
 *                                  content: ownership is UNDEFINED and must
 *                                  fail closed, never "no owner".
 */
function _readOwnerTri(fsImpl, lockDir) {
    let raw;
    try {
        raw = fsImpl.readFileSync(_ownerPath(lockDir), 'utf8');
    } catch (err) {
        if (err && err.code === 'ENOENT') return { state: 'absent' };
        return { state: 'unknown', reason: (err && err.code) || 'read-error' };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (_) {
        return { state: 'unknown', reason: 'corrupt-json' };
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.token || !parsed.pid) {
        return { state: 'unknown', reason: 'invalid-shape' };
    }
    return {
        state: 'present',
        owner: {
            token: String(parsed.token),
            pid: Number(parsed.pid),
            host: String(parsed.host || ''),
            created_at: Number(parsed.created_at) || 0,
        },
    };
}

/** Back-compat helper: readable owner or null. Never used for reclaim decisions. */
function _readOwner(fsImpl, lockDir) {
    const r = _readOwnerTri(fsImpl, lockDir);
    return r.state === 'present' ? r.owner : null;
}

function _writeOwner(fsImpl, lockDir, owner) {
    // A plain write is deliberate: the atomic mkdir already made this directory
    // exclusive, and a rename here would make the lock interfere with the
    // publication-rename failure injection used by the consistency tests.
    // A crash mid-write leaves a CORRUPT owner (fail-closed, operator cleanup)
    // or no owner file at all (reclaimed through the orphan grace below).
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

/** TRI-STATE stat: ok / gone(ENOENT) / unknown(any other error). */
function _statTri(fsImpl, p) {
    try {
        return { state: 'ok', st: fsImpl.statSync(p) };
    } catch (err) {
        if (err && err.code === 'ENOENT') return { state: 'gone' };
        return { state: 'unknown', reason: (err && err.code) || 'stat-error' };
    }
}

function _readClaimTri(fsImpl, lockDir) {
    let raw;
    try {
        raw = fsImpl.readFileSync(_claimFilePath(lockDir), 'utf8');
    } catch (err) {
        if (err && err.code === 'ENOENT') return { state: 'absent' };
        return { state: 'unknown', reason: (err && err.code) || 'read-error' };
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || !parsed.token || !parsed.pid) {
            return { state: 'unknown', reason: 'invalid-shape' };
        }
        return {
            state: 'present',
            claim: {
                token: String(parsed.token),
                pid: Number(parsed.pid),
                host: String(parsed.host || ''),
                at: Number(parsed.at) || 0,
            },
        };
    } catch (_) {
        return { state: 'unknown', reason: 'corrupt-json' };
    }
}

/**
 * Try to become THE reclaimer of the current lock dir instance.
 * `mkdir(.reclaim)` is atomic: exactly one caller gets 'held'.
 *
 *   held          — claim acquired (or already ours)
 *   busy          — another (live or unprovable) reclaimer holds the claim
 *   stale-cleaned — a dead claimant's claim was removed; retry next iteration
 */
function _tryClaim(fsImpl, lockDir, token, { pid, hostname, kill, now }) {
    const claimDir = _claimPath(lockDir);
    const mine = _readClaimTri(fsImpl, lockDir);
    if (mine.state === 'present' && mine.claim.token === token) return { status: 'held' };
    try {
        fsImpl.mkdirSync(claimDir);
        fsImpl.writeFileSync(_claimFilePath(lockDir), JSON.stringify({
            token, pid, host: hostname, at: Date.now(),
        }));
        return { status: 'held' };
    } catch (err) {
        if (!err || err.code !== 'EEXIST') {
            // mkdir failed for a non-collision reason (EIO/EACCES/…):
            // ownership of the claim is undefined → fail closed this round.
            try { fsImpl.rmSync(claimDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
            return { status: 'busy', reason: (err && err.code) || 'claim-error' };
        }
    }
    // Somebody else holds (or held) the claim.
    const other = _readClaimTri(fsImpl, lockDir);
    if (other.state === 'present') {
        if (other.claim.host === hostname && !_ownerAlive({ host: other.claim.host, pid: other.claim.pid }, { hostname, kill })) {
            // Claimant is provably dead — clean up and let a live reclaimer retry.
            try { fsImpl.rmSync(claimDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
            return { status: 'stale-cleaned' };
        }
        return { status: 'busy' };
    }
    if (other.state === 'absent') {
        const st = _statTri(fsImpl, claimDir);
        const age = st.state === 'ok' ? Math.max(0, now() - st.st.mtimeMs) : 0;
        if (st.state === 'ok' && age >= CLAIM_STALE_MS) {
            try { fsImpl.rmSync(claimDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
            return { status: 'stale-cleaned' };
        }
        return { status: 'busy' };
    }
    return { status: 'busy' }; // unknown claim content → fail closed
}

function _releaseClaim(fsImpl, lockDir) {
    try { fsImpl.rmSync(_claimPath(lockDir), { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

/** Deadline check shared by every iteration of the acquire loop (D3). */
function _checkDeadline(state) {
    if (state.now() - state.started >= state.waitMs) {
        throw _err('publication_lock_timeout',
            `publication lock is held by another process (${state.desc || 'unknown owner'})`);
    }
}

/**
 * Acquire the publication lock of one logical task.
 *
 * @returns {Promise<{dir:string, token:string, verify:()=>boolean, release:()=>Promise<boolean>}>}
 * @throws code `publication_lock_timeout` (held by a live/foreign/undefined
 *         owner, or waitMs exhausted under fs faults),
 *         `publication_lock_failed` (filesystem error on our own lock).
 *
 * Stage 139 (D3): every retry path checks the shared `waitMs` deadline and
 * sleeps POLL_MS between attempts — persistent fs faults converge to a
 * controlled refusal instead of a busy loop.
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
    const claimCtx = { pid, hostname, kill, now };
    const deadline = { now, started, waitMs, desc: '' };
    for (;;) {
        // ── D3: the deadline is checked FIRST on every iteration ──
        _checkDeadline(deadline);

        try {
            fsImpl.mkdirSync(lockDir);
            const owner = { token, pid, host: hostname, created_at: Date.now() };
            try {
                _writeOwner(fsImpl, lockDir, owner);
            } catch (err) {
                try { fsImpl.rmSync(lockDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
                throw _err('publication_lock_failed', `cannot write lock owner: ${err.message}`);
            }
            // Stage 139 (D4): confirm the dir we created still carries OUR
            // token before reporting ownership — a stale reclaimer parked
            // between our mkdir and our write would have moved it away.
            for (;;) {
                const c = _readOwnerTri(fsImpl, lockDir);
                if (c.state === 'present' && c.owner.token === token) break;
                if (now() - started >= waitMs) {
                    throw _err('publication_lock_failed', 'cannot confirm publication lock ownership');
                }
                await _sleep(POLL_MS);
            }
            const verify = () => {
                // Fail closed: only an exact, fully readable token match is ours;
                // unknown/absent/foreign never verifies as owned (D2).
                const current = _readOwnerTri(fsImpl, lockDir);
                return current.state === 'present' && current.owner.token === token;
            };
            const release = async () => {
                const current = _readOwnerTri(fsImpl, lockDir);
                if (current.state !== 'present' || current.owner.token !== token) return false;
                try { fsImpl.rmSync(lockDir, { recursive: true, force: true }); return true; } catch (_) { return false; }
            };
            return { dir: lockDir, token, verify, release };
        } catch (err) {
            if (err && err.code !== 'EEXIST') throw err;
        }

        // ── Contended: inspect the owner (tri-state, Stage 139 · D2) ──
        const ro = _readOwnerTri(fsImpl, lockDir);
        const st = _statTri(fsImpl, lockDir);
        if (ro.state === 'unknown') {
            // Undefined ownership ≠ no owner: wait for the deadline, then
            // refuse with publication_lock_timeout. Never reclaim (D2).
            deadline.desc = `undefined ownership (${ro.reason})`;
            await _sleep(POLL_MS);
            continue;
        }
        if (st.state === 'unknown') {
            deadline.desc = 'lock directory unreadable';
            await _sleep(POLL_MS);
            continue;
        }
        if (st.state === 'gone') {
            // Released/reclaimed between our mkdir and our inspection.
            await _sleep(POLL_MS);
            continue;
        }

        let age = Math.max(0, now() - st.st.mtimeMs);
        let reclaimable = false;
        if (ro.state === 'present') {
            reclaimable = ro.owner.host === hostname && !_ownerAlive(ro.owner, { hostname, kill });
            deadline.desc = `pid=${ro.owner.pid} host=${ro.owner.host}`;
        } else {
            // absent: the creating process writes owner.json in the same tick
            // as the mkdir, so a dir without one for ORPHAN_GRACE_MS is a
            // crashed writer (documented residual risk: a creator suspended
            // ≥ grace before its write — detected by the gate below).
            reclaimable = age >= ORPHAN_GRACE_MS;
            deadline.desc = 'owner-less lock dir';
        }
        if (!reclaimable) {
            await _sleep(POLL_MS);
            continue;
        }

        // ── Stage 139 (D1): claim-gated reclaim ──
        const claim = _tryClaim(fsImpl, lockDir, token, claimCtx);
        if (claim.status !== 'held') {
            deadline.desc = claim.status === 'busy' ? 'reclaim in progress elsewhere' : 'stale claim cleaned';
            await _sleep(POLL_MS);
            continue;
        }

        // Gate: re-read ownership WITH the claim held. If it is no longer
        // reclaimable (owner appeared, became unknown, changed), abort.
        const go = _readOwnerTri(fsImpl, lockDir);
        const gs = _statTri(fsImpl, lockDir);
        let gateOk = false;
        if (go.state === 'present' && gs.state === 'ok') {
            gateOk = go.owner.host === hostname && !_ownerAlive(go.owner, { hostname, kill })
                && go.owner.token === (ro.state === 'present' ? ro.owner.token : null);
            deadline.desc = `pid=${go.owner.pid} host=${go.owner.host}`;
        } else if (go.state === 'absent' && gs.state === 'ok') {
            // age only grows (pre-claim evidence); a NEW write would flip
            // state to 'present' above and abort the reclaim.
            gateOk = age >= ORPHAN_GRACE_MS;
            deadline.desc = 'owner-less lock dir';
        } else if (go.state === 'unknown') {
            deadline.desc = `undefined ownership (${go.reason})`;
        } else {
            deadline.desc = 'lock dir vanished under claim';
        }
        if (!gateOk) {
            _releaseClaim(fsImpl, lockDir);
            await _sleep(POLL_MS);
            continue;
        }

        const tomb = `${lockDir}${STALE_INFIX}${crypto.randomBytes(8).toString('hex')}`;
        try {
            fsImpl.renameSync(lockDir, tomb);
        } catch (_) {
            // Fault or race: release our claim (if the dir is still there)
            // and retry within the deadline (D3: no busy-loop).
            _releaseClaim(fsImpl, lockDir);
            await _sleep(POLL_MS);
            continue;
        }

        // ── Identity check: the dir we moved must be the dir we validated ──
        const tm = _readOwnerTri(fsImpl, tomb);
        const tc = _readClaimTri(fsImpl, tomb);
        const claimOk = tc.state === 'present' && tc.claim.token === token;
        const ownerOk = go.state === 'present'
            ? (tm.state === 'present' && tm.owner.token === go.owner.token)
            : tm.state === 'absent';
        if (claimOk && ownerOk) {
            // Same instance, provably dead/owner-less → quarantine consumed.
            try { fsImpl.rmSync(tomb, { recursive: true, force: true }); } catch (_) { /* ignore */ }
            continue; // lock path is free — try to acquire immediately
        }
        // Mismatch: we moved a dir we did NOT validate (external swap) —
        // put it back if the path is free; otherwise the true owner observes
        // the loss via verify() and fails closed (D4).
        try {
            if (!fsImpl.existsSync(lockDir)) fsImpl.renameSync(tomb, lockDir);
            else fsImpl.rmSync(tomb, { recursive: true, force: true });
        } catch (_) { /* ignore */ }
        _releaseClaim(fsImpl, lockDir);
        deadline.desc = 'reclaim identity mismatch (restored)';
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

/**
 * D5 — quarantine GC. Removes ONLY `.stale-*` tomb dirs (never `*.lock`
 * active locks) that are provably inactive:
 *
 *   · age ≥ GC_MIN_AGE_MS (from the tomb's mtime, i.e. the reclaim moment);
 *   · owner.json is absent, OR present with a provably DEAD same-host pid;
 *   · no `.reclaim` claimant that is still alive on this host.
 *
 * Anything unreadable, foreign, young or live is skipped — GC never risks an
 * active lock for the sake of cleanup. Returns {scanned, removed, details}.
 */
function collectStaleQuarantine(config, opts = {}) {
    const fsImpl = opts.fs || fs;
    const hostname = opts.hostname || os.hostname();
    const kill = opts.kill || process.kill;
    const now = typeof opts.now === 'function' ? opts.now : Date.now;
    const minAgeMs = Number.isFinite(opts.minAgeMs) ? Number(opts.minAgeMs) : GC_MIN_AGE_MS;
    const limit = Number.isFinite(opts.limit) ? Number(opts.limit) : GC_LIMIT;
    const out = { scanned: 0, removed: 0, details: [] };
    const root = lockRootFor(config);
    if (!root) return out;
    let entries;
    try { entries = fsImpl.readdirSync(root); } catch (_) { return out; }
    for (const name of entries) {
        if (!name.includes(STALE_INFIX)) continue;
        if (out.removed >= limit) break;
        out.scanned++;
        const p = path.join(root, name);
        const st = _statTri(fsImpl, p);
        if (st.state !== 'ok') {
            out.details.push({ name, action: 'skip', reason: st.state === 'gone' ? 'gone' : 'unreadable' });
            continue;
        }
        if (now() - st.st.mtimeMs < minAgeMs) {
            out.details.push({ name, action: 'skip', reason: 'young' });
            continue;
        }
        const own = _readOwnerTri(fsImpl, p);
        if (own.state === 'unknown') {
            out.details.push({ name, action: 'skip', reason: `undefined owner (${own.reason})` });
            continue;
        }
        if (own.state === 'present' && _ownerAlive(own.owner, { hostname, kill })) {
            out.details.push({ name, action: 'skip', reason: 'live owner' });
            continue;
        }
        if (own.state === 'present' && own.owner.host !== hostname) {
            out.details.push({ name, action: 'skip', reason: 'foreign owner' });
            continue;
        }
        const cl = _readClaimTri(fsImpl, p);
        if (cl.state === 'present') {
            if (cl.claim.host === hostname && _ownerAlive({ host: cl.claim.host, pid: cl.claim.pid }, { hostname, kill })) {
                out.details.push({ name, action: 'skip', reason: 'reclaim in progress' });
                continue;
            }
        } else if (cl.state === 'unknown') {
            out.details.push({ name, action: 'skip', reason: 'undefined claim' });
            continue;
        }
        try {
            fsImpl.rmSync(p, { recursive: true, force: true });
            out.removed++;
            out.details.push({ name, action: 'removed' });
        } catch (err) {
            out.details.push({ name, action: 'failed', reason: (err && err.code) || String(err.message).slice(0, 60) });
        }
    }
    return out;
}

module.exports = {
    LOCK_DIR_NAME,
    DEFAULT_WAIT_MS,
    ORPHAN_GRACE_MS,
    STALE_INFIX,
    GC_MIN_AGE_MS,
    lockRootFor,
    lockPathFor,
    taskLockName,
    acquirePublicationLock,
    withPublicationLock,
    collectStaleQuarantine,
};
