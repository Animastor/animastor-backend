// ======================================================
// Stage 66 — build_id provenance + NULL-key idempotency
// ======================================================
// Regression net for the production duplicate families in scene_assets
// (rows 25096/25097/25098/25100 and the 409-image / 12-audio NULL rows):
// the unique key (book_id, chapter_id, scene_id, asset_type, build_id)
// cannot deduplicate build_id IS NULL rows, so every repeated markReady /
// synthetic upsert inserted a NEW row.
//
// Guards:
//   1. markReady stamps build_id from the artifact path
//      (<OUTPUT_DIR>/<build_id>/<file> — the handlers build every
//      artifact path from the build directory, so the link is proven)
//   2. repeated + concurrent markReady (stamped and legacy-NULL) stay
//      single-row idempotent
//   3. different builds are never merged; legacy NULL rows are never
//      deleted or re-bound by a stamped write
//   4. image_units always carries a real build_id (column is NOT NULL,
//      the repo rejects a missing one) and its upsert is idempotent
//   5. the other NULL-inserting writers (stampSceneVersionsForDispatch,
//      book-sync.markSceneAssetsStale synthetic row) stop minting rows

const { expect } = require('chai');

const SCENE_BOOK = 'test-stage66-markready';
const IU_BOOK = 'test-stage66-image-units';
const CHAPTER = 'ch-stage66';
const SCENE = 'sc-stage66';

