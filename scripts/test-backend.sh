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
#   scripts/test-backend.sh                    # full run
#   scripts/test-backend.sh --no-deps          # skip the container health check
#   scripts/test-backend.sh --install-packages # npm ci in every packages/<pkg>
#                                              # with test/ (or INSTALL_PACKAGES=1)
#
# Prereqs (one-time):
#   docker compose -f docker-compose.test.yml --env-file backend/.env.test up -d
#   per-package deps: --install-packages, or manually
#   for p in packages/*/; do [ -d "$p/test" ] && (cd "$p" && npm ci); done

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/backend/.env.test"
BACKEND_DIR="$REPO_ROOT/backend"
PG_CONTAINER="animastor-pg-test"
REDIS_CONTAINER="animastor-redis-test"

err() { echo "[test-backend] ERROR: $*" >&2; exit 1; }
log() { echo "[test-backend] $*"; }

NO_DEPS=0
INSTALL_PACKAGES="${INSTALL_PACKAGES:-0}"
for arg in "$@"; do
    case "$arg" in
        --no-deps) NO_DEPS=1 ;;
        --install-packages) INSTALL_PACKAGES=1 ;;
        *) err "unknown argument: $arg (accepted: --no-deps, --install-packages)" ;;
    esac
done

# --- 1. env file ------------------------------------------------------------
[[ -f "$ENV_FILE" ]] || err "missing $ENV_FILE (generate it; see docker-compose.test.yml)"
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

# Tests never reach external services: closed local port unless .env.test overrides.
export HUB_URL="${HUB_URL:-http://127.0.0.1:9}"
export AI_API_BASE_URL="${AI_API_BASE_URL:-http://127.0.0.1:9}"

# --- 2. hard assertions BEFORE anything connects ----------------------------
# These mirror the in-process guards, failing fast with a clear message.
[[ "${PG_DB:-}" == *_test ]] || err "PG_DB='${PG_DB:-}' must end in _test (refusing to run)"
[[ "${PG_DB:-}" != "animastor" ]] || err "PG_DB='animastor' is the production database (refusing to run)"
[[ "${NODE_ENV:-}" == "test" ]] || err "NODE_ENV must be 'test' (refusing to run)"

# --- 3. container health check (skippable) ---------------------------------
if [[ "$NO_DEPS" -eq 0 ]]; then
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

# --- 5. deps guard -----------------------------------------------------------
# node_modules должен совпадать с package-lock.json; иначе npm test может
# падать на битые/отсутствующие пакеты @animastor/*.
deps="$(cd "$BACKEND_DIR" && npm ls --depth=0 2>&1)" || true
printf '%s\n' "$deps" | grep -q '@animastor/' \
    || err "deps guard: не удалось прочитать npm ls в $BACKEND_DIR"
if printf '%s\n' "$deps" | grep -E '@animastor/' | grep -Eqi 'invalid|missing'; then
    err "node_modules не совпадает с package-lock.json: cd backend && npm ci"
fi

# --- 6. run the suite -------------------------------------------------------
log "PG_DB=$PG_DB  PG_PORT=$PG_PORT  REDIS_PORT=$REDIS_PORT  NODE_ENV=$NODE_ENV"
cd "$BACKEND_DIR"
npm test

# --- 7. package suites ------------------------------------------------------
# Every packages/<pkg> with a test/ directory runs its OWN `npm test` in a
# separate process: the port modules are process-wide singletons, so a package
# must never share a mocha process with the backend suite or with another
# package (see reports/2026-11-25/post171-chores.md §3.2). The suites are
# package-owned (ai-connector uses its own runner, orchestration its
# --require test/test-bindings.js).
#
# A package that also declares `test:gen` runs it right after `npm test` in its
# own process too — today that is animastor-orchestration's gen suite
# (test/gen/*.test.js: the migration runner and the gen core against a real PG,
# a fresh schema per case). Both must pass for the package to count as passed.
log "package suites (one process per package)"

