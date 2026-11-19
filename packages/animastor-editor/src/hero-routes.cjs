// ======================================================
// @animastor/editor — HERO ROUTES (VBOOK_FORMAT_V4 §8.2, §10.3; HERO_CARD.md)
// ======================================================
// One hero = one resource = one file characters/<id>.json. Every write of a
// hero goes through the hero store of the editor model (the runtime's
// character store: read → change → validate → atomic write, synchronously).
// Writes that also touch chapters (looks assign / delete) go through the one
// bundle writer (editorModel.commit → saveBookBundle, which writes hero files
// through the same store).
//
//   GET    /book/:bookId/heroes                          list (+ hero_issues)
//   GET    /book/:bookId/heroes/:heroId                  one hero
//   POST   /book/:bookId/heroes                          create
//   PATCH  /book/:bookId/heroes/:heroId                  {fields, if_rev?}
//   DELETE /book/:bookId/heroes/:heroId[?broken=1]       delete (broken file: ?broken=1)
//   DELETE /book/:bookId/hero-files?file=<name>          broken file by its name (В14)
//   POST   /book/:bookId/heroes/:heroId/rules            add a rule
//   PATCH  /book/:bookId/heroes/:heroId/rules/:ruleId    {fields}
//   DELETE /book/:bookId/heroes/:heroId/rules/:ruleId
//   POST   /book/:bookId/heroes/:heroId/looks            {id?, label, fields, notes?}
//   PATCH  /book/:bookId/heroes/:heroId/looks/:lookId    {fields}
//   DELETE /book/:bookId/heroes/:heroId/looks/:lookId    releases every reference
//   POST   /book/:bookId/looks/assign                    {hero_id, look_id, chapters, scenes}
//   GET    /book/:bookId/behaviour                       global defaults + rules
//   PATCH  /book/:bookId/behaviour                       {fields}
//
// Error body: { error: <code>, message, ...details } — the same shape as the
// unsupported_vbook_version body of GET /book (the web client reads `error`).
// Access: the host mounts requireBookAccess on /api/v1/book/:bookId and the
// id guards (bookId, heroId, lookId, ruleId) before any of these run; the
// handlers re-check the hero id grammar anyway.

'use strict';

const { isValidHeroId, isCanonicalHeroId, isReservedHeroId, NARRATOR_ID, findHero, heroRules } = require('@animastor/vbook-runtime/heroes.cjs');
const { isUnsupportedVersionError, unsupportedVersionBody } = require('@animastor/vbook-runtime/vbook-version.cjs');
const { validateBehaviourGlobals } = require('@animastor/vbook-runtime/character-validator.cjs');
const { isPlainEntryName } = require('@animastor/vbook-runtime/character-store.cjs');
const { joinInside, isValidBuildId } = require('@animastor/vbook-runtime/safe-paths');
const api = require('./hero-api.cjs');
const { toEntityId, isCanonicalEntityId } = require('./entity-id.js');

const { HeroApiError, isPlainObject, clone } = api;

const STORE_STATUS = Object.freeze({
    hero_file_broken: 409,
    behaviour_file_broken: 409,
    narrator_required: 409,
    path_is_link: 409,
    invalid_character: 400,
    reserved_id: 400,
    invalid_hero_id: 400,
    invalid_file_name: 422,
});

function requestLanguage(req) {
    const header = req && req.headers ? req.headers['accept-language'] : '';
    return /^\s*ru/i.test(String(header || '')) ? 'ru' : 'en';
}

function sendError(res, status, code, message, details = {}) {
    return res.status(status).json({ error: code, message, ...details });
}

