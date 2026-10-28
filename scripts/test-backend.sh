#!/usr/bin/env bash
# ============================================================
# scripts/test-backend.sh — run the backend suite against the TEST databases
# ============================================================
# Loads backend/.env.test, verifies the dedicated test containers are running
# and healthy, then runs `npm test` with that env.
#
# Two independent guards keep production safe:
#   1. tests/test-db-safety.cjs (loaded first via backend/.mocharc.json)
#      aborts mocha unless PG_DB ends in "_test" and Redis is on a
#      non-default port / logical DB.
#   2. src/storage/postgres/database.js refuses to open a pool under
#      NODE_ENV=test unless PG_DB ends in "_test".
# Both must PASS for the suite to run; production settings (PG_DB=animastor,
# port 5432) are rejected by both. Do NOT weaken them.
#
# Usage:
#   scripts/test-backend.sh              # full run
#   scripts/test-backend.sh --no-deps   # skip the container health check
#
# Prereqs (one-time):
#   docker compose -f docker-compose.test.yml --env-file backend/.env.test up -d

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/backend/.env.test"
BACKEND_DIR="$REPO_ROOT/backend"
PG_CONTAINER="animastor-pg-test"
REDIS_CONTAINER="animastor-redis-test"

err() { echo "[test-backend] ERROR: $*" >&2; exit 1; }
log() { echo "[test-backend] $*"; }

# --- 1. env file ------------------------------------------------------------
[[ -f "$ENV_FILE" ]] || err "missing $ENV_FILE (generate it; see docker-compose.test.yml)"
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

# --- 2. hard assertions BEFORE anything connects ----------------------------
# These mirror the in-process guards, failing fast with a clear message.
[[ "${PG_DB:-}" == *_test ]] || err "PG_DB='${PG_DB:-}' must end in _test (refusing to run)"
[[ "${PG_DB:-}" != "animastor" ]] || err "PG_DB='animastor' is the production database (refusing to run)"
[[ "${NODE_ENV:-}" == "test" ]] || err "NODE_ENV must be 'test' (refusing to run)"

# --- 3. container health check (skippable) ---------------------------------
if [[ "${1:-}" != "--no-deps" ]]; then
    for c in "$PG_CONTAINER" "$REDIS_CONTAINER"; do
        running="$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)"
        [[ "$running" == "true" ]] || err "container '$c' is not running.
  Start the test stack first:
    docker compose -f docker-compose.test.yml --env-file backend/.env.test up -d"
    done
    log "test containers are up ($PG_CONTAINER, $REDIS_CONTAINER)"
fi

# --- 4. temp data roots -----------------------------------------------------
mkdir -p "${BOOKS_DIR:-/tmp/animastor-test/books}" "${OUTPUT_DIR:-/tmp/animastor-test/output}"

# --- 5. run the suite -------------------------------------------------------
log "PG_DB=$PG_DB  PG_PORT=$PG_PORT  REDIS_PORT=$REDIS_PORT  NODE_ENV=$NODE_ENV"
cd "$BACKEND_DIR"
# NB: we do not forward "$@" — the only accepted flag (--no-deps) is ours.
npm test
