// ======================================================
// Prometheus Metrics — O2
// ======================================================
// GET /metrics serves the in-memory registry (process / Node.js default
// metrics). No Redis calls.
//
// 2026-11-28 (ORCHESTRATION_V2 §12 этап 4, шаг 7): the legacy runtime gauges
// and counters — active scenes, active leases, quota usage / max /
// utilisation, lease age, dispatch counters, intent fence and fenced commit
// counters — are removed together with the legacy scheduler / dispatch /
// lease / fence code that fed them (collect() ran on the legacy runtime loop
// tick). Orchestration v2 state lives in PG (gen_commands / gen_jobs).

const client = require('prom-client');

// ======================================================
// REGISTRY
// ======================================================

const register = new client.Registry();
client.collectDefaultMetrics({ register });

// ======================================================
// METRICS EXPOSURE
// ======================================================

/** Prometheus-format metrics string. */
async function getMetricsContent() {
    return register.metrics();
}

/** Content-type header for Prometheus. */
function getContentType() {
    return register.contentType;
}

module.exports = {
    register,
    getMetricsContent,
    getContentType,
};
