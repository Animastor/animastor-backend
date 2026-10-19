// ======================================================
// Stage 73 — legacy NULL-дубли не инвалидируют канонические versioned-активы
// ======================================================
// Production-семейство строк `sc-5f18dd0f/audio` (отчёт 72 §B.4):
//   21338 (build_import_…, ready) + 21484/48348/48351/48353 (build_id IS NULL,
//   stale, тот же path). На каждом старте rebuildWorkList собирал dirty-маркер
//   ИМЕННО из stale NULL-дублей → C0 self-heal `markDirtyScene` →
//   `scene-assets-repo.markStale(buildId=null)` сбрасывал READY канонической
//   versioned-строки и запускал лишний dispatch-цикл.
//
// Правило Stage 73 (см. provenNullDuplicateCondition):
//   legacy-строка `build_id IS NULL` — доказанный дубль, если у того же ключа
//   есть versioned-строка с byte-identical путём artifact'а. Такая строка не
//   участвует в выборках dirty/stale-сигналов ключа. Поведение сохраняется для:
//     • канонических versioned-строк (их статус/штампы участвуют как раньше);
//     • legacy-книг/ключей вообще без versioned-строк;
//     • строк с `path IS NULL` (синтетические pending, К-5 Stage 70) и строк
//       с другим/отсутствующим у versioned-брата путём.
//
// Тесты пишут только в строки с собственными book_id (test73-*) и удаляют
// их в afterEach — PostgreSQL после набора должен быть чист (см. `after`).

const { expect } = require('chai');

const config = () => require('../src/config/runtime-config');
const query = () => require('../src/storage/postgres/database').query;

const V_BOOK = 'test73-versioned';
const L_BOOK = 'test73-legacy';
const CHAPTER = 'ch-73';
const SC_CANON = 'sc-73-canon';
const SC_UNPROVEN = 'sc-73-unproven';
const SC_PENDING = 'sc-73-pending';
const SC_LEGACY = 'sc-73-legacy';
const BUILD = 'build_test73_a';
const BOOKS = [V_BOOK, L_BOOK];

const artPath = (scene, ext = 'mp3') =>
    `${config().OUTPUT_DIR}/${BUILD}/${V_BOOK}_${CHAPTER}_${scene}.${ext}`;

