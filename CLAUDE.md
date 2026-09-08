# CLAUDE.md — working rules for this repo

Read `docs/ARCHITECTURE.md` before making changes. It is the map: structure,
layers, the chart of accounts, the settlement legs, and where each partner
plugs in. Update it in the same PR whenever you change structure — a new
service in `src/core/`, a new provider, a schema change, or a new route
surface.

## What this is

`axlink-settlement` is the AxLink settlement engine: an Express + TypeScript
backend (`src/`) and a React ops dashboard (`frontend/`). It settles
cross-border payments over USDT on Solana via Fireblocks, while every party
outside the system sees only fiat.

## Invariants — do not break these

1. **No SWIFT.** No correspondent banks, no nostro accounts. Cross-border value
   moves as USDT on Solana.
2. **External parties never see crypto.** Payout partners and end users receive
   fiat instructions only — never an address, a USDT amount, or a reference to
   Solana. A partner receives crypto *only* if marked `cryptoLicensed: true`,
   which `provider/capability.ts` enforces rather than documents.
3. **USD is the unit of account, and USD:USDT is 1:1 by construction.** The
   crypto hop is value-preserving. FX happens only where fiat meets a rail.
4. **Nothing reaches the ledger without passing validation.** Every deposit,
   withdrawal and transfer goes through the Kafka gate and must come back
   APPROVED. A new money-moving path needs the gate.
5. **Money is `Decimal(20,8)`.** Never `Float`, never a JS `number` in the schema.
6. **Every journal posting balances to zero, per currency**, asserted in code
   before write. `Account.balance` is a projection of the journal, written in
   the same transaction.
7. **Nothing is COMPLETED without a finalized on-chain proof.** A custodian
   returning an id is not settlement.
8. **Secrets stay out of the repo.** `.env`, `*.key`, `*.pem`, `*.csr` are
   gitignored and dockerignored. The Fireblocks key is mounted at runtime.

## Where things go

| Adding… | Goes in | Also touch |
|---|---|---|
| A fiat payout partner | `src/providers/live/<name>.ts` (client) + `<name>.baas.ts` (adapter) | one line in `src/bootstrap/baas.bootstrap.ts` |
| A liquidity provider | `src/providers/live/<name>.lp.ts` implementing `ILiquidityProvider` | one line in `src/bootstrap/lp.bootstrap.ts` |
| Business logic | `src/core/<name>.service.ts` | a test in `src/__tests__/` |
| An endpoint | `src/routes/<area>.routes.ts` | mount in `src/index.ts`; `API.md` |
| A schema change | `prisma/schema.prisma` | `npx prisma migrate dev --name <change>` |
| A corridor | `src/core/settlement/<ccy>-corridor.service.ts` | a scenario in `src/simulator/scenarios.ts` |

Both registries are built so adding a partner touches its own files plus one
bootstrap line. If your change needs edits elsewhere in `core/`, the
abstraction is probably being bypassed — reconsider.

## Commands

```bash
npm run dev              # ts-node, port 4000
npm run build            # tsc → dist/
npm test                 # vitest run — 171 tests
npx tsc --noEmit         # typecheck; the only automated style gate
docker compose up --build

cd frontend && npm run dev   # vite, port 5173, proxies /api → :4000
```

The strongest check is the settlement harness. It runs real settlements through
the real engine with only the converter, custodian and RPC node stubbed, and
asserts six global invariants on every scenario. It needs a **scratch**
database and refuses to run against one holding real users.

```bash
DATABASE_URL=postgresql://…/axlink_harness SIMULATOR_ENABLED=true npm run simulate
./scripts/demo.sh        # a full corridor against a running server
```

CI runs typecheck, tests, the harness and a production image build on every
push, and fails loudly if `prisma/migrations/` is missing rather than letting a
silent no-op deploy through.

## Running locally

Requires Postgres only. Redis and Kafka appear in `docker-compose.yml` but are
not needed: Redis is unused by any source file, and `kafka.service.ts` falls
back to an in-process EventEmitter when `KAFKA_BROKERS` is unset.

```bash
npm install
cp .env.example .env     # then set DATABASE_URL
npx prisma migrate deploy
npx prisma generate
npm run dev
```

