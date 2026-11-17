const { expect } = require('chai');
const app = require('../src/book/lazy-book/appearance');
const pipelineSteps = require('../src/services/agent/pipeline-steps');
const { applySceneVideoTokens } = require('../src/services/agent/pipeline-runner');
const wf = require('../src/workflows/video/video-workflows');

describe('sanitizeVideoTokens (stage 1 validation)', () => {
    it('trims, drops empties, caps at 4 features', () => {
        const r = app.sanitizeVideoTokens(['tie', '', '  glasses ', 'hat', 'beard', 'cane']);
        expect(r).to.deep.equal(['tie', 'glasses', 'hat', 'beard']);
    });

    it('drops features longer than 60 chars or more than 6 words', () => {
        const long = 'a very long feature sentence that goes on and on about nothing at all';
        const r = app.sanitizeVideoTokens(['tie', long]);
        expect(r).to.deep.equal(['tie']);
    });

    it('returns null for non-array input', () => {
        expect(app.sanitizeVideoTokens('tie')).to.be.null;
        expect(app.sanitizeVideoTokens(undefined)).to.be.null;
        expect(app.sanitizeVideoTokens(null)).to.be.null;
    });
});

describe('tokensToString (render)', () => {
    it('joins array features with commas', () => {
        expect(app.tokensToString(['tie', 'round glasses'])).to.equal('tie, round glasses');
    });
    it('passes legacy strings through', () => {
        expect(app.tokensToString('hero token description')).to.equal('hero token description');
    });
    it('returns empty for empty input', () => {
        expect(app.tokensToString([])).to.equal('');
        expect(app.tokensToString('')).to.equal('');
        expect(app.tokensToString(undefined)).to.equal('');
    });
});

describe('fragmentAppearanceForVideo regression ($2 artifact)', () => {
    it('never leaks the literal $2 replacement token', () => {
        const r = app.fragmentAppearanceForVideo(
            'Short stature, bald head, and large black-rimmed glasses. His face is well-groomed, with a stern expression.',
            'mikhail_berlioz'
        );
        expect(r).not.to.include('$2');
        expect(r).to.equal('short stature');
    });
});

describe('parseSceneVideoTokens (stage 2 response parsing)', () => {
    const rows = [
        // valid — numeric string scene_index, sanitized features
        { scene_index: '0', tokens: { a: ['tie', '', 'hat'], b: 'plain string' } },
        // dropped: non-integer scene_index
        { scene_index: 1.5, tokens: { a: ['x'] } },
        // dropped: empty tokens map
        { scene_index: 2, tokens: {} },
        // dropped: feature too long/wordy
        { scene_index: '3', tokens: { a: ['a very long feature sentence that goes on and on about nothing at all'] } },
    ];

    it('sanitizes tokens, coerces string scene_index, drops invalid rows', () => {
        const r = pipelineSteps.parseSceneVideoTokens(rows);
        expect(r).to.deep.equal([
            { scene_index: 0, tokens: { a: ['tie', 'hat'] } },
        ]);
    });

    it('returns [] for non-array input', () => {
        expect(pipelineSteps.parseSceneVideoTokens(undefined)).to.deep.equal([]);
        expect(pipelineSteps.parseSceneVideoTokens({})).to.deep.equal([]);
    });
});

