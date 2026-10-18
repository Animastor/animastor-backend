// ======================================================
// Book versions route — GET /api/v1/book/:bookId/versions
// ======================================================
// Regression for Stage 71: the route referenced an undefined `assetResult`
// (crashed with 500 "assetResult is not defined" for every book). The fix
// iterates the actual `assetRows` returned by getSceneAssetVersions.
// These tests pin the response contract across:
//   1. registered book WITH scenes + assets + versions
//   2. registered book WITHOUT any scenes/assets
//   3. unregistered (unknown / deleted) book → empty 200, no state resurrection
//   4. mismatch detection (outdated assets) + fallback when the repo's
//      getOutdatedByVersions throws (missing/erroneous build/version path)
//   5. repo hard-failure → 500 with the error surfaced (not a silent empty 200)

const { expect } = require('chai');
const express = require('express');

const registerVersionRoutes = require('../src/routes/book/versions-routes.cjs');

/** Build a stub sceneAssetsRepo with the four methods the route calls. */
function makeRepo(overrides = {}) {
    return {
        getSceneVersions: async () => [],
        getSceneAssetVersions: async () => [],
        getOutdatedByVersions: async () => [],
        ...overrides,
    };
}

/** Boot the real route with a stubbed ctx on an ephemeral port. */
function startServer(sceneAssetsRepo) {
    const app = express();
    registerVersionRoutes(app, { sceneAssetsRepo, log: () => {} });
    return new Promise((resolve) => {
        const server = app.listen(0, () => {
            resolve({
                base: `http://127.0.0.1:${server.address().port}`,
                close: () => new Promise((res) => server.close(res)),
            });
        });
    });
}

const GET = async (base, bookId) => {
    const res = await fetch(`${base}/api/v1/book/${bookId}/versions`);
    return { status: res.status, body: await res.json() };
};

