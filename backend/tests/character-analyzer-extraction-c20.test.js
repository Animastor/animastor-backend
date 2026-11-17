// ======================================================
// CHARACTER ANALYZER — C20 contract behavior tests
// ======================================================
// Pins the runtime behavior of the extracted module
// (docs/architecture/character-analyzer-extraction-c20.md) against the
// pre-extraction behavior of pipeline-steps.stepExtractCharacters /
// stepGenerateVoices. No prompt, merge, or fallback semantics change.
//
// Covers: happy path, empty AI payload, malformed AI response, transport
// failure (fallback/throw contract), port fail-closed, voice write-back
// rules (no overwrite, placeholder skip), skill injection.

const { expect } = require('chai');
const { extractCharacters, generateVoices } = require('@animastor/ai-analysis/tasks/character-analyzer');

function makePorts(callAIResult, overrides = {}) {
    const calls = { log: 0, complete: 0, fail: 0, update: 0, create: 0 };
    const ports = {
        callAI: async () => callAIResult,
        logConversation: async () => { calls.log++; },
        updateSession: async () => { calls.update++; },
        createStep: async () => { calls.create++; return { step_id: 'step-1' }; },
        completeStep: async () => { calls.complete++; },
        failStep: async () => { calls.fail++; },
        extractingCharactersMessage: '⟳ Извлекаю персонажей...',
        voiceGenerationMessage: '⟳ Подбираю голоса для персонажей...',
        prompt: (name) => `PROMPT:${name}`,
        fillLang: (t, lang) => `${t}[${lang}]`,
        buildSkill: () => null,
        ...overrides.ports,
    };
    return { ports, calls };
}

const baseInput = {
    windowText: 'Window text with characters.',
    language: 'ru',
    sessionId: 'sess-c20',
    stepIndex: 3,
    progress: () => {},
};

describe('C20 character-analyzer: extractCharacters contract', () => {
    it('returns { characters, mentions } and completes the step on a well-formed response', async () => {
        const ai = { characters: [{ id: 'anna_smirnova', name: 'Anna', appearance: 'tall' }], mentions: { editor: 'anna_smirnova' } };
        const { ports, calls } = makePorts(ai);
        const out = await extractCharacters(baseInput, ports);
        expect(out).to.deep.equal(ai);
        expect(calls.complete).to.equal(1);
        expect(calls.fail).to.equal(0);
        expect(calls.log).to.equal(1);
    });

    it('normalizes a partial response: missing fields → empty containers', async () => {
        const { ports, calls } = makePorts({});
        const out = await extractCharacters(baseInput, ports);
        expect(out).to.deep.equal({ characters: [], mentions: {} });
        expect(calls.complete).to.equal(1);
    });

    it('normalizes a malformed response: non-object JSON → empty containers (no throw)', async () => {
        const { ports } = makePorts('not-an-object');
        const out = await extractCharacters(baseInput, ports);
        expect(out).to.deep.equal({ characters: [], mentions: {} });
    });

    it('builds the localized characters prompt + window text verbatim', async () => {
        let seen = null;
        const { ports } = makePorts({ characters: [], mentions: {} }, {
            ports: { callAI: async (messages) => { seen = messages; return { characters: [], mentions: {} }; } },
        });
        await extractCharacters(baseInput, ports);
        expect(seen[0].content).to.equal('PROMPT:characters[ru]');
        expect(seen[1].content).to.include(baseInput.windowText);
    });

    it('fails closed when host ports are missing', async () => {
        await extractCharacters(baseInput, {}).then(
            () => { throw new Error('must not resolve'); },
            (err) => expect(err.message).to.match(/character-analyzer: missing host port/)
        );
    });

    it('on AI failure: failStep + rethrow (runner keeps existing set — degradation is host-owned)', async () => {
        const { ports, calls } = makePorts(null, {
            ports: { callAI: async () => { throw new Error('transport down'); } },
        });
        await extractCharacters(baseInput, ports).then(
            () => { throw new Error('must not resolve'); },
            (err) => {
                expect(err.message).to.equal('transport down');
                expect(calls.fail).to.equal(1);
                expect(calls.complete).to.equal(0);
            }
        );
    });
});

