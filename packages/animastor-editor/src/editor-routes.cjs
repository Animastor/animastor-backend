// ======================================================
// EDITOR ROUTES — Core Book GET/PUT/PATCH/DELETE + Cover
// ======================================================
// Editor contour (@animastor/editor — Phase 4 physical move;
// docs/architecture/editor-module-extraction-audit.md §13/§Phase 4).
// Moved byte-for-byte from routes/book/core-routes.cjs (route split,
// the 4d1f6f0e playbook): same endpoints, same handlers, same HTTP
// semantics. Host implementation modules (PG repos, services, agent
// constants) no longer land here via direct requires — they arrive via
// the editorPorts seam wired at the composition root
// (src/editor-ports.cjs), the playerPorts analog.
//
// 8 endpoints: GET book, GET source-coverage, GET cover, PUT book,
// PATCH scene/metadata/locations, DELETE book (VBook 4 step 4 removed
// PATCH characters/voices/behaviors — heroes: ./hero-routes.cjs).

const { setDeep, findUnitInScene, normalizeFieldValue, rebuildFullText } = require('./scene-patch-utils.cjs');
// VBook 4 (VBOOK_FORMAT_V4): the model is { manifest, book, bible, locations,
// behaviour, heroes, hero_issues, chapters }. Heroes are edited through the
// hero routes (./hero-routes.cjs); the 3.1 routes /characters, /voices,
// /behaviors are gone (step 4).
const { legacyBodyKeys, enrichHero, stripComputed } = require('./hero-api.cjs');
const { joinInside, isValidBuildId } = require('@animastor/vbook-runtime/safe-paths');
const {
    isUnsupportedVersionError, unsupportedVersionBody,
} = require('@animastor/vbook-runtime/vbook-version.cjs');

function requestLanguage(req) {
    const header = req && req.headers ? req.headers['accept-language'] : '';
    return /^\s*ru/i.test(String(header || '')) ? 'ru' : 'en';
}

// ── Editor-save prompt guard ─────────────────────────────────────────
// A frame prompt (image.prompt / video.action) longer than the ceiling is almost
// always a stray paste ("collected a wall of text and hit Save"). Reject it at the
// boundary with a clear message instead of silently truncating — truncation would
// let downstream polish passes rewrite the unseen part (see the
// IMAGE_PROMPT_MAX_CHARS policy in agent-prompts.js — the constant now
// flows through the editorPorts.promptLimit seam; the policy doc stays
// host-side).

