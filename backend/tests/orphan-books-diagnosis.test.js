// ======================================================
// Stage 52 — orphan books / assets diagnosis (read-only audit)
// ======================================================
// Regression net for the production drift:
//   `import_1786345731767_1786345734345` has 427 scene_assets / 17 tasks /
//   26 image_units + a canonical bundle on disk, but ZERO `scenes` rows →
//   listBooks (`SELECT DISTINCT book_id FROM scenes`) hides it from C8/recovery.
//
// Covers:
//   1. Class I   — derived rows without scenes rows (invisible book)
//   2. recovery  — ensureSceneRow materializes the row, book becomes visible
//   3. Class II  — scenes rows whose books row is gone (mirror drift)
//   4. Class III — disk bundle registered nowhere in PG (temp booksDir)
//   5. Class IV  — historical scene_assets rows with build_id IS NULL
//                  (the unique key cannot deduplicate them — PostgreSQL
//                  treats NULLs as distinct). New duplicates are no longer
//                  minted by markReady/upsert (stage 66), but rows written
//                  before the fix must stay visible to the audit.
//   6. fail-open — /regenerate materializes scenes rows and survives a
//                  failing repo (route-level, generation-routes.test.js)

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_BOOK_ID = 'test-orphan-audit-invisible';
const TEST_GHOST_ID = 'test-orphan-audit-ghost';
const TEST_DUP_ID = 'test-orphan-audit-nullbuild';

