# AxLink Settlement — working notes

**Owner scope: Leg A, Step 1 only.** Read [SCOPE.md](docs/SCOPE.md) and
[AGENTS.md](AGENTS.md). Leg A ends at verified digital asset receipt by the
receiving institution. Fiat payouts, local FX and liquidity are Leg B. B2INPAY
is optional. Preserve both frontends; report Step 1 results and stop before Step 2.

The older running notes below contain historical statements. Committed migrations
now exist: use `npx prisma migrate deploy` on an isolated database, followed by
`npx prisma generate`. See the current audit report for verification evidence.


Crypto-rail settlement service. Express + Prisma/Postgres backend (`src/`), React/Vite frontend (`frontend/`).
Users see fiat only; USDT on Solana via Fireblocks is the internal settlement layer.

## Running locally

Requires Postgres. Redis and Kafka appear in `docker-compose.yml` but are **not** required:
Redis is unused by any source file, and `src/core/kafka.service.ts` falls back to an
in-process EventEmitter bus when `KAFKA_BROKERS` is unset.

```bash
npm install                       # npm 11 blocks install scripts; see below
cp .env.example .env              # then set DATABASE_URL
npx prisma db push                # NOT `migrate deploy` — see below
npx prisma generate
npm run dev                       # backend  → http://localhost:4000
cd frontend && npm install && npm run dev   # frontend → http://localhost:5173 (proxies /api → :4000)
```

Health check: `curl -s http://localhost:4000/api/health`
Tests: `npx vitest run`

## Gotchas

- **`prisma migrate deploy` does nothing** until the baseline exists. There is still no
  `prisma/migrations/` directory. Run `./scripts/create-baseline-migration.sh` once (on macOS —
  Prisma's engine downloads are blocked inside the sandboxed Linux VM) and commit the result;
  after that use the normal `npx prisma migrate dev --name <change>` flow. Until then,
  `npx prisma db push` still works locally, but a DigitalOcean deploy will silently succeed
  against an unmigrated database. See `docs/DEPLOY.md`.

- **npm 11 blocks postinstall scripts.** `prisma`, `@prisma/engines` (root) and `esbuild` (frontend)
  need them. Approvals are recorded in the `allowScripts` field of each `package.json`, so a fresh
  `npm install` now works without manual intervention.

- **`dotenv` does not override an already-set `DATABASE_URL`.** If the shell exports one
  (e.g. a placeholder from another project), `.env` is ignored and Prisma fails with `P1010:
  User was denied access`. `.claude/settings.local.json` sets the correct value for Claude Code
  sessions; otherwise export it inline when running commands.

- **Sandbox mode is the default.** With no provider credentials set, startup logs
  `[startup] Sandbox mode — unset credentials: ...` and B2BinPay / Fireblocks / Brainrock /
  Daraja / Choice Bank are all stubbed. Quotes, routing and the ledger still work end to end.
  See SETUP.md steps 2–3 for wiring real sandbox credentials.

## Never commit

`.env`, `fireblocks_secret.key`, `fireblocks.csr` — all gitignored.

## Settlement engine

Added in the `settlement-engine` branch. `docs/GAP_ANALYSIS.md` explains why each piece exists.

- `core/settlement/journal.service.ts` — double-entry journal. Every posting balances to zero
  **per currency**, asserted before write. `Account.balance` is now a projection of the journal,
  not the source of truth; both are written in the same transaction.
- `core/settlement/leg.service.ts` — settlement legs. The plan is written before any external
  call, so a crash between the customer debit and the partner payout is recoverable.
  `core/settlement/resume.worker.ts` drives stalled legs forward.
- `core/settlement/proof.service.ts` + `providers/live/solana.ts` — a transfer is settled when a
  Solana node reports the signature `finalized`, not when Fireblocks returns an id.
- `core/idempotency.service.ts` — a retried request must not pay twice. Backed by a unique
  constraint, not a read-then-write check.
- `core/provider/capability.ts` — replaces `atomicJit: boolean`. Declares settlement and payout
  currencies separately, which is what makes local-currency corridors reachable. Refuses to send
  USDT to a partner not marked `cryptoLicensed`.
- `core/settlement/reconciliation.service.ts` — trial balance, projection drift, custody and
  on-chain position checks.

Ops surface: `/api/settlement/*`, gated by `OPS_API_KEY`. The exception is
`/api/settlement/proof/:entityType/:entityId`, which is public on purpose — a proof only we can
read is not a proof.

### Things that must be true

- `GET /api/settlement/stuck` is empty at the start of each day. Every row is customer money in
  an indeterminate state.
- Suspense is zero at close of day. A non-zero suspense balance is a customer debited and not
  delivered.
- `SOLANA_RPC_URL` points at a dedicated node. On the public endpoint, verification gets
  rate-limited and settlements pile up unproven.
