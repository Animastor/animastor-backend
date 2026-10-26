'use strict';
// ======================================================
// ANIMASTOR BACKEND — STAGED ARTIFACT PUBLICATION
// (Stage 131 — staged artifacts & fenced commit, contract 126 §3)
// ======================================================
//
// A GPU result is never written to its canonical artifact path before its
// fence is committed. The publication protocol is:
//
//   1. stage   — bytes land in {OUTPUT_DIR}/{build}/.staging/{enc(job)}/{fence}/
//                (tmp → fsync → atomic rename inside the fence dir);
//   2. commit  — queue-idempotency.fenceCommitResult (atomic Redis Lua)
//                decides `committed | duplicate_same_fence | stale_intent |
//                intent_missing | intent_corrupt | unavailable` from the
//                DURABLE intent record — never from a file;
//   3. publish — only on `committed` (first time) / `duplicate_same_fence`
//                (rename replay) the staged file is atomically renamed to the
//                canonical path (same filesystem: both live under the build
//                dir).
//
// Redis and the filesystem are NOT one transaction. The crash windows and
// their recovery (all idempotent, all fence-scoped):
//
//   crash after stage, before commit  → staged file is inert; a retry or a
//                                       fresh dispatch re-stages the same
//                                       fence dir; stale fences are removed
//                                       by `collectStaleStaging` (age-gated)
//   crash after commit, before rename → the manifest + done marker prove the
//                                       COMMIT; the per-task publication
//                                       marker proves the RENAME (Stage 135):
//                                       `resumePendingPublications` completes
//                                       it, never inferring from "a file
//                                       exists" at the shared canonical path
//   rename failed in-process          → NO success is reported, the
//                                       metadata/ready chain does not run; the
//                                       retry/resume completes the rename
//
// Publication state (Stage 135 · audit 134 B6) is decided by
// `publishCommittedFence` from the durable per-task marker
// (queue-idempotency.fencePublishKey):
//
//   marker 'renaming'  written BEFORE the rename  → crash before the rename
//                        leaves staged bytes + 'renaming' (redo the rename);
//   marker 'published' written AFTER the rename   → crash after it leaves no
//                        staged file + 'renaming' (the rename is verified and
//                        the marker repaired).
//
// A failed marker write before the rename ABORTS the publication (staged bytes
// stay, nothing is renamed blind); a failed marker write after it only leaves
// the verifiable window above. A marker is never written for a rejected
// (stale / receipt-less) fence.
//
// Invariants this module is built around (Stage 131 §2):
//   · a stale fence never becomes current through a file write or recovery;
//   · the canonical path is never overwritten before the fenced commit;
//   · a repeat of the same fence is idempotent and cannot conflict;
//   · every deletion/rollback is scoped to ONE fence dir (path-contained);
//   · legacy canonical files are never moved or removed by this module.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const qidem = require('../helpers/queue-idempotency.cjs');
const { withPublicationLock } = require('./publication-lock.cjs');

/** Name of the per-build staging root (hidden dir, never a canonical path). */
const STAGING_DIR_NAME = '.staging';
/** Fixed staged file name inside a fence dir (one artifact per fence). */
const STAGED_FILE_NAME = 'artifact';
/** Staged file extension — validated, it becomes part of a filename. */
const EXTENSION_RE = /^\.[A-Za-z0-9]+$/;
/** Build ids accepted for NEW staged paths (same grammar as safeBuildPath). */
const BUILD_ID_RE = /^[a-zA-Z0-9._-]+$/;
/** Fences are sha256 hex ids (computeIdemKey). */
const FENCE_RE = /^[0-9a-f]{64}$/i;
// Versioned-publish writer temps (Stage 143a fix 2): `{fence}.{pid}.{rand}.tmp`
// and the legacy `{fence}.tmp` — FILES directly under `{build}/.staging/{asset}/`.
// The fence here is an integer (iu_image fence sequence), unlike the 64-hex
// result-publication fence DIRS below.
const VERSIONED_STAGING_TMP_RE = /^(\d+)(?:\.[0-9]+\.[0-9a-f]+)?\.tmp$/i;
/** Content proof stored in the commit manifest (Stage 137 · audit 136 P1-B). */
const SHA256_RE = /^[0-9a-f]{64}$/i;
/** Manifest schema written by Stage 137 (adds sha256; version 1 had none). */
const MANIFEST_VERSION = 2;
/** Backup of the previous canonical bytes, kept inside the fence dir. */
const ROLLBACK_FILE_NAME = '.previous-canonical';
/** A staging fence dir older than this, not current, is removable garbage. */
const STAGING_MAX_AGE_MS = 24 * 3600 * 1000;
/** Bounded scan of manifest keys per recovery pass. */
const RESUME_MANIFEST_LIMIT = 200;
/** Bounded scan of build dirs per GC pass. */
const GC_MAX_BUILDS = 50;

