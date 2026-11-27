// ======================================================
// gen/progress — SQL aggregate over gen_jobs (ADR §9 «Прогресс») + LISTEN
// ======================================================
// The panel shows table rows, nothing else: per active command of the book,
// per layer and per scene — queued / running / done / failed / cancelled.
// Only gen_command_jobs ⨝ gen_jobs (ADR §4.2a, §9). Jobs another command
// created and this one joined are additionally reported as joined_queued /
// joined_running (they are already inside the per-status totals).

'use strict';

const { requireText, PROGRESS_CHANNEL } = require('./util');

/** Pause before each re-LISTEN attempt after a lost connection (1.4.3): 1 → 2 → 5 → 10 → 30 s, then 30 s. */
const DEFAULT_RELISTEN_DELAYS_MS = Object.freeze([1000, 2000, 5000, 10000, 30000]);

const STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'];
const zero = () => ({ queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, joined_queued: 0, joined_running: 0, retrying: 0 });

function createProgress({ pool }) {
    /** @returns {Promise<{book_id:string, totals:object, commands:object[]}>} */
    /**
     * @param {string} bookId
     * @param {{finishedWithinMs?:number}} [opts] also return commands finished within this window
     *        (a panel shows the final 100% / failed row before it disappears)
     */
    async function progress(bookId, opts = {}) {
        requireText(bookId, 'bookId');
        const within = Number(opts.finishedWithinMs) > 0 ? Number(opts.finishedWithinMs) : 0;
        const cmds = (await pool.query(
            `SELECT command_id, kind, scope, layers, force, status, created_at, finished_at, error, summary, user_id
             FROM gen_commands
             WHERE book_id = $1 AND (status = 'active'
                   OR ($2::numeric > 0 AND finished_at > now() - make_interval(secs => $2::numeric / 1000)))
             ORDER BY created_at`, [bookId, within])).rows;
        const ids = cmds.map((c) => c.command_id);
        const rows = ids.length ? (await pool.query(
            `SELECT l.command_id, j.layer, j.chapter_id, j.scene_id, j.status,
                    (j.command_id <> l.command_id) AS foreign, count(*)::int AS n,
                    count(*) FILTER (WHERE j.status = 'queued' AND j.attempt > 0)::int AS retrying,
                    count(*) FILTER (WHERE j.kind IN ('audio_merge','video_merge'))::int AS merges
             FROM gen_command_jobs l JOIN gen_jobs j ON j.job_id = l.job_id
             WHERE l.command_id = ANY($1::uuid[])
             GROUP BY 1, 2, 3, 4, 5, 6`, [ids])).rows : [];

        // 1.3.0 — why the command made no work for a scene (§6.5, §13 п.11 п.9): {reason: [scene_id…]}
        const skipRows = ids.length ? (await pool.query(
            `SELECT command_id, reason, scene_id FROM gen_command_skips WHERE command_id = ANY($1::uuid[])
             ORDER BY created_at, chapter_id, scene_id`, [ids])).rows : [];
        const skippedOf = new Map();
        for (const r of skipRows) {
            if (!skippedOf.has(r.command_id)) skippedOf.set(r.command_id, {});
            const m = skippedOf.get(r.command_id);
            if (!m[r.reason]) m[r.reason] = [];
            if (!m[r.reason].includes(r.scene_id)) m[r.reason].push(r.scene_id);
        }

        const byCmd = new Map(cmds.map((c) => [c.command_id, {
            command_id: c.command_id, kind: c.kind, scope: c.scope, layers: c.layers, force: c.force,
            status: c.status, user_id: c.user_id, created_at: c.created_at, finished_at: c.finished_at,
            error: c.error, summary: c.summary, skipped: skippedOf.get(c.command_id) || {},
            totals: zero(), by_layer: {}, merges: {}, scenes: new Map(),
        }]));
        const add = (row, field) => {
            const c = byCmd.get(row.command_id);
            if (!c) return;
            c.totals[field] += row.n;
            if (!c.by_layer[row.layer]) c.by_layer[row.layer] = zero();
            c.by_layer[row.layer][field] += row.n;
            const sk = `${row.chapter_id}\u0000${row.scene_id}\u0000${row.layer}`;
            if (!c.scenes.has(sk)) c.scenes.set(sk, { chapter_id: row.chapter_id, scene_id: row.scene_id, layer: row.layer, ...zero() });
            c.scenes.get(sk)[field] += row.n;
        };
        for (const r of rows) {
            if (STATUSES.includes(r.status)) add(r, r.status);
            if (r.retrying) add({ ...r, n: r.retrying }, 'retrying');
            if (r.merges) { const c = byCmd.get(r.command_id); if (c) c.merges[r.layer] = (c.merges[r.layer] || 0) + r.merges; }
            if (r.foreign && r.status === 'queued') add(r, 'joined_queued');
            if (r.foreign && r.status === 'running') add(r, 'joined_running');
        }

        const totals = zero();
        const commands = [...byCmd.values()].map((c) => {
            for (const k of Object.keys(totals)) totals[k] += c.totals[k];
            return { ...c, scenes: [...c.scenes.values()] };
        });
        return { book_id: bookId, totals, commands };
    }

    /**
     * LISTEN gen_progress on a dedicated pooled client that survives a lost
     * connection (1.4.3, ADR §9 «Доставка»):
     *  - the client carries an 'error' handler — a dropped connection never
     *    becomes an unhandled 'error' event (process crash);
     *  - on 'error' / 'end' the client is released WITH the error (the pool
     *    destroys it) and a new one is taken after a growing pause
     *    (opts.delaysMs, default 1 → 2 → 5 → 10 → 30 s, then 30 s), LISTEN again;
     *  - after a successful re-LISTEN opts.onReconnect() runs: NOTIFYs sent
     *    while the connection was down are lost, so the host re-reads state;
     *  - opts.onDisconnect(err) runs once per lost live connection (not per
     *    failed reconnect attempt);
     *  - close() stops the reconnect loop (also during a pause) and releases
     *    the current client.
     * The FIRST connect still throws to the caller (as before 1.4.3).
     * @param {(evt:{book_id:string, command_id:string|null})=>void} onEvent
     * @param {{onReconnect?:()=>void, onDisconnect?:(err:Error)=>void, delaysMs?:number[]}} [opts]
     * @returns {Promise<{close:()=>Promise<void>, connected:()=>boolean, pid:()=>number|null}>}
     */
    async function listenProgress(onEvent, opts = {}) {
        const delays = Array.isArray(opts.delaysMs) && opts.delaysMs.length ? opts.delaysMs : DEFAULT_RELISTEN_DELAYS_MS;
        const call = (fn, ...a) => { if (typeof fn === 'function') { try { fn(...a); } catch (_) { /* host callback */ } } };
        let live = null;          // {c, done, detach} of the listening connection
        let closed = false;
        let timer = null;
        let attempt = 0;
        const handler = (msg) => {
            if (msg.channel !== PROGRESS_CHANNEL) return;
            try { onEvent(JSON.parse(msg.payload)); } catch (_) { /* malformed payload / handler error */ }
        };

        function schedule() {
            if (closed || timer) return;
            const wait = delays[Math.min(attempt, delays.length - 1)];
            attempt += 1;
            timer = setTimeout(async () => {
                timer = null;
                if (closed) return;
                let ok = false;
                try { ok = await connectOnce(); } catch (_) { ok = false; }
                if (closed) return;
                if (ok) { attempt = 0; call(opts.onReconnect); } else schedule();
            }, wait);
            if (typeof timer.unref === 'function') timer.unref();
        }

        /**
         * One checkout of a pool client. State lives HERE, never on the client:
         * a healthy client goes back to the pool and is reused by others.
         */
        function acquire(c) {
            const a = { c, done: false };
            const onError = (err) => lost(a, err);
            const onEnd = () => lost(a, new Error('gen_progress listener connection ended'));
            c.on('error', onError);
            c.on('end', onEnd);
            c.on('notification', handler);
            /** healthy return to the pool: no listener of ours stays on a reusable client */
            a.detach = () => {
                c.removeListener('notification', handler);
                c.removeListener('end', onEnd);
                c.removeListener('error', onError);
            };
            /** broken: only the notification handler goes; the error handler stays
             *  (a destroyed socket may still emit 'error' — never unhandled) */
            a.detachBroken = () => { c.removeListener('notification', handler); };
            return a;
        }

        /** The connection broke: release it WITH the error (the pool destroys it). Once per checkout. */
        function lost(a, err, { reconnect = true } = {}) {
            if (a.done) return;
            a.done = true;
            a.detachBroken();
            const wasLive = live === a;
            if (wasLive) live = null;
            try { a.c.release(err instanceof Error ? err : new Error('gen_progress listener lost')); } catch (_) { /* already released */ }
            if (wasLive && !closed) call(opts.onDisconnect, err);
            if (reconnect && !closed) schedule();
        }

        /** @returns {Promise<boolean>} true: listening; throws on connect / LISTEN error. */
        async function connectOnce() {
            const a = acquire(await pool.connect());
            try {
                await a.c.query(`LISTEN ${PROGRESS_CHANNEL}`);
            } catch (err) {
                lost(a, err, { reconnect: false });
                throw err;
            }
            if (a.done) return false;                 // broke between LISTEN and here (lost() rescheduled)
            if (closed) {                             // close() came while connecting
                a.done = true;
                let err;
                try { await a.c.query(`UNLISTEN ${PROGRESS_CHANNEL}`); } catch (e) { err = e; }
                if (err) a.detachBroken(); else a.detach();
                try { a.c.release(err); } catch (_) { /* already released */ }
                return false;
            }
            live = a;
            return true;
        }

        await connectOnce();
        return {
            async close() {
                closed = true;
                if (timer) { clearTimeout(timer); timer = null; }
                const a = live;
                live = null;
                if (!a || a.done) return;
                a.done = true;
                let err;
                try { await a.c.query(`UNLISTEN ${PROGRESS_CHANNEL}`); } catch (e) { err = e; }
                // a broken connection goes back with its error — the pool destroys it, never reuses it
                if (err) a.detachBroken(); else a.detach();
                try { a.c.release(err); } catch (_) { /* already released */ }
            },
            connected: () => live !== null,
            /** backend pid of the listening connection (diagnostics / tests), null while reconnecting. */
            pid: () => (live && live.c.processID) || null,
        };
    }

    return { progress, listenProgress };
}

module.exports = { createProgress, DEFAULT_RELISTEN_DELAYS_MS };
