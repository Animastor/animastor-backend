'use strict';
// ============================================================
// no-store for polling / restore endpoints (О1)
// ============================================================
// reports/2026-11-07/orch-v2-image-scene-run.md О1: a mobile browser kept
// answering GET /book/:id/progress-panel from its HTTP cache (a 3-minute-old
// `status: active` 0/1 snapshot) although the command had finished; the
// responses carried only a weak ETag and no Cache-Control. Live state must
// never be cached or revalidated:
//   - `Cache-Control: no-store` (+ `Pragma: no-cache` for old proxies);
//   - no ETag, so no conditional request can be answered with 304.
// One middleware for all polling paths instead of per-route headers. Paths
// are relative to /api/v1 (same list as the web client `isNoStorePath`,
// animastor-web frontends/app/src/api/client.ts, and Android PollRequests.kt).

const NO_STORE_PATHS = [
    // /book/:id/{progress-panel,progress-stream,assets-state,status,agent-status,layer-config,generation*}
    /^\/book\/[^/]+\/(?:progress-panel|progress-stream|assets-state|status|agent-status|layer-config|generation[^/]*)(?:\/|$)/,
    // /scene/:book/:chapter/:scene/status
    /^\/scene\/[^/]+\/[^/]+\/[^/]+\/status(?:\/|$)/,
    /^\/worker\/counts(?:\/|$)/,
    // v2 generation API (/generate/*), present and future
    /^\/generate(?:\/|$)/,
];

/** `true` when `path` (relative to /api/v1, without query) is a polling path. */
function isNoStorePath(path) {
    if (typeof path !== 'string') return false;
    return NO_STORE_PATHS.some((re) => re.test(path));
}

/**
 * Express middleware, mount at '/api/v1'. For GET/HEAD of a polling path:
 * sets Cache-Control: no-store and suppresses the ETag that res.send would
 * add (no ETag → req.fresh is false → never 304).
 */
function noStoreForPolling(req, res, next) {
    if ((req.method === 'GET' || req.method === 'HEAD') && isNoStorePath(req.path)) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        const setHeader = res.setHeader;
        res.setHeader = function setHeaderNoEtag(name, value) {
            if (typeof name === 'string') {
                const n = name.toLowerCase();
                if (n === 'etag' || n === 'last-modified') return this;
                // a route that sets its own Cache-Control (e.g. SSE 'no-cache')
                // is tightened to no-store
                if (n === 'cache-control') return setHeader.call(this, name, 'no-store');
            }
            return setHeader.call(this, name, value);
        };
    }
    next();
}

module.exports = { isNoStorePath, noStoreForPolling, NO_STORE_PATHS };
