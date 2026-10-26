// ======================================================
// Stage 143a — durable IU-image fence reservations + versioned pointers
// ======================================================
//
// The ONLY PG access point of the stage-143a versioned `iu_image` contour
// (contract: stage143a-checkpoint.md §B1/B2/B3):
//
//   iu_image_fence_reservations  idem_key (sha256 hex) → integer fence +
//                                resource identity (book/chapter/scene/iu/build)
//   iu_image_pointers            (book/chapter/scene/iu/build) → relative
//                                immutable path + publish_fence
//
// Roles (checkpoint B6): the Redis intent/receipt answers ADMIT/CANCEL/
// SUPERSEDE questions; the PostgreSQL fence is the SOLE ordering authority
// for publication versions. This module never writes Redis.
//
// Feature flag: IU_IMAGE_VERSIONED (lazily read — same kill-switch style as
// GPU_FENCING_MODE). While OFF every public entrypoint returns a disabled
// verdict WITHOUT touching PostgreSQL, so the legacy contour issues zero new
// PG calls (Stage 143a condition 2).
//
// DDL is NOT here: guardrail PG-5 keeps all DDL in storage/postgres/schema.js
// (backend/tests/architecture/postgres-host-infrastructure.test.js).
//
// ── OPERATOR RULE (contract B7 / Stage 143a fix · A2) ────────────────────
//
// Mode exclusivity, in both directions:
//   • flag ON  → every `iu_image` result goes down the versioned branch
//     (task-handler `versionedIuPublication`); the legacy canonical writer is
//     unreachable for `iu_image`, so a legacy write can never race a
//     publication while the flag is on.
//   • flag OFF → this module answers "disabled" and the POINTER IS INERT:
//     every reader returns null with ZERO PG calls and serves the legacy
//     canonical file byte-identically, even when rows from an earlier ON
//     period are still in the table.
//
// The dangerous state is therefore: flag flipped OFF after a period of
// publications, a LEGACY writer then updated the canonical file, flag flipped
// back ON — the reader would serve a STALE pointer (the older generation)
// instead of the newer legacy bytes. Before RE-enabling the flag an operator
// must drop the pointers (and, when the affected receipts must not be
// replayed, the reservations) of the books/builds that went through the
// legacy window:
//
//   -- one build of one book
//   DELETE FROM iu_image_pointers           WHERE book_id = $1 AND build_id = $2;
//   -- every build of one book
//   DELETE FROM iu_image_pointers           WHERE book_id = $1;
//   -- optional: drop the durable fence reservations of the same scope (a
//   -- dropped reservation makes an old hex receipt fail closed with
//   -- reservation_missing → terminal reject; nothing is published)
//   DELETE FROM iu_image_fence_reservations WHERE book_id = $1 AND build_id = $2;
//   DELETE FROM iu_image_fence_reservations WHERE book_id = $1;
//
// Never "reset" a pointer by hand (no manual UPDATE) and never delete
// immutable files: the pointer only moves forward through
// publishIuImagePointer (`publish_fence <= EXCLUDED`), and
// `{build}/.versions/**` is write-once.
//
// Path safety (Stage 143a condition 3): pointers store paths RELATIVE to
// OUTPUT_DIR; every read resolves through resolveOutputPath() which rejects
// traversal, absolute paths and symlinks escaping OUTPUT_DIR.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// Keep the module object (not a destructured snapshot) so tests can spy on
// `database.query` without losing the reference this module captured.
const database = require('../database');

const VERSIONED_ENV = 'IU_IMAGE_VERSIONED';

const FENCE_SEQ = 'iu_image_fence_seq';
const RESERVATION_TABLE = 'iu_image_fence_reservations';
const POINTER_TABLE = 'iu_image_pointers';

