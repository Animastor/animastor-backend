// ======================================================
// orchestration-v2/routes — HTTP surface of the gen core (ADR §6, §7, §8)
// ======================================================
// 1. Internal (worker / hub) — mounted by the composition root:
//      POST /internal/gen/claim                 x-api-key (GPU_HUB_API_KEY, REQUIRED)
//      POST /internal/gen/beacon                x-api-key
//      PUT  /internal/gen/jobs/:id/result?attempt=N   Bearer upload_token, raw body stream
//      GET  /internal/gen/jobs/:id/input/:name?attempt=N  Bearer upload_token (stage 3: IU frames of a
//           video group, ADR §8.1 — by link, not base64; public through nginx like result)
//      POST /internal/gen/jobs/:id/error?attempt=N    Bearer upload_token, JSON
//    No key / token → 401. Master flag off → 503 {code:'orch_v2_disabled'}.
// 2. Book handlers for books.orchestration='v2' — the existing routes call
//    them first (deps.orchV2); legacy books never reach this file.

'use strict';

const fs = require('fs');
const path = require('path');

const { scopeBounds } = require('../services/gen-scope');
const workerLogsStore = require('../services/worker-logs-store');
const workerLogTail = require('../services/worker-log-tail');

const LEGACY_TO_SCOPE = Object.freeze({ whole_book: 'book', current_chapter: 'chapter', current_scene: 'scene' });
const ALL_LAYERS = Object.freeze(['audio', 'image', 'video']);
const BASE_V2_LAYERS = Object.freeze(['audio', 'image']);  // + video (stage 3) when the core supports it
const FROM_CURRENT_SCENE = 'from_current_scene';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendGenError(res, err, context) {
    const status = Number(err && err.status) || 500;
    if (status >= 500) console.error(`[ORCH-V2] ${context}: ${err && err.message}`);
    // details: e.g. voice_reference_required → {character_ids, reasons} (VOICE_REFERENCES.md)
    const details = err && err.details && typeof err.details === 'object' ? err.details : {};
    return res.status(status).json({ ...details, code: (err && err.code) || 'internal', error: (err && err.message) || 'error' });
}