function _err(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

/** fsync one directory (durability of a rename); best effort where unsupported. */
function _fsyncDir(fsImpl, dir) {
    let fd = null;
    try {
        fd = fsImpl.openSync(dir, 'r');
        fsImpl.fsyncSync(fd);
    } catch (_) {
        /* not every filesystem supports fsync on a directory — the rename
           itself is still atomic on POSIX; durability is best effort here */
    } finally {
        if (fd != null) { try { fsImpl.closeSync(fd); } catch (_) { /* ignore */ } }
    }
}

// ── content proof (Stage 137 · audit 136 P1-B) ────────────────────────────
//
// A marker (or a `done` key) proves that a fence was COMMITTED, never that the
// bytes currently at the shared canonical path are the bytes of that fence.
// The manifest therefore carries a cryptographic hash + size of the staged
// artifact, and every "already published" / "rename verified" decision checks
// the canonical file against it. No hash, no success.

/** SHA-256 of an in-memory result buffer. */
function sha256Buffer(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Hash + size of one file, read in bounded chunks.
 *
 * @returns {{ok:true, sha256:string, bytes:number}|{ok:false, reason:'missing'|'unreadable'|'not_file', error?:string}}
 */
function artifactProof(fsImpl, file) {
    let st;
    try {
        st = fsImpl.statSync(file);
    } catch (err) {
        return {
            ok: false,
            reason: err && err.code === 'ENOENT' ? 'missing' : 'unreadable',
            error: String((err && err.message) || err || 'stat failed'),
        };
    }
    if (typeof st.isFile === 'function' && !st.isFile()) {
        return { ok: false, reason: 'not_file' };
    }
    let fd = null;
    try {
        fd = fsImpl.openSync(file, 'r');
        const hash = crypto.createHash('sha256');
        const chunk = Buffer.allocUnsafe(64 * 1024);
        let total = 0;
        let n;
        while ((n = fsImpl.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
            hash.update(chunk.subarray(0, n));
            total += n;
        }
        return { ok: true, sha256: hash.digest('hex'), bytes: total };
    } catch (err) {
        return { ok: false, reason: 'unreadable', error: String((err && err.message) || err || 'read failed') };
    } finally {
        if (fd != null) { try { fsImpl.closeSync(fd); } catch (_) { /* ignore */ } }
    }
}

/** Expected content proof of a committed manifest, or null when unprovable. */
function expectedProofOf(manifest) {
    if (!manifest || typeof manifest !== 'object') return null;
    const sha256 = String(manifest.sha256 || '').toLowerCase();
    const bytes = Number(manifest.bytes);
    if (!SHA256_RE.test(sha256) || !Number.isFinite(bytes) || bytes < 0) return null;
    return { sha256, bytes };
}

function proofMatches(proof, expected) {
    return !!(proof && proof.ok && expected
        && proof.sha256 === expected.sha256 && proof.bytes === expected.bytes);
}

/** STRICT manifest read: a Redis error is `error`, never "absent". */
async function readManifestStrict(redis, { bookId, chapterId, sceneId, jobId }) {
    if (!redis || !bookId || !chapterId || !sceneId || !jobId) return { status: 'invalid' };
    let raw;
    try {
        raw = await redis.get(qidem.artifactManifestKey(bookId, chapterId, sceneId, jobId));
    } catch (err) {
        return { status: 'error', error: String((err && err.message) || err || 'redis error').slice(0, 200) };
    }
    if (raw == null || raw === false) return { status: 'absent' };
    let manifest = null;
    try { manifest = JSON.parse(raw); } catch (_) { manifest = null; }
    if (!manifest || typeof manifest !== 'object') return { status: 'corrupt' };
    return { status: 'ok', manifest };
}

function _removeBackup(fsImpl, backup) {
    if (backup && backup.kind === 'file') {
        try { fsImpl.rmSync(backup.path, { force: true }); } catch (_) { /* ignore */ }
    }
}

/**
 * Preserve the bytes currently at canonical before replacing them, so a
 * publication that turns out to be superseded can be rolled back atomically
 * (hardlink where supported, copy otherwise).
 */
function _backupCanonical(fsImpl, fenceDir, canonical, canonicalExists) {
    const backupPath = path.join(fenceDir, ROLLBACK_FILE_NAME);
    try { fsImpl.rmSync(backupPath, { force: true }); } catch (_) { /* ignore */ }
    if (!canonicalExists) return { kind: 'absent' };
    try {
        fsImpl.linkSync(canonical, backupPath);
        return { kind: 'file', path: backupPath };
    } catch (_) {
        try {
            fsImpl.copyFileSync(canonical, backupPath);
            return { kind: 'file', path: backupPath };
        } catch (err) {
            throw _err('publish_failed', `cannot preserve the previous canonical bytes: ${err.message}`);
        }
    }
}

function _restoreCanonical(fsImpl, backup, canonical, expected, stagedPath = null) {
    if (backup && backup.kind === 'file') {
        try {
            fsImpl.renameSync(backup.path, canonical);
            _fsyncDir(fsImpl, path.dirname(canonical));
            return true;
        } catch (_) {
            return false;
        }
    }
    // No previous canonical existed: put OUR bytes back where they came from
    // (the staged copy is the recoverable state), and only delete when the
    // bytes are provably ours and cannot be moved (never touch a newer fence
    // that raced in after lock loss).
    const current = artifactProof(fsImpl, canonical);
    if (current.ok && proofMatches(current, expected)) {
        if (stagedPath) {
            try {
                fsImpl.mkdirSync(path.dirname(stagedPath), { recursive: true });
                fsImpl.renameSync(canonical, stagedPath);
                _fsyncDir(fsImpl, path.dirname(stagedPath));
                return true;
            } catch (_) { /* fall through to delete */ }
        }
        try { fsImpl.rmSync(canonical, { force: true }); return true; } catch (_) { return false; }
    }
    return false;
}

async function _restoreMarker(redis, { bookId, chapterId, sceneId, jobId }, previous) {
    try {
        if (previous && previous.status === 'ok') {
            await qidem.markFencePublication(redis, {
                bookId, chapterId, sceneId, jobId,
                fence: previous.marker.fence,
                stage: previous.marker.stage,
                sha256: previous.marker.sha256 || null,
                bytes: previous.marker.bytes == null ? null : previous.marker.bytes,
            });
        } else {
            await redis.del(qidem.fencePublishKey(bookId, chapterId, sceneId, jobId));
        }
    } catch (_) { /* best effort: a stale marker is corrected by the next owner */ }
}

// ── path derivation (traversal-safe) ──────────────────────────────────────

/**
 * Validate a build id for a NEW staged path. Mirrors `safeBuildPath`
 * (cleanup-service): no separators, no `.`/`..`, conservative charset.
 */
function isValidBuildId(buildId) {
    if (!buildId || buildId === '.' || buildId === '..') return false;
    if (String(buildId).includes('/') || String(buildId).includes('\\')) return false;
    return BUILD_ID_RE.test(String(buildId));
}

/** Containment: `target` must be `base` itself or below it. */
function _isInside(base, target) {
    const rel = path.relative(base, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Staging root of one build: `{OUTPUT_DIR}/{build}/.staging`. Derived ONLY
 * from `config.OUTPUT_DIR` (data-path-literals gate). Returns null when any
 * component is unsafe — callers must treat null as a hard failure (no path,
 * no staging, no commit).
 */
function stagingRootFor(config, buildId) {
    if (!config || !config.OUTPUT_DIR || !isValidBuildId(buildId)) return null;
    const outRoot = path.resolve(config.OUTPUT_DIR);
    const root = path.join(outRoot, String(buildId), STAGING_DIR_NAME);
    return _isInside(outRoot, root) ? root : null;
}

/**
 * Fence dir of one (job, fence): `{build}/.staging/{enc(jobId)}/{fence}`.
 * jobId is percent-encoded (':' and glob metacharacters are escaped, so two
 * distinct job ids can never collide into one dir) and the result is
 * containment-checked — encodeURIComponent leaves a literal '..' intact, the
 * check is what makes traversal impossible.
 */
function fenceDirFor(config, { buildId, jobId, fence }) {
    if (!FENCE_RE.test(String(fence || ''))) return null;
    if (jobId == null || jobId === '') return null;
    const root = stagingRootFor(config, buildId);
    if (!root) return null;
    const dir = path.join(root, qidem.encodeKeyComponent(jobId), String(fence).toLowerCase());
    return _isInside(root, dir) ? dir : null;
}

/** Absolute canonical artifact path (the reader-visible file). */
function canonicalPathFor(config, asset) {
    if (!config || !config.OUTPUT_DIR || !asset || !asset.fullPath) return null;
    const outRoot = path.resolve(config.OUTPUT_DIR);
    const canonical = path.resolve(asset.fullPath);
    return _isInside(outRoot, canonical) ? canonical : null;
}

// ── staging ───────────────────────────────────────────────────────────────

/**
 * Write the result bytes into the fence's staging dir:
 * `artifact.tmp` → fsync file → rename → fsync dir. The rename is INSIDE the
 * fence dir (same filesystem) and therefore atomic wherever the filesystem
 * supports atomic rename at all.
 *
 * @throws code `invalid_stage_path` | `empty_result` | fs errors
 * @returns {{fenceDir:string, stagedPath:string, bytes:number}}
 */
function stageResult(config, { buildId, jobId, fence, buffer, extension }, deps = {}) {
    const fsImpl = deps.fs || fs;
    const fenceDir = fenceDirFor(config, { buildId, jobId, fence });
    if (!fenceDir) {
        throw _err('invalid_stage_path', `unsafe staging path for build=${buildId} job=${jobId} fence=${String(fence).slice(0, 12)}`);
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        // A 0-byte result is an ERROR, never a silent "success" (contract
        // 126 §3.2) — nothing is staged, nothing can be committed.
        throw _err('empty_result', `empty result buffer for job=${jobId}`);
    }
    const ext = String(extension || '');
    if (!EXTENSION_RE.test(ext)) {
        throw _err('invalid_stage_path', `unsafe artifact extension: ${ext}`);
    }
    const tmpPath = path.join(fenceDir, `${STAGED_FILE_NAME}.tmp`);
    const stagedPath = path.join(fenceDir, `${STAGED_FILE_NAME}${ext}`);

    fsImpl.mkdirSync(fenceDir, { recursive: true });
    fsImpl.writeFileSync(tmpPath, buffer);
    // Durability: fsync the data BEFORE the rename makes it visible.
    let fd = null;
    try {
        fd = fsImpl.openSync(tmpPath, 'r');
        fsImpl.fsyncSync(fd);
    } finally {
        if (fd != null) { try { fsImpl.closeSync(fd); } catch (_) { /* ignore */ } }
    }
    fsImpl.renameSync(tmpPath, stagedPath);
    _fsyncDir(fsImpl, fenceDir);

    return { fenceDir, stagedPath, bytes: buffer.length };
}

/**
 * Raw atomic rename of the staged file onto the canonical artifact path.
 *
 * LOW-LEVEL PRIMITIVE — publication decisions belong to
 * `publishCommittedFence` (Stage 135 · audit 134 B6). Calling this directly
 * cannot tell whether the canonical file belongs to the calling fence, which
 * is exactly how a retry used to report success over the previous
 * generation's bytes.
 *
 * On `duplicate_same_fence` (an already-committed fence is re-delivered) the
 * rename happens ONLY when the canonical file is absent — a redelivery may
 * finish a crashed publication but never flap an already-published file.
 *
 * @returns {{published:boolean, reason:string}}
 * @throws code `publish_failed` when the rename itself failed (the commit is
 *         already durable in Redis — a retry/resume replays this rename; NO
 *         success may be reported and the metadata chain must not run).
 */
function publishStaged(config, { buildId, jobId, fence, canonicalPath, overwrite = true }, deps = {}) {
    const fsImpl = deps.fs || fs;
    const fenceDir = fenceDirFor(config, { buildId, jobId, fence });
    if (!fenceDir || !canonicalPath) {
        throw _err('invalid_stage_path', 'cannot publish: unsafe staging or canonical path');
    }
    const canonical = path.resolve(canonicalPath);
    const outRoot = path.resolve(config.OUTPUT_DIR);
    if (!_isInside(outRoot, canonical)) {
        throw _err('invalid_stage_path', `canonical path escapes OUTPUT_DIR: ${canonical}`);
    }
    const stagedPath = _stagedFilesIn(fsImpl, fenceDir)[0] || null;
    if (!stagedPath) {
        return { published: false, reason: fsImpl.existsSync(canonical) ? 'already_published' : 'staged_missing' };
    }
    if (!overwrite && fsImpl.existsSync(canonical)) {
        return { published: false, reason: 'already_published' };
    }
    try {
        fsImpl.mkdirSync(path.dirname(canonical), { recursive: true });
        fsImpl.renameSync(stagedPath, canonical);
        _fsyncDir(fsImpl, path.dirname(canonical));
    } catch (err) {
        throw _err('publish_failed', `rename staged → canonical failed: ${err.message}`);
    }
    return { published: true, reason: 'published' };
}

function _stagedFilesIn(fsImpl, fenceDir) {
    try {
        // Only the fully staged artifact (post-rename) is publishable — a
        // leftover `artifact.tmp` (crash mid-stage) is never published.
        return fsImpl.readdirSync(fenceDir)
            .filter((f) => f.startsWith(STAGED_FILE_NAME) && !f.endsWith('.tmp'))
            .map((f) => path.join(fenceDir, f));
    } catch (_) {
        return [];
    }
}

// ── publication state machine (Stage 135 · audit 134 B6) ──────────────────
//
// `done` proves a COMMIT; it never proves that the staged bytes reached the
// canonical path. The canonical path is shared by every generation of the
// same task, so "the canonical file exists" proves nothing about THIS fence —
// the Stage 134 audit showed a retry reporting success over the PREVIOUS
// generation's bytes and a resume deleting the current fence's only copy.
//
// The decision is taken from the per-task publication marker (written durably
// BEFORE the rename, see queue-idempotency.fencePublishKey):
//
//   marker.published == fence  → THIS fence is already in canonical;
//   marker.renaming  == fence  → a rename of THIS fence was in flight;
//   anything else             → the canonical file (if any) is another
//                               generation's and may be replaced.
//
// Crash windows and their resolution are listed next to the marker helpers; a
// marker write that fails BEFORE the rename aborts the publication (the staged
// bytes stay and a retry/recovery replays it) rather than renaming blind.

const PUBLICATION_RENAMING = 'renaming';
const PUBLICATION_PUBLISHED = 'published';

/**
 * Publish one COMMITTED fence under the per-task CROSS-PROCESS lock.
 *
 * Stage 137 (audit 136 P1-A): the intent is re-read INSIDE the lock, the lock
 * token is verified immediately before AND after the rename, and the intent is
 * read once more after the rename. A publication that was superseded while it
 * held the lock rolls its canonical replacement back and reports `stale_intent`
 * — it never reports success and never reaches the ready-metadata chain.
 *
 * Stage 137 (audit 136 P1-B): every success-looking branch checks the canonical
 * file against the manifest's sha256 + byte size. `marker.published == fence`
 * or "a file exists" alone is never accepted.
 *
 * @returns {Promise<{published:boolean, reason:'published'|'rename_verified'|'already_published', cleaned:boolean}>}
 * @throws code `invalid_stage_path` (unsafe path), `publish_failed`
 *         (marker/lock/rename/read failure — retryable, no false success),
 *         `staged_missing` (committed bytes and canonical both gone),
 *         `publication_unproven` / `canonical_content_mismatch` (canonical is
 *         not the committed artifact — never reported as success),
 *         `staged_content_mismatch` (staged bytes do not match the manifest),
 *         `stale_intent` (the fence was superseded while publishing).
 */
async function publishCommittedFence(config, redis, {
    bookId, chapterId, sceneId, jobId, buildId, fence, canonicalPath,
}, deps = {}) {
    const fsImpl = deps.fs || fs;
    const fenceDir = fenceDirFor(config, { buildId, jobId, fence });
    const canonical = canonicalPath ? path.resolve(canonicalPath) : null;
    const outRoot = config && config.OUTPUT_DIR ? path.resolve(config.OUTPUT_DIR) : null;
    if (!fenceDir || !canonical || !outRoot || !_isInside(outRoot, canonical)) {
        throw _err('invalid_stage_path', 'cannot publish: unsafe staging or canonical path');
    }
    const task = { bookId, chapterId, sceneId, jobId };
    const fenceStr = String(fence);

    return withPublicationLock(config, task, async (lock) => {
        // ── 1. Authority: the CURRENT intent, re-read inside the lock ─────
        // A superseded fence must not even inspect marker/staged state, and
        // certainly must not rename. This is the check Stage 136 found missing
        // between the earlier intent check and the filesystem rename.
        const intent = await qidem.readIntentStrict(redis, task);
        if (intent.status === 'error') {
            throw _err('publish_failed', `intent read failed inside the publication lock: ${intent.error}`);
        }
        if (intent.status === 'absent') {
            throw _err('intent_missing', `intent vanished before publication (job=${jobId})`);
        }
        if (intent.status === 'corrupt') {
            throw _err('intent_corrupt', `intent is unreadable before publication (job=${jobId})`);
        }
        if (intent.fence.toLowerCase() !== fenceStr.toLowerCase() || intent.state !== 'active') {
            throw _err('stale_intent',
                `fence ${fenceStr.slice(0, 12)} is no longer the active intent (job=${jobId})`);
        }

        // ── 2. Durable content proof of THIS fence ───────────────────────
        const manifestRead = await readManifestStrict(redis, task);
        if (manifestRead.status === 'error') {
            throw _err('publish_failed', `manifest read failed: ${manifestRead.error}`);
        }
        if (manifestRead.status === 'absent') {
            throw _err('manifest_missing', `no committed manifest for fence ${fenceStr.slice(0, 12)} (job=${jobId})`);
        }
        if (manifestRead.status === 'corrupt') {
            throw _err('manifest_corrupt', `committed manifest is unreadable (job=${jobId})`);
        }
        const manifest = manifestRead.manifest;
        if (String(manifest.published_fence || '').toLowerCase() !== fenceStr.toLowerCase()) {
            throw _err('stale_intent',
                `manifest belongs to another fence (job=${jobId}) — refusing to publish ${fenceStr.slice(0, 12)}`);
        }
        const expected = expectedProofOf(manifest);
        if (!expected) {
            throw _err('content_proof_missing',
                `manifest of fence ${fenceStr.slice(0, 12)} carries no sha256/bytes proof (job=${jobId})`);
        }

        // ── 3. Publication marker + staged/canonical content ─────────────
        const read = await qidem.readFencePublication(redis, task);
        if (read.status === 'error') {
            throw _err('publish_failed', `publication marker read failed: ${read.error}`);
        }
        const sameFence = read.status === 'ok' && String(read.marker.fence).toLowerCase() === fenceStr.toLowerCase();
        const stagedPath = _stagedFilesIn(fsImpl, fenceDir)[0] || null;
        const canonicalExists = fsImpl.existsSync(canonical);
        const canonicalProof = canonicalExists
            ? artifactProof(fsImpl, canonical)
            : { ok: false, reason: 'missing' };
        const canonicalMatches = proofMatches(canonicalProof, expected);

        // 4. THIS fence is already published: idempotent, never flaps — but
        //    ONLY when the canonical bytes still match the committed manifest.
        //    A mismatch must never delete the staged copy: it may be the only
        //    correct copy left (audit 136 · M8).
        if (sameFence && read.marker.stage === PUBLICATION_PUBLISHED && canonicalMatches) {
            let cleaned = false;
            if (stagedPath) {
                try { fsImpl.rmSync(stagedPath, { force: true }); cleaned = true; } catch (_) { /* leftover only */ }
            }
            _removeBackup(fsImpl, { kind: 'file', path: path.join(fenceDir, ROLLBACK_FILE_NAME) });
            return { published: false, reason: 'already_published', cleaned };
        }
        if (sameFence && read.marker.stage === PUBLICATION_PUBLISHED && canonicalExists
            && !canonicalMatches && !stagedPath) {
            throw _err('canonical_content_mismatch',
                `canonical does not match the committed artifact of fence ${fenceStr.slice(0, 12)} and no staged copy remains (job=${jobId}); a redelivery must re-stage the result`);
        }

        // 5. No staged bytes. `renaming` + canonical is only proof when the
        //    canonical BYTES match this fence's manifest. If the staged file
        //    disappeared concurrently (ENOENT / discardStagedFence) and the
        //    canonical belongs to another fence, never report success
        //    (audit 136 · M9).
        if (!stagedPath) {
            if (sameFence && read.marker.stage === PUBLICATION_RENAMING && canonicalMatches) {
                await qidem.markFencePublication(redis, {
                    bookId, chapterId, sceneId, jobId, fence: fenceStr,
                    stage: PUBLICATION_PUBLISHED,
                    sha256: expected.sha256, bytes: expected.bytes,
                });
                return { published: true, reason: 'rename_verified', cleaned: false };
            }
            if (!canonicalExists) {
                throw _err('staged_missing', `staged bytes of a committed fence are gone (job=${jobId})`);
            }
            if (!canonicalMatches) {
                throw _err('publication_unproven',
                    `canonical bytes do not belong to fence ${fenceStr.slice(0, 12)} (job=${jobId})`);
            }
            // Canonical matches but there is no marker evidence of a rename
            // (evicted marker). This is NOT success: the commit cannot prove
            // the rename. A redelivery may re-stage and complete it.
            throw _err('publication_unproven',
                `rename of fence ${fenceStr.slice(0, 12)} is not proven by the durable marker (job=${jobId})`);
        }

        // 6. The staged bytes must be the committed artifact before they are
        //    allowed to touch canonical (partial write / tampering).
        const stagedProof = artifactProof(fsImpl, stagedPath);
        if (!stagedProof.ok) {
            if (stagedProof.reason === 'missing') {
                throw _err('staged_missing', `staged bytes vanished before publication (job=${jobId})`);
            }
            throw _err('publish_failed', `cannot read staged artifact: ${stagedProof.error || stagedProof.reason}`);
        }
        if (!proofMatches(stagedProof, expected)) {
            throw _err('staged_content_mismatch',
                `staged bytes do not match the committed manifest of fence ${fenceStr.slice(0, 12)} (job=${jobId})`);
        }

        // 7. Preserve the previous canonical bytes and take the durable
        //    `renaming` marker BEFORE the rename.
        const backup = _backupCanonical(fsImpl, fenceDir, canonical, canonicalExists);
        const marked = await qidem.markFencePublication(redis, {
            bookId, chapterId, sceneId, jobId, fence: fenceStr,
            stage: PUBLICATION_RENAMING,
            sha256: expected.sha256, bytes: expected.bytes,
        });
        if (!marked) {
            _removeBackup(fsImpl, backup);
            throw _err('publish_failed', 'publication marker write failed — the rename was not attempted');
        }

        // 8. The lock must still be ours at the rename boundary. A stale owner
        //    that lost its lock may never move bytes.
        if (!lock.verify()) {
            _removeBackup(fsImpl, backup);
            await _restoreMarker(redis, task, read);
            throw _err('publication_lock_lost', 'publication lock was lost before the rename — nothing was renamed');
        }

        try {
            fsImpl.mkdirSync(path.dirname(canonical), { recursive: true });
            fsImpl.renameSync(stagedPath, canonical);
            _fsyncDir(fsImpl, path.dirname(canonical));
        } catch (err) {
            // A concurrent publisher of the SAME fence may have moved the
            // staged file. Accept that ONLY if the canonical bytes are proven
            // to be this fence's committed artifact.
            if (err && err.code === 'ENOENT') {
                const nowProof = artifactProof(fsImpl, canonical);
                if (proofMatches(nowProof, expected)) {
                    await qidem.markFencePublication(redis, {
                        bookId, chapterId, sceneId, jobId, fence: fenceStr,
                        stage: PUBLICATION_PUBLISHED,
                        sha256: expected.sha256, bytes: expected.bytes,
                    });
                    _removeBackup(fsImpl, backup);
                    return { published: true, reason: 'rename_verified', cleaned: false };
                }
            }
            _removeBackup(fsImpl, backup);
            throw _err('publish_failed', `rename staged → canonical failed: ${err.message}`);
        }

        // 9. Prove the rename produced the committed bytes.
        const postRenameProof = artifactProof(fsImpl, canonical);
        if (!proofMatches(postRenameProof, expected)) {
            _removeBackup(fsImpl, backup);
            throw _err('publish_verification_failed',
                `canonical bytes after rename do not match the committed artifact (job=${jobId})`);
        }

        // 10. Post-rename authority check: the fence may have been superseded
        //     while it held the lock, and the lock itself may have been lost.
        //     Either way: no success, no ready metadata; roll the canonical
        //     replacement back if it is still ours.
        const after = await qidem.readIntentStrict(redis, task);
        const lockOwned = lock.verify();
        const stillCurrent = after.status === 'ok'
            && after.fence.toLowerCase() === fenceStr.toLowerCase() && after.state === 'active';
        if (!lockOwned || !stillCurrent) {
            if (after.status === 'error') {
                _removeBackup(fsImpl, backup);
                throw _err('publish_failed',
                    `intent read failed after the rename (job=${jobId}) — publication is not confirmed`);
            }
            const currentProof = artifactProof(fsImpl, canonical);
            if (proofMatches(currentProof, expected)) {
                _restoreCanonical(fsImpl, backup, canonical, expected, stagedPath);
            }
            _removeBackup(fsImpl, backup);
            await _restoreMarker(redis, task, read);
            throw _err(lockOwned ? 'stale_intent' : 'publication_lock_lost',
                lockOwned
                    ? `fence ${fenceStr.slice(0, 12)} was superseded during publication — canonical rolled back (job=${jobId})`
                    : `publication lock was lost during publication — canonical rolled back (job=${jobId})`);
        }

        // 11. Best effort finalization: the rename is complete and verified, so
        //     a failed marker write is repaired by recovery from the same
        //     content proof (never from "a file exists").
        const finalized = await qidem.markFencePublication(redis, {
            bookId, chapterId, sceneId, jobId, fence: fenceStr,
            stage: PUBLICATION_PUBLISHED,
            sha256: expected.sha256, bytes: expected.bytes,
        });
        if (!finalized) {
            console.warn(`[RESULT-PUBLICATION] publication marker not finalized for job=${jobId} fence=${fenceStr.slice(0, 12)} (rename is complete and verified; recovery repairs it)`);
        }
        _removeBackup(fsImpl, backup);
        return { published: true, reason: 'published', cleaned: false };
    }, { fs: fsImpl, waitMs: deps.lockWaitMs });
}

/**
 * Read-only proof that the CURRENT fence's committed artifact is really at the
 * canonical path. Used by debug recovery before any "already ready / already on
 * disk / PG ready" short-circuit (Stage 137 · audit 136 B3e/f/g): a ready flag
 * or a file left by a PREVIOUS generation is not proof for the current one.
 *
 * Takes the same per-task lock as publication so it observes a complete
 * publication, never a marker/rename in flight.
 *
 * @returns {Promise<{status:'published'|'not_published'|'superseded'|'error', reason?:string, manifest?:object, proof?:object}>}
 */
async function verifyPublishedFence(config, redis, {
    bookId, chapterId, sceneId, jobId, buildId = null, fence, canonicalPath = null,
}, deps = {}) {
    const fsImpl = deps.fs || fs;
    const task = { bookId, chapterId, sceneId, jobId };
    const fenceStr = String(fence || '');
    return withPublicationLock(config, task, async () => {
        const intent = await qidem.readIntentStrict(redis, task);
        if (intent.status === 'error') return { status: 'error', reason: 'intent_read_error' };
        if (intent.status !== 'ok') return { status: 'not_published', reason: `intent_${intent.status}` };
        if (intent.fence.toLowerCase() !== fenceStr.toLowerCase() || intent.state !== 'active') {
            return { status: 'superseded', reason: 'intent_of_another_fence' };
        }
        const manifestRead = await readManifestStrict(redis, task);
        if (manifestRead.status === 'error') return { status: 'error', reason: 'manifest_read_error' };
        if (manifestRead.status !== 'ok') return { status: 'not_published', reason: `manifest_${manifestRead.status}` };
        const manifest = manifestRead.manifest;
        if (String(manifest.published_fence || '').toLowerCase() !== fenceStr.toLowerCase()) {
            return { status: 'not_published', reason: 'manifest_of_another_fence' };
        }
        const expected = expectedProofOf(manifest);
        if (!expected) return { status: 'not_published', reason: 'content_proof_missing' };
        const outRoot = path.resolve(config.OUTPUT_DIR);
        const manifestBuild = buildId || manifest.build_id;
        if (!isValidBuildId(manifestBuild)) return { status: 'not_published', reason: 'invalid_build' };
        const buildDir = path.resolve(outRoot, String(manifestBuild));
        const canonical = canonicalPath
            ? path.resolve(canonicalPath)
            : path.resolve(buildDir, String(manifest.canonical_path || ''));
        if (!_isInside(buildDir, canonical) || !_isInside(outRoot, canonical)) {
            return { status: 'error', reason: 'unsafe_canonical_path' };
        }
        const marker = await qidem.readFencePublication(redis, task);
        if (marker.status === 'error') return { status: 'error', reason: 'marker_read_error' };
        if (marker.status !== 'ok'
            || String(marker.marker.fence).toLowerCase() !== fenceStr.toLowerCase()
            || marker.marker.stage !== PUBLICATION_PUBLISHED) {
            return { status: 'not_published', reason: 'marker_not_published' };
        }
        const proof = artifactProof(fsImpl, canonical);
        if (!proof.ok) return { status: 'not_published', reason: `canonical_${proof.reason}` };
        if (!proofMatches(proof, expected)) return { status: 'not_published', reason: 'canonical_content_mismatch' };
        return { status: 'published', manifest, proof };
    }, { fs: fsImpl, waitMs: deps.lockWaitMs });
}

/**
 * Remove the staged leftovers of ONE fence (own dir only — the path is
 * containment-derived, canonical files and other fences are unreachable).
 * Called for `stale_intent`/`intent_*` rejects and for uncommitted garbage.
 *
 * @returns {boolean} true when something was removed.
 */
function discardStagedFence(config, { buildId, jobId, fence }, deps = {}) {
    const fsImpl = deps.fs || fs;
    const fenceDir = fenceDirFor(config, { buildId, jobId, fence });
    if (!fenceDir) return false;
    try {
        if (!fsImpl.existsSync(fenceDir)) return false;
        fsImpl.rmSync(fenceDir, { recursive: true, force: true });
        return true;
    } catch (_) {
        return false;
    }
}

// ── fenced commit protocol ────────────────────────────────────────────────

/**
 * The durable publication manifest stored in Redis (and journaled).
 *
 * Stage 137 (audit 136 P1-B): `sha256` is the cryptographic proof that the
 * canonical path contains the committed artifact. It is computed from the
 * staged file when not supplied by the caller (the in-process commit passes
 * the buffer hash); a manifest that cannot name its bytes is never written.
 */
function buildCommitManifest({ bookId, chapterId, sceneId, jobId, buildId, buildDir, fence, stagedPath, canonicalPath, bytes, sha256 = null, now = Date.now() }) {
    const base = path.resolve(buildDir);
    let digest = String(sha256 || '').toLowerCase();
    let size = Number(bytes) || 0;
    if (!SHA256_RE.test(digest)) {
        const proof = artifactProof(fs, stagedPath);
        if (!proof.ok) {
            throw _err('staged_unreadable', `cannot hash the staged artifact: ${proof.error || proof.reason}`);
        }
        digest = proof.sha256;
        size = proof.bytes;
    }
    return {
        version: MANIFEST_VERSION,
        published_fence: String(fence),
        book_id: String(bookId),
        chapter_id: String(chapterId),
        scene_id: String(sceneId),
        job_id: String(jobId),
        build_id: String(buildId),
        // Both paths are RELATIVE to the build dir: the manifest stays
        // valid across mounts, and every consumer re-validates containment.
        staged_path: path.relative(base, path.resolve(stagedPath)),
        canonical_path: path.relative(base, path.resolve(canonicalPath)),
        bytes: size,
        sha256: digest,
        published_at: Number(now) || 0,
    };
}

/**
 * The full protocol for one fenced result (stage → commit → publish).
 *
 * @returns {Promise<{status:string, staged?:object, published?:boolean}>}
 *   status — the fence-commit verdict (`committed`, `duplicate_same_fence`,
 *            `stale_intent`, `intent_missing`, `intent_corrupt`,
 *            `invalid_fence`, `unavailable`).
 * @throws code `invalid_stage_path` | `empty_result` | `publish_failed`
 *         (fs-level failures: no commit / no metadata may follow).
 */
async function commitFencedResult(redis, config, {
    bookId, chapterId, sceneId, jobId, buildId, fence, buffer, extension, canonicalPath, now,
}, deps = {}) {
    const fsImpl = deps.fs || fs;

    // 1. STAGE — canonical path untouched, no Redis interaction yet.
    const staged = stageResult(config, { buildId, jobId, fence, buffer, extension }, { fs: fsImpl });

    // 2. COMMIT — atomic Redis verdict from the durable intent record.
    const manifest = buildCommitManifest({
        bookId, chapterId, sceneId, jobId, buildId,
        buildDir: path.join(path.resolve(config.OUTPUT_DIR), buildId),
        fence, stagedPath: staged.stagedPath, canonicalPath, bytes: staged.bytes,
        sha256: sha256Buffer(buffer), now,
    });
    const verdict = await qidem.fenceCommitResult(redis, {
        bookId, chapterId, sceneId, jobId, fence, manifest,
    });

    if (verdict.status === 'stale_intent' || verdict.status === 'intent_missing'
        || verdict.status === 'intent_corrupt' || verdict.status === 'invalid_fence') {
        // Terminal reject: only OUR staged bytes are discarded; canonical,
        // manifest, ready metadata and every other fence are untouched.
        discardStagedFence(config, { buildId, jobId, fence }, { fs: fsImpl });
        return { status: verdict.status, staged, published: false };
    }
    if (verdict.status !== 'committed' && verdict.status !== 'duplicate_same_fence') {
        // `unavailable` / `invalid` — NOT a success. The staged bytes and the
        // claim stay so a retry (or the reconciler) can complete the commit.
        return { status: verdict.status, staged, published: false };
    }

    // 3. PUBLISH — only now may the canonical path change. The state machine
    //    (Stage 135 · B6) decides from the durable publication marker whether
    //    the canonical file already belongs to THIS fence:
    //      · marker.published == fence        → idempotent, no overwrite;
    //      · marker.renaming  == fence        → finish the interrupted rename;
    //      · marker of another fence / absent → the canonical file is another
    //        generation's and is replaced (the intent gate above proved that
    //        THIS fence is the current one).
    // `duplicate_same_fence` therefore still finishes a crashed rename of the
    // current publication, without ever flapping an already-published file.
    const publication = await publishCommittedFence(config, redis, {
        bookId, chapterId, sceneId, jobId, buildId, fence, canonicalPath,
    }, { fs: fsImpl });

    return {
        status: verdict.status, staged,
        published: publication.published,
        publication: publication.reason,
    };
}

// ── restart recovery ──────────────────────────────────────────────────────

/**
 * Replay publications that were COMMITTED in Redis but whose staged→canonical
 * rename did not complete (crash / rename failure between commit and
 * publish). The decision is taken from the DURABLE state — manifest +
 * done marker — never from "a file exists" (Stage 131 §2 invariant 9).
 *
 * Idempotent and safe to run every reconciliation cycle:
 *   · manifest without done marker → NOT published (an uncommitted manifest
 *     write is impossible by construction, but never trust one signal);
 *   · fence is NOT the current intent → skipped (Stage 133 · audit 132 B4):
 *     manifest + done prove a commit HAPPENED, not that the fence is still
 *     current. Replaying a superseded fence would put dead bytes into the
 *     canonical path while the current generation still owes a publication;
 *   · canonical already holds THIS fence (publication marker) → staged
 *     leftover of the same fence removed, nothing else touched;
 *   · the rename was interrupted      → completed (marker written before it);
 *   · both files missing              → reported as orphan, nothing recreated;
 *   · staged missing, canonical of an unproven fence → NOT a success, left to
 *     an operator / a fresh delivery (Stage 135 · audit 134 B6).
 *
 * @returns {Promise<{scanned:number, resumed:number, cleaned:number, orphans:number, superseded:number, errors:number}>}
 */
async function resumePendingPublications(redis, config, { limit = RESUME_MANIFEST_LIMIT } = {}, deps = {}) {
    const fsImpl = deps.fs || fs;
    const out = { scanned: 0, resumed: 0, cleaned: 0, orphans: 0, superseded: 0, errors: 0 };
    if (!redis || typeof redis.scan !== 'function') return out;
    const prefix = qidem.IDEM_MANIFEST_PREFIX;
    let cursor = '0';
    try {
        do {
            const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
            cursor = next;
            for (const key of keys || []) {
                if (!key.startsWith(prefix)) continue;
                if (out.scanned >= limit) { cursor = '0'; break; }
                out.scanned++;
                let manifest = null;
                try { manifest = JSON.parse(await redis.get(key)); } catch (_) { manifest = null; }
                if (!manifest || typeof manifest !== 'object') { out.errors++; continue; }
                const {
                    published_fence: fence, build_id: buildId, job_id: jobId,
                    book_id: bookId, chapter_id: chapterId, scene_id: sceneId,
                } = manifest;
                if (!FENCE_RE.test(String(fence || '')) || !isValidBuildId(buildId)
                    || !jobId || !bookId || !chapterId || !sceneId) { out.errors++; continue; }
                // BOTH the manifest AND the done marker must agree — a lone
                // file or a lone key never authorizes a publication.
                let committed = false;
                try { committed = await qidem.isTaskDone(redis, String(fence).toLowerCase()); } catch (_) { committed = false; }
                if (!committed) continue;

                // Stage 133 (audit 132 · B4) — the CURRENT intent decides
                // whether these committed bytes may still appear. A superseded
                // fence is skipped (its staged dir is left to the age-gated
                // GC); a missing intent is not a contradiction (it expired
                // after the commit) and the durable pair still authorizes the
                // replay. Any read/parse failure means "cannot prove" → no
                // write at all for this key.
                let intentRaw = null;
                try {
                    intentRaw = await redis.get(qidem.intentKey(bookId, chapterId, sceneId, jobId));
                } catch (err) {
                    out.errors++;
                    continue;
                }
                if (intentRaw != null && intentRaw !== false) {
                    let intent = null;
                    try { intent = JSON.parse(intentRaw); } catch (_) { intent = null; }
                    if (!intent || typeof intent !== 'object' || intent.fence == null) { out.errors++; continue; }
                    if (String(intent.fence).toLowerCase() !== String(fence).toLowerCase()) {
                        out.superseded++;
                        continue;
                    }
                }

                const buildDir = path.resolve(config.OUTPUT_DIR, buildId);
                const canonical = path.resolve(buildDir, String(manifest.canonical_path || ''));
                const staged = path.resolve(buildDir, String(manifest.staged_path || ''));
                if (!_isInside(buildDir, canonical) || !_isInside(buildDir, staged)) { out.errors++; continue; }
                try {
                    // The SAME state machine as the in-process publication:
                    // only the publication marker can prove that the canonical
                    // file belongs to this fence (Stage 135 · audit 134 B6).
                    const publication = await publishCommittedFence(config, redis, {
                        bookId, chapterId, sceneId, jobId, buildId, fence, canonicalPath: canonical,
                    }, { fs: fsImpl });
                    if (publication.published) {
                        out.resumed++;
                    } else if (publication.reason === 'already_published' && publication.cleaned) {
                        out.cleaned++;
                    }
                } catch (err) {
                    // Stage 137 — a fence that lost its intent (or its
                    // publication lock) while the rename was in flight is
                    // SUPERSEDED, never "resumed". No success is reported.
                    if (err && err.code === 'staged_missing') out.orphans++;
                    else if (err && (err.code === 'stale_intent' || err.code === 'publication_lock_lost')) out.superseded++;
                    else out.errors++;
                    console.warn(`[RESULT-PUBLICATION] resume failed for job=${jobId} fence=${String(fence).slice(0, 12)}: ${err.code || ''} ${err.message}`);
                }
            }
        } while (cursor !== '0');
    } catch (err) {
        console.warn(`[RESULT-PUBLICATION] resume scan failed: ${err.message}`);
    }
    return out;
}

// ── staging GC (contract 126 §5.5) ────────────────────────────────────────

/**
 * Remove staging fence dirs that can never be published:
 *   age > 24 h AND (the job's current intent is a DIFFERENT fence OR the
 *   intent record is definitively absent) AND no done marker for the fence.
 *
 * The done marker is checked with STRICT reads: any Redis error aborts the
 * pass (a Redis outage must never look like "not committed" and delete the
 * staged bytes of a committed-but-unrenamed publication).
 *
 * Only `.staging` dirs are touched — canonical files and legacy artifacts are
 * unreachable by construction (path containment).
 *
 * @returns {Promise<{scanned:number, removed:number, skipped:number, aborted:boolean}>}
 */
async function collectStaleStaging(config, redis, { maxAgeMs = STAGING_MAX_AGE_MS, maxBuilds = GC_MAX_BUILDS, now = Date.now() } = {}, deps = {}) {
    const fsImpl = deps.fs || fs;
    const out = { scanned: 0, removed: 0, skipped: 0, aborted: false };
    if (!config || !config.OUTPUT_DIR || !redis) return out;
    let jobSchema;
    try { jobSchema = require('../runtime/job-schema'); } catch (_) { jobSchema = null; }

    let buildNames = [];
    try {
        buildNames = fsImpl.readdirSync(config.OUTPUT_DIR, { withFileTypes: true })
            .filter((e) => e.isDirectory() && isValidBuildId(e.name))
            .map((e) => e.name)
            .slice(0, maxBuilds);
    } catch (_) {
        return out;
    }

    try {
        for (const buildId of buildNames) {
            const root = stagingRootFor(config, buildId);
            if (!root || !fsImpl.existsSync(root)) continue;
            let jobDirs = [];
            try { jobDirs = fsImpl.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch (_) { continue; }
            for (const jobDir of jobDirs) {
                let jobId;
                try { jobId = decodeURIComponent(jobDir.name); } catch (_) { continue; }
                const jobPath = path.join(root, jobDir.name);
                let jobEntries = [];
                try { jobEntries = fsImpl.readdirSync(jobPath, { withFileTypes: true }); } catch (_) { continue; }

                // Versioned-publish writer temps are FILES directly inside
                // `{build}/.staging/{assetId}/` (`{fence}.{pid}.{rand}.tmp`,
                // legacy `{fence}.tmp`): a writer that died between link(2)
                // and unlink leaves one behind, sharing its inode with the
                // already-published immutable file (unlink of the temp only
                // drops a link — the published file stays). After the age
                // gate such a leftover is pure garbage: an in-flight publish
                // writes for milliseconds, and the fence dirs of the RESULT
                // contour live one level deeper, so their `artifact.tmp` is
                // never matched here. Authority for a versioned fence is PG,
                // not Redis — a Redis outage must not keep these leftovers.
                for (const entry of jobEntries) {
                    if (!entry.isFile()) continue;
                    if (!VERSIONED_STAGING_TMP_RE.test(entry.name)) continue;
                    out.scanned++;
                    const filePath = path.join(jobPath, entry.name);
                    let tmpSt = null;
                    try { tmpSt = fsImpl.statSync(filePath); } catch (_) { continue; }
                    if (now - tmpSt.mtimeMs < maxAgeMs) { out.skipped++; continue; }
                    try { fsImpl.unlinkSync(filePath); out.removed++; } catch (_) { out.skipped++; }
                }

                const fenceNames = jobEntries.filter((e) => e.isDirectory());
                for (const fenceDir of fenceNames) {
                    out.scanned++;
                    const fence = fenceDir.name.toLowerCase();
                    if (!FENCE_RE.test(fence)) { out.skipped++; continue; }
                    const fencePath = path.join(jobPath, fenceDir.name);
                    let st = null;
                    try { st = fsImpl.statSync(fencePath); } catch (_) { continue; }
                    if (now - st.mtimeMs < maxAgeMs) { out.skipped++; continue; }

                    // STRICT Redis reads — any Redis error aborts the whole
                    // pass: an outage must never look like "not committed"
                    // and delete the staged bytes of a committed (but not yet
                    // renamed) publication.
                    if ((await redis.get(qidem.idemDoneKey(fence))) != null) { out.skipped++; continue; }
                    const parsed = jobSchema && jobSchema.parseJobId ? jobSchema.parseJobId(jobId) : null;
                    if (!parsed) { out.skipped++; continue; } // cannot classify → never delete
                    const intentRaw = await redis.get(qidem.intentKey(parsed.bookId, parsed.chapterId, parsed.sceneId, jobId));
                    if (intentRaw != null) {
                        let intent = null;
                        try { intent = JSON.parse(intentRaw); } catch (_) { intent = null; }
                        // Corrupt or foreign intent: a corrupt record means the
                        // commit would fail closed (`intent_corrupt`) — but do
                        // NOT delete on corrupt data, only on a definite
                        // "current fence is another one".
                        if (intent && String(intent.fence) === fence) { out.skipped++; continue; } // current fence
                        if (!intent) { out.skipped++; continue; }
                    }
                    // (intent definitively absent → this fence can never
                    //  commit — `intent_missing` — the staged bytes are dead)
                    fsImpl.rmSync(fencePath, { recursive: true, force: true });
                    out.removed++;
                }
            }
        }
    } catch (err) {
        out.aborted = true;
        console.warn(`[RESULT-PUBLICATION] staging GC aborted: ${err.message}`);
    }
    return out;
}

module.exports = {
    STAGING_DIR_NAME,
    STAGING_MAX_AGE_MS,
    isValidBuildId,
    stagingRootFor,
    fenceDirFor,
    canonicalPathFor,
    stageResult,
    publishStaged,
    publishCommittedFence,
    verifyPublishedFence,
    sha256Buffer,
    artifactProof,
    expectedProofOf,
    discardStagedFence,
    buildCommitManifest,
    commitFencedResult,
    resumePendingPublications,
    collectStaleStaging,
};
