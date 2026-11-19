// ======================================================
// VBook 4, the rest of step 2b — the voice step asks for a missing manner
// ======================================================
// Acceptance 2.6 rerun: an empty manner of a hero that already had a voice was
// never asked for again (the step asked only heroes without a voice), so the
// "next window fills an empty manner" rule of step 2 (В3) never fired.
// Owner's decision 17.11: a hero with a timbre and an empty manner is asked for
// the manner, unless the voice is protected (timbre_source 'user' or a locked
// reference). The timbre is never changed.

'use strict';

const { expect } = require('chai');
const { generateVoices, needsManner } = require('@animastor/ai-analysis/tasks/character-analyzer');
const heroAnalysis = require('@animastor/vbook-runtime/hero-analysis.cjs');

const SHA = 'c'.repeat(64);
const looks = { appearance: 'a tall thin man over forty', passport: { appearance: 'a tall thin man over forty' } };

function run(characters, answer) {
    const sent = [];
    const ports = {
        callAI: async (messages) => { sent.push(messages); return answer; },
        logConversation: async () => {}, updateSession: async () => {},
        createStep: async () => ({ step_id: 'st' }), completeStep: async () => {}, failStep: async () => {},
        voiceGenerationMessage: 'voices', prompt: () => 'PROMPT %CHARACTERS%', fillLang: (t) => t, buildSkill: () => null,
    };
    return generateVoices({ windowText: '— Да, — сказал он.', characters, promptProfiles: {}, language: 'ru', sessionId: 's' }, ports)
        .then((result) => ({ result, sent }));
}

describe('VBook 4 step 2b (rest) — the voice step asks for a missing manner', () => {
    let quiet;
    beforeEach(() => { quiet = { log: console.log, warn: console.warn }; console.log = () => {}; console.warn = () => {}; });
    afterEach(() => { console.log = quiet.log; console.warn = quiet.warn; });

    it('a timbre with an empty manner → asked for the manner only; the manner is cleaned, the timbre stays', async () => {
        const voland = { id: 'voland', name: 'Иностранец', ...looks, voice: { timbre: 'A low dry male voice.', manner: '' } };
        const { result, sent } = await run([voland], {
            voices: { voland: { timbre: 'SOMETHING ELSE', manner: 'Mocking, with slow deliberate pauses; lowers his voice when he lies.' } },
        });
        expect(sent).to.have.length(1);
        expect(sent[0][1].content).to.include('already have a timbre — do NOT change it').and.include('voland');
        expect(voland.voice).to.deep.equal({ timbre: 'A low dry male voice.', manner: 'Mocking, with slow deliberate pauses.' });
        expect(result.voices.voland).to.equal(voland.voice);
    });

    it('a model that returns no manner (or an empty one) leaves the voice as it was', async () => {
        const a = { id: 'a', name: 'А', ...looks, voice: { timbre: 'A bass.', manner: '' } };
        const b = { id: 'b', name: 'Б', ...looks, voice: { timbre: 'A tenor.', manner: '' } };
        const { result } = await run([a, b], { voices: { a: { manner: '' }, b: 'A tenor, quick.' } });
        expect(a.voice).to.deep.equal({ timbre: 'A bass.', manner: '' });
        expect(b.voice).to.deep.equal({ timbre: 'A tenor.', manner: '' });
        expect(result.voices).to.deep.equal({});
    });

    it('protected voices are not asked: a person\'s voice, a locked reference (as the registry marks them)', async () => {
        const hero = (id, voice) => heroAnalysis.workingCharacterFromHero({ id, name: id, passport: { appearance: 'a tall thin man', clothes: '' }, voice });
        const user = hero('user_voice', { timbre: 'A bass.', manner: '', timbre_source: 'user' });
        const locked = hero('locked_voice', { timbre: 'A tenor.', manner: '', timbre_source: 'analysis',
            reference: { file: 'voices/locked_voice/c1.wav', sha256: SHA, ref_text: 'Фраза.', source: 'designed', verification: 'passed', locked: true } });
        const open = hero('open_voice', { timbre: 'An alto.', manner: '', timbre_source: 'cleaned' });
        expect(user.voice.protected).to.equal(true);
        expect(locked.voice.protected).to.equal(true);
        expect(open.voice).to.not.have.property('protected');
        expect([user, locked, open].map(needsManner)).to.deep.equal([false, false, true]);

        const { result, sent } = await run([user, locked], { voices: { user_voice: { manner: 'Fast.' } } });
        expect(sent).to.have.length(0);
        expect(result).to.deep.equal({ voices: {} });
        expect(user.voice.manner).to.equal('');
    });

    it('a voice that has a manner is not asked; heroes without a voice are asked as before', async () => {
        const full = { id: 'full', name: 'Ф', ...looks, voice: { timbre: 'A bass.', manner: 'Slow.' } };
        const none = { id: 'none', name: 'Н', ...looks };
        const { result, sent } = await run([full, none], { voices: { full: { timbre: 'X.', manner: 'Y.' }, none: { timbre: 'A clear soprano.', manner: 'Quick.' } } });
        expect(sent[0][1].content).to.not.include('already have a timbre');
        expect(full.voice).to.deep.equal({ timbre: 'A bass.', manner: 'Slow.' });
        expect(Object.keys(result.voices)).to.deep.equal(['none']);
        expect(none.voice.timbre).to.equal('A clear soprano. Native Russian pronunciation.');
    });
});
