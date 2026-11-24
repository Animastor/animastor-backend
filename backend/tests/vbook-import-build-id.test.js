// ======================================================
// .vbook import — the archive's build id must not be another book's (post171)
// ======================================================
// OUTPUT_DIR/<build_id>/ (voices/ included) is per build id. An archive whose
// manifest.build_id another book already names — on disk (its manifest) or in
// PG (any table with build_id) — gets a fresh build id written into the
// imported manifest; so does an archive WITHOUT a build id (no shared
// OUTPUT_DIR/default/). A re-import of the same book (wasExisting) keeps its
// id; an archive with a free build id keeps it.
// Real book module over a temp BOOKS_DIR, the production owner check
// (services/build-id-owners.cjs) with a fake PG owner lookup.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

require('./vbook-test-bindings.cjs');
const bookModule = require('../src/book/index');
const config = require('../src/config/runtime-config');
const { createVbookImporter } = require('../src/services/vbook-import.cjs');
const { buildIdsOfOtherBooks } = require('../src/services/build-id-owners.cjs');

const ORIG_BOOKS_DIR = config.BOOKS_DIR;
const CH = 'ch-2a7fee78';

function archive(bookId, buildId) {
    const files = {
        'manifest.json': { vbook_version: 4, book_id: bookId, ...(buildId ? { build_id: buildId } : {}) },
        'book.json': { book_id: bookId, title: bookId, structure: { chapters_order: [`${CH}.json`] } },
        'behaviour.json': { schema: 'animastor.behaviour-globals/1', defaults: { max_per_scene: 2 }, rules: [] },
        'characters/narrator.json': { schema: 'animastor.character/1', id: 'narrator', role: 'narrator', voice: { timbre: 'Deep.' } },
        [`chapters/${CH}.json`]: { chapter_id: CH, scenes: [] },
    };
    const zip = new AdmZip();
    for (const [name, obj] of Object.entries(files)) zip.addFile(name, Buffer.from(JSON.stringify(obj), 'utf8'));
    return zip.toBuffer();
}

describe('.vbook import — build id owned by another book (post171)', () => {
    let tmpDir;
    let pgRows; // [{ book_id, build_id }] — what the fake PG "has"

    // book-repo.buildIdsNamedByOtherBooks stand-in: the PG rows of OTHER books
    const pgOwners = async (ids, bookId) => new Set(pgRows.filter((r) => ids.includes(r.build_id) && r.book_id !== bookId).map((r) => r.build_id));

    function importer() {
        return createVbookImporter({
            book: bookModule,
            importBookAllowed: async () => ({ allowed: true }),
            buildIdsOfOtherBooks: (bookId, candidates) => buildIdsOfOtherBooks({ pgOwners, booksDir: config.BOOKS_DIR }, bookId, candidates),
            log: () => {},
        });
    }
    const req = { headers: {} };
    const manifestBuildId = (bookId) => JSON.parse(fs.readFileSync(path.join(tmpDir, bookId, 'manifest.json'), 'utf8')).build_id;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbook-build-id-'));
        config.BOOKS_DIR = tmpDir;
        pgRows = [];
    });
    afterEach(() => {
        config.BOOKS_DIR = ORIG_BOOKS_DIR;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('an archive whose build id another book has on disk gets a fresh one, written into its manifest', async () => {
        const first = await importer().importVbookArchive(req, archive('imp_owner', 'manual_shared'));
        expect(first.ok).to.equal(true);
        expect(first.buildId).to.equal('manual_shared');

        const second = await importer().importVbookArchive(req, archive('imp_copy', 'manual_shared'));
        expect(second.ok).to.equal(true);
        expect(second.wasExisting).to.equal(false);
        expect(second.buildId).to.match(/^vbook_[0-9a-f-]{36}$/);
        expect(manifestBuildId('imp_copy')).to.equal(second.buildId);
        expect(manifestBuildId('imp_owner')).to.equal('manual_shared'); // the owner is untouched
    });

    it('a build id another book names only in PG is taken too', async () => {
        pgRows = [{ book_id: 'someone_else', build_id: 'manual_pg' }];
        const r = await importer().importVbookArchive(req, archive('imp_pg', 'manual_pg'));
        expect(r.ok).to.equal(true);
        expect(r.buildId).to.not.equal('manual_pg');
        expect(manifestBuildId('imp_pg')).to.equal(r.buildId);
    });

    it('a re-import of the same book keeps its build id (wasExisting), even if another book names it', async () => {
        const first = await importer().importVbookArchive(req, archive('imp_same', 'manual_same'));
        expect(first.buildId).to.equal('manual_same');
        pgRows = [{ book_id: 'someone_else', build_id: 'manual_same' }];
        const again = await importer().importVbookArchive(req, archive('imp_same', 'manual_same'));
        expect(again.ok).to.equal(true);
        expect(again.wasExisting).to.equal(true);
        expect(again.buildId).to.equal('manual_same');
        expect(manifestBuildId('imp_same')).to.equal('manual_same');
    });

    it('a free build id is kept', async () => {
        const free = await importer().importVbookArchive(req, archive('imp_free', 'manual_free'));
        expect(free.buildId).to.equal('manual_free');
        expect(manifestBuildId('imp_free')).to.equal('manual_free');
    });

    it('an archive without a build id gets vbook_<uuid>, written into its manifest (not the shared default)', async () => {
        const none = await importer().importVbookArchive(req, archive('imp_none', null));
        expect(none.ok).to.equal(true);
        expect(none.buildId).to.match(/^vbook_[0-9a-f-]{36}$/);
        expect(manifestBuildId('imp_none')).to.equal(none.buildId);
    });

    it('a re-import of a book that has no build id on disk keeps it as it is (wasExisting)', async () => {
        // the book as an older import left it: a manifest without build_id
        bookModule.saveBookBundle(bookModule.buildBookFromBundle(bookModule.extractBookBundle(archive('imp_old', null), { log: () => {} })));
        expect(manifestBuildId('imp_old')).to.equal(undefined);
        const again = await importer().importVbookArchive(req, archive('imp_old', null));
        expect(again.wasExisting).to.equal(true);
        expect(again.buildId).to.equal('default');
        expect(manifestBuildId('imp_old')).to.equal(undefined);
    });
});

describe('book-repo.buildIdsNamedByOtherBooks (test PG)', () => {
    const { query } = require('../src/storage/postgres/database');
    const { buildIdsNamedByOtherBooks } = require('../src/storage/postgres/repositories/book-repo');
    const stamp = Date.now();
    const MINE = `bid_mine_${stamp}`;
    const OTHER = `bid_other_${stamp}`;
    const cleanup = () => query('DELETE FROM image_units WHERE book_id = ANY($1::text[])', [[MINE, OTHER]]);

    before(async () => {
        await cleanup();
        await query(`INSERT INTO image_units (book_id, build_id, chapter_id, scene_id, unit_id) VALUES
            ($1, $3, 'ch-1', 'sc-1', 'iu-bid00001'), ($2, $4, 'ch-1', 'sc-1', 'iu-bid00002')`,
        [MINE, OTHER, `b_mine_${stamp}`, `b_other_${stamp}`]);
    });
    after(cleanup);

    it('names only the build ids another book has; the asking book\'s own rows do not count', async () => {
        const taken = await buildIdsNamedByOtherBooks([`b_mine_${stamp}`, `b_other_${stamp}`, `b_free_${stamp}`], MINE);
        expect([...taken]).to.deep.equal([`b_other_${stamp}`]);
    });
});
