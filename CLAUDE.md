# AxLink Settlement — working notes

**Owner scope: Leg A. Step 1 closed on `main` (`44e1a18`); Step 2 in progress, slice by slice, back end and front end aligned in the same commit.** Read [docs/SCOPE.md](docs/SCOPE.md), [AGENTS.md](AGENTS.md) and
[docs/WORKING-TOGETHER.md](docs/WORKING-TOGETHER.md) (Claude builds slices and merges; Codex reviews independently; GitHub PRs are the only channel).
Leg A ends at verified digital asset receipt by the receiving institution; fiat payouts, local FX and
liquidity are Leg B. The AxLink front end (`apps/web`) is aligned to the API on every slice: `apps/web/tools/align_step2.py` is the re-runnable record of each change; `node scripts/check-web.js` and `node apps/web/tools/render_check.js` must stay green.

Crypto-rail settlement service. Express + Prisma/Postgres backend (`apps/api` + `packages/`), AxLink front end (`apps/web`, with the ops dashboard at `apps/web/ops`). Layout: `docs/STRUCTURE.md`.
Users see fiat only; USDT on Solana via Fireblocks is the internal settlement layer.

## Running locally

Requires Postgres. Redis and Kafka appear in `docker-compose.yml` but are **not** required:
Redis is unused by any source file, and `packages/core/events/kafka.service.ts` falls back to an
in-process EventEmitter bus when `KAFKA_BROKERS` is unset.

```bash
npm install                       # npm 11 blocks install scripts; see below
cp .env.example .env              # then set DATABASE_URL
npx prisma migrate deploy         # applies the committed migrations
npx prisma generate
npm run dev                       # backend  → http://localhost:4000
cd apps/web/ops && npm install && npm run dev   # ops dashboard → http://localhost:5173 (proxies /api → :4000)
```

Health check: `curl -s http://localhost:4000/api/health`
Tests: `npx vitest run`

## Gotchas

- **Migrations exist** (`prisma/migrations/`: baseline, Step 1 institutions, remediation). Use
  `npx prisma migrate deploy` on an isolated database, then `npx prisma generate`; new changes go
  through `npx prisma migrate dev --name <change>`. See `docs/DEPLOY.md`.

- **npm 11 blocks postinstall scripts.** `prisma`, `@prisma/engines` (root) and `esbuild` (apps/web/ops)
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

- `packages/core/ledger/journal.service.ts` — double-entry journal. Every posting balances to zero
  **per currency**, asserted before write. `Account.balance` is now a projection of the journal,
  not the source of truth; both are written in the same transaction.
- `packages/settlement/orchestration/leg.service.ts` — settlement legs. The plan is written before any external
  call, so a crash between the customer debit and the partner payout is recoverable.
  `packages/settlement/orchestration/resume.worker.ts` drives stalled legs forward.
- `packages/settlement/proof/proof.service.ts` + `packages/providers/blockchain/solana/solana.ts` — a transfer is settled when a
  Solana node reports the signature `finalized`, not when Fireblocks returns an id.
- `packages/core/idempotency/idempotency.service.ts` — a retried request must not pay twice. Backed by a unique
  constraint, not a read-then-write check.
- `packages/providers/runtime/capability.ts` — replaces `atomicJit: boolean`. Declares settlement and payout
  currencies separately, which is what makes local-currency corridors reachable. Refuses to send
  USDT to a partner not marked `cryptoLicensed`.
- `packages/settlement/reconciliation/reconciliation.service.ts` — trial balance, projection drift, custody and
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