describe('Stage 73: legacy NULL-дубли не влияют на канонические versioned-артефакты', () => {
    let repo;
    let adapter;
    let stateOps;
    let bookSync;
    let createMockRedis;
    let redis;

    const keyOf = (chapter, scene, asset) => `${chapter}:${scene}:${asset}`;

    async function insertNullRow(book, scene, assetType, path, opts = {}) {
        const {
            status = 'stale',
            contentVersion = 1,
            audioVersion = 1,
            updatedAt = 1700000000,
        } = opts;
        const r = await query()(`
            INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, path,
                                      build_id, status, scene_content_version, scene_audio_config_version,
                                      created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $9)
            RETURNING id, book_id, chapter_id, scene_id, asset_type, path, build_id, status,
                      scene_content_version, scene_audio_config_version, updated_at
        `, [book, CHAPTER, scene, assetType, path, status, contentVersion, audioVersion, updatedAt]);
        return r.rows[0];
    }

    async function seedScene(book, scene, opts = {}) {
        const { content = 1, audio = 1, isDirty = false } = opts;
        await query()(`
            INSERT INTO scenes (book_id, chapter_id, scene_id, content_version,
                                audio_config_version, is_dirty, dirty_unit_ids, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, '{}', EXTRACT(EPOCH FROM NOW())::bigint)
            ON CONFLICT (book_id, chapter_id, scene_id) DO UPDATE
                SET content_version = EXCLUDED.content_version,
                    audio_config_version = EXCLUDED.audio_config_version,
                    is_dirty = EXCLUDED.is_dirty
        `, [book, CHAPTER, scene, content, audio, isDirty]);
    }

    async function rowsFor(book) {
        const r = await query()(
            `SELECT id, chapter_id, scene_id, asset_type, path, build_id, status,
                    scene_content_version, scene_audio_config_version, duration_sec, updated_at
             FROM scene_assets WHERE book_id = $1 ORDER BY id`,
            [book]
        );
        return r.rows;
    }

    async function rowById(id) {
        const r = await query()(
            `SELECT id, path, build_id, status, scene_content_version, scene_audio_config_version, updated_at
             FROM scene_assets WHERE id = $1`,
            [id]
        );
        return r.rows[0] || null;
    }

    async function dirtyMarkerKeys(book) {
        const m = await adapter.sceneAssets.getDirtyMarkers(book);
        return m.assetStages.map(r => keyOf(r.chapter_id, r.scene_id, r.asset_type)).sort();
    }

    // Повторяет C0-гейт rebuildWorkList (reconciliation-engine.js:2353/2428):
    // dirty-маркер из PG — единственная причина, по которой self-heal зовёт
    // markDirtyScene (и, как следствие, markStale поверх канонической строки).
    async function runStartupSelfHealGate(book, chapter, scene, asset) {
        const markers = await dirtyMarkerKeys(book);
        const dirty = markers.includes(keyOf(chapter, scene, asset));
        if (dirty) {
            await stateOps.markDirtyScene(redis, book, chapter, scene, [asset]);
        }
        return { dirty, markDirtySceneCalled: dirty };
    }

    before(async () => {
        const postgres = require('../src/storage/postgres');
        await postgres.initialize();
        repo = require('../src/storage/postgres/repositories/scene-assets-repo');
        adapter = require('../src/storage/runtime-persistence-adapter');
        stateOps = require('../src/state/scene-state-ops');
        bookSync = require('../src/services/book-sync');
        createMockRedis = require('./mocks/redis-mock').createMockRedis;
        redis = createMockRedis();
    });

    afterEach(async () => {
        for (const book of BOOKS) {
            await query()('DELETE FROM scene_assets WHERE book_id = $1', [book]);
            await query()('DELETE FROM scenes WHERE book_id = $1', [book]);
        }
    });

    after(async () => {
        for (const book of BOOKS) {
            await query()('DELETE FROM scene_assets WHERE book_id = $1', [book]);
            await query()('DELETE FROM scenes WHERE book_id = $1', [book]);
            await query()('DELETE FROM image_units WHERE book_id = $1', [book]);
        }
        const left = await query()(
            `SELECT (SELECT count(*)::int FROM scene_assets WHERE book_id = ANY($1::text[]))
                  + (SELECT count(*)::int FROM scenes WHERE book_id = ANY($1::text[]))
                  + (SELECT count(*)::int FROM image_units WHERE book_id = ANY($1::text[])) AS n`,
            [BOOKS]
        );
        expect(left.rows[0].n, 'test73 rows must not survive the suite').to.equal(0);
    });

    // ─────────────────────────────────────────────────────
    // 1. Startup / self-heal не трогает каноническую READY-строку
    // ─────────────────────────────────────────────────────
    describe('startup self-heal (markDirtyScene → markStale)', () => {
        async function seedCanonFamily() {
            const canon = await repo.markReady(V_BOOK, CHAPTER, SC_CANON, 'audio', artPath(SC_CANON));
            const dup = await insertNullRow(V_BOOK, SC_CANON, 'audio', artPath(SC_CANON), {
                status: 'stale', contentVersion: 1, audioVersion: 1,
            });
            await seedScene(V_BOOK, SC_CANON, { content: 1, audio: 1 });
            return { canon, dup };
        }

        it('markDirtyScene не сбрасывает каноническую READY-строку из-за пустого NULL-дубля', async () => {
            const { canon, dup } = await seedCanonFamily();
            expect(canon.build_id).to.equal(BUILD);
            expect(canon.status).to.equal('ready');
            expect(dup.build_id).to.equal(null);
            expect(dup.path).to.equal(canon.path);

            const gate = await runStartupSelfHealGate(V_BOOK, CHAPTER, SC_CANON, 'audio');

            expect(gate.markDirtySceneCalled,
                'доказанный NULL-дубль не должен запускать self-heal markDirtyScene').to.equal(false);
            const canonAfter = await rowById(canon.id);
            expect(canonAfter.status, 'каноническая versioned-строка обязана остаться ready').to.equal('ready');
            expect(canonAfter.updated_at).to.equal(canon.updated_at);
            expect((await rowById(dup.id)).status).to.equal('stale');
            expect(await rowsFor(V_BOOK)).to.have.length(2);
        });

        it('пустой NULL-дубль не даёт dirty-маркер, но versioned-строка того же ключа — даёт (работа не теряется)', async () => {
            const { canon } = await seedCanonFamily();
            expect(await dirtyMarkerKeys(V_BOOK)).to.deep.equal([]);

            // Контроль: как только сама versioned-строка становится stale
            // (реальная invalidation), ключ снова dirty.
            await query()(
                `UPDATE scene_assets SET status = 'stale' WHERE id = $1`,
                [canon.id]
            );
            expect(await dirtyMarkerKeys(V_BOOK)).to.deep.equal([keyOf(CHAPTER, SC_CANON, 'audio')]);
        });

        it('повторный startup/self-heal идемпотентен: вторая итерация не меняет PostgreSQL', async () => {
            const { canon, dup } = await seedCanonFamily();
            const before = await rowsFor(V_BOOK);

            const first = await runStartupSelfHealGate(V_BOOK, CHAPTER, SC_CANON, 'audio');
            const second = await runStartupSelfHealGate(V_BOOK, CHAPTER, SC_CANON, 'audio');
            const after = await rowsFor(V_BOOK);

            expect(first.markDirtySceneCalled).to.equal(false);
            expect(second.markDirtySceneCalled).to.equal(false);
            expect(after).to.deep.equal(before);
            expect((await rowById(canon.id)).status).to.equal('ready');
            expect((await rowById(dup.id)).status).to.equal('stale');
        });

        it('доказанный NULL-дубль не порождает version-сигнал в getDirtyScenesByVersion (C0 staleAssets)', async () => {
            const { canon, dup } = await seedCanonFamily();
            // Дубль намеренно ready и с устаревшими штампами (0/0) — раньше это
            // помечало ключ stale. Каноническая versioned-строка устаревает
            // честно (1/1 < 2/2) — её сигнал обязан сохраниться.
            await query()(
                `UPDATE scene_assets SET status = 'ready', scene_content_version = 0,
                        scene_audio_config_version = 0 WHERE id = $1`,
                [dup.id]
            );
            await query()(
                `UPDATE scene_assets SET scene_content_version = 1, scene_audio_config_version = 1
                 WHERE id = $1`,
                [canon.id]
            );
            await seedScene(V_BOOK, SC_CANON, { content: 2, audio: 2 });

            const rows = await adapter.sceneAssets.getDirtyScenesByVersion(V_BOOK);
            const mismatchReady = rows.filter(r =>
                r.chapter_id === CHAPTER && r.scene_id === SC_CANON &&
                r.status === 'ready' &&
                ((r.scene_content_version != null && r.scene_content_version < r.content_version) ||
                 (r.scene_audio_config_version != null && r.scene_audio_config_version < r.audio_config_version)));
            expect(
                mismatchReady.map(r => r.scene_content_version).sort((a, b) => a - b),
                'version-сигнал приходит только от versioned-строки (1), не от дубля (0)'
            ).to.deep.equal([1]);
        });

        it('C2 getVersionStalenessRows исключает доказанный NULL-дубль и оставляет versioned-строку', async () => {
            const { canon, dup } = await seedCanonFamily();
            await query()(
                `UPDATE scene_assets SET status = 'ready', scene_content_version = 1 WHERE id = $1`,
                [dup.id]
            );
            await query()(
                `UPDATE scene_assets SET scene_content_version = 2, scene_audio_config_version = 2
                 WHERE id = $1`,
                [canon.id]
            );
            await seedScene(V_BOOK, SC_CANON, { content: 2, audio: 2 });

            const rows = await adapter.sceneVersions.getVersionStalenessRows();
            const mine = rows.filter(r => r.book_id === V_BOOK && r.scene_id === SC_CANON);
            expect(mine.map(r => r.scene_content_version), 'дубль с устаревшими штампами исключён')
                .to.deep.equal([2]);
            expect(mine.every(r => r.asset_type === 'audio')).to.equal(true);
        });
    });

    // ─────────────────────────────────────────────────────
    // 2. Реальное изменение сцены по-прежнему помечает canonical stale
    // ─────────────────────────────────────────────────────
    describe('реальное изменение сцены (genuine invalidation)', () => {
        it('book-sync.markSceneAssetsStale переводит каноническую READY-строку в stale при наличии доказанного дубля', async () => {
            const canon = await repo.markReady(V_BOOK, CHAPTER, SC_CANON, 'audio', artPath(SC_CANON));
            await insertNullRow(V_BOOK, SC_CANON, 'audio', artPath(SC_CANON), { status: 'stale' });
            await seedScene(V_BOOK, SC_CANON, { content: 1, audio: 1 });

            await bookSync.markSceneAssetsStale(V_BOOK, [`${CHAPTER}::${SC_CANON}`]);

            const after = await rowById(canon.id);
            expect(after.status, 'реальное изменение сцены обязано пометить canonical stale').to.equal('stale');
            expect(after.scene_content_version).to.equal(1);
        });

        it('markDirtyScene без доказанного эквивалента (другой path) сбрасывает canonical stale — прежнее поведение', async () => {
            const canon = await repo.markReady(V_BOOK, CHAPTER, SC_UNPROVEN, 'audio', artPath(SC_UNPROVEN));
            // У дубля ДРУГОЙ путь → эквивалент не доказан → маркер остаётся.
            const dup = await insertNullRow(V_BOOK, SC_UNPROVEN, 'audio', '/tmp/stage73-legacy/other.mp3', {
                status: 'stale',
            });

            const gate = await runStartupSelfHealGate(V_BOOK, CHAPTER, SC_UNPROVEN, 'audio');
            expect(gate.markDirtySceneCalled, 'недоказанный NULL-строке маркер сохраняется').to.equal(true);

            expect((await rowById(canon.id)).status).to.equal('stale');
            expect((await rowById(dup.id)).status).to.equal('stale');
        });
    });

    // ─────────────────────────────────────────────────────
    // 3. Legacy и неизвестные pending-строки не повреждены
    // ─────────────────────────────────────────────────────
    describe('legacy-ключи и синтетические pending-строки', () => {
        it('legacy-ключ без versioned-эквивалента сохраняет прежнее поведение (маркер есть, markStale как раньше)', async () => {
            const ready = await insertNullRow(L_BOOK, SC_LEGACY, 'audio', '/tmp/stage73-legacy/a.mp3', {
                status: 'ready',
            });
            await insertNullRow(L_BOOK, SC_LEGACY, 'audio', '/tmp/stage73-legacy/a-old.mp3', { status: 'stale' });

            const gate = await runStartupSelfHealGate(L_BOOK, CHAPTER, SC_LEGACY, 'audio');
            expect(gate.markDirtySceneCalled, 'legacy-ключ обязан оставаться dirty-маркером').to.equal(true);
            expect((await rowById(ready.id)).status, 'legacy ready-строка помечается stale как раньше')
                .to.equal('stale');
            expect(await rowsFor(L_BOOK)).to.have.length(2);
        });

        it('синтетическая pending-строка с path IS NULL (К-5 Stage 70) остаётся dirty-маркером', async () => {
            await repo.markReady(V_BOOK, CHAPTER, SC_PENDING, 'image', artPath(SC_PENDING, 'png'));
            const pending = await insertNullRow(V_BOOK, SC_PENDING, 'image', null, { status: 'pending' });

            expect(await dirtyMarkerKeys(V_BOOK),
                'строка без доказанной artifact-идентичности не исключается правилом')
                .to.deep.equal([keyOf(CHAPTER, SC_PENDING, 'image')]);
            expect((await rowById(pending.id)).status).to.equal('pending');
        });

        it('legacy-сцена с version-расхождением продолжает давать сигнал C0/C2 (строк без versioned-брата правило не трогает)', async () => {
            const legacy = await insertNullRow(L_BOOK, SC_LEGACY, 'audio', '/tmp/stage73-legacy/b.mp3', {
                status: 'ready', contentVersion: 1, audioVersion: 1,
            });
            await seedScene(L_BOOK, SC_LEGACY, { content: 3, audio: 3 });

            const dirtyRows = await adapter.sceneAssets.getDirtyScenesByVersion(L_BOOK);
            expect(dirtyRows.some(r => r.scene_id === SC_LEGACY && r.status === 'ready' &&
                r.scene_content_version === 1 && r.content_version === 3)).to.equal(true);

            const c2 = await adapter.sceneVersions.getVersionStalenessRows();
            expect(c2.some(r => r.book_id === L_BOOK && r.scene_id === SC_LEGACY &&
                r.scene_content_version === 1)).to.equal(true);
            expect((await rowById(legacy.id)).status).to.equal('ready');
        });
    });
});
