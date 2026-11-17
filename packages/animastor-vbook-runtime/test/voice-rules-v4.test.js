// ======================================================
// Voice cleanup rules v4 (VBook 4, the rest of step 2b — owner's decisions 17.11)
// ======================================================
// Acceptance 2.6, rerun (reports/2026-11-17/vbook-v4-step2b.md):
//   - Berlioz's manner "Confident and lecturing, with an authoritative, steady
//     pace; becomes hurried and tremulous when anxious." was dropped WHOLE by
//     the v2 conditional rule → an empty manner. v4 cuts the conditional clause
//     only;
//   - appearance in timbre: "of a small, plump bald man". v4: sex, age and build
//     stay; hair / baldness, clothes and other looks are cut (timbre only).

'use strict';

const { expect } = require('chai');
const voice = require('../src/voice.js');

const parse = (timbre, manner, language = 'ru') => voice.voiceFromAnalysis({ timbre, manner }, { language });

describe('voice cleanup rules v4', () => {
    it('the rules version is 4', () => {
        expect(voice.CLEANUP_RULES_VERSION).to.equal(4);
    });

    describe('conditions: the clause is cut, the main part stays', () => {
        it('Berlioz (acceptance): → "Confident and lecturing, with an authoritative, steady pace."', () => {
            const r = parse('A high male tenor. Native Russian pronunciation.',
                'Confident and lecturing, with an authoritative, steady pace; becomes hurried and tremulous when anxious.');
            expect(r.voice.manner).to.equal('Confident and lecturing, with an authoritative, steady pace.');
            expect(r.removed).to.deep.equal(['becomes hurried and tremulous when anxious']);
            expect(r.voice.timbre_source).to.equal('cleaned');
        });

        const CASES = [
            ['clause after a comma', 'Speaks slowly, but quickens when excited.', 'Speaks slowly.'],
            ['if', 'Calm and measured, louder if contradicted.', 'Calm and measured.'],
            ['unless', 'Soft-spoken, unless provoked.', 'Soft-spoken.'],
            ['a dash', 'Quiet and even — sharp whenever someone interrupts.', 'Quiet and even.'],
            ['the other case goes with the condition', 'Fast when excited, otherwise slow and careful.', ''],
            ['ru: когда', 'Говорит размеренно, когда волнуется — сбивается.', 'Говорит размеренно.'],
            ['ru: если', 'Негромко и спокойно, громче если спорят.', 'Негромко и спокойно.'],
            ['de: wenn', 'Ruhig, lauter wenn er widerspricht.', 'Ruhig.'],
            // a sentence that STARTS with the condition is conditional as a whole
            ['leading "When …,"', 'When angry, he shouts. Slow pace.', 'Slow pace.'],
            ['leading «Если …,»', 'Если злится, кричит. Говорит медленно.', 'Говорит медленно.'],
            ['only a condition → nothing', 'Becomes hurried when anxious.', ''],
        ];
        for (const [name, manner, want] of CASES) {
            it(name, () => expect(parse('A low bass.', manner).voice.manner, manner).to.equal(want));
        }

        it('the separators of what stays are its own (the comma inside "authoritative, steady" is kept)', () => {
            const r = voice.cleanVoiceDescription('Dry, ironic; pauses before answering when unsure.');
            expect(r.timbre).to.equal('Dry, ironic.');
        });

        it('quoted words and "on the word …" still drop the whole sentence (v2)', () => {
            expect(voice.cleanVoiceDescription('Cheerful inflection on the word «поехали», calm otherwise. Low pace.').timbre).to.equal('Low pace.');
        });
    });

    describe('appearance in timbre: age, sex, build stay; hair, baldness, clothes, looks go', () => {
        it('Berlioz (acceptance rerun): "small, plump bald man" → "small, plump man"', () => {
            const r = parse('High, clear male tenor of a small, plump bald man in his forties, slightly nasal texture. Native Russian pronunciation.', '');
            expect(r.voice.timbre).to.equal('High, clear male tenor of a small, plump man in his forties, slightly nasal texture. Native Russian pronunciation.');
            expect(r.removed).to.deep.equal(['bald']);
            expect(r.voice.timbre_source).to.equal('cleaned');
        });

        it('Woland (acceptance rerun): "tall, extremely thin man" is build — unchanged', () => {
            const t = 'Low, dry male voice of a tall, extremely thin man over forty, with a slight foreign accent.';
            const r = parse(t, '');
            expect(r.voice.timbre).to.equal(t);
            expect(r.removed).to.deep.equal([]);
            expect(r.voice.timbre_source).to.equal('analysis');
        });

        it('acceptance 1: "of a small, plump middle-aged man", "broad-shouldered man" — build and age, unchanged', () => {
            for (const t of [
                'High, bright male tenor of a small, plump middle-aged man, clear and resonant. Native Russian pronunciation.',
                'Deep baritone of a broad-shouldered man around fifty. Native Russian pronunciation.',
            ]) expect(parse(t, '').voice.timbre).to.equal(t);
        });

        const CASES = [
            ['clothes: "in a grey suit"', 'Low baritone of a tall man in a grey suit. Native Russian pronunciation.', 'Low baritone of a tall man. Native Russian pronunciation.'],
            ['clothes: "wearing a checked cap"', 'Thin tenor of a lanky man wearing a checked cap and pince-nez, cracked texture.', 'Thin tenor of a lanky man, cracked texture. Native Russian pronunciation.'],
            ['beard: "with a grey beard"', 'Deep, gravelly bass of an old man with a long grey beard.', 'Deep, gravelly bass of an old man. Native Russian pronunciation.'],
            ['hair adjective', 'Bright soprano of a red-haired girl of twenty.', 'Bright soprano of a girl of twenty. Native Russian pronunciation.'],
            ['adjective first: "a bald, plump man"', 'Hoarse voice of a bald, plump man.', 'Hoarse voice of a plump man. Native Russian pronunciation.'],
            ['"and bald"', 'Tenor of a short and bald man.', 'Tenor of a short man. Native Russian pronunciation.'],
            ['a / an', 'Rasping voice of a bearded elderly man.', 'Rasping voice of an elderly man. Native Russian pronunciation.'],
            ['a clause of looks only', 'A clear alto, she wears glasses.', 'A clear alto. Native Russian pronunciation.'],
            ['ru: лысый, в сером костюме', 'Высокий тенор невысокого лысого мужчины в сером костюме.', 'Высокий тенор невысокого мужчины. Native Russian pronunciation.'],
            ['ru: с бородой, рыжий', 'Низкий бас рыжего старика с окладистой бородой.', 'Низкий бас старика. Native Russian pronunciation.'],
            ['ru: в пенсне', 'Дребезжащий тенор длинного худого гражданина в пенсне.', 'Дребезжащий тенор длинного худого гражданина. Native Russian pronunciation.'],
        ];
        for (const [name, timbre, want] of CASES) {
            it(name, () => expect(parse(timbre, '').voice.timbre, timbre).to.equal(want));
        }

        it('words that only look alike are kept: capable, that, hatred, nasal, curt, breathy, "in his forties"', () => {
            const t = 'A capable, breathy baritone that is nasal, with a hint of hatred, of a man in his forties.';
            expect(parse(t, '').voice.timbre).to.equal(`${t} Native Russian pronunciation.`);
        });

        it('manner is not touched by the appearance rule', () => {
            expect(parse('A bass.', 'Gruff, like a bearded sailor.').voice.manner).to.equal('Gruff, like a bearded sailor.');
        });

        it('a timbre of looks only → no voice', () => {
            expect(parse('In a grey suit.', 'Fast.')).to.include({ voice: null, reason: 'timbre_empty' });
        });

        it('idempotent: a cleaned voice parsed again does not change', () => {
            const once = parse('Hoarse tenor of a bald man in a grey suit; slows down when tired.', 'Quick, but stammers when nervous.').voice;
            expect(voice.voiceFromAnalysis(once, { language: 'ru' }).voice).to.deep.equal(once);
            expect(voice.voiceFromAnalysis(once).voice).to.deep.equal(once);
        });
    });
});
