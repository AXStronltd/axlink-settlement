# AxLink Leg A — verification of commit `6d26e5d`

*2026-11-06 · branch `step-1-foundation` · for independent Codex review.*
*Scope: Leg A only (institutional digital-asset custody, transfers, settlement). No new financial features were implemented during this verification; the only additions are a test file and this report.*

## Summary

| # | Item | Verdict |
|---|---|---|
| 1 | Exact commit and changed files | **PASS** |
| 2 | Frontend and backend builds | **PASS** |
| 3 | USDC/USDT identified by network + token contract, not ticker | **PARTIAL** — on-chain proof: PASS; ledger/custody path: FAIL (ticker-only, single global asset) |
| 4 | Solana mint addresses vs authoritative config | **PASS** (static) / **NOT VERIFIED** (live RPC) |
| 5 | Balances from real APIs or explicitly marked simulated | **PASS** (frontend bannered as simulated; backend ledger is real) |
| 6 | Same deposit address safely receives both assets, with attribution | **FAIL** — USDC deposits are silently ignored; attribution exists for USDT only |
| 7 | No cross-institution access | **PARTIAL** — institution API: PASS; legacy customer API: FAIL (known S2) |
| 8 | Precise decimal/integer arithmetic | **PARTIAL** — journal and proof: PASS; legacy ledger/credit paths: FAIL (float) |
| 9 | Statuses reflect backend state, not frontend simulation | **PASS** for backend; frontend is simulated and says so |
| 10 | Fireblocks and B2BinPay isolated behind provider interfaces | **PARTIAL** — `core/settlement` PASS; 6 legacy core services import live adapters directly |
| 11 | Automated tests for both assets (duplicates, wrong mints, unsupported networks, cross-tenant) | **PARTIAL** — tests exist and document the gaps; duplicate-event test proves a double credit (**FAIL** behaviour) |
| 12 | All changes within Leg A | **PASS** |

**Critical findings for Codex (must be resolved before any live money):**
- **F1 Duplicate Fireblocks event credits twice** (`src/routes/webhook.routes.ts:155-186`). Proven by test: balance 100 → 200 on exact replay.
- **F2 USDC deposits never credit** — asset filter is `assetId.startsWith('USDT')` (`webhook.routes.ts:155`). A USDC arrival at the same vault is logged and dropped.
- **F3 Fireblocks webhook signature is skipped when `FIREBLOCKS_WEBHOOK_PUBLIC_KEY` is unset** (`src/providers/live/fireblocks.ts:192-193`). Combined with F1, an unauthenticated POST can mint ledger balance. Config validation does not require the key in production.
- **F4 Legacy customer API has no auth or tenant scoping** (S2 in `docs/AUDIT-STEP1.md`). Proven by test: `POST /api/users` and `GET /api/users/:id` succeed with no credential.
- **F5 Float arithmetic** on the legacy credit/debit path (`Number(deposit.amount)`, `Number(account.balance)`).

## Commands run

```bash
# database
npx prisma migrate deploy                      # "No pending migrations to apply."
# backend
npx tsc --noEmit                               # 0 errors
npm run build                                  # exit 0
npx vitest run                                 # Test Files 13 passed · Tests 197 passed (184 existing + 13 verification)
npx vitest run src/__tests__/verification.leg-a.test.ts   # 13 passed
# frontends
cd frontend && npm run build                   # OK (vite, 2.36 s)
node scripts/check-web.js                      # "web ok: 289 KB, 61 routes"
node apps/web/tools/render_check.js            # {"routes":60,"bad":[],"errors":[]}
```
Environment: `DATABASE_URL=postgresql://…/axlink_test`, `OPS_API_KEY` set, no provider credentials (sandbox mode).

## Item-by-item evidence

### 1 · Commit — PASS
`6d26e5d0b82c134597291d873bf18a3eec37a457` — "apps/web: settlement assets are USDC and USDT (both first-class); docs aligned".
Changed: `apps/web/README.md` (+1/−1), `apps/web/index.html` (+42/−42), `docs/FINANCIAL-MODULES-ARCHITECTURE.md` (+1/−1). **No backend source changed in this commit.** The backend already contained both mints (`src/providers/live/solana.ts`) from before Step 1.

