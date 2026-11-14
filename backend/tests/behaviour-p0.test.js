// ======================================================
// Behaviour phase 0 — deterministic rules → unit.behaviour → video storyboard
// ======================================================
// Docs: animastor-docs architecture/VBOOK_BEHAVIOUR.md.
//   1. matcher: determinism, probability 0/1, strength 0, cooldown, priority,
//      locked / already-filled IU, unknown hero / emotion, snapshot
//   2. effective rules: defaults ∪ book (override by id, enabled:false)
//   3. emotion vocabulary == the list in ai/rules/visuals.md; state validation
//   4. visuals step keeps only valid unit.state
//   5. runner: the hook runs once in BOTH paths, after reconcile/polish/repair
//   6. registry: behaviour → video, state / behaviour_locked → nothing
//   7. video-workflows: phrases appended to the storyboard line; no
//      behaviour → byte-identical prompt
//   8. schema v2: migration v2.1 → v2, save/load round-trip, API projection,
//      merge of a flat client map (rules survive)
//   9. assistant: legacy /behaviors/<id> paths land in characters.<id>

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const proxyquire = require('proxyquire');

const { matchSceneBehaviours, behaviourSeed, SEED_SPACE } = require('../src/services/agent/behaviour-matcher');
const behaviourRules = require('../src/services/agent/behaviour-rules');
const { BEHAVIOUR_EMOTIONS, sanitizeUnitState } = require('../src/services/agent/behaviour-emotions');
const { applyBehavioursToWindow } = require('../src/services/agent/behaviour-apply');

const BOOK = 'book_behaviour_test';

function rule(over = {}) {
    return {
        id: 'r_blush',
        scope: 'global',
        when: { emotion: ['embarrassed'] },
        then: { action: 'blushes and looks away' },
        strength: 0.8,
        probability: 1,
        cooldown_iu: 0,
        priority: 0,
        ...over,
        when: { emotion: ['embarrassed'], ...(over.when || {}) },
        then: { action: 'blushes and looks away', ...(over.then || {}) },
    };
}

function units(n, state = { yura: 'embarrassed' }) {
    return Array.from({ length: n }, (_, i) => ({ id: `iu-${String(i).padStart(8, '0')}`, type: 'dialogue', text: `t${i}`, state: { ...state } }));
}

describe('behaviour-matcher (phase 0)', () => {
    it('is deterministic: two runs give identical output; seed = sha256(book:rule:unit)', () => {
        const rules = [rule({ probability: 0.5 })];
        const a = matchSceneBehaviours({ bookId: BOOK, units: units(20), rules });
        const b = matchSceneBehaviours({ bookId: BOOK, units: units(20), rules });
        expect(a).to.deep.equal(b);
        const fired = a.filter(Boolean);
        expect(fired.length).to.be.greaterThan(0);
        expect(fired.length).to.be.lessThan(20);
        a.forEach((beh, i) => {
            const seed = behaviourSeed(BOOK, 'r_blush', `iu-${String(i).padStart(8, '0')}`);
            expect(!!beh).to.equal(seed / SEED_SPACE < 0.5);
            if (beh) expect(beh[0].seed).to.equal(seed);
        });
    });

    it('never calls Math.random', () => {
        const orig = Math.random;
        Math.random = () => { throw new Error('Math.random used'); };
        try {
            matchSceneBehaviours({ bookId: BOOK, units: units(5), rules: [rule({ probability: 0.5 })] });
        } finally { Math.random = orig; }
    });

    it('probability 1 fires on every matching IU, probability 0 never', () => {
        const all = matchSceneBehaviours({ bookId: BOOK, units: units(6), rules: [rule({ probability: 1 })] });
        expect(all.every(Boolean)).to.equal(true);
        const none = matchSceneBehaviours({ bookId: BOOK, units: units(6), rules: [rule({ probability: 0 })] });
        expect(none.every(x => x === null)).to.equal(true);
    });

    it('strength 0 switches the rule off; enabled:false too', () => {
        expect(matchSceneBehaviours({ bookId: BOOK, units: units(3), rules: [rule({ strength: 0 })] }).every(x => x === null)).to.equal(true);
        expect(matchSceneBehaviours({ bookId: BOOK, units: units(3), rules: [rule({ enabled: false })] }).every(x => x === null)).to.equal(true);
    });

    it('output entry = {rule_id, character_id, strength, seed, action}', () => {
        const [beh] = matchSceneBehaviours({ bookId: BOOK, units: units(1), rules: [rule()] });
        expect(beh).to.have.length(1);
        expect(beh[0]).to.have.all.keys('rule_id', 'character_id', 'strength', 'seed', 'action');
        expect(beh[0]).to.include({ rule_id: 'r_blush', character_id: 'yura', strength: 0.8, action: 'blushes and looks away' });
    });

    it('cooldown_iu blocks the rule for N IU after a fire (per hero, inside the scene)', () => {
        const out = matchSceneBehaviours({ bookId: BOOK, units: units(7), rules: [rule({ cooldown_iu: 2 })] });
        expect(out.map(Boolean)).to.deep.equal([true, false, false, true, false, false, true]);
        // another hero is not blocked by yura's cooldown
        const two = matchSceneBehaviours({ bookId: BOOK, units: units(3, { yura: 'embarrassed', svetlana: 'embarrassed' }), rules: [rule({ cooldown_iu: 5 })] });
        expect(two[0].map(b => b.character_id)).to.deep.equal(['svetlana', 'yura']);
        expect(two[1]).to.equal(null);
    });

    it('one behaviour per hero per IU: higher priority wins, then id ascending', () => {
        const rules = [
            rule({ id: 'b_low', priority: 1, then: { action: 'low' } }),
            rule({ id: 'c_high', priority: 5, then: { action: 'high' } }),
            rule({ id: 'a_high', priority: 5, then: { action: 'high-a' } }),
        ];
        const [beh] = matchSceneBehaviours({ bookId: BOOK, units: units(1), rules });
        expect(beh).to.have.length(1);
        expect(beh[0].rule_id).to.equal('a_high');
    });

    it('skips behaviour_locked and already-filled IU (idempotent re-run)', () => {
        const us = units(3);
        us[0].behaviour_locked = true;
        us[1].behaviour = [{ rule_id: 'manual', character_id: 'yura', strength: 1, seed: 0, action: 'author text' }];
        const out = matchSceneBehaviours({ bookId: BOOK, units: us, rules: [rule()] });
        expect(out[0]).to.equal(null);
        expect(out[1]).to.equal(null);
        expect(out[2]).to.have.length(1);

        // applying twice changes nothing the second time
        const scenes = [{ units: units(4) }];
        applyBehavioursToWindow(scenes, { bookId: BOOK, rules: [rule({ probability: 0.6 })] });
        const snapshot = JSON.parse(JSON.stringify(scenes));
        applyBehavioursToWindow(scenes, { bookId: BOOK, rules: [rule({ probability: 0.6, then: { action: 'CHANGED' } })] });
        expect(scenes).to.deep.equal(snapshot);
    });

    it('existing behaviour of a skipped IU counts for the cooldown', () => {
        const us = units(3);
        us[0].behaviour = [{ rule_id: 'r_blush', character_id: 'yura', strength: 1, seed: 0, action: 'x' }];
        const out = matchSceneBehaviours({ bookId: BOOK, units: us, rules: [rule({ cooldown_iu: 1 })] });
        expect(out.map(Boolean)).to.deep.equal([false, false, true]);
    });

    it('ignores unknown heroes and emotions outside the vocabulary', () => {
        const us = [
            { id: 'iu-1', state: { ghost: 'embarrassed' } },
            { id: 'iu-2', state: { yura: 'blushing' } },
            { id: 'iu-3', state: { yura: 'embarrassed' } },
        ];
        const out = matchSceneBehaviours({ bookId: BOOK, units: us, rules: [rule()], characterIds: ['yura'] });
        expect(out[0]).to.equal(null);
        expect(out[1]).to.equal(null);
        expect(out[2][0].character_id).to.equal('yura');
    });

    it('scope:"character" fires only for its character_id; unit_type filter', () => {
        const r = rule({ scope: 'character', character_id: 'svetlana', when: { unit_type: ['action'] } });
        const us = [
            { id: 'iu-1', type: 'dialogue', state: { svetlana: 'embarrassed' } },
            { id: 'iu-2', type: 'action', state: { yura: 'embarrassed' } },
            { id: 'iu-3', type: 'action', state: { svetlana: 'embarrassed', yura: 'embarrassed' } },
        ];
        const out = matchSceneBehaviours({ bookId: BOOK, units: us, rules: [r] });
        expect(out[0]).to.equal(null);
        expect(out[1]).to.equal(null);
        expect(out[2].map(b => b.character_id)).to.deep.equal(['svetlana']);
    });

    it('action is a snapshot: editing the rule later does not change the IU', () => {
        const r = rule();
        const scenes = [{ units: units(1) }];
        applyBehavioursToWindow(scenes, { bookId: BOOK, rules: [r] });
        r.then.action = 'edited later';
        expect(scenes[0].units[0].behaviour[0].action).to.equal('blushes and looks away');
    });

    it('applyBehavioursToWindow: no rules → no-op (no ids assigned, nothing written)', () => {
        const scenes = [{ units: [{ text: 'a', state: { yura: 'embarrassed' } }] }];
        const before = JSON.parse(JSON.stringify(scenes));
        expect(applyBehavioursToWindow(scenes, { bookId: BOOK, rules: [] })).to.deep.equal({ rules: 0, applied: 0 });
        expect(scenes).to.deep.equal(before);
    });

    it('applyBehavioursToWindow assigns final iu ids before matching', () => {
        const scenes = [{ units: [{ text: 'a', state: { yura: 'embarrassed' } }] }];
        applyBehavioursToWindow(scenes, { bookId: BOOK, rules: [rule()] });
        expect(scenes[0].units[0].id).to.match(/^iu-[0-9a-f]+$/);
        expect(scenes[0].units[0].behaviour[0].seed).to.equal(behaviourSeed(BOOK, 'r_blush', scenes[0].units[0].id));
    });
});

