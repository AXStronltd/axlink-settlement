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

**Front end aligned (same commit):** Developers page lists `GET /wallets` and `GET /wallets/{id}/balances` as live with the real response shape; the Wallet screen shows balances by asset in the API's terms (`USDC_SOL`, `USDT_SOL`, exact decimal strings) beside the deposit address. Applied by `apps/web/tools/align_step2.py` (idempotent).

**Not in this slice (next):** wallets created through the API still need a linked legacy `User` row to settle a deposit instruction (the instruction model is slice 2's job); per-wallet settlement asset selection on the leg path; institution self-service wallet creation (portal); production custody go-live checklist. Backfilled legacy vaults are SANDBOX wallets: a production deployment rejects receipts into them until the operator moves them, by design.

## Slice 2 — Settlement API: deposit instructions, status with proof, signed webhooks

**What.** An institution announces an incoming deposit to one of its wallets (`POST /deposits/instructions` → deposit address + tracking id). The Fireblocks receipt that names the tracking id settles it only when asset, exact amount, wallet and environment all match. `GET /settlements/{id}` reports PROCESSING · COMPLETED · FAILED; **COMPLETED means a Solana node reported the receipt finalized**, not that the custodian said so (custody confirmation is `RECEIVED`/`CUSTODY_CONFIRMED`; the finalizer proves it on chain and only then marks `SETTLED`/`ON_CHAIN_FINALIZED`). Signed webhooks to the institution: `deposit.received`, `deposit.settled`, `deposit.rejected`, `deposit.expired`.

| Piece | Where |
|---|---|
| Models + migrations | `DepositInstruction` (PENDING → RECEIVED → SETTLED; CANCELLED, EXPIRED), `WebhookEndpoint` (secret AES-256-GCM at rest); `20261106…step2_deposit_instructions_webhooks`, `…instruction_received_state` |
| Settlement path | `packages/webhooks/custody-deposit.ts` `settleInstruction`: same evidence rules as Step 1, claim, journal `CUSTODY+ / INSTITUTION−`, wallet projection, `deposit.received` — one transaction. Rejections recorded on the instruction (`attention`) and announced (`deposit.rejected`) |
| Finality | `packages/settlement/deposits/deposit-instruction.service.ts` `finalizeReceivedInstructions` (sweeper tick): `proveSettlement` on the tx hash; on-chain mismatch is recorded and announced, never COMPLETED |
| Webhooks | `packages/core/webhooks/webhook-endpoint.service.ts`, `url-policy.ts` (public https only; loopback/private/link-local/metadata refused at registration and at delivery; redirects never followed), `outbox.service.ts` channel `institution.webhook`: `X-AxLink-Signature: t=…,v1=…`, `X-AxLink-Event-Id`, retries 1m/5m/30m/2h/12h on 5xx/408/429, other 4xx final |
| API | `/api/deposits/instructions[/:id[/cancel]]`, `/api/settlements/:id`, `/api/webhooks/endpoints`; OpenAPI; `WEBHOOK_ENCRYPTION_KEY` required in production, `WEBHOOK_ALLOW_INSECURE_URLS` tests only |
| Front end | Developers page: endpoints live, real shapes and scopes, finality semantics spelled out, four events; deposit dialog in instruction terms (`apps/web/tools/align_step2.py`, idempotent across slices) |
| Tests | `tests/integration/settlements.step2.test.ts` (9): end-to-end settle through a signed Fireblocks event → RECEIVED → finalized COMPLETED with on-chain proof and both webhooks; six rejection cases with institution-visible attention; on-chain mismatch; 10 concurrent copies → one credit; isolation + scopes + validation; SSRF URL policy + redirect refusal; expiry + retry schedule; encryption + production config |

**Independent review (no critical; 1 high, 4 medium, 5 low) and what changed:** SSRF through webhook URLs → URL policy at registration and delivery, `redirect: 'manual'`; decrypt failure stranding outbox rows → inside the try, permanent fail; COMPLETED on custody evidence alone → RECEIVED state + on-chain finalizer; rejected receipts invisible → `attention` + `deposit.rejected`; dev encryption key outside development/test → refused; expiry/settle race reason; 4xx documented; `?status` validated; amount length capped; internal-move guard checks legacy users too.

## Slice 3 — Providers on the ports

**What.** Fireblocks, B2BinPay and Solana are adapters implementing the port interfaces, obtained from one registry. Nothing under `packages/core`, `packages/settlement` or `packages/webhooks` imports a vendor module any more (enforced by `tests/integration/verification.leg-a.test.ts`). Swapping a provider is one adapter registered at boot.

| Piece | Where |
|---|---|
| Ports | `packages/providers/ports/*.port.ts` — `CustodyProvider` gains `configured()`; `BlockchainProvider` gains `getTransaction` detail with token movements, `awaitFinality` throwing `ChainTransactionFailed` on a definite on-chain failure |
| Adapters | `custody/fireblocks/fireblocks.custody-provider.ts`, `liquidity/b2binpay/b2binpay.liquidity-provider.ts`, `blockchain/solana/solana.blockchain-provider.ts` — each routes through the runtime seam (`ports()`) where one exists, so the settlement harness still stubs the rails |
| Registry | `packages/providers/registry/provider-registry.ts` — `providers.custody() / liquidity() / blockchain(network)`, `register*Provider`, `describeProviders()`; defaults registered lazily and explicitly at boot |
| Core on the ports | `wallet.service` (vault + address via `CustodyProvider`), `proof.service` (finality + token movements via `BlockchainProvider`, asset by registry id or symbol), `reconciliation.service` (custody balances and on-chain balances via the ports), `accounts.ts` (default settlement symbol from the registry) |
| Legacy facade | `packages/providers/legacy/index.ts` — the frozen Leg B services (transfer, orchestrator, interbank, treasury, fiat deposit) import the same functions through this one file instead of naming vendors; deleted when the last of them is migrated or retired |
| Operator view | `GET /api/settlement/providers` (operator key): role, adapter, configured/stub, live health; the Providers screen mirrors it |
| Tests | `tests/integration/providers.step2.test.ts` (6): adapter conformance in sandbox mode, registry defaults and swap, wallet creation on a swapped adapter, operator endpoint, proof through the blockchain port by id and by symbol; verification test now asserts **zero** vendor imports in core |

**Independent review (fresh reviewer, 95095ca) and what changed.**

| Finding | Severity | Fix |
|---|---|---|
| Solana adapter turned a finality *timeout* (node lagging / rate-limited) into `ChainTransactionFailed`, which the proof service records as a permanent on-chain failure and `finalizeReceivedInstructions` emits as `deposit.rejected` — for a deposit that finalizes seconds later | High | `SettlementNotFinalError` now carries `reason: 'execution_error' \| 'timeout'`; only an execution error maps to `ChainTransactionFailed`, a deadline is rethrown `retryable: true` and the settlement stays unproven for the next sweep |
| Custody balance for reconciliation was `available + pending`; Fireblocks `total` also includes frozen/locked holds that are still ours on the ledger → spurious `CUSTODY_MISMATCH` or a masked break | Medium | `getBalance` returns `total` when the custodian reports one; reconciliation prefers it |
| `register*Provider` had no production guard: a stray registration with `configured: () => true` would flip the deployment to PRODUCTION custody and persist stub vaults as production wallets | Medium | `freezeProviders()` after boot; replacements then refused in production and require `SIMULATOR_ENABLED=true` elsewhere (same rule as `useTestPorts`) |
| B2BinPay `execute()`/`getOrder()` were type-correct placeholders that would create a real zero-amount order with live credentials | Medium | Both throw `LIQUIDITY_EXECUTE_UNSUPPORTED` — fiat conversion is Leg B and not enabled; quote, webhooks and health remain |
| Operator `/providers` health calls ran sequentially with no timeout; `configured` inferred from the health text, `null` without a health call | Medium | Health calls in parallel, each bounded by 5 s; `configured` from the adapter's own `configured()` (`LiquidityProvider` gains it); defaults loaded before describing |
| `FIREBLOCKS_USDT_ASSET` override honoured by the legacy services but not the registry | Low | Registry provider ids honour `FIREBLOCKS_USDC_ASSET` / `FIREBLOCKS_USDT_ASSET` |
| Adapter `parseWebhook` diverged from the live route (no decimal-lexeme reviver, DEPOSIT lacked `externalTxId`/`network`/`contract`/source) | Low | Same reviver; DEPOSIT shape carries the attribution fields; `verifyWebhook` documented as pinned-key only — the route remains the admission point (pinned key or JWKS) |
| Proof `slot` fell back to `0` when neither call reported one | Info | Throws `PROOF_UNAVAILABLE` (retryable) instead of recording a bogus slot |

Noted, not changed: `usd-corridor.service.ts` (frozen Leg B) still reaches custody through the runtime seam rather than the registry — a replaced custody adapter does not reach the corridor engine. It is retired with Leg B, not migrated.
