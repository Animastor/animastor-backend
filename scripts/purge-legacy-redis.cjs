#!/usr/bin/env node
// ======================================================
// scripts/purge-legacy-redis.cjs — remove the Redis key families of the
// legacy orchestration (ORCHESTRATION_V2 §12 этап 4, шаг 7)
// ======================================================
// Dry-run by default: SCAN-counts every animastor:* family (key NAMES only — values are
// never read) and prints what --apply would delete and what is kept.
//
//   node scripts/purge-legacy-redis.cjs                       # dry-run
//   node scripts/purge-legacy-redis.cjs --apply --confirm=<host:port/db>
//   node scripts/purge-legacy-redis.cjs --include-hub-v2 …    # + hub protocol-2 transport
//
// Connection: the backend's own variables (config/infra-env.js):
// REDIS_HOST, REDIS_PORT, REDIS_PASSWORD (optional), REDIS_DB (optional).
// --apply refuses to run unless --confirm names exactly the target
// (host:port/db) — a mistyped environment never deletes anything.
//
// Deleted: only the families listed in PURGE below (an allow-list). A key
// of any other family is never touched — it is reported as "other (kept)".
// Kept on purpose (live readers after the legacy removal) — KEEP below.
//
// Docs: animastor-docs architecture/ORCHESTRATION_V2.md §4.3;
//       reports/2026-11-26/legacy-removal-recon.md §3.1.

'use strict';

const path = require('path');

/** families of the legacy orchestration — no writer and no reader remains */
const PURGE = Object.freeze([
    // scheduler / dispatch / lease (legacy package runtime)
    'animastor:active-scenes',
    'animastor:runtime:*',
    'animastor:dispatch-lease:*',
    'animastor:dispatch-meta:*',
    'animastor:dispatch-completed',
    'animastor:dispatch-completed:*',
    'animastor:dispatch-noprogress:*',
    'animastor:dispatch-intent:*',
    'animastor:dispatch:*',
    'animastor:lease-heartbeat:*',
    'animastor:lease:*',
    'animastor:retry-budget:*',
    'animastor:circuit:*',
    'animastor:fairness:*',
    'animastor:priority:queue',
    'animastor:retry:*',
    'animastor:drift:*',
    'animastor:failure:*',
    // command gate / cancel / progress registry
    'animastor:generation:cancel',
    'animastor:generation:cancel:*',
    'animastor:force-dispatch:*',
    'animastor:force-dispatch-stages:*',
    'animastor:generation-progress:*',
    'animastor:gen-scope:*',
    'animastor:regenerate-lock',
    'animastor:regenerate-lock:*',
    'animastor:gpu-retry:*',
    // asset FSM / stage state
    'animastor:asset-state:*',
    'animastor:assets:*',
    'animastor:asset:*',
    'animastor:audio-orch:*',
    'animastor:video-orch:*',
    'animastor:scene-state:*',
    'animastor:scene:*',
    'animastor:scene-heartbeat:*',
    'animastor:event-journal:*',
    'animastor:scene-audio-status:*',
    'animastor:scene-video:*',
    // stage locks (video-book-merge-lock is NOT here: the export uses it)
    'animastor:audio-merge-lock:*',
    'animastor:video-merge-lock:*',
    'animastor:video-dedup:*',
    'animastor:scene-lock:*',
    'animastor:audio-scene-lock:*',
    'animastor:audio-scene-failsafe:*',
    'animastor:video-lock:*',
    'animastor:scene-transition-lock:*',
    'animastor:cleanup-lock',
    // IU dispatch (iu-processor)
    'animastor:iu-in-flight',
    'animastor:iu-in-flight:*',
    'animastor:iu-in-flight-index:*',
    'animastor:iu-registry:*',
    'animastor:iu-progress:*',
    'animastor:iu-progress-ids:*',
    'animastor:iu:*',
    // result delivery of protocol 2 (backend side)
    'animastor:result-processed:*',
    'animastor:error-processed:*',
    // queue idempotency / intent fence (helpers/queue-idempotency)
    'animastor:idempotency:*',
    'animastor:intent:*',
    'animastor:intent-lock:*',
    'animastor:artifact-manifest:*',
    'animastor:fence-journal:*',
    'animastor:fence-publish:*',
    'animastor:fence-unrecoverable:*',
    // layer config moved to PG (book_layer_config, 2026-11-27)
    'animastor:layer-config:*',
    // writer-less leftovers of older stages (recon §3.1, last rows)
    'animastor:mode:*',
    'animastor:snapshot:*',
    'animastor:scope:*',
    'animastor:layer:*',
    'animastor:event:*',
    'animastor:book:*',
    'animastor:gen:*',
    'animastor:vbook:*',            // (animastor:vbook-scene-idx:* is live — a different prefix)
]);

