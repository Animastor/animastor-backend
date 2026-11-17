// ======================================================
// Voice cleanup rules v3 (VBook 4 step 2b)
// ======================================================
// Acceptance 2.6 (reports/2026-11-17/vbook-v4-acceptance-2.6.md):
//   - "frequent hiccups breaking the flow of speech" (Bezdomny's hiccups are an
//     episode of chapter 1) reached manner;
//   - "spoken with a foreign accent. Native Russian pronunciation." — a
//     contradiction: the suffix was written for every hero.
// v3: episodic physical states are cut from both fields; the pronunciation
// suffix follows the book language and is not added when timbre has an accent.

'use strict';

const { expect } = require('chai');
const voice = require('../src/voice.js');

const parse = (timbre, manner, language) => voice.voiceFromAnalysis({ timbre, manner }, { language });

describe('voice cleanup rules v3 (step 2b)', () => {
    it('the rules version is 4 (v3 behaviour below still holds; v4 — voice-rules-v4.test.js)', () => {
        expect(voice.CLEANUP_RULES_VERSION).to.equal(4);
        expect(voice.cleanVoiceDescription('A voice.').rules_version).to.equal(4);
    });

    describe('the phrases of the acceptance run', () => {
        it('Bezdomny: the hiccups clause is cut from manner, the habit stays', () => {
            const r = parse('Clear male tenor of a young man, light and slightly thin texture. Native Russian pronunciation.',
                'Impulsive and irritable, with abrupt interruptions and frequent hiccups breaking the flow of speech.', 'ru');
            expect(r.voice.manner).to.equal('Impulsive and irritable.');
            expect(r.voice.timbre).to.equal('Clear male tenor of a young man, light and slightly thin texture. Native Russian pronunciation.');
            expect(r.voice.timbre_source).to.equal('cleaned');
            expect(r.removed).to.deep.equal(['with abrupt interruptions and frequent hiccups breaking the flow of speech']);
        });

        it('Woland: an accent in timbre → no "Native … pronunciation"', () => {
            const r = parse('Low, thin male voice of a tall man over forty, dry and resonant texture, spoken with a foreign accent. Native Russian pronunciation.',
                'Polite and inquisitive, with a habit of lowering his voice conspiratorially and trailing off into pauses.', 'ru');
            expect(r.voice.timbre).to.equal('Low, thin male voice of a tall man over forty, dry and resonant texture, spoken with a foreign accent.');
            expect(r.voice.manner).to.equal('Polite and inquisitive, with a habit of lowering his voice conspiratorially and trailing off into pauses.');
            // normalisation is not a removal
            expect(r.voice.timbre_source).to.equal('analysis');
        });
    });

    describe('the pronunciation suffix follows the language of the book', () => {
        const CASES = [
            ['ru: missing → added', 'A warm low baritone.', 'ru', 'A warm low baritone. Native Russian pronunciation.'],
            ['ru: another language → replaced', 'A warm low baritone. Native English pronunciation.', 'ru', 'A warm low baritone. Native Russian pronunciation.'],
            ['de: the Russian suffix → German', 'Bright tenor, Native Russian pronunciation.', 'de', 'Bright tenor. Native German pronunciation.'],
            ['en-GB → English', 'A clear soprano', 'en-GB', 'A clear soprano. Native English pronunciation.'],
            ['two suffixes → one', 'A bass. Native Russian pronunciation. Native Russian pronunciation.', 'ru', 'A bass. Native Russian pronunciation.'],
            ['an accent, no language given', 'A baritone with a heavy Georgian accent. Native Russian pronunciation.', undefined, 'A baritone with a heavy Georgian accent.'],
            ['Russian word «акцент»', 'Низкий голос с лёгким немецким акцентом. Native Russian pronunciation.', 'ru', 'Низкий голос с лёгким немецким акцентом.'],
            ['unknown language: left as it is', 'A bass. Native Russian pronunciation.', 'xx', 'A bass. Native Russian pronunciation.'],
            ['no language (write-time re-parse): left as it is', 'A bass. Native Russian pronunciation.', undefined, 'A bass. Native Russian pronunciation.'],
        ];
        for (const [name, timbre, lang, want] of CASES) {
            it(name, () => expect(parse(timbre, '', lang).voice.timbre).to.equal(want));
        }

        it('idempotent: a parsed voice parsed again gives the same block', () => {
            const once = parse('Hoarse young male voice. Native English pronunciation.', 'Fast.', 'ru').voice;
            const twice = voice.voiceFromAnalysis(once, { language: 'ru' }).voice;
            const atWrite = voice.voiceFromAnalysis(once).voice;
            expect(twice).to.deep.equal(once);
            expect(atWrite).to.deep.equal(once);
        });

        it('a timbre that is only the suffix is not emptied', () => {
            expect(parse('Native Russian pronunciation.', '', 'ru').voice.timbre).to.equal('Native Russian pronunciation.');
        });
    });

    describe('episodic physical states are in neither field', () => {
        // [name, manner, what must be left of it]
        const STATES = [
            ['hiccups', 'Speaks fast, hiccuping between words.', 'Speaks fast.'],
            ['hiccough', 'Hiccoughs constantly.'],
            ['drunk', 'Drunken, slurred delivery.', 'Slurred delivery.'],
            ['intoxicated', 'Sounds intoxicated.'],
            ['tipsy', 'A little tipsy, giggling.', 'Giggling.'],
            ['crying', 'Speaks through tears.'],
            ['sobbing', 'Sobbing, broken phrases.', 'Broken phrases.'],
            ['tearful', 'Tearful and quiet.'],
            ['ill', 'Sounds ill and weak.'],
            // v4: the condition is cut by clause, the texture stays
            ['cold', 'Nasal, as if with a cold.', 'Nasal.'],
            ['fever', 'Feverish, mumbling.', 'Mumbling.'],
            ['out of breath', 'Out of breath after running.'],
            ['panting', 'Panting heavily.'],
            ['breathless', 'Breathless and hurried.'],
            ['икота', 'Говорит с икотой.'],
            ['пьяный', 'Пьяная, заплетающаяся речь.', 'Заплетающаяся речь.'],
            ['плач', 'Говорит сквозь слёзы.'],
            ['запыхался', 'Запыхавшись, глотает слова.', 'Глотает слова.'],
        ];
        for (const [name, sentence, left = ''] of STATES) {
            it(`manner: ${name} → the clause is cut${left ? `, «${left}» stays` : ''}`, () => {
                const r = parse('A deep male bass.', sentence, 'ru');
                expect(r.voice.manner, sentence).to.equal(left);
                expect(r.removed.length).to.be.above(0);
                expect(r.voice.timbre_source).to.equal('cleaned');
            });
        }

        it('timbre: the state clause is cut, the voice stays; a timbre of a state only → no voice', () => {
            expect(parse('A hoarse tenor, slurred from drink, drunk and loud.', '', 'ru').voice.timbre)
                .to.equal('A hoarse tenor, slurred from drink. Native Russian pronunciation.');
            expect(parse('Sobbing and drunk.', 'Fast.', 'ru')).to.include({ voice: null, reason: 'timbre_empty' });
        });

        it('permanent qualities that look alike are kept: breathy, hoarse, raspy, ill-tempered, sickly-sweet tone is not "sick"', () => {
            const r = parse('A breathy, hoarse, raspy alto.', 'Ill-tempered and curt.', 'ru');
            expect(r.voice.timbre).to.equal('A breathy, hoarse, raspy alto. Native Russian pronunciation.');
            expect(r.voice.manner).to.equal('Ill-tempered and curt.');
            expect(r.removed).to.deep.equal([]);
        });
    });
});
