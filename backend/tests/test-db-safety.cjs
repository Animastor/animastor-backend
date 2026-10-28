// ======================================================
// TEST DATABASE SAFETY — fail closed before any connection
// ======================================================
// Loaded FIRST from .mocharc.json. With no env, src/storage/postgres/database
// falls back to localhost:5432 / "animastor" — on the production host that is
// the live production database. Refuse to start the suite unless the env
// points at clearly separate test databases; throwing here aborts mocha
// before a single test file (and therefore any PG/Redis client) is loaded.
//
// Postgres: PG_DB (the variable database.js actually reads) must be set
// explicitly, end in "_test" and not be "animastor". PG_DATABASE, if set,
// must agree with it.
// Redis: REDIS_URL or REDIS_DB must be set explicitly and select a non-zero
// logical DB, or REDIS_URL / REDIS_PORT must use a port other than 6379.
//
// Example:
//   PG_DB=animastor_test PG_PORT=55432 REDIS_URL=redis://localhost:56379/15 npm test

const PROD_PG_DB = 'animastor';
const DEFAULT_REDIS_PORT = 6379;

function fail(msg) {
    throw new Error(
        `[test-db-safety] refusing to run tests: ${msg}\n`
        + '  Point the suite at dedicated test databases, e.g.\n'
        + '    PG_DB=animastor_test PG_PORT=55432 REDIS_URL=redis://localhost:56379/15 npm test'
    );
}

function checkPostgres(env) {
    const db = env.PG_DB;
    if (!db) fail('PG_DB is not set (database.js would fall back to the production "animastor" DB)');
    if (db === PROD_PG_DB) fail(`PG_DB="${db}" is the production database name`);
    if (!db.endsWith('_test')) fail(`PG_DB="${db}" must end in "_test"`);
    if (env.PG_DATABASE !== undefined && env.PG_DATABASE !== db) {
        fail(`PG_DATABASE="${env.PG_DATABASE}" disagrees with PG_DB="${db}"`);
    }
}

function checkRedis(env) {
    const url = env.REDIS_URL;
    let db = env.REDIS_DB;
    let port = env.REDIS_PORT;
    if (url) {
        let parsed;
        try { parsed = new URL(url); } catch (_) { fail(`REDIS_URL="${url}" is not a valid URL`); }
        const pathDb = parsed.pathname.replace(/^\//, '');
        if (pathDb) db = pathDb;
        if (parsed.port) port = parsed.port;
    } else if (db === undefined) {
        fail('neither REDIS_URL nor REDIS_DB is set');
    }
    const dbIndex = db === undefined ? 0 : Number(db);
    if (!Number.isInteger(dbIndex) || dbIndex < 0) fail(`Redis DB "${db}" is not a valid index`);
    const portNum = port === undefined ? DEFAULT_REDIS_PORT : Number(port);
    if (dbIndex === 0 && portNum === DEFAULT_REDIS_PORT) {
        fail(`Redis DB 0 on the default port ${DEFAULT_REDIS_PORT} — use a separate DB (/1../15) or a separate port`);
    }
}

checkPostgres(process.env);
checkRedis(process.env);

// Arms the second guard in src/storage/postgres/database (NODE_ENV=test).
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';

module.exports = { checkPostgres, checkRedis };
