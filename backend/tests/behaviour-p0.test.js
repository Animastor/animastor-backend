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
const { heroRules } = require('@animastor/vbook-runtime/heroes.cjs');

const BOOK = 'book_behaviour_test';

// VBook 4 (§6.3): a rule in behaviour.json / a hero file carries no scope /
// character_id — they follow from where it is stored.
function stored(r) {
    const { scope, character_id, ...rest } = r; // eslint-disable-line no-unused-vars
    return rest;
}
function writeGlobals(dir, doc) {
    fs.writeFileSync(path.join(dir, 'behaviour.json'), JSON.stringify({ schema: 'animastor.behaviour-globals/1', ...doc, ...(doc.rules ? { rules: doc.rules.map(stored) } : {}) }));
}
function writeHero(dir, hero) {
    fs.mkdirSync(path.join(dir, 'characters'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'characters', `${hero.id}.json`), JSON.stringify({ schema: 'animastor.character/1', ...hero }));
}

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

    it('applyBehavioursToWindow reads the book override from behaviour.json (0 = off for the whole window)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beh-limit-'));
        const glob = rule({ id: 'g', probability: 1 });
        const mk = () => [{ units: twoHeroes(4) }, { units: twoHeroes(4) }];
        writeGlobals(dir, { rules: [glob], defaults: { max_per_scene: 1 } });
        let scenes = mk();
        let r = applyBehavioursToWindow(scenes, { bookId: BOOK, bookDir: dir });
        expect(r.maxPerScene).to.equal(1);
        expect(scenes.map(sc => count(sc.units.map(u => u.behaviour)))).to.deep.equal([1, 1]);
        writeGlobals(dir, { rules: [glob], defaults: { max_per_scene: 0 } });
        scenes = mk();
        r = applyBehavioursToWindow(scenes, { bookId: BOOK, bookDir: dir });
        expect(r.applied).to.equal(0);
        expect(scenes.every(sc => sc.units.every(u => u.behaviour === undefined))).to.equal(true);
        writeGlobals(dir, { rules: [glob] });
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
        // the structure examples are a VBook 4 book: behaviour.json + one file per hero
        expect(names).to.include('behaviour.json');
        expect(names).to.include('characters/narrator.json');
        for (const legacy of ['behavior.json', 'characters.json', 'voices.json', 'mentions.json']) expect(names, legacy).to.not.include(legacy);
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

    it('loadEffectiveRules (VBook 4): defaults ⊕ behaviour.json rules (global) ⊕ hero rules (character)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beh-rules-'));
        // a 3.1 behavior.json is not read at all
        fs.writeFileSync(path.join(dir, 'behavior.json'), JSON.stringify({ schema_version: 2, rules: [rule({ id: 'legacy' })], characters: {} }));
        expect(behaviourRules.readBookRules(dir)).to.deep.equal([]);
        writeGlobals(dir, { rules: [rule({ id: 'own' })] });
        writeHero(dir, { id: 'yura', name: 'Юра', behaviour: { profile: { baseline: 'calm' }, rules: [stored(rule({ id: 'yura_blush' }))] } });
        const book = behaviourRules.readBookRules(dir);
        expect(book.map(r => [r.id, r.scope, r.character_id])).to.deep.equal([['own', 'global', undefined], ['yura_blush', 'character', 'yura']]);
        const eff = behaviourRules.loadEffectiveRules(dir);
        expect(eff.map(r => r.id)).to.include.members(['own', 'yura_blush']).and.not.include('legacy');
        expect(eff.find(r => r.id === 'yura_blush')).to.include({ scope: 'character', character_id: 'yura' });
        expect(eff).to.have.length(behaviourRules.loadDefaultRules().length + 2);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('a book rule {id, enabled:false} switches a default off; a duplicate id keeps the first source and is logged', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beh-dup-'));
        const someDefault = behaviourRules.loadDefaultRules()[0].id;
        writeGlobals(dir, { rules: [{ id: someDefault, enabled: false, when: { emotion: ['sad'] }, then: { action: 'x' } }, rule({ id: 'dup' })] });
        writeHero(dir, { id: 'yura', name: 'Юра', behaviour: { rules: [stored(rule({ id: 'dup', then: { action: 'other' } }))] } });
        const warnings = [];
        const settings = behaviourRules.loadEffectiveSettings(dir, { log: { warn: (m) => warnings.push(m) } });
        expect(settings.rules.map(r => r.id)).to.not.include(someDefault);
        expect(settings.rules.find(r => r.id === 'dup')).to.include({ scope: 'global' });
        expect(warnings.join('\n')).to.include('duplicate_rule_id').and.include('dup');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('a broken behaviour.json is treated as absent (В5): defaults + hero rules still apply', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beh-broken-'));
        fs.writeFileSync(path.join(dir, 'behaviour.json'), '{ not json');
        writeHero(dir, { id: 'yura', name: 'Юра', behaviour: { rules: [stored(rule({ id: 'yura_blush' }))] } });
        const warnings = [];
        const settings = behaviourRules.loadEffectiveSettings(dir, { log: { warn: (m) => warnings.push(m) } });
        expect(settings.rules.map(r => r.id)).to.include('yura_blush');
        expect(settings.maxPerScene).to.equal(2); // the defaults file
        expect(warnings.join('\n')).to.include('behaviour.json invalid_json');
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

// VBook 4 step 3 (VBOOK_FORMAT_V4 §6): the 3.1 behavior.json v2 document and
// behavior-schema.cjs are gone (step 1). The same intents on v4 — behaviours
// live in behaviour.json (defaults + global rules) and in hero files
// (behaviour.profile + behaviour.rules). The flat API projection
// (behaviors / behavior_rules) is the 3.1 editor API — step 4 (§8.2).
describe('VBook 4 — behaviour on disk / in memory / at import', () => {
    const config = require('../src/config/runtime-config');
    const bookModule = require('../src/book/index');
    const lazyBook = require('@animastor/vbook-runtime/lazy-book');
    const { configureBooksRoot } = require('@animastor/vbook-runtime/books-root');
    const { validateCharacterFile, validateBehaviourGlobals } = require('@animastor/vbook-runtime/character-validator.cjs');
    const { heroRules } = require('@animastor/vbook-runtime/heroes.cjs');
    const ORIG = config.BOOKS_DIR;
    let tmp;

    const RULE = { id: 'own', when: { emotion: ['sad'] }, then: { action: 'sighs' }, strength: 1, probability: 1, cooldown_iu: 0, priority: 0 };

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beh-v4-'));
        config.BOOKS_DIR = tmp;
        configureBooksRoot(() => config.BOOKS_DIR);
    });
    afterEach(() => {
        config.BOOKS_DIR = ORIG;
        configureBooksRoot(() => config.BOOKS_DIR);
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    function draftWithHero() {
        const { bookId } = lazyBook.createDraftBook('Глава 1.\n\nЮра вошёл.\n', lazyBook.SourceType.TXT, 'beh.txt');
        const dir = path.join(tmp, bookId);
        writeHero(dir, { id: 'yura', name: 'Юра', passport: { appearance: 'young man', clothes: 'coat', video_tokens: ['coat'] } });
        return { bookId, dir };
    }

    it('a v4 book on disk: global rules, defaults, hero profile (unknown keys too) and hero rules are read; the matcher gets them with scope', () => {
        const { dir } = draftWithHero();
        writeGlobals(dir, { defaults: { max_per_scene: 3 }, rules: [RULE] });
        const hero = JSON.parse(fs.readFileSync(path.join(dir, 'characters', 'yura.json'), 'utf8'));
        hero.behaviour = { profile: { baseline: 'calm', quirks: ['fidgets'], extra: 1 }, rules: [{ ...RULE, id: 'yura_sigh' }] };
        fs.writeFileSync(path.join(dir, 'characters', 'yura.json'), JSON.stringify(hero));
        const before = { globals: fs.readFileSync(path.join(dir, 'behaviour.json'), 'utf8') };
        const loaded = lazyBook.loadDraftBook(path.basename(dir));
        expect(loaded.behaviour).to.deep.equal(JSON.parse(before.globals));
        expect(loaded.heroes.find((h) => h.id === 'yura').behaviour).to.deep.equal(hero.behaviour);
        const { rules, duplicates } = heroRules(loaded);
        expect(rules.map((r) => [r.id, r.scope, r.character_id])).to.deep.equal([['own', 'global', undefined], ['yura_sigh', 'character', 'yura']]);
        expect(duplicates).to.deep.equal([]);
        // the same through the backend loader of the matcher
        expect(behaviourRules.readBookRules(dir).map((r) => r.id)).to.deep.equal(['own', 'yura_sigh']);
        expect(behaviourRules.loadEffectiveSettings(dir).maxPerScene).to.equal(3);
    });

    it('.vbook import (buildBookFromBundle) carries behaviour.json and the hero behaviour', () => {
        const files = {
            'manifest.json': JSON.stringify({ book_id: 'imp', vbook_version: 4 }),
            'book.json': JSON.stringify({ book_id: 'imp', structure: { chapters_order: ['ch-00000001.json'] } }),
            'chapters/ch-00000001.json': JSON.stringify({ chapter_id: 'ch-00000001', scenes: [{ scene_id: 'sc-00000001', units: [{ id: 'iu-00000001', text: 'x' }] }] }),
            'behaviour.json': JSON.stringify({ schema: 'animastor.behaviour-globals/1', defaults: { max_per_scene: 1 }, rules: [RULE] }),
            'characters/yura.json': JSON.stringify({ schema: 'animastor.character/1', id: 'yura', name: 'Юра', behaviour: { profile: { baseline: 'calm' }, rules: [{ ...RULE, id: 'yura_sigh' }] } }),
        };
        const b = bookModule.buildBookFromBundle(files);
        expect(b.behaviour).to.deep.include({ defaults: { max_per_scene: 1 } });
        expect(b.behaviour.rules.map((r) => r.id)).to.deep.equal(['own']);
        expect(b.heroes.find((h) => h.id === 'yura').behaviour.profile).to.deep.equal({ baseline: 'calm' });
        expect(b).to.not.have.property('behaviors');
    });

    it('validator: scope / character_id are not written in a stored rule; a duplicate id across the book is reported', () => {
        expect(validateBehaviourGlobals({ schema: 'animastor.behaviour-globals/1', rules: [RULE] }).valid).to.equal(true);
        expect(validateBehaviourGlobals({ schema: 'animastor.behaviour-globals/1', rules: [{ ...RULE, scope: 'global' }] }).valid).to.equal(false);
        const heroFile = (rule) => ({ schema: 'animastor.character/1', id: 'yura', name: 'Юра', behaviour: { rules: [rule] } });
        expect(validateCharacterFile(heroFile({ ...RULE, id: 'y' })).valid).to.equal(true);
        expect(validateCharacterFile(heroFile({ ...RULE, id: 'y', character_id: 'yura' })).valid).to.equal(false);
        const book = {
            behaviour: { schema: 'animastor.behaviour-globals/1', rules: [RULE] },
            heroes: [{ id: 'yura', behaviour: { rules: [RULE] } }, { id: 'anna', behaviour: { rules: [{ ...RULE, id: 'a' }] } }],
        };
        const out = heroRules(book);
        expect(out.duplicates).to.deep.equal(['own']);
        expect(out.rules.map((r) => r.id)).to.deep.equal(['own', 'a']);
    });
});

// VBook 4 step 4: the editor API of behaviour — GET/PUT /book carry `behaviour`
// (behaviour.json: defaults + global rules) and the heroes with their own
// behaviour {profile, rules}; a hero's behaviour is edited through the hero API
// (VBOOK_FORMAT_V4 §6, §8.2). The flat `behaviors` map and /behaviors are gone.
describe('editor routes — behaviour.json and hero behaviour in VBook 4 (rules survive)', function () {
    this.timeout(20000);
    const harness = require('../../packages/animastor-editor/test/hero-harness.cjs');
    const B = 'beh_ed_book';
    let t;
    const disk = () => JSON.parse(fs.readFileSync(path.join(t.bookDir(B), 'behaviour.json'), 'utf8'));
    const GLOBAL = { id: 'global.sigh', when: { emotion: ['sad'] }, then: { action: 'sighs' } };

    beforeEach(async () => {
        t = await harness.startHeroServer();
        harness.writeBook(t.booksDir, B);
    });
    afterEach(async () => { await t.close(); });

    it('GET /book returns behaviour (globals) and heroes with their own behaviour; no behaviors / behavior_rules', async () => {
        const r = await t.api('GET', `/api/v1/book/${B}`);
        expect(r.status).to.equal(200);
        expect(r.body.behaviour).to.deep.equal({ schema: 'animastor.behaviour-globals/1', defaults: { max_per_scene: 2 }, rules: [GLOBAL] });
        expect(r.body.heroes.find((h) => h.id === 'yura').behaviour.profile.baseline).to.equal('calm');
        expect(r.body).to.not.have.property('behaviors');
        expect(r.body).to.not.have.property('behavior_rules');
    });

    it('GET → PUT (a hero profile edited) → the hero file changes, behaviour.json rules stay', async () => {
        const body = (await t.api('GET', `/api/v1/book/${B}`)).body;
        body.heroes.find((h) => h.id === 'yura').behaviour.profile.baseline = 'edited';
        const r = await t.api('PUT', `/api/v1/book/${B}`, body);
        expect(r.status, JSON.stringify(r.body)).to.equal(200);
        expect(t.readHero(B, 'yura').behaviour.profile.baseline).to.equal('edited');
        expect(t.readHero(B, 'yura').behaviour.rules.map((x) => x.id)).to.deep.equal(['yura.praised']);
        expect(disk().rules).to.deep.equal([GLOBAL]);
    });

    it('PUT without behaviour keeps behaviour.json as it is', async () => {
        const body = (await t.api('GET', `/api/v1/book/${B}`)).body;
        delete body.behaviour;
        const before = fs.readFileSync(path.join(t.bookDir(B), 'behaviour.json'), 'utf8');
        expect((await t.api('PUT', `/api/v1/book/${B}`, body)).status).to.equal(200);
        expect(fs.readFileSync(path.join(t.bookDir(B), 'behaviour.json'), 'utf8')).to.equal(before);
    });

    it('profile and rules of a hero through the hero API; behaviour.json untouched', async () => {
        expect((await t.api('PATCH', `/api/v1/book/${B}/heroes/sveta`, { fields: { 'behaviour.profile.baseline': 'b' } })).status).to.equal(200);
        expect(t.readHero(B, 'sveta').behaviour).to.deep.equal({ profile: { baseline: 'b' } });
        expect((await t.api('POST', `/api/v1/book/${B}/heroes/sveta/rules`, { id: 'sveta.r', when: { emotion: ['joy'] }, then: { action: 'laughs' } })).status).to.equal(201);
        expect((await t.api('POST', `/api/v1/book/${B}/heroes/sveta/rules`, { id: 'sveta.r', then: { action: 'laughs' } })).status).to.equal(409);
        expect((await t.api('PATCH', `/api/v1/book/${B}/heroes/sveta/rules/sveta.r`, { fields: { enabled: false } })).status).to.equal(200);
        expect(t.readHero(B, 'sveta').behaviour.rules).to.deep.equal([{ id: 'sveta.r', when: { emotion: ['joy'] }, then: { action: 'laughs' }, enabled: false }]);
        expect((await t.api('DELETE', `/api/v1/book/${B}/heroes/sveta/rules/sveta.r`)).status).to.equal(200);
        expect(disk().rules).to.deep.equal([GLOBAL]);
    });

    it('DELETE /heroes/:id takes the hero\'s rules with its file; other heroes\' rules and global rules stay', async () => {
        await t.api('POST', `/api/v1/book/${B}/heroes/sveta/rules`, { id: 'sveta.r', when: { emotion: ['joy'] }, then: { action: 'laughs' } });
        expect((await t.api('DELETE', `/api/v1/book/${B}/heroes/yura`)).status).to.equal(200);
        const out = heroRules(harness.bookModule.loadBook(B));
        expect(out.rules.map((r) => [r.id, r.scope, r.character_id || null])).to.deep.equal([['global.sigh', 'global', null], ['sveta.r', 'character', 'sveta']]);
    });

    it('a broken behaviour.json: the book saves unchanged, a behaviour write is refused, the file keeps its bytes', async () => {
        fs.writeFileSync(path.join(t.bookDir(B), 'behaviour.json'), '{ broken');
        const body = (await t.api('GET', `/api/v1/book/${B}`)).body;
        expect(body.hero_issues.find((i) => i.file === 'behaviour.json')).to.include({ blocking: true });
        expect((await t.api('PUT', `/api/v1/book/${B}`, body)).status).to.equal(200);
        expect((await t.api('PATCH', `/api/v1/book/${B}/behaviour`, { fields: { 'defaults.max_per_scene': 1 } })).body.error).to.equal('behaviour_file_broken');
        expect(fs.readFileSync(path.join(t.bookDir(B), 'behaviour.json'), 'utf8')).to.equal('{ broken');
    });
});

// VBook 4 step 4: edit_book addresses heroes by id — /heroes/<id>/behaviour/…
// (@animastor/assistant 0.3.0); the 3.1 paths /behaviors/… are refused.
describe('assistant edit_book — hero behaviour at /heroes/<id>/behaviour', () => {
    const createChatEngine = (cfg) => require('@animastor/assistant').createChatEngine(cfg, {
        validateBundleObject: require('../src/book/bundle-validator.cjs').validateBundleObject,
        aiProfile: null,
    });
    const RULE = { id: 'own', when: { emotion: ['sad'] }, then: { action: 'sighs' } };
    const book = () => ({
        manifest: { book_id: 'b', vbook_version: 4 },
        book: { book_id: 'b', structure: { chapters_order: [] } },
        behaviour: { schema: 'animastor.behaviour-globals/1', defaults: { max_per_scene: 2 }, rules: [RULE] },
        heroes: [
            { schema: 'animastor.character/1', id: 'narrator', role: 'narrator', voice: { timbre: 'Calm.' } },
            { schema: 'animastor.character/1', id: 'hero', name: 'Hero', behaviour: { profile: { baseline: 'calm' }, rules: [{ id: 'hero.r', when: { emotion: ['sad'] }, then: { action: 'x' } }] } },
            { schema: 'animastor.character/1', id: 'side', name: 'Side' },
        ],
        chapters: [],
        locations: {},
    });

    it('/heroes/<id>/behaviour/profile/baseline is applied to that hero (the segment is an id, not an index)', () => {
        const ce = createChatEngine({});
        const r = ce.applyPatchesValidated(book(), [{ op: 'replace', path: '/heroes/hero/behaviour/profile/baseline', value: 'x' }]);
        expect(r.errors).to.deep.equal([]);
        expect(r.result.heroes[1].behaviour.profile.baseline).to.equal('x');
        expect(r.result.heroes[1].behaviour.rules.map((x) => x.id)).to.deep.equal(['hero.r']);
    });

    it('add /heroes/<id>/behaviour/profile creates the behaviour of a hero that had none; global rules survive', () => {
        const ce = createChatEngine({});
        const r = ce.applyPatchesValidated(book(), [{ op: 'add', path: '/heroes/side/behaviour/profile', value: { baseline: 'new', quirks: ['q'] } }]);
        expect(r.errors).to.deep.equal([]);
        expect(r.result.heroes[2].behaviour).to.deep.equal({ profile: { baseline: 'new', quirks: ['q'] } });
        expect(r.result.behaviour.rules).to.deep.equal([RULE]);
    });

    it('the 3.1 paths /behaviors/… are refused with a hint; nothing is applied', () => {
        const ce = createChatEngine({});
        for (const p of ['/behaviors/hero/baseline', '/behaviors/characters/hero/baseline', '/behaviors']) {
            const r = ce.applyPatchesValidated(book(), [{ op: 'replace', path: p, value: 'y' }]);
            expect(r.result, p).to.equal(null);
            expect(r.errors[0]).to.match(/not part of VBook 4.*\/heroes\/<hero_id>/);
        }
    });

    it('removing a hero via edit_book takes its rules with it; the narrator cannot be removed', () => {
        const ce = createChatEngine({});
        const r = ce.applyPatchesValidated(book(), [{ op: 'remove', path: '/heroes/hero' }]);
        expect(r.errors).to.deep.equal([]);
        expect(heroRules(r.result).rules.map((x) => x.id)).to.deep.equal(['own']);
        const n = ce.applyPatchesValidated(book(), [{ op: 'remove', path: '/heroes/narrator' }]);
        expect(n.result).to.equal(null);
        expect(n.errors[0]).to.match(/narrator cannot be removed/);
    });

    it('edit-mode prompt and tool document /heroes/{hero_id}', () => {
        const ce = createChatEngine({});
        const tools = JSON.stringify(ce.getToolsForMode('edit'));
        expect(tools).to.include('/heroes/{hero_id}/');
        expect(tools).to.not.include('/behaviors/characters/');
        expect(ce.buildChatSystemPrompt({ mode: 'edit' })).to.include('/heroes/<hero_id>/');
    });
});
