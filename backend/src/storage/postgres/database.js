const { Pool } = require('pg');

const POOL_CONFIG = {
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432', 10),
    database: process.env.PG_DB || 'animastor',
    user: process.env.PG_USER || 'animastor',
    // No default: a missing PG_PASSWORD must fail loudly, not fall back to a
    // well-known password (see assertPasswordConfigured below).
    password: process.env.PG_PASSWORD,
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

// Outside NODE_ENV=test the password is mandatory. The test stack supplies
// it via backend/.env.test; a bare test run may still rely on PGPASSWORD.
function assertPasswordConfigured() {
    if (process.env.NODE_ENV === 'test') return;
    if (!POOL_CONFIG.password) {
        throw new Error(
            '[PG] PG_PASSWORD is not set: refusing to create the connection pool '
            + `(user "${POOL_CONFIG.user}", db "${POOL_CONFIG.database}"). `
            + 'Set PG_PASSWORD in the environment (.env / docker-compose).'
        );
    }
}

function getPool() {
    if (pool) return pool;
    assertNotProductionDbUnderTest();
    assertPasswordConfigured();
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
