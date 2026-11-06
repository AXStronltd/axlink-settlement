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

## Slice 4 — `/api/v1` institution contract (Architecture Blueprint names)

**What.** The bank-facing API now exists under `/api/v1` with exactly the route names the AxLink Architecture Blueprint publishes, so the document a client reads and the API it calls agree. The older `/api/wallets`, `/api/deposits/instructions`, `/api/settlements`, `/api/webhooks/endpoints` routes stay mounted as aliases of the same services; nothing already integrated breaks.

| Route | Scope | Backed by |
|---|---|---|
| `GET /v1/institutions/me` | any | tenancy context + `permissions` |
| `GET /v1/assets` | any | `packages/core/assets/registry.ts` (supported assets, networks, finality) |
| `POST /v1/wallets` · `GET /v1/wallets` · `GET /v1/wallets/{id}` | `wallets:write` / `wallets:read` | `wallet.service` — an institution now provisions its own wallet in the environment its credential is bound to (operator creation under `/api/institutions/{id}/wallets` remains) |
| `POST /v1/custody/deposit-addresses` | `wallets:read` | the wallet's one receiving address, with the assets it accepts |
| `GET /v1/balances` | `wallets:read` | `statement.service.institutionBalances` — journal-derived, per asset, with the per-wallet split |
| `POST/GET /v1/deposits`, `GET /v1/deposits/{id}`, `POST /v1/deposits/{id}/cancel` | `deposits:*` | deposit instructions (slice 2) |
| `GET /v1/settlements/{id}` | `settlements:read` | settlement status with proof (slice 2) |
| `GET /v1/ledger/entries` | `ledger:read` | `statement.service.listInstitutionEntries` — journal entries touching this institution's `CUSTODY:<vault>:*` and `INSTITUTION:<id>:*` accounts, **only those lines**, newest first, cursor-paged (`postedAt|id`), filters `asset`, `entityType`, `entityId` |
| `POST/GET/DELETE /v1/webhook-endpoints` | `webhooks:*` | signed institution webhooks (slice 2) |
| `POST /v1/transfers`, `GET /v1/transfers/{id}`, `POST /v1/settlements` | — | **501 `NOT_YET_AVAILABLE`** until outbound settlement (slice 5); named now so integrators can plan |

Files: `apps/api/src/routes/v1.routes.ts`, `packages/core/ledger/statement.service.ts`, `openapi/openapi.json` (version `2.2.0-step2`, tag `v1`), tests `tests/integration/v1.step2.test.ts` (2: every route answers + aliases + 501s; ledger view after two settled deposits — two lines each, tenant B sees nothing, paging, filters, scopes). Front end: Developers page base URL is `/api/v1`, endpoint table is the blueprint list with `next` badges on the two outbound routes (`align_step2.py`, slice 4).

### Blueprint phases → repository slices

| Blueprint phase | Where it lives | Status |
|---|---|---|
| 01 Foundation & Security | Step 1 (`docs/REMEDIATION-STEP1.md`): fail-closed webhooks, exactly-once provider events, tenant guard, Decimal arithmetic | done, independently reviewed |
| 02 API & Tenant Isolation | Step 1 institutions + scoped credentials; Step 2 slice 4 `/v1` contract; idempotency via `postingKey`/`ProviderEvent` uniqueness | done |
| 03 Registry & Ledger | `packages/core/assets/registry.ts`, `packages/core/ledger/*` (balanced journal, projections reconciled) | done |
| 04 Institutional Custody | Step 2 slice 1 wallets + slice 3 Fireblocks adapter on the custody port | done |
| 05 Stablecoin Deposits | Step 2 slice 2 deposit instructions, custody receipt → Solana finality proof, mint + amount check, signed webhooks | done |
| 06 Transfer Engine | Step 2 slice 5 — `POST /v1/transfers`: counterparties (whitelisted, screened), policy checks, balance reservation, custody transfer, finality proof, retries | next |
| 07 B2B Settlement | Step 2 slice 5/6 — `POST /v1/settlements` between participating institutions on the network | planned |
| 08 Reconciliation | `reconciliation.service.ts` (trial balance, projection drift, custody vs ledger via the ports, on-chain positions) exists; exception queue + operator screen to finish | partly done |
| 09 Developer APIs | `/v1` contract + OpenAPI (slice 4), signed outbound webhooks (slice 2); SDKs (`packages/sdk`) to follow | partly done |
| 10 Production Readiness | dedicated Solana node, secrets, runbooks, certification tests, formal approval — **no production deployment without authorisation** | planned |

