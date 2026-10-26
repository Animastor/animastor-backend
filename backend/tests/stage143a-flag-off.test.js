// ======================================================
// Stage 143a (phase 1) — feature flag OFF (condition 2)
// ======================================================
//
// With IU_IMAGE_VERSIONED unset/off (the default, and the production state
// for this stage) the new versioned contour must:
//   • issue ZERO new PostgreSQL calls (every entrypoint short-circuits
//     BEFORE any query — verified with a spy on the pool handle);
//   • leave legacy behavior byte-identical (canonical disk probes/scans,
//     the dispatcher, the player resolver).
//
// Isolated PostgreSQL only matters here for the spy target — no query is
// ever allowed to reach it.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const database = require('../src/storage/postgres/database');
const pointerRepo = require('../src/storage/postgres/repositories/iu-image-pointer-repo');
const registry = require('../src/image/registry');

const RES = {
    bookId: 'b143aoff', chapterId: 'ch-1', sceneId: 'sc-1',
    iuId: 'iu-1', buildId: 'build-143a',
};

let savedFlag;
let queryCalls = [];
const originalQuery = database.query;

function spyOnQueries() {
    queryCalls = [];
    database.query = (...args) => {
        queryCalls.push(String(args[0]));
        return originalQuery.apply(database, args);
    };
}

function restoreQueries() {
    database.query = originalQuery;
}

describe('stage143a — flag OFF: no new PG calls, legacy behavior intact', function () {
    this.timeout(20000);

    before(() => {
        savedFlag = process.env.IU_IMAGE_VERSIONED;
        delete process.env.IU_IMAGE_VERSIONED;
        spyOnQueries();
    });

    after(() => {
        restoreQueries();
        if (savedFlag !== undefined) process.env.IU_IMAGE_VERSIONED = savedFlag;
    });

    afterEach(() => {
        queryCalls = [];
    });

    it('the flag reads off for unset / "0" / "false" / "off"', () => {
        delete process.env.IU_IMAGE_VERSIONED;
        expect(pointerRepo.versionedEnabled()).to.equal(false);
        for (const v of ['0', 'false', 'OFF', 'no', '']) {
            process.env.IU_IMAGE_VERSIONED = v;
            expect(pointerRepo.versionedEnabled(), `value ${JSON.stringify(v)}`).to.equal(false);
        }
        delete process.env.IU_IMAGE_VERSIONED;
        for (const v of ['1', 'true', 'on']) {
            process.env.IU_IMAGE_VERSIONED = v;
            expect(pointerRepo.versionedEnabled(), `value ${JSON.stringify(v)}`).to.equal(true);
        }
        delete process.env.IU_IMAGE_VERSIONED;
    });

    it('every versioned entrypoint returns a disabled verdict with ZERO PG calls', async () => {
        expect(queryCalls.length).to.equal(0);

        const reserve = await pointerRepo.reserveDispatchFence({
            idemKey: 'f'.repeat(64), ...RES,
        });
        expect(reserve.status).to.equal('disabled');

        const admission = await pointerRepo.resolveCallbackFence({ idemKey: 'f'.repeat(64), ...RES });
        expect(admission.ok).to.equal(false);
        expect(admission.reason).to.equal('versioned_disabled');

        const published = await pointerRepo.publishIuImagePointer({ ...RES, relPath: 'x.png', fence: 3 });
        expect(published.published).to.equal(false);
        expect(published.reason).to.equal('versioned_disabled');

        expect(await pointerRepo.getIuImagePointer(RES)).to.equal(null);
        expect(await pointerRepo.listPublishedIuIds(RES)).to.deep.equal([]);
        expect(await pointerRepo.listScenePointerPaths(RES)).to.deep.equal([]);

        // Player-facing resolvers (image facade seams).
        expect(await registry.resolveIuImagePath('/nowhere', RES.buildId, RES.bookId, RES.chapterId, RES.sceneId, RES.iuId))
            .to.equal(null);
        expect(await registry.resolveVersionedSceneProof('/nowhere', RES.buildId, RES.bookId, RES.chapterId, RES.sceneId))
            .to.equal(null);

        expect(queryCalls, 'flag OFF ⇒ not a single new PG call').to.deep.equal([]);
    });

    it('legacy canonical probe/scan behavior is unchanged with the flag OFF', () => {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'stage143a-legacy-'));
        try {
            const build = 'build-143a';
            fs.mkdirSync(path.join(out, build), { recursive: true });
            const name = `${RES.bookId}_${RES.chapterId}_${RES.sceneId}_iu-1.png`;
            expect(registry.probeIUImage(`${RES.bookId}_${RES.chapterId}_${RES.sceneId}_iu-1`, build, out))
                .to.deep.equal({ image: false, path: null });
            fs.writeFileSync(path.join(out, build, name), 'png-bytes');

            const hit = registry.probeIUImage(`${RES.bookId}_${RES.chapterId}_${RES.sceneId}_iu-1`, build, out);
            expect(hit.image).to.equal(true);
            expect(hit.path).to.equal(path.join(out, build, name));

            const scene = registry.resolveCanonicalSceneImage(out, build, RES.bookId, RES.chapterId, RES.sceneId);
            expect(scene).to.equal(name);
            expect(queryCalls, 'legacy probes stay disk-only').to.deep.equal([]);
        } finally {
            fs.rmSync(out, { recursive: true, force: true });
        }
    });

    it('the dispatcher gates its reservation on the flag (source contract)', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'runtime', 'gpu-dispatcher.js'), 'utf8');
        const kindIdx = src.indexOf("parsed.kind === 'iu_image'");
        const reserveIdx = src.indexOf('reserveDispatchFence');
        expect(kindIdx).to.be.above(0);
        expect(reserveIdx).to.be.above(kindIdx);
        expect(src.slice(kindIdx, reserveIdx), 'reservation is unreachable while the flag is off')
            .to.match(/versionedEnabled\(\)/);
    });

    it('the migration itself is flag-gated (schema.js is the only DDL owner)', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'storage', 'postgres', 'schema.js'), 'utf8');
        const gateIdx = src.indexOf('iuImageVersionedEnabled') >= 0
            ? src.indexOf('iuImageVersionedEnabled')
            : src.indexOf('versionedEnabled()');
        const ddlIdx = src.indexOf('iu_image_fence_reservations');
        expect(gateIdx, 'schema.js must consult the flag').to.be.above(0);
        expect(ddlIdx, 'the DDL lives in schema.js (guardrail PG-5)').to.be.above(0);
        expect(gateIdx, 'the flag check must precede the DDL execution').to.be.below(ddlIdx);
    });
});