describe('behaviour-matcher — max_per_scene', () => {
    const count = (out) => out.reduce((n, b) => n + (b ? b.length : 0), 0);
    const twoHeroes = (n) => units(n, { yura: 'embarrassed', svetlana: 'embarrassed' });

    it('the limit always holds (probability 1, no cooldown, many books)', () => {
        for (let k = 0; k < 300; k++) {
            for (const limit of [1, 2, 3]) {
                const out = matchSceneBehaviours({ bookId: `b${k}`, units: twoHeroes(6), rules: [rule({ probability: 0.7 })], maxPerScene: limit });
                expect(count(out)).to.be.at.most(limit);
            }
        }
        const unlimited = matchSceneBehaviours({ bookId: BOOK, units: twoHeroes(6), rules: [rule()] });
        expect(count(unlimited)).to.equal(12);
    });

    it('0 switches behaviours off in the scene; null / invalid = unlimited', () => {
        expect(count(matchSceneBehaviours({ bookId: BOOK, units: twoHeroes(4), rules: [rule()], maxPerScene: 0 }))).to.equal(0);
        expect(count(matchSceneBehaviours({ bookId: BOOK, units: twoHeroes(4), rules: [rule()], maxPerScene: null }))).to.equal(8);
        expect(count(matchSceneBehaviours({ bookId: BOOK, units: twoHeroes(4), rules: [rule()], maxPerScene: -1 }))).to.equal(8);
    });

    it('counts in IU order; inside an IU: priority desc, then rule id, then character_id; rest of the scene skipped', () => {
        const rules = [
            rule({ id: 'z_high', priority: 5, scope: 'character', character_id: 'yura', then: { action: 'high' } }),
            rule({ id: 'a_low', priority: 1, scope: 'character', character_id: 'svetlana', then: { action: 'low' } }),
        ];
        const out = matchSceneBehaviours({ bookId: BOOK, units: twoHeroes(3), rules, maxPerScene: 1 });
        expect(out[0].map(b => b.rule_id)).to.deep.equal(['z_high']); // priority beats id and character order
        expect(out[1]).to.equal(null);
        expect(out[2]).to.equal(null);
        const same = matchSceneBehaviours({ bookId: BOOK, units: twoHeroes(2), rules: [rule()], maxPerScene: 3 });
        expect(same[0].map(b => b.character_id)).to.deep.equal(['svetlana', 'yura']);
        expect(same[1].map(b => b.character_id)).to.deep.equal(['svetlana']);
    });

    it('filled and locked IU count toward the limit', () => {
        const us = units(4);
        us[0].behaviour = [{ rule_id: 'manual', character_id: 'yura', strength: 1, seed: 0, action: 'a' }];
        us[1].behaviour_locked = true;
        us[1].behaviour = [{ rule_id: 'manual2', character_id: 'yura', strength: 1, seed: 0, action: 'b' }];
        const out = matchSceneBehaviours({ bookId: BOOK, units: us, rules: [rule()], maxPerScene: 2 });
        expect(out.every(x => x === null)).to.equal(true);
        const out3 = matchSceneBehaviours({ bookId: BOOK, units: us, rules: [rule()], maxPerScene: 3 });
        expect(out3.map(Boolean)).to.deep.equal([false, false, true, false]);
    });

    it('is deterministic with a limit (two runs identical)', () => {
        const args = () => ({ bookId: BOOK, units: twoHeroes(8), rules: [rule({ probability: 0.5 })], maxPerScene: 2 });
        expect(matchSceneBehaviours(args())).to.deep.equal(matchSceneBehaviours(args()));
    });

    it('defaults file sets defaults.max_per_scene = 2; book defaults.max_per_scene overrides; invalid ignored', () => {
        const doc = behaviourRules.loadDefaultsDoc();
        expect(doc.defaults.max_per_scene).to.equal(2);
        expect(behaviourRules.computeEffectiveSettings(doc, null).maxPerScene).to.equal(2);
        expect(behaviourRules.computeEffectiveSettings(doc, { schema_version: 2, defaults: { max_per_scene: 5 } }).maxPerScene).to.equal(5);
        expect(behaviourRules.computeEffectiveSettings(doc, { schema_version: 2, defaults: { max_per_scene: 0 } }).maxPerScene).to.equal(0);
        expect(behaviourRules.computeEffectiveSettings(doc, { schema_version: 2, defaults: { max_per_scene: 1.5 } }).maxPerScene).to.equal(2);
        expect(behaviourRules.computeEffectiveSettings({ rules: [] }, null).maxPerScene).to.equal(null);
    });

    it('applyBehavioursToWindow reads the book override from behavior.json (0 = off for the whole window)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beh-limit-'));
        const glob = rule({ id: 'g', probability: 1 });
        const mk = () => [{ units: twoHeroes(4) }, { units: twoHeroes(4) }];
        fs.writeFileSync(path.join(dir, 'behavior.json'), JSON.stringify({ schema_version: 2, rules: [glob], characters: {}, defaults: { max_per_scene: 1 } }));
        let scenes = mk();
        let r = applyBehavioursToWindow(scenes, { bookId: BOOK, bookDir: dir });
        expect(r.maxPerScene).to.equal(1);
        expect(scenes.map(sc => count(sc.units.map(u => u.behaviour)))).to.deep.equal([1, 1]);
        fs.writeFileSync(path.join(dir, 'behavior.json'), JSON.stringify({ schema_version: 2, rules: [glob], characters: {}, defaults: { max_per_scene: 0 } }));
        scenes = mk();
        r = applyBehavioursToWindow(scenes, { bookId: BOOK, bookDir: dir });
        expect(r.applied).to.equal(0);
        expect(scenes.every(sc => sc.units.every(u => u.behaviour === undefined))).to.equal(true);
        fs.writeFileSync(path.join(dir, 'behavior.json'), JSON.stringify({ schema_version: 2, rules: [glob], characters: {} }));
        scenes = mk();
        applyBehavioursToWindow(scenes, { bookId: BOOK, bookDir: dir });
        expect(scenes.map(sc => count(sc.units.map(u => u.behaviour)))).to.deep.equal([2, 2]); // defaults file: 2
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('behaviour rules — effective set', () => {
    it('defaults file: schema v2, 6–8 global EN rules, gestures only, all valid', () => {
        const doc = JSON.parse(fs.readFileSync(behaviourRules.DEFAULT_RULES_PATH, 'utf8'));
        expect(path.basename(behaviourRules.DEFAULT_RULES_PATH)).to.equal('behaviour-rules.json');
        expect(doc.schema_version).to.equal(2);
        expect(doc.rules.length).to.be.within(6, 8);
        const eff = behaviourRules.computeEffectiveRules(doc.rules, []);
        expect(eff).to.have.length(doc.rules.length);
        for (const r of eff) {
            expect(r).to.include({ scope: 'global', strength: 0.6, probability: 0.25, cooldown_iu: 4, priority: 0 });
            expect(r).to.not.have.property('character_id');
            expect(r.then.action).to.match(/^[a-z][\x20-\x7E]+$/); // EN, ASCII, subject-less verb phrase
            // no appearance / clothes words (passport + render_rules own them)
            expect(r.then.action).to.not.match(/\b(hair|eyes? (are|is)|coat|dress|shirt|scarf|glasses|suit|wearing|clothes|skin|tall|short|beard)\b/i);
        }
        const emotions = new Set(eff.flatMap(r => r.when.emotion));
        for (const e of ['embarrassed', 'thoughtful', 'anxious', 'surprised', 'angry', 'sad', 'joyful']) expect(emotions.has(e), e).to.equal(true);
    });

    it('behaviour-rules.example.json (9 character rules) is a sample: valid, but never loaded', () => {
        const exPath = path.join(path.dirname(behaviourRules.DEFAULT_RULES_PATH), 'behaviour-rules.example.json');
        const ex = JSON.parse(fs.readFileSync(exPath, 'utf8'));
        expect(ex.rules).to.have.length(9);
        expect(behaviourRules.computeEffectiveRules(ex.rules, [])).to.have.length(9);
        expect(ex.rules.every(r => r.scope === 'character' && r.character_id)).to.equal(true);
        // not part of the effective defaults
        const loaded = behaviourRules.loadDefaultRules().map(r => r.id);
        for (const r of ex.rules) expect(loaded).to.not.include(r.id);
        const eff = behaviourRules.loadEffectiveRules(null).map(r => r.id);
        for (const r of ex.rules) expect(eff).to.not.include(r.id);
        // no source file references it
        const srcRoot = path.join(__dirname, '..', 'src');
        const hits = [];
        (function walk(d) {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const f = path.join(d, e.name);
                if (e.isDirectory()) walk(f);
                else if (/\.(c?js)$/.test(e.name) && fs.readFileSync(f, 'utf8').includes('behaviour-rules.example')) hits.push(f);
            }
        })(srcRoot);
        expect(hits).to.deep.equal([]);
    });

    it('rule files never reach the import prompt (ai-service reference examples)', () => {
        const aiService = require('../src/services/ai-service');
        const dir = path.join(__dirname, '..', 'ai', 'examples');
        const names = aiService.loadReferenceExamples(dir).map(x => x.relPath);
        expect(names).to.not.include('behaviour-rules.json');
        expect(names).to.not.include('behaviour-rules.example.json');
        expect(names).to.include('behavior.json'); // the pre-existing structure example stays
    });

    it('book rules override defaults by id (shallow merge), add new ids, enabled:false disables a default', () => {
        const defaults = [rule({ id: 'd1' }), rule({ id: 'd2' }), rule({ id: 'd3' })];
        const book = [
            { id: 'd1', probability: 0.1 },
            { id: 'd2', enabled: false },
            rule({ id: 'b1', then: { action: 'book rule' } }),
        ];
        const eff = behaviourRules.computeEffectiveRules(defaults, book);
        expect(eff.map(r => r.id)).to.deep.equal(['b1', 'd1', 'd3']);
        expect(eff.find(r => r.id === 'd1').probability).to.equal(0.1);
        expect(eff.find(r => r.id === 'd1').then.action).to.equal('blushes and looks away');
    });

    it('invalid rules are dropped; numbers clamped to 0..1', () => {
        const eff = behaviourRules.computeEffectiveRules([], [
            { id: 'no_action', when: { emotion: ['sad'] }, then: {} },
            { id: 'bad_emotion', when: { emotion: ['blushing'] }, then: { action: 'x' } },
            { id: 'char_no_id', scope: 'character', when: { emotion: ['sad'] }, then: { action: 'x' } },
            { id: 'ok', when: { emotion: ['sad', 'nope'] }, then: { action: 'sighs' }, strength: 7, probability: -1 },
        ]);
        expect(eff.map(r => r.id)).to.deep.equal(['ok']);
        expect(eff[0]).to.include({ strength: 1, probability: 0 });
        expect(eff[0].when.emotion).to.deep.equal(['sad']);
    });

    it('loadEffectiveRules reads rules only from a v2 behavior.json', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beh-rules-'));
        fs.writeFileSync(path.join(dir, 'behavior.json'), JSON.stringify({ hero: { baseline: 'x' } }));
        expect(behaviourRules.readBookRules(dir)).to.deep.equal([]);
        fs.writeFileSync(path.join(dir, 'behavior.json'), JSON.stringify({ schema_version: 2, rules: [rule({ id: 'own' })], characters: {} }));
        const eff = behaviourRules.loadEffectiveRules(dir);
        expect(eff.map(r => r.id)).to.include('own');
        expect(eff).to.have.length(behaviourRules.loadDefaultRules().length + 1);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('behaviour emotions', () => {
    it('vocabulary (~15, EN) is the exact list in ai/rules/visuals.md', () => {
        expect(BEHAVIOUR_EMOTIONS.length).to.equal(15);
        const md = fs.readFileSync(path.join(__dirname, '..', 'ai', 'rules', 'visuals.md'), 'utf8');
        const section = md.split('## Character emotions (unit.state)')[1].split('\n## ')[0];
        const line = section.split('\n').find(l => l.startsWith('neutral'));
        expect(line.split(',').map(s => s.trim())).to.deep.equal([...BEHAVIOUR_EMOTIONS]);
    });

    it('sanitizeUnitState drops unknown heroes and emotions; empty is valid', () => {
        expect(sanitizeUnitState({ yura: ' Sad ', ghost: 'sad', svetlana: 'blushing', x: 3 }, ['yura', 'svetlana'])).to.deep.equal({ yura: 'sad' });
        expect(sanitizeUnitState(null, ['yura'])).to.deep.equal({});
        expect(sanitizeUnitState(['sad'], ['yura'])).to.deep.equal({});
    });
});

describe('stepCreateVisuals — unit.state (same LLM call)', () => {
    function loadSteps(response) {
        const calls = { ai: 0 };
        const mod = proxyquire('../src/services/agent/pipeline-steps', {
            './ai-caller': { callAI: async () => { calls.ai++; return response; }, logConversation: async () => {} },
            '../agent-session': {
                createStep: async () => ({ step_id: 's' }), completeStep: async () => {},
                failStep: async () => {}, updateSession: async () => {},
            },
        });
        return { mod, calls };
    }

    it('keeps valid state, drops unknown hero / emotion, omits empty state; one AI call; prompts untouched', async () => {
        const prompt = 'yura stands at the window, morning light';
        const { mod, calls } = loadSteps({
            units: [
                { image: { shot: 'medium', prompt }, video: { action: 'yura turns' }, state: { yura: 'embarrassed', ghost: 'sad', svetlana: 'blushing' } },
                { image: { shot: 'wide', prompt: 'empty street' }, video: { action: 'slow pan' }, state: {} },
            ],
        });
        const characters = [{ id: 'yura', name: 'Юра' }, { id: 'svetlana', name: 'Света' }];
        const out = await mod.stepCreateVisuals('sess', { title: 'S', participants: ['yura', 'svetlana'], location: { id: 'room' } },
            [{ text: 'a', type: 'dialogue' }, { text: 'b', type: 'perception' }], 0, characters, [], 0, null, null, {}, null);
        expect(calls.ai).to.equal(1);
        expect(out[0].state).to.deep.equal({ yura: 'embarrassed' });
        expect(out[0].image.prompt).to.equal(prompt);
        expect(out[0].video.action).to.equal('yura turns');
        expect(out[1]).to.not.have.property('state');
    });
});

describe('pipeline-runner — behaviour hook in both paths', () => {
    function makeRunner(order) {
        const unitsOut = () => [{ type: 'narration', text: 'Unit text', image: { shot: 'wide', prompt: 'wide shot' }, video: { action: 'slow pan' } }];
        const rec = (name, ret) => async (...args) => { order.push(name); return ret(...args); };
        const pipelineSteps = {
            stepExtractCharacters: async () => ({ characters: [], mentions: {} }),
            stepGenerateVoices: async () => ({ voices: {} }),
            stepExtractLocations: async () => [],
            stepCreateScenes: async () => [
                { title: 'S0', text: 'First scene text here.', location: { id: 'loc1' } },
                { title: 'S1', text: 'Second scene text here.', location: { id: 'loc1' } },
            ],
            stepCreateUnits: async () => [{ type: 'narration', text: 'Unit text' }],
            stepCreateVisuals: rec('visuals', unitsOut),
            stepReconcilePassports: rec('reconcile_passports', (_s, u) => ({ units: u, videoTokens: [] })),
            stepReconcileVideoActions: rec('reconcile_video', (_s, u) => u),
            stepPolishStoryboard: rec('polish_storyboard', (_s, u) => u),
            stepPolishVideoActions: rec('polish_video', (_s, u) => u),
            stepRepairFantasyIds: rec('fantasy_repair', () => []),
            applyRepairToScenes: () => {},
            needsVideoActionReconciliation: () => false,
        };
        const mod = proxyquire('../src/services/agent/pipeline-runner', {
            '@animastor/parser/source-coverage': {
                computeSceneCoverage: () => ({ ok: true, next_offset: 100, covered_end_offset: 100,
                    scene_spans: [{ source_start: 0, source_end: 50 }, { source_start: 50, source_end: 100 }] }),
                findLastSceneEndOffset: () => ({ ok: true, source_end: 100, method: 'test' }),
                findNarrativeStartOffset: () => 0,
            },
            '../../book/lazy-book': { injectChapterMarkers: (t) => t, splitIntoChapters: () => [], firstMeaningfulChapter: null },
            '../../config/runtime-config': {},
            '../agent-session': {
                updateSession: async () => {}, createSession: async () => ({ session_id: 's' }),
                isSessionCancelled: async () => false, isBookCancelled: async () => false,
            },
            '../agent-prompts': {
                PROGRESS_STAGES: { extracting_chars: 'e', analyzing_structure: 'a', creating_scenes: 'c',
                    creating_units: (i) => `u${i}`, creating_visuals: (i) => `v${i}` },
                MAX_WINDOW_CHARS: 100000, MAX_SCENES_PER_CHUNK: 5, computeWindowChars: () => 100000,
            },
            './pipeline-steps': pipelineSteps,
            './unit-splitter': { splitLongUnits: async (_s, _sc, u) => u },
            './text-utils': { buildFallbackScenes: () => [] },
            './behaviour-apply': {
                applyBehavioursToWindow: (scenes, opts) => {
                    order.push('behaviour');
                    order.behaviourCalls = (order.behaviourCalls || 0) + 1;
                    order.behaviourArgs = { scenes: scenes.length, bookId: opts.bookId };
                    return { rules: 0, applied: 0 };
                },
            },
        });
        return mod;
    }

    function assertOrder(order) {
        expect(order.behaviourCalls).to.equal(1);
        expect(order[order.length - 1]).to.equal('behaviour');
        const at = (n) => order.indexOf(n);
        for (const step of ['visuals', 'reconcile_passports', 'polish_storyboard', 'polish_video', 'fantasy_repair']) {
            expect(at(step), step).to.be.within(0, at('behaviour') - 1);
        }
    }

    it('runPipeline calls the hook once, after every LLM step of the window', async () => {
        const order = [];
        const mod = makeRunner(order);
        await mod.runPipeline('s', 'Some narrative text.', [], [], 0, () => {}, 0, { rawWindowText: 'Some narrative text.', chunkSize: 2, bookId: BOOK });
        assertOrder(order);
        expect(order.behaviourArgs).to.deep.equal({ scenes: 2, bookId: BOOK });
    });

    it('processCachedScenes calls the same hook once, after every LLM step', async () => {
        const order = [];
        const mod = makeRunner(order);
        const cached = [
            { title: 'C0', text: 'Cached scene one text.', type: 'narration', characters_present: [], location: { id: 'loc1' } },
            { title: 'C1', text: 'Cached scene two text.', type: 'narration', characters_present: [], location: { id: 'loc1' } },
        ];
        await mod.processCachedScenes('s', cached, [], [], {}, 1, () => {}, 0, { bookId: BOOK, chunkSize: 2 });
        assertOrder(order);
        expect(order.behaviourArgs.bookId).to.equal(BOOK);
    });

    it('a failing hook never fails the window', () => {
        const mod = proxyquire('../src/services/agent/pipeline-runner', {
            './behaviour-apply': { applyBehavioursToWindow: () => { throw new Error('boom'); } },
        });
        expect(mod.applyWindowBehaviours([{ units: [] }], BOOK, [])).to.deep.equal({ rules: 0, applied: 0 });
    });
});

describe('prompt-dependency-registry — behaviour fields', () => {
    const registry = require('@animastor/generation').dirtyGrammar;
    const scene = (u) => ({ scene_id: 'sc-1', units: [{ id: 'iu-1', type: 'dialogue', text: 'x', image: { prompt: 'p' }, video: { action: 'a' }, ...u }] });

    it('unit.behaviour → video only', () => {
        const r = registry.computeSceneDirtyLayers(scene({}), scene({ behaviour: [{ rule_id: 'r', character_id: 'yura', strength: 1, seed: 1, action: 'x' }] }));
        expect(r.dirtyLayers).to.deep.equal(['video']);
    });

    it('unit.state → no layer; unit.behaviour_locked → no layer', () => {
        expect(registry.computeSceneDirtyLayers(scene({}), scene({ state: { yura: 'sad' } })).dirtyLayers).to.deep.equal([]);
        expect(registry.computeSceneDirtyLayers(scene({}), scene({ behaviour_locked: true })).dirtyLayers).to.deep.equal([]);
    });

    it('a truly unknown unit field still marks every layer (catch-all kept)', () => {
        const r = registry.computeSceneDirtyLayers(scene({}), scene({ mystery: 1 }));
        expect(r.dirtyLayers).to.include.members(['audio', 'image', 'video']);
    });
});

describe('video-workflows — behaviour phrases in the storyboard line', () => {
    const wf = require('../src/workflows/video/video-workflows');
    const sceneData = {
        book_id: 'b1', chapter_id: 'ch1', scene_id: 'sc1',
        scene: { participants: ['yura', 'svetlana'], location: { id: 'room', environment: { time: 'evening' } } },
    };
    const loadedBook = {
        manifest: { render: { mode: 'cinematic_realism' } },
        characters: [
            { id: 'yura', name: 'Юра', passport: { video_tokens: 'young man, grey coat' } },
            { id: 'svetlana', name: 'Светлана', passport: { video_tokens: 'young woman, red scarf' } },
        ],
        locations: { room: { description: 'a small kitchen' } },
    };
    const base = [
        { id: 'iu-1', type: 'dialogue', audio: { speaker: 'yura' }, image: { shot: 'medium', prompt: 'yura at the table' }, video: { action: 'yura leans forward' } },
        { id: 'iu-2', type: 'perception', image: { shot: 'close', prompt: 'svetlana by the window' }, video: { action: 'svetlana turns' } },
    ];

    it('without behaviour the prompt is byte-identical (empty / missing array)', () => {
        const a = wf.buildVideoPrompt(sceneData, loadedBook, base, [3, 4]);
        const withEmpty = base.map(u => ({ ...u, behaviour: [] }));
        expect(wf.buildVideoPrompt(sceneData, loadedBook, withEmpty, [3, 4])).to.equal(a);
        const withState = base.map(u => ({ ...u, state: { yura: 'sad' } }));
        expect(wf.buildVideoPrompt(sceneData, loadedBook, withState, [3, 4])).to.equal(a);
    });

    it('appends "<character_id> <action>" phrases to the IU line; video.action untouched', () => {
        const units = base.map(u => ({ ...u }));
        units[1] = { ...units[1], behaviour: [{ rule_id: 'r', character_id: 'svetlana', strength: 0.7, seed: 1, action: 'blushes and looks away.' }] };
        const before = wf.buildVideoPrompt(sceneData, loadedBook, base, [3, 4]).split('\n');
        const after = wf.buildVideoPrompt(sceneData, loadedBook, units, [3, 4]).split('\n');
        const idx = after.findIndex(l => l.includes('svetlana turns'));
        expect(after[idx]).to.equal(`${before[idx]}. svetlana blushes and looks away`);
        expect(units[1].video.action).to.equal('svetlana turns');
        expect(after.filter((l, i) => l !== before[i])).to.have.length(1);
    });

    it('buildBehaviourText joins several phrases with "; " and skips junk', () => {
        expect(wf.buildBehaviourText([
            { character_id: 'a', action: 'nods' },
            null,
            { character_id: 'b', action: '  ' },
            { character_id: 'c', action: 'sighs.' },
        ])).to.equal('a nods; c sighs');
        expect(wf.buildBehaviourText(undefined)).to.equal('');
    });
});

// [v4-pending step 3] behavior-schema.cjs (the 3.1 behavior.json v2 document and
// its flat API projection) was removed by VBook 4 step 1: behaviours now live in
// behaviour.json (globals) and in hero files. VBOOK_FORMAT_V4 §12 step 3 requires
// this file to be green on v4 — these cases are rewritten there, not deleted.
describe.skip('[v4-pending step 3] behavior.json schema v2 — disk / memory / API', () => {
    const schema = (() => { try { return require('@animastor/vbook-runtime/behavior-schema.cjs'); } catch (_) { return null; } })();
    const config = require('../src/config/runtime-config');
    const bookModule = require('../src/book/index');
    const ORIG = config.BOOKS_DIR;
    let tmp; let bookId; let bookDir;

    const RULE = { id: 'own', scope: 'global', when: { emotion: ['sad'] }, then: { action: 'sighs' }, strength: 1, probability: 1, cooldown_iu: 0, priority: 0 };

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beh-v2-'));
        bookId = 'beh-v2-' + Date.now();
        bookDir = path.join(tmp, bookId);
        fs.mkdirSync(path.join(bookDir, 'chapters'), { recursive: true });
        config.BOOKS_DIR = tmp;
        fs.writeFileSync(path.join(bookDir, 'manifest.json'), JSON.stringify({ book_id: bookId, vbook_version: '3.1', build_id: 'b', state: 'BOOTSTRAPPED' }));
        fs.writeFileSync(path.join(bookDir, 'book.json'), JSON.stringify({ book_id: bookId, title: 'T', language: 'ru', structure: { chapters_order: ['chapters/ch-00000001.json'] } }));
        fs.writeFileSync(path.join(bookDir, 'chapters', 'ch-00000001.json'), JSON.stringify({ chapter_id: 'ch-00000001', scenes: [{ scene_id: 'sc-1', units: [{ id: 'iu-1', text: 'x' }] }] }));
        fs.writeFileSync(path.join(bookDir, 'characters.json'), JSON.stringify([{ id: 'hero', name: 'Hero' }]));
    });
    afterEach(() => {
        config.BOOKS_DIR = ORIG;
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('legacy v2.1 file migrates on load (all top-level keys → characters) and saves as v2', () => {
        fs.writeFileSync(path.join(bookDir, 'behavior.json'), JSON.stringify({ hero: { baseline: 'calm', extra: 1 } }));
        const b = bookModule.loadBook(bookId);
        expect(b.behaviors).to.deep.equal({ schema_version: 2, rules: [], characters: { hero: { baseline: 'calm', extra: 1 } } });
        bookModule.saveBookBundle(b);
        const disk = JSON.parse(fs.readFileSync(path.join(bookDir, 'behavior.json'), 'utf8'));
        expect(disk).to.deep.equal({ schema_version: 2, rules: [], characters: { hero: { baseline: 'calm', extra: 1 } } });
    });

    it('v2 round-trip keeps rules, characters and unknown top-level keys', () => {
        const doc = { schema_version: 2, rules: [RULE], characters: { hero: { baseline: 'calm' } }, defaults: { probability: 0.3 } };
        fs.writeFileSync(path.join(bookDir, 'behavior.json'), JSON.stringify(doc));
        const b = bookModule.loadBook(bookId);
        bookModule.saveBookBundle(b);
        expect(JSON.parse(fs.readFileSync(path.join(bookDir, 'behavior.json'), 'utf8'))).to.deep.equal(doc);
    });

    it('a legacy in-memory map passed to saveBookBundle is written as v2', () => {
        const b = bookModule.loadBook(bookId);
        b.behaviors = { hero: { baseline: 'x' } };
        bookModule.saveBookBundle(b);
        expect(JSON.parse(fs.readFileSync(path.join(bookDir, 'behavior.json'), 'utf8')).schema_version).to.equal(2);
    });

    it('.vbook import (buildBookFromBundle) migrates a v2.1 behavior.json', () => {
        const files = {
            'manifest.json': JSON.stringify({ book_id: 'imp', vbook_version: '3.1' }),
            'book.json': JSON.stringify({ book_id: 'imp', structure: { chapters_order: ['chapters/ch-00000001.json'] } }),
            'chapters/ch-00000001.json': JSON.stringify({ chapter_id: 'ch-00000001', scenes: [{ scene_id: 'sc-00000001', units: [{ id: 'iu-00000001', text: 'x' }] }] }),
            'behavior.json': JSON.stringify({ hero: { baseline: 'calm' } }),
        };
        const b = bookModule.buildBookFromBundle(files);
        expect(b.behaviors).to.deep.equal({ schema_version: 2, rules: [], characters: { hero: { baseline: 'calm' } } });
    });

    it('API projection: flat character map + read-only behavior_rules; model untouched', () => {
        const model = { manifest: {}, behaviors: { schema_version: 2, rules: [RULE], characters: { hero: { baseline: 'calm' } } } };
        const api = schema.projectBookBehaviorsForApi(model);
        expect(api.behaviors).to.deep.equal({ hero: { baseline: 'calm' } });
        expect(api.behavior_rules).to.deep.equal([RULE]);
        expect(model.behaviors.schema_version).to.equal(2);
    });

    it('merge of a flat client map keeps rules / schema_version; reserved keys never become characters', () => {
        const stored = { schema_version: 2, rules: [RULE], characters: { hero: { baseline: 'old' } } };
        const merged = schema.mergeIncomingBehaviors(stored, { hero: { baseline: 'new' }, rules: 'junk', schema_version: 1 });
        expect(merged).to.deep.equal({ schema_version: 2, rules: [RULE], characters: { hero: { baseline: 'new' } } });
        expect(schema.mergeIncomingBehaviors(stored, undefined)).to.deep.equal(stored);
    });

    it('validator: v2 shape checked, duplicate rule ids rejected, legacy accepted', () => {
        const v = require('../src/book/bundle-validator.cjs');
        expect(v.validateBundleFile('behavior.json', { hero: {} }).valid).to.equal(true);
        expect(v.validateBundleFile('behavior.json', { schema_version: 2, rules: [RULE], characters: {} }).valid).to.equal(true);
        expect(v.validateBundleFile('behavior.json', { schema_version: 2, rules: [RULE, RULE], characters: {} }).valid).to.equal(false);
        expect(v.validateBundleFile('behavior.json', { schema_version: 2, rules: {}, characters: {} }).valid).to.equal(false);
        expect(v.validateBundleFile('behavior.json', { schema_version: 3 }).valid).to.equal(false);
    });
});

// [v4-pending step 4] GET/PUT /book with the flat `behaviors` map and
// PATCH /behaviors/<id> are the 3.1 editor API. VBook 4 answers with heroes and
// behaviour; the hero API (§8.2) is @animastor/editor 0.5.0, step 4.
describe.skip('[v4-pending step 4] editor routes — flat API map in, v2 on disk (rules survive)', () => {
    const config = require('../src/config/runtime-config');
    const bookModule = require('../src/book/index');
    const ORIG = config.BOOKS_DIR;
    let tmp; let bookId; let bookDir; let handlers;
    const RULE = { id: 'own', scope: 'global', when: { emotion: ['sad'] }, then: { action: 'sighs' }, strength: 1, probability: 1, cooldown_iu: 0, priority: 0 };

    function res() {
        return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; }, setHeader() {} };
    }
    async function call(key, params, body) {
        const r = res();
        await handlers.get(key)({ params, body: body || {}, query: {}, headers: {} }, r);
        return r;
    }
    const disk = () => JSON.parse(fs.readFileSync(path.join(bookDir, 'behavior.json'), 'utf8'));

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beh-editor-'));
        bookId = 'beh-ed-' + Date.now();
        bookDir = path.join(tmp, bookId);
        fs.mkdirSync(path.join(bookDir, 'chapters'), { recursive: true });
        config.BOOKS_DIR = tmp;
        fs.writeFileSync(path.join(bookDir, 'manifest.json'), JSON.stringify({ book_id: bookId, vbook_version: '3.1', build_id: 'b', state: 'BOOTSTRAPPED' }));
        fs.writeFileSync(path.join(bookDir, 'book.json'), JSON.stringify({ book_id: bookId, title: 'T', language: 'ru', structure: { chapters_order: ['chapters/ch-00000001.json'] } }));
        fs.writeFileSync(path.join(bookDir, 'chapters', 'ch-00000001.json'), JSON.stringify({ chapter_id: 'ch-00000001', scenes: [{ scene_id: 'sc-1', units: [{ id: 'iu-1', text: 'x' }] }] }));
        fs.writeFileSync(path.join(bookDir, 'characters.json'), JSON.stringify([{ id: 'hero', name: 'Hero' }, { id: 'side', name: 'Side' }]));
        fs.writeFileSync(path.join(bookDir, 'behavior.json'), JSON.stringify({ schema_version: 2, rules: [RULE], characters: { hero: { baseline: 'calm' } } }));

        handlers = new Map();
        const app = {};
        for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
            app[m] = (p, ...hs) => handlers.set(`${m.toUpperCase()} ${p}`, hs[hs.length - 1]);
        }
        const editorModel = { read: (id) => bookModule.loadBook(id), commit: (b, f) => bookModule.saveBookBundle(b, f) };
        const editorPorts = {
            sceneAssetsRepo: { bumpSceneVersions: async () => 0, setDirtyUnitIds: async () => 0 },
            placeholderAudio: { recoverMissingPlaceholders: async () => ({ created: 0, errors: [] }) },
            auditCoverage: { auditBookCoverage: () => ({}) },
            promptLimit: 2000,
            purge: { purgeScene: async () => ({ complete: true, steps: [] }), purgeUnit: async () => ({ complete: true, steps: [] }) },
            resolveOwnership: async () => ({}),
            recoveryCtx: { isBookRegistered: async () => false },
            bookDiff: { computeBookDiff: () => ({ dirty_scenes: [] }) },
            storage: { bookSync: { reconcileFromDiff: async () => ({ reconciled: 0 }) } },
        };
        const deps = { book: bookModule, editorModel, editorPorts, utils: { log: () => {} } };
        require('../../packages/animastor-editor/src/entity-crud-routes.cjs')(app, {}, deps);
        require('../../packages/animastor-editor/src/editor-routes.cjs')(app, {}, deps);
    });
    afterEach(() => {
        config.BOOKS_DIR = ORIG;
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('GET /book returns the flat map + behavior_rules', async () => {
        const r = await call('GET /api/v1/book/:bookId', { bookId });
        expect(r.statusCode).to.equal(200);
        expect(r.body.behaviors).to.deep.equal({ hero: { baseline: 'calm' } });
        expect(r.body.behavior_rules).to.deep.equal([RULE]);
    });

    it('GET → PUT (flat map, edited) → rules and schema_version still on disk', async () => {
        const got = (await call('GET /api/v1/book/:bookId', { bookId })).body;
        const body = JSON.parse(JSON.stringify(got));
        body.behaviors.hero.baseline = 'edited';
        body.behaviors.side = { baseline: 'new' };
        const r = await call('PUT /api/v1/book/:bookId', { bookId }, body);
        expect(r.statusCode, JSON.stringify(r.body)).to.equal(200);
        expect(disk()).to.deep.equal({ schema_version: 2, rules: [RULE], characters: { hero: { baseline: 'edited' }, side: { baseline: 'new' } } });
    });

    it('PUT without behaviors keeps the stored document', async () => {
        const got = (await call('GET /api/v1/book/:bookId', { bookId })).body;
        delete got.behaviors;
        delete got.behavior_rules;
        await call('PUT /api/v1/book/:bookId', { bookId }, got);
        expect(disk()).to.deep.equal({ schema_version: 2, rules: [RULE], characters: { hero: { baseline: 'calm' } } });
    });

    it('POST / PATCH / DELETE work in characters.<id>; character delete cascades; rules survive', async () => {
        expect((await call('POST /api/v1/book/:bookId/behaviors', { bookId }, { character_id: 'side', baseline: 'b' })).statusCode).to.equal(200);
        expect(disk().characters.side).to.deep.equal({ baseline: 'b' });
        expect((await call('POST /api/v1/book/:bookId/behaviors', { bookId }, { character_id: 'side' })).statusCode).to.equal(409);
        expect((await call('POST /api/v1/book/:bookId/behaviors', { bookId }, { character_id: 'rules' })).statusCode).to.equal(404);

        expect((await call('PATCH /api/v1/book/:bookId/behaviors/:characterId', { bookId, characterId: 'side' }, { fields: { quirks: ['q'] } })).statusCode).to.equal(200);
        expect(disk().characters.side).to.deep.equal({ baseline: 'b', quirks: ['q'] });
        expect((await call('PATCH /api/v1/book/:bookId/behaviors/:characterId', { bookId, characterId: 'rules' }, { fields: { x: 1 } })).statusCode).to.equal(404);

        expect((await call('DELETE /api/v1/book/:bookId/behaviors/:characterId', { bookId, characterId: 'side' })).statusCode).to.equal(200);
        expect(disk().characters).to.not.have.property('side');
        expect((await call('DELETE /api/v1/book/:bookId/behaviors/:characterId', { bookId, characterId: 'schema_version' })).statusCode).to.equal(404);

        expect((await call('DELETE /api/v1/book/:bookId/characters/:characterId', { bookId, characterId: 'hero' })).statusCode).to.equal(200);
        expect(disk()).to.deep.equal({ schema_version: 2, rules: [RULE], characters: {} });
    });

    it('DELETE /characters/:id cascades: entry + scope:"character" rules of that hero; other rules stay', async () => {
        const heroRule = { ...RULE, id: 'hero.r', scope: 'character', character_id: 'hero' };
        const sideRule = { ...RULE, id: 'side.r', scope: 'character', character_id: 'side' };
        const odd = { ...RULE, id: 'global.with_id', scope: 'global', character_id: 'hero' };
        fs.writeFileSync(path.join(bookDir, 'behavior.json'), JSON.stringify({
            schema_version: 2, rules: [RULE, heroRule, sideRule, odd], characters: { hero: { baseline: 'calm' }, side: { baseline: 's' } },
        }));
        expect((await call('DELETE /api/v1/book/:bookId/characters/:characterId', { bookId, characterId: 'hero' })).statusCode).to.equal(200);
        expect(disk()).to.deep.equal({ schema_version: 2, rules: [RULE, sideRule, odd], characters: { side: { baseline: 's' } } });
    });

    it('legacy v2.1 file on disk: PATCH migrates to v2 and edits characters.<id>', async () => {
        fs.writeFileSync(path.join(bookDir, 'behavior.json'), JSON.stringify({ hero: { baseline: 'calm' } }));
        await call('PATCH /api/v1/book/:bookId/behaviors/:characterId', { bookId, characterId: 'hero' }, { fields: { baseline: 'v2' } });
        expect(disk()).to.deep.equal({ schema_version: 2, rules: [], characters: { hero: { baseline: 'v2' } } });
    });
});

