const { expect } = require('chai');
const registry = require('../src/dirty-grammar/prompt-dependency-registry');

describe('Prompt Dependency Registry', () => {
    describe('isEqual', () => {
        it('returns true for identical primitives', () => {
            expect(registry.isEqual(42, 42)).to.be.true;
            expect(registry.isEqual('hello', 'hello')).to.be.true;
            expect(registry.isEqual(true, true)).to.be.true;
        });

        it('returns false for different primitives', () => {
            expect(registry.isEqual(42, 43)).to.be.false;
            expect(registry.isEqual('hello', 'world')).to.be.false;
            expect(registry.isEqual(true, false)).to.be.false;
        });

        it('handles null and undefined', () => {
            expect(registry.isEqual(null, null)).to.be.true;
            expect(registry.isEqual(undefined, undefined)).to.be.true;
            expect(registry.isEqual(null, undefined)).to.be.false;
            expect(registry.isEqual(null, 'value')).to.be.false;
        });

        it('compares arrays element-wise', () => {
            expect(registry.isEqual([1, 2, 3], [1, 2, 3])).to.be.true;
            expect(registry.isEqual([1, 2, 3], [1, 2, 4])).to.be.false;
            expect(registry.isEqual([1, 2], [1, 2, 3])).to.be.false;
        });

        it('compares objects by keys', () => {
            expect(registry.isEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).to.be.true;
            expect(registry.isEqual({ a: 1 }, { a: 2 })).to.be.false;
            expect(registry.isEqual({ a: 1 }, { b: 1 })).to.be.false;
        });

        it('compares nested objects', () => {
            expect(registry.isEqual({ a: { b: 1 } }, { a: { b: 1 } })).to.be.true;
            expect(registry.isEqual({ a: { b: 1 } }, { a: { b: 2 } })).to.be.false;
        });
    });

    describe('resolvedLooks (VBook 4: the derived key scene.resolved_looks)', () => {
        const looks = { a: { appearance: 'tall', clothes: 'robe', video_tokens: ['tie'] } };
        const resolveHeroLook = (book, chapter, scene, id) => (looks[id] ? { ...looks[id], base: looks[id] } : null);

        it('participants with a passport → their resolved look (appearance, clothes, video_tokens)', () => {
            const out = registry.resolvedLooks({ participants: ['a', 'b', 'a'] }, { book: {}, chapter: {}, resolveHeroLook });
            expect(out).to.deep.equal({ a: { appearance: 'tall', clothes: 'robe', video_tokens: ['tie'] } });
        });

        it('without a book or a resolver in the context the key is absent', () => {
            expect(registry.resolvedLooks({ participants: ['a'] }, null)).to.equal(undefined);
            expect(registry.resolvedLooks({ participants: ['a'] }, { book: {} })).to.equal(undefined);
        });

        it('computeSceneDirtyLayers compares the RESULT: a changed look → image + video, no audio', () => {
            let v = 'tall';
            const resolver = (book, chapter, scene, id) => (id === 'a' ? { appearance: book.v, clothes: '', video_tokens: [], base: {} } : null);
            const scene = { participants: ['a'] };
            const r = registry.computeSceneDirtyLayers(scene, scene, { old: { book: { v } }, new: { book: { v: 'short' } }, resolveHeroLook: resolver });
            expect(r.dirtyLayers).to.have.members(['image', 'video']);
            expect(r.changes.scene_resolved_looks).to.deep.equal({ changed: true });
            const same = registry.computeSceneDirtyLayers(scene, scene, { old: { book: { v } }, new: { book: { v } }, resolveHeroLook: resolver });
            expect(same.dirtyLayers).to.deep.equal([]);
        });
    });

    describe('sceneReferencesCharacter', () => {
        it('finds character at scene participants level', () => {
            const scene = { participants: ['char-1', 'char-2'] };
            expect(registry.sceneReferencesCharacter(scene, 'char-1')).to.be.true;
            expect(registry.sceneReferencesCharacter(scene, 'char-3')).to.be.false;
        });

        it('returns false for scene with no participants data', () => {
            expect(registry.sceneReferencesCharacter({}, 'char-1')).to.be.false;
            expect(registry.sceneReferencesCharacter({ scene: {} }, 'char-1')).to.be.false;
        });

        it('returns false for unit-level participants (removed — only scene-level used)', () => {
            const scene = {
                scene: {
                    units: [
                        { text: 'test' },
                    ],
                },
            };
            // unit-level participants no longer exist
            expect(registry.sceneReferencesCharacter(scene, 'char-1')).to.be.false;
        });

        it('returns false for scene with null/undefined scene entry', () => {
            expect(registry.sceneReferencesCharacter(null, 'char-1')).to.be.false;
            expect(registry.sceneReferencesCharacter(undefined, 'char-1')).to.be.false;
        });
    });

    describe('computeSceneDirtyLayers', () => {
        it('returns empty for identical scenes', () => {
            const scene = { audio: { full_text: 'Hello' } };
            const result = registry.computeSceneDirtyLayers(scene, scene);
            expect(result.dirtyLayers).to.deep.equal([]);
            expect(result.changes).to.be.null;
        });

        it('detects audio full_text change → audio + image + video', () => {
            const oldScene = { audio: { full_text: 'Hello' } };
            const newScene = { audio: { full_text: 'Hello world' } };
            const result = registry.computeSceneDirtyLayers(oldScene, newScene);
            expect(result.dirtyLayers).to.include.members(['audio', 'image', 'video']);
            expect(result.changes.audio_full_text).to.deep.equal({ changed: true });
        });

        it('detects audio voice change → audio only', () => {
            const oldScene = { audio: { voice: 'narrator' } };
            const newScene = { audio: { voice: 'character' } };
            const result = registry.computeSceneDirtyLayers(oldScene, newScene);
            expect(result.dirtyLayers).to.deep.equal(['audio']);
            expect(result.changes.audio_voice).to.deep.equal({ changed: true });
        });

        it('detects scene visual style change → image + video', () => {
            const oldScene = { visual: { style: 'cinematic' } };
            const newScene = { visual: { style: 'cartoon' } };
            const result = registry.computeSceneDirtyLayers(oldScene, newScene);
            expect(result.dirtyLayers).to.include.members(['image', 'video']);
            expect(result.dirtyLayers).to.not.include('audio');
        });

        it('detects scene location change → image + video', () => {
            const oldScene = { location: { id: 'forest' } };
            const newScene = { location: { id: 'castle' } };
            const result = registry.computeSceneDirtyLayers(oldScene, newScene);
            expect(result.dirtyLayers).to.include.members(['image', 'video']);
        });

        it('detects scene participants change → image + video', () => {
            const oldScene = { participants: ['char-1'] };
            const newScene = { participants: ['char-1', 'char-2'] };
            const result = registry.computeSceneDirtyLayers(oldScene, newScene);
            expect(result.dirtyLayers).to.include.members(['image', 'video']);
        });

        it('scene.passport (3.1) is not a key any more: its change marks nothing', () => {
            const oldScene = { passport: { 'char-1': { clothing_base: 'grey coat' } } };
            const newScene = { passport: { 'char-1': { clothing_base: 'black suit' } } };
            const result = registry.computeSceneDirtyLayers(oldScene, newScene);
            expect(result.dirtyLayers).to.deep.equal([]);
        });

        it('detects units change → image + video + audio', () => {
            const oldScene = { units: [{ text: 'Hello' }] };
            const newScene = { units: [{ text: 'Hello world' }] };
            const result = registry.computeSceneDirtyLayers(oldScene, newScene);
            expect(result.dirtyLayers).to.include.members(['image', 'video', 'audio']);
            expect(result.changes.units).to.deep.equal({ old_count: 1, new_count: 1, unit_ids: [] });
        });

        it('detects dialogue_blocks units change', () => {
            const oldScene = { dialogue_blocks: [{ units: [{ text: 'A' }] }] };
            const newScene = { dialogue_blocks: [{ units: [{ text: 'B' }] }] };
            const result = registry.computeSceneDirtyLayers(oldScene, newScene);
            expect(result.dirtyLayers).to.include.members(['image', 'video', 'audio']);
        });

        it('handles null/undefined scenes without crashing', () => {
            expect(() => registry.computeSceneDirtyLayers(null, null)).to.not.throw();
            expect(() => registry.computeSceneDirtyLayers(undefined, undefined)).to.not.throw();
            expect(() => registry.computeSceneDirtyLayers(null, { audio: { full_text: 'test' } })).to.not.throw();
        });

        it('deduplicates layers when multiple fields change', () => {
            const oldScene = {
                audio: { full_text: 'Hello' },
                visual: { style: 'cinematic' },
            };
            const newScene = {
                audio: { full_text: 'World' },
                visual: { style: 'cartoon' },
            };
            const result = registry.computeSceneDirtyLayers(oldScene, newScene);
            // Both changes push 'image' and 'video' — should be deduplicated
            expect(result.dirtyLayers.sort()).to.deep.equal(['audio', 'image', 'video']);
        });
    });

    describe('getFieldsForLayer', () => {
        it('returns audio-triggered fields', () => {
            const fields = registry.getFieldsForLayer('audio');
            const keys = fields.map(f => f.key);
            expect(keys).to.include('audio.full_text');
            expect(keys).to.include('audio.voice');
            expect(keys).to.not.include('scene.visual.style');
        });

        it('returns image-triggered fields', () => {
            const fields = registry.getFieldsForLayer('image');
            const keys = fields.map(f => f.key);
            expect(keys).to.include('scene.visual.style');
            expect(keys).to.include('scene.location');
        });

        it('returns video-triggered fields', () => {
            const fields = registry.getFieldsForLayer('video');
            const keys = fields.map(f => f.key);
            expect(keys).to.include('scene.visual.style');
            expect(keys).to.include('scene.location');
            expect(keys).to.not.include('audio.voice');  // audio doesn't trigger video
        });
    });

    describe('getLayerDependencies', () => {
        it('audio regenerates only audio', () => {
            const deps = registry.getLayerDependencies();
            expect(deps.audio.regenerate).to.deep.equal(['audio']);
        });

        it('image regenerates image + video', () => {
            const deps = registry.getLayerDependencies();
            expect(deps.image.regenerate).to.include.members(['image', 'video']);
        });

        it('video regenerates only video', () => {
            const deps = registry.getLayerDependencies();
            expect(deps.video.regenerate).to.deep.equal(['video']);
        });

        it('video is NOT triggered by audio fields', () => {
            const deps = registry.getLayerDependencies();
            const audioKeys = deps.video.triggeredBy.filter(k => k.startsWith('audio.'));
            expect(audioKeys).to.deep.equal([]);
        });
    });

    describe('getCrossFields', () => {
        it('returns 2 cross-cutting fields (VBook 4: looks are the derived scene key)', () => {
            const fields = registry.getCrossFields();
            expect(fields).to.have.length(2);
        });

        it('includes heroes.voice and bible.locations; no characters.* / book.voices', () => {
            const keys = registry.getCrossFields().map(f => f.key);
            expect(keys).to.deep.equal(['heroes.voice', 'bible.locations']);
        });

        describe('heroes.voice', () => {
            const field = () => registry.getCrossFields().find(f => f.key === 'heroes.voice');

            it('entitySource: the heroes of the book', () => {
                expect(field().entitySource({ heroes: [{ id: 'narrator' }, { id: 'a' }, { name: 'no id' }] }).map((h) => h.id)).to.deep.equal(['narrator', 'a']);
                expect(field().entitySource({})).to.deep.equal([]);
            });

            it('isChanged follows the LOCKED reference only (sha256 + ref_text), not timbre / manner', () => {
                const ref = (sha, text, locked = true) => ({ voice: { reference: { sha256: sha, ref_text: text, locked } } });
                expect(field().isChanged({ voice: { timbre: 'x' } }, { voice: { timbre: 'y', manner: 'z' } })).to.equal(false);
                expect(field().isChanged(ref('a', 't'), ref('b', 't'))).to.equal(true);
                expect(field().isChanged(ref('a', 't'), ref('a', 'u'))).to.equal(true);
                expect(field().isChanged(ref('a', 't'), ref('a', 't', false))).to.equal(true);
                expect(field().isChanged({}, ref('a', 't', false))).to.equal(false);
                expect(field().isChanged({ name: 'A', voice: {} }, { name: 'B', notes: 'x', voice: {} })).to.equal(false);
            });

            it('findAffectedScenes: narrator → every scene; a hero → scenes where it takes part or speaks', () => {
                const scenes = [
                    { participants: ['a'], scene: {} },
                    { participants: [], scene: { units: [{ audio: { speaker: 'a' } }] } },
                    { participants: ['b'], scene: { dialogue_blocks: [{ units: [{ audio: { speaker: 'b' } }] }] } },
                ];
                expect(field().findAffectedScenes(scenes, 'narrator')).to.have.length(3);
                expect(field().findAffectedScenes(scenes, 'a')).to.deep.equal(scenes.slice(0, 2));
                expect(field().findAffectedScenes(scenes, 'b')).to.deep.equal([scenes[2]]);
            });
        });

        describe('bible.locations entitySource', () => {
            it('converts locations object to array with id', () => {
                const field = registry.getCrossFields().find(f => f.key === 'bible.locations');
                const book = {
                    locations: {
                        forest: { description: 'A dark forest' },
                        castle: { description: 'A castle' },
                    },
                };
                const entities = field.entitySource(book);
                expect(entities).to.have.length(2);
                expect(entities[0].id).to.equal('forest');
                expect(entities[1].id).to.equal('castle');
            });

            it('findAffectedScenes finds scenes with matching location id', () => {
                const field = registry.getCrossFields().find(f => f.key === 'bible.locations');
                const scenes = [
                    { location: { id: 'forest' }, scene: {} },
                    { location: { id: 'castle' }, scene: {} },
                ];
                const affected = field.findAffectedScenes(scenes, 'forest');
                expect(affected).to.have.length(1);
                expect(affected[0].location.id).to.equal('forest');
            });
        });
    });
});