/** hub protocol-2 transport — removed in hub v0.4.0; only with --include-hub-v2 */
const PURGE_HUB_V2 = Object.freeze([
    'animastor:queue:*',
    'animastor:processing',
    'animastor:processing-claimed',
    'animastor:running',
    'animastor:dead-letter',
    'animastor:job:*',
    'animastor:result:*',
    'animastor:error:*',
    'animastor:stale-dispatch-signal:*',
]);

/** kept: live readers / writers remain (reported, never deleted) */
const KEEP = Object.freeze([
    ['animastor:worker-auth', 'worker credentials mirror (hub /v3, backend)'],
    ['animastor:worker:heartbeat:*', 'hub /v3/beacon → GET /worker/counts'],
    ['animastor:gpu-hub:workers', 'hub worker registry'],
    ['animastor:ai-connector:hb:*', 'Local AI Connector heartbeats'],
    ['animastor:prompt-profiles', 'prompt profiles'],
    ['animastor:pending-purge', 'entity-cleanup retry markers'],
    ['animastor:pending-purge-attempts:*', 'entity-cleanup retry counters'],
    ['animastor:bootstrap-lock:*', 'VBook bootstrap lock (until task H)'],
    ['animastor:progress:*', 'VBook pub/sub channel (no keys normally)'],
    ['animastor:cancelled-workers:*', 'VBook cancel signal: bootstrap, pipeline-runner, import windows read it (until task H)'],
    ['animastor:chunk:*', 'text chunk records: import writes, player reads'],
    ['animastor:chunks:*', 'chunk index of a book: import writes, player reads'],
    ['animastor:book-scenes:*', 'window counters: import writes, player / editor read'],
    ['animastor:video-book-merge-lock:*', 'export (video-merge) lock'],
]);

function globToRegExp(glob) {
    return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

/** first family (in list order) whose glob matches the key, else null */
function familyOf(key, families) {
    for (const f of families) if (globToRegExp(f).test(key)) return f;
    return null;
}

function parseArgs(argv) {
    const out = { apply: false, confirm: null, includeHubV2: false, help: false };
    for (const a of argv) {
        if (a === '--apply') out.apply = true;
        else if (a === '--include-hub-v2') out.includeHubV2 = true;
        else if (a.startsWith('--confirm=')) out.confirm = a.slice('--confirm='.length);
        else if (a === '-h' || a === '--help') out.help = true;
        else throw new Error(`unknown argument: ${a}`);
    }
    return out;
}

/**
 * Scan the whole keyspace once (key names only) and classify every key.
 * KEEP wins over PURGE (a kept family is never deleted, even if a purge
 * glob would also match it).
 */
async function classify(redis, { includeHubV2 = false } = {}) {
    const purge = includeHubV2 ? [...PURGE, ...PURGE_HUB_V2] : [...PURGE];
    const keepGlobs = KEEP.map(([g]) => g);
    const counts = { purge: new Map(), keep: new Map(), other: new Map() };
    const toDelete = [];
    let cursor = '0';
    let total = 0;
    do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', 'animastor:*', 'COUNT', 1000);
        cursor = next;
        for (const key of keys) {
            total += 1;
            const kept = familyOf(key, keepGlobs);
            if (kept) { counts.keep.set(kept, (counts.keep.get(kept) || 0) + 1); continue; }
            const fam = familyOf(key, purge);
            if (fam) { counts.purge.set(fam, (counts.purge.get(fam) || 0) + 1); toDelete.push(key); continue; }
            const prefix = key.split(':').slice(0, 2).join(':');
            counts.other.set(prefix, (counts.other.get(prefix) || 0) + 1);
        }
    } while (cursor !== '0');
    return { total, counts, toDelete };
}

