#!/usr/bin/env bash
#
# Create the initial Prisma migration from the current schema.
#
# Run this ONCE, then commit prisma/migrations/. After that, use the normal
# `npx prisma migrate dev --name <change>` flow.
#
# Why this script exists: the repo has no prisma/migrations/ directory, so
# `prisma migrate deploy` — which is what the DigitalOcean pre-deploy job runs —
# silently does nothing and the deploy succeeds against an unmigrated database.
#
# Run it on macOS. Prisma fetches its engine binaries from binaries.prisma.sh,
# which is blocked by egress policy inside the sandboxed environments; your Mac
# already has the darwin-arm64 engines in node_modules.

set -euo pipefail

cd "$(dirname "$0")/.."

MIGRATION_DIR="prisma/migrations/00000000000000_init"

if [ -d "prisma/migrations" ]; then
  echo "prisma/migrations already exists — nothing to do."
  echo "For a schema change use: npx prisma migrate dev --name <change>"
  exit 0
fi

echo "==> Generating baseline SQL from prisma/schema.prisma"
mkdir -p "$MIGRATION_DIR"

npx prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script > "$MIGRATION_DIR/migration.sql"

LINES=$(wc -l < "$MIGRATION_DIR/migration.sql" | tr -d ' ')
if [ "$LINES" -lt 10 ]; then
  echo "ERROR: generated migration is only $LINES lines — that is not a full schema." >&2
  rm -rf "$MIGRATION_DIR"
  exit 1
fi
echo "    wrote $MIGRATION_DIR/migration.sql ($LINES lines)"

# If the database already has these tables (created previously by `db push`),
# the baseline must be marked applied rather than run — otherwise migrate
# deploy tries to CREATE TABLE over live tables and fails.
if [ -n "${DATABASE_URL:-}" ]; then
  echo "==> DATABASE_URL is set. Marking the baseline as already applied."
  echo "    (Correct when the schema was previously created with 'prisma db push'.)"
  echo "    If this database is EMPTY, skip this and run 'npx prisma migrate deploy'."
  read -r -p "    Mark as applied? [y/N] " reply
  if [ "$reply" = "y" ] || [ "$reply" = "Y" ]; then
    npx prisma migrate resolve --applied 00000000000000_init
    echo "    marked applied."
  fi
fi

echo
echo "Done. Next:"
echo "  git add prisma/migrations && git commit -m 'Add migration baseline'"
