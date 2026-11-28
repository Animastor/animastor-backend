// ======================================================
// runtime/worker-lanes — workspace / private-worker / users-policy lookups
// ======================================================
// 2026-11-28 (ORCHESTRATION_V2 этап 4, шаг 7): the three routing lookups the
// orchestration v2 lanes need (gen.defaults.makeLaneFor), moved verbatim out
// of the deleted runtime/gpu-dispatcher.js (protocol-2 hub transport). Cached,
// PG-backed, degrade to the system pool on any error.

'use strict';

const config = require('../config/runtime-config');

const logPrefix = '[GPU]';
function warn(msg) { console.warn(`${logPrefix} ⚠️ ${msg}`); }

const WORKSPACE_CACHE_TTL_MS = 60_000;      // book → workspace
const ROUTING_CACHE_TTL_MS = 30_000;        // (workspace,type) → has private worker
const GRANT_CACHE_TTL_MS = 30_000;           // (workspace,type) → users-policy lane (V2)
const workspaceCache = new Map();
const routingCache = new Map();
const grantCache = new Map();

function cacheGet(cache, key, ttlMs) {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.ts > ttlMs) { cache.delete(key); return undefined; }
    return hit.value;
}

/**
 * Resolve the owning workspace for a book (server-side, cached).
 * @returns {Promise<string|null>} workspace_id or null (absent/unattached/error)
 */
async function resolveWorkspaceForBook(bookId) {
    if (!bookId) return null;
    const cached = cacheGet(workspaceCache, bookId, WORKSPACE_CACHE_TTL_MS);
    if (cached !== undefined) return cached;
    let workspaceId = null;
    try {
        const bookRepo = require('../storage/postgres/repositories/book-repo');
        workspaceId = await bookRepo.getWorkspaceId(bookId);
    } catch (err) {
        warn(`workspace resolution failed for book=${bookId}: ${err.message} — using system pool`);
        workspaceId = null;
    }
    workspaceCache.set(bookId, { value: workspaceId, ts: Date.now() });
    return workspaceId;
}

/**
 * Does the workspace have an active private worker of this type? (cached).
 * @returns {Promise<boolean>}
 */
async function workspaceHasPrivateWorker(workspaceId, workerType) {
    if (!workspaceId) return false;
    const key = `${workspaceId}:${workerType}`;
    const cached = cacheGet(routingCache, key, ROUTING_CACHE_TTL_MS);
    if (cached !== undefined) return cached;
    let has = false;
    try {
        const workerRepo = require('../storage/postgres/repositories/worker-repo');
        has = await workerRepo.hasActivePrivateWorkerOfType(workspaceId, workerType);
    } catch (err) {
        warn(`private-worker routing check failed for ws=${workspaceId} type=${workerType}: ${err.message} — using system pool`);
        has = false;
    }
    routingCache.set(key, { value: has, ts: Date.now() });
    return has;
}

/**
 * SH-2 (worker sharing V2): resolve the workspace's OWNER user, then find an
 * active users-scoped policy whose worker (private, of the job type, not
 * revoked) carries a personal grant for that user. Result: the policy lane
 * the job must be enqueued into (queue:{type}:policy:{id}), or null for the
 * system pool. Kill-switch OFF → always null (bit-for-bit V1-off behavior).
 * Resolutions degrade to the system pool on any error (availability).
 * @returns {Promise<object|null>} { policy_id, scope_kind, expires_at } | null
 */
async function workspaceGrantPolicyLane(workspaceId, workerType) {
    if (!workspaceId) return null;
    if (config.shareFeaturesEnabled() !== true) return null;
    const key = `grant:${workspaceId}:${workerType}`;
    const cached = cacheGet(grantCache, key, GRANT_CACHE_TTL_MS);
    if (cached !== undefined) return cached;
    let lane = null;
    try {
        const workerRepo = require('../storage/postgres/repositories/worker-repo');
        const workspaceRepo = require('../storage/postgres/repositories/workspace-repo');
        const ws = await workspaceRepo.findById(workspaceId);
        if (ws && ws.owner_user_id) {
            lane = await workerRepo.findGrantPolicyForRouting(workspaceId, ws.owner_user_id, workerType);
        }
    } catch (err) {
        warn(`users-policy routing check failed for ws=${workspaceId} type=${workerType}: ${err.message} — using system pool`);
        lane = null;
    }
    grantCache.set(key, { value: lane, ts: Date.now() });
    return lane;
}

/** Test hook: drop resolution caches. */
function clearRoutingCaches() {
    workspaceCache.clear();
    routingCache.clear();
    grantCache.clear();
}

module.exports = { resolveWorkspaceForBook, workspaceHasPrivateWorker, workspaceGrantPolicyLane, clearRoutingCaches };
