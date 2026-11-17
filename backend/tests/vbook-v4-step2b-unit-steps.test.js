// ======================================================
// VBook 4 step 2b — the per-unit steps fit their output budget
// ======================================================
// Acceptance 2.6: the visuals of a 44-unit scene, reconcile_passports and
// polish_storyboard of a 46–83-unit window were cut at max_tokens=4096
// (11 responses, finish_reason=length). Now:
//   - the units are sent once (system prompt %UNITS%), not twice;
//   - reconcile_passports and polish_storyboard return only the CHANGED units,
//     a unit left out stays as it was;
//   - max_tokens follows the number of units (unitOutputBudget).

'use strict';

const { expect } = require('chai');
const proxyquire = require('proxyquire');

function loadSteps(callAI) {
    const session = {
        createStep: async () => ({ step_id: 'step-test' }),
        completeStep: async () => {}, failStep: async () => {}, updateSession: async () => {},
    };
    return proxyquire('../src/services/agent/pipeline-steps', {
        './ai-caller': { callAI, logConversation: async () => {} },
        '../agent-session': session,
    });
}

const CHARS = [
    { id: 'mikhail_berlioz', name: 'Михаил Александрович Берлиоз', appearance: 'small plump man', clothes: 'grey suit' },
    { id: 'ivan_ponyrev', name: 'Иван Николаевич Понырев', appearance: 'young man', clothes: 'checked cap' },
];
const unit = (i, prompt) => ({
    sceneIndex: 0, unitIndex: i, sceneTitle: 'Пруды', sceneText: 'Текст сцены', text: `реплика ${i}`, type: 'narration',
    participants: ['mikhail_berlioz', 'ivan_ponyrev'],
    image: { shot: 'wide', prompt },
    video: { action: `mikhail_berlioz speaks ${i}` },
});
const UNITS = Array.from({ length: 60 }, (_, i) => unit(i, `mikhail_berlioz and ivan_ponyrev on a bench, frame ${i}`));

describe('VBook 4 step 2b — per-unit steps: one copy of the units, changed units only, budget by size', () => {
    let quiet;
    beforeEach(() => { quiet = { log: console.log, warn: console.warn }; console.log = () => {}; console.warn = () => {}; });
    afterEach(() => { console.log = quiet.log; console.warn = quiet.warn; });

    for (const [name, run, section] of [
        ['reconcile_passports', (m) => m.stepReconcilePassports('s', UNITS, CHARS, 0, () => {}, []), 'Input units to reconcile'],
        ['polish_storyboard', (m) => m.stepPolishStoryboard('s', UNITS, CHARS, [], 0, () => {}, {}), 'Input units to polish'],
    ]) {
        describe(name, () => {
            it('the units are in the system prompt once and not repeated in the user message', async () => {
                let sent;
                const mod = loadSteps(async (messages, options) => { sent = { messages, options }; return { units: [] }; });
                await run(mod);
                expect(sent.messages[0].content.split('frame 17').length - 1).to.equal(1);
                expect(sent.messages[1].content).to.not.include('frame 17');
                expect(sent.messages[1].content).to.include(section).and.include('Return only the units you change');
            });

            it('max_tokens follows the number of units (60 → 7024), not a flat 4096', async () => {
                let options;
                const mod = loadSteps(async (m, o) => { options = o; return { units: [] }; });
                await run(mod);
                expect(options.maxTokens).to.equal(1024 + 60 * 100);
            });

            it('only the changed units come back: they are merged, every other unit stays as it was', async () => {
                const mod = loadSteps(async () => ({
                    units: [{ scene_index: 0, unit_index: 5, image: { shot: 'medium', prompt: 'mikhail_berlioz alone on the bench, frame 5' } }],
                }));
                const out = await run(mod);
                const units = Array.isArray(out) ? out : out.units;
                expect(units).to.have.length(60);
                expect(units[5].image.prompt).to.equal('mikhail_berlioz alone on the bench, frame 5');
                for (const i of [0, 4, 6, 59]) expect(units[i]).to.deep.equal(UNITS[i]);
            });
        });
    }

    describe('visuals of a scene', () => {
        it('one copy of the units; max_tokens 1024 + 200 per unit (the 44-unit scene of the acceptance → 9824)', async () => {
            let sent;
            const mod = loadSteps(async (messages, options) => { sent = { messages, options }; return { units: [] }; });
            const sceneUnits = Array.from({ length: 44 }, (_, i) => ({ text: `реплика номер ${i}`, type: 'dialogue' }));
            await mod.stepCreateVisuals('s', { title: 'Пруды', text: 'Текст', participants: [] }, sceneUnits, 6, CHARS, [], 0, () => {}, null, {}, {});
            expect(sent.options.maxTokens).to.equal(9824);
            expect(sent.messages[0].content.split('реплика номер 17').length - 1).to.equal(1);
            expect(sent.messages[1].content).to.not.include('реплика номер 17');
            expect(sent.messages[1].content).to.include('44 units').and.include('Input units to describe');
        });
    });

    it('the rules ask for the changed units only', () => {
        const fs = require('fs');
        const path = require('path');
        const rules = (n) => fs.readFileSync(path.join(__dirname, '..', 'ai', 'rules', n), 'utf8');
        expect(rules('passport_reconciliation.md')).to.include('include ONLY the units whose image.prompt you change');
        expect(rules('storyboard_polish.md')).to.include('return ONLY the units you change');
        expect(rules('storyboard_polish.md')).to.not.include('Return exactly the same number of units as received');
    });
});