### 2 · Builds — PASS
Backend `npm run build` exit 0; `frontend/` Vite build OK; `apps/web/index.html` parses and renders all 60 routes as client and operator (`apps/web/tools/render_check.js`).

### 3 · Asset identity by network + contract — PARTIAL
- **PASS (proof path):** `src/core/settlement/proof.service.ts:92-162` resolves `asset → SOLANA_MINTS[asset].mint` and refuses a finalized transaction whose token transfers do not carry that exact mint (`ProofMismatchError`, non-retryable). `SettlementProof.mint` stores the contract address; `AccountCode.onchain(mint)` keys on-chain accounts by mint (`src/core/settlement/accounts.ts`).
- **FAIL (ledger/custody path):** custody accounts are keyed by ticker (`CUSTODY:<vault>:USDC`), the Fireblocks webhook matches on the Fireblocks asset id prefix (`USDT…`), and `SETTLEMENT_ASSET` (`solana.ts`) is one global value (`'USDT'` default) — not per institution, per wallet, or per transfer. `SOLANA_MINTS` has **no chain/network field**; Solana is implicit, so an "unsupported network" cannot be represented, only an unknown asset key.
- Test: `verification.leg-a.test.ts` › "3/4 · asset identity" (4 tests, incl. two labelled GAP).

### 4 · Mint addresses — PASS (static) / NOT VERIFIED (live)
`src/providers/live/solana.ts`: USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, USDT `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`, both 6 decimals. These equal the Circle and Tether Solana mainnet mints; asserted by test. **Not verified against a live RPC node** (no network access to Solana from this environment; `SOLANA_RPC_URL` unset). Codex should confirm `getAccountInfo` on both mints from the dedicated node.

### 5 · Real balances vs simulated — PASS
- Backend: `Account.balance` is a projection of the double-entry journal, written in the same transaction (`journal.service.ts`); `/api/settlement/*` reconciliation reads the database, not fixtures.
- `apps/web/index.html`: every portal screen carries the "Illustrative data — not connected to the API" banner; the Developers page marks each endpoint `live` or `planned`. No frontend number is presented as a real balance.
- `frontend/` ops dashboard reads the backend API.

### 6 · One deposit address, both assets, attribution — FAIL
`src/routes/webhook.routes.ts:155-186`: on `COMPLETED`, attribution is by `destination.id` → `User.vaultId` and `externalTxId` (`dep_…`) → `BankDeposit.trackingId`. That attribution is to a **legacy `User`**, not to an `Institution`/wallet/asset (the `Institution` model from Step 1 is not yet linked to vaults or deposits).
- USDC completion at the same vault: **ignored** (filter `startsWith('USDT')`). Test result `afterUsdc: "0"`.
- USDT completion: credited (`afterUsdt: "100"`).
- Exact replay of the same event: credited again (`afterDup: "200"`). `bankDeposit.findUnique({ trackingId })` ignores `status`, and no provider-event id (`data.id`) is recorded — the idempotency service (`core/idempotency.service.ts`) is not used on this path.
Test: › "6/11 · Fireblocks deposit webhook…" (passes because it asserts the current, wrong behaviour; labelled FAIL in its name).

### 7 · Cross-institution isolation — PARTIAL
- **PASS:** Step 1 institution API. Test creates institutions A and B, issues a SANDBOX key for A: `/api/institutions/me` returns A; `GET /api/institutions/:idB` with A's key → **401** (institution keys never reach ops routes; ops routes need `OPS_API_KEY`). Credentials are per `ApiEnvironment` (SANDBOX/PRODUCTION isolated), hashed with pepper, scoped.
- **FAIL:** legacy customer API (`/api/users`, `/api/transfers`, `/api/withdrawals`, `/api/deposits`, `/api/orchestrator`, `/api/quote`) — no credential required at all. Test: `POST /api/users` → 201 and `GET /api/users/:id` → 200 with no header. This is S2 (open, scheduled for Step 2). Legacy `User`/`Account`/`BankDeposit` rows have **no `institutionId`** column, so isolation cannot be enforced at the data layer yet.

