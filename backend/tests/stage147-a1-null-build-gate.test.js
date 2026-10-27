// ======================================================
// Stage 147 (A1) — version-gate fallback на строку build_id IS NULL
// ======================================================
// Регрессия к циклу stage146 §5.4: единственная строка ключа scene_assets
// имеет build_id = NULL; getAsset(buildId) её не видит (`build_id = $5`),
// а markReady — единственный писатель build_id — вызывается ПОСЛЕ gate ⇒
// сцена навсегда DIRTY и перезапускается каждые 5 с
// (ATTEMPT_DISPATCH → cache_hit → IMAGE_CALLBACK → stale → DIRTY).
//
// Контракт фикса (orchestrator.completeStage):
//   1. пустой getAsset(buildId) → РОВНО одно дополнительное чтение строки
//      ТОГО ЖЕ ключа с build_id IS NULL (не другого билда, не «последней
//      любой»); подтверждённые версии → READY с ОДНОГО вызова, markReady
//      проставляет build_id (buildIdFromArtifactPath);
//   2. NULL-строка с версией ниже версии сцены → не READY (DIRTY);
//   3. строка ДРУГОГО билда никогда не служит доказательством версий;
//   4. ошибка PG на любом чтении → fail-closed (как раньше).
//
// Слой 1 — юнит (require.cache-стабы, без PG): изоляция логики gate.
// Слой 2 — PG-интеграция (реальный репозиторий/адаптер/markReady):
// воспроизведение цикла «с одного вызова + build_id проставлен» и
// отрицательные случаи на реальных строках.

const { expect } = require('chai');
const { createMockRedis } = require('./mocks/redis-mock');

const ORCH = '../node_modules/@animastor/orchestration/src/orchestration/orchestrator';
const CALLBACKS = '../node_modules/@animastor/orchestration/src/orchestration/scene-callbacks';
const SCENE_UTILS = '../node_modules/@animastor/orchestration/src/orchestration/scene-utils';
const DISPATCH = '../node_modules/@animastor/orchestration/src/runtime/dispatch-engine';
const DB = '../src/storage/postgres/database';
const REPO = '../src/storage/postgres/repositories/scene-assets-repo';

const UNIT_MODULES = [ORCH, CALLBACKS, SCENE_UTILS, DISPATCH, DB, REPO];
// PG-слой: реальные db/repo, только колбэки/диспетчер/логи застаблены.
const E2E_MODULES = [ORCH, CALLBACKS, SCENE_UTILS, DISPATCH];

const BOOK = 'test147-a1-unit';
const E2E_BOOK = 'test147-a1-e2e';
const CHAPTER = 'ch-147';
const SCENE = 'sc-147';
const BUILD = 'build_147_a1';

function saveCache(modules) {
    const saved = new Map();
    for (const m of modules) {
        const resolved = require.resolve(m);
        saved.set(resolved, require.cache[resolved]);
        delete require.cache[resolved];
    }
    return saved;
}

function restoreCache(saved) {
    for (const [resolved, entry] of saved) {
        if (entry) require.cache[resolved] = entry;
        else delete require.cache[resolved];
    }
}

function stubModule(request, exports) {
    const resolved = require.resolve(request);
    require.cache[resolved] = { exports, loaded: true };
}