module.exports = function (app, redis, deps) {
    const { editorModel, editorPorts = {}, bookDiff, storage, utils } = deps;
    const log = (utils && utils.log) || (() => {});
    const sceneAssetsRepo = editorPorts.sceneAssetsRepo;

    const prefix = '/api/v1/book/:bookId';

    function fail(req, res, err, tag) {
        if (err instanceof HeroApiError) return sendError(res, err.status, err.code, err.message, err.details);
        if (isUnsupportedVersionError(err)) return res.status(409).json(unsupportedVersionBody(err, requestLanguage(req)));
        if (err && STORE_STATUS[err.code]) {
            const details = {};
            if (err.details && err.details.hero_id) details.hero_id = err.details.hero_id;
            if (err.details && Array.isArray(err.details.errors)) details.errors = err.details.errors.slice(0, 20);
            if (err.details && err.details.issue) details.issue = err.details.issue;
            if (err.details && Array.isArray(err.details.issues)) details.issues = err.details.issues;
            return sendError(res, STORE_STATUS[err.code], err.code, err.message, details);
        }
        console.error(`[${tag}] Error:`, err && err.message);
        return sendError(res, 500, 'internal_error', (err && err.message) || 'internal error');
    }

    /** The book or a thrown 404; a 3.1 book throws the version error (→ 409). */
    function readBook(bookId) {
        const book = editorModel.read(bookId);
        if (!book) throw new HeroApiError(404, 'book_not_found', `book ${bookId} not found`);
        return book;
    }

    function buildDirOf(book) {
        const root = editorPorts.outputRoot;
        const buildId = book && book.manifest && book.manifest.build_id;
        if (!root || !isValidBuildId(buildId)) return null;
        try { return joinInside(root, buildId); } catch (_) { return null; }
    }

    function heroIdOf(req) {
        const heroId = req.params.heroId;
        if (!isCanonicalHeroId(heroId)) throw new HeroApiError(400, 'invalid_hero_id', `invalid hero id ${JSON.stringify(heroId)}`);
        return heroId;
    }

    /** The hero of the request: 404 when absent, 409 hero_file_broken when broken. */
    function existingHero(book, bookId, heroId) {
        const store = editorModel.heroes(bookId);
        const found = store.inspect(heroId);
        if (found.state === 'broken') {
            throw new HeroApiError(409, 'hero_file_broken', `hero file characters/${heroId}.json is broken (${found.issue.code}) — fix or delete it first`, { hero_id: heroId, issue: found.issue });
        }
        const hero = findHero(book, heroId);
        if (found.state === 'absent' || !hero) throw new HeroApiError(404, 'hero_not_found', `hero ${heroId} not found`);
        return hero;
    }

    function heroIssues(book, heroId) {
        return (Array.isArray(book.hero_issues) ? book.hero_issues : []).filter((i) => i && i.hero_id === heroId);
    }

    /**
     * Dirty fan-out after a write (the same legs as PATCH /scene): diff the book
     * before and after, reconcile PG, bump scene versions, mark dirty units.
     * A failure here never fails the already-written change.
     * @returns {object[]} dirty_scenes
     */
    async function propagateDirty(bookId, before, tag) {
        if (!bookDiff || typeof bookDiff.computeBookDiff !== 'function') return [];
        let after;
        try { after = editorModel.read(bookId); } catch (_) { after = null; }
        if (!after) return [];
        const diff = bookDiff.computeBookDiff(before, after);
        const dirty = diff.dirty_scenes || [];
        if (dirty.length > 0) {
            try {
                if (storage && storage.bookSync) await storage.bookSync.reconcileFromDiff(bookId, dirty, after);
                if (sceneAssetsRepo && sceneAssetsRepo.bumpSceneVersions) await sceneAssetsRepo.bumpSceneVersions(bookId, dirty);
                for (const ds of dirty) {
                    const ids = ds.changes && ds.changes.units && ds.changes.units.unit_ids;
                    if (Array.isArray(ids) && ids.length > 0 && sceneAssetsRepo && sceneAssetsRepo.setDirtyUnitIds) {
                        await sceneAssetsRepo.setDirtyUnitIds(bookId, ds.chapter_id, ds.scene_id, ids);
                    }
                }
            } catch (syncErr) {
                console.warn(`[${tag}] PG reconcile/bump failed: ${syncErr.message}`);
            }
        }
        return dirty.map((d) => ({ chapter_id: d.chapter_id, scene_id: d.scene_id, reason: d.reason, dirty_layers: d.dirty_layers }));
    }

    function heroReply(bookId, heroId, extra = {}) {
        const book = readBook(bookId);
        const hero = findHero(book, heroId);
        return {
            saved: true, book_id: bookId, hero_id: heroId,
            hero: hero ? api.enrichHero(hero, buildDirOf(book)) : null,
            rev: hero ? api.heroRev(hero) : null,
            ...extra,
        };
    }

    // ======================================================
    // LIST / READ
    // ======================================================
    app.get(`${prefix}/heroes`, (req, res) => {
        try {
            const { bookId } = req.params;
            const book = readBook(bookId);
            const buildDir = buildDirOf(book);
            return res.json({
                book_id: bookId,
                heroes: (book.heroes || []).map((h) => api.enrichHero(h, buildDir)),
                hero_issues: book.hero_issues || [],
            });
        } catch (err) { return fail(req, res, err, 'LIST HEROES'); }
    });

    app.get(`${prefix}/heroes/:heroId`, (req, res) => {
        try {
            const { bookId } = req.params;
            const heroId = heroIdOf(req);
            const book = readBook(bookId);
            const hero = existingHero(book, bookId, heroId);
            return res.json({ book_id: bookId, hero: api.enrichHero(hero, buildDirOf(book)), issues: heroIssues(book, heroId) });
        } catch (err) { return fail(req, res, err, 'GET HERO'); }
    });

    // ======================================================
    // CREATE
    // ======================================================
    app.post(`${prefix}/heroes`, (req, res) => {
        try {
            const { bookId } = req.params;
            const body = isPlainObject(req.body) ? req.body : {};
            const rawId = typeof body.id === 'string' ? body.id.trim() : '';
            const name = typeof body.name === 'string' ? body.name.trim() : '';
            if (body.id !== undefined && body.id !== null && typeof body.id !== 'string') {
                throw new HeroApiError(400, 'invalid_hero_id', 'id must be a string');
            }
            if (!name && rawId !== NARRATOR_ID) throw new HeroApiError(400, 'name_required', 'a hero has a name');
            // id: a canonical id is kept, free text is transliterated, an empty id
            // comes from the name — the existing resolveId of the editor.
            let heroId = rawId && isCanonicalEntityId(rawId) ? rawId : toEntityId(rawId || name);
            if (!heroId || !isCanonicalHeroId(heroId)) {
                throw new HeroApiError(400, 'invalid_hero_id', `could not derive a hero id (latin snake_case, up to 64 characters) from ${JSON.stringify(rawId || name)}`);
            }
            if (isReservedHeroId(heroId)) throw new HeroApiError(400, 'reserved_id', `hero id "${heroId}" is reserved`);
            if (body.role === NARRATOR_ID && heroId !== NARRATOR_ID) {
                throw new HeroApiError(400, 'invalid_field', 'role "narrator" belongs to the hero "narrator"');
            }

            const book = readBook(bookId);
            const store = editorModel.heroes(bookId);
            const found = store.inspect(heroId);
            if (found.state === 'broken') {
                throw new HeroApiError(409, 'hero_file_broken', `hero file characters/${heroId}.json is broken (${found.issue.code}) — fix or delete it first`, { hero_id: heroId, issue: found.issue });
            }
            if (found.state === 'ok' || findHero(book, heroId)) {
                throw new HeroApiError(409, 'hero_exists', `hero "${heroId}" already exists`, { hero_id: heroId });
            }
            const hero = api.newHero(heroId, body);
            api.checkHeroDraft(hero);
            store.create(hero);
            log(`[ADD HERO] ${bookId}/${heroId}`);
            return res.status(201).json(heroReply(bookId, heroId));
        } catch (err) { return fail(req, res, err, 'ADD HERO'); }
    });

    // ======================================================
    // PATCH — white list + optimistic lock (rev)
    // ======================================================
    app.patch(`${prefix}/heroes/:heroId`, async (req, res) => {
        try {
            const { bookId } = req.params;
            const heroId = heroIdOf(req);
            const body = isPlainObject(req.body) ? req.body : {};
            const ifRev = body.if_rev;
            if (ifRev !== undefined && ifRev !== null && typeof ifRev !== 'string') {
                throw new HeroApiError(400, 'bad_request', 'if_rev must be a string');
            }
            const before = readBook(bookId);
            existingHero(before, bookId, heroId);
            const snapshot = clone(before);
            // read → check rev → change → validate → write, with no await between
            editorModel.heroes(bookId).update(heroId, (hero) => {
                const current = api.heroRev(hero);
                if (ifRev && ifRev !== current) {
                    throw new HeroApiError(409, 'rev_conflict', 'the hero was changed elsewhere', { hero_id: heroId, rev: current });
                }
                api.applyHeroFields(hero, body.fields);
                api.checkHeroDraft(hero);
                return hero;
            });
            log(`[PATCH HERO] ${bookId}/${heroId}: fields=${Object.keys(body.fields).join(', ')}`);
            const dirty = await propagateDirty(bookId, snapshot, 'PATCH HERO');
            return res.json(heroReply(bookId, heroId, { dirty_scenes: dirty }));
        } catch (err) { return fail(req, res, err, 'PATCH HERO'); }
    });

    // ======================================================
    // DELETE — a hero file; ?broken=1 — the broken file under this id
    // ======================================================
    app.delete(`${prefix}/heroes/:heroId`, async (req, res) => {
        try {
            const { bookId } = req.params;
            const heroId = heroIdOf(req);
            const broken = req.query && (req.query.broken === '1' || req.query.broken === 'true');
            const before = readBook(bookId);
            const store = editorModel.heroes(bookId);
            const found = store.inspect(heroId);
            if (found.state === 'absent') throw new HeroApiError(404, 'hero_not_found', `hero ${heroId} not found`);
            if (broken && found.state === 'ok') {
                throw new HeroApiError(409, 'hero_not_broken', `characters/${heroId}.json is not broken — delete the hero without ?broken=1`);
            }
            if (!broken && found.state === 'ok' && heroId === NARRATOR_ID) {
                throw new HeroApiError(409, 'narrator_required', 'the narrator cannot be deleted');
            }
            const snapshot = clone(before);
            store.remove(heroId, { broken });
            log(`[DELETE HERO] ${bookId}/${heroId}${broken ? ' (broken file)' : ''}`);
            const dirty = broken ? [] : await propagateDirty(bookId, snapshot, 'DELETE HERO');
            return res.json({ deleted: true, book_id: bookId, hero_id: heroId, broken: !!broken, dirty_scenes: dirty });
        } catch (err) { return fail(req, res, err, 'DELETE HERO'); }
    });

    // A broken file whose name is not a hero id ("Юра.json", "notes.txt") —
    // owner's decision В14: only a name that is in hero_issues of THIS book
    // right now (the book is loaded in this request), only a plain name.
    app.delete(`${prefix}/hero-files`, (req, res) => {
        try {
            const { bookId } = req.params;
            const name = req.query ? req.query.file : undefined;
            if (typeof name !== 'string' || !isPlainEntryName(name)) {
                throw new HeroApiError(422, 'invalid_file_name', 'file: one plain file name from characters/ (as listed in hero_issues)');
            }
            const book = readBook(bookId);
            const listed = (book.hero_issues || []).some((i) => i && i.blocking === true
                && typeof i.file === 'string' && i.file === `characters/${name}`);
            if (!listed) {
                throw new HeroApiError(404, 'not_in_hero_issues', `characters/${name} is not a broken hero file of this book`);
            }
            const removed = editorModel.heroes(bookId).removeEntry(name);
            if (!removed) throw new HeroApiError(404, 'not_in_hero_issues', `characters/${name} is gone`);
            log(`[DELETE HERO FILE] ${bookId}/characters/${name}`);
            return res.json({ deleted: true, book_id: bookId, file: `characters/${name}` });
        } catch (err) { return fail(req, res, err, 'DELETE HERO FILE'); }
    });

    // ======================================================
    // RULES of a hero (§6.2) — no dirty layer: rules are snapshotted into
    // unit.behaviour at pipeline time (VBOOK_BEHAVIOUR.md)
    // ======================================================
    app.post(`${prefix}/heroes/:heroId/rules`, (req, res) => {
        try {
            const { bookId } = req.params;
            const heroId = heroIdOf(req);
            const book = readBook(bookId);
            existingHero(book, bookId, heroId);
            const taken = api.bookRuleIds(book);
            const rule = api.newRule(req.body, heroId, taken);
            editorModel.heroes(bookId).update(heroId, (hero) => {
                if (!isPlainObject(hero.behaviour)) hero.behaviour = {};
                if (!Array.isArray(hero.behaviour.rules)) hero.behaviour.rules = [];
                hero.behaviour.rules.push(rule);
                return hero;
            });
            log(`[ADD RULE] ${bookId}/${heroId}/${rule.id}`);
            return res.status(201).json(heroReply(bookId, heroId, { rule_id: rule.id }));
        } catch (err) { return fail(req, res, err, 'ADD RULE'); }
    });

    app.patch(`${prefix}/heroes/:heroId/rules/:ruleId`, (req, res) => {
        try {
            const { bookId, ruleId } = req.params;
            const heroId = heroIdOf(req);
            const book = readBook(bookId);
            existingHero(book, bookId, heroId);
            const fields = isPlainObject(req.body) ? req.body.fields : undefined;
            editorModel.heroes(bookId).update(heroId, (hero) => {
                const rule = api.heroRuleList(hero).find((r) => r && r.id === ruleId);
                if (!rule) throw new HeroApiError(404, 'rule_not_found', `rule ${ruleId} of hero ${heroId} not found`);
                api.applyRuleFields(rule, fields);
                return hero;
            });
            log(`[PATCH RULE] ${bookId}/${heroId}/${ruleId}: ${Object.keys(fields || {}).join(', ')}`);
            return res.json(heroReply(bookId, heroId, { rule_id: ruleId }));
        } catch (err) { return fail(req, res, err, 'PATCH RULE'); }
    });

    app.delete(`${prefix}/heroes/:heroId/rules/:ruleId`, (req, res) => {
        try {
            const { bookId, ruleId } = req.params;
            const heroId = heroIdOf(req);
            const book = readBook(bookId);
            existingHero(book, bookId, heroId);
            editorModel.heroes(bookId).update(heroId, (hero) => {
                const rules = api.heroRuleList(hero);
                const idx = rules.findIndex((r) => r && r.id === ruleId);
                if (idx < 0) throw new HeroApiError(404, 'rule_not_found', `rule ${ruleId} of hero ${heroId} not found`);
                rules.splice(idx, 1);
                if (rules.length === 0) delete hero.behaviour.rules;
                if (Object.keys(hero.behaviour).length === 0) delete hero.behaviour;
                return hero;
            });
            log(`[DELETE RULE] ${bookId}/${heroId}/${ruleId}`);
            return res.json(heroReply(bookId, heroId, { rule_id: ruleId, deleted: true }));
        } catch (err) { return fail(req, res, err, 'DELETE RULE'); }
    });

    // ======================================================
    // LOOKS (§4a) — dirty: image + video where the resolved look changed
    // ======================================================
    app.post(`${prefix}/heroes/:heroId/looks`, async (req, res) => {
        try {
            const { bookId } = req.params;
            const heroId = heroIdOf(req);
            const before = readBook(bookId);
            const current = existingHero(before, bookId, heroId);
            if (!isPlainObject(current.passport)) {
                throw new HeroApiError(409, 'passport_required', 'looks override the passport — the hero has none');
            }
            const snapshot = clone(before);
            let lookId = null;
            editorModel.heroes(bookId).update(heroId, (hero) => {
                const look = api.newLook(hero, req.body);
                lookId = look.id;
                if (!Array.isArray(hero.looks)) hero.looks = [];
                hero.looks.push(look);
                return hero;
            });
            log(`[ADD LOOK] ${bookId}/${heroId}/${lookId}`);
            const dirty = await propagateDirty(bookId, snapshot, 'ADD LOOK');
            return res.status(201).json(heroReply(bookId, heroId, { look_id: lookId, dirty_scenes: dirty }));
        } catch (err) { return fail(req, res, err, 'ADD LOOK'); }
    });

    app.patch(`${prefix}/heroes/:heroId/looks/:lookId`, async (req, res) => {
        try {
            const { bookId, lookId } = req.params;
            const heroId = heroIdOf(req);
            const before = readBook(bookId);
            existingHero(before, bookId, heroId);
            const snapshot = clone(before);
            const fields = isPlainObject(req.body) ? req.body.fields : undefined;
            editorModel.heroes(bookId).update(heroId, (hero) => {
                const look = api.lookList(hero).find((l) => l && l.id === lookId);
                if (!look) throw new HeroApiError(404, 'look_not_found', `look ${lookId} of hero ${heroId} not found`);
                api.applyLookFields(look, fields);
                return hero;
            });
            log(`[PATCH LOOK] ${bookId}/${heroId}/${lookId}: ${Object.keys(fields || {}).join(', ')}`);
            const dirty = await propagateDirty(bookId, snapshot, 'PATCH LOOK');
            return res.json(heroReply(bookId, heroId, { look_id: lookId, dirty_scenes: dirty }));
        } catch (err) { return fail(req, res, err, 'PATCH LOOK'); }
    });

    app.delete(`${prefix}/heroes/:heroId/looks/:lookId`, async (req, res) => {
        try {
            const { bookId, lookId } = req.params;
            const heroId = heroIdOf(req);
            const book = readBook(bookId);
            const hero = existingHero(book, bookId, heroId);
            const looks = api.lookList(hero);
            const idx = looks.findIndex((l) => l && l.id === lookId);
            if (idx < 0) throw new HeroApiError(404, 'look_not_found', `look ${lookId} of hero ${heroId} not found`);
            const snapshot = clone(book);
            // The look and every chapter / scene reference to it go in ONE save:
            // the bundle writer writes the hero file through the character store.
            looks.splice(idx, 1);
            if (looks.length === 0) delete hero.looks;
            const unassigned = api.unassignLook(book, heroId, lookId);
            editorModel.commit(book);
            log(`[DELETE LOOK] ${bookId}/${heroId}/${lookId} (released ${unassigned.length})`);
            const dirty = await propagateDirty(bookId, snapshot, 'DELETE LOOK');
            return res.json({ deleted: true, book_id: bookId, hero_id: heroId, look_id: lookId, unassigned, dirty_scenes: dirty });
        } catch (err) { return fail(req, res, err, 'DELETE LOOK'); }
    });

    // One operation for any set of chapters and scenes (§4a.3):
    //   look_id: <id> — assign; "base" — base passport for a SCENE against the
    //   chapter's look; null — release the reference.
    app.post(`${prefix}/looks/assign`, async (req, res) => {
        try {
            const { bookId } = req.params;
            const body = isPlainObject(req.body) ? req.body : {};
            const heroId = body.hero_id;
            if (!isValidHeroId(heroId)) throw new HeroApiError(400, 'invalid_hero_id', 'hero_id: a hero id');
            const lookId = body.look_id === undefined ? undefined : body.look_id;
            if (lookId === undefined) throw new HeroApiError(400, 'bad_request', 'look_id is required (a look id, "base" or null)');
            if (lookId !== null && (typeof lookId !== 'string' || (lookId !== api.BASE_LOOK_ID && !api.isCanonicalId(lookId)))) {
                throw new HeroApiError(400, 'invalid_look_id', 'look_id: a look id, "base" or null');
            }
            const chapterIds = body.chapters === undefined ? [] : body.chapters;
            const scenes = body.scenes === undefined ? [] : body.scenes;
            if (!Array.isArray(chapterIds) || chapterIds.some((c) => typeof c !== 'string')) {
                throw new HeroApiError(400, 'bad_request', 'chapters: an array of chapter ids');
            }
            if (!Array.isArray(scenes) || scenes.some((s) => !isPlainObject(s) || typeof s.chapter_id !== 'string' || typeof s.scene_id !== 'string')) {
                throw new HeroApiError(400, 'bad_request', 'scenes: an array of {chapter_id, scene_id}');
            }
            if (chapterIds.length === 0 && scenes.length === 0) throw new HeroApiError(400, 'bad_request', 'nothing to assign: give chapters and/or scenes');
            if (lookId === api.BASE_LOOK_ID && chapterIds.length > 0) {
                throw new HeroApiError(400, 'base_for_chapter', '"base" is a scene override of a chapter look; to release a chapter use look_id: null');
            }

            const book = readBook(bookId);
            const hero = existingHero(book, bookId, heroId);
            if (!isPlainObject(hero.passport)) throw new HeroApiError(409, 'passport_required', 'the hero has no passport — nothing to override');
            if (typeof lookId === 'string' && lookId !== api.BASE_LOOK_ID && !api.lookList(hero).some((l) => l && l.id === lookId)) {
                throw new HeroApiError(404, 'look_not_found', `look ${lookId} of hero ${heroId} not found`);
            }
            const chapters = Array.isArray(book.chapters) ? book.chapters : [];
            const targets = [];
            for (const cid of chapterIds) {
                const ch = chapters.find((c) => c && c.chapter_id === cid);
                if (!ch) throw new HeroApiError(404, 'chapter_not_found', `chapter ${cid} not found`);
                targets.push(ch);
            }
            for (const s of scenes) {
                const ch = chapters.find((c) => c && c.chapter_id === s.chapter_id);
                const sc = ch && (ch.scenes || []).find((x) => x && x.scene_id === s.scene_id);
                if (!sc) throw new HeroApiError(404, 'scene_not_found', `scene ${s.chapter_id}/${s.scene_id} not found`);
                targets.push(sc);
            }
            const snapshot = clone(book);
            for (const holder of targets) api.assignInto(holder, heroId, lookId);
            editorModel.commit(book);
            log(`[ASSIGN LOOK] ${bookId}/${heroId}: ${lookId === null ? 'release' : lookId} → ${chapterIds.length} chapter(s), ${scenes.length} scene(s)`);
            const dirty = await propagateDirty(bookId, snapshot, 'ASSIGN LOOK');
            return res.json({ saved: true, book_id: bookId, hero_id: heroId, look_id: lookId, dirty_scenes: dirty });
        } catch (err) { return fail(req, res, err, 'ASSIGN LOOK'); }
    });

    // ======================================================
    // BEHAVIOUR — book-level defaults and global rules (§6.3)
    // ======================================================
    function behaviourProblem(book) {
        return (book.hero_issues || []).find((i) => i && i.file === 'behaviour.json' && i.blocking) || null;
    }

    app.get(`${prefix}/behaviour`, (req, res) => {
        try {
            const { bookId } = req.params;
            const book = readBook(bookId);
            const { duplicates } = heroRules(book);
            return res.json({ book_id: bookId, behaviour: book.behaviour, issue: behaviourProblem(book), duplicate_rule_ids: duplicates });
        } catch (err) { return fail(req, res, err, 'GET BEHAVIOUR'); }
    });

    const BEHAVIOUR_PATCH_KEYS = Object.freeze(['defaults.max_per_scene', 'rules']);
    app.patch(`${prefix}/behaviour`, (req, res) => {
        try {
            const { bookId } = req.params;
            const fields = isPlainObject(req.body) ? req.body.fields : undefined;
            if (!isPlainObject(fields) || Object.keys(fields).length === 0) throw new HeroApiError(400, 'bad_request', 'Provide a non-empty "fields" object');
            const bad = Object.keys(fields).filter((k) => !BEHAVIOUR_PATCH_KEYS.includes(k));
            if (bad.length > 0) throw new HeroApiError(400, 'field_not_editable', `behaviour fields not editable: ${bad.join(', ')}`, { allowed: BEHAVIOUR_PATCH_KEYS });
            const book = readBook(bookId);
            const problem = behaviourProblem(book);
            if (problem) {
                throw new HeroApiError(409, 'behaviour_file_broken', `behaviour.json is broken (${problem.code}) — fix or delete it first`, { issue: problem });
            }
            const next = clone(book.behaviour);
            if (fields['defaults.max_per_scene'] !== undefined) {
                if (!isPlainObject(next.defaults)) next.defaults = {};
                if (fields['defaults.max_per_scene'] === null) delete next.defaults.max_per_scene;
                else next.defaults.max_per_scene = fields['defaults.max_per_scene'];
            }
            if (fields.rules !== undefined) next.rules = fields.rules === null ? [] : fields.rules;
            const check = validateBehaviourGlobals(next);
            if (!check.valid) throw new HeroApiError(400, 'invalid_behaviour', check.errors.slice(0, 5).map((e) => `${e.path}: ${e.message}`).join('; '), { errors: check.errors.slice(0, 20) });
            book.behaviour = next;
            editorModel.commit(book);
            log(`[PATCH BEHAVIOUR] ${bookId}: ${Object.keys(fields).join(', ')}`);
            return res.json({ saved: true, book_id: bookId, behaviour: next });
        } catch (err) { return fail(req, res, err, 'PATCH BEHAVIOUR'); }
    });
};
