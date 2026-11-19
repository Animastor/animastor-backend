// ======================================================
// VBook 4 step 3 — scripts/audit-video-actions.js reads the v4 cast
// ======================================================
// VBOOK_FORMAT_V4 §11.1 (audit-video-actions.js: mentions.json and
// characters.json → step 3). The cast is characters/<id>.json; a broken hero
// file is a FAIL, an alias two heroes claim a WARN; the 3.1 files are not read.

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const audit = require('../scripts/audit-video-actions');

describe('VBook 4 step 3 — audit-video-actions.js on a v4 book', () => {
    let root;
    const bookId = 'audit_v4';
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-audit-'));
        const dir = path.join(root, bookId);
        fs.mkdirSync(path.join(dir, 'characters'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'chapters'));
        const hero = (h) => fs.writeFileSync(path.join(dir, 'characters', `${h.id}.json`), JSON.stringify({ schema: 'animastor.character/1', ...h }));
        hero({ id: 'mikhail_berlioz', name: 'Михаил Берлиоз', aliases: ['редактор'], passport: { appearance: 'short man', clothes: 'grey suit', video_tokens: ['grey suit'] } });
        hero({ id: 'ivan_ponyrev', name: 'Иван Понырев', aliases: ['редактор'], passport: { appearance: 'young man', clothes: 'cap', video_tokens: ['cap'] } });
        fs.writeFileSync(path.join(dir, 'characters', 'broken.json'), '{ nope');
        // 3.1 leftovers are ignored
        fs.writeFileSync(path.join(dir, 'characters.json'), JSON.stringify([{ id: 'zhenshchina_v_budochke', name: 'X' }]));
        fs.writeFileSync(path.join(dir, 'mentions.json'), JSON.stringify({ 'кто-то': 'invented_target' }));
        fs.writeFileSync(path.join(dir, 'chapters', 'ch-0001aa.json'), JSON.stringify({
            chapter_id: 'ch-0001aa',
            scenes: [{
                scene_id: 's1', participants: ['mikhail_berlioz', 'ivan_ponyrev'],
                units: [
                    { id: 'u1', image: { prompt: 'mikhail_berlioz and ivan_ponyrev on a bench' }, video: { action: 'mikhail_berlioz turns to ivan_ponyrev' } },
                    { id: 'u2', image: { prompt: 'zhenshchina_v_budochke at the kiosk' }, video: { action: 'zhenshchina_v_budochke shrugs' } },
                ],
            }],
        }));
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('the cast comes from the hero files, not from characters.json', () => {
        const ctx = audit.loadBook(bookId, root);
        expect([...ctx.charIds].sort()).to.deep.equal(['ivan_ponyrev', 'mikhail_berlioz']);
        expect(ctx.heroIssues.map((i) => i.file)).to.deep.equal(['characters/broken.json']);
    });

    it('findings: an invented id (FAIL), the broken hero file (FAIL), the shared alias (WARN); mentions.json is not read', () => {
        const { unitsSeen, findings } = audit.auditBook(audit.loadBook(bookId, root));
        expect(unitsSeen).to.equal(2);
        const lines = findings.filter((f) => f.level !== 'INFO').map((f) => `${f.level} ${f.where}: ${f.msg}`);
        expect(lines.some((l) => /^FAIL .*zhenshchina_v_budochke/.test(l))).to.equal(true);
        expect(lines.some((l) => l.startsWith('FAIL characters/broken.json: broken hero file (invalid_json)'))).to.equal(true);
        expect(lines).to.include('WARN characters/*.json: ambiguous alias "редактор" — claimed by more than one hero, names nobody');
        expect(lines.join('\n')).to.not.include('mentions.json').and.not.include('invented_target');
    });

    it('a missing book is an error, not a crash of the process', () => {
        expect(() => audit.loadBook('nope', root)).to.throw().with.property('code', 'not_found');
    });
});
