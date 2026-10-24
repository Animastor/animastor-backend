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
//   crash after commit, before rename → the manifest + done marker are the
//                                       durable proof; `resumePendingPublications`
//                                       replays the rename (never inferred
//                                       from "a file exists")
//   rename failed in-process          → same as above: NO success is
//                                       reported, the metadata/ready chain
//                                       does not run, the retry/resume
//                                       completes the rename
//
// Invariants this module is built around (Stage 131 §2):
//   · a stale fence never becomes current through a file write or recovery;
//   · the canonical path is never overwritten before the fenced commit;
//   · a repeat of the same fence is idempotent and cannot conflict;
//   · every deletion/rollback is scoped to ONE fence dir (path-contained);
//   · legacy canonical files are never moved or removed by this module.

const fs = require('fs');
const path = require('path');
const qidem = require('../helpers/queue-idempotency.cjs');

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
 * Atomically move the staged file to the canonical artifact path.
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

/** The durable publication manifest stored in Redis (and journaled). */
function buildCommitManifest({ bookId, chapterId, sceneId, jobId, buildId, buildDir, fence, stagedPath, canonicalPath, bytes, now = Date.now() }) {
    const base = path.resolve(buildDir);
    return {
        version: 1,
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
        bytes: Number(bytes) || 0,
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
        fence, stagedPath: staged.stagedPath, canonicalPath, bytes: staged.bytes, now,
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

    // 3. PUBLISH — only now may the canonical path change.
    //
    // `duplicate_same_fence` here means the commit script verified that THIS
    // fence is the CURRENT active intent and only then found its done marker
    // (Stage 133 · audit 132 B4 reordered the script): the replay can only
    // finish a crashed rename of the current publication.
    const published = publishStaged(config, {
        buildId, jobId, fence, canonicalPath,
        // A first commit publishes unconditionally (regeneration replaces the
        // previous generation's file — the current behaviour); a repeat only
        // finishes a crashed rename, it never flaps a published file.
        overwrite: verdict.status === 'committed',
    }, { fs: fsImpl });

    return { status: verdict.status, staged, published: published.published };
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
 *   · canonical already present    → staged leftover of THIS fence removed,
 *     nothing else touched;
 *   · both files missing            → reported as orphan, nothing recreated.
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
                    if (fsImpl.existsSync(canonical)) {
                        // Already published (possibly by a previous pass): a
                        // staged leftover of this committed fence is garbage.
                        if (fsImpl.existsSync(staged)) {
                            fsImpl.rmSync(staged, { force: true });
                            out.cleaned++;
                        }
                        continue;
                    }
                    if (!fsImpl.existsSync(staged)) { out.orphans++; continue; }
                    fsImpl.mkdirSync(path.dirname(canonical), { recursive: true });
                    fsImpl.renameSync(staged, canonical);
                    _fsyncDir(fsImpl, path.dirname(canonical));
                    out.resumed++;
                } catch (err) {
                    out.errors++;
                    console.warn(`[RESULT-PUBLICATION] resume failed for job=${jobId} fence=${String(fence).slice(0, 12)}: ${err.message}`);
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
                let fenceNames = [];
                try { fenceNames = fsImpl.readdirSync(jobPath, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch (_) { continue; }
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
    discardStagedFence,
    buildCommitManifest,
    commitFencedResult,
    resumePendingPublications,
    collectStaleStaging,
};