describe('C20 character-analyzer: generateVoices contract (F7)', () => {
    const realChar = (over = {}) => ({
        id: 'anna_smirnova', name: 'Anna', role: 'protagonist',
        description: 'editor', appearance: 'tall, gray eyes', traits: ['sharp'],
        ...over,
    });

    // VBook 4 (VBOOK_FORMAT_V4 §5.1, §12 step 2): a voice is { timbre, manner }.
    const TIMBRE = 'Warm low female alto, mid-thirties. Native Russian pronunciation.';
    const MANNER = 'Speaks slowly and evenly.';

    it('writes { timbre, manner, timbre_source } into characters[i].voice in place', async () => {
        const ch = realChar();
        const { ports, calls } = makePorts({ voices: { anna_smirnova: { timbre: TIMBRE, manner: MANNER } } });
        const out = await generateVoices({ ...baseInput, characters: [ch], promptProfiles: {} }, ports);
        const voice = { timbre: TIMBRE, manner: MANNER, timbre_source: 'analysis' };
        expect(out).to.deep.equal({ voices: { anna_smirnova: voice } });
        expect(ch.voice).to.deep.equal(voice);
        expect(calls.complete).to.equal(1);
    });

    it('the model returned no manner → the voice is written with an empty manner', async () => {
        const ch = realChar();
        const { ports } = makePorts({ voices: { anna_smirnova: { timbre: TIMBRE } } });
        await generateVoices({ ...baseInput, characters: [ch], promptProfiles: {} }, ports);
        expect(ch.voice).to.deep.equal({ timbre: TIMBRE, manner: '', timbre_source: 'analysis' });
    });

    it('a plot-bound sentence reaches neither field (rule cleanup); the voice is marked cleaned', async () => {
        const ch = realChar();
        const { ports } = makePorts({ voices: { anna_smirnova: {
            timbre: `${TIMBRE} When she is angry, the voice turns sharp.`,
            manner: `${MANNER} Rising intonation on the word «поехали». Whispers "never" to Boris.`,
        } } });
        await generateVoices({ ...baseInput, characters: [ch], promptProfiles: {} }, ports);
        expect(ch.voice).to.deep.equal({ timbre: TIMBRE, manner: MANNER, timbre_source: 'cleaned' });
        expect(JSON.stringify(ch.voice)).to.not.match(/angry|поехали|never|Boris/);
    });

    it('the model returned the voice as one string, or as { instruction } → taken as timbre, marked cleaned', async () => {
        for (const raw of ['Deep male bass. Slow.', { instruction: 'Deep male bass. Slow.' }]) {
            const ch = realChar();
            const { ports } = makePorts({ voices: { anna_smirnova: raw } });
            await generateVoices({ ...baseInput, characters: [ch], promptProfiles: {} }, ports);
            // rules v3 (step 2b): the pronunciation suffix of the book language (ru) is added
            expect(ch.voice).to.deep.equal({ timbre: 'Deep male bass. Slow. Native Russian pronunciation.', manner: '', timbre_source: 'cleaned' });
        }
    });

    const REFUSED = [
        ['a manner without a timbre', { manner: MANNER }, 'timbre_empty'],
        ['a timbre made only of plot text', { timbre: 'When angry, she shouts.', manner: MANNER }, 'timbre_empty'],
        ['a number', 42, 'bad_shape'],
        ['an array', [TIMBRE], 'bad_shape'],
        ['an empty object', {}, 'empty'],
        ['null', null, 'empty'],
    ];
    for (const [label, raw, reason] of REFUSED) {
        it(`the model returned ${label} → no voice is written, the refusal is reported (${reason})`, async () => {
            const ch = realChar();
            const { ports, calls } = makePorts({ voices: { anna_smirnova: raw } });
            const out = await generateVoices({ ...baseInput, characters: [ch], promptProfiles: {} }, ports);
            expect(out).to.deep.equal({ voices: {}, rejected: { anna_smirnova: reason } });
            expect(ch).to.not.have.property('voice');
            expect(calls.complete).to.equal(1);
            expect(calls.fail).to.equal(0);
        });
    }

    it('a voice for an id that is not in the list is dropped (the model cannot add speakers)', async () => {
        const ch = realChar();
        const { ports } = makePorts({ voices: { anna_smirnova: { timbre: TIMBRE }, zhenshchina_v_budochke: { timbre: 'Sharp.' }, narrator: { timbre: 'Deep.' } } });
        const out = await generateVoices({ ...baseInput, characters: [ch], promptProfiles: {} }, ports);
        expect(Object.keys(out.voices)).to.deep.equal(['anna_smirnova']);
    });

    it('never overwrites an existing voice — a { timbre, manner } block from an earlier window or the hero file', async () => {
        const existing = { timbre: 'Edited by hand.', manner: '' };
        const ch = realChar({ voice: existing });
        const other = realChar({ id: 'boris_volkov', name: 'Boris' });
        let asked = null;
        const { ports } = makePorts({ voices: { anna_smirnova: { timbre: 'NEW VOICE' }, boris_volkov: { timbre: TIMBRE } } }, {
            ports: { callAI: async (messages) => { asked = messages; return { voices: { anna_smirnova: { timbre: 'NEW VOICE' }, boris_volkov: { timbre: TIMBRE } } }; } },
        });
        const out = await generateVoices({ ...baseInput, characters: [ch, other], promptProfiles: {} }, ports);
        expect(ch.voice).to.equal(existing);
        expect(other.voice.timbre).to.equal(TIMBRE);
        expect(Object.keys(out.voices)).to.deep.equal(['boris_volkov']);
        // the model is shown the existing voice as two fields, never as "instruction"
        const prompt = asked.map((m) => m.content).join('\n');
        expect(prompt).to.include('current_voice: timbre: Edited by hand.');
        expect(prompt).to.not.include('[object Object]');
    });

    it('skips the AI call entirely when every character already has a voice', async () => {
        const ch = realChar({ voice: { timbre: TIMBRE, manner: MANNER } });
        const { ports, calls } = makePorts({ voices: { anna_smirnova: { timbre: 'NEW VOICE' } } });
        const out = await generateVoices({ ...baseInput, characters: [ch], promptProfiles: {} }, ports);
        expect(out).to.deep.equal({ voices: {} });
        expect(ch.voice.timbre).to.equal(TIMBRE);
        expect(calls.complete).to.equal(0);
    });

    it('the prompt of the step asks for timbre and manner and forbids plot directions (voice_generation.md)', () => {
        const fs = require('fs');
        const path = require('path');
        const rule = fs.readFileSync(path.join(__dirname, '..', 'ai', 'rules', 'voice_generation.md'), 'utf8');
        expect(rule).to.match(/"timbre":/).and.match(/"manner":/);
        expect(rule).to.match(/### `timbre` — WHO is speaking/).and.match(/### `manner` — HOW the character usually speaks/);
        expect(rule).to.match(/on the word/).and.match(/NO situational or plot directions/);
        expect(rule).to.not.match(/"instruction":/);
        expect(rule).to.match(/Do NOT include narrator/);
    });

    it('skips a dialogue-only participant without described appearance (no voice invented)', async () => {
        const phantom = { id: 'unknown', name: 'unknown' };
        const { ports } = makePorts({ voices: { unknown: { timbre: 'X' } } });
        const out = await generateVoices({ ...baseInput, characters: [phantom], promptProfiles: {} }, ports);
        expect(out).to.deep.equal({ voices: {} });
        expect(phantom.voice).to.equal(undefined);
    });

    it('injects the audio skill section ahead of the prompt when a profile is configured', async () => {
        let seen = null;
        const { ports } = makePorts({ voices: {} }, {
            ports: {
                buildSkill: (domain, profile) => (domain === 'audio' && profile === 'qwen-tts' ? 'SKILL:audio' : null),
                callAI: async (messages) => { seen = messages; return { voices: {} }; },
            },
        });
        await generateVoices({ ...baseInput, characters: [realChar()], promptProfiles: { audioProfile: 'qwen-tts' } }, ports);
        expect(seen[0].content.startsWith('SKILL:audio')).to.equal(true);
    });

    it('on AI failure: failStep + warn, returns { voices: {} } and keeps existing voices', async () => {
        const ch = realChar({ voice: 'weak' }); // short voice → needs generation, reaches the AI call
        const { ports, calls } = makePorts(null, {
            ports: { callAI: async () => { throw new Error('transport down'); } },
        });
        const out = await generateVoices({ ...baseInput, characters: [ch], promptProfiles: {} }, ports);
        expect(out).to.deep.equal({ voices: {} });
        expect(ch.voice).to.equal('weak');
        expect(calls.fail).to.equal(1);
    });

    it('fails closed when host ports are missing', async () => {
        await generateVoices({ ...baseInput, characters: [realChar()], promptProfiles: {} }, {}).then(
            () => { throw new Error('must not resolve'); },
            (err) => expect(err.message).to.match(/character-analyzer: missing host port/)
        );
    });
});
