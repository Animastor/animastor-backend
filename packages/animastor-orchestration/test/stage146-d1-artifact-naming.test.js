// ======================================================
// STAGE 146 — D1 REGRESSION: artifactNaming must be visible to resetScenes
// ======================================================
// D1: `const artifactNaming = require('@animastor/generation').artifactNaming;`
// used to live INSIDE beginStage(). resetScenes() also reads it (step 6 — the
// stale-PNG/preview pre-delete branch, formerly lines 534/537/555), so on the
// pre-fix code that branch threw `ReferenceError: artifactNaming is not
// defined` and /regenerate returned HTTP 500.
//
// This test exercises EXACTLY that branch on the fresh package sources:
//   • resetScenes() with a dirty unit and cleanPngUnitIds reaches step 6;
//   • it must NOT throw;
//   • it must delete the old PNG AND the old preview for that unit.
//
// The test FAILS on the pre-fix code (the ReferenceError escapes resetScenes —
// step 6 is not wrapped in try/catch) and PASSES once artifactNaming is hoisted
// to module scope.
// ======================================================

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bindHostModules } = require('../src/host/host-bindings');
const { setHubCancelPort, _resetHubCancelPort } = require('../src/runtime/hub-cancel-port');
const { createMockRedis } = require('./mocks/redis-mock');
const artifactNaming = require('@animastor/generation').artifactNaming;

const orchestrator = require('../src/orchestration/orchestrator');

const BOOK = 'b1';
const CHAPTER = 'ch1';
const SCENE = 'sc1';
const BUILD = 'build1';
const UID = 'iu_001';

describe('Stage 146 — D1: resetScenes reads artifactNaming at module scope', function () {
    this.timeout(10000);

    let tmpRoot;
    let redis;

    before(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage146-d1-'));
        redis = createMockRedis();
        // resetScenes reaches the PNG-delete branch through these two seams.
        bindHostModules({
            config: () => ({
                OUTPUT_DIR: tmpRoot,
                TIMEOUTS: { FORCE_DISPATCH_TTL_S: 3600 },
            }),
            journal: () => ({
                EventType: { SCENE_RESET: 'SCENE_RESET', SCENE_RESET_COMPLETED: 'SCENE_RESET_COMPLETED' },
                appendSceneEvent: async () => {},
            }),
        });
        setHubCancelPort({ clearHubDispatches: async () => ({ requested: 0, cleared: 0, failed: 0 }) });
    });

    after(() => {
        _resetHubCancelPort();
        // Restore the fail-fast default from test/test-bindings.js.
        bindHostModules({
            config: () => { throw new Error('[D1-TEST] config unwired'); },
            journal: () => { throw new Error('[D1-TEST] journal unwired'); },
        });
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('removes the stale PNG and preview of a dirty unit without throwing', async () => {
        const buildDir = path.join(tmpRoot, BUILD);
        fs.mkdirSync(buildDir, { recursive: true });

        const pngPath = path.join(buildDir, artifactNaming.sceneImageName(BOOK, CHAPTER, SCENE, UID));
        const previewPath = path.join(buildDir, artifactNaming.sceneImagePreviewName(BOOK, CHAPTER, SCENE, UID));
        fs.writeFileSync(pngPath, 'png-bytes');
        fs.writeFileSync(previewPath, 'preview-bytes');
        expect(fs.existsSync(pngPath), 'fixture PNG must exist').to.equal(true);
        expect(fs.existsSync(previewPath), 'fixture preview must exist').to.equal(true);

        const scenes = [{ chapter_id: CHAPTER, scene_id: SCENE, dirty_layers: ['image'] }];
        const layerCfg = { image_enabled: true };
        const bookDiff = { markDirtyScenes: async () => ({ marked: 1 }) };

        const res = await orchestrator.resetScenes(
            redis, BOOK, BUILD, scenes, layerCfg,
            {
                scope: 'SCENE',
                chapterId: CHAPTER,
                sceneId: SCENE,
                bookDiff,
                cleanPngUnitIds: { [`${CHAPTER}_${SCENE}`]: [UID] },
            }
        );

        expect(res.reset_scenes).to.equal(1);
        expect(res.marked).to.equal(1);
        // The pre-fix bug threw before this point, so these two assertions are
        // what the regression pins down.
        expect(fs.existsSync(pngPath), 'old PNG must be deleted').to.equal(false);
        expect(fs.existsSync(previewPath), 'old preview must be deleted').to.equal(false);
    });
});
