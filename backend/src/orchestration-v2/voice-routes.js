// ======================================================
// orchestration-v2/voice-routes — voice references API (VOICE_REFERENCES.md)
// ======================================================
// Book-scoped (the /api/v1/book/:bookId guard of backend.cjs applies):
//   GET    /api/v1/book/:bookId/voices/references
//          → voices with description, reference status and candidates
//   POST   /api/v1/book/:bookId/voices/references/candidates
//          {character_ids?:[…], count?:3, client_action:{action_id}}  — explicit command
//   POST   /api/v1/book/:bookId/voices/:voiceId/references/upload   raw audio body (wav/mp3/ogg/flac)
//          ?action_id=…                                              — explicit command
//   GET    /api/v1/book/:bookId/voices/:voiceId/references/candidates/:candId/audio
//   DELETE /api/v1/book/:bookId/voices/:voiceId/references/candidates/:candId
//   POST   /api/v1/book/:bookId/voices/:voiceId/reference  {candidate_id, ref_text?}  select + lock
//   DELETE /api/v1/book/:bookId/voices/:voiceId/reference                             unlock (remove)
// Generation happens ONLY on an explicit command (COMMAND_ONLY_GENERATION):
// both POSTs that create GPU work require a client action id.
// Books on legacy orchestration get 409 book_not_v2 (no voice references there).

'use strict';

