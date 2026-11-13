// ======================================================
// character-store (VBOOK_FORMAT_V4 §3, §4, §10; приёмка 1.7 и часть 1.6)
// ======================================================
// Behaviour of the characters/ store as its callers see it: where files land,
// what a broken file does to listing and to writes, and what is left on disk
// after an interrupted write. Every refusal also checks that the directory
// did not change.

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    HeroStoreError,
    charactersDir,
    characterFile,
    atomicWriteFile,
    cleanStaleTempFiles,
    listCharacters,
    inspectCharacter,
    readCharacter,
    writeCharacter,
    updateCharacter,
    removeCharacter,
} = require('../src/character-store.cjs');

function snapshot(root) {
    const out = [];
    (function walk(dir, rel) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            const full = path.join(dir, e.name);
            if (e.isSymbolicLink()) out.push(`${r} -> ${fs.readlinkSync(full)}`);
            else if (e.isDirectory()) { out.push(`${r}/`); walk(full, r); }
            else out.push(`${r} = ${fs.readFileSync(full, 'utf8')}`);
        }
    })(root, '');
    return out.sort().join('\n');
}

function codeOf(fn) {
    try { fn(); } catch (err) { return err.code || err.message; }
    return null;
}

describe('character-store', () => {
    let sandbox;
    let bookDir;

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vbook-store-'));
        bookDir = path.join(sandbox, 'book_1');
        fs.mkdirSync(bookDir);
        fs.writeFileSync(path.join(sandbox, 'outside.json'), '{"keep":true}');
    });

    afterEach(() => {
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    function hero(id, extra = {}) {
        return { schema: 'animastor.character/1', id, name: id, ...extra };
    }
    const narratorHero = (extra = {}) => hero('narrator', { role: 'narrator', ...extra });
    const dir = () => charactersDir(bookDir);

    describe('paths', () => {
        it('a hero lands in characters/<id>.json and nowhere else', () => {
            writeCharacter(bookDir, hero('yura'));
            expect(fs.readdirSync(bookDir)).to.deep.equal(['characters']);
            expect(fs.readdirSync(dir())).to.deep.equal(['yura.json']);
            expect(characterFile(bookDir, 'yura')).to.equal(path.join(bookDir, 'characters', 'yura.json'));
            expect(readCharacter(bookDir, 'yura')).to.deep.equal(hero('yura'));
            expect(readCharacter(bookDir, 'nobody')).to.equal(null);
        });

        const BAD_IDS = ['../escape', '..', '.', '', 'a/b', 'a\\b', '/abs', 'Yura', 'Юра', 'yura.json', 'a b', 'a-b', 'a\u0000b', 'x'.repeat(65), null, undefined, 7];
        for (const id of BAD_IDS) {
            it(`id ${JSON.stringify(id)} is refused by every operation, disk unchanged`, () => {
                writeCharacter(bookDir, hero('yura'));
                const before = snapshot(sandbox);
                expect(codeOf(() => characterFile(bookDir, id))).to.equal('invalid_hero_id');
                expect(codeOf(() => readCharacter(bookDir, id))).to.equal('invalid_hero_id');
                expect(codeOf(() => writeCharacter(bookDir, { schema: 'animastor.character/1', id }))).to.equal('invalid_hero_id');
                expect(codeOf(() => updateCharacter(bookDir, id, (h) => h))).to.equal('invalid_hero_id');
                expect(codeOf(() => removeCharacter(bookDir, id))).to.equal('invalid_hero_id');
                expect(snapshot(sandbox)).to.equal(before);
            });
        }

        it('reserved ids cannot be written', () => {
            for (const id of ['manifest', 'book', 'bible', 'locations', 'voices', 'characters', 'behavior', 'behaviour', 'mentions', 'index']) {
                expect(codeOf(() => writeCharacter(bookDir, hero(id))), id).to.equal('reserved_id');
            }
            expect(fs.existsSync(dir())).to.equal(false);
        });

        it('an invalid hero is refused before anything is written', () => {
            expect(codeOf(() => writeCharacter(bookDir, { id: 'yura' }))).to.equal('invalid_character'); // no schema
            expect(codeOf(() => writeCharacter(bookDir, hero('yura', { role: 'narrator' })))).to.equal('invalid_character');
            expect(codeOf(() => writeCharacter(bookDir, hero('narrator')))).to.equal('invalid_character'); // narrator needs the role
            expect(codeOf(() => writeCharacter(bookDir, hero('yura', {
                voice: { reference: { file: 'voices/anna/ref.wav', sha256: 'a'.repeat(64) } },
            })))).to.equal('invalid_character');
            expect(codeOf(() => writeCharacter(bookDir, 'yura'))).to.equal('invalid_character');
            expect(fs.existsSync(dir())).to.equal(false);
        });

        it('errors are HeroStoreError with a stable code', () => {
            try { writeCharacter(bookDir, hero('book')); } catch (err) {
                expect(err).to.be.instanceOf(HeroStoreError);
                expect(err.code).to.equal('reserved_id');
                return;
            }
            throw new Error('expected a refusal');
        });
    });

    describe('symbolic links are never followed', () => {
        it('a linked hero file is reported, not read, and cannot be written through', () => {
            writeCharacter(bookDir, hero('yura'));
            const outside = path.join(sandbox, 'outside.json');
            fs.writeFileSync(outside, JSON.stringify(hero('anna')));
            fs.symlinkSync(outside, path.join(dir(), 'anna.json'));
            const before = snapshot(sandbox);

            const { heroes, issues } = listCharacters(bookDir);
            expect(heroes.map((h) => h.id)).to.deep.equal(['yura']);
            expect(issues).to.have.length(1);
            expect(issues[0]).to.include({ file: 'characters/anna.json', hero_id: 'anna', code: 'unreadable', blocking: true });

            expect(codeOf(() => readCharacter(bookDir, 'anna'))).to.equal('hero_file_broken');
            expect(codeOf(() => writeCharacter(bookDir, hero('anna', { notes: 'x' })))).to.equal('hero_file_broken');
            expect(codeOf(() => updateCharacter(bookDir, 'anna', (h) => h))).to.equal('hero_file_broken');
            expect(snapshot(sandbox)).to.equal(before);
            expect(JSON.parse(fs.readFileSync(outside, 'utf8'))).to.deep.equal(hero('anna'));
        });

        it('deleting a linked hero file removes the link, never its target', () => {
            const outside = path.join(sandbox, 'outside.json');
            fs.mkdirSync(dir());
            fs.symlinkSync(outside, path.join(dir(), 'anna.json'));
            expect(removeCharacter(bookDir, 'anna', { broken: true })).to.equal(true);
            expect(fs.readdirSync(dir())).to.deep.equal([]);
            expect(fs.readFileSync(outside, 'utf8')).to.equal('{"keep":true}');
        });

        it('a linked characters directory is not used for reading or writing', () => {
            const elsewhere = path.join(sandbox, 'elsewhere');
            fs.mkdirSync(elsewhere);
            fs.writeFileSync(path.join(elsewhere, 'yura.json'), JSON.stringify(hero('yura')));
            fs.symlinkSync(elsewhere, path.join(bookDir, 'characters'));
            const before = snapshot(sandbox);

            const { heroes, issues } = listCharacters(bookDir);
            expect(heroes).to.deep.equal([]);
            expect(issues.map((i) => [i.file, i.code, i.blocking])).to.deep.equal([['characters', 'unreadable', true]]);
            expect(codeOf(() => readCharacter(bookDir, 'yura'))).to.equal('hero_file_broken');
            expect(codeOf(() => writeCharacter(bookDir, hero('anna')))).to.equal('hero_file_broken');
            expect(codeOf(() => removeCharacter(bookDir, 'yura', { broken: true }))).to.equal('hero_file_broken');
            expect(snapshot(sandbox)).to.equal(before);
        });
    });

    describe('listing', () => {
        it('the narrator is first, characters_order is a hint, the rest is alphabetical', () => {
            for (const id of ['yura', 'anna', 'boris', 'zoya']) writeCharacter(bookDir, hero(id));
            writeCharacter(bookDir, narratorHero());
            const { heroes, issues } = listCharacters(bookDir, { charactersOrder: ['zoya', 'ghost', 'yura', 'zoya', 42] });
            expect(heroes.map((h) => h.id)).to.deep.equal(['narrator', 'zoya', 'yura', 'anna', 'boris']);
            expect(issues).to.deep.equal([]);
            expect(listCharacters(path.join(sandbox, 'missing'))).to.deep.equal({ heroes: [], issues: [] });
        });

        it('entries starting with a dot are service files', () => {
            writeCharacter(bookDir, hero('yura'));
            fs.writeFileSync(path.join(dir(), '.yura.json.tmp-1-abc'), '{half');
            fs.mkdirSync(path.join(dir(), '.cache'));
            expect(listCharacters(bookDir)).to.deep.equal({ heroes: [hero('yura')], issues: [] });
        });

        it('every kind of broken file is reported with its ADR code and the healthy heroes stay', () => {
            writeCharacter(bookDir, hero('yura'));
            const put = (name, text) => fs.writeFileSync(path.join(dir(), name), text);
            put('broken.json', '{not json');
            put('mismatch.json', JSON.stringify(hero('other')));
            put('noschema.json', JSON.stringify({ id: 'noschema' }));
            put('Юра.json', JSON.stringify({ schema: 'animastor.character/1', id: 'Юра' }));
            put('Upper.json', JSON.stringify(hero('upper')));
            put('book.json', JSON.stringify(hero('book')));
            put('notes.txt', 'hello');
            fs.mkdirSync(path.join(dir(), 'folder.json'));

            const { heroes, issues } = listCharacters(bookDir);
            expect(heroes.map((h) => h.id)).to.deep.equal(['yura']);
            const byFile = Object.fromEntries(issues.map((i) => [i.file, i]));
            expect(Object.keys(byFile).sort()).to.deep.equal([
                'characters/Upper.json', 'characters/book.json', 'characters/broken.json',
                'characters/folder.json', 'characters/mismatch.json', 'characters/noschema.json',
                'characters/notes.txt', 'characters/Юра.json',
            ]);
            expect(byFile['characters/broken.json']).to.include({ code: 'invalid_json', hero_id: 'broken', blocking: true });
            expect(byFile['characters/mismatch.json']).to.include({ code: 'filename_mismatch', hero_id: 'mismatch', blocking: true });
            expect(byFile['characters/Upper.json']).to.include({ code: 'filename_mismatch', blocking: true });
            expect(byFile['characters/noschema.json']).to.include({ code: 'schema', hero_id: 'noschema', blocking: true });
            expect(byFile['characters/Юра.json']).to.include({ code: 'schema', blocking: true });
            expect(byFile['characters/book.json']).to.include({ code: 'schema', blocking: true });
            expect(byFile['characters/notes.txt']).to.include({ code: 'filename_mismatch', blocking: true });
            expect(byFile['characters/folder.json']).to.include({ code: 'unreadable', blocking: true });
            // a file whose name is not an id has no id to block
            expect(byFile['characters/Юра.json']).to.not.have.property('hero_id');
            expect(byFile['characters/Upper.json']).to.not.have.property('hero_id');
            // server paths never leak into an issue
            for (const i of issues) expect(JSON.stringify(i)).to.not.include(sandbox);
        });

        it('unknown keys are kept and reported as a non-blocking warning', () => {
            const odd = hero('yura', { future_field: { a: 1 }, voice: { timbre: 'low', pitch: 3 } });
            writeCharacter(bookDir, odd);
            const { heroes, issues } = listCharacters(bookDir);
            expect(heroes).to.deep.equal([odd]);
            expect(issues.map((i) => [i.code, i.hero_id, i.blocking, i.message])).to.deep.equal([
                ['unknown_key', 'yura', false, 'voice.pitch: unknown key "pitch"'],
                ['unknown_key', 'yura', false, 'future_field: unknown key "future_field"'],
            ]);
        });
    });

    describe('a broken hero file is never touched (§10.3)', () => {
        beforeEach(() => {
            writeCharacter(bookDir, hero('yura'));
            fs.writeFileSync(path.join(dir(), 'anna.json'), '{not json');
        });

        it('reads report it, writes to its id are refused, the bytes stay', () => {
            const before = snapshot(sandbox);
            expect(inspectCharacter(bookDir, 'anna').state).to.equal('broken');
            expect(inspectCharacter(bookDir, 'yura').state).to.equal('ok');
            expect(inspectCharacter(bookDir, 'nobody').state).to.equal('absent');
            expect(codeOf(() => readCharacter(bookDir, 'anna'))).to.equal('hero_file_broken');
            expect(codeOf(() => writeCharacter(bookDir, hero('anna')))).to.equal('hero_file_broken');
            expect(codeOf(() => updateCharacter(bookDir, 'anna', (h) => ({ ...h, notes: 'x' })))).to.equal('hero_file_broken');
            expect(codeOf(() => removeCharacter(bookDir, 'anna'))).to.equal('hero_file_broken');
            expect(snapshot(sandbox)).to.equal(before);
        });

        it('the refusal names the hero and the reason', () => {
            try { writeCharacter(bookDir, hero('anna')); } catch (err) {
                expect(err.details.hero_id).to.equal('anna');
                expect(err.details.issue).to.include({ file: 'characters/anna.json', code: 'invalid_json' });
                return;
            }
            throw new Error('expected a refusal');
        });

        it('other heroes stay writable, and the broken file leaves only by an explicit delete', () => {
            updateCharacter(bookDir, 'yura', (h) => ({ ...h, notes: 'still fine' }));
            expect(readCharacter(bookDir, 'yura').notes).to.equal('still fine');
            expect(fs.readFileSync(path.join(dir(), 'anna.json'), 'utf8')).to.equal('{not json');
            expect(removeCharacter(bookDir, 'anna', { broken: true })).to.equal(true);
            writeCharacter(bookDir, hero('anna'));
            expect(readCharacter(bookDir, 'anna')).to.deep.equal(hero('anna'));
        });
    });

    describe('point update', () => {
        it('reads, mutates, validates and stores; the id cannot change', () => {
            writeCharacter(bookDir, hero('yura', { notes: 'old' }));
            expect(updateCharacter(bookDir, 'yura', (h) => ({ ...h, notes: 'new' })).notes).to.equal('new');
            expect(readCharacter(bookDir, 'yura').notes).to.equal('new');
            // in-place mutation of the private copy is a valid way to answer
            updateCharacter(bookDir, 'yura', (h) => { h.notes = 'in place'; });
            expect(readCharacter(bookDir, 'yura').notes).to.equal('in place');
            expect(updateCharacter(bookDir, 'nobody', (h) => h)).to.equal(null);

            const before = snapshot(sandbox);
            expect(codeOf(() => updateCharacter(bookDir, 'yura', (h) => ({ ...h, id: 'anna' })))).to.equal('invalid_character');
            expect(codeOf(() => updateCharacter(bookDir, 'yura', (h) => ({ ...h, name: 42 })))).to.equal('invalid_character');
            expect(codeOf(() => updateCharacter(bookDir, 'yura', () => null))).to.equal('invalid_character');
            expect(snapshot(sandbox)).to.equal(before);
        });

        it('a mutator that throws leaves the stored hero as it was', () => {
            writeCharacter(bookDir, hero('yura', { notes: 'kept' }));
            const before = snapshot(sandbox);
            expect(() => updateCharacter(bookDir, 'yura', (h) => { h.notes = 'lost'; throw new Error('boom'); })).to.throw('boom');
            expect(snapshot(sandbox)).to.equal(before);
        });

        it('unknown keys survive a read-modify-write', () => {
            writeCharacter(bookDir, hero('yura', { future_field: { a: [1, 2] }, voice: { timbre: 'low', timbre_source: 'analysis' } }));
            updateCharacter(bookDir, 'yura', (h) => ({ ...h, notes: 'n' }));
            const stored = readCharacter(bookDir, 'yura');
            expect(stored.future_field).to.deep.equal({ a: [1, 2] });
            expect(stored.voice.timbre_source).to.equal('analysis');
        });
    });

    describe('acceptance 1.7 — atomic and independent writes', () => {
        it('1.7 simultaneous point writes of hero A and hero B are both stored', () => {
            writeCharacter(bookDir, hero('a', { notes: 'a0' }));
            writeCharacter(bookDir, hero('b', { notes: 'b0' }));
            // The editor and an analysis window each hold a stale copy of the
            // other hero and interleave: A is read, then B is read AND written
            // while A's update is still open, then A is written.
            let seenB;
            updateCharacter(bookDir, 'a', (a) => {
                updateCharacter(bookDir, 'b', (b) => ({ ...b, notes: 'B' }));
                seenB = readCharacter(bookDir, 'b').notes;
                return { ...a, notes: 'A' };
            });
            expect(seenB).to.equal('B');
            expect(readCharacter(bookDir, 'a')).to.deep.equal(hero('a', { notes: 'A' }));
            expect(readCharacter(bookDir, 'b')).to.deep.equal(hero('b', { notes: 'B' }));
            expect(fs.readdirSync(dir()).sort()).to.deep.equal(['a.json', 'b.json']);
        });

        it('1.7 many heroes updated in one tick: every write lands in its own file', async () => {
            const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
            for (const id of ids) writeCharacter(bookDir, hero(id, { notes: '0' }));
            await Promise.all(ids.map((id, i) => new Promise((resolve) => {
                setImmediate(() => { updateCharacter(bookDir, id, (h) => ({ ...h, notes: `n${i}` })); resolve(); });
            })));
            expect(ids.map((id) => readCharacter(bookDir, id).notes)).to.deep.equal(['n0', 'n1', 'n2', 'n3', 'n4', 'n5']);
            expect(fs.readdirSync(dir()).sort()).to.deep.equal(ids.map((id) => `${id}.json`));
        });

        for (const step of ['renameSync', 'fsyncSync', 'writeFileSync']) {
            it(`1.7 an interrupted write (${step} fails) keeps the previous file and leaves no temp file`, () => {
                writeCharacter(bookDir, hero('yura', { notes: 'good' }));
                const before = snapshot(sandbox);
                const failingIo = { ...fs, [step]: () => { throw new Error(`crash in ${step}`); } };
                expect(() => writeCharacter(bookDir, hero('yura', { notes: 'bad' }), failingIo)).to.throw(`crash in ${step}`);
                expect(() => updateCharacter(bookDir, 'yura', (h) => ({ ...h, notes: 'bad' }), failingIo)).to.throw(`crash in ${step}`);
                expect(snapshot(sandbox)).to.equal(before);
                expect(readCharacter(bookDir, 'yura').notes).to.equal('good');
            });
        }

        it('1.7 an interrupted first write leaves no hero and no temp file', () => {
            const failingIo = { ...fs, renameSync: () => { throw new Error('crash before rename'); } };
            expect(() => writeCharacter(bookDir, hero('yura'), failingIo)).to.throw('crash before rename');
            expect(fs.readdirSync(dir())).to.deep.equal([]);
            expect(readCharacter(bookDir, 'yura')).to.equal(null);
        });

        it('the temp file is created next to the target, so the rename never crosses a filesystem', () => {
            const opened = [];
            const spyIo = { ...fs, openSync: (p, ...rest) => { opened.push(p); return fs.openSync(p, ...rest); } };
            writeCharacter(bookDir, hero('yura'), spyIo);
            expect(path.dirname(opened[0])).to.equal(dir());
            expect(path.basename(opened[0])).to.match(/^\.yura\.json\.tmp-\d+-[0-9a-f]+$/);
            expect(fs.readdirSync(dir())).to.deep.equal(['yura.json']);
        });

        it('a write does not follow a link planted at the target', () => {
            const outside = path.join(sandbox, 'outside.json');
            const target = path.join(sandbox, 'plain.json');
            fs.symlinkSync(outside, target);
            expect(codeOf(() => atomicWriteFile(target, '{}'))).to.equal('path_is_link');
            expect(fs.readFileSync(outside, 'utf8')).to.equal('{"keep":true}');
        });

        it('temp files older than an hour are cleaned up, fresh ones and hero files are not', () => {
            writeCharacter(bookDir, hero('yura'));
            const stale = path.join(dir(), '.yura.json.tmp-1-aaaa');
            const fresh = path.join(dir(), '.anna.json.tmp-1-bbbb');
            fs.writeFileSync(stale, '{');
            fs.writeFileSync(fresh, '{');
            const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
            fs.utimesSync(stale, twoHoursAgo, twoHoursAgo);
            expect(cleanStaleTempFiles(dir())).to.equal(1);
            expect(fs.readdirSync(dir()).sort()).to.deep.equal(['.anna.json.tmp-1-bbbb', 'yura.json']);
            expect(cleanStaleTempFiles(path.join(sandbox, 'missing'))).to.equal(0);
        });
    });

    describe('delete', () => {
        it('removes a hero file; a second delete is a no-op', () => {
            writeCharacter(bookDir, hero('yura'));
            expect(removeCharacter(bookDir, 'yura')).to.equal(true);
            expect(removeCharacter(bookDir, 'yura')).to.equal(false);
            expect(readCharacter(bookDir, 'yura')).to.equal(null);
        });

        it('the narrator cannot be deleted', () => {
            writeCharacter(bookDir, narratorHero({ voice: { timbre: 'deep' } }));
            const before = snapshot(sandbox);
            expect(codeOf(() => removeCharacter(bookDir, 'narrator'))).to.equal('narrator_required');
            expect(codeOf(() => removeCharacter(bookDir, 'narrator', { broken: true }))).to.equal('narrator_required');
            expect(snapshot(sandbox)).to.equal(before);
        });

        it('a broken narrator.json can be deleted explicitly, so it can be created again', () => {
            fs.mkdirSync(dir());
            fs.writeFileSync(path.join(dir(), 'narrator.json'), '{oops');
            expect(codeOf(() => removeCharacter(bookDir, 'narrator'))).to.equal('hero_file_broken');
            expect(removeCharacter(bookDir, 'narrator', { broken: true })).to.equal(true);
            writeCharacter(bookDir, narratorHero());
            expect(readCharacter(bookDir, 'narrator').role).to.equal('narrator');
        });
    });
});