**Independent review (fresh reviewer, 838e4d8) and what changed.**

| Finding | Severity | Fix |
|---|---|---|
| `GET /v1/ledger/entries` selected entries by the `INSTITUTION:<id>:<ASSET>` liability account, which is keyed by institution, not environment — a SANDBOX key could read PRODUCTION postings of its own institution | High | Entries are selected only through the CUSTODY accounts of the credential's environment; the INSTITUTION line is displayed when it sits on such an entry. Test: a production-style posting is invisible to the sandbox key |
| Wallet label uniqueness was check-then-write; concurrent `POST /v1/wallets` could mint two custody vaults; no cap per environment | Medium | `@@unique([environmentId, label])` (migration `step2_wallet_label_unique`), `P2002` → 409 with the winning `walletId` and the orphan vault logged for operations; `MAX_WALLETS_PER_ENVIRONMENT` (20) |
| `GET /v1/balances` was 2 queries per wallet per asset | Medium | One account lookup + one grouped sum |
| `POST /v1/custody/deposit-addresses` returned 201 with a possibly-null address, ignored wallet status, and `assets: []` for a bad filter | Medium | 200 (nothing is created); 409 `WALLET_NOT_ACTIVE`, 503 `ADDRESS_NOT_ISSUED`, 400 `ASSET_NOT_ON_NETWORK` |
| 501 placeholders ran after the settlement sub-router's scope check, so the answer depended on scopes | Low | Registered before the sub-routers |
| A mangled cursor silently restarted at page 1 | Low | 400 `INVALID_CURSOR` |
| Every composed route authenticated twice | Low | `requireInstitution` is a no-op when the enclosing router already set `req.tenant` |
| Scope strings were only regex-validated at issuance (`ledger:raed` issued silently) | Low | `KNOWN_SCOPES` enum at issuance; tests and web updated to the canonical names |
| (pre-existing) key hash compared with `!==` | Info | `timingSafeEqual` |

## Slice 5 — Outbound settlement: counterparties and transfers

**What.** The first slice that moves money *out* of a vault: `POST /v1/transfers` (and its blueprint name `POST /v1/settlements`) settles USDC or USDT from an institution's wallet to an approved counterparty address, journaled before custody is called and COMPLETED only on Solana finality. Nothing in this slice can move live funds: PRODUCTION outbound is refused unless `OUTBOUND_SETTLEMENT_ENABLED=true` is set deliberately, and even then every production transfer waits for an operator.