const fs = require('fs');
const express = require('express');
const voicePort = require('@animastor/vbook-runtime/voice');
const { VoiceReferenceError, phraseForVoice, MIN_DURATION_SEC, MAX_DURATION_SEC } = require('../audio/voice-references');
const { sendGenError } = require('./routes');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mountVoiceRoutes(app, { host, editorModel, bookRepo, getPool, log = console.log }) {
    const refs = () => host.voiceRefs();
    const fail = (res, err, ctx) => sendGenError(res, err, `voice-references ${ctx}`);

    function userIdOf(req) {
        const u = req.user && (req.user.user_id || req.user.id);
        if (u && UUID_RE.test(String(u))) return String(u);
        const g = req.guest && req.guest.guestId;
        return g && UUID_RE.test(String(g)) ? String(g) : null;
    }

    async function requireV2(bookId) {
        if (!host.isEnabled()) throw new VoiceReferenceError('orch_v2_disabled', 503, host.disabledReason() || 'orchestration v2 is disabled');
        if (!(await host.isV2Book(bookId))) throw new VoiceReferenceError('book_not_v2', 409, 'voice references need orchestration v2 (books.orchestration = v2)');
    }

    function loadBook(bookId) {
        const b = editorModel.read(bookId);
        if (!b) throw new VoiceReferenceError('book_not_found', 404, `book ${bookId} not found`);
        return b;
    }

    async function commandOwner(req, bookId) {
        const workspaceId = await bookRepo.getWorkspaceId(bookId);
        if (!workspaceId) throw new VoiceReferenceError('book_without_workspace', 409, 'book has no workspace');
        let userId = userIdOf(req);
        if (!userId) {
            const ws = await require('../storage/postgres/repositories/workspace-repo').findById(workspaceId).catch(() => null);
            userId = ws && ws.owner_user_id ? ws.owner_user_id : null;
        }
        if (!userId) throw new VoiceReferenceError('unauthorized', 401, 'no user for the command');
        return { workspaceId, userId };
    }

    /** pending candidates whose job ended without a result → failed (visible in the UI) */
    async function reconcilePending(loadedBook, bookId, voiceId, candidates) {
        const pending = candidates.filter((c) => c.status === 'pending').map((c) => c.candidate_id);
        if (!pending.length) return candidates;
        const rows = (await getPool().query(
            `SELECT DISTINCT ON (unit_key) unit_key, status, error FROM gen_jobs
             WHERE book_id = $1 AND kind = 'voice_reference' AND scene_id = $2 AND unit_key = ANY($3::text[])
             ORDER BY unit_key, created_at DESC`, [bookId, voiceId, pending])).rows;
        let changed = false;
        for (const r of rows) {
            if (r.status === 'failed' || r.status === 'cancelled') {
                refs().markCandidateFailed(refs().buildIdOf(loadedBook), voiceId, r.unit_key, r.error || r.status);
                changed = true;
            }
        }
        return changed ? refs().listCandidates(loadedBook, voiceId) : candidates;
    }

    // ── list ────────────────────────────────────────────────────────────
    app.get('/api/v1/book/:bookId/voices/references', async (req, res) => {
        const { bookId } = req.params;
        try {
            await requireV2(bookId);
            const b = loadBook(bookId);
            const voices = [];
            for (const id of voicePort.listVoiceIds(b)) {
                const v = voicePort.getCharacterVoice(b, id);
                const st = refs().referenceStatus(b, id);
                let phrase = null;
                try { const p = phraseForVoice(b, id); phrase = { id: p.id, version: p.version, style: p.style, text: p.text, language: p.language }; } catch (_) { /* language unsupported */ }
                voices.push({
                    id,
                    timbre: v.timbre,
                    manner: v.manner,
                    timbre_source: v.timbre_source,
                    design_description: voicePort.voiceDesignDescription(v),
                    reference: v.reference,
                    reference_status: st.status,
                    phrase,
                    candidates: await reconcilePending(b, bookId, id, refs().listCandidates(b, id)),
                });
            }
            return res.json({
                book_id: bookId, language: (b.book && b.book.language) || null,
                duration_bounds_sec: [MIN_DURATION_SEC, MAX_DURATION_SEC], voices,
            });
        } catch (err) { return fail(res, err, 'list'); }
    });

    // ── create candidates (explicit command) ────────────────────────────
    app.post('/api/v1/book/:bookId/voices/references/candidates', async (req, res) => {
        const { bookId } = req.params;
        const body = req.body || {};
        try {
            const ca = body.client_action && typeof body.client_action === 'object' ? body.client_action : null;
            const actionId = ca && typeof ca.action_id === 'string' && ca.action_id ? ca.action_id.slice(0, 200) : null;
            if (!actionId) return res.status(400).json({ code: 'no_user_action', error: 'voice candidates are created only by an explicit user action (client_action.action_id)' });
            await requireV2(bookId);
            const b = loadBook(bookId);
            const all = voicePort.listVoiceIds(b);
            let ids;
            if (Array.isArray(body.character_ids) && body.character_ids.length) {
                ids = [...new Set(body.character_ids.map(String))];
                const unknown = ids.filter((id) => !all.includes(id));
                if (unknown.length) return res.status(404).json({ code: 'voice_not_found', error: `unknown voices: ${unknown.join(', ')}`, character_ids: unknown });
                const locked = ids.filter((id) => refs().referenceStatus(b, id).status === 'ok');
                if (locked.length) {
                    return res.status(409).json({ code: 'reference_locked', error: `locked reference present (unlock first): ${locked.join(', ')}`, character_ids: locked });
                }
            } else {
                ids = all.filter((id) => refs().referenceStatus(b, id).status !== 'ok');   // «Создать референсы голосов» — the missing ones
            }
            if (!ids.length) return res.json({ book_id: bookId, command_id: null, character_ids: [], summary: { jobs_created: 0 } });
            const owner = await commandOwner(req, bookId);
            const r = await host.orch().createCommand({
                ...owner, bookId, kind: 'voice_reference', layers: ['audio'], clientActionId: actionId,
                scope: { level: 'book', voice: { mode: 'design', character_ids: ids, count: body.count } },
            });
            log(`[VOICE-REF] ${bookId}: candidates command ${r.command_id} ${r.existing ? '(repeated click)' : 'created'} voices=${ids.join(',')} summary=${JSON.stringify(r.summary)}`);
            return res.json({ book_id: bookId, command_id: r.command_id, existing: r.existing, character_ids: ids, summary: r.summary });
        } catch (err) { return fail(res, err, 'candidates'); }
    });

    // ── upload own sample (explicit command) ────────────────────────────
    app.post('/api/v1/book/:bookId/voices/:voiceId/references/upload',
        express.raw({ type: ['audio/*'], limit: '20mb' }),
        async (req, res) => {
            const { bookId, voiceId } = req.params;
            try {
                const actionId = typeof req.query.action_id === 'string' && req.query.action_id ? req.query.action_id.slice(0, 200) : null;
                if (!actionId) return res.status(400).json({ code: 'no_user_action', error: 'upload is accepted only from an explicit user action (?action_id=…)' });
                await requireV2(bookId);
                const b = loadBook(bookId);
                if (refs().referenceStatus(b, voiceId).status === 'ok') {
                    return res.status(409).json({ code: 'reference_locked', error: 'locked reference present (unlock first)', character_ids: [voiceId] });
                }
                const scopeVoice = refs().storeUpload(b, voiceId, req.body, req.headers['content-type']);
                const owner = await commandOwner(req, bookId);
                const r = await host.orch().createCommand({
                    ...owner, bookId, kind: 'voice_reference', layers: ['audio'], clientActionId: actionId,
                    scope: { level: 'book', voice: scopeVoice },
                });
                log(`[VOICE-REF] ${bookId}/${voiceId}: upload ${scopeVoice.candidate_id} (${scopeVoice.upload.bytes} B) → command ${r.command_id}`);
                return res.json({ book_id: bookId, command_id: r.command_id, candidate_id: scopeVoice.candidate_id, summary: r.summary });
            } catch (err) { return fail(res, err, 'upload'); }
        });

    // ── listen ──────────────────────────────────────────────────────────
    app.get('/api/v1/book/:bookId/voices/:voiceId/references/candidates/:candId/audio', async (req, res) => {
        const { bookId, voiceId, candId } = req.params;
        try {
            const b = loadBook(bookId);
            const p = refs().paths.candidateWav(refs().buildIdOf(b), voiceId, candId);
            if (!fs.existsSync(p)) return res.status(404).json({ code: 'not_found', error: 'candidate audio not found' });
            res.setHeader('Content-Type', 'audio/wav');
            res.setHeader('Cache-Control', 'no-store');
            return fs.createReadStream(p).pipe(res);
        } catch (err) { return fail(res, err, 'audio'); }
    });

    // ── delete candidate ────────────────────────────────────────────────
    app.delete('/api/v1/book/:bookId/voices/:voiceId/references/candidates/:candId', async (req, res) => {
        const { bookId, voiceId, candId } = req.params;
        try {
            const b = loadBook(bookId);
            refs().deleteCandidate(b, voiceId, candId);
            return res.json({ deleted: true, book_id: bookId, voice_id: voiceId, candidate_id: candId });
        } catch (err) { return fail(res, err, 'delete'); }
    });

    // ── select + lock ───────────────────────────────────────────────────
    app.post('/api/v1/book/:bookId/voices/:voiceId/reference', async (req, res) => {
        const { bookId, voiceId } = req.params;
        const body = req.body || {};
        try {
            await requireV2(bookId);
            const b = loadBook(bookId);
            if (typeof body.candidate_id !== 'string') return res.status(400).json({ code: 'bad_request', error: 'candidate_id required' });
            const reference = refs().selectCandidate(b, voiceId, body.candidate_id, { refText: body.ref_text });
            editorModel.commit(b, null);
            log(`[VOICE-REF] ${bookId}/${voiceId}: locked ${reference.candidate_id} sha=${reference.sha256.slice(0, 12)} source=${reference.source}`);
            return res.json({ saved: true, book_id: bookId, voice_id: voiceId, reference });
        } catch (err) { return fail(res, err, 'select'); }
    });

    // ── unlock (remove the reference; candidate files stay) ─────────────
    app.delete('/api/v1/book/:bookId/voices/:voiceId/reference', async (req, res) => {
        const { bookId, voiceId } = req.params;
        try {
            const b = loadBook(bookId);
            voicePort.setCharacterVoiceReference(b, voiceId, null);
            editorModel.commit(b, null);
            log(`[VOICE-REF] ${bookId}/${voiceId}: reference unlocked`);
            return res.json({ saved: true, book_id: bookId, voice_id: voiceId, reference: null });
        } catch (err) {
            if (err && err.code === 'voice_not_found') return res.status(404).json({ code: err.code, error: err.message });
            return fail(res, err, 'unlock');
        }
    });
}

module.exports = { mountVoiceRoutes };