describe('buildSceneTokensContext (stage 2 prompt context)', () => {
    const characters = [
        { id: 'a', name: 'A', appearance: 'bald', clothes: 'suit', video_tokens: ['tie'] },
        { id: 'b', name: 'B', appearance: 'beard', clothes: 'coat', video_tokens: ['hat'] },
        { id: 'c', name: 'C', appearance: 'tall' }, // no tokens
    ];

    it('lists only scenes with 2+ token-bearing participants', () => {
        const scenes = [
            { title: 'Duet', participants: ['a', 'b'] },
            { title: 'Solo', participants: ['a'] },
            { title: 'One has no tokens', participants: ['a', 'c'] },
        ];
        const ctx = pipelineSteps.buildSceneTokensContext(scenes, characters);
        expect(ctx).to.include('Scene 0 "Duet":');
        expect(ctx).to.include('- a (A): current_tokens="tie" appearance="bald" clothes="suit"');
        expect(ctx).to.include('- b (B): current_tokens="hat"');
        expect(ctx).not.to.include('Scene 1');
        expect(ctx).not.to.include('Scene 2');
    });

    it('returns None when no scene qualifies', () => {
        const scenes = [{ title: 'Solo', participants: ['a'] }];
        expect(pipelineSteps.buildSceneTokensContext(scenes, characters)).to.equal('None');
        expect(pipelineSteps.buildSceneTokensContext([], characters)).to.equal('None');
    });

    it('the current tokens are the RESOLVED look: scene.look_patch wins over the passport', () => {
        const scenes = [{ title: 'S', participants: ['a', 'b'], look_patch: { a: { video_tokens: ['red scarf'] } } }];
        const ctx = pipelineSteps.buildSceneTokensContext(scenes, characters);
        expect(ctx).to.include('- a (A): current_tokens="red scarf"');
        expect(ctx).to.include('- b (B): current_tokens="hat"');
    });

    it('…and so does a look assigned in the scene (resolveHeroLook, not a private lookup)', () => {
        const withLook = [
            { id: 'a', name: 'A', passport: { appearance: 'bald', clothes: 'suit', video_tokens: ['tie'] }, looks: [{ id: 'coat', label: 'Coat', fields: { video_tokens: ['grey coat'] } }] },
            characters[1],
        ];
        const ctx = pipelineSteps.buildSceneTokensContext([{ title: 'S', participants: ['a', 'b'], looks: { a: 'coat' } }], withLook);
        expect(ctx).to.include('- a (A): current_tokens="grey coat"');
    });

    it('a scene cached by a pre-v4 analysis (scene.passport) is read as look_patch', () => {
        const scenes = [{ title: 'S', participants: ['a', 'b'], passport: { a: { video_tokens: ['red scarf'] } } }];
        const ctx = pipelineSteps.buildSceneTokensContext(scenes, characters);
        expect(ctx).to.include('current_tokens="red scarf"');
        expect(scenes[0]).to.not.have.property('passport');
    });

    it('tokens kept as one comma-separated string by an older window still count', () => {
        const legacy = [{ id: 'a', name: 'A', video_tokens: 'tie, round glasses' }, characters[1]];
        const ctx = pipelineSteps.buildSceneTokensContext([{ title: 'S', participants: ['a', 'b'] }], legacy);
        expect(ctx).to.include('- a (A): current_tokens="tie, round glasses"');
    });
});

