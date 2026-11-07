// ======================================================
// gen/commands — create / cancel a user command (ADR §6.1, §6.2, §6.4, §4.2a)
// ======================================================
// I1: gen_jobs rows are created ONLY here (first stage) and by stage
// transitions inside acceptance (§6.3). Nothing else inserts work.
// I7: every statement is filtered by book / command; there is no
// "cancel everything" operation.
// §4.2a: gen_command_jobs records every job a command waits for — the jobs it
// created AND the live jobs it joined. Progress / completion read only it.

'use strict';

const NOOP_LOG = Object.freeze({ event() {} });

const {
    GenError, withTx, requireUuid, requireText, isUuid, notifyProgress, linkJobs,
    EXECUTOR_OF_KIND, LAYER_OF_KIND, FIRST_STAGE_KINDS, LAYERS,
} = require('./util');
const { checkLane } = require('./ports');

const COMMAND_KINDS = Object.freeze(['regenerate', 'generate_all']);
const SCOPE_LEVELS = Object.freeze(['book', 'chapter', 'scenes', 'scene', 'unit']);
const MAX_SCOPE_SCENES = 10_000;

function normaliseScope(scope) {
    const s = scope && typeof scope === 'object' ? scope : null;
    if (!s || !SCOPE_LEVELS.includes(s.level)) throw new GenError('bad_request', 400, 'scope.level must be book|chapter|scenes|scene|unit');
    const out = { level: s.level };
    const opt = (k) => { if (s[k] !== undefined && s[k] !== null) out[k] = requireText(s[k], `scope.${k}`); };
    opt('chapter_id'); opt('scene_id'); opt('unit_id');
    if (s.level === 'chapter' && !out.chapter_id) throw new GenError('bad_request', 400, 'scope.chapter_id required for level=chapter');
    if ((s.level === 'scene' || s.level === 'unit') && !out.scene_id) throw new GenError('bad_request', 400, `scope.scene_id required for level=${s.level}`);
    if (s.level === 'unit' && !out.unit_id) throw new GenError('bad_request', 400, 'scope.unit_id required for level=unit');
    if (s.level === 'scenes') {
        // ADR §11.1: an explicit, ordered list of scenes (e.g. «from the current
        // scene to the end», expanded by the host in book order). Order kept,
        // duplicates dropped; chapter_id / scene_id do not apply.
        if (!Array.isArray(s.scene_ids) || s.scene_ids.length === 0) throw new GenError('bad_request', 400, 'scope.scene_ids (non-empty array) required for level=scenes');
        if (s.scene_ids.length > MAX_SCOPE_SCENES) throw new GenError('bad_request', 400, `scope.scene_ids: at most ${MAX_SCOPE_SCENES}`);
        out.scene_ids = [...new Set(s.scene_ids.map((x, i) => requireText(x, `scope.scene_ids[${i}]`)))];
        delete out.chapter_id; delete out.scene_id; delete out.unit_id;
    } else if (s.scene_ids !== undefined) {
        throw new GenError('bad_request', 400, 'scope.scene_ids applies only to level=scenes');
    }
    return out;
}

/** Layers a planned unit may belong to: video work starts with its images (§6.3). */
function unitFitsLayer(kind, layer) {
    if (LAYER_OF_KIND[kind] === layer) return true;
    return layer === 'video' && kind === 'iu_image';
}

function checkUnit(u, layer) {
    const ok = u && typeof u === 'object'
        && FIRST_STAGE_KINDS.includes(u.kind) && unitFitsLayer(u.kind, layer)
        && typeof u.chapter_id === 'string' && u.chapter_id
        && typeof u.scene_id === 'string' && u.scene_id
        && typeof u.unit_key === 'string' && u.unit_key
        && typeof u.build_id === 'string' && u.build_id
        && u.input && typeof u.input === 'object';
    if (!ok) {
        throw new GenError('bad_plan', 500,
            `planUnits(${layer}) returned an invalid unit: ${JSON.stringify(u && { kind: u.kind, chapter_id: u.chapter_id, scene_id: u.scene_id, unit_key: u.unit_key, build_id: u.build_id })}`);
    }
}

const unitKey = (u) => `${u.chapter_id}\u0000${u.scene_id}\u0000${u.kind}\u0000${u.unit_key}`;

/**
 * Book deletion: remove every gen_* row of the book (one transaction).
 * Usable without an orchestration instance (master flag off).
 * @returns {Promise<{commands:number, jobs:number, links:number, build_ids:string[], job_ids:string[]}>}
 */