async function purgeKeys(redis, keys, batch = 500) {
    let deleted = 0;
    for (let i = 0; i < keys.length; i += batch) {
        const chunk = keys.slice(i, i + batch);
        // UNLINK (non-blocking) when the server / client has it, DEL otherwise
        deleted += typeof redis.unlink === 'function' ? await redis.unlink(...chunk) : await redis.del(...chunk);
    }
    return deleted;
}

function report(target, r, { apply, includeHubV2 }) {
    const lines = [];
    lines.push(`[purge-legacy-redis] target ${target} — ${apply ? 'APPLY' : 'dry-run'}${includeHubV2 ? ' (+hub protocol 2)' : ''}`);
    lines.push(`[purge-legacy-redis] keys scanned: ${r.total}`);
    lines.push(`[purge-legacy-redis] to delete: ${r.toDelete.length}`);
    for (const [f, n] of [...r.counts.purge].sort()) lines.push(`  delete ${f}: ${n}`);
    lines.push('[purge-legacy-redis] kept (live readers):');
    for (const [g, why] of KEEP) lines.push(`  keep   ${g}: ${r.counts.keep.get(g) || 0} — ${why}`);
    if (r.counts.other.size) {
        lines.push('[purge-legacy-redis] other families (not in either list, kept):');
        for (const [p, n] of [...r.counts.other].sort()) lines.push(`  other  ${p}:*: ${n}`);
    }
    return lines.join('\n');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log('usage: purge-legacy-redis.cjs [--apply --confirm=<host:port/db>] [--include-hub-v2]');
        return 0;
    }
    const infraEnv = require(path.join(__dirname, '..', 'backend', 'src', 'config', 'infra-env'));
    infraEnv.assertInfraEnv();
    const opts = infraEnv.redisOptions();
    const db = Number(process.env.REDIS_DB || opts.db || 0);
    const target = `${opts.host}:${opts.port}/${db}`;
    if (args.apply && args.confirm !== target) {
        console.error(`[purge-legacy-redis] --apply needs --confirm=${target} (got ${args.confirm === null ? 'nothing' : JSON.stringify(args.confirm)}) — nothing deleted`);
        return 2;
    }
    const Redis = require(require.resolve('ioredis', { paths: [path.join(__dirname, '..', 'backend')] }));
    const redis = new Redis({ ...opts, db, lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
        await redis.connect();
        const r = await classify(redis, args);
        console.log(report(target, r, args));
        if (args.apply) {
            const n = await purgeKeys(redis, r.toDelete);
            console.log(`[purge-legacy-redis] deleted: ${n}`);
        } else {
            console.log('[purge-legacy-redis] dry-run: nothing deleted (use --apply --confirm=<target>)');
        }
        return 0;
    } finally {
        redis.disconnect();
    }
}

module.exports = { PURGE, PURGE_HUB_V2, KEEP, familyOf, classify, purgeKeys, parseArgs };

if (require.main === module) {
    main().then((code) => process.exit(code), (err) => {
        console.error(`[purge-legacy-redis] ERROR: ${err.message}`);
        process.exit(1);
    });
}