// VBook 4 (VBOOK_FORMAT_V4 §4a.4, §12 step 2): the reconciliation result is
// scene.look_patch[hero_id].video_tokens. The CURRENT tokens are read through
// resolveHeroLook (passport ← look ← an existing look_patch) and a patch is
// written only when the agent's tokens differ. scene.passport is never written.
describe('applySceneVideoTokens (stage 2 persistence → scene.look_patch)', () => {
    const characters = [
        { id: 'a', name: 'A', video_tokens: ['tie'] },
        { id: 'b', name: 'B', passport: { appearance: 'tall', clothes: 'coat', video_tokens: ['hat'] } },
    ];

    it('writes scene.look_patch when the agent tokens differ from the hero\'s tokens', () => {
        const scenes = [{ participants: ['a', 'b'] }];
        applySceneVideoTokens(scenes, [
            { scene_index: 0, tokens: { a: ['red scarf'], b: ['hat'] } },
        ], characters);
        // a changed → patch written; b unchanged → the passport still applies (no patch)
        expect(scenes[0].look_patch).to.deep.equal({ a: { video_tokens: ['red scarf'] } });
        expect(scenes[0]).to.not.have.property('passport');
    });

    it('does not write when the agent tokens equal the current tokens', () => {
        const scenes = [{ participants: ['a', 'b'] }];
        applySceneVideoTokens(scenes, [
            { scene_index: 0, tokens: { a: ['tie'], b: [' hat '] } },
        ], characters);
        expect(scenes[0]).to.not.have.property('look_patch');
        expect(scenes[0]).to.not.have.property('passport');
    });

    it('merges into an existing look_patch preserving its other fields and other heroes', () => {
        const scenes = [{
            participants: ['a', 'b'],
            look_patch: { b: { video_tokens: ['x'], clothes: 'keep me' }, a: { clothes: 'bathrobe' } },
        }];
        applySceneVideoTokens(scenes, [
            { scene_index: 0, tokens: { a: ['red scarf'] } },
        ], characters);
        expect(scenes[0].look_patch).to.deep.equal({
            a: { clothes: 'bathrobe', video_tokens: ['red scarf'] },
            b: { video_tokens: ['x'], clothes: 'keep me' },
        });
    });

    it('ignores tokens for characters that are not scene participants or not heroes', () => {
        const scenes = [{ participants: ['a', 'ghost'] }];
        applySceneVideoTokens(scenes, [
            { scene_index: 0, tokens: { z: ['intruder'], b: ['cap'], ghost: ['mist'], a: ['red scarf'] } },
        ], characters);
        expect(scenes[0].look_patch).to.deep.equal({ a: { video_tokens: ['red scarf'] } });
    });

    it('an existing look_patch is the current value: the same tokens are not written again, new ones replace it', () => {
        const scenes = [{ participants: ['a', 'b'], look_patch: { a: { video_tokens: ['scarf'] } } }];
        const before = scenes[0].look_patch;
        applySceneVideoTokens(scenes, [{ scene_index: 0, tokens: { a: ['scarf'] } }], characters);
        expect(scenes[0].look_patch).to.equal(before); // untouched object — no write at all
        applySceneVideoTokens(scenes, [{ scene_index: 0, tokens: { a: ['tie'] } }], characters);
        // back to the passport tokens is a change against the current patch → written
        expect(scenes[0].look_patch.a.video_tokens).to.deep.equal(['tie']);
    });

    it('the current tokens come from the look assigned in the scene, not from the base passport', () => {
        const withLook = [{ id: 'a', name: 'A', passport: { appearance: 'x', clothes: 'y', video_tokens: ['tie'] },
            looks: [{ id: 'coat', label: 'Coat', fields: { video_tokens: ['grey coat'] } }] }];
        const scenes = [{ participants: ['a'], looks: { a: 'coat' } }, { participants: ['a'], looks: { a: 'coat' } }];
        applySceneVideoTokens(scenes, [
            { scene_index: 0, tokens: { a: ['grey coat'] } },   // equals the look → nothing
            { scene_index: 1, tokens: { a: ['tie'] } },         // equals the BASE, differs from the look → written
        ], withLook);
        expect(scenes[0]).to.not.have.property('look_patch');
        expect(scenes[1].look_patch).to.deep.equal({ a: { video_tokens: ['tie'] } });
    });

    it('a scene cached by a pre-v4 analysis (scene.passport) is read as look_patch and loses the old key', () => {
        const scenes = [{ participants: ['a', 'b'], passport: { a: { video_tokens: ['scarf'] } } }];
        applySceneVideoTokens(scenes, [{ scene_index: 0, tokens: { a: ['scarf'], b: ['cap'] } }], characters);
        expect(scenes[0]).to.not.have.property('passport');
        expect(scenes[0].look_patch).to.deep.equal({ a: { video_tokens: ['scarf'] }, b: { video_tokens: ['cap'] } });
    });

    it('tokens are sanitized (trimmed, at most four) and an empty list is never written', () => {
        const scenes = [{ participants: ['a', 'b'] }];
        applySceneVideoTokens(scenes, [
            { scene_index: 0, tokens: { a: [' one ', 'two', 'three', 'four', 'five'], b: [] } },
        ], characters);
        expect(scenes[0].look_patch).to.deep.equal({ a: { video_tokens: ['one', 'two', 'three', 'four'] } });
    });

    it('does nothing for empty rows or unknown scene indexes', () => {
        const scenes = [{ participants: ['a', 'b'] }];
        applySceneVideoTokens(scenes, [], characters);
        applySceneVideoTokens(scenes, [{ scene_index: 7, tokens: { a: ['x'] } }], characters);
        expect(scenes[0]).to.deep.equal({ participants: ['a', 'b'] });
    });
});

describe('buildCharLines duplicate guard (order-insensitive)', () => {
    it('treats the same feature set in different order as a collision', () => {
        const book = {
            heroes: [
                { id: 'a', name: 'A', passport: { video_tokens: ['tie', 'red jacket'] } },
                { id: 'b', name: 'B', passport: { video_tokens: ['blue shirt'] } },
            ],
        };
        const scene = {
            look_patch: {
                a: { video_tokens: ['tie', 'red jacket'] },
                b: { video_tokens: ['red jacket', 'tie'] }, // same set, different order
            },
        };
        const lines = wf.buildCharLines(['a', 'b'], book, scene);
        // a keeps its scene override; b falls back to its global token
        expect(lines).to.deep.equal(['a: tie, red jacket.', 'b: blue shirt.']);
    });
});