async function purgeBookRows(pool, bookId) {
    requireText(bookId, 'bookId');
    return withTx(pool, async (client) => {
        const jobsOf = (await client.query(
            'SELECT job_id, build_id FROM gen_jobs WHERE book_id = $1', [bookId])).rows;
        const links = await client.query(
            `DELETE FROM gen_command_jobs l
             WHERE l.command_id IN (SELECT command_id FROM gen_commands WHERE book_id = $1)
                OR l.job_id IN (SELECT job_id FROM gen_jobs WHERE book_id = $1)`, [bookId]);
        const jobs = await client.query('DELETE FROM gen_jobs WHERE book_id = $1', [bookId]);
        const commands = await client.query('DELETE FROM gen_commands WHERE book_id = $1', [bookId]);
        return {
            commands: commands.rowCount, jobs: jobs.rowCount, links: links.rowCount,
            build_ids: [...new Set(jobsOf.map((r) => r.build_id))], job_ids: jobsOf.map((r) => r.job_id),
        };
    });
}

function createCommands({ pool, ports, genLog = NOOP_LOG }) {
    /**
     * ADR §6.1 — one transaction.
     * @returns {Promise<{command_id:string, created:boolean, existing:boolean, status:string, layers:string[],
     *          summary:{jobs_created:number, joined:number, skipped_ready:number}}>}
     */
    async function createCommandTx(params = {}) {
        const workspaceId = requireUuid(params.workspaceId, 'workspaceId');
        const userId = requireUuid(params.userId, 'userId');
        const bookId = requireText(params.bookId, 'bookId');
        const kind = params.kind || 'regenerate';
        if (!COMMAND_KINDS.includes(kind)) throw new GenError('bad_request', 400, `kind must be ${COMMAND_KINDS.join('|')}`);
        const scope = normaliseScope(params.scope);
        const requested = Array.isArray(params.layers) ? [...new Set(params.layers)] : [];
        if (requested.length === 0 || requested.some((l) => !LAYERS.includes(l))) {
            throw new GenError('bad_request', 400, 'layers must be a non-empty subset of audio|image|video');
        }
        const force = params.force === true;
        const clientActionId = params.clientActionId == null ? null : requireText(params.clientActionId, 'clientActionId', 200);

        // §6.1 п.2: requested ∩ enabled (host layer-config passed in, or the optional port)
        let effective;
        if (Array.isArray(params.enabledLayers)) {
            effective = requested.filter((l) => params.enabledLayers.includes(l));
        } else {
            effective = [];
            for (const l of requested) if (await ports.isLayerEnabled(bookId, l)) effective.push(l);
        }

        return withTx(pool, async (client) => {
            const book = (await client.query(
                'SELECT book_id, workspace_id, orchestration FROM books WHERE book_id = $1 FOR SHARE', [bookId])).rows[0];
            if (!book) throw new GenError('book_not_found', 404, `book ${bookId} not found`);
            if (book.workspace_id !== workspaceId) throw new GenError('forbidden', 403, 'book belongs to another workspace');
            if (book.orchestration !== 'v2') throw new GenError('book_not_v2', 409, `book ${bookId} is on legacy orchestration`);

            const existingOf = async () => (await client.query(
                'SELECT * FROM gen_commands WHERE book_id = $1 AND client_action_id = $2', [bookId, clientActionId])).rows[0] || null;
            const existingResponse = (row) => {
                if (row.workspace_id !== workspaceId) throw new GenError('conflict', 409, 'client_action_id taken');
                return {
                    command_id: row.command_id, created: false, existing: true,
                    status: row.status, layers: row.layers,
                    summary: row.summary || { jobs_created: 0, joined: 0, skipped_ready: 0 },
                };
            };

            // §6.1 п.1: a repeated click returns the same command (and the same summary)
            if (clientActionId) {
                const prev = await existingOf();
                if (prev) return existingResponse(prev);
            }
            if (effective.length === 0) throw new GenError('layer_disabled', 409, 'all requested layers are disabled');

            const ins = await client.query(
                `INSERT INTO gen_commands (workspace_id, user_id, book_id, kind, scope, layers, force, client_action_id, created_at)
                 VALUES ($1, $2, $3, $4, $5::jsonb, $6::text[], $7, $8, clock_timestamp())
                 ON CONFLICT ON CONSTRAINT gen_commands_client_action_uniq DO NOTHING
                 RETURNING *`,
                [workspaceId, userId, bookId, kind, JSON.stringify(scope), effective, force, clientActionId]);
            if (ins.rowCount === 0) return existingResponse(await existingOf()); // concurrent twin committed first
            const cmd = ins.rows[0];

            // §6.1 п.3: plan units per layer
            const bookRef = { bookId, workspaceId, userId };
            const units = [];
            const seen = new Set();
            for (const layer of effective) {
                const planned = await ports.planUnits(bookRef, scope, layer);
                if (!Array.isArray(planned)) throw new GenError('bad_plan', 500, `planUnits(${layer}) must return an array`);
                for (const u of planned) {
                    checkUnit(u, layer);
                    if (seen.has(unitKey(u))) continue; // video+image may both plan the same IU
                    seen.add(unitKey(u));
                    units.push(u);
                }
            }

            // §6.1 п.3: skip units whose scene asset is ready for the current content (PG scene_assets only)
            let skipped = 0;
            let todo = units;
            if (!force && units.length) {
                const k5 = (g) => `${g.chapter_id}\u0000${g.scene_id}\u0000${g.asset_type}\u0000${g.build_id}\u0000${g.scene_hash}`;
                const gkey = (u) => k5({ ...u, asset_type: LAYER_OF_KIND[u.kind] });
                const groups = new Map();
                for (const u of units) {
                    if (typeof u.scene_hash !== 'string' || !u.scene_hash) continue; // readiness unprovable → do it
                    if (!groups.has(gkey(u))) groups.set(gkey(u), { chapter_id: u.chapter_id, scene_id: u.scene_id, asset_type: LAYER_OF_KIND[u.kind], build_id: u.build_id, scene_hash: u.scene_hash });
                }
                const readyKeys = new Set();
                if (groups.size) {
                    const list = [...groups.values()];
                    const r = await client.query(
                        `SELECT g.ord FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
                                WITH ORDINALITY AS g(chapter_id, scene_id, asset_type, build_id, scene_hash, ord)
                         WHERE EXISTS (SELECT 1 FROM scene_assets a
                                       WHERE a.book_id = $1 AND a.chapter_id = g.chapter_id AND a.scene_id = g.scene_id
                                         AND a.asset_type = g.asset_type AND a.build_id = g.build_id
                                         AND a.status = 'ready' AND a.scene_hash = g.scene_hash)`,
                        [bookId, list.map((x) => x.chapter_id), list.map((x) => x.scene_id), list.map((x) => x.asset_type),
                            list.map((x) => x.build_id), list.map((x) => x.scene_hash)]);
                    for (const row of r.rows) readyKeys.add(k5(list[Number(row.ord) - 1]));
                }
                todo = units.filter((u) => {
                    if (typeof u.scene_hash !== 'string' || !u.scene_hash) return true;
                    if (readyKeys.has(gkey(u))) { skipped += 1; return false; }
                    return true;
                });
                // 1.1.0 — part-level readiness (opt-in: the unit carries input.part_hash).
                // A part (e.g. one IU picture) whose accepted snapshot hash is recorded in
                // scene_assets.metadata.gen_parts[unit_key].part_hash for the same build is
                // already done for the current content — skip it even if its scene is not
                // complete («сгенерировать недостающее» = only the missing / changed parts).
                // A row the host marked 'stale' proves nothing. Units without part_hash
                // (audio) keep the scene-level rule above unchanged.
                const parted = todo.filter((u) => typeof u.input.part_hash === 'string' && u.input.part_hash);
                if (parted.length) {
                    const r = await client.query(
                        `SELECT t.ord FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
                                WITH ORDINALITY AS t(chapter_id, scene_id, asset_type, build_id, unit_key, part_hash, ord)
                         WHERE EXISTS (SELECT 1 FROM scene_assets a
                                       WHERE a.book_id = $1 AND a.chapter_id = t.chapter_id AND a.scene_id = t.scene_id
                                         AND a.asset_type = t.asset_type AND a.build_id = t.build_id
                                         AND a.status IN ('pending', 'ready')
                                         AND jsonb_typeof(a.metadata->'gen_parts') = 'object'
                                         AND a.metadata->'gen_parts'->t.unit_key->>'part_hash' = t.part_hash)`,
                        [bookId, parted.map((u) => u.chapter_id), parted.map((u) => u.scene_id), parted.map((u) => LAYER_OF_KIND[u.kind]),
                            parted.map((u) => u.build_id), parted.map((u) => u.unit_key), parted.map((u) => u.input.part_hash)]);
                    const done = new Set(r.rows.map((row) => parted[Number(row.ord) - 1]));
                    if (done.size) {
                        skipped += done.size;
                        todo = todo.filter((u) => !done.has(u));
                    }
                }
            }

            // lanes, one lookup per worker type (§4.2: computed at creation)
            const laneCache = new Map();
            const laneOf = async (executor) => {
                if (executor === 'local') return null;
                const type = executor.slice(4);
                if (!laneCache.has(type)) {
                    const lane = await ports.laneFor(workspaceId, type);
                    if (!checkLane(lane)) throw new GenError('bad_lane', 500, `laneFor(${type}) returned an invalid lane`);
                    if (lane.kind === 'private' && lane.workspace_id !== workspaceId) {
                        throw new GenError('bad_lane', 500, 'private lane must be the book workspace (I7)');
                    }
                    laneCache.set(type, lane);
                }
                return laneCache.get(type);
            };

            // §6.1 п.4: insert; a unit live under another command → joined (link to the live job)
            let created = 0;
            let joined = 0;
            if (todo.length) {
                const cols = { ch: [], sc: [], uk: [], kind: [], ex: [], layer: [], build: [], lane: [], max: [], input: [] };
                for (const u of todo) {
                    const ex = EXECUTOR_OF_KIND[u.kind];
                    const lane = await laneOf(ex);
                    cols.ch.push(u.chapter_id); cols.sc.push(u.scene_id); cols.uk.push(u.unit_key);
                    cols.kind.push(u.kind); cols.ex.push(ex); cols.layer.push(LAYER_OF_KIND[u.kind]); cols.build.push(u.build_id);
                    cols.lane.push(lane ? JSON.stringify(lane) : null);
                    cols.max.push(ports.maxAttemptsFor(u.kind));
                    cols.input.push(JSON.stringify({ ...u.input, scene_hash: u.scene_hash ?? u.input.scene_hash ?? null }));
                }
                const ins2 = await client.query(
                    `INSERT INTO gen_jobs (command_id, workspace_id, user_id, book_id, chapter_id, scene_id, unit_key,
                                           kind, executor, layer, build_id, lane, max_attempts, input, created_at)
                     SELECT $1, $2, $3, $4, t.ch, t.sc, t.uk, t.kind, t.ex, t.layer, t.build, t.lane::jsonb, t.max, t.input::jsonb,
                            clock_timestamp()       -- strictly increasing in plan order → claim order = plan order
                     FROM unnest($5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[],
                                 $12::text[], $13::int[], $14::text[])
                          WITH ORDINALITY AS t(ch, sc, uk, kind, ex, layer, build, lane, max, input, ord)
                     ORDER BY t.ord
                     ON CONFLICT (book_id, chapter_id, scene_id, kind, unit_key) WHERE status IN ('queued','running')
                     DO NOTHING
                     RETURNING job_id`,
                    [cmd.command_id, workspaceId, userId, bookId, cols.ch, cols.sc, cols.uk, cols.kind, cols.ex,
                        cols.layer, cols.build, cols.lane, cols.max, cols.input]);
                created = ins2.rowCount;
                // live jobs of the same units (ours just inserted + other commands' → joined)
                const live = await client.query(
                    `SELECT j.job_id, j.command_id FROM gen_jobs j
                     JOIN unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS t(ch, sc, kind, uk)
                       ON j.chapter_id = t.ch AND j.scene_id = t.sc AND j.kind = t.kind AND j.unit_key = t.uk
                     WHERE j.book_id = $1 AND j.status IN ('queued','running')`,
                    [bookId, cols.ch, cols.sc, cols.kind, cols.uk]);
                joined = live.rows.filter((r) => r.command_id !== cmd.command_id).length;
                await linkJobs(client, [cmd.command_id], live.rows.map((r) => r.job_id));
            }
            const summary = { jobs_created: created, joined, skipped_ready: skipped };
            await client.query('UPDATE gen_commands SET summary = $2::jsonb WHERE command_id = $1', [cmd.command_id, JSON.stringify(summary)]);
            await notifyProgress(client, bookId, cmd.command_id);
            return {
                command_id: cmd.command_id, created: true, existing: false,
                status: cmd.status, layers: cmd.layers, summary,
            };
        });
    }

    /**
     * ADR §6.4. One transaction. Exactly one of:
     *   {bookId}            — stop the book: every active command + every live job of the book
     *   {bookId, layer}     — stop one layer of the book (audio also stops audio_merge); commands stay active
     *   {commandId}         — stop one command; its jobs are cancelled only when no OTHER active
     *                         command waits for them (gen_command_jobs) — shared jobs keep running
     * @param {object} target
     * @param {{cancelledBy?:string}} [opts]
     * @returns {Promise<{commands_cancelled:number, jobs_cancelled:number, job_ids:string[], kept_shared:number, layers?:string[]}>}
     *          layers (1.1.0, {commandId} only): the layers of the command that was stopped
     */
    async function cancel(target = {}, opts = {}) {
        const by = opts.cancelledBy == null ? null : String(opts.cancelledBy).slice(0, 200);
        const { bookId, layer, commandId } = target;
        if ('executor' in target) throw new GenError('bad_request', 400, 'cancel by executor was removed — use {bookId, layer}');
        if (commandId !== undefined) {
            if (!isUuid(commandId) || bookId !== undefined || layer !== undefined) {
                throw new GenError('bad_request', 400, 'cancel({commandId}) takes a UUID and nothing else');
            }
        } else {
            requireText(bookId, 'bookId');
            if (layer !== undefined && !LAYERS.includes(layer)) {
                throw new GenError('bad_request', 400, 'layer must be audio|image|video');
            }
        }
        return withTx(pool, async (client) => {
            let commands = [];
            let jobs;
            let keptShared = 0;
            if (commandId !== undefined) {
                commands = (await client.query(
                    `UPDATE gen_commands SET status = 'cancelled', finished_at = now(), cancelled_by = $2
                     WHERE command_id = $1 AND status = 'active' RETURNING command_id, book_id, layers`, [commandId, by])).rows;
                jobs = await client.query(
                    `UPDATE gen_jobs j SET status = 'cancelled', finished_at = now()
                     FROM gen_command_jobs l
                     WHERE l.command_id = $1 AND l.job_id = j.job_id AND j.status IN ('queued','running')
                       AND NOT EXISTS (SELECT 1 FROM gen_command_jobs o JOIN gen_commands oc ON oc.command_id = o.command_id
                                        WHERE o.job_id = j.job_id AND o.command_id <> $1 AND oc.status = 'active')
                     RETURNING j.job_id, j.book_id`, [commandId]);
                keptShared = Number((await client.query(
                    `SELECT count(*)::int AS n FROM gen_command_jobs l JOIN gen_jobs j ON j.job_id = l.job_id
                     WHERE l.command_id = $1 AND j.status IN ('queued','running')`, [commandId])).rows[0].n);
            } else if (layer !== undefined) {
                jobs = await client.query(
                    `UPDATE gen_jobs SET status = 'cancelled', finished_at = now()
                     WHERE book_id = $1 AND layer = $2 AND status IN ('queued','running')
                     RETURNING job_id, book_id`, [bookId, layer]);
            } else {
                commands = (await client.query(
                    `UPDATE gen_commands SET status = 'cancelled', finished_at = now(), cancelled_by = $2
                     WHERE book_id = $1 AND status = 'active' RETURNING command_id, book_id`, [bookId, by])).rows;
                jobs = await client.query(
                    `UPDATE gen_jobs SET status = 'cancelled', finished_at = now()
                     WHERE book_id = $1 AND status IN ('queued','running')
                     RETURNING job_id, book_id`, [bookId]);
            }
            const books = new Set([...commands.map((c) => c.book_id), ...jobs.rows.map((j) => j.book_id)]);
            for (const b of books) await notifyProgress(client, b, commandId || null);
            const out = {
                commands_cancelled: commands.length,
                jobs_cancelled: jobs.rowCount,
                job_ids: jobs.rows.map((j) => j.job_id),
                kept_shared: keptShared,
            };
            if (commandId !== undefined) out.layers = commands.length ? commands[0].layers : [];   // 1.1.0
            return out;
        });
    }

    const purgeBook = (bookId) => purgeBookRows(pool, bookId);

    /** createCommandTx + the О3 `command-created` info line (also for a repeated click: existing=true). */
    async function createCommand(params = {}) {
        const t0 = Date.now();
        const r = await createCommandTx(params);
        genLog.event('command-created', {
            book_id: params.bookId, command_id: r.command_id, layers: r.layers, status: r.status,
            scope: params.scope && params.scope.level, existing: r.existing === true ? true : undefined,
            jobs_created: r.summary && r.summary.jobs_created, joined: r.summary && r.summary.joined,
            skipped_ready: r.summary && r.summary.skipped_ready, ms: Date.now() - t0,
        });
        return r;
    }

    return { createCommand, cancel, purgeBook };
}

module.exports = { createCommands, normaliseScope, purgeBookRows };