describe('GET /api/v1/book/:bookId/versions (stage 71 regression)', () => {
    it('registered book with scenes + assets → 200, per-scene assets attached', async () => {
        const sceneRows = [
            {
                chapter_id: 'ch-1', scene_id: 'sc-1',
                content_version: 2, audio_config_version: 1,
                scene_hash: 'hash-a', updated_at: '2026-10-18T00:00:00Z',
            },
        ];
        const assetRows = [
            {
                chapter_id: 'ch-1', scene_id: 'sc-1', asset_type: 'image',
                scene_content_version: 2, scene_audio_config_version: 1,
                status: 'ready', build_id: 'build_ba_x',
            },
            {
                chapter_id: 'ch-1', scene_id: 'sc-1', asset_type: 'audio',
                scene_content_version: 1, scene_audio_config_version: 1,
                status: 'ready', build_id: 'build_ba_x',
            },
        ];
        const srv = await startServer(makeRepo({
            getSceneVersions: async () => sceneRows,
            getSceneAssetVersions: async () => assetRows,
        }));
        try {
            const { status, body } = await GET(srv.base, 'ba_x');
            expect(status).to.equal(200);
            expect(body.book_id).to.equal('ba_x');
            expect(body.scene_count).to.equal(1);
            // Regression: asset_count must reflect the real asset rows (the old
            // code threw before it could ever be computed).
            expect(body.asset_count).to.equal(2);
            expect(body.scenes).to.have.length(1);
            expect(body.scenes[0].chapter_id).to.equal('ch-1');
            expect(body.scenes[0].assets.map((a) => a.asset_type).sort())
                .to.deep.equal(['audio', 'image']);
            expect(body.scenes[0].assets.find((a) => a.asset_type === 'image').build_id)
                .to.equal('build_ba_x');
            expect(body.mismatches).to.deep.equal([]);
            expect(body.mismatch_count).to.equal(0);
        } finally {
            await srv.close();
        }
    });

    it('registered book without versions → 200, empty scenes + zero counts', async () => {
        const srv = await startServer(makeRepo());
        try {
            const { status, body } = await GET(srv.base, 'ba_empty');
            expect(status).to.equal(200);
            expect(body.book_id).to.equal('ba_empty');
            expect(body.scenes).to.deep.equal([]);
            expect(body.scene_count).to.equal(0);
            expect(body.asset_count).to.equal(0);
            expect(body.mismatches).to.deep.equal([]);
        } finally {
            await srv.close();
        }
    });

    it('unregistered / deleted book → 200 empty, no state resurrection', async () => {
        // A deleted book leaves no scenes/scene_assets rows. The endpoint is
        // read-only and must return an empty 200 — never cached or rebuilt data.
        const srv = await startServer(makeRepo());
        try {
            const { status, body } = await GET(srv.base, 'deleted_book_xyz');
            expect(status).to.equal(200);
            expect(body.scene_count).to.equal(0);
            expect(body.asset_count).to.equal(0);
            expect(body.scenes).to.deep.equal([]);
        } finally {
            await srv.close();
        }
    });

    it('detects version mismatches from getOutdatedByVersions', async () => {
        const sceneRows = [
            {
                chapter_id: 'ch-1', scene_id: 'sc-1',
                content_version: 3, audio_config_version: 1,
                scene_hash: 'h', updated_at: 't',
            },
        ];
        const srv = await startServer(makeRepo({
            getSceneVersions: async () => sceneRows,
            getOutdatedByVersions: async () => [{
                chapter_id: 'ch-1', scene_id: 'sc-1', asset_type: 'image',
                scene_content_version: 1, status: 'stale',
                _outdated_reason: 'content_version', _expected_version: 3,
            }],
        }));
        try {
            const { status, body } = await GET(srv.base, 'ba_m');
            expect(status).to.equal(200);
            expect(body.mismatch_count).to.equal(1);
            expect(body.mismatches[0]).to.include({
                key: 'ch-1/sc-1', type: 'content_version', asset_type: 'image',
            });
        } finally {
            await srv.close();
        }
    });

    it('falls back to inline comparison when getOutdatedByVersions throws', async () => {
        // Missing/erroneous build+version path: the repo's mismatch query fails.
        // The route must still serve 200 with a computed mismatch (fail-open on
        // the secondary comparison), not a 500.
        const sceneRows = [
            {
                chapter_id: 'ch-1', scene_id: 'sc-1',
                content_version: 3, audio_config_version: 2,
                scene_hash: 'h', updated_at: 't',
            },
        ];
        const assetRows = [
            {
                chapter_id: 'ch-1', scene_id: 'sc-1', asset_type: 'image',
                scene_content_version: 1, scene_audio_config_version: 1,
                status: 'stale', build_id: null,
            },
        ];
        const srv = await startServer(makeRepo({
            getSceneVersions: async () => sceneRows,
            getSceneAssetVersions: async () => assetRows,
            getOutdatedByVersions: async () => {
                throw new Error('missing build/version row');
            },
        }));
        try {
            const { status, body } = await GET(srv.base, 'ba_f');
            expect(status).to.equal(200);
            expect(body.asset_count).to.equal(1);
            // Inline fallback flags both stale content and audio versions.
            expect(body.mismatch_count).to.equal(2);
            const types = body.mismatches.map((m) => m.type).sort();
            expect(types).to.deep.equal(['audio_config_version', 'content_version']);
        } finally {
            await srv.close();
        }
    });

    it('repo hard-failure → 500 with error surfaced (not a silent empty 200)', async () => {
        const srv = await startServer(makeRepo({
            getSceneVersions: async () => {
                throw new Error('pg down');
            },
        }));
        try {
            const { status, body } = await GET(srv.base, 'ba_err');
            expect(status).to.equal(500);
            expect(body).to.have.property('error');
            expect(body.error).to.match(/pg down/);
        } finally {
            await srv.close();
        }
    });
});
