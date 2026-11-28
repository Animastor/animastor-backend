const { expect } = require('chai');
const book = require('../src/book');

const TEST_BOOK_ID = 'test-book-phaseB-sync';

function buildBook({ bookId, chapters }) {
    return {
        manifest: { book_id: bookId, vbook_version: 4 },
        book: { book_id: bookId, title: bookId, structure: { chapters_order: [] } },
        bible: { version: '3.0' },
        heroes: [],
        chapters,
    };
}

describe('Book Sync (Phase B.3)', () => {
    let bookSync;
    // a ready audio asset (formerly services/scene-asset-registry, removed
    // 2026-11-28 with the legacy orchestration) — the same PG row shape
    const sceneAssetRegistry = {
        registerSceneAudio: (bookId, chapterId, sceneId, { canonicalPath, duration, buildId }) =>
            require('../src/storage/postgres/repositories/scene-assets-repo').upsertAsset({
                book_id: bookId, chapter_id: chapterId, scene_id: sceneId, asset_type: 'audio',
                path: canonicalPath, duration_sec: duration, format: 'mp3', sample_rate: 24000, channel_count: 1,
                chunks: null, status: 'ready', build_id: buildId,
            }),
        getAudioAsset: (bookId, chapterId, sceneId) =>
            require('../src/storage/postgres/repositories/scene-assets-repo').getAsset(bookId, chapterId, sceneId, 'audio'),
    };
    const query = () => require('../src/storage/postgres/database').query;

    before(async () => {
        const postgres = require('../src/storage/postgres');
        await postgres.initialize();
        bookSync = require('../src/services/book-sync');
        book.resetBook(TEST_BOOK_ID);
    });

    afterEach(async () => {
        await query()(`DELETE FROM scene_assets WHERE book_id = $1`, [TEST_BOOK_ID]);
        await query()(`DELETE FROM image_units WHERE book_id = $1`, [TEST_BOOK_ID]);
        await query()(`DELETE FROM scenes WHERE book_id = $1`, [TEST_BOOK_ID]);
        book.resetBook(TEST_BOOK_ID);
    });

    function saveFixture(chapters) {
        book.resetBook(TEST_BOOK_ID);
        book.saveBookBundle(buildBook({ bookId: TEST_BOOK_ID, chapters }), null);
    }

    it('detectChangedScenes reports added when first seen', async () => {
        saveFixture([{ chapter_id: 'ch-1', scenes: [{ scene_id: 'sc-1' }] }]);
        const diff = await bookSync.detectChangedScenes(TEST_BOOK_ID);
        expect(diff.added).to.have.length(1);
        expect(diff.changed).to.have.length(0);
        expect(diff.removed).to.have.length(0);
    });

    it('detectChangedScenes reports changed when hash drifts', async () => {
        saveFixture([{ chapter_id: 'ch-1', scenes: [{ scene_id: 'sc-1', text: 'a' }] }]);
        await bookSync.syncBook(TEST_BOOK_ID);

        saveFixture([{ chapter_id: 'ch-1', scenes: [{ scene_id: 'sc-1', text: 'b' }] }]);
        const diff = await bookSync.detectChangedScenes(TEST_BOOK_ID);
        expect(diff.added).to.have.length(0);
        expect(diff.changed).to.have.length(1);
        expect(diff.changed[0].old_hash).to.not.equal(diff.changed[0].new_hash);
    });

    it('detectChangedScenes reports removed when scene deleted from JSON', async () => {
        saveFixture([{ chapter_id: 'ch-1', scenes: [{ scene_id: 'sc-1' }, { scene_id: 'sc-2' }] }]);
        await bookSync.syncBook(TEST_BOOK_ID);

        saveFixture([{ chapter_id: 'ch-1', scenes: [{ scene_id: 'sc-1' }] }]);
        const diff = await bookSync.detectChangedScenes(TEST_BOOK_ID);
        expect(diff.removed).to.have.length(1);
        expect(diff.removed[0].chapter_scene).to.equal('ch-1::sc-2');
    });

    it('syncBook persists hashes for new scenes', async () => {
        saveFixture([{ chapter_id: 'ch-1', scenes: [{ scene_id: 'sc-1' }, { scene_id: 'sc-2' }] }]);
        const r = await bookSync.syncBook(TEST_BOOK_ID);
        expect(r.added).to.equal(2);

        const stored = await query()(
            `SELECT scene_id, scene_hash FROM scenes WHERE book_id = $1 ORDER BY scene_id`,
            [TEST_BOOK_ID]
        );
        expect(stored.rows).to.have.length(2);
        for (const row of stored.rows) {
            expect(row.scene_hash).to.have.length(64);
        }
    });

    it('syncBook marks assets stale for changed scenes', async () => {
        saveFixture([{ chapter_id: 'ch-1', scenes: [{ scene_id: 'sc-1', text: 'a' }] }]);
        await bookSync.syncBook(TEST_BOOK_ID);
        await sceneAssetRegistry.registerSceneAudio(TEST_BOOK_ID, 'ch-1', 'sc-1', {
            canonicalPath: '/tmp/x.mp3', duration: 1, buildId: 'b1',
        });

        saveFixture([{ chapter_id: 'ch-1', scenes: [{ scene_id: 'sc-1', text: 'b' }] }]);

        const r = await bookSync.syncBook(TEST_BOOK_ID);
        expect(r.changed).to.equal(1);
        expect(r.assets_marked_stale).to.equal(1);

        const after = await sceneAssetRegistry.getAudioAsset(TEST_BOOK_ID, 'ch-1', 'sc-1');
        expect(after.status).to.equal('stale');
    });

    // (2026-11-28: «syncBook cancels running generation_tasks» and
    // «reconcileFromDiff cancels only task types invalidated by the diff» went
    // with the legacy generation_tasks registry; the field stays 0.)
    it('syncBook / reconcileFromDiff report generation_tasks_cancelled = 0 (contract field kept)', async () => {
        saveFixture([{ chapter_id: 'ch-1', scenes: [{ scene_id: 'sc-1', text: 'a' }] }]);
        await bookSync.syncBook(TEST_BOOK_ID);
        saveFixture([{ chapter_id: 'ch-1', scenes: [{ scene_id: 'sc-1', text: 'b' }] }]);
        const r = await bookSync.syncBook(TEST_BOOK_ID);
        expect(r.changed).to.equal(1);
        expect(r.generation_tasks_cancelled).to.equal(0);
        const result = await bookSync.reconcileFromDiff(TEST_BOOK_ID, [{
            chapter_id: 'ch-1', scene_id: 'sc-1', reason: 'changed', dirty_layers: ['image'],
        }], book.loadBook(TEST_BOOK_ID));
        expect(result.generation_tasks_cancelled).to.equal(0);
    });

    it('syncBook purges DB rows for scenes removed from JSON', async () => {
        saveFixture([{ chapter_id: 'ch-1', scenes: [{ scene_id: 'sc-1' }, { scene_id: 'sc-2' }] }]);
        await bookSync.syncBook(TEST_BOOK_ID);
        await sceneAssetRegistry.registerSceneAudio(TEST_BOOK_ID, 'ch-1', 'sc-2', {
            canonicalPath: '/tmp/y.mp3', duration: 1, buildId: 'b1',
        });

        saveFixture([{ chapter_id: 'ch-1', scenes: [{ scene_id: 'sc-1' }] }]);
        const r = await bookSync.syncBook(TEST_BOOK_ID);
        expect(r.removed).to.equal(1);
        expect(r.purged.scene_assets).to.be.gte(1);
        expect(r.purged).to.not.have.property('generation_tasks');

        const after = await query()(
            `SELECT count(*)::int as c FROM scenes WHERE book_id = $1 AND scene_id = 'sc-2'`,
            [TEST_BOOK_ID]
        );
        expect(after.rows[0].c).to.equal(0);
    });

    it('dryRun reports counts without modifying DB', async () => {
        saveFixture([{ chapter_id: 'ch-1', scenes: [{ scene_id: 'sc-1' }] }]);
        const r = await bookSync.syncBook(TEST_BOOK_ID, { dryRun: true });
        expect(r.dry_run).to.be.true;

        const stored = await query()(
            `SELECT count(*)::int as c FROM scenes WHERE book_id = $1`, [TEST_BOOK_ID]
        );
        expect(stored.rows[0].c).to.equal(0);
    });

    it('purgeRemoved=false keeps removed-scene rows', async () => {
        saveFixture([{ chapter_id: 'ch-1', scenes: [{ scene_id: 'sc-1' }, { scene_id: 'sc-2' }] }]);
        await bookSync.syncBook(TEST_BOOK_ID);
        await sceneAssetRegistry.registerSceneAudio(TEST_BOOK_ID, 'ch-1', 'sc-2', {
            canonicalPath: '/tmp/z.mp3', duration: 1, buildId: 'b1',
        });

        saveFixture([{ chapter_id: 'ch-1', scenes: [{ scene_id: 'sc-1' }] }]);
        const r = await bookSync.syncBook(TEST_BOOK_ID, { purgeRemoved: false });
        expect(r.removed).to.equal(1);
        expect(Object.keys(r.purged).length).to.equal(0);
    });
});
