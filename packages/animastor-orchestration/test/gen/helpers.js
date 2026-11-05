// ======================================================
// test/gen/helpers — clean PG schema per test on the animastor-test stack
// ======================================================
// Env: PG_HOST, PG_PORT, PG_DB, PG_USER, PG_PASSWORD (backend/.env.test).
// Safety (mirrors backend tests/test-db-safety.cjs): PG_DB must end in
// "_test", must not be "animastor", port must not be 5432. Every test gets a
// fresh schema gen_t_<random> holding minimal copies of the host tables the
// core touches (books, workers, scene_assets — column types as in backend
// schema.js) plus the v2 migration; it is dropped afterwards.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { Pool } = require('pg');

function assertTestDb() {
    const db = process.env.PG_DB;
    const port = Number(process.env.PG_PORT || 5432);
    if (!db || db === 'animastor' || !db.endsWith('_test')) {
        throw new Error(`[gen tests] refusing to run: PG_DB="${db}" must end in _test`);
    }
    if (port === 5432) throw new Error('[gen tests] refusing to run against port 5432');
}

function baseConfig() {
    assertTestDb();
    return {
        host: process.env.PG_HOST || '127.0.0.1',
        port: Number(process.env.PG_PORT),
        database: process.env.PG_DB,
        user: process.env.PG_USER,
        password: process.env.PG_PASSWORD,
        max: 10,
    };
}

// host tables (subset of backend storage/postgres/schema.js, same types/constraints)
const HOST_TABLES = [
    `CREATE TABLE books (
        book_id TEXT PRIMARY KEY, workspace_id UUID, user_id UUID, title TEXT,
        created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint), metadata JSONB)`,
    `CREATE TABLE workers (
        worker_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID, name TEXT NOT NULL DEFAULT 'w',
        worker_type TEXT NOT NULL CHECK(worker_type IN ('audio','image','video')),
        mode TEXT NOT NULL DEFAULT 'private' CHECK(mode IN ('private','share','system')),
        status TEXT NOT NULL DEFAULT 'offline' CHECK(status IN ('online','offline','busy','error')),
        token_hash TEXT NOT NULL UNIQUE DEFAULT md5(random()::text), revoked_at BIGINT, last_seen BIGINT, version TEXT,
        created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
        CONSTRAINT workers_scope_check CHECK (mode = 'system' OR workspace_id IS NOT NULL))`,
    `CREATE TABLE scene_assets (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        book_id TEXT NOT NULL, chapter_id TEXT NOT NULL, scene_id TEXT NOT NULL,
        asset_type TEXT NOT NULL CHECK(asset_type IN ('audio','image','video','storyboard','subtitle','preview','manifest')),
        path TEXT, duration_sec REAL, width INTEGER, height INTEGER, format TEXT, sample_rate INTEGER, channel_count INTEGER,
        chunks JSONB, build_id TEXT, scene_hash TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','stale','failed','missing','placeholder','cancelled')),
        error TEXT, metadata JSONB,
        created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
        updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
        UNIQUE(book_id, chapter_id, scene_id, asset_type, build_id))`,
];

const uuid = () => crypto.randomUUID();
const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name));
const streamOf = (buf) => Readable.from([buf]);

/** Decoder that returns the real ffmpeg decode of a fixture, recorded next to it (.s16le). */
async function fixtureDecodePcm(filePath) {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    for (const f of fs.readdirSync(FIXTURES).filter((x) => x.endsWith('.mp3'))) {
        if (crypto.createHash('sha256').update(fixture(f)).digest('hex') === sha) {
            const p = fixture(f.replace(/\.mp3$/, '.s16le'));
            return new Int16Array(p.buffer, p.byteOffset, p.length / 2);
        }
    }
    throw Object.assign(new Error('no recorded decode for this file'), { code: 'EDECODE' });
}

function hasFfmpeg() {
    const r = require('child_process').spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return r.status === 0;
}

/**
 * Make a fresh schema, host tables, migrate. Returns ctx with pool & helpers.
 */