/** Flag accessor — read on every call (kill-switch semantics). */
function versionedEnabled() {
    const v = String(process.env[VERSIONED_ENV] || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

// ── path safety ──────────────────────────────────────────────────────────

function inside(root, p) {
    return p === root || p.startsWith(root + path.sep);
}

/**
 * Lexical validation of a stored (relative) path: string, no NUL, no
 * absolute form, no `..` segment after normalization.
 */
function normalizeRelativePath(relPath) {
    if (typeof relPath !== 'string' || relPath.length === 0) {
        return { ok: false, reason: 'not_a_string' };
    }
    if (relPath.indexOf('\0') !== -1) return { ok: false, reason: 'nul_byte' };
    if (path.isAbsolute(relPath) || /^[a-zA-Z]:[\\/]/.test(relPath)) {
        return { ok: false, reason: 'absolute_path' };
    }
    const normalized = path.normalize(relPath);
    const segments = normalized.split(path.sep);
    if (segments.includes('..')) return { ok: false, reason: 'traversal' };
    return { ok: true, normalized };
}

/**
 * Resolve a stored relative path against OUTPUT_DIR. Rejects traversal,
 * absolute paths and symlink escapes — the only acceptable answer for a
 * pointer read is a path strictly INSIDE OUTPUT_DIR.
 *
 * @returns {{ok: true, path: string} | {ok: false, reason: string}}
 */
function resolveOutputPath(outputDir, relPath) {
    const norm = normalizeRelativePath(relPath);
    if (!norm.ok) return { ok: false, reason: norm.reason };

    const root = path.resolve(String(outputDir || ''));
    if (!root || root === path.resolve('')) {
        // Guard against a missing/empty root producing a cwd-relative read.
        if (!outputDir) return { ok: false, reason: 'no_output_dir' };
    }
    const absolute = path.resolve(root, norm.normalized);
    if (!inside(root, absolute)) return { ok: false, reason: 'outside_output_dir' };

    // Symlink escape guard: probe the deepest existing ancestor and make
    // sure it still resolves inside the real OUTPUT_DIR.
    try {
        const realRoot = fs.realpathSync(root);
        let probe = absolute;
        while (!fs.existsSync(probe) && probe !== root && probe !== path.dirname(probe)) {
            probe = path.dirname(probe);
        }
        const realProbe = fs.existsSync(probe) ? fs.realpathSync(probe) : probe;
        if (!inside(realRoot, realProbe)) return { ok: false, reason: 'symlink_escape' };
    } catch (_) {
        // OUTPUT_DIR may not exist yet — the lexical check above still holds.
    }
    return { ok: true, path: absolute };
}

/** Reject path-hostile component values (book ids are client-controlled). */
function safeComponent(value) {
    const s = String(value == null ? '' : value);
    if (!s || s === '.' || s === '..') return null;
    if (/[\\/]/.test(s) || s.indexOf('\0') !== -1) return null;
    return s;
}

/** Immutable versioned path (relative to OUTPUT_DIR) for one fence. */
function versionedRelPath(buildId, assetId, fence) {
    const b = safeComponent(buildId);
    const a = safeComponent(assetId);
    const f = Number(fence);
    if (!b || !a || !Number.isInteger(f) || f <= 0) return null;
    return path.posix.join(b, '.versions', a, `${f}.png`);
}

/**
 * Writer staging path (relative to OUTPUT_DIR) for ONE delivery attempt.
 *
 * Stage 143a fix 2: the name is unique per attempt
 * (`{fence}.{pid}.{rand}.tmp`), never a shared `{fence}.tmp`. After
 * `link(2)` the temp file and the immutable versioned file are the SAME
 * inode — if a crashed attempt left its temp behind (or two deliveries of
 * one fence run concurrently), a second attempt opening the old name with
 * a truncating `open('w')` would cut the PUBLISHED file. The writer opens
 * this path with the exclusive flag `wx` (O_EXCL), which rejects any
 * collision instead of truncating. Leftovers of crashed attempts are
 * collected by the age-based `.staging` GC (`collectStaleStaging`), which
 * recognises this name pattern.
 */
function stagingRelPath(buildId, assetId, fence) {
    const b = safeComponent(buildId);
    const a = safeComponent(assetId);
    const f = Number(fence);
    if (!b || !a || !Number.isInteger(f) || f <= 0) return null;
    const attempt = `${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
    return path.posix.join(b, '.staging', a, `${f}.${attempt}.tmp`);
}

// ── B1 — durable fence reservation (dispatch-time) ───────────────────────

/**
 * Atomically bind one logical dispatch (idem_key) to an integer fence.
 *
 * Contract (checkpoint B1):
 *  - a re-dispatch of the SAME idem_key reuses the original fence (the
 *    PRIMARY KEY is the atomic binding; a concurrent double-reserve resolves
 *    to one row);
 *  - a NEW intent (new idem_key — user regeneration bumps the epoch, see
 *    computeIdemKey) always receives a strictly greater fence (nextval is
 *    never reused, not even by a rolled-back/losing statement);
 *  - the row carries the resource identity so a callback can prove it refers
 *    to this resource + build.
 *
 * The SEQUENCE alone provides uniqueness/monotonicity only — idempotency
 * comes from UNIQUE(idem_key) + ON CONFLICT DO NOTHING + the follow-up read.
 *
 * @returns {Promise<{status:'created'|'reused', fence:number}>}
 * @throws on PG failure — the caller (dispatcher) must NOT send the job.
 */
async function reserveDispatchFence({ idemKey, bookId, chapterId, sceneId, iuId, buildId }) {
    if (!versionedEnabled()) return { status: 'disabled' };

    const existing = await database.query(
        `SELECT fence FROM ${RESERVATION_TABLE} WHERE idem_key = $1`,
        [idemKey]
    );
    if (existing.rows.length > 0) return { status: 'reused', fence: Number(existing.rows[0].fence) };

    const inserted = await database.query(
        `INSERT INTO ${RESERVATION_TABLE}
            (idem_key, book_id, chapter_id, scene_id, iu_id, build_id, fence)
         VALUES ($1, $2, $3, $4, $5, $6, nextval('${FENCE_SEQ}'))
         ON CONFLICT (idem_key) DO NOTHING
         RETURNING fence`,
        [idemKey, bookId, chapterId, sceneId, iuId, buildId]
    );
    if (inserted.rows.length > 0) return { status: 'created', fence: Number(inserted.rows[0].fence) }

    // Lost the race against a concurrent reserve of the SAME idem_key: both
    // statements target one row, so the original fence is read back here
    // (the nextval of the losing statement is burned — a harmless gap).
    const again = await database.query(
        `SELECT fence FROM ${RESERVATION_TABLE} WHERE idem_key = $1`,
        [idemKey]
    );
    if (again.rows.length === 0) {
        throw new Error('iu_image_fence_reservations: reservation row vanished during concurrent reserve');
    }
    return { status: 'reused', fence: Number(again.rows[0].fence) };
}

/**
 * Callback-side admission: hex receipt (idem_key) → integer fence, with the
 * reserved resource identity verified against the parsed job. Missing row or
 * any identity mismatch is a FAIL-CLOSED reject (no publication).
 *
 * @returns {Promise<{ok:true, fence:number} | {ok:false, reason:string}>}
 */
async function resolveCallbackFence({ idemKey, bookId, chapterId, sceneId, iuId, buildId }) {
    if (!versionedEnabled()) return { ok: false, reason: 'versioned_disabled' };
    if (!idemKey) return { ok: false, reason: 'reservation_missing' };

    const res = await database.query(
        `SELECT fence, book_id, chapter_id, scene_id, iu_id, build_id
         FROM ${RESERVATION_TABLE} WHERE idem_key = $1`,
        [idemKey]
    );
    if (res.rows.length === 0) return { ok: false, reason: 'reservation_missing' };
    const row = res.rows[0];
    if (String(row.book_id) !== String(bookId)
        || String(row.chapter_id) !== String(chapterId)
        || String(row.scene_id) !== String(sceneId)
        || String(row.iu_id) !== String(iuId)
        || String(row.build_id) !== String(buildId)) {
        return { ok: false, reason: 'reservation_mismatch' };
    }
    return { ok: true, fence: Number(row.fence) };
}

// ── B2 — atomic pointer publication ──────────────────────────────────────

/**
 * Publish (first insert) or advance the pointer for one IU.
 *
 * `publish_fence <= EXCLUDED.publish_fence` makes the statement idempotent
 * for a REPLAY of the same fence (same reservation → same integer → same
 * deterministic path) and rejects any STALE fence (rowCount 0) — PostgreSQL
 * serializes concurrent publishers through the primary key.
 *
 * @returns {Promise<{published:true, fence:number, current:number}
 *                 | {published:false, reason:string, current:number|null}>}
 */
async function publishIuImagePointer({ bookId, chapterId, sceneId, iuId, buildId, relPath, fence }) {
    if (!versionedEnabled()) return { published: false, reason: 'versioned_disabled', current: null };
    const f = Number(fence);
    if (!Number.isInteger(f) || f <= 0) {
        return { published: false, reason: 'invalid_fence', current: null };
    }

    const upsert = await database.query(
        `INSERT INTO ${POINTER_TABLE}
            (book_id, chapter_id, scene_id, iu_id, build_id, path, publish_fence)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (book_id, chapter_id, scene_id, iu_id, build_id)
         DO UPDATE SET
            path = EXCLUDED.path,
            publish_fence = EXCLUDED.publish_fence,
            updated_at = EXTRACT(EPOCH FROM NOW())::bigint
         WHERE ${POINTER_TABLE}.publish_fence <= EXCLUDED.publish_fence
         RETURNING publish_fence`,
        [bookId, chapterId, sceneId, iuId, buildId, relPath, f]
    );
    if (upsert.rows.length > 0) {
        const current = Number(upsert.rows[0].publish_fence);
        return { published: true, fence: current, current };
    }

    const cur = await database.query(
        `SELECT publish_fence FROM ${POINTER_TABLE}
         WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3 AND iu_id = $4 AND build_id = $5`,
        [bookId, chapterId, sceneId, iuId, buildId]
    );
    return {
        published: false,
        reason: 'stale_fence',
        current: cur.rows.length > 0 ? Number(cur.rows[0].publish_fence) : null,
    };
}

/** Read the published pointer (validated by the CALLER through resolveOutputPath). */
async function getIuImagePointer({ bookId, chapterId, sceneId, iuId, buildId }) {
    if (!versionedEnabled()) return null;
    const res = await database.query(
        `SELECT path, publish_fence FROM ${POINTER_TABLE}
         WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3 AND iu_id = $4 AND build_id = $5`,
        [bookId, chapterId, sceneId, iuId, buildId]
    );
    if (res.rows.length === 0) return null;
    return { path: res.rows[0].path, publishFence: Number(res.rows[0].publish_fence) };
}

/** Published IU ids of one scene build (stage-completion proof, task-handler). */
async function listPublishedIuIds({ bookId, chapterId, sceneId, buildId }) {
    if (!versionedEnabled()) return [];
    const res = await database.query(
        `SELECT DISTINCT iu_id FROM ${POINTER_TABLE}
         WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3 AND build_id = $4`,
        [bookId, chapterId, sceneId, buildId]
    );
    return res.rows.map((r) => String(r.iu_id));
}

/** One published pointer of a scene build (scene-level completion proof). */
async function listScenePointerPaths({ bookId, chapterId, sceneId, buildId, limit = 50 }) {
    if (!versionedEnabled()) return [];
    const res = await database.query(
        `SELECT iu_id, path FROM ${POINTER_TABLE}
         WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3 AND build_id = $4
         ORDER BY publish_fence DESC
         LIMIT $5`,
        [bookId, chapterId, sceneId, buildId, Number(limit) || 50]
    );
    return res.rows.map((r) => ({ iuId: String(r.iu_id), path: r.path }));
}

/**
 * Stage 143a (phase 2c) — every published pointer of one BUILD, for the
 * storyboard export (read-only; the caller unions it with the legacy disk
 * scan). Flag OFF ⇒ [] with zero PG calls; a PG error THROWS so the caller
 * can degrade to a legacy-only export with a warning.
 *
 * Deliberately NO `LIMIT`: a silent cap would produce a TRUNCATED zip that
 * looks complete (a data-loss bug for the user). If a bounded query is ever
 * needed, the caller must detect the overflow and FAIL the export instead of
 * returning a partial archive — never just add a LIMIT here.
 *
 * @returns {Promise<Array<{iuId:string, path:string}>>}
 */
async function listBuildPointerPaths({ bookId, buildId }) {
    if (!versionedEnabled()) return [];
    const res = await database.query(
        `SELECT iu_id, path FROM ${POINTER_TABLE}
         WHERE book_id = $1 AND build_id = $2
         ORDER BY chapter_id, scene_id, iu_id`,
        [bookId, buildId]
    );
    return res.rows.map((r) => ({ iuId: String(r.iu_id), path: r.path }));
}

module.exports = {
    VERSIONED_ENV,
    versionedEnabled,
    // path safety
    normalizeRelativePath,
    resolveOutputPath,
    safeComponent,
    versionedRelPath,
    stagingRelPath,
    // B1
    reserveDispatchFence,
    resolveCallbackFence,
    // B2
    publishIuImagePointer,
    getIuImagePointer,
    listPublishedIuIds,
    listScenePointerPaths,
    listBuildPointerPaths,
};
