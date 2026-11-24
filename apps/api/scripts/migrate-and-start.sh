#!/bin/sh
# FixFlow API startup: run migrations as the OWNER, then run the app as
# the non-owner NOBYPASSRLS app role. Migrations never run as the app
# role, and the app never runs as the owner.
set -eu

if [ -z "${MIGRATION_DATABASE_URL:-}" ]; then
  echo "migrate-and-start.sh: MIGRATION_DATABASE_URL is not set." >&2
  exit 1
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "migrate-and-start.sh: DATABASE_URL is not set." >&2
  exit 1
fi

# prisma migrate deploy reads the datasource URL from the Prisma config,
# which resolves DATABASE_URL — so the OWNER url is passed as DATABASE_URL
# for this command only. The app itself later uses the app-role DATABASE_URL.
echo "migrate-and-start.sh: applying migrations as the owner role..."
attempt=1
until DATABASE_URL="$MIGRATION_DATABASE_URL" npx prisma migrate deploy --schema prisma/schema.prisma; do
  if [ "$attempt" -ge 12 ]; then
    echo "migrate-and-start.sh: migrations failed after 12 attempts." >&2
    exit 1
  fi
  echo "migrate-and-start.sh: migration attempt $attempt failed (Postgres may not be ready); retrying in 5s..."
  attempt=$((attempt + 1))
  sleep 5
done

echo "migrate-and-start.sh: migrations applied; starting the API as the app role."
exec node dist/main.js
