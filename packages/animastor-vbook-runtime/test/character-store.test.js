// ======================================================
// character-store (VBOOK_FORMAT_V4 §3, §4, приёмка 1.7)
// ======================================================

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    charactersDir,
    characterFile,
    atomicWriteJson,
    listCharacters,
    readCharacter,
    writeCharacter,
    updateCharacter,
    removeCharacter,
} = require('../src/character-store.cjs');

describe('character-store', () => {
    let bookDir;

    beforeEach(() => {
        bookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbook-store-'));
    });

    afterEach(() => {
        fs.rmSync(bookDir, { recursive: true, force: true });
    });

    function hero(id, extra = {}) {
        return { schema: 'animastor.character/1', id, name: id, ...extra };
    }

    it('writes, reads and refuses to escape the characters directory', () => {
        writeCharacter(bookDir, hero('yura'));
        expect(fs.existsSync(path.join(bookDir, 'characters', 'yura.json'))).to.equal(true);
        expect(readCharacter(bookDir, 'yura').name).to.equal('yura');
        expect(readCharacter(bookDir, 'nobody')).to.equal(null);
        expect(() => characterFile(bookDir, '../escape')).to.throw(/invalid hero id/);
        expect(() => characterFile(bookDir, 'Yura')).to.throw(/invalid hero id/);
        expect(() => writeCharacter(bookDir, { id: 'behaviour' })).to.throw(/reserved/);
    });

    it('lists heroes with the narrator first and characters_order as a hint', () => {
        writeCharacter(bookDir, hero('yura'));
        writeCharacter(bookDir, hero('narrator', { role: 'narrator' }));
        writeCharacter(bookDir, hero('anna'));
        const { heroes, issues } = listCharacters(bookDir, { charactersOrder: ['yura'] });
        expect(heroes.map((h) => h.id)).to.deep.equal(['narrator', 'yura', 'anna']);
        expect(issues).to.deep.equal([]);
        expect(listCharacters(path.join(bookDir, 'missing')).heroes).to.deep.equal([]);
    });

    it('reports broken files without losing the healthy ones', () => {
        writeCharacter(bookDir, hero('yura'));
        fs.writeFileSync(path.join(charactersDir(bookDir), 'broken.json'), '{not json');
        fs.writeFileSync(
            path.join(charactersDir(bookDir), 'mismatch.json'),
            JSON.stringify({ schema: 'animastor.character/1', id: 'other' }),
        );
        const { heroes, issues } = listCharacters(bookDir);
        expect(heroes.map((h) => h.id)).to.deep.equal(['yura']);
        expect(issues.map((i) => i.code).sort()).to.deep.equal(['id_mismatch', 'invalid_json']);
        // a broken file neither hides the book nor counts as a hero
        expect(readCharacter(bookDir, 'broken')).to.equal(null);
    });

    it('updates one hero atomically and cannot change its id', () => {
        writeCharacter(bookDir, hero('yura', { notes: 'old' }));
        const next = updateCharacter(bookDir, 'yura', (h) => ({ ...h, notes: 'new' }));
        expect(next.notes).to.equal('new');
        expect(readCharacter(bookDir, 'yura').notes).to.equal('new');
        expect(updateCharacter(bookDir, 'nobody', (h) => h)).to.equal(null);
        expect(() => updateCharacter(bookDir, 'yura', (h) => ({ ...h, id: 'anna' })))
            .to.throw(/cannot change the hero id/);
    });

    it('a crash between temp write and rename keeps the previous file intact', () => {
        writeCharacter(bookDir, hero('yura', { notes: 'good' }));
        const failingIo = {
            mkdirSync: fs.mkdirSync,
            writeFileSync: fs.writeFileSync,
            unlinkSync: fs.unlinkSync,
            renameSync: () => { throw new Error('crash before rename'); },
        };
        expect(() => atomicWriteJson(characterFile(bookDir, 'yura'), hero('yura', { notes: 'bad' }), failingIo))
            .to.throw(/crash before rename/);
        expect(readCharacter(bookDir, 'yura').notes).to.equal('good');
        const leftovers = fs.readdirSync(charactersDir(bookDir)).filter((n) => n.endsWith('.tmp'));
        expect(leftovers).to.deep.equal([]);
    });

    it('simultaneous point writes of hero A and hero B both survive', async () => {
        writeCharacter(bookDir, hero('a'));
        writeCharacter(bookDir, hero('b'));
        await Promise.all([
            Promise.resolve().then(() => updateCharacter(bookDir, 'a', (h) => ({ ...h, notes: 'A' }))),
            Promise.resolve().then(() => updateCharacter(bookDir, 'b', (h) => ({ ...h, notes: 'B' }))),
        ]);
        expect(readCharacter(bookDir, 'a').notes).to.equal('A');
        expect(readCharacter(bookDir, 'b').notes).to.equal('B');
        expect(removeCharacter(bookDir, 'a')).to.equal(true);
        expect(removeCharacter(bookDir, 'a')).to.equal(false);
        expect(readCharacter(bookDir, 'a')).to.equal(null);
    });
});
