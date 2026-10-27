// ======================================================
// STAGE 147 — A1 REGRESSION: version-gate must see the build_id IS NULL row
// ======================================================
// A1 (stage146 §5.4): the key's only scene_assets row had build_id = NULL.
// completeStage read the asset via sceneAssets.getAsset(..., buildId) —
// which filters `build_id = $5` — so the row was invisible; markReady, the
// ONLY writer able to stamp build_id (buildIdFromArtifactPath), runs BEHIND
// the gate. Result: endless DIRTY + re-dispatch every 5 s scheduler tick
// (cache_hit → callback → "stale" → DIRTY).
//
// The fix (orchestrator.completeStage): when the build-scoped read misses,
// perform exactly ONE additional read of the SAME key with build_id IS NULL
// (port op sceneAssets.getAssetNullBuild — never another build's row, never
// "latest any row"), apply the SAME version rules, then let markReady stamp
// build_id as before.
//
// On the PRE-FIX code tests 1 and 2 FAIL (gate stays DIRTY / fallback op
// never consulted); they PASS with the fix. Fail-closed on PG errors is
// preserved for both reads.
// ======================================================

const { expect } = require('chai');
const { bindHostModules } = require('../src/host/host-bindings');
const {
    OPS, setPersistencePort, _resetPersistencePort,
} = require('../src/runtime/persistence-port');
const { createMockRedis } = require('./mocks/redis-mock');

const ORCH = require.resolve('../src/orchestration/orchestrator');
const CALLBACKS = require.resolve('../src/orchestration/scene-callbacks');
const DISPATCH = require.resolve('../src/runtime/dispatch-engine');

const BOOK = 'book-a1';
const CHAPTER = 'ch-a1';
const SCENE = 'sc-a1';
const BUILD = 'build_a1';
const ARTIFACT = `/data/output/${BUILD}/scene_a1.png`;
const SCENE_VERSIONS = [{ content_version: 5, audio_config_version: 5 }];

// Port adapter built from the declared OPS (contract completeness is
// asserted implicitly: setPersistencePort fails fast on any missing op).
function makeAdapter(overrides = {}) {
    const adapter = {};
    for (const op of OPS) {
        const noop = async () => null;
        const [ns, fn] = op.includes('.') ? op.split('.') : [null, op];
        if (ns === null) adapter[fn] = overrides[op] || noop;
        else {
            adapter[ns] = adapter[ns] || {};
            adapter[ns][fn] = (overrides[op]) || noop;
        }
    }
    return adapter;
}