On a database created earlier with `db push`, the tables already exist — run
`npx prisma migrate resolve --applied 00000000000000_init` once instead of
`migrate deploy`.

## Gotchas

- **`dotenv` must load before any module reads `process.env`.** `index.ts`
  imports `'dotenv/config'` first, deliberately. Moving it below another import
  makes every module-scope env read see `undefined` — which is how
  `TREASURY_VAULT` was permanently empty while the startup check reported it
  present.
- **npm 11 blocks postinstall scripts.** `prisma`, `@prisma/engines` and
  `esbuild` need them; approvals live in the `allowScripts` field of each
  `package.json`.
- **`dotenv` does not override an already-set `DATABASE_URL`.** A shell that
  exports one wins over `.env`, and Prisma fails with `P1010`.
- **Sandbox mode is the default.** With no credentials, every provider returns
  a shaped stub and startup logs which are unset. Quotes, routing, the ledger
  and payouts all run. Keep that behaviour — the service must start on an empty
  `.env`, and a provider that throws instead makes its corridor untestable.

## Settlement engine

`docs/GAP_ANALYSIS.md` explains why each piece exists.

- `core/settlement/journal.service.ts` — double-entry journal.
- `core/settlement/leg.service.ts` — settlement legs, planned before any
  external call, so a crash between the debit and the payout is recoverable.
  `resume.worker.ts` drives stalled legs forward.
- `core/settlement/proof.service.ts` + `providers/live/solana.ts` — settled
  means a Solana node reports the signature `finalized`.
- `core/settlement/usd-corridor.service.ts` — the USD corridor, and
  `compensateWithdrawal`, which reverses a settlement that failed after the
  debit. It refuses once the USDT has been sold: buying it back is a treasury
  decision with a real cost, not a journal entry.
- `core/idempotency.service.ts` — backed by a unique constraint, not a
  read-then-write check.
- `core/provider/capability.ts` — declares settlement and payout currencies
  separately, which is what makes local-currency corridors reachable.
- `core/settlement/reconciliation.service.ts` — trial balance, projection
  drift, custody and on-chain position checks.

Ops surface: `/api/settlement/*`, gated by `OPS_API_KEY`. The exception is
`/api/settlement/proof/:entityType/:entityId`, public on purpose — a proof only
we can read is not a proof.

### Things that must be true

- `GET /api/settlement/stuck` is empty at the start of each day. Every row is
  customer money in an indeterminate state.
- Suspense is zero at close of day. A non-zero balance is a customer debited
  and not delivered.
- `SOLANA_RPC_URL` points at a dedicated node. On the public endpoint,
  verification gets rate-limited and settlements pile up unproven.

## Known gaps — do not be surprised by these

- **Only `/api/network`, `/api/ops` and `/api/settlement` are authenticated.**
  Retail surfaces are open at the app layer. Do not add a public money-moving
  route without raising this.
- **Redis is provisioned but unused.** Quotes live in a process-local `Map`,
  which breaks on more than one backend instance.
- **No Kafka broker is configured**, so the in-process EventEmitter is what runs.
- **Partner FX sits outside the quoted spread.** A corridor where neither side
  is USD converts twice — ours at collection, the partner's at payout. The
  router's spread covers only ours.
- **`PREFUNDED_FLOAT` has no low-water mark.** It is chosen on a boolean;
  nothing reads the `FLOAT:<partner>:<CCY>` balance, so a drained float fails at
  the moment of payment — worse than the slow wire it was chosen to avoid.
- **An empty `FIREBLOCKS_WEBHOOK_PUBLIC_KEY` makes the webhook signature check
  pass everything.** Convenient locally; in production it means anyone who can
  reach the endpoint can credit any account.

## Operational, after the rename

- `DARAJA_INITIATOR_NAME` must match the initiator registered on the Safaricom
  portal. It defaults to `AxLink`; if the portal still holds the previous name,
  B2C payouts fail until one side changes.
- `APP_URL` is required wherever Brainrock is configured. The payment session
  now refuses to open without it rather than redirecting a paying customer to a
  guessed domain.
- Fireblocks vaults created before the rename keep their old labels. Harmless —
  every lookup uses the stored `vaultAccountId` — and they must not be renamed
  in the console.

## Never commit

`.env`, `fireblocks_secret.key`, `fireblocks.csr` — all gitignored.