### 8 · Arithmetic — PARTIAL
- **PASS:** journal postings are `Prisma.Decimal`, balanced to zero **per currency** before write (`assertBalanced`; test shows a USDC/USDT mixed posting is refused). Proof compares raw integer units as `bigint` (`parseUnits`, `changeRaw`).
- **FAIL:** legacy paths convert to JS floats: `Number(deposit.amount)` (`webhook.routes.ts:103,174`), `Number(account.balance)` (`ledger.service.ts`, 2 sites), `deposit.service.ts` (4 sites); 31 `Number(…)`/`parseFloat` sites across `src/core` + `src/routes` in total. 6-decimal stablecoin amounts above ~9×10⁹ or sums of many cents can lose precision.

### 9 · Statuses from backend state — PASS
Settlement statuses (`SettlementLeg.status`, `SettlementProof`, `/api/settlement/stuck`, `/proof/:entityType/:entityId`) are database-backed; a leg is settled only on Solana `finalized` (`proof.service.ts`). The `apps/web` portal statuses are illustrative and bannered as such (see 5). No frontend-computed status is served by the API.

### 10 · Provider isolation — PARTIAL
- **PASS:** `src/core/settlement/*` touches custody/converter/chain only through `ports()` (`src/core/ports.ts`); test scans the directory for direct `providers/live/{fireblocks,b2binpay}` imports → none.
- **GAP:** `src/core/{baas-registry,interbank,orchestrator,transfer,treasury}.service.ts` and `ports.ts` itself import live adapters directly. The five Step 1 interfaces (`src/providers/ports/index.ts`: `CustodyProvider`, `LiquidityProvider`, `BlockchainProvider`, `CrossChainProvider`, `FiatPayoutProvider`; `PROVIDER_ROLES` fireblocks → custody+blockchainExecution, b2binpay → liquidity) are declared but **not yet implemented by the adapters** (Step 2 mapping). Fireblocks asset ids (`USDT_SOL`) leak into core via `FIREBLOCKS_USDT_ASSET` in `fireblocks.lp.ts` / `baas-registry.service.ts`.

### 11 · Automated tests — PARTIAL
Added `src/__tests__/verification.leg-a.test.ts` (13 tests, all green on a real Postgres):
- both mints + decimals vs authoritative values; custody/on-chain account codes per asset;
- journal rejects USDC/USDT mixing; Decimal exactness;
- unknown asset key rejected by `proveSettlement` (`USDX`);
- cross-tenant: A's key cannot read B; legacy routes open (documented FAIL);
- Fireblocks deposit: USDC ignored, USDT credited, **duplicate credits twice** (documented FAIL).
Existing suites already cover: mint+amount mismatch on chain (`proof` tests, simulator "wrong mint" scenario), idempotency unique-constraint, per-currency journal balance.
**Missing tests (because the behaviour is missing):** per-institution asset attribution; unsupported-network rejection (no network dimension exists); USDC deposit credit; provider-event dedupe.

### 12 · Scope — PASS
Commit `6d26e5d` touched only the static site and two docs. This verification added `src/__tests__/verification.leg-a.test.ts` and this file. No NDD/N3XT, no fiat payout, no cross-chain, no liquidity code was added; `scripts/check-web.js` still fails CI on any `NDD` token in `apps/web`.

## Missing implementation (for the next approved milestone — not started)

1. Provider-event idempotency on both webhooks (store `provider + event id` under a unique constraint; reuse `core/idempotency.service.ts`).
2. Asset-aware deposit crediting: match on `(network, mint)` resolved from the provider asset id, credit the matching `CUSTODY:<vault>:<ASSET>` journal account; accept USDC and USDT.
3. Require `FIREBLOCKS_WEBHOOK_PUBLIC_KEY` (and `B2BINPAY_CALLBACK_SECRET`) in production via `src/platform/config.ts`.
4. Add an `Asset` registry with `{ network, mint, symbol, decimals }` replacing `SETTLEMENT_ASSET` and `SOLANA_MINTS`; reject unsupported networks explicitly.
5. Link `Institution` to vaults/wallets/deposits (`institutionId` on the money-moving tables); apply `requireInstitution` to the legacy customer routes or retire them (S2).
6. Replace `Number(...)` on money with `Prisma.Decimal`/`bigint` raw units across `ledger.service.ts`, `deposit.service.ts`, `webhook.routes.ts`.
7. Map the live adapters onto the five port interfaces and remove direct `providers/live` imports from `src/core`.

**Stopped here. Awaiting independent Codex review and explicit approval before any further milestone.**
