// In-memory Redis mock for tests.
// Operations are internally consistent: hset/hget/hgetall use flat `key:field` storage,
// scan filters the store by glob pattern, lrange handles stop=-1.

function globToRegex(pattern) {
    let regexStr = '^';
    for (const ch of pattern) {
        if (ch === '*') regexStr += '.*';
        else if (ch === '?') regexStr += '.';
        else if ('[](){}+.^$|\\'.includes(ch)) regexStr += '\\' + ch;
        else regexStr += ch;
    }
    regexStr += '$';
    return new RegExp(regexStr);
}

function createMockRedis() {
    const store = new Map();
    // Recorded TTLs (seconds) so ttl() can report them. Keys are NOT
    // auto-expired — existing tests rely on keys persisting. Tests simulate
    // renewal / decay by calling set(...,'EX',n) or expire(key, n).
    const expiries = new Map();
    const recordExpiry = (key, args) => {
        const i = args.indexOf('EX');
        if (i !== -1 && args[i + 1] !== undefined) expiries.set(key, Number(args[i + 1]));
    };
    // WATCH/MULTI (Stage 129): per-key mutation counters, so a transaction
    // can abort exactly like Redis when a watched key changed. `versioned`
    // mirrors the real client's optimistic concurrency; the fallback of
    // queue-idempotency relies on it for its atomicity.
    const versions = new Map();
    const bump = (key) => versions.set(key, (versions.get(key) || 0) + 1);
    let watchState = null;
    let transactionState = null;
    const api = {
        hset: async (key, field, value) => {
            if (field && typeof field === 'object' && !Array.isArray(field)) {
                for (const [name, fieldValue] of Object.entries(field)) {
                    store.set(`${key}:${name}`, fieldValue);
                    bump(`${key}:${name}`);
                }
                return Object.keys(field).length;
            }
            store.set(`${key}:${field}`, value);
            bump(`${key}:${field}`);
            return 1;
        },
        hget: async (key, field) => store.get(`${key}:${field}`) || null,
        hgetall: async (key) => {
            const result = {};
            const prefix = key + ':';
            for (const [k, v] of store) {
                if (k.startsWith(prefix)) {
                    result[k.slice(prefix.length)] = v;
                }
            }
            return Object.keys(result).length > 0 ? result : null;
        },
        hdel: async (key, ...fields) => {
            let n = 0;
            for (const field of fields) {
                if (store.delete(`${key}:${field}`)) { n++; bump(`${key}:${field}`); }
            }
            return n;
        },
        hlen: async (key) => {
            const prefix = key + ':';
            let n = 0;
            for (const k of store.keys()) if (k.startsWith(prefix)) n++;
            return n;
        },
        hexists: async (key, field) => store.has(`${key}:${field}`) ? 1 : 0,
        get: async (key) => store.get(key) || null,
        set: async (key, value, ...args) => {
            const nx = args.includes('NX');
            if (nx && store.has(key)) return null;
            store.set(key, value);
            recordExpiry(key, args);
            bump(key);
            return 'OK';
        },
        del: async (...keys) => { let n = 0; for (const k of keys) { expiries.delete(k); if (store.delete(k)) { n++; bump(k); } } return n; },
        expire: async (key, ttl) => {
            if (!store.has(key)) return 0;
            expiries.set(key, Number(ttl));
            bump(key);
            return 1;
        },
        // Mirrors ioredis: -2 if key missing, -1 if no expiry, else seconds.
        ttl: async (key) => {
            if (!store.has(key)) return -2;
            return expiries.has(key) ? expiries.get(key) : -1;
        },
        incr: async (key) => { const v = (parseInt(store.get(key) || '0', 10)) + 1; store.set(key, String(v)); bump(key); return v; },
        incrby: async (key, increment) => { const v = (parseInt(store.get(key) || '0', 10)) + Number(increment || 0); store.set(key, String(v)); bump(key); return v; },
        decr: async (key) => { const v = Math.max(0, (parseInt(store.get(key) || '0', 10)) - 1); store.set(key, String(v)); bump(key); return v; },
        exists: async (key) => store.has(key) ? 1 : 0,
        scan: async (cursor, ...args) => {
            let pattern = null;
            for (let i = 0; i < args.length; i++) {
                if (args[i] === 'MATCH') pattern = args[i + 1];
            }
            if (!pattern) return ['0', []];
            const regex = globToRegex(pattern);
            const matched = [...store.keys()].filter(k => regex.test(k));
            return ['0', matched];
        },
        hscan: async (key, cursor, ...args) => {
            const prefix = key + ':';
            const entries = [];
            for (const [k, v] of store) {
                if (k.startsWith(prefix)) {
                    entries.push(k.slice(prefix.length), v);
                }
            }
            return ['0', entries];
        },
        eval: async (script, keysCount, ...args) => {
            // Stage 120 (F2): state-aware claim TTL refresh — the exact mirror
            // of queue-idempotency REFRESH_CLAIM_TTL_SCRIPT:
            //   missing key → 0 (never resurrect a released claim);
            //   'ambiguous' → -1 (the deliberately shortened 90-minute window
            //   is NEVER extended back to the 24 h backstop);
            //   otherwise  → SET XX EX ttl → 1.
            if (script.includes("if v == 'ambiguous' then return -1 end")) {
                const key = args[0];
                const ttl = Number(args[keysCount]);
                const value = store.get(key);
                if (value === undefined) return 0;
                if (value === 'ambiguous') return -1;
                expiries.set(key, ttl);
                return 1;
            }
            if (script.includes('local metadata') && script.includes("ARGV[5] == '1'")) {
                const [metadataKey, completedKey, leaseKey, quotaKey] = args.slice(0, keysCount);
                const [
                    expectedMetadata,
                    markerValue,
                    markerTtl,
                    expectedLease,
                    quotaOwned,
                ] = args.slice(keysCount);
                const metadata = store.get(metadataKey);
                if (metadata === undefined) return store.has(completedKey) ? 2 : 0;
                if (metadata !== expectedMetadata) return -1;
                const lease = store.get(leaseKey);
                if (lease !== undefined && (!expectedLease || lease !== expectedLease)) return -2;
                if (store.has(completedKey)) return 2;

                store.set(completedKey, markerValue);
                store.delete(metadataKey);
                expiries.delete(metadataKey);
                if (lease !== undefined && expectedLease) {
                    store.delete(leaseKey);
                    expiries.delete(leaseKey);
                }
                if (quotaOwned === '1') {
                    const current = Number(store.get(quotaKey) || 0);
                    if (current > 0) store.set(quotaKey, String(current - 1));
                }
                void markerTtl;
                return 1;
            }
            // Lease renewal (lease-manager.renewLeaseIfOwner): compare-and-EXPIRE.
            // KEYS=[leaseKey, metadataKey], ARGV=[expectedToken, ttl, now].
            if (script.includes('ttl_add') && script.includes('EXPIRE')) {
                const leaseKey = args[0];
                const metadataKey = args[1];
                const expected = args[keysCount];
                const ttlAdd = Number(args[keysCount + 1]);
                const now = args[keysCount + 2];
                const current = store.get(leaseKey);
                if (current === undefined) return ['false', 'no_lease'];
                if (current !== expected) return ['false', 'token_mismatch', current];
                expiries.set(leaseKey, ttlAdd);
                if (store.has(metadataKey)) expiries.set(metadataKey, ttlAdd);
                return ['true', 'renewed', String(now)];
            }
            if (script.includes("current ~= ARGV[1]") && script.includes("redis.call('DEL', KEYS[1])")) {
                const key = args[0];
                const expected = args[keysCount];
                const current = store.get(key);
                if (current === undefined) return 0;
                if (current !== expected) return -1;
                store.delete(key);
                expiries.delete(key);
                return 1;
            }
            if (script.includes("return redis.call('INCR', key)")) {
                const key = args[0];
                const max = Number(args[keysCount]);
                const current = Number(store.get(key) || 0);
                if (current >= max) return 0;
                const next = current + 1;
                store.set(key, String(next));
                return next;
            }
            // Stage 127/129 — ensureIntentAndReceipt (queue-idempotency):
            // KEYS=[intentKey, receiptKey],
            // ARGV=[fence, epoch, now, intentTtl, receiptTtl, historyMax]
            // An INDEPENDENT mirror of ENSURE_INTENT_RECEIPT_SCRIPT (there is
            // no Lua runtime in the test environment — a change to the script
            // must be mirrored here, which is exactly what the verdict matrix
            // in tests/gpu-intent-fence-regressions.test.js checks):
            //   'created' | 'reused' | 'receipt_conflict' | 'stale_intent'
            //   | 'intent_missing' | 'intent_not_active:<state>'
            //   | 'intent_corrupt' | 'invalid_fence'
            if (script.includes("'stale_intent'") && script.includes("'intent_missing'")) {
                const intentKey = args[0];
                const receiptKey = args[1];
                const stageKey = args[2];
                const [fenceRaw, epochStr, now, intentTtl, receiptTtl, historyMaxArg, stageTtlArg] = args.slice(keysCount);
                const fence = String(fenceRaw);
                const epoch = Number(epochStr) || 0;
                const historyMax = Number(historyMaxArg) || 8;
                const stageTtl = Number(stageTtlArg) || 2592000;
                // KEYS[3] is authoritative only while it exists (mirror of
                // the stageKnown rule in ENSURE_INTENT_RECEIPT_SCRIPT).
                const stageKnown = (!stageKey) ? true : store.has(stageKey);
                const touchStage = () => {
                    if (stageKey && stageKnown) { expiries.set(stageKey, stageTtl); bump(stageKey); }
                };
                const label = (value) => String(value).replace(/[^\w-]/g, '').slice(0, 40) || 'unknown';
                if (!/^[0-9a-f]+$/i.test(fence)) return 'invalid_fence';

                const receiptFence = store.get(receiptKey);
                const hasReceipt = receiptFence !== undefined;
                if (hasReceipt && String(receiptFence) !== fence) return 'receipt_conflict';

                const writeReceipt = () => {
                    if (hasReceipt) return;
                    store.set(receiptKey, fence);
                    expiries.set(receiptKey, Number(receiptTtl));
                    bump(receiptKey);
                };

                const intentRaw = store.get(intentKey);
                if (intentRaw === undefined) {
                    if (hasReceipt) return 'intent_missing';
                    store.set(intentKey, JSON.stringify({
                        fence, state: 'active', epoch: String(epochStr), supersedes: null,
                        updated_at: Number(now) || 0, history: [],
                    }));
                    expiries.set(intentKey, Number(intentTtl));
                    bump(intentKey);
                    touchStage();
                    writeReceipt();
                    return 'created';
                }

                let intent = null;
                try { intent = JSON.parse(intentRaw); } catch (_) { return 'intent_corrupt'; }
                if (!intent || typeof intent !== 'object') return 'intent_corrupt';
                if (intent.fence == null) return 'intent_corrupt';
                const storedFence = String(intent.fence);
                if (!/^[0-9a-f]+$/i.test(storedFence)) return 'intent_corrupt';

                const state = intent.state == null ? 'active' : String(intent.state);
                const storedEpochNum = Number(intent.epoch);
                const storedEpoch = Number.isFinite(storedEpochNum) ? storedEpochNum : null;
                const history = Array.isArray(intent.history)
                    ? intent.history.filter((entry) => Array.isArray(entry) && entry[0] != null && /^[0-9a-f]+$/i.test(String(entry[0])))
                        .map((entry) => [String(entry[0]), Number(entry[1]) || 0])
                    : [];
                const wasSuperseded = history.some(([f]) => f === fence)
                    || String(intent.supersedes == null ? '' : intent.supersedes) === fence;

                if (storedFence === fence) {
                    if (state !== 'active') return `intent_not_active:${label(state)}`;
                    expiries.set(intentKey, Number(intentTtl));
                    bump(intentKey);
                    touchStage();
                    writeReceipt();
                    return hasReceipt ? 'reused' : 'created';
                }

                if (wasSuperseded) return 'stale_intent';
                if (stageKnown && storedEpoch !== null && epoch < storedEpoch) return 'stale_intent';
                if (state !== 'active' && stageKnown && (storedEpoch === null || epoch <= storedEpoch)) {
                    return `intent_not_active:${label(state)}`;
                }

                const nextHistory = history
                    .concat([[storedFence, storedEpoch === null ? 0 : storedEpoch]])
                    .slice(-historyMax);
                store.set(intentKey, JSON.stringify({
                    fence, state: 'active', epoch: String(epochStr), supersedes: storedFence,
                    updated_at: Number(now) || 0, history: nextHistory,
                }));
                expiries.set(intentKey, Number(intentTtl));
                bump(intentKey);
                touchStage();
                writeReceipt();
                return hasReceipt ? 'reused' : 'created';
            }
            // Return array mimicking Lua return: {true, 'corrected', old, new}
            // Callers (e.g. correctCounterWithLua) destructure result[0]..result[3]
            const key = args[0];
            const target = args[keysCount] || args[1];
            let current = store.get(key);
            if (current === undefined) current = null;
            store.set(key, target);
            return ['true', 'corrected', current, target];
        },
        rpush: async (key, ...values) => { const arr = store.get(key) || []; arr.push(...values); store.set(key, arr); return arr.length; },
        lpush: async (key, ...values) => { const arr = store.get(key) || []; arr.unshift(...values); store.set(key, arr); return arr.length; },
        rpoplpush: async (source, destination) => {
            const arr = store.get(source);
            if (!arr || arr.length === 0) return null;
            const value = arr.pop();
            if (arr.length === 0) store.delete(source);
            const dest = store.get(destination) || [];
            dest.unshift(value);
            store.set(destination, dest);
            return value;
        },
        llen: async (key) => { const arr = store.get(key); return arr ? arr.length : 0; },
        lrange: async (key, start, stop) => {
            const arr = store.get(key) || [];
            if (stop === -1 || stop === undefined) return arr.slice(start);
            return arr.slice(start, stop + 1);
        },
        lrem: async (key, count, value) => {
            const arr = store.get(key) || [];
            const index = arr.indexOf(value);
            if (index === -1) return 0;
            arr.splice(index, 1);
            return 1;
        },
        sadd: async (key, member) => { const s = store.get(key) || new Set(); s.add(member); store.set(key, s); return 1; },
        srem: async (key, member) => { const s = store.get(key); if (s) { s.delete(member); return 1; } return 0; },
        smembers: async (key) => { const s = store.get(key); return s ? [...s] : []; },
        scard: async (key) => { const s = store.get(key); return s ? s.size : 0; },
        zrem: async (key, member) => {
            const s = store.get(key);
            if (s && s instanceof Set) { return s.delete(member) ? 1 : 0; }
            return 0;
        },
        // ── WATCH / MULTI (Stage 129) ────────────────────────────────────
        // Real optimistic concurrency: `watch` snapshots the mutation
        // counters of the given keys, `exec` returns null (like Redis) when
        // any of them changed, and otherwise applies the queued commands. A
        // client whose MULTI silently does nothing would be caught by the
        // `replies.length === queued` check in queue-idempotency.
        watch: async (...keys) => {
            watchState = new Map(keys.map((k) => [k, versions.get(k) || 0]));
            return 'OK';
        },
        unwatch: async () => { watchState = null; return 'OK'; },
        multi: () => {
            const queue = [];
            const builder = {
                set: (key, value, ...rest) => { queue.push(() => api.set(key, value, ...rest)); return builder; },
                del: (...keys) => { queue.push(() => api.del(...keys)); return builder; },
                expire: (key, ttl) => { queue.push(() => api.expire(key, ttl)); return builder; },
                exec: async () => {
                    if (transactionState) return null; // nested MULTI is a client bug
                    transactionState = queue;
                    try {
                        if (watchState) {
                            for (const [key, version] of watchState) {
                                if ((versions.get(key) || 0) !== version) return null;
                            }
                        }
                        const out = [];
                        for (const command of queue) out.push(await command());
                        return out;
                    } finally {
                        watchState = null;
                        transactionState = null;
                    }
                },
            };
            return builder;
        },
        // Stage 129: this double explicitly opts into the non-Lua fallback of
        // ensureIntentAndReceipt (there is no Lua runtime here). A real
        // client never carries this flag — it fails closed instead.
        __allowNonLuaFallback: true,
        quit: async () => 'OK',
        disconnect: () => {},
        duplicate: () => createMockRedis(),
    };
    return api;
}

module.exports = { createMockRedis };