if [[ "$INSTALL_PACKAGES" -eq 1 ]]; then
    log "installing package deps (npm ci in every packages/<pkg> with test/)"
    for PKG_DIR in "$REPO_ROOT"/packages/*/; do
        [[ -d "$PKG_DIR/test" ]] || continue
        log "npm ci $(basename "$PKG_DIR")"
        PKG_CI_LOG="$(mktemp)"
        if ! ( cd "$PKG_DIR" && npm ci --no-audit --no-fund ) >"$PKG_CI_LOG" 2>&1; then
            cat "$PKG_CI_LOG"
            rm -f "$PKG_CI_LOG"
            err "npm ci failed in $PKG_DIR"
        fi
        rm -f "$PKG_CI_LOG"
    done
fi

PKG_TOTAL=0
PKG_FAILED=0
PKG_REPORT=()
for PKG_DIR in "$REPO_ROOT"/packages/*/; do
    [[ -d "$PKG_DIR/test" ]] || continue
    PKG_NAME="$(basename "$PKG_DIR")"
    PKG_TOTAL=$((PKG_TOTAL + 1))
    if [[ ! -d "$PKG_DIR/node_modules" ]]; then
        PKG_FAILED=$((PKG_FAILED + 1))
        PKG_REPORT+=("$PKG_NAME: NOT RUN — node_modules отсутствует (запустите с --install-packages или cd packages/$PKG_NAME && npm ci)")
        log "package $PKG_NAME: NOT RUN (node_modules отсутствует; используйте --install-packages)"
        continue
    fi
    log "package $PKG_NAME: npm test (отдельный процесс)"
    PKG_LOG="$(mktemp)"
    set +e
    ( cd "$PKG_DIR" && npm test ) >"$PKG_LOG" 2>&1
    PKG_STATUS=$?
    set -e
    cat "$PKG_LOG"
    PKG_PASSING="$(sed -nE 's/.*LAC package tests: ([0-9]+) pass \/ ([0-9]+) fail.*/\1/p' "$PKG_LOG" | tail -1)"
    PKG_FAILING="$(sed -nE 's/.*LAC package tests: ([0-9]+) pass \/ ([0-9]+) fail.*/\2/p' "$PKG_LOG" | tail -1)"
    [[ -n "$PKG_PASSING" ]] || PKG_PASSING="$(sed -nE 's/^[[:space:]]+([0-9]+) passing.*/\1/p' "$PKG_LOG" | tail -1)"
    [[ -n "$PKG_FAILING" ]] || PKG_FAILING="$(sed -nE 's/^[[:space:]]+([0-9]+) failing.*/\1/p' "$PKG_LOG" | tail -1)"
    rm -f "$PKG_LOG"
    # Второй сьют пакета (сейчас — только gen: миграции gen/sql на реальном PG).
    # Отдельный процесс по той же причине (порт-синглтоны) и потому, что ему
    # нужен PG из .env.test; без ffmpeg сьют не падает, а скипает медиа-кейсы.
    PKG_GEN_NOTE=""
    if node -e "process.exit((require(process.argv[1]).scripts || {})['test:gen'] ? 0 : 1)" "$PKG_DIR/package.json" 2>/dev/null; then
        log "package $PKG_NAME: npm run test:gen (отдельный процесс)"
        PKG_GEN_LOG="$(mktemp)"
        set +e
        ( cd "$PKG_DIR" && npm run test:gen ) >"$PKG_GEN_LOG" 2>&1
        PKG_GEN_STATUS=$?
        set -e
        cat "$PKG_GEN_LOG"
        PKG_GEN_PASSING="$(sed -nE 's/^[[:space:]]+([0-9]+) passing.*/\1/p' "$PKG_GEN_LOG" | tail -1)"
        PKG_GEN_FAILING="$(sed -nE 's/^[[:space:]]+([0-9]+) failing.*/\1/p' "$PKG_GEN_LOG" | tail -1)"
        rm -f "$PKG_GEN_LOG"
        if [[ "$PKG_GEN_STATUS" -eq 0 ]]; then
            PKG_GEN_NOTE=" · test:gen ${PKG_GEN_PASSING:-?} passing"
        else
            PKG_STATUS=$PKG_GEN_STATUS
            PKG_FAILING="${PKG_GEN_FAILING:-?}"
            PKG_GEN_NOTE=" · test:gen FAILED (exit $PKG_GEN_STATUS)"
        fi
    fi
    if [[ "$PKG_STATUS" -eq 0 ]]; then
        PKG_REPORT+=("$PKG_NAME: ${PKG_PASSING:-?} passing, ${PKG_FAILING:-0} failing${PKG_GEN_NOTE}")
    else
        PKG_FAILED=$((PKG_FAILED + 1))
        PKG_REPORT+=("$PKG_NAME: FAILED (exit $PKG_STATUS; ${PKG_PASSING:-?} passing, ${PKG_FAILING:-?} failing)")
    fi
done

log "package suites: $((PKG_TOTAL - PKG_FAILED))/$PKG_TOTAL passed"
for PKG_LINE in "${PKG_REPORT[@]}"; do log "  $PKG_LINE"; done
[[ "$PKG_FAILED" -eq 0 ]] || err "$PKG_FAILED package suite(s) failed (see the summary above)"
log "all package suites passed"
