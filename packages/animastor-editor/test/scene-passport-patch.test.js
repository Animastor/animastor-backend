// ======================================================
// Scene PATCH — one-off look of a hero in a scene (VBook 4)
// ======================================================
// The VBook 4 successor of the scene.passport overrides (VBOOK_FORMAT_V4 §4a.3,
// §4a.4, §8.2): the scene PATCH takes
//   looks.<hero_id>                  — a look id, "base" or null
//   look_patch.<hero_id>.<field>     — appearance | clothes | video_tokens
// and the resolver is resolveHeroLook (the full table of cases:
// packages/animastor-vbook-runtime/test/looks.test.js). Dirty: image + video of
// exactly the scene whose resolved look changed.

'use strict';

const { expect } = require('chai');
const h = require('./hero-harness.cjs');
const { resolveHeroLook } = require('@animastor/vbook-runtime/looks.cjs');

const B = 'scene_look_book_1';
const S1 = 'sc-00000001';

describe('Scene PATCH — looks.<hero_id> and look_patch.<hero_id>.<field> (VBook 4)', function () {
    this.timeout(20000);
    let t;

    beforeEach(async () => {
        t = await h.startHeroServer();
        h.writeBook(t.booksDir, B);
    });
    afterEach(async () => { await t.close(); });

    const patch = (fields) => t.api('PATCH', `/api/v1/book/${B}/scene/${h.CH1}/${S1}`, { fields });
    const scene = () => t.readChapter(B, h.CH1).scenes[0];
    const resolved = (heroId) => {
        const book = h.bookModule.loadBook(B);
        return resolveHeroLook(book, book.chapters[0], book.chapters[0].scenes[0], heroId);
    };

    it('applies look_patch.<hero>.<field> keys to scene.look_patch', async () => {
        const r = await patch({ 'look_patch.yura.appearance': 'wet hair, tired' });
        expect(r.status).to.equal(200);
        expect(scene().look_patch).to.deep.equal({ yura: { appearance: 'wet hair, tired' } });
    });

    it('applies several fields for one hero', async () => {
        await patch({ 'look_patch.yura.appearance': 'wet hair', 'look_patch.yura.clothes': 'raincoat' });
        expect(scene().look_patch.yura).to.deep.equal({ appearance: 'wet hair', clothes: 'raincoat' });
    });

    it('removes a field when an empty string is sent', async () => {
        await patch({ 'look_patch.yura.appearance': 'wet hair', 'look_patch.yura.clothes': 'raincoat' });
        await patch({ 'look_patch.yura.appearance': '' });
        expect(scene().look_patch.yura).to.deep.equal({ clothes: 'raincoat' });
    });

    it('book diff: a look_patch change → image + video dirty for this scene only', async () => {
        const r = await patch({ 'look_patch.yura.clothes': 'raincoat' });
        expect(r.body.dirty_scenes).to.equal(1);
        const dirty = t.calls.bump[0];
        expect(dirty.map((d) => d.scene_id)).to.deep.equal([S1]);
        expect(dirty[0].dirty_layers).to.include.members(['image', 'video']).and.not.include('audio');
    });

    it('no dirty scenes when the override does not change the resolved look', async () => {
        await patch({ 'look_patch.yura.clothes': 'raincoat' });
        t.resetCalls();
        const r = await patch({ 'look_patch.yura.clothes': 'raincoat' });
        expect(r.body.dirty_scenes).to.equal(0);
        expect(t.calls.bump).to.deep.equal([]);
    });

    it('resolveHeroLook prefers the scene patch over the look and the base passport', async () => {
        await patch({ 'looks.yura': 'coat', 'look_patch.yura.clothes': 'raincoat' });
        const look = resolved('yura');
        expect(look).to.include({ look_id: 'coat', source: 'scene', clothes: 'raincoat', appearance: 'tall man, dark hair' });
        expect(look.video_tokens).to.deep.equal(['man', 'grey coat']);
        expect(look.patched).to.deep.equal(['clothes']);
    });

    it('splits comma-joined video_tokens into an array on save', async () => {
        await patch({ 'look_patch.yura.video_tokens': 'man,wet hair,raincoat' });
        expect(scene().look_patch.yura.video_tokens).to.deep.equal(['man', 'wet hair', 'raincoat']);
    });

    it('splits video_tokens with standard ", " spacing into an array', async () => {
        await patch({ 'look_patch.yura.video_tokens': 'man, wet hair, raincoat' });
        expect(scene().look_patch.yura.video_tokens).to.deep.equal(['man', 'wet hair', 'raincoat']);
    });

    it('clears the video_tokens override when an empty string is sent (empty maps are dropped)', async () => {
        await patch({ 'look_patch.yura.video_tokens': 'man, raincoat' });
        await patch({ 'look_patch.yura.video_tokens': '' });
        expect(scene()).to.not.have.property('look_patch');
    });

    it('resolveHeroLook falls back to the base passport once the override is cleared', async () => {
        await patch({ 'looks.yura': 'coat' });
        expect(resolved('yura').clothes).to.equal('grey wool coat');
        await patch({ 'looks.yura': null });
        expect(resolved('yura')).to.include({ look_id: 'base', source: 'base', clothes: 'leather jacket' });
        expect(scene()).to.not.have.property('looks');
    });
});