describe('Stage 147 — A1: version-gate fallback на строку build_id IS NULL (пакет)', function () {
    this.timeout(10000);

    let redis;
    let calls;
    let savedCache;

    function stubModule(resolvedPath, exports) {
        savedCache.set(resolvedPath, require.cache[resolvedPath]);
        require.cache[resolvedPath] = { exports, loaded: true };
    }

    beforeEach(() => {
        redis = createMockRedis();
        calls = { markReady: [], nullBuildReads: [] };
        savedCache = new Map();
        for (const p of [CALLBACKS, DISPATCH]) {
            savedCache.set(p, require.cache[p]);
            delete require.cache[p];
        }

        // Host seams the gate path touches (state restore after READY).
        bindHostModules({
            config: () => ({ OUTPUT_DIR: '/data/output' }),
            state: () => ({
                AssetState: {
                    NEW: 'new', DIRTY: 'dirty', PENDING: 'pending',
                    GENERATING: 'generating', READY: 'ready', FAILED: 'failed',
                },
                unsafeRestoreAssetState: async (r, b, c, s, asset, status) => {
                    calls.stateWrite = { asset, status };
                },
            }),
            journal: () => ({ EventType: {}, appendSceneEvent: async () => {} }),
        });

        stubModule(CALLBACKS, {
            STAGE_HANDLERS: {
                image: async () => ({ ok: true, artifact: { buildId: BUILD, path: ARTIFACT } }),
            },
        });
        stubModule(DISPATCH, {
            verifyDispatchIdentity: async () => ({ valid: true, metadata: {} }),
            finalizeDispatch: async (r, b, c, s, stage, opts) => {
                calls.finalize = { stage, opts };
                return { finalized: true };
            },
        });

        setPersistencePort(makeAdapter({
            'sceneVersions.getSceneVersions': async () => SCENE_VERSIONS,
            'sceneAssets.getAsset': async () => (calls.buildRow === undefined ? null : calls.buildRow),
            'sceneAssets.getAssetNullBuild': async (...args) => {
                calls.nullBuildReads.push(args);
                if (calls.nullRowError) throw calls.nullRowError;
                return calls.nullRow || null;
            },
            'sceneAssets.markReady': async (...args) => {
                calls.markReady.push(args);
                return { status: 'ready' };
            },
        }));
    });

    afterEach(() => {
        for (const [p, entry] of savedCache) {
            if (entry) require.cache[p] = entry;
            else delete require.cache[p];
        }
        _resetPersistencePort();
        calls = {};
        // Возврат fail-fast дефолтов из test/test-bindings.js
        bindHostModules({
            journal: () => {
                throw new Error('[ORCH-TEST-BINDINGS] host journal not wired — wire it in the test that asserts journal behavior');
            },
        });
    });

    async function runGate(stage = 'image') {
        const orchestrator = require(ORCH);
        return orchestrator.completeStage(redis, BOOK, CHAPTER, SCENE, stage, BUILD, 'dispatch-a1');
    }

    it('1. NULL-строка с подтверждённой версией → READY с одного вызова, markReady вызван', async () => {
        calls.buildRow = null; // getAsset(buildId) промахнулся
        calls.nullRow = { build_id: null, scene_content_version: 5, scene_audio_config_version: 5 };

        const result = await runGate();

        expect(result.completed, 'fallback-чтение должно пропустить READY').to.be.true;
        expect(calls.markReady).to.have.length(1);
        expect(calls.markReady[0].slice(0, 5)).to.deep.equal([BOOK, CHAPTER, SCENE, 'image', ARTIFACT]);
        expect(calls.nullBuildReads, 'дополнительное чтение — ровно одно').to.have.length(1);
        expect(calls.nullBuildReads[0]).to.deep.equal([BOOK, CHAPTER, SCENE, 'image']);
        expect(calls.stateWrite).to.deep.equal({ asset: 'image', status: 'ready' });
        expect(calls.finalize.opts.outcome).to.equal('success');
    });

    it('2. NULL-строка с устаревшей версией (2 < 5) → не READY', async () => {
        calls.buildRow = null;
        calls.nullRow = { build_id: null, scene_content_version: 2, scene_audio_config_version: 2 };

        const result = await runGate();

        expect(result.completed).to.be.false;
        expect(result.reason).to.equal('stale');
        expect(calls.markReady).to.have.length(0);
        expect(calls.stateWrite).to.deep.equal({ asset: 'image', status: 'dirty' });
    });

    it('3. строки этого билда нет, NULL-строки нет (только чужой билд) → не READY', async () => {
        calls.buildRow = null;
        calls.nullRow = null;

        const result = await runGate();

        expect(result.completed).to.be.false;
        expect(result.reason).to.equal('stale');
        expect(calls.markReady).to.have.length(0);
        expect(calls.nullBuildReads).to.have.length(1);
    });

    it('4. строка этого билда найдена → fallback не выполняется', async () => {
        calls.buildRow = { build_id: BUILD, scene_content_version: 5, scene_audio_config_version: 5 };
        calls.nullRow = { build_id: null, scene_content_version: 5, scene_audio_config_version: 5 };

        const result = await runGate();

        expect(result.completed).to.be.true;
        expect(calls.nullBuildReads).to.have.length(0);
        expect(calls.markReady).to.have.length(1);
    });

    it('5. ошибка PG при основном чтении → fail-closed', async () => {
        const adapter = require('../src/runtime/persistence-port').persistence();
        adapter.sceneAssets.getAsset = async () => { throw new Error('pg down'); };
        calls.nullRow = { build_id: null, scene_content_version: 5, scene_audio_config_version: 5 };

        const result = await runGate();

        expect(result.completed).to.be.false;
        expect(calls.markReady).to.have.length(0);
    });

    it('6. ошибка PG при fallback-чтении → fail-closed', async () => {
        calls.buildRow = null;
        calls.nullRowError = new Error('pg down (null-build read)');

        const result = await runGate();

        expect(result.completed).to.be.false;
        expect(result.reason).to.equal('stale');
        expect(calls.markReady).to.have.length(0);
    });
});