function bearer(req) {
    const h = String(req.headers.authorization || '');
    return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

function createV2Routes({ host, config, workerRepo, bookRepo, layerConfig, redis, book, sessionControl, log = console.log }) {
    const disabled = (res) => res.status(503).json({ code: 'orch_v2_disabled', error: host.disabledReason() || 'orchestration v2 is disabled' });

    // ── internal auth ────────────────────────────────────────────────────
    function requireHubKey(req, res, next) {
        const key = config.GPU_HUB_API_KEY;
        if (!key) return res.status(401).json({ code: 'unauthorized', error: 'hub key not configured' });   // ключ обязателен
        if (req.headers['x-api-key'] !== key) return res.status(401).json({ code: 'unauthorized', error: 'bad hub key' });
        return next();
    }

    function mountInternal(app) {
        app.post('/internal/gen/claim', requireHubKey, async (req, res) => {
            if (!host.isEnabled()) return disabled(res);
            try {
                const b = req.body || {};
                if (!UUID_RE.test(String(b.worker_id || ''))) return res.status(400).json({ code: 'bad_request', error: 'worker_id required' });
                // PG is the identity truth (I7): type / mode / workspace / share policy of the worker
                const w = await workerRepo.findActiveByIdWithTokenHash(b.worker_id);
                if (!w) return res.status(403).json({ code: 'unknown_worker', error: 'worker unknown or revoked' });
                if (b.worker_type && b.worker_type !== w.worker_type) return res.status(403).json({ code: 'type_mismatch', error: 'worker_type differs from the credential' });
                const policy = (typeof config.shareFeaturesEnabled === 'function' && config.shareFeaturesEnabled() === true) ? w.share_policy : null;
                const out = await host.orch().claim({
                    workerId: w.worker_id,
                    workerType: w.worker_type,
                    mode: w.mode,
                    workspaceId: w.mode === 'private' ? w.workspace_id : null,
                    policyIds: policy && policy.scope_kind === 'users' ? [policy.policy_id] : [],
                    sharePublic: !!(policy && policy.scope_kind === 'public' && w.mode === 'private'),
                });
                if (!out.task) return res.json({ task: null });
                const t = out.task;
                const task = {
                    ...t,
                    protocol_version: 3,
                    job_type: w.worker_type,
                    upload_url: host.uploadUrl(t.job_id, t.attempt),
                    error_url: host.errorUrl(t.job_id, t.attempt),
                };
                // stage 3: input files by link (same token as the result) — the worker puts them
                // into COMFY_INPUT_DIR under `name` before the workflow runs
                if (Array.isArray(t.input_files) && t.input_files.length && host.inputUrl) {
                    task.input_files = t.input_files.map((f) => ({ ...f, url: host.inputUrl(t.job_id, t.attempt, f.name) }));
                }
                return res.json({ task });
            } catch (err) { return sendGenError(res, err, 'claim'); }
        });

        app.post('/internal/gen/beacon', requireHubKey, async (req, res) => {
            if (!host.isEnabled()) return disabled(res);
            try {
                const b = req.body || {};
                if (!UUID_RE.test(String(b.worker_id || ''))) return res.status(400).json({ code: 'bad_request', error: 'worker_id required' });
                const r = await host.orch().beacon(b.worker_id, { current_job_id: b.current_job_id || null });
                // §8.5: a pending one-shot tail request rides exactly ONE
                // beacon answer. Consumed only after the beacon succeeded, so
                // a failed/disabled beacon never swallows the request.
                const sendLogTail = workerLogTail.consume(b.worker_id);
                return res.json({ cancel: r.cancel, send_log_tail: sendLogTail });
            } catch (err) { return sendGenError(res, err, 'beacon'); }
        });

        // POST /internal/workers/:workerId/logs — fresh worker logs (§8.5).
        // The hub is the only caller (x-api-key, docker network; nginx blocks
        // /internal/workers/ externally). The URL identity is the token-derived
        // worker_id and is validated as a UUID before it reaches the disk.
        // log_shipping=false → 204 without writing (tenant opt-out).
        app.post('/internal/workers/:workerId/logs', requireHubKey, async (req, res) => {
            const workerId = String(req.params.workerId || '');
            if (!UUID_RE.test(workerId)) {
                return res.status(400).json({ code: 'bad_request', error: 'worker_id must be a UUID' });
            }
            const declared = Number(req.headers['content-length']);
            if (Number.isFinite(declared) && declared > 128 * 1024) {
                return res.status(413).json({ code: 'too_large', error: 'limit 131072 bytes' });
            }
            const b = req.body || {};
            if (!Array.isArray(b.lines)) {
                return res.status(400).json({ code: 'bad_request', error: 'lines[] required' });
            }
            if (b.lines.length > 2000) {
                return res.status(413).json({ code: 'too_many_lines', error: 'limit 2000 lines' });
            }
            try {
                const w = await workerRepo.findById(workerId);
                if (!w || w.revoked_at != null) {
                    return res.status(404).json({ code: 'unknown_worker', error: 'worker unknown or revoked' });
                }
                if (w.log_shipping !== true) {
                    // Opt-out: acknowledge without touching the disk (the
                    // worker's own buffer is not our data to keep).
                    return res.status(204).end();
                }
                if (b.lines.length === 0) return res.status(204).end();
                await workerLogsStore.writeLines(workerId, b.lines);
                return res.status(204).end();
            } catch (err) { return sendGenError(res, err, 'logs'); }
        });

        app.put('/internal/gen/jobs/:jobId/result', async (req, res) => {
            const token = bearer(req);
            if (!token) { req.resume(); return res.status(401).json({ code: 'unauthorized', error: 'upload token required' }); }
            if (!host.isEnabled()) { req.resume(); return disabled(res); }
            const declared = Number(req.headers['content-length']);
            if (Number.isFinite(declared) && declared > host.maxUploadBytes) {
                req.resume();
                return res.status(413).json({ code: 'too_large', error: `limit ${host.maxUploadBytes} bytes` });
            }
            try {
                const r = await host.orch().acceptResult(req.params.jobId, Number(req.query.attempt), token, req);
                return res.status(r.status).json(r);
            } catch (err) { return sendGenError(res, err, 'result'); }
        });

        // ADR §8.1 (stage 3): an input file of the CURRENT running attempt, by the job's upload
        // token; only names the job lists; bytes = the snapshot hashed at planning (else 409).
        app.get('/internal/gen/jobs/:jobId/input/:name', async (req, res) => {
            const token = bearer(req);
            if (!token) return res.status(401).json({ code: 'unauthorized', error: 'upload token required' });
            if (!host.isEnabled()) return disabled(res);
            const orch = host.orch();
            if (!orch || typeof orch.openInput !== 'function') return res.status(404).json({ code: 'not_found', error: 'input files need @animastor/orchestration >= 1.3.0' });
            try {
                const r = await orch.openInput(req.params.jobId, Number(req.query.attempt), token, String(req.params.name || ''));
                if (r.status !== 200) return res.status(r.status).json({ code: r.code });
                res.set('Content-Type', /\.png$/i.test(r.name) ? 'image/png' : 'application/octet-stream');
                res.set('Content-Length', String(r.body.length));
                res.set('Cache-Control', 'no-store');
                res.set('X-Content-SHA256', r.sha256);
                return res.status(200).end(r.body);
            } catch (err) { return sendGenError(res, err, 'input'); }
        });

        app.post('/internal/gen/jobs/:jobId/error', async (req, res) => {
            const token = bearer(req);
            if (!token) return res.status(401).json({ code: 'unauthorized', error: 'upload token required' });
            if (!host.isEnabled()) return disabled(res);
            try {
                const b = req.body || {};
                const r = await host.orch().acceptError(req.params.jobId, Number(req.query.attempt), token, {
                    error_class: typeof b.error_class === 'string' ? b.error_class : null,
                    reason: [b.reason, b.comfy_status ? `comfy_status=${b.comfy_status}` : null].filter(Boolean).join(' '),
                });
                return res.status(r.status).json(r);
            } catch (err) { return sendGenError(res, err, 'error'); }
        });
        log('[ROUTES] orchestration v2 internal routes loaded (/internal/gen/*)');
    }

    // ── book handlers (v2 books) ────────────────────────────────────────
    function userIdOf(req) {
        const u = req.user && (req.user.user_id || req.user.id);
        if (u && UUID_RE.test(String(u))) return String(u);
        const g = req.guest && req.guest.guestId;
        if (g && UUID_RE.test(String(g))) return String(g);
        return null;
    }

    /** from_current_scene → {level:'scenes', scene_ids:[current … last]} in book order (legacy scopeBounds). */
    function expandFromCurrentScene(bookId, body) {
        const chapterId = typeof body.chapter_id === 'string' ? body.chapter_id : null;
        const sceneId = typeof body.scene_id === 'string' ? body.scene_id : null;
        if (!chapterId || !sceneId) {
            return { status: 400, error: { code: 'bad_request', error: 'chapter_id and scene_id are required for scope from_current_scene' } };
        }
        const loaded = book && typeof book.loadBook === 'function' ? book.loadBook(bookId) : null;
        if (!loaded) return { status: 404, error: { code: 'book_not_found', error: 'book not found' } };
        const all = book.collectScenes(loaded).filter((s) => s.chapter_id && s.scene_id);
        const { startIndex, endIndex } = scopeBounds({ scope: FROM_CURRENT_SCENE, chapter_id: chapterId, scene_id: sceneId }, all);
        if (endIndex <= startIndex) {
            return { status: 404, error: { code: 'scene_not_found', error: `scene ${chapterId}/${sceneId} is not in the book` } };
        }
        return { scope: { level: 'scenes', scene_ids: all.slice(startIndex, endIndex).map((s) => s.scene_id) } };
    }

    async function regenerate(req, res) {
        const { bookId } = req.params;
        if (!host.isEnabled()) return res.status(409).json({ code: 'orch_v2_disabled', error: host.disabledReason() || 'orchestration v2 is disabled' });
        const body = req.body || {};
        const types = body.worker_types === undefined ? ['audio'] : body.worker_types;
        if (!Array.isArray(types) || types.length === 0 || types.some((t) => !ALL_LAYERS.includes(t))) {
            return res.status(400).json({ error: 'worker_types must be a non-empty array containing audio, image, or video' });
        }
        // audio + image (2a) + video (stage 3, core >= 1.3.0) run on v2; a layer the host
        // cannot run creates no work — the answer says so (summary.skipped_unsupported)
        const requested = [...new Set(types)];
        const videoWhy = host.videoUnsupportedReason ? host.videoUnsupportedReason() : 'host without video support';
        const supported = videoWhy ? BASE_V2_LAYERS : [...BASE_V2_LAYERS, 'video'];
        const unsupported = requested.filter((t) => !supported.includes(t));
        const layers = requested.filter((t) => supported.includes(t));
        if (!layers.length) {
            return res.status(409).json({
                code: 'v2_video_unavailable', error: `video layer is unavailable on orchestration v2: ${videoWhy}`,
                worker_types: unsupported, summary: { jobs_created: 0, joined: 0, skipped_ready: 0, skipped_unsupported: unsupported },
            });
        }
        if (layers.includes('image')) {
            const why = host.imageUnsupportedReason ? host.imageUnsupportedReason() : 'host without image support';
            if (why) return res.status(409).json({ code: 'v2_image_unavailable', error: `image layer is unavailable on orchestration v2: ${why}`, worker_types: ['image'] });
        }
        const legacyScope = body.scope || 'whole_book';
        let scope;
        if (legacyScope === FROM_CURRENT_SCENE) {
            // ADR §11.1 / §13 п.8 (1c): «from the current scene to the end» is expanded
            // HERE into an explicit list — book order, [current, last) exactly as the
            // legacy gen-scope.scopeBounds; the command stores {level:'scenes', scene_ids}.
            const r = expandFromCurrentScene(bookId, body);
            if (r.error) return res.status(r.status).json(r.error);
            scope = r.scope;
        } else {
            const level = LEGACY_TO_SCOPE[legacyScope];
            if (!level) return res.status(409).json({ code: 'v2_scope_not_supported_yet', error: `scope ${legacyScope} is not supported on orchestration v2 yet` });
            scope = { level };
            if (body.chapter_id) scope.chapter_id = String(body.chapter_id);
            if (body.scene_id && level === 'scene') scope.scene_id = String(body.scene_id);
        }
        try {
            const workspaceId = await bookRepo.getWorkspaceId(bookId);
            if (!workspaceId) return res.status(409).json({ code: 'book_without_workspace', error: 'book has no workspace' });
            let userId = userIdOf(req);
            if (!userId) {
                const ws = await require('../storage/postgres/repositories/workspace-repo').findById(workspaceId).catch(() => null);
                userId = ws && ws.owner_user_id ? ws.owner_user_id : null;
            }
            if (!userId) return res.status(401).json({ code: 'unauthorized', error: 'no user for the command' });
            const cfg = await layerConfig.get(bookId);
            const enabledLayers = ['audio', 'image', 'video'].filter((l) => cfg[`${l}_enabled`] !== false);
            const ca = body.client_action && typeof body.client_action === 'object' ? body.client_action : null;
            const clientActionId = ca && typeof ca.action_id === 'string' && ca.action_id ? ca.action_id.slice(0, 200) : null;
            const r = await host.orch().createCommand({
                workspaceId, userId, bookId, kind: 'regenerate', scope, layers,
                force: body.rebuild_all === true || body.force === true,
                clientActionId, enabledLayers,
            });
            const loaded = book && typeof book.loadBook === 'function' ? book.loadBook(bookId) : null;
            const scopeLog = scope.level === 'scenes' ? `${legacyScope}→scenes[${scope.scene_ids.length}] from ${scope.scene_ids[0]}` : legacyScope;
            const summary = unsupported.length ? { ...r.summary, skipped_unsupported: unsupported } : r.summary;
            log(`[REGENERATE] ${bookId}: orchestration v2 command ${r.command_id} ${r.existing ? '(existing, repeated click)' : 'created'} layers=${r.layers.join(',')} scope=${scopeLog} summary=${JSON.stringify(summary)} client_action_id=${clientActionId || '-'}`);
            // per-layer counts of the command (jobs it created or joined, §4.2a)
            let byLayer = {};
            try {
                const p = await host.orch().progress(bookId);
                const c = p.commands.find((x) => x.command_id === r.command_id);
                if (c) byLayer = c.by_layer || {};
            } catch (_) { /* counts are informational */ }
            const layerCount = (l) => { const t = byLayer[l] || {}; return (t.queued || 0) + (t.running || 0) + (t.done || 0) + (t.failed || 0) + (t.cancelled || 0); }
            return res.json({
                book_id: bookId,
                orchestration: 'v2',
                command_id: r.command_id,
                existing: r.existing,
                summary,
                scope: legacyScope,
                build_id: (loaded && loaded.manifest && loaded.manifest.build_id) || 'default',
                dirty_scenes: [],
                // not run by this command: unsupported on v2 (video) + disabled in layer-config
                skipped_worker_types: requested.filter((t) => !r.layers.includes(t)),
                tasks: r.layers.map((type) => ({ task_id: r.command_id, type, target_count: layerCount(type) })),
            });
        } catch (err) {
            if (err && err.code === 'layer_disabled') {
                return res.status(409).json({ error: 'layer_disabled', message: 'All requested layers are disabled in layer-config', disabled_worker_types: layers });
            }
            return sendGenError(res, err, 'regenerate');
        }
    }

    async function cancelGeneration(req, res) {
        const { bookId } = req.params;
        try {
            if (host.isEnabled()) {
                const r = await host.orch().cancel({ bookId }, { cancelledBy: userIdOf(req) || 'cancel-generation' });
                log(`[CANCEL-GENERATION] ${bookId}: orchestration v2 — ${r.commands_cancelled} command(s), ${r.jobs_cancelled} job(s) cancelled`);
            }
            // VBook (LLM) is not orchestration work — the button stops it as before.
            if (sessionControl) { try { await sessionControl.cancelSessions(bookId); } catch (e) { console.warn(`[CANCEL-GENERATION] VBook cancel failed: ${e.message}`); } }
            return res.json({ ok: true, book_id: bookId, orchestration: 'v2' });
        } catch (err) { return sendGenError(res, err, 'cancel-generation'); }
    }

    /** @returns {Promise<boolean>} true when handled (otherwise the legacy route continues: vbook / cover) */
    async function cancelWorker(req, res) {
        const { bookId } = req.params;
        const { type, task_id: taskId } = req.body || {};
        try {
            if (taskId && UUID_RE.test(String(taskId))) {
                if (!host.isEnabled()) return res.status(409).json({ code: 'orch_v2_disabled', error: host.disabledReason() });
                const r = await host.orch().cancel({ commandId: String(taskId) }, { cancelledBy: userIdOf(req) || 'cancel-worker' });
                return res.json({ ok: true, book_id: bookId, cancelled: r.layers || [], task_ids: [String(taskId)], jobs_cancelled: r.jobs_cancelled, kept_shared: r.kept_shared });
            }
            if (type === 'cover') return res.json({ ok: true, book_id: bookId, cancelled: ['cover'], task_ids: [] }); // no legacy leases for a v2 book
            if (['audio', 'image', 'video'].includes(type)) {
                let n = 0;
                if (host.isEnabled()) n = (await host.orch().cancel({ bookId, layer: type })).jobs_cancelled;
                return res.json({ ok: true, book_id: bookId, cancelled: [type], task_ids: [], jobs_cancelled: n });
            }
            return false;
        } catch (err) { return sendGenError(res, err, 'cancel-worker'); }
    }

    /** PUT layer-config switched layers off → stop those layers of the v2 book. */
    async function onLayersDisabled(bookId, layers) {
        if (!host.isEnabled() || !layers.length) return [];
        const out = [];
        for (const layer of layers) {
            const r = await host.orch().cancel({ bookId, layer });
            out.push(layer);
            log(`[LAYER-CONFIG] ${bookId}: orchestration v2 layer ${layer} off — ${r.jobs_cancelled} job(s) cancelled`);
        }
        return out;
    }

    async function progressPanel(bookId, resolveLabels) {
        if (!host.isEnabled()) return { book_id: bookId, tasks: [], overall_percent: 0, any_incomplete: false, orchestration: 'v2' };
        const p = await host.progress().panel(bookId, { resolveLabels });
        return { ...p, orchestration: 'v2' };
    }

    /** Book deletion: gen_* rows + this book's files in {build}/.incoming. Works with the flag off. */
    async function purgeBook(bookId, { getPool, outputDir }) {
        const gen = require('@animastor/orchestration').gen;
        let r;
        try {
            r = await gen.purgeBook(getPool(), bookId);
        } catch (err) {
            if (err && err.code === '42P01') return { skipped: 'no_gen_tables' };   // v2 schema never created
            throw err;
        }
        let removed = 0;
        for (const build of r.build_ids) {
            const dir = path.join(outputDir, build, '.incoming');
            let names = [];
            try { names = fs.readdirSync(dir); } catch (_) { continue; }
            for (const name of names) {
                if (!r.job_ids.some((id) => name.startsWith(id) || name.startsWith(`merge-${id}`))) continue;
                try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); removed += 1; } catch (_) { /* best effort */ }
            }
        }
        return { ...r, incoming_removed: removed };
    }

    /**
     * Stop every v2 command / job of the book (DELETE /book/:id/cache — the v2
     * counterpart of the hub queue clear). Master flag off → nothing runs → null.
     */
    async function cancelBook(bookId, cancelledBy) {
        if (!host.isEnabled()) return null;
        return host.orch().cancel({ bookId }, { cancelledBy: cancelledBy || 'cache-clear' });
    }

    // ── generate API v2 (ADR §11.1, этап 2; 2026-11-27) ──────────────────
    // Thin wrappers over the same core calls as the legacy names above:
    //   POST /generate          ≈ /regenerate      (createCommand; mode all = force)
    //   POST /generate/stop     ≈ cancel-worker / cancel-generation (cancel by command / layer / book)
    //   GET  /generate/progress ≈ progress-panel   (ADR §9 aggregate, new format)
    //   GET  /generate/stream   ≈ progress-stream  (SSE from LISTEN gen_progress, no Redis)
    // Access: the /api/v1/book/:bookId guard of the composition root (as /regenerate).
    // Errors: {code, error} (sendGenError), as the v2 leg of /regenerate.
    // A legacy book → 409 book_not_v2 (as voice-routes); the legacy names keep working unchanged.

    let material = null;   // helpers/book-text.cjs, set by mountGenerateRoutes
    const notV2 = (res, bookId) => res.status(409).json({ code: 'book_not_v2', error: `book ${bookId} is not on orchestration v2 (books.orchestration = v2)` });
    const bad = (res, error, code = 'bad_request') => res.status(400).json({ code, error });
    const GENERATE_MODES = Object.freeze(['missing', 'all']);
    const SCOPE_KEYS = Object.freeze(['level', 'chapter_id', 'scene_id', 'scene_ids', 'unit_id', 'unit_key']);

    /** /generate body.scope → the core scope (or {status, error}). */
    function generateScope(bookId, raw) {
        if (raw === undefined) return { scope: { level: 'book' } };
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { status: 400, error: { code: 'bad_request', error: 'scope must be an object {level, …}' } };
        const level = raw.level;
        if (level === FROM_CURRENT_SCENE) return expandFromCurrentScene(bookId, raw);
        if (!['book', 'chapter', 'scenes', 'scene', 'unit'].includes(level)) {
            return { status: 400, error: { code: 'bad_request', error: 'scope.level must be book|chapter|scenes|scene|unit|from_current_scene' } };
        }
        const scope = { level };
        for (const k of SCOPE_KEYS) if (k !== 'level' && raw[k] !== undefined && raw[k] !== null) scope[k] = raw[k];
        // ADR §11.1 names the unit `unit_key`; the core field is unit_id
        if (scope.unit_key !== undefined) { if (scope.unit_id === undefined) scope.unit_id = scope.unit_key; delete scope.unit_key; }
        return { scope };   // the core (normaliseScope) validates the rest → 400 bad_request
    }

    async function ownerOf(req, bookId) {
        const workspaceId = await bookRepo.getWorkspaceId(bookId);
        if (!workspaceId) return { error: { status: 409, body: { code: 'book_without_workspace', error: 'book has no workspace' } } };
        let userId = userIdOf(req);
        if (!userId) {
            const ws = await require('../storage/postgres/repositories/workspace-repo').findById(workspaceId).catch(() => null);
            userId = ws && ws.owner_user_id ? ws.owner_user_id : null;
        }
        if (!userId) return { error: { status: 401, body: { code: 'unauthorized', error: 'no user for the command' } } };
        return { workspaceId, userId };
    }

    async function generate(req, res) {
        const { bookId } = req.params;
        try {
            if (!(await host.isV2Book(bookId))) return notV2(res, bookId);
            if (!host.isEnabled()) return res.status(409).json({ code: 'orch_v2_disabled', error: host.disabledReason() || 'orchestration v2 is disabled' });
            const body = req.body || {};
            const mode = body.mode === undefined || body.mode === null ? 'missing' : body.mode;
            if (!GENERATE_MODES.includes(mode)) return bad(res, 'mode must be "missing" or "all"');
            const clientActionId = typeof body.client_action_id === 'string' ? body.client_action_id.trim() : '';
            if (!clientActionId) return bad(res, 'client_action_id (one per click) is required', 'client_action_id_required');
            if (clientActionId.length > 200) return bad(res, 'client_action_id: at most 200 characters');
            const types = body.layers;
            if (!Array.isArray(types) || types.length === 0 || types.some((t) => !ALL_LAYERS.includes(t))) {
                return bad(res, 'layers must be a non-empty array of audio, image, video');
            }
            // the /regenerate «nothing to generate» guard (helpers/book-text.cjs)
            if (material) {
                const loaded = book && typeof book.loadBook === 'function' ? book.loadBook(bookId) : null;
                if (loaded && material.nothingToGenerate(loaded, types)) {
                    log(`[GENERATE] ${bookId}: refused — book_has_no_text (layers=${types.join(',')})`);
                    return res.status(422).json({ ...material.BOOK_HAS_NO_TEXT });
                }
            }
            const sc = generateScope(bookId, body.scope);
            if (sc.error) return res.status(sc.status).json(sc.error);
            const scope = sc.scope;

            // layer availability — the same rules as the v2 leg of /regenerate
            const requested = [...new Set(types)];
            const videoWhy = host.videoUnsupportedReason ? host.videoUnsupportedReason() : 'host without video support';
            const supported = videoWhy ? BASE_V2_LAYERS : [...BASE_V2_LAYERS, 'video'];
            const unsupported = requested.filter((t) => !supported.includes(t));
            const layers = requested.filter((t) => supported.includes(t));
            if (!layers.length) {
                return res.status(409).json({ code: 'v2_video_unavailable', error: `video layer is unavailable on orchestration v2: ${videoWhy}`, layers: unsupported });
            }
            if (layers.includes('image')) {
                const why = host.imageUnsupportedReason ? host.imageUnsupportedReason() : 'host without image support';
                if (why) return res.status(409).json({ code: 'v2_image_unavailable', error: `image layer is unavailable on orchestration v2: ${why}`, layers: ['image'] });
            }
            const owner = await ownerOf(req, bookId);
            if (owner.error) return res.status(owner.error.status).json(owner.error.body);
            const cfg = await layerConfig.get(bookId);
            const enabledLayers = ALL_LAYERS.filter((l) => cfg[`${l}_enabled`] !== false);
            const r = await host.orch().createCommand({
                workspaceId: owner.workspaceId, userId: owner.userId, bookId, kind: 'regenerate', scope, layers,
                force: mode === 'all', clientActionId, enabledLayers,
            });
            // a repeated click answers the FIRST command (its mode, layers, summary)
            let cmdMode = mode;
            if (r.existing) {
                const row = await host.commandRow(r.command_id).catch(() => null);
                if (row) cmdMode = row.force ? 'all' : 'missing';
            }
            const summary = unsupported.length ? { ...r.summary, skipped_unsupported: unsupported } : r.summary;
            const scopeLog = scope.level === 'scenes' ? `scenes[${scope.scene_ids.length}] from ${scope.scene_ids[0]}` : scope.level;
            log(`[GENERATE] ${bookId}: command ${r.command_id} ${r.existing ? '(existing, repeated click)' : 'created'} mode=${cmdMode} layers=${r.layers.join(',')} scope=${scopeLog} summary=${JSON.stringify(summary)} client_action_id=${clientActionId}`);
            return res.json({
                book_id: bookId,
                orchestration: 'v2',
                command_id: r.command_id,
                existing: r.existing === true,
                status: r.status,
                mode: cmdMode,
                layers: r.layers,
                scope,
                summary,
                // requested but not run: unsupported by the host (video) + disabled in layer-config
                skipped_layers: requested.filter((t) => !r.layers.includes(t)),
            });
        } catch (err) {
            if (err && err.code === 'layer_disabled') {
                return res.status(409).json({ code: 'layer_disabled', error: 'all requested layers are disabled in layer-config', disabled_layers: Array.isArray(req.body && req.body.layers) ? req.body.layers : [] });
            }
            return sendGenError(res, err, 'generate');
        }
    }

    async function generateStop(req, res) {
        const { bookId } = req.params;
        try {
            if (!(await host.isV2Book(bookId))) return notV2(res, bookId);
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const hasCommand = body.command_id !== undefined && body.command_id !== null;
            const hasLayer = body.layer !== undefined && body.layer !== null;
            if (hasCommand && hasLayer) return bad(res, 'stop takes {command_id} or {layer} or {} (whole book), not both');
            const by = userIdOf(req) || 'generate-stop';
            if (hasCommand) {
                const commandId = String(body.command_id);
                if (!UUID_RE.test(commandId)) return bad(res, 'command_id must be a UUID');
                if (!host.isEnabled()) return res.status(409).json({ code: 'orch_v2_disabled', error: host.disabledReason() || 'orchestration v2 is disabled' });
                const row = await host.commandRow(commandId);
                if (!row || row.book_id !== bookId) return res.status(404).json({ code: 'command_not_found', error: `command ${commandId} is not a command of book ${bookId}` });
                const r = await host.orch().cancel({ commandId }, { cancelledBy: by });
                log(`[GENERATE-STOP] ${bookId}: command ${commandId} — ${r.commands_cancelled} command(s), ${r.jobs_cancelled} job(s) cancelled, ${r.kept_shared} kept (shared)`);
                return res.json({
                    ok: true, book_id: bookId, target: 'command', command_id: commandId,
                    commands_cancelled: r.commands_cancelled, jobs_cancelled: r.jobs_cancelled, kept_shared: r.kept_shared, layers: r.layers || [],
                });
            }
            if (hasLayer) {
                if (!ALL_LAYERS.includes(body.layer)) return bad(res, 'layer must be audio, image or video');
                let n = 0;
                if (host.isEnabled()) n = (await host.orch().cancel({ bookId, layer: body.layer }, { cancelledBy: by })).jobs_cancelled;
                log(`[GENERATE-STOP] ${bookId}: layer ${body.layer} — ${n} job(s) cancelled`);
                return res.json({ ok: true, book_id: bookId, target: 'layer', layer: body.layer, commands_cancelled: 0, jobs_cancelled: n });
            }
            let r = { commands_cancelled: 0, jobs_cancelled: 0 };
            if (host.isEnabled()) r = await host.orch().cancel({ bookId }, { cancelledBy: by });
            // VBook (LLM) is not orchestration work — the book stop stops it as cancel-generation does
            let vbookCancelled = false;
            if (sessionControl) {
                try { await sessionControl.cancelSessions(bookId); vbookCancelled = true; } catch (e) { console.warn(`[GENERATE-STOP] VBook cancel failed: ${e.message}`); }
            }
            log(`[GENERATE-STOP] ${bookId}: book — ${r.commands_cancelled} command(s), ${r.jobs_cancelled} job(s) cancelled`);
            return res.json({ ok: true, book_id: bookId, target: 'book', commands_cancelled: r.commands_cancelled, jobs_cancelled: r.jobs_cancelled, vbook_cancelled: vbookCancelled });
        } catch (err) { return sendGenError(res, err, 'generate-stop'); }
    }

    const emptyAggregate = (bookId) => ({
        book_id: bookId, orchestration: 'v2', generated_at: new Date().toISOString(), active: false,
        totals: { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, retrying: 0, joined_queued: 0, joined_running: 0 },
        commands: [], disabled: true,
    });

    async function generateProgress(req, res) {
        const { bookId } = req.params;
        try {
            if (!(await host.isV2Book(bookId))) return notV2(res, bookId);
            if (!host.isEnabled() || !host.progress()) return res.json(emptyAggregate(bookId));
            return res.json(await host.progress().aggregate(bookId));
        } catch (err) { return sendGenError(res, err, 'generate-progress'); }
    }

    const SSE_HEARTBEAT_MS = 15_000;
    async function generateStream(req, res) {
        const { bookId } = req.params;
        try {
            if (!(await host.isV2Book(bookId))) return notV2(res, bookId);
        } catch (err) { return sendGenError(res, err, 'generate-stream'); }
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');   // nginx: no buffering
        res.flushHeaders?.();
        let closed = false;
        const send = (payload) => { if (!closed) { try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) { /* gone */ } } };
        res.write('retry: 3000\n\n');
        let off = null;
        const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) { /* gone */ } }, SSE_HEARTBEAT_MS);
        const cleanup = () => {
            if (closed) return;
            closed = true;
            clearInterval(heartbeat);
            if (off) { off(); off = null; }
        };
        req.on('close', cleanup);
        res.on('error', cleanup);
        const hub = host.isEnabled() ? host.progressHub() : null;
        if (!hub) { send({ type: 'gen_progress', reason: 'connect', command_ids: [], progress: emptyAggregate(bookId) }); return undefined; }
        try {
            // connect AND reconnect: the fresh §9 aggregate first, then one per NOTIFY
            const unsubscribe = await hub.subscribeAggregate(bookId, send);
            if (closed) unsubscribe(); else off = unsubscribe;
        } catch (err) {
            console.warn(`[GENERATE-STREAM] ${bookId}: initial aggregate failed: ${err && err.message}`);
            send({ type: 'error', code: 'progress_unavailable', error: (err && err.message) || 'error' });
            cleanup();
            try { res.end(); } catch (_) { /* gone */ }
        }
        return undefined;
    }

    /**
     * Mount the four /generate endpoints (composition root, AFTER the
     * /api/v1/book/:bookId access guard — the same guard as /regenerate).
     * generationMaterial: the /regenerate «nothing to generate» guard (helpers/book-text.cjs).
     */
    function mountGenerateRoutes(app, { generationMaterial = null } = {}) {
        material = generationMaterial;
        app.post('/api/v1/book/:bookId/generate', generate);
        app.post('/api/v1/book/:bookId/generate/stop', generateStop);
        app.get('/api/v1/book/:bookId/generate/progress', generateProgress);
        app.get('/api/v1/book/:bookId/generate/stream', generateStream);
        log('[ROUTES] orchestration v2 generate API loaded (/api/v1/book/:bookId/generate, /stop, /progress, /stream)');
    }

    /** Old GET /progress-stream of a v2 book (until step 5): the old event shapes, from the in-process hub. */
    function subscribeLegacyProgress(bookId, fn) {
        const hub = host.isEnabled() && host.progressHub ? host.progressHub() : null;
        return hub ? hub.subscribeLegacy(bookId, fn) : null;
    }

    return {
        mountInternal, mountGenerateRoutes, regenerate, cancelGeneration, cancelWorker, onLayersDisabled, progressPanel, purgeBook, cancelBook,
        generate, generateStop, generateProgress, generateStream, subscribeLegacyProgress, isV2Book: host.isV2Book,
    };
}

module.exports = { createV2Routes, LEGACY_TO_SCOPE, sendGenError };
