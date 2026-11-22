// ======================================================
// @animastor/assistant 0.3.1 — honest edit turns (engine level)
// ======================================================
// reports/2026-11-22/assistant-edit-bug.md: the model answered "Done. I've
// added …" with a ```json scene instead of calling edit_book, and nothing was
// saved. Engine pieces of the fix:
//   - the book context is a READ-ONLY snapshot (no "return the full changed
//     version in your response");
//   - looksLikeChangeClaim — a reply that reports a change / pastes a changed
//     book JSON, so the routes can retry once and never relay a false "Done";
//   - assignMissingIds — a scene / unit added without ids gets sc-/iu- ids.

const { expect } = require('chai');
const { createChatEngine } = require('../src/index.cjs');

const engine = createChatEngine({}, { validateBundleObject: () => ({ valid: true, errors: [] }), aiProfile: null });

describe('EH1: book context is a read-only snapshot', () => {
    const book = { manifest: {}, chapters: [{ chapter_id: 'ch-1', scenes: [] }] };
    it('edit turn: points at edit_book, never asks for the changed JSON in the reply', () => {
        const ctx = engine.buildBookContext(book, { canEdit: true });
        expect(ctx).to.match(/READ-ONLY snapshot/);
        expect(ctx).to.match(/`edit_book`/);
        expect(ctx).to.not.match(/return the full changed version/);
    });
    it('other modes: says the book cannot be changed here', () => {
        expect(engine.buildBookContext(book)).to.match(/In this mode you cannot change the book/);
        expect(engine.buildCompactBookContext(book, { canEdit: true })).to.match(/READ-ONLY snapshot/);
    });
    it('the edit-mode prompt documents scene / unit paths and drops "confirm before applying"', () => {
        const p = engine.buildChatSystemPrompt({ mode: 'edit', topic: 'book', lang: 'en' });
        expect(p).to.match(/add \/chapters\/<chapter_index>\/scenes\/-/);
        expect(p).to.match(/`video` \{action\}/);
        expect(p).to.not.match(/Always confirm changes with the user before applying/);
    });
});

describe('EH2: looksLikeChangeClaim', () => {
    const claims = [
        'Done. I’ve added **“The Unexpected Visitor”** as Scene 2 in your chapter.',
        "I've filled in the video.action field for all four units.",
        'I have updated the scene text.',
        'The new scene has been added to chapter 1.',
        'Готово! Добавил сцену «Гость» во вторую главу.',
        'Я заполнил поле video.action для всех юнитов.',
        'Here is the scene:\n```json\n{"scene_id": "sc-1", "units": []}\n```',
    ];
    const notClaims = [
        '',
        'What would you like to change in the scene?',
        'Хотите, чтобы я добавил сцену с этим текстом?',
        'The scene is about a visitor who knocks at night. It is a good opening.',
        'A JSON example of a unit field: `{"text": "..."}`.',
    ];
    for (const t of claims) it(`claim: ${JSON.stringify(t.slice(0, 48))}`, () => expect(engine.looksLikeChangeClaim(t)).to.equal(true));
    for (const t of notClaims) it(`not a claim: ${JSON.stringify(t.slice(0, 48))}`, () => expect(engine.looksLikeChangeClaim(t)).to.equal(false));
    it('the corrective retry prompt names edit_book', () => {
        expect(engine.EDIT_RETRY_PROMPT).to.match(/edit_book/);
    });
});

describe('EH3: assignMissingIds', () => {
    it('gives a new scene and its units ids, keeps existing ids, adds participants', () => {
        const book = { chapters: [{ chapter_id: 'ch-1', scenes: [
            { scene_id: 'sc-aaaaaaaa', units: [{ id: 'iu-aaaaaaaa', text: 'a' }] },
            { scene_title: 'New', units: [{ text: 'b' }, { id: '', text: 'c' }] },
        ] }] };
        engine.assignMissingIds(book);
        const [s0, s1] = book.chapters[0].scenes;
        expect(s0.scene_id).to.equal('sc-aaaaaaaa');
        expect(s0.units[0].id).to.equal('iu-aaaaaaaa');
        expect(s1.scene_id).to.match(/^sc-[0-9a-f]{8}$/);
        expect(s1.participants).to.deep.equal([]);
        expect(s1.units.map((u) => u.id)).to.satisfy((ids) => ids.every((id) => /^iu-[0-9a-f]{8}$/.test(id)));
        expect(new Set(s1.units.map((u) => u.id)).size).to.equal(2);
    });
    it('applyPatchesValidated assigns ids to a scene added without them', () => {
        const book = { chapters: [{ chapter_id: 'ch-1', scenes: [{ scene_id: 'sc-aaaaaaaa', units: [] }] }] };
        const r = engine.applyPatchesValidated(book, [{ op: 'add', path: '/chapters/0/scenes/-', value: { units: [{ text: 'x', video: { action: 'y' } }] } }]);
        expect(r.errors).to.deep.equal([]);
        expect(r.result.chapters[0].scenes[1].scene_id).to.match(/^sc-/);
        expect(r.result.chapters[0].scenes[1].units[0]).to.include({ text: 'x' });
        expect(r.result.chapters[0].scenes[1].units[0].id).to.match(/^iu-/);
        expect(book.chapters[0].scenes).to.have.length(1); // input untouched
    });
});
