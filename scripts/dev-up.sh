#!/usr/bin/env bash
#
# One command to a working localhost.
#
#   ./scripts/dev-up.sh
#
# Checks Postgres, generates the Prisma client, pushes the schema, and starts
# the server with the settlement console enabled. Everything is idempotent, so
# running it twice is fine.

set -euo pipefail
cd "$(dirname "$0")/.."

green() { printf '\033[32m%s\033[0m\n' "$1"; }
amber() { printf '\033[33m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1" >&2; }

# ── .env ──────────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  amber "No .env — copying .env.example"
  cp .env.example .env
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a

if [ -z "${DATABASE_URL:-}" ]; then
  red "DATABASE_URL is not set in .env"
  exit 1
fi

# The console can move money-shaped value and stub the payment rails. It is
# enabled here explicitly rather than defaulted on, so nothing inherits it.
export SIMULATOR_ENABLED=true
export NODE_ENV=development

if [ -z "${OPS_API_KEY:-}" ]; then
  amber "OPS_API_KEY is unset — generating a throwaway one for this run"
  OPS_API_KEY="$(openssl rand -hex 16)"
  export OPS_API_KEY
fi

# ── Postgres ──────────────────────────────────────────────────────────────────
printf 'Checking Postgres… '
if command -v psql >/dev/null 2>&1 && psql "$DATABASE_URL" -c 'select 1' >/dev/null 2>&1; then
  green "reachable"
elif command -v docker >/dev/null 2>&1; then
  amber "not reachable — starting the docker-compose db service"
  docker compose up -d db
  printf 'Waiting for it to accept connections'
  for _ in $(seq 1 30); do
    if docker compose exec -T db pg_isready -q 2>/dev/null; then break; fi
    printf '.'; sleep 1
  done
  echo
  green "Postgres up"
else
  red "Cannot reach Postgres at DATABASE_URL and docker is not available."
  red "Start Postgres, or install Docker and re-run."
  exit 1
fi

# ── Schema ────────────────────────────────────────────────────────────────────
if [ -d prisma/migrations ]; then
  echo "Applying migrations…"
  npx prisma migrate deploy
else
  amber "No prisma/migrations — using 'db push'."
  amber "Before deploying anywhere, run ./scripts/create-baseline-migration.sh (see docs/DEPLOY.md)."
  npx prisma db push --skip-generate
fi

echo "Generating the Prisma client…"
npx prisma generate >/dev/null

# ── Go ────────────────────────────────────────────────────────────────────────
PORT="${PORT:-4000}"
echo
green "Ready."
echo
echo "  Console   http://localhost:${PORT}/console?key=${OPS_API_KEY}"
echo "  Health    http://localhost:${PORT}/api/health"
echo "  Harness   npm run simulate"
echo
amber "Rails are stubbed in this process. Nothing here reaches a real partner."
echo

exec npx ts-node src/index.ts
