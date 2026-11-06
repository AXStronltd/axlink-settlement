# AxLink — Step 1 security remediation (F1–F6)

*2026-11-06 · branch `step-1-security-remediation` (from `step-1-foundation` @ `b673635`) · for independent Codex review.*
*Leg A only. No new settlement features. No real financial transactions were executed; every test runs in sandbox mode against a local PostgreSQL. No production data touched.*

## 1. Findings resolved

| Finding | Status | Mechanism |
|---|---|---|
| **F1** Duplicate financial credits | **Resolved** | `ProviderEvent(provider, eventId)` unique constraint claimed *inside the same transaction* as the ledger posting (`processOnce`). Replayed, delayed and concurrent deliveries fail the insert and are acknowledged with `duplicate: true`, no effect. Deposit status flip is a conditional `updateMany(status != COMPLETED)`; a zero-row match throws and rolls the credit back. Same pattern on the B2BinPay withdrawal reversal. |
| **F2** Webhook authentication | **Resolved** | `platform/webhook-policy.ts`: no key → 503 `WEBHOOK_NOT_CONFIGURED`; missing signature → 401; invalid signature over the raw body → 401. The "skip when unconfigured" branch is removed from Fireblocks, B2BinPay, Brainrock and Choice Bank verifiers. Production boot refuses missing `FIREBLOCKS_WEBHOOK_PUBLIC_KEY` / `B2BINPAY_CALLBACK_SECRET` and refuses `ALLOW_UNVERIFIED_WEBHOOKS=true`. |
| **F3** USDC and USDT deposits | **Resolved** | USDT-only filter removed. `custody-deposit.ts` resolves the provider asset id through the registry (network + contract); credits USDC_SOL and USDT_SOL; records `BankDeposit.settlementAssetId` and `ProviderEvent{assetId, institutionId, vaultId, entityType, entityId}`. Unsupported network/token → `IGNORED`, never credited. Deposit owned by a different wallet than the destination → `REJECTED`. |
| **F4** Legacy API exposure | **Resolved** | `core/tenancy/customer-auth.middleware.ts`: operator key or institution credential required on `/api/users*`, `/api/transfers*`, `/api/withdrawals*`, `/api/deposits*`, `/api/crypto*`, `/api/orchestrator/*`, `/api/quote*`. Tenant isolation is central: every user id / record id named by the request must belong to the caller's institution, else 404. `User.institutionId` set on creation; lookup-by-email tenant-filtered. Legacy rows with `institutionId = null` are operator-only. |
| **F5** Financial arithmetic | **Resolved on posting paths** | `credit`/`debit` take `Prisma.Decimal.Value`, compare and post in Decimal; `toUSDDecimal` replaces the float conversion on those paths; `getBalance` returns Decimal (reduced to a JSON number only at the display edge). Webhook credits pass the stored Decimal, never `Number(...)`. Remaining float sites are on non-posting legacy paths (see §6). |
| **F6** Asset identity | **Resolved** | `core/assets/registry.ts`: `{ id, symbol, issuer, network, contract, decimals, providerIds }` with `resolveByContract(network, contract)`, `resolveProviderAsset(provider, id)`, `toMinorUnits/fromMinorUnits` (bigint). `SOLANA_MINTS` is now derived from it — the registry is the only place a mint is written. |

## 2. Exact files changed (27)

New:
- `src/core/assets/registry.ts` (F6)
- `src/core/provider-events/provider-event.service.ts` (F1)
- `src/core/provider-events/custody-deposit.ts` (F3)
- `src/core/tenancy/customer-auth.middleware.ts` (F4)
- `src/platform/webhook-policy.ts` (F2)
- `src/__tests__/remediation.step1.test.ts` (19 tests)
- `prisma/migrations/20261106040249_step1_security_remediation/migration.sql`
- `docs/REMEDIATION-STEP1.md` (this file)