| Piece | Where |
|---|---|
| Counterparties | `packages/settlement/transfers/counterparty.service.ts` — register (valid network address; AxLink's own wallets refused; unique per environment), list, disable. **SANDBOX: ACTIVE at once. PRODUCTION: PENDING_APPROVAL** until an operator approves with `custodyWhitelisted: true`, an attestation that the address is whitelisted at the custodian (Fireblocks TAP) — AxLink does not automate the custodian's whitelist on purpose |
| Transfers | `packages/settlement/transfers/settlement-transfer.service.ts` — lifecycle `AWAITING_APPROVAL → APPROVED (journaled) → SUBMITTED (custody) → CONFIRMED (txHash) → SETTLED (finality)`; `FAILED` reverses the journal; `REJECTED` / `CANCELLED` before posting |
| Policy | per-transfer limit (`TRANSFER_MAX_AMOUNT`, 1,000,000), available = journal balance − transfers awaiting approval, counterparty and wallet ACTIVE, asset on the wallet's network; sandbox auto-approves up to `TRANSFER_AUTO_APPROVE_LIMIT_SANDBOX` (100,000); the checks are recorded on the row (`policy`) |
| Idempotency | `Idempotency-Key` header required; unique per environment; same request → same transfer (200), different body → 409 `IDEMPOTENCY_MISMATCH`; `externalTxId = transfer.id` at the custodian so a crash-and-retry cannot pay twice |
| Journal | at APPROVED: `CUSTODY:<vault>:<ASSET>` − / `INSTITUTION:<id>:<ASSET>` + (`SETTLEMENT`, posting key `SettlementTransfer:<id>:debit`); on failure the entry is reversed (`reversesId`) and the wallet projection restored |
| Custody | `providers.custody().transferExternal` via the port; sweeper submits APPROVED rows with backoff 30 s → 2 m → 10 m → 30 m → 1 h, terminal after 5 attempts; status by Fireblocks webhook (`source.type = VAULT_ACCOUNT`, matched by `providerTxId`, exactly once) or by polling `getTransfer` |
| Finality | `proveSettlement` on the txHash with the counterparty address (mint + exact amount); custody-confirmed-but-chain-disagrees is **never auto-reversed**: recorded, `attention: true`, `transfer.failed` with status PROCESSING, a person decides. Sandbox stub has no chain → `SANDBOX_SIMULATED`, stated as such |
| Events | `transfer.submitted`, `transfer.settled`, `transfer.failed` on the signed institution webhooks |
| Operator | `GET /api/settlement/transfers/pending`, `POST …/:id/approve|reject`, `POST …/transfers/sweep`, `GET /api/settlement/counterparties/pending`, `POST …/:id/approve|reject` |
| Routes | `apps/api/src/routes/transfer-v1.routes.ts` (`/v1/counterparties`, `/v1/transfers`), `v1.routes.ts` (`POST /v1/settlements` alias, `GET /v1/settlements/{id}` answers for deposits and transfers), webhook hook in `webhook.routes.ts` |
| Schema | `Counterparty`, `SettlementTransfer` (migration `step2_outbound_settlement`); the legacy Leg B `Transfer` model is untouched |
| Scopes | `counterparties:read|write`, `transfers:read|write` (`settlements:*` accepted for transfers as the blueprint alias) |
| Front end | Settlements screen in transfer terms (stage, finality, lifecycle), New Settlement dialog in API terms, Counterparties in registration/approval terms, Approvals queue mirroring the operator endpoints, Developers list (`align_step2.py`, slice 5; markers of earlier slices made durable so the script re-runs from any state) |
| Tests | `tests/integration/transfers.step2.test.ts` (6): sandbox end to end with ledger and webhooks; policy and tenancy refusals; approval/reject/cancel with reservation semantics; real-shaped custody adapter → webhook CONFIRMED → on-chain proof → SETTLED, public proof; custody failure reverses; retry/backoff/terminal failure; PRODUCTION gating and counterparty attestation. Outbox `drain()` gained an `only: { entityId }` filter so parallel test workers do not deliver each other's rows |

**Not in this slice (on purpose):** internal transfers between two AxLink institutions as one custody move (`transferInternal`), daily/velocity limits, screening of counterparty addresses against a sanctions provider — all planned for slice 6 (B2B settlement on the network) together with the operator exception queue.

**Independent review (fresh reviewer, def067c, money-out lens) and what changed.**

| Finding | Severity | Fix |
|---|---|---|
| Two concurrent creates (or a create and an operator approve) could both pass the balance check and both post — overdraft, two real custody transfers | **Critical** | Every balance-changing decision takes a row lock on the wallet (`SELECT … FOR UPDATE`) inside the transaction; after posting, the custody account is re-read and the transaction aborts if negative. Test: five concurrent 80s against 100 → one 202, four 422, journal never negative |
| The live Fireblocks `createTransfer` swallowed every API error and returned a fabricated `COMPLETED` stub — a rejection or timeout on a real workspace would have parked the institution's money as "confirmed" | **Critical** | Live errors now throw (`CUSTODY_SUBMIT_FAILED`, retryable); the submission path refuses a `_sandbox_` id on a configured workspace and fails the transfer (journal restored) |
| Two instances / overlapping sweeps could submit the same APPROVED row twice | High | Atomic claim `APPROVED → SUBMITTING` with a lease before custody is called; expired leases are re-claimed; the sweeper has a running guard |
| A timeout after the custodian accepted would be retried, hit the duplicate-`externalTxId` refusal, exhaust attempts and **reverse the journal for money that had left** | High | Before any resubmission and before any terminal failure the custodian is asked `findTransferByClientRef(transfer.id)` (Fireblocks `GET /transactions/external_tx_id/…`); a held transaction is adopted as SUBMITTED. Test: one submission, recovered, balance unchanged |
| Approval and submission ignored counterparty/wallet state — a counterparty disabled after the request could still be paid | High | Checked at approval (409) and at submission (refused before custody, journal restored) |
| The on-chain proof summed every credit of the mint; the right amount to the **wrong address** would have proven | High | `requireRecipient` for outbound: only movements whose owner is the counterparty count. Test: payment to someone else is a mismatch |
| Production kill switch checked only at create | Medium | Checked at approval and in the sweeper (rows deferred, logged) |
| A custody `FAILED` after broadcast (txHash known) reversed the journal | Medium | Never reversed after broadcast: flagged `attention`, `transfer.failed` with status PROCESSING, a person verifies on chain |
| No alarm for a negative custody account | Medium | Reconciliation `NEGATIVE_CUSTODY` (CRITICAL) check |
| `providerTxId` not unique; no index for the reservation aggregate | Medium | `@unique`, `(walletId, assetId, status)` index (migration `step2_outbound_review`) |
| Replay ignored `reference`; reject emitted outside its transaction; `/v1/settlements/{id}` refused `transfers:read`; OpenAPI gaps | Low | All fixed |

Noted, not changed: the Solana address check is base58-shape only (the custodian's whitelist is the control that matters); the `ADDRESS_IS_AXLINK_WALLET` check runs at registration.

## Slice 6a — Portal connected

**What.** The AxLink portal stops being a demonstration the moment an institution signs in with its API key. The API serves the page itself at `GET /portal` (one process in sandbox, same origin, no CORS); the page calls `/api/v1` with the key and renders exactly what comes back. The key lives in `sessionStorage` only (gone when the tab closes), the environment is whatever the key is bound to, and the "figures are illustrative" banner is replaced by a live strip naming the institution, environment and API base.

| Piece | Where |
|---|---|
| Live layer | `apps/web/tools/live_portal.js` — single source, inlined into `index.html` by `align_step2.py` (slice 6a); `axApi()` is the one fetch wrapper; every screen is a view over one GET, every button one POST |
| Screens | Overview, Wallet (`/wallets`, `/balances`, `/deposits` + Announce a deposit, New wallet, Cancel), Settlements (`/transfers` + New settlement with Idempotency-Key, Cancel), Counterparties (`/counterparties` + Register, Disable), Webhooks (`/webhook-endpoints` + deliveries, secret shown once), Developers (`/institutions/me`, `/assets`, `/ledger/entries`) |
| Deliveries | `GET /v1/webhook-endpoints/{id}/deliveries` — recent outbox rows for the endpoint: event, attempts, last status, next retry |
| Reference tenant | `scripts/seed-sandbox.ts` → `npm run seed:sandbox`: AxLink Reference Institution (`axlink-reference`) with a SANDBOX environment, a `Treasury` wallet and a portal-scoped key printed once (`--new-key` for another). Idempotent |
| Sign-in | "Connect with your API key" is the real credential; "Explore the demo" keeps the illustrative mode for prospects. A wrong key never connects and leaves nothing in storage |
| Test | `tests/integration/portal.step2.test.ts` drives headless Chromium against the Express app: serve `/portal`, connect with the seeded key, banner gone, real wallet shown, register a counterparty / announce a deposit / attempt a settlement from the UI and verify the rows in the database and the API's error surfaced in the toast |

Screens that are still illustrative in live mode (no API behind them yet): Transactions, Sub-Accounts, Balances, Compliance, Reports, Team, Settings — the sidebar is unchanged so the product shape stays visible; each flips to live as its API lands.

**Independent review (fresh reviewer, eb5c91b, browser-security lens) and what changed.**

| Finding | Severity | Fix |
|---|---|---|
| Stored XSS: the live layer concatenated API values (labels, references, webhook URLs, operator reasons, custody error text) into HTML unescaped — a same-tenant key holder could plant a script that the treasury officer's broader key would then execute | High | Every string from the API is HTML-escaped at the boundary (`liveSan` in `axApi`) before it is stored; `toast()` renders its message as a text node; the strip and `title` attributes use escaped values. Test: a counterparty label containing `<b>` renders as text |
| Delivery history was matched by URL — two institutions sharing an ingress URL could read each other's rows | Medium | `OutboxEvent.webhookEndpointId` (migration `step2_outbox_endpoint_scope`) set at emit time; deliveries scoped by endpoint id |
| Seed script could run against production, re-activated a suspended institution, printed a broad key to any stdout | Medium | Refuses `NODE_ENV=production`; never re-activates; prints the key only on a terminal (or `--print-key`); tenant renamed to `axlink-reference` — an internal stand-in, not a client |
| No security headers on `/portal`; file path cwd-relative | Medium | CSP (`connect-src 'self'` — an injected script could not ship a key elsewhere; `frame-ancestors 'none'`), `nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`; path resolved from the module, overridable with `PORTAL_FILE`, 503 if missing |
| Browser test failed hard without Chromium | Medium | Skips with a logged reason when no browser is available |
| Key stored before validation; user-typed base unvalidated and overriding the `/portal` origin | Low | Nothing is stored until `/institutions/me` succeeds; base must be `https://` (or `http://localhost`); ignored when served from `/portal` |
| Delivery status `ABANDONED` mis-rendered; deliveries route missing from OpenAPI; test assertions weaker than described | Low | Fixed |

## Slice 6b — Network settlement and the operator exception queue

**Network settlement.** An institution can now settle to another AxLink participant by slug, not by address: `POST /v1/counterparties { label, participant: "<slug>" }` creates a `NETWORK` counterparty (active at once — the destination is a vault in AxLink custody held by a KYB'd participant, so there is nothing to whitelist at the custodian). A transfer to it runs the same policy, approval and journal path as an external one, with three differences: the receiving participant's settlement wallet (its oldest ACTIVE wallet in the same environment kind) is fixed at approval; submission is `custody.transferInternal` vault-to-vault; and at SETTLED the receiver is credited (`CUSTODY:<its vault>+ / INSTITUTION:<it>−`, posting key `SettlementTransfer:<id>:credit`, same entity id in both ledgers) and notified with `settlement.received`. The custody-deposit path refuses vault-sourced receipts, so the credit happens exactly once, here. A failure before broadcast restores the sender and never touches the receiver.

**Exception queue.** `OperationalException` is one open item per (kind, subject, asset): reconciliation re-runs bump `occurrences`/`lastSeenAt`; a FULL run auto-closes items of reconciliation kinds it no longer sees; a transfer where custody and the chain disagree raises `TRANSFER_ATTENTION` (CRITICAL). Operators acknowledge and resolve with a required note; a recurrence after resolution opens a new item (resolution is a statement about the past). Partial unique index on open items only. Routes: `GET /api/settlement/exceptions`, `POST …/{id}/acknowledge`, `POST …/{id}/resolve`.

**Operator console (front end).** AxLink staff connect the portal with the operator key ("Operator sign-in" on the sign-in page): Alerts becomes the exception queue (acknowledge, resolve, run reconciliation), Approvals the real transfer/counterparty queue (approve, reject with reason, attest whitelisting), Providers the live adapter health. Same rules as the institution side: key in session storage only, everything from the API escaped at the boundary. Counterparty registration in the institution portal offers "network participant" or "external address".

Files: `packages/settlement/operations/exception.service.ts`, `counterparty.service.ts` (NETWORK, `settlementWalletFor`), `settlement-transfer.service.ts` (receiving wallet at approval, internal submission, credit at SETTLED, exceptions on attention), `reconciliation.service.ts` (queue feed + auto-close), `settlement.routes.ts` (exceptions), `transfer-v1.routes.ts` (participant), `live_portal.js` (operator console), migration `step2_network_settlement_exceptions`. Tests: `tests/integration/network.step2.test.ts` (3: A→B end to end with both ledgers, webhooks and idempotent finality; participant not ready / failure before broadcast; queue lifecycle with reconciliation feed and auto-close), `portal.step2.test.ts` (+1: operator console in a real browser).

Out of scope, still: velocity/daily limits and sanctions screening of external addresses (slice 7 with production readiness).