describe('Orphan-books audit (stage 52)', () => {
    let audit;
    const query = () => require('../src/storage/postgres/database').query;
    const runAudit = (extra = {}) => audit.collectOrphanReport({
        booksDir: '/nonexistent-books-dir',
        query: query(),
        ...extra,
    });

    before(async () => {
        const postgres = require('../src/storage/postgres');
        await postgres.initialize();
        audit = require('../src/services/orphan-books-audit');
    });

    afterEach(async () => {
        for (const id of [TEST_BOOK_ID, TEST_GHOST_ID, TEST_DUP_ID]) {
            await query()('DELETE FROM scenes WHERE book_id = $1', [id]);
            await query()('DELETE FROM scene_assets WHERE book_id = $1', [id]);
            await query()('DELETE FROM generation_tasks WHERE book_id = $1', [id]);
            await query()('DELETE FROM image_units WHERE book_id = $1', [id]);
            await query()('DELETE FROM books WHERE book_id = $1', [id]);
        }
    });

    async function insertAsset(bookId, { buildId = 'build-audit', status = 'ready' } = {}) {
        await query()(`
            INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, path, build_id, status)
            VALUES ($1, 'ch-audit', 'sc-audit', 'audio', '/tmp/audit.mp3', $2, $3)
        `, [bookId, buildId, status]);
    }

    async function listBooksLike() {
        const r = await query()('SELECT DISTINCT book_id FROM scenes');
        return r.rows.map(row => row.book_id);
    }

    it('Class I: flags a book with asset rows but no scenes rows (invisible to listBooks)', async () => {
        await query()(`
            INSERT INTO books (book_id, title) VALUES ($1, 'orphan-invisible')
            ON CONFLICT (book_id) DO NOTHING
        `, [TEST_BOOK_ID]);
        await insertAsset(TEST_BOOK_ID);
        await query()(`
            INSERT INTO generation_tasks (task_id, book_id, chapter_id, scene_id, task_type, status)
            VALUES ('task-orphan-audit', $1, 'ch-audit', 'sc-audit', 'audio', 'queued')
        `, [TEST_BOOK_ID]);

        const report = await runAudit();
        const hit = report.booksWithoutScenes.find(b => b.book_id === TEST_BOOK_ID);

        expect(hit, 'invisible book must be reported').to.exist;
        expect(hit.assets).to.be.greaterThan(0);
        expect(hit.tasks).to.equal(1);
        expect(hit.in_books).to.equal(true);

        const visible = await listBooksLike();
        expect(visible).to.not.include(TEST_BOOK_ID);
    });

    it('recovery primitive: ensureSceneRow clears the finding and makes the book visible', async () => {
        await query()(`
            INSERT INTO books (book_id, title) VALUES ($1, 'orphan-invisible')
            ON CONFLICT (book_id) DO NOTHING
        `, [TEST_BOOK_ID]);
        await insertAsset(TEST_BOOK_ID);

        let report = await runAudit();
        expect(report.booksWithoutScenes.map(b => b.book_id)).to.include(TEST_BOOK_ID);

        const sceneAssetsRepo = require('../src/storage/postgres/repositories/scene-assets-repo');
        await sceneAssetsRepo.ensureSceneRow(TEST_BOOK_ID, 'ch-audit', 'sc-audit');
        // idempotent — second call must not throw / duplicate
        await sceneAssetsRepo.ensureSceneRow(TEST_BOOK_ID, 'ch-audit', 'sc-audit');

        report = await runAudit();
        expect(report.booksWithoutScenes.map(b => b.book_id)).to.not.include(TEST_BOOK_ID);

        const visible = await listBooksLike();
        expect(visible).to.include(TEST_BOOK_ID);

        const rows = await query()(
            'SELECT COUNT(*)::int AS n FROM scenes WHERE book_id = $1', [TEST_BOOK_ID]);
        expect(rows.rows[0].n).to.equal(1);

        // READY assets are preserved: materialization only touches `scenes`
        const assets = await query()(
            `SELECT asset_type, status, path FROM scene_assets
             WHERE book_id = $1 ORDER BY asset_type`, [TEST_BOOK_ID]);
        expect(assets.rows).to.deep.equal([
            { asset_type: 'audio', status: 'ready', path: '/tmp/audit.mp3' },
        ]);
    });

    it('Class II: flags scenes rows whose books row is gone (mirror drift)', async () => {
        await query()(`
            INSERT INTO scenes (book_id, chapter_id, scene_id) VALUES ($1, 'ch-audit', 'sc-audit')
        `, [TEST_GHOST_ID]);

        const report = await runAudit();
        const hit = report.scenesWithoutBooks.find(b => b.book_id === TEST_GHOST_ID);

        expect(hit, 'ghost scenes must be reported').to.exist;
        expect(hit.scenes).to.equal(1);
        expect(hit.on_disk).to.equal(false);

        // once the books row exists the class II finding disappears
        await query()(`
            INSERT INTO books (book_id, title) VALUES ($1, 'ghost-owner')
            ON CONFLICT (book_id) DO NOTHING
        `, [TEST_GHOST_ID]);
        const after = await runAudit();
        expect(after.scenesWithoutBooks.map(b => b.book_id)).to.not.include(TEST_GHOST_ID);
        expect(after.booksWithoutScenes.map(b => b.book_id)).to.not.include(TEST_GHOST_ID);
    });

    it('Class III: flags a disk bundle registered nowhere in PG (isolated booksDir)', async () => {
        const tmpBooksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-audit-books-'));
        try {
            fs.mkdirSync(path.join(tmpBooksDir, TEST_BOOK_ID), { recursive: true });
            fs.writeFileSync(
                path.join(tmpBooksDir, TEST_BOOK_ID, 'manifest.json'),
                JSON.stringify({ book_id: TEST_BOOK_ID, state: 'BOOTSTRAPPED' })
            );

            const report = await runAudit({ booksDir: tmpBooksDir });
            expect(report.diskBooksWithoutScenes.map(b => b.book_id))
                .to.include(TEST_BOOK_ID);
            // disjoint from Class I (registered books are reported there instead)
            expect(report.booksWithoutScenes.map(b => b.book_id))
                .to.not.include(TEST_BOOK_ID);
        } finally {
            fs.rmSync(tmpBooksDir, { recursive: true, force: true });
        }
    });

    it('Class IV: historical NULL build_id duplicates are still detected and reported', async () => {
        const repo = require('../src/storage/postgres/repositories/scene-assets-repo');
        const asset = (buildId) => ({
            book_id: TEST_DUP_ID, chapter_id: 'ch-audit', scene_id: 'sc-audit',
            asset_type: 'audio', path: '/tmp/dup.mp3', build_id: buildId, status: 'ready',
        });

        await repo.upsertAsset(asset(null));
        await repo.upsertAsset(asset(null));
        await query()(`
            INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, path, build_id, status, updated_at)
            VALUES ($1, 'ch-audit', 'sc-audit', 'audio', '/tmp/dup.mp3', NULL, 'ready', 1700000000)
        `, [TEST_DUP_ID]);
        await repo.upsertAsset(asset('build-real'));

        const rows = await query()(
            'SELECT build_id FROM scene_assets WHERE book_id = $1 ORDER BY build_id NULLS FIRST',
            [TEST_DUP_ID]);
        expect(rows.rows.map(r => r.build_id)).to.deep.equal([null, null, 'build-real']);

        const report = await runAudit();
        const dup = report.nullBuildDuplicates.find(d => d.book_id === TEST_DUP_ID);
        expect(dup, 'NULL build_id duplicate key must be reported').to.exist;
        expect(dup.rows).to.equal(2);
        expect(dup.asset_type).to.equal('audio');

        expect(report.stats.null_build_redundant_rows).to.be.greaterThan(0);
        expect(audit.countIssues(report)).to.equal(
            report.booksWithoutScenes.length
            + report.scenesWithoutBooks.length
            + report.diskBooksWithoutScenes.length
            + report.nullBuildDuplicates.length
        );
    });

    it('report is computed read-only (SELECT-only statements)', async () => {
        const database = require('../src/storage/postgres/database');
        const statements = [];
        const recorder = async (text, params) => {
            statements.push(String(text).trim());
            return database.query(text, params);
        };

        const report = await audit.collectOrphanReport({
            booksDir: '/nonexistent-books-dir',
            query: recorder,
        });

        expect(report.stats).to.be.an('object');
        expect(statements.length, 'audit must query every source of truth').to.be.greaterThanOrEqual(7);
        const writable = statements.filter(s => /^(insert|update|delete|alter|create|drop|truncate|grant)\b/i.test(s));
        expect(writable, `read-only audit issued: ${writable.join(' | ')}`).to.have.length(0);
        expect(statements.every(s => /^select\b/i.test(s))).to.equal(true);
    });
});
