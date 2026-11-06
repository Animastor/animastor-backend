// ======================================================
// orchestration-v2/routes — HTTP surface of the gen core (ADR §6, §7, §8)
// ======================================================
// 1. Internal (worker / hub) — mounted by the composition root:
//      POST /internal/gen/claim                 x-api-key (GPU_HUB_API_KEY, REQUIRED)
//      POST /internal/gen/beacon                x-api-key
//      PUT  /internal/gen/jobs/:id/result?attempt=N   Bearer upload_token, raw body stream
//      POST /internal/gen/jobs/:id/error?attempt=N    Bearer upload_token, JSON
//    No key / token → 401. Master flag off → 503 {code:'orch_v2_disabled'}.
// 2. Book handlers for books.orchestration='v2' — the existing routes call
//    them first (deps.orchV2); legacy books never reach this file.

'use strict';

const fs = require('fs');
const path = require('path');

const { scopeBounds } = require('../services/gen-scope');

const LEGACY_TO_SCOPE = Object.freeze({ whole_book: 'book', current_chapter: 'chapter', current_scene: 'scene' });
const FROM_CURRENT_SCENE = 'from_current_scene';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendGenError(res, err, context) {
    const status = Number(err && err.status) || 500;
    if (status >= 500) console.error(`[ORCH-V2] ${context}: ${err && err.message}`);
    return res.status(status).json({ code: (err && err.code) || 'internal', error: (err && err.message) || 'error' });
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
                return res.json({
                    task: {
                        ...t,
                        protocol_version: 3,
                        job_type: w.worker_type,
                        upload_url: host.uploadUrl(t.job_id, t.attempt),
                        error_url: host.errorUrl(t.job_id, t.attempt),
                    },
                });
            } catch (err) { return sendGenError(res, err, 'claim'); }
        });

        app.post('/internal/gen/beacon', requireHubKey, async (req, res) => {
            if (!host.isEnabled()) return disabled(res);
            try {
                const b = req.body || {};
                if (!UUID_RE.test(String(b.worker_id || ''))) return res.status(400).json({ code: 'bad_request', error: 'worker_id required' });
                const r = await host.orch().beacon(b.worker_id, { current_job_id: b.current_job_id || null });
                return res.json({ cancel: r.cancel });
            } catch (err) { return sendGenError(res, err, 'beacon'); }
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
        if (!Array.isArray(types) || types.length === 0) {
            return res.status(400).json({ error: 'worker_types must be a non-empty array containing audio, image, or video' });
        }
        const unsupported = [...new Set(types)].filter((t) => t !== 'audio');
        if (unsupported.length) {
            return res.status(409).json({ code: 'v2_layer_not_supported_yet', error: `orchestration v2 (stage 1) supports audio only`, worker_types: unsupported });
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
            const cfg = await layerConfig.get(redis, bookId);
            const enabledLayers = ['audio', 'image', 'video'].filter((l) => cfg[`${l}_enabled`] !== false);
            const ca = body.client_action && typeof body.client_action === 'object' ? body.client_action : null;
            const clientActionId = ca && typeof ca.action_id === 'string' && ca.action_id ? ca.action_id.slice(0, 200) : null;
            const r = await host.orch().createCommand({
                workspaceId, userId, bookId, kind: 'regenerate', scope, layers: ['audio'],
                force: body.rebuild_all === true || body.force === true,
                clientActionId, enabledLayers,
            });
            const loaded = book && typeof book.loadBook === 'function' ? book.loadBook(bookId) : null;
            const scopeLog = scope.level === 'scenes' ? `${legacyScope}→scenes[${scope.scene_ids.length}] from ${scope.scene_ids[0]}` : legacyScope;
            log(`[REGENERATE] ${bookId}: orchestration v2 command ${r.command_id} ${r.existing ? '(existing, repeated click)' : 'created'} scope=${scopeLog} summary=${JSON.stringify(r.summary)} client_action_id=${clientActionId || '-'}`);
            return res.json({
                book_id: bookId,
                orchestration: 'v2',
                command_id: r.command_id,
                existing: r.existing,
                summary: r.summary,
                scope: legacyScope,
                build_id: (loaded && loaded.manifest && loaded.manifest.build_id) || 'default',
                dirty_scenes: [],
                skipped_worker_types: [],
                tasks: [{ task_id: r.command_id, type: 'audio', target_count: r.summary.jobs_created + r.summary.joined }],
            });
        } catch (err) {
            if (err && err.code === 'layer_disabled') {
                return res.status(409).json({ error: 'layer_disabled', message: 'All requested layers are disabled in layer-config', disabled_worker_types: ['audio'] });
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
                return res.json({ ok: true, book_id: bookId, cancelled: ['audio'], task_ids: [String(taskId)], jobs_cancelled: r.jobs_cancelled, kept_shared: r.kept_shared });
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

    return { mountInternal, regenerate, cancelGeneration, cancelWorker, onLayersDisabled, progressPanel, purgeBook, cancelBook, isV2Book: host.isV2Book };
}

module.exports = { createV2Routes, LEGACY_TO_SCOPE };
