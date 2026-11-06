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

**Results at this slice:** `tsc` clean · vitest 18 files, 268 passed · harness 10/10 · builds OK · site 61 routes.

**Not in this slice (next):** per-wallet settlement asset selection on the leg path; reconciliation check `WalletBalance` vs journal custody account; institution self-service wallet creation (portal); production custody go-live checklist.
