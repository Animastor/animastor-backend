const { Pool } = require('pg');

const POOL_CONFIG = {
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432', 10),
    database: process.env.PG_DB || 'animastor',
    user: process.env.PG_USER || 'animastor',
    password: process.env.PG_PASSWORD || 'animastor_secret_2026',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
};

let pool = null;

// Second line of defence behind tests/test-db-safety.cjs: under NODE_ENV=test
// never open a pool to the production database (the default above).
function assertNotProductionDbUnderTest() {
    if (process.env.NODE_ENV !== 'test') return;
    const db = process.env.PG_DB;
    if (!db || db === 'animastor' || !db.endsWith('_test')) {
        throw new Error(
            `[PG] refusing to connect under NODE_ENV=test: PG_DB="${db || ''}" `
            + '(must be set explicitly, end in "_test" and not be "animastor")'
        );
    }
}

function getPool() {
    if (pool) return pool;
    assertNotProductionDbUnderTest();
    pool = new Pool(POOL_CONFIG);
    pool.on('error', (err) => {
        console.error('[PG] Unexpected pool error:', err.message);
    });
    return pool;
}

async function closePool() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}

async function query(text, params) {
    const client = await getPool().connect();
    try {
        const result = await client.query(text, params);
        return result;
    } finally {
        client.release();
    }
}

async function withTransaction(work) {
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (_) {}
        throw err;
    } finally {
        client.release();
    }
}

module.exports = { getPool, closePool, query, withTransaction };
