# Step 2 — Wallets, institution API, provider ports, portal connection

*Started 2026-11-06 on `main`, after Step 1 closed at `44e1a18`. Claude works alone (Codex stopped). Each slice: branch → tests → fresh-reviewer pass → merge to `main`.*

## Slice 1 — Wallet model

**What.** `Wallet` = one institution, one API environment (SANDBOX/PRODUCTION), one custody vault on one network, one deposit address, one `WalletBalance` per registry asset. The balance is a projection of the journal's custody account, moved in the same transaction as the posting.

| Piece | Where |
|---|---|
| Models + migrations | `prisma/schema.prisma` (`Wallet`, `WalletBalance`, `ProviderEvent.walletId`, `User.wallet`), `20261106065019_step2_wallets`, `20261106065215_step2_wallets_legacy_link` |
| Service | `packages/core/wallets/wallet.service.ts` — create (custody vault + address through a registered `WalletCustody` adapter; sandbox stub when unconfigured, refused in production), list/get scoped by institution **and** environment, projection update |
| Custody adapter | `packages/providers/custody/fireblocks/fireblocks.wallet-custody.ts` + `createVaultAssetAddress` in `fireblocks.ts` (no stub address on failure — an invented address would receive real money); registered in `apps/api/src/bootstrap/runtime.ts` |
| Deposit attribution | `packages/webhooks/custody-deposit.ts`: the destination vault's wallet is the owner of record; rejects when wallet and legacy user disagree on institution, when the wallet is not ACTIVE, or when the asset's network differs; credits `WalletBalance` with the journal |
| API | operator `POST/GET /api/institutions/:id/wallets`; institution `GET /api/wallets`, `/api/wallets/:id`, `/api/wallets/:id/balances` (scope `wallets:read`); OpenAPI updated |
| Backfill | `scripts/backfill-wallets.ts` (`--dry-run`): legacy users with a vault and an institution get a SANDBOX wallet carrying their canonical balances; links to an existing wallet instead of duplicating; idempotent |
| Tests | `tests/integration/wallets.step2.test.ts` (8): create, production refusals, unsupported network, tenant + environment isolation (404), scope, custody receipt moves wallet balance atomically with replay, rejection cases, backfill |

**Independent review (fresh reviewer, no critical; 1 high, 4 medium, 3 low) and what changed:**

| Finding | Fix |
|---|---|
| H1 — `WalletBalance` was a credit-only projection; any debit path would leave the institution API showing stale funds | The API now serves the **journal** figure (`CUSTODY:<vault>:<ASSET>` account) and returns the projection beside it with a `drift` flag; `reconciliation.service` gained `checkWalletProjectionDrift` (CRITICAL break on any disagreement) |
| M1 — suspending a wallet permanently stranded a receipt (rejection was recorded as the event) | SUSPENDED now throws a retryable error: transaction rolls back, no event row, the provider's retry settles once re-activated; CLOSED is a hard rejection |
| M2 — a PRODUCTION wallet could be created on stub/sandbox custody when `NODE_ENV` ≠ production | Gate is `custodyEnvironmentKind()` (real credentials on the production workspace → PRODUCTION; Fireblocks sandbox or stub → SANDBOX); PRODUCTION wallets need production custody (503), SANDBOX wallets cannot be created on a production-bound deployment (409) |
| M3 — different addresses per asset were logged, not refused | Refused (502), wallet not created |
| M4 — environment not enforced on receipts | A receipt is rejected when the deployment's custody kind differs from the wallet's environment |
| M5 — backfill link branch skipped balances; symbol-keyed accounts silently dropped | Projection seeded from the **journal** (never from `Account.balance`); disagreements and dropped fiat accounts are printed for the operator |
| L1 — orphan vault on retry | Stable custodian ref (`institution:env:label`) and label unique per environment (409 with the existing wallet id) |
| L3 — institution status unchecked; unknown institution listed `[]` | Checked (409); 404 |

**Latent Step 1 bug found by the suite:** credential lookup prefix was 12 chars = only 2 random characters under a unique index → issuance failed randomly after a few hundred keys. Prefix is now 20 chars (legacy keys still resolve by their 12-char prefix).

**Results at this slice:** `tsc` clean · vitest 18 files, 271 passed (3 consecutive runs) · harness 10/10 · builds OK · site 61 routes.

**Not in this slice (next):** wallets created through the API still need a linked legacy `User` row to settle a deposit instruction (the instruction model is slice 2's job); per-wallet settlement asset selection on the leg path; institution self-service wallet creation (portal); production custody go-live checklist. Backfilled legacy vaults are SANDBOX wallets: a production deployment rejects receipts into them until the operator moves them, by design.
