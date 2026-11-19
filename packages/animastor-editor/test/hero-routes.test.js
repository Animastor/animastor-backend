// ======================================================
// Hero API — contract tests (VBOOK_FORMAT_V4 §8.2, §9, §10.3; HERO_CARD.md)
// ======================================================
// Every route of @animastor/editor 0.5.0 and every error code it answers,
// over a real HTTP server, the real editor model (runtime loader, character
// store, saveBookBundle) and the real book diff. The route-level refusals of
// the host guards (anonymous, a stranger's book, a bad :heroId) are in
// backend/tests/book-input-guard.test.js.

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const h = require('./hero-harness.cjs');

const B = 'hero_book_1';
const S1 = 'sc-00000001';
const S2 = 'sc-00000002';
const S3 = 'sc-00000003';
const dirtyIds = (list) => (list || []).map((d) => d.scene_id).sort();

describe('@animastor/editor 0.5.0 — hero API (VBOOK_FORMAT_V4 §8.2)', function () {
    this.timeout(20000);
    let t;

    beforeEach(async () => {
        t = await h.startHeroServer();
        h.writeBook(t.booksDir, B);
    });
    afterEach(async () => { await t.close(); });

    // ── GET /book ────────────────────────────────────────────────────────
    describe('GET /book — the v4 model with computed hero fields', () => {
        it('heroes carry rev; no characters / voices / behaviors / behavior_rules', async () => {
            const r = await t.api('GET', `/api/v1/book/${B}`);
            expect(r.status).to.equal(200);
            for (const k of ['characters', 'voices', 'behaviors', 'behavior_rules']) expect(r.body).to.not.have.property(k);
            expect(r.body.heroes.map((x) => x.id)).to.deep.equal(['narrator', 'yura', 'sveta']);
            const yura = r.body.heroes.find((x) => x.id === 'yura');
            expect(yura.rev).to.match(/^[0-9a-f]{16}$/);
            const stored = fs.readFileSync(t.heroFile(B, 'yura'));
            expect(yura.rev).to.equal(crypto.createHash('sha256').update(stored).digest('hex').slice(0, 16));
            expect(JSON.parse(stored)).to.not.have.property('rev');
        });

        it('voice.reference_state (missing / ok / mismatch) and reference_outdated are computed, never stored', async () => {
            const wav = Buffer.from('RIFF....WAVEfmt fake');
            const sha = h.SHA(wav);
            const timbreSha = crypto.createHash('sha256').update('Warm baritone.', 'utf8').digest('hex');
            const yura = JSON.parse(fs.readFileSync(t.heroFile(B, 'yura'), 'utf8'));
            yura.voice.reference = { file: 'voices/yura/c1.wav', sha256: sha, ref_text: 'Фраза.', source: 'designed', verification: 'passed', locked: true, source_timbre_sha256: timbreSha };
            fs.writeFileSync(t.heroFile(B, 'yura'), JSON.stringify(yura, null, 2));
            const get = async () => (await t.api('GET', `/api/v1/book/${B}`)).body.heroes.find((x) => x.id === 'yura').voice;

            expect(await get()).to.include({ reference_state: 'missing', reference_outdated: false });
            const dir = path.join(t.outputDir, `build_${B}`, 'voices', 'yura');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'c1.wav'), wav);
            expect(await get()).to.include({ reference_state: 'ok', reference_outdated: false });
            fs.appendFileSync(path.join(dir, 'c1.wav'), 'x');
            expect((await get()).reference_state).to.equal('mismatch');

            // owner's decision 18.11: a different timbre → reference_outdated, nothing regenerated
            const p = await t.api('PATCH', `/api/v1/book/${B}/heroes/yura`, { fields: { 'voice.timbre': 'Husky tenor.' } });
            expect(p.status).to.equal(200);
            expect((await get()).reference_outdated).to.equal(true);
            const onDisk = t.readHero(B, 'yura').voice;
            expect(onDisk).to.not.have.property('reference_state');
            expect(onDisk).to.not.have.property('reference_outdated');
            expect(onDisk.reference.source_timbre_sha256).to.equal(timbreSha);
        });

        it('PUT /book strips the computed fields before saving; a 3.1 body is refused', async () => {
            const book = (await t.api('GET', `/api/v1/book/${B}`)).body;
            const put = await t.api('PUT', `/api/v1/book/${B}`, book);
            expect(put.status).to.equal(200);
            expect(t.readHero(B, 'yura')).to.not.have.property('rev');
            const legacy = await t.api('PUT', `/api/v1/book/${B}`, { ...book, characters: [] });
            expect(legacy.status).to.equal(400);
            expect(legacy.body.error).to.equal('legacy_fields');
            const empty = await t.api('PUT', `/api/v1/book/${B}`, { ...book, heroes: [] });
            expect(empty.status).to.equal(400);
            expect(empty.body.error).to.equal('heroes_empty');
        });

        it('possible duplicates of the analysis and unknown participants are non-blocking hero_issues', async () => {
            const meta = JSON.parse(fs.readFileSync(path.join(t.bookDir(B), 'book.json'), 'utf8'));
            meta.analysis = { possible_duplicates: [{ hero_id: 'sveta', of: 'yura', evidence: ['клетчатый'] }, { hero_id: 'ghost', of: 'yura', evidence: [] }] };
            fs.writeFileSync(path.join(t.bookDir(B), 'book.json'), JSON.stringify(meta));
            const ch = t.readChapter(B, h.CH2);
            ch.scenes[0].participants = ['sveta', 'berlioz'];
            fs.writeFileSync(path.join(t.bookDir(B), 'chapters', `${h.CH2}.json`), JSON.stringify(ch));
            const issues = (await t.api('GET', `/api/v1/book/${B}`)).body.hero_issues;
            const dup = issues.filter((i) => i.code === 'possible_duplicate');
            expect(dup).to.have.length(1, 'an entry whose hero is gone is not shown');
            expect(dup[0]).to.include({ hero_id: 'sveta', of: 'yura', blocking: false });
            expect(dup[0].evidence).to.deep.equal(['клетчатый']);
            const unknown = issues.find((i) => i.code === 'unknown_participant');
            expect(unknown).to.include({ participant: 'berlioz', blocking: false });
            expect(unknown.scenes).to.deep.equal([{ chapter_id: h.CH2, scene_id: S3 }]);
        });
    });

    // ── list / read ──────────────────────────────────────────────────────
    describe('GET /heroes, GET /heroes/:heroId', () => {
        it('list: heroes (with rev) and hero_issues', async () => {
            const r = await t.api('GET', `/api/v1/book/${B}/heroes`);
            expect(r.status).to.equal(200);
            expect(r.body.heroes.map((x) => x.id)).to.deep.equal(['narrator', 'yura', 'sveta']);
            expect(r.body.heroes[1].rev).to.match(/^[0-9a-f]{16}$/);
            expect(r.body.hero_issues).to.be.an('array');
        });
        it('one hero; 404 hero_not_found; 409 hero_file_broken; 404 book_not_found', async () => {
            const r = await t.api('GET', `/api/v1/book/${B}/heroes/yura`);
            expect(r.status).to.equal(200);
            expect(r.body.hero).to.include({ id: 'yura', name: 'Юра' });
            expect((await t.api('GET', `/api/v1/book/${B}/heroes/nobody`)).body.error).to.equal('hero_not_found');
            fs.writeFileSync(t.heroFile(B, 'sveta'), '{ not json');
            const broken = await t.api('GET', `/api/v1/book/${B}/heroes/sveta`);
            expect(broken.status).to.equal(409);
            expect(broken.body.error).to.equal('hero_file_broken');
            const nb = await t.api('GET', `/api/v1/book/no_such_book/heroes`);
            expect(nb.status).to.equal(404);
            expect(nb.body.error).to.equal('book_not_found');
        });
        it('the handler re-checks the hero id grammar (400 invalid_hero_id)', async () => {
            const r = await t.api('GET', `/api/v1/book/${B}/heroes/Yura`);
            expect(r.status).to.equal(400);
            expect(r.body.error).to.equal('invalid_hero_id');
        });
    });

    // ── create ───────────────────────────────────────────────────────────
    describe('POST /heroes', () => {
        it('201: a canonical id is kept, the file is characters/<id>.json with the passport', async () => {
            const r = await t.api('POST', `/api/v1/book/${B}/heroes`, { id: 'anna', name: 'Анна', role: 'neighbour', passport: { appearance: 'old woman', clothes: 'shawl', video_tokens: 'old woman, shawl' } });
            expect(r.status).to.equal(201);
            expect(r.body.hero_id).to.equal('anna');
            expect(r.body.rev).to.match(/^[0-9a-f]{16}$/);
            expect(t.readHero(B, 'anna')).to.deep.equal({ schema: 'animastor.character/1', id: 'anna', name: 'Анна', role: 'neighbour', passport: { appearance: 'old woman', clothes: 'shawl', video_tokens: ['old woman', 'shawl'] } });
        });
        it('id from a Cyrillic name (transliteration, snake_case); a free-form id is transliterated', async () => {
            const a = await t.api('POST', `/api/v1/book/${B}/heroes`, { name: 'Анна Сергеевна', passport: {} });
            expect(a.status).to.equal(201);
            expect(a.body.hero_id).to.equal('anna_sergeevna');
            const b = await t.api('POST', `/api/v1/book/${B}/heroes`, { id: 'Женщина в будке', name: 'Женщина', voice: { timbre: 'Shrill voice.' } });
            expect(b.status).to.equal(201);
            expect(b.body.hero_id).to.match(/^zhenschina_v_budke$|^zhenshchina_v_budke$/);
            const voiceOnly = t.readHero(B, b.body.hero_id);
            expect(voiceOnly).to.not.have.property('passport');
            expect(voiceOnly.voice).to.deep.equal({ timbre: 'Shrill voice.', timbre_source: 'user' });
        });
        it('409 hero_exists; 400 reserved_id; 400 name_required; 400 invalid_hero_id; role narrator only for the narrator', async () => {
            expect((await t.api('POST', `/api/v1/book/${B}/heroes`, { id: 'yura', name: 'Другой' })).body.error).to.equal('hero_exists');
            const reserved = await t.api('POST', `/api/v1/book/${B}/heroes`, { id: 'book', name: 'Книга' });
            expect(reserved.status).to.equal(400);
            expect(reserved.body.error).to.equal('reserved_id');
            const noName = await t.api('POST', `/api/v1/book/${B}/heroes`, { id: 'anna' });
            expect(noName.status).to.equal(400);
            expect(noName.body.error).to.equal('name_required');
            const long = await t.api('POST', `/api/v1/book/${B}/heroes`, { id: 'a'.repeat(65), name: 'X' });
            expect(long.status).to.equal(400);
            expect(long.body.error).to.equal('invalid_hero_id');
            const punct = await t.api('POST', `/api/v1/book/${B}/heroes`, { name: '!!!' });
            expect(punct.body.error).to.equal('invalid_hero_id');
            expect((await t.api('POST', `/api/v1/book/${B}/heroes`, { id: 'anna', name: 'Анна', role: 'narrator' })).status).to.equal(400);
        });
        it('409 hero_file_broken: the id of a broken file is not taken over, the file keeps its bytes', async () => {
            fs.writeFileSync(t.heroFile(B, 'anna'), '{ broken');
            const r = await t.api('POST', `/api/v1/book/${B}/heroes`, { id: 'anna', name: 'Анна' });
            expect(r.status).to.equal(409);
            expect(r.body.error).to.equal('hero_file_broken');
            expect(fs.readFileSync(t.heroFile(B, 'anna'), 'utf8')).to.equal('{ broken');
        });
        it('the narrator is re-created with {id: "narrator"} when its file is missing (§10.3)', async () => {
            fs.unlinkSync(t.heroFile(B, 'narrator'));
            const r = await t.api('POST', `/api/v1/book/${B}/heroes`, { id: 'narrator' });
            expect(r.status).to.equal(201);
            expect(t.readHero(B, 'narrator')).to.include({ id: 'narrator', role: 'narrator' });
        });
    });

    // ── patch ────────────────────────────────────────────────────────────
    describe('PATCH /heroes/:heroId', () => {
        it('white list only (400 field_not_editable); null removes; texts and lists', async () => {
            const bad = await t.api('PATCH', `/api/v1/book/${B}/heroes/yura`, { fields: { 'voice.reference': null, id: 'x' } });
            expect(bad.status).to.equal(400);
            expect(bad.body.error).to.equal('field_not_editable');
            expect(bad.body.fields).to.deep.equal(['voice.reference', 'id']);
            const r = await t.api('PATCH', `/api/v1/book/${B}/heroes/yura`, { fields: { role: null, notes: '', aliases: ['Юрка', ' Юрий '], 'behaviour.profile.quirks': ['a', 'b'] } });
            expect(r.status).to.equal(200);
            const hero = t.readHero(B, 'yura');
            expect(hero).to.not.have.property('role');
            expect(hero).to.not.have.property('notes');
            expect(hero.aliases).to.deep.equal(['Юрка', 'Юрий']);
            expect(hero.behaviour.profile.quirks).to.deep.equal(['a', 'b']);
            expect(hero.behaviour.profile.reactions[0]).to.include({ note: 'kept' }, 'an untouched list keeps unknown keys');
            expect(hero.behaviour.rules).to.have.length(1);
        });
        it('blocks: passport: null / voice: null remove, {} adds; voice.timbre → timbre_source user', async () => {
            await t.api('PATCH', `/api/v1/book/${B}/heroes/sveta`, { fields: { passport: null } });
            expect(t.readHero(B, 'sveta')).to.not.have.property('passport');
            // looks override the passport: a hero with looks keeps it (schema)
            const withLooks = await t.api('PATCH', `/api/v1/book/${B}/heroes/yura`, { fields: { passport: null } });
            expect(withLooks.status).to.equal(400);
            expect(withLooks.body.error).to.equal('invalid_character');
            expect(withLooks.body.errors[0]).to.include({ path: 'looks' });
            await t.api('PATCH', `/api/v1/book/${B}/heroes/sveta`, { fields: { voice: {}, 'voice.timbre': 'Bright soprano.' } });
            expect(t.readHero(B, 'sveta').voice).to.deep.equal({ timbre: 'Bright soprano.', timbre_source: 'user' });
            const narr = await t.api('PATCH', `/api/v1/book/${B}/heroes/narrator`, { fields: { voice: null } });
            expect(narr.status).to.equal(400);
            expect(narr.body.error).to.equal('narrator_voice_required');
        });
        it('409 rev_conflict with a stale if_rev; the current rev passes', async () => {
            const rev = (await t.api('GET', `/api/v1/book/${B}/heroes/yura`)).body.hero.rev;
            const ok = await t.api('PATCH', `/api/v1/book/${B}/heroes/yura`, { fields: { name: 'Юрочка' }, if_rev: rev });
            expect(ok.status).to.equal(200);
            expect(ok.body.rev).to.not.equal(rev);
            const stale = await t.api('PATCH', `/api/v1/book/${B}/heroes/yura`, { fields: { name: 'Юра' }, if_rev: rev });
            expect(stale.status).to.equal(409);
            expect(stale.body).to.include({ error: 'rev_conflict', rev: ok.body.rev });
            expect(t.readHero(B, 'yura').name).to.equal('Юрочка');
        });
        it('the card checks: name_required, alias_equals_name, too_many_video_tokens, too_many_aliases', async () => {
            const codes = async (fields) => (await t.api('PATCH', `/api/v1/book/${B}/heroes/yura`, { fields })).body.error;
            expect(await codes({ name: null })).to.equal('name_required');
            expect(await codes({ aliases: ['юра'] })).to.equal('alias_equals_name');
            expect(await codes({ 'passport.video_tokens': 'a, b, c, d, e' })).to.equal('too_many_video_tokens');
            expect(await codes({ aliases: Array.from({ length: 65 }, (_, i) => `a${i}`) })).to.equal('too_many_aliases');
        });
        it('409 hero_file_broken; 404 hero_not_found; 400 bad_request without fields', async () => {
            fs.writeFileSync(t.heroFile(B, 'sveta'), '[]');
            expect((await t.api('PATCH', `/api/v1/book/${B}/heroes/sveta`, { fields: { name: 'X' } })).body.error).to.equal('hero_file_broken');
            expect((await t.api('PATCH', `/api/v1/book/${B}/heroes/nobody`, { fields: { name: 'X' } })).status).to.equal(404);
            expect((await t.api('PATCH', `/api/v1/book/${B}/heroes/yura`, {})).body.error).to.equal('bad_request');
        });
        it('dirty: passport → image+video of the hero\'s scenes; timbre / manner / name / notes / behaviour → nothing', async () => {
            const p = await t.api('PATCH', `/api/v1/book/${B}/heroes/yura`, { fields: { 'passport.clothes': 'blue coat' } });
            expect(dirtyIds(p.body.dirty_scenes)).to.deep.equal([S1, S2]);
            for (const d of p.body.dirty_scenes) expect(d.dirty_layers).to.include.members(['image', 'video']).and.not.include('audio');
            expect(t.calls.bump).to.have.length(1);
            for (const fields of [{ 'voice.timbre': 'Other.' }, { 'voice.manner': 'Fast.' }, { name: 'Юрочка' }, { notes: 'x' }, { 'behaviour.profile.baseline': 'nervous' }]) {
                const r = await t.api('PATCH', `/api/v1/book/${B}/heroes/yura`, { fields });
                expect(r.body.dirty_scenes, JSON.stringify(fields)).to.deep.equal([]);
            }
        });
    });

    // ── delete ───────────────────────────────────────────────────────────
    describe('DELETE /heroes/:heroId, DELETE /hero-files', () => {
        it('removes the WHOLE hero file; the scenes keep the id; 404 for an unknown hero', async () => {
            const r = await t.api('DELETE', `/api/v1/book/${B}/heroes/sveta`);
            expect(r.status).to.equal(200);
            expect(fs.existsSync(t.heroFile(B, 'sveta'))).to.equal(false);
            expect(t.readChapter(B, h.CH1).scenes[0].participants).to.deep.equal(['yura', 'sveta']);
            expect(dirtyIds(r.body.dirty_scenes)).to.deep.equal([S1, S3]);
            expect((await t.api('DELETE', `/api/v1/book/${B}/heroes/sveta`)).status).to.equal(404);
        });
        it('409 narrator_required — the narrator cannot be deleted', async () => {
            const r = await t.api('DELETE', `/api/v1/book/${B}/heroes/narrator`);
            expect(r.status).to.equal(409);
            expect(r.body.error).to.equal('narrator_required');
            expect(fs.existsSync(t.heroFile(B, 'narrator'))).to.equal(true);
        });
        it('a broken file: without ?broken=1 → 409 hero_file_broken; with it → deleted; a healthy one with it → 409 hero_not_broken', async () => {
            fs.writeFileSync(t.heroFile(B, 'sveta'), '{ broken');
            expect((await t.api('DELETE', `/api/v1/book/${B}/heroes/sveta`)).body.error).to.equal('hero_file_broken');
            expect((await t.api('DELETE', `/api/v1/book/${B}/heroes/yura?broken=1`)).body.error).to.equal('hero_not_broken');
            const r = await t.api('DELETE', `/api/v1/book/${B}/heroes/sveta?broken=1`);
            expect(r.status).to.equal(200);
            expect(r.body.broken).to.equal(true);
            expect(fs.existsSync(t.heroFile(B, 'sveta'))).to.equal(false);
        });
        it('(В14) /hero-files deletes a broken file with a non-canonical name listed in hero_issues', async () => {
            h.writeBook(t.booksDir, 'hero_book_2', { extraFiles: { 'Юра.json': '{"schema":"animastor.character/1","id":"yura"}', 'notes.txt': 'x' } });
            const issues = (await t.api('GET', '/api/v1/book/hero_book_2')).body.hero_issues.filter((i) => i.blocking);
            expect(issues.map((i) => i.file).sort()).to.deep.equal(['characters/notes.txt', 'characters/Юра.json']);
            const r = await t.api('DELETE', `/api/v1/book/hero_book_2/hero-files?file=${encodeURIComponent('Юра.json')}`);
            expect(r.status).to.equal(200);
            expect(fs.existsSync(path.join(t.bookDir('hero_book_2'), 'characters', 'Юра.json'))).to.equal(false);
            expect((await t.api('DELETE', '/api/v1/book/hero_book_2/hero-files?file=notes.txt')).status).to.equal(200);
        });
        it('/hero-files refuses a name that is not in hero_issues (404) and anything that is not one plain name (422)', async () => {
            const healthy = await t.api('DELETE', `/api/v1/book/${B}/hero-files?file=yura.json`);
            expect(healthy.status).to.equal(404);
            expect(healthy.body.error).to.equal('not_in_hero_issues');
            expect(fs.existsSync(t.heroFile(B, 'yura'))).to.equal(true);
            for (const bad of ['../manifest.json', '..', 'a/b.json', '.hidden', '']) {
                const r = await t.api('DELETE', `/api/v1/book/${B}/hero-files?file=${encodeURIComponent(bad)}`);
                expect(r.status, bad).to.equal(422);
                expect(r.body.error).to.equal('invalid_file_name');
            }
            expect((await t.api('DELETE', `/api/v1/book/${B}/hero-files`)).status).to.equal(422);
            expect(fs.existsSync(path.join(t.bookDir(B), 'manifest.json'))).to.equal(true);
        });
        it('/hero-files removes a symbolic link as a link — its target stays', async () => {
            const target = path.join(t.sandbox, 'outside.json');
            fs.writeFileSync(target, '{}');
            fs.symlinkSync(target, path.join(t.bookDir(B), 'characters', 'link.json'));
            const r = await t.api('DELETE', `/api/v1/book/${B}/hero-files?file=link.json`);
            expect(r.status).to.equal(200);
            expect(fs.existsSync(path.join(t.bookDir(B), 'characters', 'link.json'))).to.equal(false);
            expect(fs.readFileSync(target, 'utf8')).to.equal('{}');
        });
    });

    // ── rules ────────────────────────────────────────────────────────────
    describe('rules of a hero', () => {
        it('POST: id <hero>.<three words>, unique in the book; enabled by default; no dirty layer', async () => {
            const r = await t.api('POST', `/api/v1/book/${B}/heroes/yura/rules`, { when: { emotion: ['sad'] }, then: { action: 'Looks away and sighs deeply' }, probability: 0.35 });
            expect(r.status).to.equal(201);
            expect(r.body.rule_id).to.equal('yura.looks_away_and');
            const rule = t.readHero(B, 'yura').behaviour.rules.find((x) => x.id === 'yura.looks_away_and');
            expect(rule).to.include({ probability: 0.35, enabled: true });
            expect(rule).to.not.have.property('scope');
            const again = await t.api('POST', `/api/v1/book/${B}/heroes/yura/rules`, { when: { emotion: ['sad'] }, then: { action: 'looks away and sighs' } });
            expect(again.body.rule_id).to.equal('yura.looks_away_and_2');
        });
        it('409 rule_exists (a global rule id too); 400 invalid_rule (no action, scope / character_id)', async () => {
            const dup = await t.api('POST', `/api/v1/book/${B}/heroes/yura/rules`, { id: 'global.sigh', then: { action: 'sighs' } });
            expect(dup.status).to.equal(409);
            expect(dup.body.error).to.equal('rule_exists');
            expect((await t.api('POST', `/api/v1/book/${B}/heroes/yura/rules`, { when: {} })).body.error).to.equal('invalid_rule');
            expect((await t.api('POST', `/api/v1/book/${B}/heroes/yura/rules`, { then: { action: 'x' }, scope: 'character' })).body.error).to.equal('invalid_rule');
        });
        it('PATCH {enabled} — the card switch; 404 rule_not_found; 400 field_not_editable; DELETE', async () => {
            const p = await t.api('PATCH', `/api/v1/book/${B}/heroes/yura/rules/yura.praised`, { fields: { enabled: false } });
            expect(p.status).to.equal(200);
            expect(t.readHero(B, 'yura').behaviour.rules[0].enabled).to.equal(false);
            expect((await t.api('PATCH', `/api/v1/book/${B}/heroes/yura/rules/nope`, { fields: { enabled: true } })).status).to.equal(404);
            expect((await t.api('PATCH', `/api/v1/book/${B}/heroes/yura/rules/yura.praised`, { fields: { id: 'x' } })).body.error).to.equal('field_not_editable');
            const d = await t.api('DELETE', `/api/v1/book/${B}/heroes/yura/rules/yura.praised`);
            expect(d.status).to.equal(200);
            expect(t.readHero(B, 'yura').behaviour).to.not.have.property('rules');
            expect((await t.api('DELETE', `/api/v1/book/${B}/heroes/yura/rules/yura.praised`)).body.error).to.equal('rule_not_found');
        });
    });

    // ── looks ────────────────────────────────────────────────────────────
    describe('looks (§4a) and POST /looks/assign', () => {
        it('POST: id from the label; 409 look_exists; 400 look_empty / look_label_required / invalid_look_id; 409 passport_required', async () => {
            const r = await t.api('POST', `/api/v1/book/${B}/heroes/yura/looks`, { label: 'С бородой', fields: { appearance: 'tall man, thick beard' } });
            expect(r.status).to.equal(201);
            expect(r.body.look_id).to.equal('s_borodoy');
            expect(t.readHero(B, 'yura').looks.map((l) => l.id)).to.deep.equal(['coat', 's_borodoy']);
            expect((await t.api('POST', `/api/v1/book/${B}/heroes/yura/looks`, { id: 'coat', label: 'X', fields: { clothes: 'x' } })).body.error).to.equal('look_exists');
            expect((await t.api('POST', `/api/v1/book/${B}/heroes/yura/looks`, { label: 'X', fields: {} })).body.error).to.equal('look_empty');
            expect((await t.api('POST', `/api/v1/book/${B}/heroes/yura/looks`, { fields: { clothes: 'x' } })).body.error).to.equal('look_label_required');
            expect((await t.api('POST', `/api/v1/book/${B}/heroes/yura/looks`, { id: 'base', label: 'X', fields: { clothes: 'x' } })).body.error).to.equal('invalid_look_id');
            const narr = await t.api('POST', `/api/v1/book/${B}/heroes/narrator/looks`, { label: 'X', fields: { clothes: 'x' } });
            expect(narr.status).to.equal(409);
            expect(narr.body.error).to.equal('passport_required');
        });
        it('assign to a chapter → image+video of the chapter\'s scenes where the hero is; base for a scene; null releases', async () => {
            const a = await t.api('POST', `/api/v1/book/${B}/looks/assign`, { hero_id: 'yura', look_id: 'coat', chapters: [h.CH1] });
            expect(a.status).to.equal(200);
            expect(t.readChapter(B, h.CH1).looks).to.deep.equal({ yura: 'coat' });
            expect(dirtyIds(a.body.dirty_scenes)).to.deep.equal([S1, S2]);
            for (const d of a.body.dirty_scenes) expect(d.dirty_layers).to.not.include('audio');
            const base = await t.api('POST', `/api/v1/book/${B}/looks/assign`, { hero_id: 'yura', look_id: 'base', scenes: [{ chapter_id: h.CH1, scene_id: S2 }] });
            expect(t.readChapter(B, h.CH1).scenes[1].looks).to.deep.equal({ yura: 'base' });
            expect(dirtyIds(base.body.dirty_scenes)).to.deep.equal([S2]);
            const rel = await t.api('POST', `/api/v1/book/${B}/looks/assign`, { hero_id: 'yura', look_id: null, chapters: [h.CH1], scenes: [{ chapter_id: h.CH1, scene_id: S2 }] });
            expect(rel.status).to.equal(200);
            const ch = t.readChapter(B, h.CH1);
            expect(ch).to.not.have.property('looks');
            expect(ch.scenes[1]).to.not.have.property('looks');
        });
        it('assign refusals: base for a chapter 400, unknown look 404, unknown chapter / scene 404, no passport 409, bad body 400', async () => {
            const call = (body) => t.api('POST', `/api/v1/book/${B}/looks/assign`, body);
            expect((await call({ hero_id: 'yura', look_id: 'base', chapters: [h.CH1] })).body.error).to.equal('base_for_chapter');
            expect((await call({ hero_id: 'yura', look_id: 'nope', chapters: [h.CH1] })).body.error).to.equal('look_not_found');
            expect((await call({ hero_id: 'yura', look_id: 'coat', chapters: ['ch-00000000'] })).body.error).to.equal('chapter_not_found');
            expect((await call({ hero_id: 'yura', look_id: 'coat', scenes: [{ chapter_id: h.CH1, scene_id: 'sc-99999999' }] })).body.error).to.equal('scene_not_found');
            expect((await call({ hero_id: 'narrator', look_id: null, chapters: [h.CH1] })).body.error).to.equal('passport_required');
            expect((await call({ hero_id: 'yura', look_id: 'coat' })).status).to.equal(400);
            expect((await call({ hero_id: 'Yura', look_id: 'coat', chapters: [h.CH1] })).body.error).to.equal('invalid_hero_id');
        });
        it('PATCH a look: dirty only where it applies; removing the last field → 400 look_empty; label null → 400', async () => {
            await t.api('POST', `/api/v1/book/${B}/looks/assign`, { hero_id: 'yura', look_id: 'coat', scenes: [{ chapter_id: h.CH1, scene_id: S1 }] });
            const p = await t.api('PATCH', `/api/v1/book/${B}/heroes/yura/looks/coat`, { fields: { 'fields.clothes': 'black coat' } });
            expect(p.status).to.equal(200);
            expect(dirtyIds(p.body.dirty_scenes)).to.deep.equal([S1]);
            const label = await t.api('PATCH', `/api/v1/book/${B}/heroes/yura/looks/coat`, { fields: { label: 'Чёрное пальто', notes: 'x' } });
            expect(label.body.dirty_scenes).to.deep.equal([], 'label / notes → nothing');
            await t.api('PATCH', `/api/v1/book/${B}/heroes/yura/looks/coat`, { fields: { 'fields.video_tokens': null } });
            const last = await t.api('PATCH', `/api/v1/book/${B}/heroes/yura/looks/coat`, { fields: { 'fields.clothes': null } });
            expect(last.status).to.equal(400);
            expect(last.body.error).to.equal('look_empty');
            expect((await t.api('PATCH', `/api/v1/book/${B}/heroes/yura/looks/coat`, { fields: { label: null } })).body.error).to.equal('look_label_required');
            expect((await t.api('PATCH', `/api/v1/book/${B}/heroes/yura/looks/nope`, { fields: { label: 'x' } })).status).to.equal(404);
        });
        it('DELETE a look releases every reference to it (unassigned) in one save', async () => {
            await t.api('POST', `/api/v1/book/${B}/looks/assign`, { hero_id: 'yura', look_id: 'coat', chapters: [h.CH1], scenes: [{ chapter_id: h.CH1, scene_id: S2 }] });
            const d = await t.api('DELETE', `/api/v1/book/${B}/heroes/yura/looks/coat`);
            expect(d.status).to.equal(200);
            expect(d.body.unassigned).to.deep.equal([{ chapter_id: h.CH1 }, { chapter_id: h.CH1, scene_id: S2 }]);
            expect(t.readHero(B, 'yura')).to.not.have.property('looks');
            expect(t.readChapter(B, h.CH1)).to.not.have.property('looks');
            expect((await t.api('DELETE', `/api/v1/book/${B}/heroes/yura/looks/coat`)).body.error).to.equal('look_not_found');
        });
    });

    // ── scene PATCH ──────────────────────────────────────────────────────
    describe('PATCH /scene — looks.<hero_id> and look_patch.<hero_id>.<field>', () => {
        const scene = `/api/v1/book/${B}/scene/${h.CH1}/${S1}`;
        it('sets the look and a one-off field; comma text → array; "" removes; empty maps are dropped', async () => {
            const r = await t.api('PATCH', scene, { fields: { 'looks.yura': 'coat', 'look_patch.sveta.video_tokens': 'woman, red hair, umbrella' } });
            expect(r.status).to.equal(200);
            let sc = t.readChapter(B, h.CH1).scenes[0];
            expect(sc.looks).to.deep.equal({ yura: 'coat' });
            expect(sc.look_patch).to.deep.equal({ sveta: { video_tokens: ['woman', 'red hair', 'umbrella'] } });
            await t.api('PATCH', scene, { fields: { 'looks.yura': null, 'look_patch.sveta.video_tokens': '' } });
            sc = t.readChapter(B, h.CH1).scenes[0];
            expect(sc).to.not.have.property('looks');
            expect(sc).to.not.have.property('look_patch');
        });
        it('scene.passport is gone (400 legacy_field); malformed look keys → 400 invalid_look_field', async () => {
            const legacy = await t.api('PATCH', scene, { fields: { 'passport.yura.clothes': 'x' } });
            expect(legacy.status).to.equal(400);
            expect(legacy.body.error).to.equal('legacy_field');
            for (const fields of [{ 'looks.yura.x': 'coat' }, { 'look_patch.yura.hair': 'x' }, { 'looks.yura': 'Coat!' }]) {
                const r = await t.api('PATCH', scene, { fields });
                expect(r.status, JSON.stringify(fields)).to.equal(400);
                expect(r.body.error).to.equal('invalid_look_field');
            }
        });
    });

    // ── behaviour ────────────────────────────────────────────────────────
    describe('GET / PATCH /behaviour (book level)', () => {
        it('reads and writes the defaults and global rules; 400 invalid_behaviour / field_not_editable', async () => {
            const g = await t.api('GET', `/api/v1/book/${B}/behaviour`);
            expect(g.body.behaviour.defaults).to.deep.equal({ max_per_scene: 2 });
            const p = await t.api('PATCH', `/api/v1/book/${B}/behaviour`, { fields: { 'defaults.max_per_scene': 3 } });
            expect(p.status).to.equal(200);
            expect(JSON.parse(fs.readFileSync(path.join(t.bookDir(B), 'behaviour.json'), 'utf8')).defaults.max_per_scene).to.equal(3);
            expect((await t.api('PATCH', `/api/v1/book/${B}/behaviour`, { fields: { rules: 'nope' } })).body.error).to.equal('invalid_behaviour');
            expect((await t.api('PATCH', `/api/v1/book/${B}/behaviour`, { fields: { schema: 'x' } })).body.error).to.equal('field_not_editable');
        });
        it('a broken behaviour.json: GET shows the issue, PATCH → 409 behaviour_file_broken, the file keeps its bytes', async () => {
            fs.writeFileSync(path.join(t.bookDir(B), 'behaviour.json'), '{ broken');
            expect((await t.api('GET', `/api/v1/book/${B}/behaviour`)).body.issue.code).to.equal('invalid_json');
            const p = await t.api('PATCH', `/api/v1/book/${B}/behaviour`, { fields: { 'defaults.max_per_scene': 3 } });
            expect(p.status).to.equal(409);
            expect(p.body.error).to.equal('behaviour_file_broken');
            expect(fs.readFileSync(path.join(t.bookDir(B), 'behaviour.json'), 'utf8')).to.equal('{ broken');
        });
    });

    // ── what is gone, and a 3.1 book ─────────────────────────────────────
    describe('the 3.1 routes are gone; a 3.1 book answers 409', () => {
        it('/characters, /voices, /behaviors (POST / PATCH / DELETE) are not routes any more (404)', async () => {
            for (const [m, u] of [['POST', 'characters'], ['PATCH', 'characters/yura'], ['DELETE', 'characters/yura'],
                ['POST', 'voices'], ['PATCH', 'voices/yura'], ['DELETE', 'voices/yura'],
                ['POST', 'behaviors'], ['PATCH', 'behaviors/yura'], ['DELETE', 'behaviors/yura']]) {
                const r = await t.api(m, `/api/v1/book/${B}/${u}`, m === 'DELETE' ? undefined : { fields: { name: 'x' }, name: 'x' });
                expect(r.status, `${m} ${u}`).to.equal(404);
            }
            expect(fs.existsSync(path.join(t.bookDir(B), 'characters.json'))).to.equal(false);
            expect(fs.existsSync(path.join(t.bookDir(B), 'voices.json'))).to.equal(false);
        });
        it('every hero route of a 3.1 book → 409 unsupported_vbook_version (the GET /book body), no file changes', async () => {
            const old = path.join(t.booksDir, 'old_book_31');
            fs.mkdirSync(old, { recursive: true });
            fs.writeFileSync(path.join(old, 'manifest.json'), JSON.stringify({ book_id: 'old_book_31', vbook_version: '3.1' }));
            fs.writeFileSync(path.join(old, 'book.json'), JSON.stringify({ title: 'Old' }));
            const ref = (await t.api('GET', '/api/v1/book/old_book_31')).body;
            expect(ref.error).to.equal('unsupported_vbook_version');
            for (const [m, u, body] of [['GET', 'heroes'], ['POST', 'heroes', { name: 'A' }], ['PATCH', 'heroes/yura', { fields: { name: 'x' } }],
                ['DELETE', 'heroes/yura'], ['POST', 'looks/assign', { hero_id: 'yura', look_id: null, chapters: ['ch-1'] }], ['GET', 'behaviour']]) {
                const r = await t.api(m, `/api/v1/book/old_book_31/${u}`, body);
                expect(r.status, `${m} ${u}`).to.equal(409);
                expect(r.body).to.deep.equal(ref);
            }
            expect(fs.readdirSync(old).sort()).to.deep.equal(['book.json', 'manifest.json']);
        });
    });
});