async function setupDb({ migrate = true } = {}) {
    const schema = `gen_t_${crypto.randomBytes(6).toString('hex')}`;
    const admin = new Pool({ ...baseConfig(), max: 2 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ ...baseConfig(), options: `-c search_path=${schema}` });
    for (const sql of HOST_TABLES) await pool.query(sql);
    if (migrate) await require('../../src/gen').migrate(pool);
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-v2-'));
    return {
        schema, pool, admin, outputDir,
        async teardown() {
            await pool.end();
            await admin.query(`DROP SCHEMA ${schema} CASCADE`);
            await admin.end();
            fs.rmSync(outputDir, { recursive: true, force: true });
        },
        q: (sql, params) => pool.query(sql, params),
        newPool: () => new Pool({ ...baseConfig(), options: `-c search_path=${schema}` }),
    };
}

/**
 * Host ports for tests: a book = chapters → scenes → N audio chunks.
 * plan: { [chapter_id]: { [scene_id]: chunkCount } }
 */
function makePorts(ctx, plan, overrides = {}) {
    const calls = { runLocal: [], buildPayload: [] };
    const media = require('../../src/gen').defaults;
    const ports = {
        planUnits: async (book, scope, layer) => {
            const units = [];
            for (const [ch, scenes] of Object.entries(plan)) {
                if (scope.level === 'chapter' && scope.chapter_id !== ch) continue;
                for (const [sc, n] of Object.entries(scenes)) {
                    if ((scope.level === 'scene' || scope.level === 'unit') && scope.scene_id !== sc) continue;
                    if (layer === 'audio') {
                        for (let i = 1; i <= n; i += 1) {
                            units.push({
                                chapter_id: ch, scene_id: sc, kind: 'audio_chunk', unit_key: String(i).padStart(4, '0'),
                                scene_hash: `h-${sc}`, build_id: 'build-1', input: { text: `chunk ${i}` },
                            });
                        }
                    } else if (layer === 'image') {
                        units.push({ chapter_id: ch, scene_id: sc, kind: 'iu_image', unit_key: 'iu-1', scene_hash: `h-${sc}`, build_id: 'build-1', input: {} });
                    }
                }
            }
            return units;
        },
        buildPayload: async (job) => { calls.buildPayload.push(job.job_id); return { workflow: 'tts', text: job.input.text }; },
        artifactPath: (job) => path.join(ctx.outputDir, job.build_id,
            job.kind === 'audio_merge' ? `${job.book_id}_${job.chapter_id}_${job.scene_id}.mp3`
                : `${job.book_id}_${job.chapter_id}_${job.scene_id}_${job.unit_key}.mp3`),
        validateResult: media.createDefaultValidateResult({ decodePcm: fixtureDecodePcm, rmsThresholdDbfs: -60 }),
        runLocal: async (job) => {
            calls.runLocal.push(job.job_id);
            const out = path.join(ctx.outputDir, job.build_id, `merge-${job.job_id}.tmp.mp3`);
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, fixture('tone.mp3'));
            return { path: out };
        },
        laneFor: async (ws) => ({ kind: 'private', workspace_id: ws }),
        timeoutFor: media.timeoutFor,
        retryPolicy: media.retryPolicy,
        ...overrides,
    };
    return { ports, calls };
}

const SECRET = 'test-upload-secret-0123456789abcdef-xyz';

async function makeBook(ctx, { bookId = `book-${crypto.randomBytes(3).toString('hex')}`, workspaceId = uuid(), v2 = true } = {}) {
    await ctx.q(`INSERT INTO books (book_id, workspace_id, orchestration) VALUES ($1, $2, $3)`, [bookId, workspaceId, v2 ? 'v2' : 'legacy']);
    return { bookId, workspaceId, userId: uuid() };
}

async function makeWorker(ctx, { workspaceId = null, type = 'audio', mode = 'private' } = {}) {
    const r = await ctx.q(
        `INSERT INTO workers (workspace_id, worker_type, mode, last_seen) VALUES ($1, $2, $3, floor(extract(epoch from now()))::bigint) RETURNING worker_id`,
        [workspaceId, type, mode]);
    return r.rows[0].worker_id;
}

async function count(ctx, sql, params) {
    return Number((await ctx.q(sql, params)).rows[0].n);
}

module.exports = {
    setupDb, makePorts, makeBook, makeWorker, count, uuid, fixture, streamOf,
    fixtureDecodePcm, hasFfmpeg, SECRET, FIXTURES,
};