// ======================================================
// Слой 1 — юнит: логика gate без PG
// ======================================================
describe('Stage 147 (A1): completeStage version-gate — fallback на NULL-build строку', () => {
    let redis;
    let saved;
    let calls;

    const artifactPath = `${require('../src/config/runtime-config').OUTPUT_DIR}/${BUILD}/scene_a1.png`;

    beforeEach(() => {
        redis = createMockRedis();
        saved = saveCache(UNIT_MODULES);
        calls = { handler: 0, markReady: [], nullBuildReads: [] };

        stubModule(CALLBACKS, {
            STAGE_HANDLERS: {
                image: async () => {
                    calls.handler += 1;
                    return { ok: true, artifact: { buildId: BUILD, path: artifactPath } };
                },
                audio: async () => {
                    calls.handler += 1;
                    return { ok: true, artifact: { buildId: BUILD, path: artifactPath } };
                },
            },
        });
        stubModule(DISPATCH, {
            verifyDispatchIdentity: async () => ({ valid: true, metadata: {} }),
            finalizeDispatch: async (r, b, c, s, stage, opts) => {
                calls.finalize = { stage, opts };
                return { finalized: true };
            },
        });
        stubModule(SCENE_UTILS, { log: () => {}, warn: () => {}, error: () => {}, logEvent: async () => {} });

        // scenes-строка версии читается адаптером напрямую через database.query
        stubModule(DB, {
            query: async () => ({ rows: [{ content_version: 5, audio_config_version: 5 }] }),
        });

        // Репозиторий: getAsset «промахивается» по build_id (строки того
        // билда нет); getAssetNullBuild/markReady задаются per-test.
        stubModule(REPO, {
            getAsset: async () => undefined,
            getAssetNullBuild: async (...args) => {
                calls.nullBuildReads.push(args);
                return calls.nullRow;
            },
            markReady: async (...args) => {
                calls.markReady.push(args);
                return { id: 1, status: 'ready', path: args[4], build_id: BUILD };
            },
        });
    });

    afterEach(() => {
        restoreCache(saved);
    });

    async function runGate() {
        const orchestrator = require(ORCH);
        return orchestrator.completeStage(redis, BOOK, CHAPTER, SCENE, 'image', BUILD, 'dispatch-a1');
    }

    // Воспроизведение цикла: строка build_id = NULL с подтверждённой
    // версией. До фикса gate не видит строку → DIRTY (тест падает);
    // после — READY с одного вызова и markReady вызван для простановки
    // build_id/path.
    it('A1-репро: NULL-строка с подтверждённой версией → READY с одного вызова, markReady вызван', async () => {
        calls.nullRow = { build_id: null, scene_content_version: 5, scene_audio_config_version: 5 };

        const result = await runGate();

        expect(result.completed, 'gate должен пропустить READY с первого вызова').to.be.true;
        expect(result.reason).to.be.null;
        expect(calls.markReady, 'markReady должен быть вызван (build_id/path)').to.have.length(1);
        expect(calls.markReady[0].slice(0, 5)).to.deep.equal([BOOK, CHAPTER, SCENE, 'image', artifactPath]);
        expect(calls.markReady[0][5], 'extras не передаются — логика markReady прежняя').to.be.undefined;
        // Дополнительное чтение — ровно одно и только того же ключа
        // (без buildId в аргументах: это чтение build_id IS NULL, а не билда).
        expect(calls.nullBuildReads).to.have.length(1);
        expect(calls.nullBuildReads[0]).to.deep.equal([BOOK, CHAPTER, SCENE, 'image']);
        expect(calls.finalize.opts.outcome).to.equal('success');
    });

    it('NULL-строка с устаревшей версией (2 < 5) → не READY', async () => {
        calls.nullRow = { build_id: null, scene_content_version: 2, scene_audio_config_version: 2 };

        const result = await runGate();

        expect(result.completed).to.be.false;
        expect(result.reason).to.equal('stale');
        expect(calls.markReady).to.have.length(0);
        expect(calls.finalize.opts.outcome).to.equal('success'); // финализация success, фаза stale
    });

    it('аудио: NULL-строка без подтверждённой audio-версии → не READY (правила прежние)', async () => {
        calls.nullRow = { build_id: null, scene_content_version: 5, scene_audio_config_version: 4 };
        const orchestrator = require(ORCH);

        const result = await orchestrator.completeStage(redis, BOOK, CHAPTER, SCENE, 'audio', BUILD, 'dispatch-a1');

        expect(result.completed).to.be.false;
        expect(result.reason).to.equal('stale');
        expect(calls.markReady).to.have.length(0);
    });

    // Строка другого билда не используется как доказательство: основное
    // чтение промахнулось (билда нет), NULL-строки тоже нет — gate
    // остаётся fail-closed, хотя у ключа может быть versioned-строка
    // другого билда.
    it('строка другого билда не доказывает версии: нет NULL-строки → не READY', async () => {
        calls.nullRow = null; // у ключа есть только строка чужого билда (её не вернул ни один из двух чтений)

        const result = await runGate();

        expect(result.completed).to.be.false;
        expect(result.reason).to.equal('stale');
        expect(calls.markReady).to.have.length(0);
        expect(calls.nullBuildReads).to.have.length(1); // fallback всё равно запрошен — и не нашёл NULL-строки
    });

    it('основное чтение нашло строку этого билда → fallback НЕ выполняется', async () => {
        const repoPath = require.resolve(REPO);
        calls.nullRow = { build_id: null, scene_content_version: 5, scene_audio_config_version: 5 };
        require.cache[repoPath].exports.getAsset = async () => ({
            build_id: BUILD, scene_content_version: 5, scene_audio_config_version: 5,
        });

        const result = await runGate();

        expect(result.completed).to.be.true;
        expect(calls.nullBuildReads, 'дополнительное чтение нужно только при промахе').to.have.length(0);
        expect(calls.markReady).to.have.length(1);
    });

    it('ошибка PG при чтении scenes → fail-closed (не READY)', async () => {
        calls.nullRow = { build_id: null, scene_content_version: 5, scene_audio_config_version: 5 };
        stubModule(DB, { query: async () => { throw new Error('pg down'); } });

        const result = await runGate();

        expect(result.completed).to.be.false;
        expect(result.reason).to.equal('stale');
        expect(calls.markReady).to.have.length(0);
    });

    it('ошибка PG при fallback-чтении NULL-строки → fail-closed (не READY)', async () => {
        const repoPath = require.resolve(REPO);
        require.cache[repoPath].exports.getAsset = async () => undefined;
        require.cache[repoPath].exports.getAssetNullBuild = async () => {
            throw new Error('pg down (null-build read)');
        };

        const result = await runGate();

        expect(result.completed).to.be.false;
        expect(result.reason).to.equal('stale');
        expect(calls.markReady).to.have.length(0);
    });
});

