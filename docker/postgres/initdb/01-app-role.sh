#!/usr/bin/env bash
# ============================================================
# 01-app-role.sh — application role for a fresh PostgreSQL cluster
# ============================================================
# Mounted into /docker-entrypoint-initdb.d, so the postgres image runs it once,
# on an EMPTY data volume, as POSTGRES_USER (the bootstrap superuser) against
# POSTGRES_DB. Existing volumes (production) are never touched by it.
#
# Creates the backend's working role ${PG_APP_USER:-animastor_app}:
#   LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS,
#   password = PG_PASSWORD, owner of POSTGRES_DB and of schema public.
# The superuser password (POSTGRES_PASSWORD) stays with the postgres
# container only; the backend connects as the app role (see
# docs/pgsql-roles-logging.md).
#
# Idempotent: re-running it re-asserts attributes, password and ownership.
# The password is read inside psql via \getenv, never passed on argv.

set -euo pipefail

APP_USER="${PG_APP_USER:-animastor_app}"

if [[ -z "${PG_PASSWORD:-}" ]]; then
    echo "[initdb] ERROR: PG_PASSWORD is not set — cannot create role '$APP_USER'" >&2
    exit 1
fi
if [[ "$APP_USER" == "$POSTGRES_USER" ]]; then
    echo "[initdb] ERROR: PG_APP_USER must differ from POSTGRES_USER ('$POSTGRES_USER')" >&2
    exit 1
fi

export PG_PASSWORD
psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v app_user="$APP_USER" -v app_db="$POSTGRES_DB" <<'SQL'
\getenv app_password PG_PASSWORD

SELECT format('CREATE ROLE %I LOGIN', :'app_user')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user')
\gexec

ALTER ROLE :"app_user" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOREPLICATION NOBYPASSRLS PASSWORD :'app_password';

ALTER DATABASE :"app_db" OWNER TO :"app_user";
ALTER SCHEMA public OWNER TO :"app_user";
SQL

echo "[initdb] role '$APP_USER' ready (owner of database '$POSTGRES_DB' and schema public)"
