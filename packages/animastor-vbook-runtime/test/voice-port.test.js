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

describe('voice port (VOICE_REFERENCES.md)', () => {
    it('getCharacterVoice reads timbre / manner / reference; instruction-only is not a voice description', () => {
        const book = { voices: { anna: { timbre: ' Low warm female. ', manner: '', timbre_source: 'cleaned', reference: ref() }, old: { instruction: 'x' } } };
        const v = voice.getCharacterVoice(book, 'anna');
        expect(v.timbre).to.equal('Low warm female.');
        expect(v.reference.sha256).to.equal(SHA);
        expect(v.reference_problem).to.equal(null);
        const old = voice.getCharacterVoice(book, 'old');
        expect(old.timbre).to.equal('');
        expect(old.reference).to.equal(null);
        expect(voice.getCharacterVoice(book, 'missing')).to.equal(null);
    });

    it('a malformed reference is reported, not used', () => {
        const v = voice.getCharacterVoice({ voices: { a: { timbre: 't', reference: ref({ sha256: 'xyz' }) } } }, 'a');
        expect(v.reference).to.equal(null);
        expect(v.reference_problem).to.match(/sha256/);
    });

    it('setCharacterVoiceReference sets / clears and validates', () => {
        const book = { voices: { anna: { timbre: 't' } } };
        voice.setCharacterVoiceReference(book, 'anna', ref());
        expect(book.voices.anna.reference.locked).to.equal(true);
        expect(() => voice.setCharacterVoiceReference(book, 'anna', ref({ file: '../x.wav' }))).to.throw(/reference.file/);
        expect(() => voice.setCharacterVoiceReference(book, 'nobody', ref())).to.throw(/not found/);
        voice.setCharacterVoiceReference(book, 'anna', null);
        expect(book.voices.anna).to.not.have.property('reference');
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

    it('bundle validator checks the voice fields and the reference link', () => {
        const base = { manifest: { book_id: 'b' }, book: { structure: { chapters_order: [] } }, locations: {}, behaviors: {}, characters: [] };
        const ok = validateBundleObject({ ...base, voices: { anna: { timbre: 't', manner: '', timbre_source: 'user', reference: ref() } } });
        expect(ok.errors || []).to.deep.equal([]);
        const bad = validateBundleObject({ ...base, voices: { anna: { timbre: 1, timbre_source: 'llm', reference: ref({ source: 'web' }) } } });
        expect(bad.errors.join('\n')).to.match(/timbre must be a string/).and.match(/timbre_source/).and.match(/reference.source/);
    });
});