describe('Stage 66: scene_assets/image_units build_id + NULL-key idempotency', () => {
    let repo;
    let iuRepo;
    let bookSync;
    const config = () => require('../src/config/runtime-config');
    const query = () => require('../src/storage/postgres/database').query;

    const assetPath = (buildId, file = 'scene.mp3') =>
        `${config().OUTPUT_DIR}/${buildId}/${SCENE_BOOK}_${CHAPTER}_${SCENE}_${file}`;

    async function rowsFor(bookId) {
        const r = await query()(
            `SELECT id, book_id, chapter_id, scene_id, asset_type, path, build_id, status, updated_at
             FROM scene_assets WHERE book_id = $1 ORDER BY id`,
            [bookId]
        );
        return r.rows;
    }

    before(async () => {
        const postgres = require('../src/storage/postgres');
        await postgres.initialize();
        repo = require('../src/storage/postgres/repositories/scene-assets-repo');
        iuRepo = require('../src/storage/postgres/repositories/iu-repo');
        bookSync = require('../src/services/book-sync');
    });

    afterEach(async () => {
        for (const bookId of [SCENE_BOOK, IU_BOOK]) {
            await query()('DELETE FROM scene_assets WHERE book_id = $1', [bookId]);
            await query()('DELETE FROM image_units WHERE book_id = $1', [bookId]);
            await query()('DELETE FROM scenes WHERE book_id = $1', [bookId]);
        }
    });

    describe('markReady stamps build_id from the artifact path', () => {
        it('first markReady stores the build directory as build_id', async () => {
            const created = await repo.markReady(
                SCENE_BOOK, CHAPTER, SCENE, 'audio', assetPath('build_stage66_a')
            );
            expect(created.build_id).to.equal('build_stage66_a');
            expect(created.status).to.equal('ready');
            expect(created.path).to.equal(assetPath('build_stage66_a'));

            const rows = await rowsFor(SCENE_BOOK);
            expect(rows).to.have.length(1);
            expect(rows[0].build_id).to.equal('build_stage66_a');
        });

        it('repeated markReady for the same artifact does not add rows', async () => {
            const first = await repo.markReady(
                SCENE_BOOK, CHAPTER, SCENE, 'audio', assetPath('build_stage66_a')
            );
            const second = await repo.markReady(
                SCENE_BOOK, CHAPTER, SCENE, 'audio', assetPath('build_stage66_a')
            );

            expect(second.id).to.equal(first.id);
            expect(second.build_id).to.equal('build_stage66_a');
            expect(await rowsFor(SCENE_BOOK)).to.have.length(1);
        });

        it('two concurrent markReady calls for the same artifact stay one row', async () => {
            const results = await Promise.all([
                repo.markReady(SCENE_BOOK, CHAPTER, SCENE, 'audio', assetPath('build_stage66_a')),
                repo.markReady(SCENE_BOOK, CHAPTER, SCENE, 'audio', assetPath('build_stage66_a')),
            ]);
            expect(results[0].build_id).to.equal('build_stage66_a');
            expect(results[1].build_id).to.equal('build_stage66_a');

            const rows = await rowsFor(SCENE_BOOK);
            expect(rows).to.have.length(1);
            expect(rows[0].build_id).to.equal('build_stage66_a');
        });

        it('an explicit extras.build_id wins over the path-derived one', async () => {
            const created = await repo.markReady(
                SCENE_BOOK, CHAPTER, SCENE, 'audio', assetPath('build_stage66_a'),
                { build_id: 'build_stage66_explicit' }
            );
            expect(created.build_id).to.equal('build_stage66_explicit');
            expect(await rowsFor(SCENE_BOOK)).to.have.length(1);
        });

        it('an artifact outside OUTPUT_DIR keeps build_id NULL (legacy path)', async () => {
            const legacyPath = `/tmp/stage66-legacy/${SCENE_BOOK}_${CHAPTER}_${SCENE}.mp3`;
            const created = await repo.markReady(SCENE_BOOK, CHAPTER, SCENE, 'audio', legacyPath);
            expect(created.build_id).to.equal(null);

            await repo.markReady(SCENE_BOOK, CHAPTER, SCENE, 'audio', legacyPath);
            const rows = await rowsFor(SCENE_BOOK);
            expect(rows).to.have.length(1);
            expect(rows[0].build_id).to.equal(null);
        });

        it('two concurrent legacy markReady calls stay one row', async () => {
            const legacyPath = `/tmp/stage66-legacy/${SCENE_BOOK}_${CHAPTER}_${SCENE}.mp3`;
            await Promise.all([
                repo.markReady(SCENE_BOOK, CHAPTER, SCENE, 'audio', legacyPath),
                repo.markReady(SCENE_BOOK, CHAPTER, SCENE, 'audio', legacyPath),
            ]);
            expect(await rowsFor(SCENE_BOOK)).to.have.length(1);
        });
    });

    describe('build identity is never merged across builds', () => {
        it('different builds produce different rows', async () => {
            await repo.markReady(SCENE_BOOK, CHAPTER, SCENE, 'video', assetPath('build_stage66_a', 'scene.mp4'));
            await repo.markReady(SCENE_BOOK, CHAPTER, SCENE, 'video', assetPath('build_stage66_b', 'scene.mp4'));

            const rows = await rowsFor(SCENE_BOOK);
            expect(rows.map(r => r.build_id).sort()).to.deep.equal(['build_stage66_a', 'build_stage66_b']);
        });

        it('a stamped write never deletes or re-binds historical NULL rows', async () => {
            const legacy = await query()(`
                INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, path, build_id, status, updated_at)
                VALUES ($1, $2, $3, 'video', '/data/output/b1/legacy.mp4', NULL, 'ready', 1787740722)
                RETURNING id
            `, [SCENE_BOOK, CHAPTER, SCENE]);
            const legacyId = legacy.rows[0].id;

            const newerNull = await query()(`
                INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, path, build_id, status, updated_at)
                VALUES ($1, $2, $3, 'video', '/data/output/b1/live.mp4', NULL, 'ready', 1787741423)
                RETURNING id
            `, [SCENE_BOOK, CHAPTER, SCENE]);
            const newerNullId = newerNull.rows[0].id;

            await repo.markReady(SCENE_BOOK, CHAPTER, SCENE, 'video', assetPath('build_stage66_a', 'scene.mp4'));

            const rows = await rowsFor(SCENE_BOOK);
            expect(rows).to.have.length(3);

            const untouched = rows.find(r => r.id === legacyId);
            expect(untouched.build_id).to.equal(null);
            expect(untouched.path).to.equal('/data/output/b1/legacy.mp4');

            const stamped = rows.find(r => r.build_id === 'build_stage66_a');
            expect(stamped, 'the ready row must be a NEW row keyed by the build').to.exist;
            expect(stamped.id).to.not.equal(legacyId);
            expect(stamped.id).to.not.equal(newerNullId);
        });

        it('a legacy NULL markReady updates the existing NULL row in place', async () => {
            const legacy = await query()(`
                INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, path, build_id, status, updated_at)
                VALUES ($1, $2, $3, 'audio', '/tmp/old.mp3', NULL, 'ready', 1700000000)
                RETURNING id
            `, [SCENE_BOOK, CHAPTER, SCENE]);
            const legacyId = legacy.rows[0].id;

            const updated = await repo.markReady(
                SCENE_BOOK, CHAPTER, SCENE, 'audio', '/tmp/new-legacy.mp3'
            );
            expect(updated.id).to.equal(legacyId);
            expect(updated.path).to.equal('/tmp/new-legacy.mp3');
            expect(updated.build_id).to.equal(null);

            expect(await rowsFor(SCENE_BOOK)).to.have.length(1);
        });

        it('a legacy NULL markReady touches only the canonical (newest) NULL row', async () => {
            const older = await query()(`
                INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, path, build_id, status, updated_at)
                VALUES ($1, $2, $3, 'audio', '/tmp/older.mp3', NULL, 'ready', 1700000000)
                RETURNING id
            `, [SCENE_BOOK, CHAPTER, SCENE]);
            const olderId = older.rows[0].id;

            const newer = await query()(`
                INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, path, build_id, status, updated_at)
                VALUES ($1, $2, $3, 'audio', '/tmp/newer.mp3', NULL, 'ready', 1787741423)
                RETURNING id
            `, [SCENE_BOOK, CHAPTER, SCENE]);
            const newerId = newer.rows[0].id;

            const updated = await repo.markReady(
                SCENE_BOOK, CHAPTER, SCENE, 'audio', '/tmp/canonical.mp3'
            );
            expect(updated.id).to.equal(newerId);
            expect(updated.path).to.equal('/tmp/canonical.mp3');

            const rows = await rowsFor(SCENE_BOOK);
            expect(rows).to.have.length(2);
            const untouched = rows.find(r => r.id === olderId);
            expect(untouched.path).to.equal('/tmp/older.mp3');
            expect(Number(untouched.updated_at)).to.equal(1700000000);
        });
    });

    describe('other NULL-inserting writers are idempotent', () => {
        it('stampSceneVersionsForDispatch inserts a synthetic row once', async () => {
            await query()(`
                INSERT INTO scenes (book_id, chapter_id, scene_id, content_version, audio_config_version, dirty_unit_ids, updated_at)
                VALUES ($1, $2, $3, 3, 2, '{}', EXTRACT(EPOCH FROM NOW())::bigint)
                ON CONFLICT (book_id, chapter_id, scene_id) DO NOTHING
            `, [SCENE_BOOK, CHAPTER, SCENE]);

            const first = await repo.stampSceneVersionsForDispatch(SCENE_BOOK, CHAPTER, SCENE, 'image');
            const second = await repo.stampSceneVersionsForDispatch(SCENE_BOOK, CHAPTER, SCENE, 'image');

            expect(first.inserted).to.equal(1);
            expect(second.inserted).to.equal(0);
            expect(second.stamped).to.equal(1);

            const rows = await rowsFor(SCENE_BOOK);
            expect(rows).to.have.length(1);
            expect(rows[0].status).to.equal('pending');
            expect(rows[0].build_id).to.equal(null);
        });

        it('ensureSyntheticStaleAsset is a no-op without a scenes row', async () => {
            expect(await repo.ensureSyntheticStaleAsset(SCENE_BOOK, CHAPTER, SCENE)).to.equal(0);
            expect(await rowsFor(SCENE_BOOK)).to.have.length(0);
        });

        it('book-sync.markSceneAssetsStale does not mint a second NULL audio row', async () => {
            await query()(`
                INSERT INTO scenes (book_id, chapter_id, scene_id, content_version, audio_config_version, dirty_unit_ids, updated_at)
                VALUES ($1, $2, $3, 1, 1, '{}', EXTRACT(EPOCH FROM NOW())::bigint)
                ON CONFLICT (book_id, chapter_id, scene_id) DO NOTHING
            `, [SCENE_BOOK, CHAPTER, SCENE]);

            await bookSync.markSceneAssetsStale(SCENE_BOOK, [`${CHAPTER}::${SCENE}`]);
            await bookSync.markSceneAssetsStale(SCENE_BOOK, [`${CHAPTER}::${SCENE}`]);

            const rows = await rowsFor(SCENE_BOOK);
            expect(rows).to.have.length(1);
            expect(rows[0].asset_type).to.equal('audio');
            expect(rows[0].status).to.equal('stale');
            expect(rows[0].build_id).to.equal(null);
        });
    });

    describe('image_units always carry a real build_id', () => {
        const unitData = { scene_order: 0, text: 'hello', text_length: 5, scene_duration_sec: 1.5 };

        it('stores the given build_id and stays single-row on repeat', async () => {
            await iuRepo.upsertImageUnit('build_stage66_iu_a', IU_BOOK, CHAPTER, SCENE, 'iu-1', unitData);
            await iuRepo.upsertImageUnit('build_stage66_iu_a', IU_BOOK, CHAPTER, SCENE, 'iu-1', unitData);

            const r = await query()(
                'SELECT build_id, unit_id FROM image_units WHERE book_id = $1',
                [IU_BOOK]
            );
            expect(r.rows).to.have.length(1);
            expect(r.rows[0].build_id).to.equal('build_stage66_iu_a');
        });

        it('two concurrent upserts for the same unit stay one row', async () => {
            await Promise.all([
                iuRepo.upsertImageUnit('build_stage66_iu_a', IU_BOOK, CHAPTER, SCENE, 'iu-1', unitData),
                iuRepo.upsertImageUnit('build_stage66_iu_a', IU_BOOK, CHAPTER, SCENE, 'iu-1', unitData),
            ]);

            const r = await query()('SELECT count(*)::int AS c FROM image_units WHERE book_id = $1', [IU_BOOK]);
            expect(r.rows[0].c).to.equal(1);
        });

        it('different builds are never merged', async () => {
            await iuRepo.upsertImageUnit('build_stage66_iu_a', IU_BOOK, CHAPTER, SCENE, 'iu-1', unitData);
            await iuRepo.upsertImageUnit('build_stage66_iu_b', IU_BOOK, CHAPTER, SCENE, 'iu-1', unitData);

            const r = await query()('SELECT build_id FROM image_units WHERE book_id = $1 ORDER BY build_id', [IU_BOOK]);
            expect(r.rows.map(x => x.build_id)).to.deep.equal(['build_stage66_iu_a', 'build_stage66_iu_b']);
        });

        it('rejects a missing build_id and writes no row', async () => {
            for (const bad of [null, undefined, '', '   ']) {
                let threw = null;
                try {
                    await iuRepo.upsertImageUnit(bad, IU_BOOK, CHAPTER, SCENE, 'iu-1', unitData);
                } catch (err) {
                    threw = err;
                }
                expect(threw, `build_id=${JSON.stringify(bad)} must be rejected`).to.exist;
                expect(String(threw.message)).to.match(/build_id is required/);
            }

            const r = await query()('SELECT count(*)::int AS c FROM image_units WHERE book_id = $1', [IU_BOOK]);
            expect(r.rows[0].c).to.equal(0);
        });

        it('upsertIuTiming rejects a missing build_id as well', async () => {
            let threw = null;
            try {
                await iuRepo.upsertIuTiming(null, IU_BOOK, CHAPTER, SCENE, 'iu-1', 0, 100);
            } catch (err) {
                threw = err;
            }
            expect(threw).to.exist;
            expect(String(threw.message)).to.match(/build_id is required/);
        });
    });
});
