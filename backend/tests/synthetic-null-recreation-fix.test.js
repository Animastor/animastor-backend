// ======================================================
// Stage 76 — синтетические NULL-строки не ре-создаются на versioned-ключах
// ======================================================
// К-5 Stage 70 / риск Stage 75: ensureSyntheticStaleAsset при genuine edit
// versioned-сцены (нет ready-строк → book-sync вызывает ensure) выполнял
//   UPDATE … WHERE build_id IS NULL  → 0 строк (NULL-дубли удалены/нет)
//   INSERT новой NULL-строки         → новое семейство build_id IS NULL,
// unique-ключ которого не может дедуплицировать NULL.
//
// Фикс Stage 76 (scene-assets-repo.ensureSyntheticStaleAsset):
//   1. строки в scenes нет            → no-op (контракт Stage 66 сохранён);
//   2. есть NULL-строки ключа         → обновить ИХ (текущая production-форма
//                                       ba_ с NULL+versioned не меняется);
//   3. есть versioned-строки          → обновить ВСЕ их (stale + штампы),
//                                       INSERT NULL запрещён; при нескольких
//                                       builds — fail-closed: ничего не
//                                       удаляется, ни один build не выбирается
//                                       молча, все строки консервативно stale;
//   4. строк нет (legacy без builds)  → прежний синтетический NULL-INSERT
//                                       (R15+ маркер версии).
//
// Тесты пишут только в строки с book_id test76-* и удаляют их в afterEach/
// after — после набора PostgreSQL чист (см. итоговый `after`).

const { expect } = require('chai');

const config = () => require('../src/config/runtime-config');
const query = () => require('../src/storage/postgres/database').query;

const BOOK = 'test76-synthetic-null';
const CHAPTER = 'ch-76';
const SC_CANON = 'sc-76-canon';
const SC_AMBIG = 'sc-76-ambig';
const SC_LEGACY = 'sc-76-legacy';
const SC_MIXED = 'sc-76-mixed';
const BUILD_A = 'build_test76_a';
const BUILD_B = 'build_test76_b';

const artPath = (scene, build = BUILD_A, ext = 'mp3') =>
    `${config().OUTPUT_DIR}/${build}/${BOOK}_${CHAPTER}_${scene}.${ext}`;