// ======================================================
// Слой 2 — PG-интеграция: реальный репозиторий, реальный markReady
// ======================================================
describe('Stage 147 (A1): PG-интеграция — NULL-строка чинится через READY', () => {
    const query = () => require(DB).query;
    let redis;
    let saved;
    const artifactPath = `${require('../src/config/runtime-config').OUTPUT_DIR}/${BUILD}/scene_a1_e2e.png`;

    before(async () => {
        const postgres = require('../src/storage/postgres');
        await postgres.initialize();
    });

    beforeEach(() => {
        redis = createMockRedis();
        saved = saveCache(E2E_MODULES);
        stubModule(CALLBACKS, {
            STAGE_HANDLERS: {
                image: async () => ({ ok: true, artifact: { buildId: BUILD, path: artifactPath } }),
            },
        });
        stubModule(DISPATCH, {
            verifyDispatchIdentity: async () => ({ valid: true, metadata: {} }),
            finalizeDispatch: async () => ({ finalized: true }),
        });
        stubModule(SCENE_UTILS, { log: () => {}, warn: () => {}, error: () => {}, logEvent: async () => {} });
    });

    afterEach(async () => {
        restoreCache(saved);
        await query()('DELETE FROM scene_assets WHERE book_id = $1', [E2E_BOOK]);
        await query()('DELETE FROM scenes WHERE book_id = $1', [E2E_BOOK]);
    });

    async function seedScene(contentVersion = 5) {
        await query()(
            `INSERT INTO scenes (book_id, chapter_id, scene_id, content_version,
                                 audio_config_version, is_dirty, dirty_unit_ids, updated_at)
             VALUES ($1, $2, $3, $4, $4, false, '{}', EXTRACT(EPOCH FROM NOW())::bigint)
             ON CONFLICT (book_id, chapter_id, scene_id) DO UPDATE
                 SET content_version = EXCLUDED.content_version,
                     audio_config_version = EXCLUDED.audio_config_version`,
            [E2E_BOOK, CHAPTER, SCENE, contentVersion]
        );
    }

    async function seedNullRow({ contentVersion = 5, audioVersion = 5, status = 'stale' } = {}) {
        await query()(
            `INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, path,
                                       build_id, status, scene_content_version,
                                       scene_audio_config_version, updated_at)
             VALUES ($1, $2, $3, 'image', 'legacy_scene_a1.png', NULL, $4, $5, $6,
                     EXTRACT(EPOCH FROM NOW())::bigint)`,
            [E2E_BOOK, CHAPTER, SCENE, status, contentVersion, audioVersion]
        );
    }

    async function seedOtherBuildRow() {
        await query()(
            `INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, path,
                                       build_id, status, scene_content_version,
                                       scene_audio_config_version, updated_at)
             VALUES ($1, $2, $3, 'image', 'other_build/scene.png', 'build_other', 'ready', 5, 5,
                     EXTRACT(EPOCH FROM NOW())::bigint)`,
            [E2E_BOOK, CHAPTER, SCENE]
        );
    }

    async function imageRows() {
        const r = await query()(
            `SELECT id, path, build_id, status, scene_content_version
             FROM scene_assets WHERE book_id = $1 AND asset_type = 'image' ORDER BY id`,
            [E2E_BOOK]
        );
        return r.rows;
    }

    async function runGate() {
        const orchestrator = require(ORCH);
        return orchestrator.completeStage(redis, E2E_BOOK, CHAPTER, SCENE, 'image', BUILD, 'dispatch-a1-e2e');
    }

    // Репро цикла: единственная строка ключа — NULL, версии подтверждены.
    // До фикса: DIRTY и цикл каждые 5 с. После: READY с одного вызова,
    // markReady создаёт versioned-строку с build_id из артефактного пути.
    it('A1-репро: NULL-строка (версия подтверждена) → READY + build_id проставлен, legacy-строка не тронута', async () => {
        await seedScene(5);
        await seedNullRow({ contentVersion: 5, audioVersion: 5 });

        const result = await runGate();

        expect(result.completed, 'gate должен пройти с первого вызова').to.be.true;

        const rows = await imageRows();
        const versioned = rows.find((r) => r.build_id === BUILD);
        expect(versioned, 'markReady должен создать строку с build_id из артефактного пути').to.exist;
        expect(versioned.status).to.equal('ready');
        expect(versioned.path).to.equal(artifactPath);

        const legacy = rows.find((r) => r.build_id === null);
        expect(legacy, 'legacy NULL-строка не удаляется и не перепривязывается (контракт Stage 66)').to.exist;
        expect(legacy.path).to.equal('legacy_scene_a1.png');
    });

    // Идемпотентность по реальной последовательности «dispatch → stamp →
    // completion»: повторный цикл (как после любых реальных re-dispatch)
    // не плодит строки и не ломает READY. Прямой повторный completeStage
    // БЕЗ dispatch-штампа закономерно DIRTY (versioned-строка после первого
    // markReady ещё не проштампована версиями — штампует Step 5.5 каждого
    // dispatch, см. stage50/stage147), поэтому здесь между вызовами
    // выполняется тот же штамп, что и перед каждым реальным dispatch.
    it('идемпотентен через цикл «dispatch stamp → completion» (реальная последовательность)', async () => {
        await seedScene(5);
        await seedNullRow({ contentVersion: 5, audioVersion: 5 });

        const first = await runGate();
        expect(first.completed).to.be.true;

        // Step 5.5 реального dispatch: штамп текущих версий сцены на все
        // строки ключа (включая только что созданную versioned-строку)
        const repo = require('../src/storage/postgres/repositories/scene-assets-repo');
        await repo.stampSceneVersionsForDispatch(E2E_BOOK, CHAPTER, SCENE, 'image');

        const second = await runGate();
        expect(second.completed).to.be.true;
        expect((await imageRows()).filter((r) => r.build_id === BUILD)).to.have.length(1);
    });

    it('NULL-строка с устаревшей версией → DIRTY, versioned-строка не создаётся', async () => {
        await seedScene(5);
        await seedNullRow({ contentVersion: 2, audioVersion: 2 });

        const result = await runGate();

        expect(result.completed).to.be.false;
        expect(result.reason).to.equal('stale');
        expect((await imageRows()).filter((r) => r.build_id === BUILD)).to.have.length(0);
    });

    it('строка только другого билда (версии подтверждены) → DIRTY: чужой билд — не доказательство', async () => {
        await seedScene(5);
        await seedOtherBuildRow();

        const result = await runGate();

        expect(result.completed).to.be.false;
        expect(result.reason).to.equal('stale');
        const rows = await imageRows();
        expect(rows.filter((r) => r.build_id === BUILD)).to.have.length(0);
        expect(rows.find((r) => r.build_id === 'build_other').status).to.equal('ready');
    });

    it('строка другого билда И NULL-строка → доказывает только NULL-строка', async () => {
        await seedScene(5);
        await seedOtherBuildRow();
        await seedNullRow({ contentVersion: 5, audioVersion: 5 });

        const result = await runGate();

        expect(result.completed).to.be.true;
        expect((await imageRows()).filter((r) => r.build_id === BUILD)).to.have.length(1);
    });

    it('repositorий-контракт: getAssetNullBuild возвращает только build_id IS NULL того же ключа', async () => {
        await seedScene(5);
        await seedOtherBuildRow(); // versioned-строка чужого билда, версии свежие
        await seedNullRow({ contentVersion: 3, audioVersion: 3 }); // NULL-строка с БОЛЕЕ старой версией

        const repo = require('../src/storage/postgres/repositories/scene-assets-repo');
        const nullRow = await repo.getAssetNullBuild(E2E_BOOK, CHAPTER, SCENE, 'image');

        expect(nullRow).to.exist;
        expect(nullRow.build_id).to.be.null;
        expect(nullRow.scene_content_version).to.equal(3); // не подменено версией чужой строки

        // Нет NULL-строки → null (чужой билд не подставляется)
        await query()('DELETE FROM scene_assets WHERE book_id = $1 AND build_id IS NULL', [E2E_BOOK]);
        expect(await repo.getAssetNullBuild(E2E_BOOK, CHAPTER, SCENE, 'image')).to.be.null;
    });
});