// [v4-pending step 4] edit_book paths /behaviors/characters/<id> belong to 3.1;
// @animastor/assistant 0.3.0 retargets them to /heroes/<id>/behaviour/….
describe.skip('[v4-pending step 4] assistant edit_book — behaviours in characters.<id>', () => {
    const createChatEngine = (cfg) => require('@animastor/assistant').createChatEngine(cfg, {
        validateBundleObject: require('../src/book/bundle-validator.cjs').validateBundleObject,
        aiProfile: null,
    });
    const RULE = { id: 'own', when: { emotion: ['sad'] }, then: { action: 'sighs' } };
    const book = () => ({
        manifest: { book_id: 'b', vbook_version: '3.1' },
        book: { book_id: 'b', structure: { chapters_order: [] } },
        characters: [{ id: 'hero', name: 'Hero' }],
        chapters: [],
        locations: {},
        voices: {},
        behaviors: { schema_version: 2, rules: [RULE], characters: { hero: { baseline: 'calm' } } },
    });

    it('v2 path /behaviors/characters/<id> is applied as is', () => {
        const ce = createChatEngine({});
        const r = ce.applyPatchesValidated(book(), [{ op: 'replace', path: '/behaviors/characters/hero/baseline', value: 'x' }]);
        expect(r.errors).to.deep.equal([]);
        expect(r.result.behaviors.characters.hero.baseline).to.equal('x');
    });

    it('legacy /behaviors/<id> paths are rewritten into characters.<id>; rules survive', () => {
        const ce = createChatEngine({});
        const r = ce.applyPatchesValidated(book(), [
            { op: 'replace', path: '/behaviors/hero/baseline', value: 'y' },
            { op: 'add', path: '/behaviors/side', value: { baseline: 'new' } },
        ]);
        expect(r.errors).to.deep.equal([]);
        expect(r.result.behaviors).to.deep.equal({ schema_version: 2, rules: [RULE], characters: { hero: { baseline: 'y' }, side: { baseline: 'new' } } });
    });

    it('replace /behaviors with a flat map → characters; rules / schema_version kept', () => {
        const ce = createChatEngine({});
        const r = ce.applyPatchesValidated(book(), [{ op: 'replace', path: '/behaviors', value: { hero: { baseline: 'z' }, rules: [] } }]);
        expect(r.errors).to.deep.equal([]);
        expect(r.result.behaviors).to.deep.equal({ schema_version: 2, rules: [RULE], characters: { hero: { baseline: 'z' } } });
    });

    it('deleting a character via edit_book cascades: entry + its scope:"character" rules', () => {
        const ce = createChatEngine({});
        const b = book();
        b.characters.push({ id: 'side', name: 'Side' });
        b.behaviors.characters.side = { baseline: 's' };
        const heroRule = { id: 'hero.r', scope: 'character', character_id: 'hero', when: { emotion: ['sad'] }, then: { action: 'x' } };
        const sideRule = { id: 'side.r', scope: 'character', character_id: 'side', when: { emotion: ['sad'] }, then: { action: 'y' } };
        b.behaviors.rules.push(heroRule, sideRule);
        const r = ce.applyPatchesValidated(b, [{ op: 'remove', path: '/characters/0' }]);
        expect(r.errors).to.deep.equal([]);
        expect(r.result.behaviors).to.deep.equal({ schema_version: 2, rules: [RULE, sideRule], characters: { side: { baseline: 's' } } });
        // no character removed → behaviours untouched
        const r2 = ce.applyPatchesValidated(b, [{ op: 'replace', path: '/characters/0/name', value: 'H' }]);
        expect(r2.result.behaviors).to.deep.equal(b.behaviors);
    });

    it('edit-mode prompt documents /behaviors/characters/{character_id}', () => {
        const ce = createChatEngine({});
        const tools = JSON.stringify(ce.getToolsForMode('edit'));
        expect(tools).to.include('/behaviors/characters/');
    });
});
