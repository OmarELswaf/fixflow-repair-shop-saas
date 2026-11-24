#!/bin/sh
# FixFlow — PostgreSQL init script (runs ONCE, on first init of an empty
# data directory, as the POSTGRES_USER). Creates the non-owner application
# role used by the API at runtime. This is a SINGLE FLAT FILE in
# /docker-entrypoint-initdb.d — Postgres does NOT recursively execute
# nested directories, so migration files must never be mounted there
# (migrations run via `prisma migrate deploy` in migrate-and-start.sh).
#
# Requires APP_DB_PASSWORD in the environment. Fails loudly without it.
set -eu

if [ -z "${APP_DB_PASSWORD:-}" ]; then
  echo "01-app-role.sh: APP_DB_PASSWORD is not set; refusing to create the app role." >&2
  exit 1
fi

# The password is passed through psql variables, not interpolated into SQL.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$APP_DB_PASSWORD" <<'EOSQL'
-- Application role: LOGIN, NOBYPASSRLS (never a superuser, never BYPASSRLS).
-- It must never own tables and must never run migrations.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fixflow_app') THEN
    CREATE ROLE fixflow_app WITH LOGIN NOBYPASSRLS PASSWORD :'app_password';
  ELSE
    ALTER ROLE fixflow_app WITH LOGIN NOBYPASSRLS PASSWORD :'app_password';
  END IF;
END $$;
REVOKE ALL ON SCHEMA public FROM fixflow_app;
GRANT USAGE ON SCHEMA public TO fixflow_app;
-- Future tables created by the owner (via migrations) are usable by the
-- app role for DML only — no DDL, no ownership, no BYPASSRLS.
ALTER DEFAULT PRIVILEGES FOR ROLE fixflow_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fixflow_app;
ALTER DEFAULT PRIVILEGES FOR ROLE fixflow_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO fixflow_app;
EOSQL

echo "01-app-role.sh: fixflow_app role ready (LOGIN, NOBYPASSRLS)."