describe('Stage 76: ensureSyntheticStaleAsset не ре-создаёт NULL-строки на versioned-ключах', () => {
    let repo;
    let bookSync;

    async function seedScene(scene, opts = {}) {
        const { content = 1, audio = 1 } = opts;
        await query()(`
            INSERT INTO scenes (book_id, chapter_id, scene_id, content_version,
                                audio_config_version, is_dirty, dirty_unit_ids, updated_at)
            VALUES ($1, $2, $3, $4, $5, false, '{}', EXTRACT(EPOCH FROM NOW())::bigint)
            ON CONFLICT (book_id, chapter_id, scene_id) DO UPDATE
                SET content_version = EXCLUDED.content_version,
                    audio_config_version = EXCLUDED.audio_config_version
        `, [BOOK, CHAPTER, scene, content, audio]);
    }

    async function rowsFor(book = BOOK) {
        const r = await query()(
            `SELECT id, chapter_id, scene_id, asset_type, path, build_id, status,
                    scene_content_version, scene_audio_config_version, updated_at
             FROM scene_assets WHERE book_id = $1 ORDER BY id`,
            [book]
        );
        return r.rows;
    }

    async function insertNullRow(scene, opts = {}) {
        const {
            status = 'stale', path = null, contentVersion = 1, audioVersion = 1,
        } = opts;
        const r = await query()(`
            INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, path,
                                      build_id, status, scene_content_version,
                                      scene_audio_config_version, updated_at)
            VALUES ($1, $2, $3, 'audio', $4, NULL, $5, $6, $7,
                    EXTRACT(EPOCH FROM NOW())::bigint)
            RETURNING id
        `, [BOOK, CHAPTER, scene, path, status, contentVersion, audioVersion]);
        return r.rows[0];
    }

    before(async () => {
        const postgres = require('../src/storage/postgres');
        await postgres.initialize();
        repo = require('../src/storage/postgres/repositories/scene-assets-repo');
        bookSync = require('../src/services/book-sync');
    });

    afterEach(async () => {
        await query()('DELETE FROM scene_assets WHERE book_id = $1', [BOOK]);
        await query()('DELETE FROM scenes WHERE book_id = $1', [BOOK]);
    });

    after(async () => {
        await query()('DELETE FROM scene_assets WHERE book_id = $1', [BOOK]);
        await query()('DELETE FROM scenes WHERE book_id = $1', [BOOK]);
        const left = await query()(
            `SELECT (SELECT count(*)::int FROM scene_assets WHERE book_id = $1)
                  + (SELECT count(*)::int FROM scenes WHERE book_id = $1) AS n`,
            [BOOK]
        );
        expect(left.rows[0].n, 'test76 rows must not survive the suite').to.equal(0);
    });

    // ─────────────────────────────────────────────────────
    // 1. Versioned edit не создаёт NULL-строку при известном каноническом build
    // ─────────────────────────────────────────────────────
    describe('versioned сцена: NULL-строка не создаётся', () => {
        it('ensureSyntheticStaleAsset обновляет versioned-строку вместо INSERT NULL', async () => {
            const canon = await repo.markReady(BOOK, CHAPTER, SC_CANON, 'audio', artPath(SC_CANON));
            expect(canon.build_id).to.equal(BUILD_A);
            await seedScene(SC_CANON, { content: 2, audio: 2 });

            const n = await repo.ensureSyntheticStaleAsset(BOOK, CHAPTER, SC_CANON);

            expect(n, 'versioned-строка должна быть обновлена').to.equal(1);
            const rows = await rowsFor();
            expect(rows).to.have.length(1);
            expect(rows[0].id).to.equal(canon.id);
            expect(rows[0].build_id).to.equal(BUILD_A);
            expect(rows[0].status).to.equal('stale');
            expect(rows[0].scene_content_version).to.equal(2);
            expect(rows[0].scene_audio_config_version).to.equal(2);
        });

        it('genuine edit через book-sync.markSceneAssetsStale не плодит NULL-строку', async () => {
            const canon = await repo.markReady(BOOK, CHAPTER, SC_CANON, 'audio', artPath(SC_CANON));
            // versioned-строка уже не ready (например, stale с прошлой инвалидации) —
            // step1 markSceneAssetsStale не матчит, ensure получает ключ без NULL-строк.
            await query()(`UPDATE scene_assets SET status = 'stale' WHERE id = $1`, [canon.id]);
            await seedScene(SC_CANON, { content: 3, audio: 3 });

            await bookSync.markSceneAssetsStale(BOOK, [`${CHAPTER}::${SC_CANON}`]);

            const rows = await rowsFor();
            expect(rows, 'новая NULL-строка не должна появиться').to.have.length(1);
            expect(rows[0].id).to.equal(canon.id);
            expect(rows[0].build_id).to.equal(BUILD_A);
            expect(rows[0].status).to.equal('stale');
            expect(rows[0].scene_content_version).to.equal(3);
        });

        it('ready versioned-строка при edit через book-sync: step1 матчит ready — ensure не вызывается', async () => {
            const canon = await repo.markReady(BOOK, CHAPTER, SC_CANON, 'audio', artPath(SC_CANON));
            await seedScene(SC_CANON, { content: 2, audio: 2 });

            await bookSync.markSceneAssetsStale(BOOK, [`${CHAPTER}::${SC_CANON}`]);

            const rows = await rowsFor();
            expect(rows).to.have.length(1);
            expect(rows[0].status).to.equal('stale');
            expect(rows[0].build_id).to.equal(BUILD_A);
        });
    });

    // ─────────────────────────────────────────────────────
    // 2. Legacy-сцена без build-контекста сохраняет прежнее поведение
    // ─────────────────────────────────────────────────────
    describe('legacy без build-контекста: прежнее поведение сохранено', () => {
        it('сцена с нуля строк: ensure создаёт один синтетический NULL-маркер', async () => {
            await seedScene(SC_LEGACY, { content: 1, audio: 1 });

            const n = await repo.ensureSyntheticStaleAsset(BOOK, CHAPTER, SC_LEGACY);

            expect(n).to.equal(1);
            const rows = await rowsFor();
            expect(rows).to.have.length(1);
            expect(rows[0].build_id).to.equal(null);
            expect(rows[0].asset_type).to.equal('audio');
            expect(rows[0].status).to.equal('stale');
        });

        it('без строки в scenes — no-op (контракт Stage 66)', async () => {
            expect(await repo.ensureSyntheticStaleAsset(BOOK, CHAPTER, SC_LEGACY)).to.equal(0);
            expect(await rowsFor()).to.have.length(0);
        });

        it('повторный ensure на legacy-сцене идемпотентен (одна строка)', async () => {
            await seedScene(SC_LEGACY);
            await repo.ensureSyntheticStaleAsset(BOOK, CHAPTER, SC_LEGACY);
            await repo.ensureSyntheticStaleAsset(BOOK, CHAPTER, SC_LEGACY);

            const rows = await rowsFor();
            expect(rows).to.have.length(1);
            expect(rows[0].build_id).to.equal(null);
        });
    });

    // ─────────────────────────────────────────────────────
    // 3. Неоднозначный provenance — fail closed, ничего не теряется
    // ─────────────────────────────────────────────────────
    describe('неоднозначный provenance: fail closed', () => {
        it('два versioned-строки с разными builds: обе stale, ни одна не удалена, NULL не создана', async () => {
            const a = await repo.markReady(BOOK, CHAPTER, SC_AMBIG, 'audio', artPath(SC_AMBIG, BUILD_A));
            const b = await repo.markReady(BOOK, CHAPTER, SC_AMBIG, 'audio', artPath(SC_AMBIG, BUILD_B));
            await seedScene(SC_AMBIG, { content: 2, audio: 2 });

            const n = await repo.ensureSyntheticStaleAsset(BOOK, CHAPTER, SC_AMBIG);

            expect(n, 'обе versioned-строки консервативно stale').to.equal(2);
            const rows = await rowsFor();
            expect(rows).to.have.length(2);
            expect(rows.map(r => r.build_id).sort()).to.deep.equal([BUILD_A, BUILD_B].sort());
            expect(rows.every(r => r.status === 'stale')).to.equal(true);
            expect(rows.every(r => r.scene_content_version === 2)).to.equal(true);
            expect(rows.map(r => r.id).sort((x, y) => x - y))
                .to.deep.equal([a.id, b.id].sort((x, y) => x - y));
        });

        it('повторный ensure на неоднозначном ключе идемпотентен (те же 2 строки)', async () => {
            await repo.markReady(BOOK, CHAPTER, SC_AMBIG, 'audio', artPath(SC_AMBIG, BUILD_A));
            await repo.markReady(BOOK, CHAPTER, SC_AMBIG, 'audio', artPath(SC_AMBIG, BUILD_B));
            await seedScene(SC_AMBIG);

            await repo.ensureSyntheticStaleAsset(BOOK, CHAPTER, SC_AMBIG);
            const afterFirst = await rowsFor();
            await repo.ensureSyntheticStaleAsset(BOOK, CHAPTER, SC_AMBIG);
            const afterSecond = await rowsFor();

            expect(afterSecond).to.have.length(2);
            expect(afterSecond.map(r => r.id)).to.deep.equal(afterFirst.map(r => r.id));
            expect(afterSecond.every(r => r.status === 'stale')).to.equal(true);
        });

        it('NULL+versioned одной формы (production ba_): выигрывает NULL-ветка, versioned не тронута', async () => {
            const canon = await repo.markReady(BOOK, CHAPTER, SC_MIXED, 'audio', artPath(SC_MIXED));
            const dup = await insertNullRow(SC_MIXED, { status: 'stale' });
            await seedScene(SC_MIXED, { content: 2, audio: 2 });

            const n = await repo.ensureSyntheticStaleAsset(BOOK, CHAPTER, SC_MIXED);

            expect(n, 'обновляется только NULL-строка — прежняя ветка').to.equal(1);
            const rows = await rowsFor();
            expect(rows).to.have.length(2);

            const versioned = rows.find(r => r.id === canon.id);
            expect(versioned.status, 'versioned-строка не меняется при наличии NULL-строки')
                .to.equal('ready');
            expect(versioned.updated_at).to.equal(canon.updated_at);

            const nullRow = rows.find(r => r.id === dup.id);
            expect(nullRow.status).to.equal('stale');
            expect(nullRow.scene_content_version).to.equal(2);
        });
    });
});