Modified:
- `prisma/schema.prisma` — `ProviderEvent`; `User.institutionId`; `BankDeposit.settlementAssetId`; `Institution.users`
- `src/routes/webhook.routes.ts` — Fireblocks + B2BinPay handlers rebuilt around `processOnce`
- `src/routes/transfer.routes.ts`, `deposit.routes.ts`, `orchestrator.routes.ts`, `quote.routes.ts` — guard mounted; `POST /users` stamps institution; lookup filtered
- `src/routes/brainrock.routes.ts`, `src/routes/choicebank.routes.ts` — admission policy
- `src/providers/live/fireblocks.ts`, `b2binpay.ts`, `brainrock.ts`, `choicebank.ts` — verifiers fail closed
- `src/providers/live/solana.ts` — mints derived from registry
- `src/core/ledger.service.ts`, `src/core/fx.service.ts` — Decimal posting paths; `createUser(institutionId)`
- `src/platform/config.ts` — `ALLOW_UNVERIFIED_WEBHOOKS`; production requirements
- `src/__tests__/verification.leg-a.test.ts` — expectations updated where gaps closed
- `frontend/src/api.ts` — ops dashboard sends the operator key (prompted once, sessionStorage)
- `.env.example`, `scripts/demo.sh` — documentation of the new requirement

Not touched: `apps/web/` (AxLink site), `core/settlement/*` (journal, legs, proof, reconciliation), the provider SDK calls, `.do/app.yaml`, CI workflow (already provides `OPS_API_KEY`; no webhook posting in CI).

## 3. Database migrations

`20261106040249_step1_security_remediation` — additive only, no data rewrite:
- `CREATE TABLE "ProviderEvent"` with `UNIQUE (provider, eventId)`, indexes on `(entityType, entityId)` and `institutionId`
- `ALTER TABLE "User" ADD COLUMN "institutionId" TEXT` + FK → `Institution(id)` `ON DELETE SET NULL`
- `ALTER TABLE "BankDeposit" ADD COLUMN "settlementAssetId" TEXT`

Applied with `npx prisma migrate deploy` on a fresh database and on the test database; `prisma migrate deploy` reports no pending migrations afterwards. Rollback = drop the table and the two nullable columns; no existing rows change.

## 4. Tests executed and results

Red commit `41cb819` (before any fix): `npx vitest run src/__tests__/remediation.step1.test.ts` → **18 failed / 18**.

After each fix (commit → tests that turned green):
- `2f599e1` F6 → registry (3)
- `13c1adb` F5 → arithmetic (1)
- `2ae9252` F2 → no signature, tampered body, key unset, B2BinPay bad HMAC/unset (4)
- `0b1ab70` F1+F3 → USDC credit, USDT credit, unsupported network/token ignored, replay, **10 concurrent deliveries credit once**, second distinct event for settled deposit ignored, B2BinPay reversal once, **rollback** (8)
- `c8fb435` F4 → unauthenticated rejected on 9 routes; A cannot read/move B (user, balance, deposits list, transfer, orchestrator), ops retains access (2)
- config fail-closed in production (1)

Final, this branch head:
```
npx tsc --noEmit                                     0 errors
npx vitest run                                       14 files · 215 passed · 0 failed   (run twice; stable)
npx vitest run src/__tests__/remediation.step1.test.ts   19 passed
SIMULATOR_ENABLED=true npm run simulate              10/10 scenarios, ledger invariants hold
npm run build                                        exit 0
cd frontend && npm run build                         OK
node scripts/check-web.js                            web ok: 289 KB, 61 routes
node apps/web/tools/render_check.js                  {"routes":60,"bad":[],"errors":[]}
npx prisma migrate deploy                            No pending migrations
```
Environment: local PostgreSQL 16, `OPS_API_KEY` set, no provider credentials (sandbox); test-generated RSA key for Fireblocks signatures, test HMAC secret for B2BinPay.

Coverage of the required list: duplicate replay ✓ · concurrent duplicates (10×) ✓ · missing signature ✓ · invalid signature ✓ · key unset ✓ · USDC deposit ✓ · USDT deposit ✓ · wrong token mint (registry: wrong contract → null; webhook: `FAKE_SOL` ignored) ✓ · wrong network (`USDC_ETH`, `USDC_POLYGON` ignored; `resolveByContract('ethereum-mainnet', …)` null) ✓ · cross-institution access ✓ · exact arithmetic (`100.123456` credited exactly; Decimal/bigint unit conversion) ✓ · transaction rollback ✓ · frontend + backend regression (existing 196 tests, harness, both builds, site render) ✓.

