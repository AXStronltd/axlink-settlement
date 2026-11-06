# Financial modules — architecture for Steps 2+

*Documentation only. None of this is implemented in Step 1. Each section names what exists today, what is missing, and the design that will be built on the Step 1 foundation (institutions, environments, credentials, ports).*

## Invariants that hold across every module

1. **Tenant on everything.** Every ledger account, wallet, transfer, payout, webhook and audit row carries `institutionId` and `environmentId`. Sandbox and production never share a row, a vault or a key.
2. **The ledger is the record of truth.** Custodian balances, chain state and bank balances are evidence reconciled against it.
3. **Decimal money only.** Strings in APIs, `Decimal` in the database. No floats anywhere on an amount.
4. **Our id travels.** Every outbound provider call carries our `clientRef`; a retry cannot act twice. Every inbound event is stored by provider event id; duplicates are ignored.
5. **Finality is proven**, never assumed: custodian final **and** chain final before a settlement completes.
6. **No provider name inside the core.** Adapters implement `src/providers/ports`; a lint rule enforces the boundary.

## 1. Immutable double-entry ledger
- **Exists:** `JournalEntry`/`JournalLine`, balanced per currency (`journal.service.ts`); `LedgerAccount` projections; trial balance in reconciliation.
- **Missing:** tenant columns on journal rows; database-level append-only guard (trigger rejecting UPDATE/DELETE); hash-chained audit; account naming convention per institution/environment.
- **Design:** `institutionId`, `environmentId`, `asset`, `chain` on every line; `ledger_entry` append-only by trigger; balances derived (`SUM(credits) − SUM(debits)`) under an advisory lock per account for holds; holds as `account:hold` sub-accounts; reversal is a new entry, never an edit.

## 2. Institutional wallet management
- **Exists:** `Bank.vaultId` (one Fireblocks vault per member), `Account` per user with projected balances.
- **Missing:** institution-owned omnibus vaults per environment, sub-ledger wallets for an institution's end users, address registry.
- **Design:** one custody vault per institution per environment (`CustodyProvider.createVault`); end-user wallets are sub-ledgers inside it (no per-user vault); deposit addresses per vault/asset; a treasury float sub-ledger inside each vault so on-ramp/off-ramp are ledger moves, not chain transactions.

## 3. Stablecoin deposits and transfers
- **Exists:** USDT on Solana via Fireblocks; `SettlementLeg` with plan-before-act; deposit detection via Fireblocks webhooks.
- **Missing:** both assets (`USDC`, `USDT`) first-class per vault, per-institution deposit crediting with confirmations policy, whitelisted external destinations with approvals.
- **Design:** `asset`+`chain` on every movement (config-selected, not hard-coded); inbound deposit → `ProviderEvent` → credit after N confirmations; outbound only to addresses in a whitelist registry (screened, dual-approved, mirrored at the custodian); amounts above a threshold wait for two operator approvals, with a timeout.

## 4. Cross-chain settlement
- **Exists:** nothing (Solana only).
- **Design:** `CrossChainProvider` port (routes, quote, execute, status). A cross-chain leg is two proofs (source finality, destination finality) and an in-transit ledger account between them; failure after source finality opens a case, never silently reverses.

## 5. Liquidity and FX conversion
- **Exists:** `lp-registry`, `fx.service`, `smart-router` (spread, rate protection), B2BinPay converter, Brainrock FX.
- **Missing:** treasury-driven buying (not per-payment), best-quote selection across several liquidity providers, exposure caps.
- **Design:** liquidity sources are a list per currency (`LiquidityProvider[]`), chosen by best quote within daily and in-transit caps; purchases are treasury rebalances with their own saga and reference, never inside a customer payment; prices lock for a short window; a stablecoin depeg guard pauses quoting.

## 6. Bank-to-bank settlement
- **Exists:** `InterbankTransfer` (`AXLK-XX-NNN` network ids), daily and corridor limits, member webhooks via outbox.
- **Missing:** institution-scoped keys (today one key per bank, unscoped), settlement modes per counterparty.
- **Design:** counterparty `settlementMode`: `CRYPTO_DIRECT` (receives the asset at its whitelisted address; no off-ramp) or `FIAT_LOCAL` (paid in local currency by a fiat payout provider from a float); both reachable through one `/transfers` call; one chain transfer between institution vaults is the settlement.

## 7. Local fiat payout coordination
- **Exists:** BaaS registry with Daraja (M-Pesa), Choice Bank, Brainrock; `payout-confirmation.service`.
- **Missing:** rail routing by amount and clock, retry policy by return code, payout queue when a float is at its floor, float reconciliation against the provider balance.
- **Design:** `FiatPayoutProvider` per currency with `railPolicy`; payouts debit a float account; below floor → queued, never overdrawn; returns map to retryable/non-retryable; provider balance reconciled hourly.

## 8. Compliance and risk controls
- **Exists:** `payment-validator.service` (Kafka-gated validation), limits per bank.
- **Missing:** screening port (names, addresses) in the path before any hold; travel-rule data on crypto transfers; cases for REVIEW outcomes; per-credential rate limits.
- **Design:** `Screening` port called before the hold (HIT blocks, REVIEW opens a case and proceeds per policy); originator/beneficiary fields required on external crypto transfers; every policy decision audited.

## 9. Signed webhooks
- **Exists:** `OutboxEvent` worker, HMAC with `Bank.webhookSecret`.
- **Missing:** per-environment endpoints and secrets (hashed at rest), timestamped signature header with replay window, dead-letter and replay by operators.
- **Design:** `X-AxLink-Signature: t=<unix>,v1=<hmac-sha256(secret, t + "." + body)>`, 5-minute tolerance; backoff 1m/5m/30m/2h/12h then DEAD; operator replay; secret shown once, hash stored on `ApiEnvironment`.

## 10. Reconciliation
- **Exists:** trial balance, projection drift, custody and on-chain position checks; `ReconciliationRun`/`ReconciliationBreak`.
- **Missing:** per-institution vault = Σ sub-ledgers check with automatic payout freeze; fiat float vs provider balance; statement import matching.
- **Design:** every 5 min per vault (mismatch → case + freeze that institution's payouts until resolved); hourly per fiat float; daily statement lines matched by reference; a monthly close snapshot of every balance, hashed.

## Build order proposed for Step 2 onward
1. **Step 2 — Tenancy applied:** scope the existing customer and bank APIs to institution + environment; map live adapters onto the five ports; hashed webhook secrets; rate limits. No new money movement.
2. **Step 3 — Ledger hardening:** tenant columns, append-only trigger, advisory-lock holds, hash-chained audit.
3. **Step 4 — Wallets and deposits** (per-institution vaults, sub-ledgers, deposit crediting, whitelist registry).
4. **Step 5 — Transfers and bank-to-bank settlement** (CRYPTO_DIRECT, FIAT_LOCAL).
5. **Step 6 — Liquidity, FX and treasury** (multi-LP, caps, rebalances).
6. **Step 7 — Fiat payouts** (rail policy, queue, float reconciliation).
7. **Step 8 — Cross-chain.**
8. **Step 9 — Compliance, webhooks v2, reconciliation v2, operator console wiring in `apps/web`.**