module.exports = function(app, redis, deps) {
    const {
        book, bookDiff, storage, bookDeletion, editorModel,
        editorPorts, utils,
    } = deps;
    const { log } = utils;

    // Host legs via the port object (composition root wires the same
    // function references the pre-split code required directly).
    const sceneAssetsRepo = editorPorts.sceneAssetsRepo;
    const sourceCoverageAudit = editorPorts.auditCoverage;
    const IMAGE_PROMPT_MAX_CHARS = editorPorts.promptLimit;
    const PROMPT_PATH_KEYS = new Set(['image.prompt', 'visual.prompt', 'video.action']);

    // <outputRoot>/<build_id> — where a hero's reference files live (read only).
    function buildDirOf(bookData) {
        const root = editorPorts.outputRoot;
        const buildId = bookData && bookData.manifest && bookData.manifest.build_id;
        if (!root || !isValidBuildId(buildId)) return null;
        try { return joinInside(root, buildId); } catch (_) { return null; }
    }

    function promptLengthError(field, value) {
        return `Field "${field}" is ${value.length} chars — exceeds the ${IMAGE_PROMPT_MAX_CHARS}-char limit for a frame prompt. It looks like a large text block was pasted in; please shorten it.`;
    }

    function assertPromptLength(field, value) {
        if (typeof value === 'string' && value.length > IMAGE_PROMPT_MAX_CHARS) {
            const err = new Error(promptLengthError(field, value));
            err.statusCode = 400;
            throw err;
        }
    }

    // ── scene look fields (VBOOK_FORMAT_V4 §4a.3, §4a.4) ──────────────
    const LOOK_PATCH_FIELDS = ['appearance', 'clothes', 'video_tokens'];
    const SNAKE_ID = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
    function sceneLookKeyProblem(key, value) {
        const parts = key.split('.');
        if (parts[0] === 'looks') {
            if (parts.length !== 2 || !SNAKE_ID.test(parts[1])) return 'looks.<hero_id>';
            if (value !== null && value !== '' && (typeof value !== 'string' || (value !== 'base' && !SNAKE_ID.test(value)))) {
                return 'looks.<hero_id>: a look id, "base" or null';
            }
            return null;
        }
        if (parts[0] === 'look_patch') {
            if (parts.length !== 3 || !SNAKE_ID.test(parts[1]) || !LOOK_PATCH_FIELDS.includes(parts[2])) {
                return `look_patch.<hero_id>.<${LOOK_PATCH_FIELDS.join('|')}>`;
            }
            return null;
        }
        return null;
    }
    /** Set or (null / '') remove one look field of a scene; empty maps are dropped. */
    function setSceneLookField(sceneObj, key, value) {
        const parts = key.split('.');
        const v = normalizeFieldValue(key, value);
        const map = parts[0];
        if (parts.length === 2) {
            if (v === null || v === undefined) {
                if (sceneObj[map]) delete sceneObj[map][parts[1]];
            } else {
                if (!sceneObj[map] || typeof sceneObj[map] !== 'object') sceneObj[map] = {};
                sceneObj[map][parts[1]] = v;
            }
        } else {
            const heroId = parts[1];
            const field = parts[2];
            if (v === null || v === undefined) {
                if (sceneObj[map] && sceneObj[map][heroId]) {
                    delete sceneObj[map][heroId][field];
                    if (Object.keys(sceneObj[map][heroId]).length === 0) delete sceneObj[map][heroId];
                }
            } else {
                if (!sceneObj[map] || typeof sceneObj[map] !== 'object') sceneObj[map] = {};
                if (!sceneObj[map][heroId] || typeof sceneObj[map][heroId] !== 'object') sceneObj[map][heroId] = {};
                sceneObj[map][heroId][field] = v;
            }
        }
        if (sceneObj[map] && typeof sceneObj[map] === 'object' && Object.keys(sceneObj[map]).length === 0) delete sceneObj[map];
    }

    function findOversizedPromptInScene(sceneObj) {
        const units = sceneObj && Array.isArray(sceneObj.units) ? sceneObj.units : [];
        for (let i = 0; i < units.length; i++) {
            const u = units[i] || {};
            for (const field of PROMPT_PATH_KEYS) {
                const [a, b] = field.split('.');
                const val = u[a] && u[a][b];
                if (typeof val === 'string' && val.length > IMAGE_PROMPT_MAX_CHARS) {
                    return { path: `units[${i}].${field}`, length: val.length };
                }
            }
        }
        return null;
    }

    // ======================================================
    // GET BOOK DATA
    // ======================================================
    app.get('/api/v1/book/:bookId', async (req, res) => {
        try {
            const { bookId } = req.params;
            let bookData;
            try {
                bookData = editorModel.read(bookId);
            } catch (readErr) {
                // A book that exists but is VBook 3.1 (or has no version, or is
                // newer): 409 with the same body the importer answers with
                // (VBOOK_FORMAT_V4 §9). Nothing on disk is touched.
                if (isUnsupportedVersionError(readErr)) {
                    return res.status(409).json(unsupportedVersionBody(readErr, requestLanguage(req)));
                }
                throw readErr;
            }
            if (!bookData) return res.status(404).json({ error: 'Book not found' });

            // ── Enrich chapters (F5+F7): fill missing chapter_title + compute display indices ──
            if (bookData.chapters && Array.isArray(bookData.chapters)) {
                let displayNum = 0;
                for (const ch of bookData.chapters) {
                    // F7: Fill chapter_title from chapter.intro.text if missing.
                    if (!ch.chapter_title && ch.intro && ch.intro.text) {
                        const separators = [' — ', ' – ', '. ', '! ', '? '];
                        for (const sep of separators) {
                            const idx = ch.intro.text.indexOf(sep);
                            if (idx > 0 && idx < ch.intro.text.length - sep.length) {
                                const candidate = ch.intro.text.substring(idx + sep.length).trim()
                                    .replace(/\.$/, '').replace(/!$/, '').replace(/\?$/, '').trim();
                                if (candidate) {
                                    ch.chapter_title = candidate;
                                    break;
                                }
                            }
                        }
                    }
                    // F5/N3: "special" chapters (cover/prologue) are not numbered and
                    // are labelled by type instead of "Chapter N". This business rule
                    // lives on the server; the client renders is_special, not the type.
                    ch.is_special = (ch.type === 'cover' || ch.type === 'prologue');
                    // F5: Compute display_number (1-based, excludes cover/prologue).
                    if (!ch.is_special) {
                        displayNum++;
                        ch.display_number = displayNum;
                    }
                    // F5: Compute display_index for each scene (1-based within chapter).
                    if (ch.scenes && Array.isArray(ch.scenes)) {
                        ch.scenes.forEach((sc, idx) => {
                            sc.display_index = idx + 1;
                        });
                    }
                }
            }

            // ── Thin-client contract: flat scene list in book order (F-thin) ──
            // Clients build playback queues and navigation from this list instead
            // of re-implementing chapter→scene traversal themselves. Cover is the
            // first entry with type "cover" — detection is centralized here too.
            bookData.scene_list = book.collectSceneList ? book.collectSceneList(bookData) : [];

            // 0.6.0 (ORCHESTRATION_V2 этап 4): GET /book is read-only — the
            // read-time repair (placeholder audio + Redis chunks, read-recovery)
            // was a legacy-orchestration leg and is removed.

            // VBook 4: the model — { manifest, book, bible, locations,
            // behaviour, heroes, hero_issues, chapters, scene_list }. There is
            // no compatible projection of characters / voices / behaviors (§1.5).
            // Heroes carry the computed fields of §8.2 (rev, voice.reference_state,
            // voice.reference_outdated, image_refs[].state) — never stored.
            const buildDir = buildDirOf(bookData);
            bookData.heroes = (bookData.heroes || []).map((h) => enrichHero(h, buildDir));
            return res.json(bookData);
        } catch (err) {
            console.error('[GET BOOK] Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/v1/book/:bookId/source-coverage', async (req, res) => {
        try {
            const { bookId } = req.params;
            const report = sourceCoverageAudit.auditBookCoverage(bookId);
            return res.json(report);
        } catch (err) {
            console.error('[SOURCE-COVERAGE] Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // UPDATE BOOK DATA (PUT — full replace with merge)
    // ======================================================
    app.put('/api/v1/book/:bookId', async (req, res) => {
        try {
            const { bookId } = req.params;
            const updatedBookData = req.body;
            if (!updatedBookData || !updatedBookData.manifest || !updatedBookData.manifest.book_id) {
                return res.status(400).json({ error: 'Invalid book data: manifest.book_id required' });
            }
            if (updatedBookData.manifest.book_id !== bookId) {
                return res.status(400).json({ error: 'bookId mismatch' });
            }

            // VBook 4 has no characters / voices / behaviors maps: a body that
            // still carries one comes from a 3.1 client and is refused as a
            // whole — never saved with those fields silently dropped.
            const legacy = legacyBodyKeys(updatedBookData);
            if (legacy.length > 0) {
                return res.status(400).json({
                    error: 'legacy_fields',
                    fields: legacy,
                    message: 'characters, voices and behaviors are not part of VBook 4 — heroes live in `heroes`',
                });
            }
            // hero_issues and the computed hero fields (rev, reference_state, …)
            // are computed on load and never stored.
            delete updatedBookData.hero_issues;
            delete updatedBookData.scene_list;
            if (Array.isArray(updatedBookData.heroes)) {
                updatedBookData.heroes = updatedBookData.heroes.map(stripComputed);
            }

            let oldBook;
            try {
                oldBook = editorModel.read(bookId);
            } catch (readErr) {
                if (isUnsupportedVersionError(readErr)) {
                    return res.status(409).json(unsupportedVersionBody(readErr, requestLanguage(req)));
                }
                throw readErr;
            }

            if (oldBook) {
                // A body without `heroes` does not change the cast. An EMPTY
                // list against a non-empty cast is a stale response, not a wish
                // to delete everyone (the same guard `characters` had) — §8.2.
                if (Array.isArray(updatedBookData.heroes) && updatedBookData.heroes.length === 0
                    && Array.isArray(oldBook.heroes) && oldBook.heroes.length > 0) {
                    return res.status(400).json({ error: 'heroes_empty', message: 'an empty heroes list would delete every hero of the book' });
                }
                if (updatedBookData.behaviour === undefined || updatedBookData.behaviour === null) {
                    delete updatedBookData.behaviour; // keep behaviour.json as it is on disk
                }
                if (!updatedBookData.bible || (typeof updatedBookData.bible === 'object' && Object.keys(updatedBookData.bible).length === 0)) {
                    if (oldBook.bible && Object.keys(oldBook.bible).length > 0) {
                        updatedBookData.bible = oldBook.bible;
                        log(`[UPDATE BOOK] ${bookId}: preserved bible data from existing book`);
                    }
                }
                if (!updatedBookData.manifest || !updatedBookData.manifest.book_id) {
                    if (oldBook.manifest && oldBook.manifest.book_id) {
                        updatedBookData.manifest = oldBook.manifest;
                        log(`[UPDATE BOOK] ${bookId}: preserved manifest from existing book`);
                    }
                }
            }

            // Editor-save guard: reject full-book saves carrying an oversized frame
            // prompt (stray paste) — otherwise polish passes would later rewrite the
            // unseen part of it (see the IMAGE_PROMPT_MAX_CHARS policy).
            for (const ch of (updatedBookData.chapters || [])) {
                for (const sc of (ch.scenes || [])) {
                    const oversized = findOversizedPromptInScene(sc);
                    if (oversized) {
                        return res.status(400).json({ error: promptLengthError(`chapters[${ch.chapter_id}].${oversized.path}`, oversized) });
                    }
                }
            }

            editorModel.commit(updatedBookData, null);
            log(`[UPDATE BOOK] ${bookId}: ${updatedBookData.chapters?.length || 0} chapters saved`);

            const newBook = editorModel.read(bookId) || updatedBookData;

            try {
                const diff = bookDiff.computeBookDiff(oldBook || { chapters: [] }, newBook);
                if (diff.dirty_scenes.length > 0) {
                    const syncResult = await storage.bookSync.reconcileFromDiff(bookId, diff.dirty_scenes, newBook);
                    log(`[UPDATE BOOK] ${bookId}: reconciled ${syncResult.reconciled} scenes`);

                    try {
                        await sceneAssetsRepo.bumpSceneVersions(bookId, diff.dirty_scenes);
                        for (const ds of diff.dirty_scenes) {
                            if (ds.reason === 'removed') continue;
                            if (ds.changes && typeof ds.changes === 'object') {
                                const crossKeys = Object.keys(ds.changes).filter(k =>
                                    k.includes('Character') || k.includes('Location') ||
                                    k.includes('characters') || k.includes('bible') ||
                                    k.includes('passport') || k.includes('voice')
                                );
                                if (crossKeys.length > 0) {
                                    log(`[CROSS-CUTTING] ${bookId}/${ds.chapter_id}/${ds.scene_id}: version bump triggered by ${crossKeys.join(', ')}`);
                                }
                            }
                        }
                        for (const ds of diff.dirty_scenes) {
                            const unitIds = ds.changes?.units?.unit_ids;
                            if (unitIds && Array.isArray(unitIds) && unitIds.length > 0) {
                                await sceneAssetsRepo.setDirtyUnitIds(bookId, ds.chapter_id, ds.scene_id, unitIds);
                                log(`[DIRTY-UNITS] ${bookId}/${ds.chapter_id}/${ds.scene_id}: ${unitIds.length} dirty unit(s): ${unitIds.join(', ')}`);
                            }
                        }
                    } catch (verErr) {
                        console.warn(`[UPDATE BOOK] Version bump/failed: ${verErr.message}`);
                    }
                }
            } catch (syncErr) {
                console.warn(`[UPDATE BOOK] PG reconcile failed for ${bookId}: ${syncErr.message}`);
            }

            return res.json({ saved: true, book_id: bookId });
        } catch (err) {
            console.error('[UPDATE BOOK] Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // PATCH BOOK DATA (targeted update — no round-trip loss)
    // ======================================================
    app.patch('/api/v1/book/:bookId/scene/:chapterId/:sceneId', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const { scene: incomingScene, unit_id, chapter_title, fields } = req.body;

            if (!incomingScene && !unit_id && !fields) {
                return res.status(400).json({ error: 'Provide "scene", "unit_id", or "fields"' });
            }

            const oldBook = editorModel.read(bookId);
            if (!oldBook) return res.status(404).json({ error: 'Book not found' });

            const bookBeforePatch = JSON.parse(JSON.stringify(oldBook));

            let targetScene = null;
            let targetChapter = null;
            let sceneIndex = -1;
            for (const ch of oldBook.chapters) {
                if (ch.chapter_id === chapterId && ch.scenes) {
                    for (let i = 0; i < ch.scenes.length; i++) {
                        if (ch.scenes[i].scene_id === sceneId) {
                            targetScene = ch.scenes[i];
                            targetChapter = ch;
                            sceneIndex = i;
                            break;
                        }
                    }
                }
                if (targetScene) break;
            }

            if (!targetScene) {
                return res.status(404).json({ error: 'Scene not found in book' });
            }

            if (fields) {
                // F8: flat dotted-path fields — server merges using setDeep().
                // The frontend sends { fields: { "key": "value", ... } } where keys
                // can be dotted paths like "location.id", "env.time", "visual.prompt".
                if (unit_id) {
                    const unit = findUnitInScene(targetScene, unit_id);
                    if (!unit) {
                        return res.status(404).json({ error: `Unit ${unit_id} not found in scene` });
                    }
                    // Validate both dotted keys ("image.prompt") and nested objects
                    // (image: { prompt: ... }) before applying.
                    for (const [key, value] of Object.entries(fields)) {
                        if (PROMPT_PATH_KEYS.has(key)) assertPromptLength(key, value);
                    }
                    for (const field of PROMPT_PATH_KEYS) {
                        const [a, b] = field.split('.');
                        const v = fields[a] && fields[a][b];
                        if (v !== undefined) assertPromptLength(field, v);
                    }
                    const textChanged = fields.text !== undefined || fields.type !== undefined;
                    for (const [key, value] of Object.entries(fields)) {
                        setDeep(unit, key, value === '' ? null : value);
                    }
                    // Rebuild audio.full_text when unit text or type changes so narration
                    // audio generation uses the current unit structure.
                    if (textChanged) rebuildFullText(targetScene);
                    log(`[PATCH BOOK] ${bookId}/${chapterId}/${sceneId}/${unit_id}: fields=${Object.keys(fields).join(', ')}`);
                } else {
                    // VBook 4 (§4a): a scene overrides a hero's look by
                    // `looks.<hero_id>` (a look id, "base" or null) and edits single
                    // fields by `look_patch.<hero_id>.<field>`. scene.passport is gone.
                    const legacy = Object.keys(fields).filter((k) => k === 'passport' || k.startsWith('passport.'));
                    if (legacy.length > 0) {
                        return res.status(400).json({
                            error: 'legacy_field', fields: legacy,
                            message: 'scene.passport is not part of VBook 4 — use looks.<hero_id> and look_patch.<hero_id>.<field>',
                        });
                    }
                    for (const key of Object.keys(fields)) {
                        const lookProblem = sceneLookKeyProblem(key, fields[key]);
                        if (lookProblem) return res.status(400).json({ error: 'invalid_look_field', field: key, message: lookProblem });
                    }
                    for (const [key, value] of Object.entries(fields)) {
                        if (key.startsWith('looks.') || key.startsWith('look_patch.')) {
                            setSceneLookField(targetScene, key, value);
                            continue;
                        }
                        // scene_title → scene_title, location.id → location.id, env.time → location.environment.time
                        const resolvedKey = key.startsWith('env.') ? 'location.environment.' + key.slice(4) : key;
                        if (PROMPT_PATH_KEYS.has(resolvedKey)) assertPromptLength(resolvedKey, value);
                        setDeep(targetScene, resolvedKey, normalizeFieldValue(resolvedKey, value));
                        // Special handling for participants (comma-separated string → array)
                        if (key === 'participants' && typeof value === 'string') {
                            setDeep(targetScene, 'participants', value ? value.split(', ').map(s => s.trim()) : null);
                        }
                    }
                    log(`[PATCH BOOK] ${bookId}/${chapterId}/${sceneId}: fields=${Object.keys(fields).join(', ')}`);
                }
            } else if (unit_id) {
                const unit = findUnitInScene(targetScene, unit_id);
                if (!unit) {
                    return res.status(404).json({ error: `Unit ${unit_id} not found in scene` });
                }
                const unitFields = {};
                for (const [key, value] of Object.entries(req.body)) {
                    if (key === 'unit_id' || key === 'chapter_title' || key === 'scene' || key === 'fields') continue;
                    unitFields[key] = value;
                }
                if (Object.keys(unitFields).length === 0) {
                    return res.status(400).json({ error: 'No unit fields to update' });
                }
                // Validate frame-prompt fields (dotted keys like "image.prompt" and
                // nested objects like image: { prompt: ... }) before applying.
                for (const [key, value] of Object.entries(unitFields)) {
                    if (PROMPT_PATH_KEYS.has(key)) assertPromptLength(key, value);
                }
                for (const field of PROMPT_PATH_KEYS) {
                    const [a, b] = field.split('.');
                    const v = unitFields[a] && unitFields[a][b];
                    if (v !== undefined) assertPromptLength(field, v);
                }
                const textChangedLegacy = unitFields.text !== undefined || unitFields.type !== undefined;
                for (const [key, value] of Object.entries(unitFields)) {
                    setDeep(unit, key, value);
                }
                if (textChangedLegacy) rebuildFullText(targetScene);
                log(`[PATCH BOOK] ${bookId}/${chapterId}/${sceneId}/${unit_id}: ${Object.keys(unitFields).join(', ')}`);
            } else {
                const oversized = findOversizedPromptInScene(incomingScene);
                if (oversized) {
                    return res.status(400).json({ error: promptLengthError(oversized.path, oversized) });
                }
                oldBook.chapters.find(ch => ch.chapter_id === chapterId).scenes[sceneIndex] = incomingScene;
                rebuildFullText(incomingScene);
                log(`[PATCH BOOK] ${bookId}/${chapterId}/${sceneId}: full scene replaced`);
            }

            if (chapter_title !== undefined && chapter_title !== null && targetChapter) {
                targetChapter.chapter_title = chapter_title;
            }

            editorModel.commit(oldBook, null);

            const newBook = editorModel.read(bookId) || oldBook;
            const diff = bookDiff.computeBookDiff(bookBeforePatch, newBook);

            if (diff.dirty_scenes.length > 0) {
                try {
                    await storage.bookSync.reconcileFromDiff(bookId, diff.dirty_scenes, newBook);
                    await sceneAssetsRepo.bumpSceneVersions(bookId, diff.dirty_scenes);
                    for (const ds of diff.dirty_scenes) {
                        const ids = ds.changes?.units?.unit_ids;
                        if (ids && Array.isArray(ids) && ids.length > 0) {
                            await sceneAssetsRepo.setDirtyUnitIds(bookId, ds.chapter_id, ds.scene_id, ids);
                        }
                    }
                } catch (syncErr) {
                    console.warn(`[PATCH BOOK] PG reconcile/bump failed: ${syncErr.message}`);
                }
            }

            return res.json({
                saved: true, book_id: bookId, chapter_id: chapterId, scene_id: sceneId,
                unit_id: unit_id || null, dirty_scenes: diff.dirty_scenes.length,
            });
        } catch (err) {
            console.error('[PATCH BOOK] Error:', err.message);
            return res.status(err.statusCode || 500).json({ error: err.message });
        }
    });

    // ======================================================
    // PATCH BOOK METADATA (lightweight — only book + bible fields)
    // ======================================================
    // Full replace of manifest.json / bible.json with PUT /book is risky:
    // if the frontend sends stale chapters, the entire book gets overwritten.
    // This endpoint only touches book-level and bible-level metadata:
    //   - book.json: title, author, language
    //   - bible.json: country, epoch, render_rules, narrator.voice.instruction
    // Chapters, characters, voices, locations are NOT touched.
    //
    app.patch('/api/v1/book/:bookId/metadata', async (req, res) => {
        try {
            const { bookId } = req.params;
            const {
                title, author, language,
                country, epoch,
                render_style, lighting_default,
                narration_voice
            } = req.body;

            const oldBook = editorModel.read(bookId);
            if (!oldBook) return res.status(404).json({ error: 'Book not found' });

            const hasAnyField = title !== undefined || author !== undefined ||
                language !== undefined || country !== undefined ||
                epoch !== undefined || render_style !== undefined ||
                lighting_default !== undefined || narration_voice !== undefined;
            if (!hasAnyField) {
                return res.status(400).json({ error: 'No metadata fields to update' });
            }

            // ── Update book.json fields ──
            const bookMeta = oldBook.book || {};
            if (title !== undefined) bookMeta.title = title || null;
            if (author !== undefined) bookMeta.author = author || null;
            if (language !== undefined) bookMeta.language = language || null;

            // narration_voice lives in book.defaults.narration_voice
            if (narration_voice !== undefined) {
                if (!bookMeta.defaults) bookMeta.defaults = {};
                bookMeta.defaults.narration_voice = narration_voice || null;
            }

            oldBook.book = bookMeta;

            // ── Update bible.json fields ──
            if (!oldBook.bible) oldBook.bible = {};
            const bib = oldBook.bible;
            if (country !== undefined) bib.country = country || null;
            if (epoch !== undefined) bib.epoch = epoch || null;

            // render_rules
            if (render_style !== undefined || lighting_default !== undefined) {
                if (!bib.render_rules) bib.render_rules = {};
                if (render_style !== undefined) bib.render_rules.style = render_style || null;
                if (lighting_default !== undefined) bib.render_rules.lighting_default = lighting_default || null;
            }

            oldBook.bible = bib;

            // Save — preserves all other files untouched
            editorModel.commit(oldBook, null);
            log(`[PATCH METADATA] ${bookId}: title=${title !== undefined} author=${author !== undefined} lang=${language !== undefined} country=${country !== undefined} epoch=${epoch !== undefined} render=${render_style !== undefined} light=${lighting_default !== undefined} narration_voice=${narration_voice !== undefined}`);

            return res.json({ saved: true, book_id: bookId });
        } catch (err) {
            console.error('[PATCH METADATA] Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // PATCH LOCATION (targeted per-location update — name, description,
    // environment template, etc.). Locations are cross-cutting: changes
    // trigger image+video regeneration for all scenes referencing the location.
    // ======================================================
    app.patch('/api/v1/book/:bookId/locations/:locationId', async (req, res) => {
        try {
            const { bookId, locationId } = req.params;
            const { fields } = req.body;

            if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
                return res.status(400).json({ error: 'Provide "fields" object' });
            }

            const oldBook = editorModel.read(bookId);
            if (!oldBook) return res.status(404).json({ error: 'Book not found' });

            const bookBeforePatch = JSON.parse(JSON.stringify(oldBook));

            const locations = oldBook.locations || {};
            const loc = locations[locationId];
            if (!loc) {
                return res.status(404).json({ error: `Location ${locationId} not found` });
            }

            for (const [key, value] of Object.entries(fields)) {
                // "environment.time" → location.environment.time (same pattern as scene env.*)
                const resolvedKey = key.startsWith('environment.')
                    ? 'environment.' + key.slice('environment.'.length)
                    : key;
                setDeep(loc, resolvedKey, value === '' ? null : value);
            }
            log(`[PATCH LOCATION] ${bookId}/${locationId}: fields=${Object.keys(fields).join(', ')}`);

            editorModel.commit(oldBook, null);

            const newBook = editorModel.read(bookId) || oldBook;
            const diff = bookDiff.computeBookDiff(bookBeforePatch, newBook);

            if (diff.dirty_scenes.length > 0) {
                try {
                    await storage.bookSync.reconcileFromDiff(bookId, diff.dirty_scenes, newBook);
                    await sceneAssetsRepo.bumpSceneVersions(bookId, diff.dirty_scenes);
                    for (const ds of diff.dirty_scenes) {
                        const ids = ds.changes?.units?.unit_ids;
                        if (ids && Array.isArray(ids) && ids.length > 0) {
                            await sceneAssetsRepo.setDirtyUnitIds(bookId, ds.chapter_id, ds.scene_id, ids);
                        }
                    }
                } catch (syncErr) {
                    console.warn(`[PATCH LOCATION] PG reconcile/bump failed: ${syncErr.message}`);
                }
            }

            return res.json({
                saved: true, book_id: bookId, location_id: locationId,
                dirty_scenes: diff.dirty_scenes.length,
            });
        } catch (err) {
            console.error('[PATCH LOCATION] Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // GET BOOK COVER DATA
    // ======================================================
    app.get('/api/v1/book/:bookId/cover', async (req, res) => {
        try {
            const { bookId } = req.params;
            const bookData = editorModel.read(bookId);
            if (!bookData) {
                return res.status(404).json({ error: 'Book not found' });
            }
            const coverCh = (bookData.chapters || []).find(ch => ch.type === 'cover');
            if (!coverCh || !coverCh.scenes || coverCh.scenes.length === 0) {
                return res.status(404).json({ error: 'Cover not found for this book' });
            }
            return res.json(coverCh.scenes[0]);
        } catch (err) {
            console.error('[GET COVER] Error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // DELETE BOOK
    // ======================================================
    // Phase 4: the route no longer implements the deletion cascade itself —
    // ownership/cancel/runtime/derived-purge details live behind the
    // bookDeletion.deleteBook(bookId) contract (services/book-deletion.cjs).
    app.delete('/api/v1/book/:bookId', async (req, res) => {
        try {
            const { bookId } = req.params;
            log('[DELETE-BOOK] Deleting', bookId);

            const result = await bookDeletion.deleteBook(bookId);
            res.json(result);
        } catch (err) {
            console.error('[DELETE-BOOK] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });
};