## 5. Security regression evidence

| Attack | Before (`6d26e5d`, proven in `VERIFICATION-6d26e5d.md`) | After (this branch) |
|---|---|---|
| Unsigned POST to `/api/webhooks/fireblocks` with key unset | accepted, **credited ledger** | 503, no state change |
| Signed event replayed | balance 100 → **200** | 200 `duplicate:true`, balance unchanged |
| 10 concurrent copies of one event | (not tested; would credit up to 10×) | exactly one credit |
| USDC completion at a vault | silently dropped | credited, asset recorded `USDC_SOL` |
| `USDC_ETH` completion | silently dropped (no record) | recorded `IGNORED: unsupported asset or network` |
| `GET /api/users/:id` with no credential | 200, full record | 401 |
| Institution A reads/moves institution B's customer | 200 | 404 (existence not revealed) |
| Production boot without webhook keys | started | refuses to start, lists each missing key |

## 6. Outstanding issues (not in this remediation's scope; listed for the next approved milestone)

1. **Fiat-rail webhooks** (Brainrock, Choice Bank, Daraja) now fail closed on signature, but their credit paths (`brainrock.routes.ts:266`, `daraja.routes.ts:79`) do not yet use `processOnce`. Daraja has no signature at all (Safaricom does not sign; IP allow-listing is the control). These are Leg C rails.
2. **Float arithmetic on non-posting paths**: `fx.service.ts` quotes, `quote.service.ts`, `deposit.service.ts` (fiat on-ramp amounts), `payout-confirmation.service.ts`. They compute display/quote values and request amounts for providers; they do not post to the ledger directly, but the request amounts should move to Decimal before live money.
3. **`SETTLEMENT_ASSET` is still a single global** for the settlement-leg path (`core/settlement/*`); per-institution asset selection needs the `Institution`→wallet→asset link (Step 2). Deposit crediting is already per-event asset-aware.
4. **Legacy `User` rows with `institutionId = null`** are operator-only; backfill after each institution's customers are identified.
5. **`User.vaultId` is the wallet** — there is no `Wallet` model yet; attribution is vault-based. Fine for one vault per customer; a wallet model is Step 2.
6. **Amount cross-check on deposit completion** (Fireblocks `amount` vs `BankDeposit.usdtAmount`) is recorded but not enforced — fees can legitimately reduce the received amount; policy decision needed.
7. S4 (plaintext `Bank.webhookSecret`) and S9 (rate limiting) remain open as before.
8. **Mint addresses still not verified against a live RPC node** from this environment (no network access to Solana).
9. The ops dashboard prompts for the operator key; a proper operator login is Step 2.

## 7. Commit hashes (oldest → newest, all on `step-1-security-remediation`)

```
41cb819  test(remediation): failing tests for F1–F6 (red before fix)
2f599e1  fix(F6): asset registry keyed by network + contract; SOLANA_MINTS derived from it
f594dbf  schema(remediation): ProviderEvent, User.institutionId, BankDeposit.settlementAssetId
13c1adb  fix(F5): Decimal-exact credit/debit/balance checks
c8ed320  test(verification): F5 gap closed
2ae9252  fix(F2): webhooks fail closed; keys required in production
0b1ab70  fix(F1,F3): exactly-once provider events; USDC and USDT deposits settle by registry asset
c8fb435  fix(F4): legacy customer API requires operator/institution credential; tenant isolation
(head)   docs(remediation): completion report; audit statuses; config test — the branch head hash is reported in the submission message, since this file cannot contain its own commit hash
```

## 8. Codex review status

**Pending.** This branch is submitted for independent Codex review. It has not been merged into `step-1-foundation` or `main`, and nothing has been deployed. Stopped here; Step 2 (restructure, port mapping, wallet model) awaits explicit approval.
