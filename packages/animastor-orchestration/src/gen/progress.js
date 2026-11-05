// ======================================================
// gen/progress — SQL aggregate over gen_jobs (ADR §9 «Прогресс») + LISTEN
// ======================================================
// The panel shows table rows, nothing else: per active command of the book,
// per layer and per scene — queued / running / done / failed / cancelled.
// Units a command «joined» (live under another command, §6.1 п.4) are
// counted separately as joined_queued / joined_running.

'use strict';

const { requireText, JOB_LAYER_SQL, IN_SCOPE_SQL, PROGRESS_CHANNEL } = require('./util');

const STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'];
const zero = () => ({ queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, joined_queued: 0, joined_running: 0 });

function createProgress({ pool }) {
    /** @returns {Promise<{book_id:string, totals:object, commands:object[]}>} */
    async function progress(bookId) {
        requireText(bookId, 'bookId');
        const cmds = (await pool.query(
            `SELECT command_id, kind, scope, layers, force, status, created_at, user_id
             FROM gen_commands WHERE book_id = $1 AND status = 'active' ORDER BY created_at`, [bookId])).rows;
        const ids = cmds.map((c) => c.command_id);
        const own = ids.length ? (await pool.query(
            `SELECT j.command_id, ${JOB_LAYER_SQL('j')} AS layer, j.chapter_id, j.scene_id, j.status, count(*)::int AS n
             FROM gen_jobs j WHERE j.command_id = ANY($1::uuid[])
             GROUP BY 1, 2, 3, 4, 5`, [ids])).rows : [];
        const joined = ids.length ? (await pool.query(
            `SELECT c.command_id, ${JOB_LAYER_SQL('j')} AS layer, j.chapter_id, j.scene_id, j.status, count(*)::int AS n
             FROM gen_commands c
             JOIN gen_jobs j ON j.command_id <> c.command_id AND j.status IN ('queued','running') AND ${IN_SCOPE_SQL('j', 'c')}
             WHERE c.command_id = ANY($1::uuid[])
             GROUP BY 1, 2, 3, 4, 5`, [ids])).rows : [];

        const byCmd = new Map(cmds.map((c) => [c.command_id, {
            command_id: c.command_id, kind: c.kind, scope: c.scope, layers: c.layers, force: c.force,
            status: c.status, user_id: c.user_id, created_at: c.created_at,
            totals: zero(), by_layer: {}, scenes: new Map(),
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
        for (const r of own) if (STATUSES.includes(r.status)) add(r, r.status);
        for (const r of joined) add(r, r.status === 'queued' ? 'joined_queued' : 'joined_running');

        const totals = zero();
        const commands = [...byCmd.values()].map((c) => {
            for (const k of Object.keys(totals)) totals[k] += c.totals[k];
            return { ...c, scenes: [...c.scenes.values()] };
        });
        return { book_id: bookId, totals, commands };
    }

    /**
     * LISTEN gen_progress on a dedicated pooled client.
     * @param {(evt:{book_id:string, command_id:string|null})=>void} onEvent
     * @returns {Promise<{close:()=>Promise<void>}>}
     */
    async function listenProgress(onEvent) {
        const client = await pool.connect();
        const handler = (msg) => {
            if (msg.channel !== PROGRESS_CHANNEL) return;
            try { onEvent(JSON.parse(msg.payload)); } catch (_) { /* malformed payload / handler error */ }
        };
        client.on('notification', handler);
        await client.query(`LISTEN ${PROGRESS_CHANNEL}`);
        return {
            async close() {
                client.removeListener('notification', handler);
                try { await client.query(`UNLISTEN ${PROGRESS_CHANNEL}`); } finally { client.release(); }
            },
        };
    }

    return { progress, listenProgress };
}

module.exports = { createProgress };
