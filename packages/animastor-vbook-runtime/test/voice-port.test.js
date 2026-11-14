'use strict';

const { expect } = require('chai');
const voice = require('../src/voice');
const { validateBundleObject } = require('../src/bundle-validator.cjs');

const SHA = 'a'.repeat(64);
const ref = (over = {}) => ({
    file: 'voices/anna/c1.wav', ref_text: 'Тестовая фраза.', source: 'designed',
    model: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign', seed: 7, sha256: SHA,
    verification: 'passed', locked: true, candidate_id: 'c1', ...over,
});

const hero = (id, voiceObj, extra = {}) => ({ schema: 'animastor.character/1', id, ...(voiceObj ? { voice: voiceObj } : {}), ...extra });

// The port of the voice-reference task, unchanged in names and checks; in
// VBook 4 the voice lives in the hero file (book.heroes[].voice).
describe('voice port (VOICE_REFERENCES.md) on VBook 4 storage', () => {
    it('getCharacterVoice reads timbre / manner / reference from the hero; there is no instruction', () => {
        const book = { heroes: [
            hero('anna', { timbre: ' Low warm female. ', manner: '', timbre_source: 'cleaned', reference: ref() }),
            hero('old', { instruction: 'x' }),
            hero('mute', null, { passport: { appearance: 'tall' } }),
        ] };
        const v = voice.getCharacterVoice(book, 'anna');
        expect(v.timbre).to.equal('Low warm female.');
        expect(v.reference.sha256).to.equal(SHA);
        expect(v.reference_problem).to.equal(null);
        const old = voice.getCharacterVoice(book, 'old');
        expect(old.timbre).to.equal('');
        expect(old.reference).to.equal(null);
        expect(voice.getCharacterVoice(book, 'mute')).to.equal(null);      // a hero without a voice block
        expect(voice.getCharacterVoice(book, 'missing')).to.equal(null);
        expect(voice.listVoiceIds(book)).to.deep.equal(['anna', 'old']);
    });

    it('the 3.1 map book.voices is not a voice source', () => {
        const book = { voices: { anna: { timbre: 't', reference: ref() } }, heroes: [] };
        expect(voice.getCharacterVoice(book, 'anna')).to.equal(null);
        expect(voice.listVoiceIds(book)).to.deep.equal([]);
    });

    it('a malformed reference is reported, not used', () => {
        const v = voice.getCharacterVoice({ heroes: [hero('anna', { timbre: 't', reference: ref({ sha256: 'xyz' }) })] }, 'anna');
        expect(v.reference).to.equal(null);
        expect(v.reference_problem).to.match(/sha256/);
    });

    it('a reference that points into another hero\'s folder is reported, not used', () => {
        const v = voice.getCharacterVoice({ heroes: [hero('boris', { timbre: 't', reference: ref() })] }, 'boris');
        expect(v.reference).to.equal(null);
        expect(v.reference_problem).to.match(/voices\/boris\//);
    });

    it('setCharacterVoiceReference sets / clears and validates', () => {
        const book = { heroes: [hero('anna', { timbre: 't' }), hero('boris', { timbre: 'b' })] };
        voice.setCharacterVoiceReference(book, 'anna', ref());
        expect(book.heroes[0].voice.reference.locked).to.equal(true);
        expect(book.heroes[0].voice.timbre).to.equal('t');
        const before = JSON.stringify(book);
        for (const file of ['../x.wav', '/abs/c1.wav', 'voices/anna/../boris/c1.wav', 'voices\\anna\\c1.wav', 'voices/anna/c1.exe', 'voices/anna/sub/c1.wav']) {
            expect(() => voice.setCharacterVoiceReference(book, 'anna', ref({ file })), file).to.throw(/reference.file/);
        }
        expect(() => voice.setCharacterVoiceReference(book, 'boris', ref())).to.throw(/voices\/boris\//);
        expect(() => voice.setCharacterVoiceReference(book, 'nobody', ref())).to.throw(/not found/);
        expect(JSON.stringify(book)).to.equal(before);
        voice.setCharacterVoiceReference(book, 'anna', null);
        expect(book.heroes[0].voice).to.not.have.property('reference');
    });

    it('a reference set through the port leaves the hero file valid — also for an uploaded sample (model/seed null)', () => {
        const { validateCharacterFile } = require('../src/bundle-validator.cjs');
        const book = { heroes: [hero('anna', { timbre: 't' })] };
        const returned = voice.setCharacterVoiceReference(book, 'anna', ref({ source: 'uploaded', model: null, seed: null, language: 'Russian' }));
        expect(returned).to.include({ model: null, seed: null, source: 'uploaded' });            // what callers always got
        expect(book.heroes[0].voice.reference).to.not.have.any.keys('model', 'seed');             // what is stored
        expect(validateCharacterFile(book.heroes[0], { filename: 'anna.json' })).to.deep.equal({ valid: true, errors: [], warnings: [] });
        const read = voice.getCharacterVoice(book, 'anna');
        expect(read.reference).to.deep.equal(returned);
        expect(read.reference_problem).to.equal(null);
        voice.setCharacterVoiceReference(book, 'anna', ref());
        expect(book.heroes[0].voice.reference).to.include({ model: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign', seed: 7 });
        expect(validateCharacterFile(book.heroes[0]).valid).to.equal(true);
    });

    it('setCharacterVoiceDescription updates a hero, and creates a voice-only hero for a new id', () => {
        const book = { heroes: [hero('anna', null, { passport: { appearance: 'tall' } })] };
        voice.setCharacterVoiceDescription(book, 'anna', { timbre: ' Warm. ', timbre_source: 'user' });
        expect(book.heroes[0]).to.deep.equal(hero('anna', { timbre: 'Warm.', timbre_source: 'user' }, { passport: { appearance: 'tall' } }));
        voice.setCharacterVoiceDescription(book, 'shop_women', { timbre: 'Sharp.' });
        expect(book.heroes[1]).to.deep.equal(hero('shop_women', { timbre: 'Sharp.' }));
        voice.setCharacterVoiceDescription(book, 'narrator', { timbre: 'Deep.' });
        expect(book.heroes[2]).to.deep.equal({ schema: 'animastor.character/1', id: 'narrator', role: 'narrator', voice: { timbre: 'Deep.' } });
        for (const id of ['Юра', '../x', 'book', 'a/b', '']) {
            expect(() => voice.setCharacterVoiceDescription(book, id, { timbre: 't' }), id).to.throw();
        }
        expect(book.heroes).to.have.length(3);
    });

    describe('reference file on disk', () => {
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const crypto = require('crypto');
        let sandbox, buildDir;
        beforeEach(() => {
            sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vbook-voice-'));
            buildDir = path.join(sandbox, 'build_b1');
            fs.mkdirSync(path.join(buildDir, 'voices', 'anna'), { recursive: true });
            fs.writeFileSync(path.join(sandbox, 'secret.wav'), 'secret');
        });
        afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

        it('resolveReferenceFile maps a link into build_<id>/voices/<hero>/ and nowhere else', () => {
            expect(voice.resolveReferenceFile(buildDir, { file: 'voices/anna/c1.wav' }))
                .to.equal(path.join(buildDir, 'voices', 'anna', 'c1.wav'));
            expect(voice.resolveReferenceFile(buildDir, { file: 'voices/anna/ref_02.flac' }, 'anna'))
                .to.equal(path.join(buildDir, 'voices', 'anna', 'ref_02.flac'));
            const bad = [
                '../secret.wav', 'voices/anna/../../../secret.wav', 'voices/../secret.wav', '/etc/passwd',
                path.join(sandbox, 'secret.wav'), 'voices\\anna\\c1.wav', 'voices/anna/..\\c1.wav', 'C:/voices/anna/c1.wav',
                'voices/anna/c1.exe', 'voices/anna/c1', 'voices/anna/sub/c1.wav', 'voices/Anna/c1.wav', 'voices/Юра/c1.wav',
                'voices//c1.wav', 'voices/anna/a..b.wav', 'voices/anna/./c1.wav', 'voices/book/c1.wav', 'refs/anna/c1.wav', '', null, 42,
            ];
            for (const file of bad) {
                let code = null;
                try { voice.resolveReferenceFile(buildDir, { file }); } catch (err) { code = err.code; }
                expect(code, JSON.stringify(file)).to.equal('bad_reference');
            }
            expect(() => voice.resolveReferenceFile(buildDir, { file: 'voices/boris/c1.wav' }, 'anna')).to.throw(/voices\/anna\//);
            expect(() => voice.resolveReferenceFile(buildDir, null)).to.throw(/bad reference/);
        });

        it('referenceState is ok / missing / mismatch and never follows a link', () => {
            const file = path.join(buildDir, 'voices', 'anna', 'c1.wav');
            const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
            const link = { file: 'voices/anna/c1.wav', sha256: sha('RIFF') };
            expect(voice.referenceState(buildDir, link)).to.equal('missing');
            fs.writeFileSync(file, 'RIFF');
            expect(voice.referenceState(buildDir, link)).to.equal('ok');
            expect(voice.referenceState(buildDir, link, 'anna')).to.equal('ok');
            expect(voice.referenceState(buildDir, link, 'boris')).to.equal('missing');
            fs.writeFileSync(file, 'changed');
            expect(voice.referenceState(buildDir, link)).to.equal('mismatch');
            fs.unlinkSync(file);
            fs.symlinkSync(path.join(sandbox, 'secret.wav'), file);
            expect(voice.referenceState(buildDir, { file: 'voices/anna/c1.wav', sha256: sha('secret') })).to.equal('missing');
            expect(voice.referenceState(buildDir, { file: '../secret.wav', sha256: sha('secret') })).to.equal('missing');
        });
    });

    it('narrator design text = timbre + manner; a character gets timbre only', () => {
        expect(voice.voiceDesignDescription({ id: 'narrator', timbre: 'Deep male.', manner: 'Slow narration.' })).to.equal('Deep male. Slow narration.');
        expect(voice.voiceDesignDescription({ id: 'anna', timbre: 'Warm female.', manner: 'Teasing.' })).to.equal('Warm female.');
    });

    it('narratorVoiceId: scene voice, scene-type markers ignored, book default, narrator', () => {
        expect(voice.narratorVoiceId({ audio: { voice: 'old_man' } }, {})).to.equal('old_man');
        expect(voice.narratorVoiceId({ audio: { voice: 'dialogue' } }, { book: { defaults: { narration_voice: 'v2' } } })).to.equal('v2');
        expect(voice.narratorVoiceId({}, {})).to.equal('narrator');
    });

    describe('cleanVoiceDescription (rules, no LLM)', () => {
        it('drops conditional sentences (en / ru / de)', () => {
            const r = voice.cleanVoiceDescription('A calm, warm male voice. Low and soft. When the interlocutor is a close friend, the voice becomes warmer. Если он злится, голос твердеет. Wenn er lacht, klingt er heller.');
            expect(r.timbre).to.equal('A calm, warm male voice. Low and soft.');
            expect(r.removed).to.have.length(3);
        });
        it('drops sentences with quoted plot text', () => {
            const r = voice.cleanVoiceDescription("Bright young female voice. Cheerful inflection on «поехали?». Says 'yes' playfully.");
            expect(r.timbre).to.equal('Bright young female voice.');
        });
        it('keeps a plain description intact and versioned', () => {
            const r = voice.cleanVoiceDescription('Medium-low female voice, confident and elegant.');
            expect(r.timbre).to.equal('Medium-low female voice, confident and elegant.');
            expect(r.removed).to.deep.equal([]);
            expect(r.rules_version).to.equal(voice.CLEANUP_RULES_VERSION);
        });
        it('does not treat words that merely contain "if" as conditionals', () => {
            expect(voice.cleanVoiceDescription('A gifted, different timbre.').timbre).to.equal('A gifted, different timbre.');
        });
        it('voiceFromDescription marks the result as cleaned', () => {
            expect(voice.voiceFromDescription('Warm. If angry, sharp.')).to.deep.equal({ timbre: 'Warm.', manner: '', timbre_source: 'cleaned' });
        });
    });

    it('bundle validator checks the voice fields and the reference link of a hero', () => {
        const base = {
            manifest: { book_id: 'b', vbook_version: 4 }, book: { structure: { chapters_order: [] } },
            locations: {}, behaviour: { schema: 'animastor.behaviour-globals/1', rules: [] },
        };
        const ok = validateBundleObject({ ...base, heroes: [hero('anna', { timbre: 't', manner: '', timbre_source: 'user', reference: ref() })] });
        expect(ok.errors || []).to.deep.equal([]);
        const bad = validateBundleObject({ ...base, heroes: [hero('anna', { timbre: 1, reference: ref({ source: 'web', file: 'voices/boris/c1.wav' }) })] });
        expect(bad.errors.join('\n')).to.match(/voice\.timbre: must be a string/)
            .and.match(/voice\.reference\.source/).and.match(/must be the hero id "anna"/);
        const legacy = validateBundleObject({ ...base, heroes: [], voices: { anna: { timbre: 't' } } });
        expect(legacy.errors.join('\n')).to.match(/voices: not part of VBook 4/);
    });
});
