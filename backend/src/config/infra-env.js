// ======================================================
// Infrastructure hosts from the environment — no short-name defaults
// ======================================================
// Owner's decision (VBook v4 step 6, 18.11): REDIS_HOST / REDIS_PORT and
// PG_HOST come ONLY from the environment. A missing value is a start error,
// never a fallback to 'redis' / 'pg' / 'localhost'.
//
// Why: the VPS resolver carries `search webhostbox.com`, and that domain
// answers EVERY name (wildcard). On the host — and inside a container whose
// service is absent from the docker network (containers inherit the search
// domain, ndots:0) — a short name such as `redis` resolves to a foreign
// machine (redis.webhostbox.com), and the client would send it the password.
// An explicit value in docker-compose / .env.test makes the target visible
// and reviewable; a missing one stops the process before any connection.

'use strict';

class InfraEnvError extends Error {
    constructor(message) {
        super(message);
        this.name = 'InfraEnvError';
        this.code = 'infra_env_missing';
    }
}

function requiredString(env, name) {
    const raw = env[name];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
        throw new InfraEnvError(`${name} is not set: the backend does not guess infrastructure hosts `
            + '(set it in docker-compose / .env; see config/infra-env.js)');
    }
    return value;
}

function requiredPort(env, name) {
    const value = requiredString(env, name);
    const port = Number(value);
    if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new InfraEnvError(`${name} must be a TCP port (1..65535), got "${value}"`);
    }
    return port;
}

/** ioredis options of the backend connection. REDIS_PASSWORD stays optional. */
function redisOptions(env = process.env) {
    const host = requiredString(env, 'REDIS_HOST');
    const port = requiredPort(env, 'REDIS_PORT');
    return { host, port, ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}) };
}

/** PG_HOST (required). PG_PORT keeps its standard default 5432 — a port, not a name. */
function pgHost(env = process.env) {
    return requiredString(env, 'PG_HOST');
}

/**
 * Start check: every required value at once, so the operator sees the whole
 * list in one failed start. Returns the names that are missing / invalid.
 */
function missingInfraEnv(env = process.env) {
    const problems = [];
    for (const check of [() => requiredString(env, 'REDIS_HOST'), () => requiredPort(env, 'REDIS_PORT'), () => requiredString(env, 'PG_HOST')]) {
        try { check(); } catch (err) { problems.push(err.message); }
    }
    return problems;
}

function assertInfraEnv(env = process.env) {
    const problems = missingInfraEnv(env);
    if (problems.length) throw new InfraEnvError(problems.join('; '));
}

module.exports = { InfraEnvError, redisOptions, pgHost, missingInfraEnv, assertInfraEnv };
