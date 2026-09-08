## Summary

Builds the settlement layer behind the fiat-in → Solana transport → fiat-out model, scoped to a **USD-only v1** corridor. `docs/GAP_ANALYSIS.md` records the full review; this is what the branch changes.

The architecture that was already here is sound — pluggable LPs, pluggable payout partners, USDT on Solana as the internal rail. What was missing was everything that makes a settlement system defensible: provable settlement, balanced books, safe retries, and recovery from a crash mid-payment.

---

## What this fixes

### 1. Local-currency corridors were unreachable — the Africa book did not work

`IBaaSProvider.atomicJit` is a boolean. It can say "the partner takes USDT" or "the partner takes the payout currency", and nothing else. B2BinPay settles USD/EUR/GBP only, so KES via Daraja, NGN/GHS/ZAR via Choice Bank had no funding route at all and threw.

The shape that was missing is the ordinary one: **"fund me in USD, I deliver KES."**

`ProviderCapability` now declares `settlementCurrencies` and `payoutCurrencies` separately, and `resolveFundingPlan` picks the settlement currency, sizes the funding, and records who bears the FX. Four modes: `ATOMIC_USDT`, `PREFUNDED_FLOAT`, `DIRECT_FIAT`, `PARTNER_FX`. Providers that don't declare a capability get one derived from the legacy fields, so nothing breaks.

**Compliance guardrail:** the resolver **refuses** to build a USDT plan for any partner not explicitly marked `cryptoLicensed`. Payout partners are money-transmission licensed, not VASPs — sending them crypto pushes a regulated obligation onto a counterparty that cannot legally accept it. The derived capability deliberately does *not* infer the licence from `atomicJit`, so a legacy provider fails closed rather than quietly continuing to receive crypto.

### 2. Settlement was asserted, never proven

`InterbankTransfer.solanaTxHash` was in the schema and **never written** — both webhook payloads hard-coded `null`. A transfer was marked `COMPLETED` when the Fireblocks SDK returned an id, which means *submitted to the custodian*, not *finalized on Solana*.

Worse: `fireblocks.ts` catches every error and returns a synthetic `tx_sandbox_…` id with `status: 'COMPLETED'`. A production environment with a bad API key would report a steady stream of settled transfers that never touched a chain.

Settlement now: resolves the real signature from the custody transaction → polls an RPC node to `finalized` → **checks the mint and amount that actually moved match what we intended** → records an immutable `SettlementProof` with signature, slot, block time and fee paid.

Three outcomes are kept distinct, because conflating them loses money: finalized, failed-on-chain, and *we couldn't reach a node* — the last says nothing about the transaction and must never be treated as failure. Proving a settlement against a stub custody id is refused outright.

`GET /api/settlement/proof/:entityType/:entityId` is **public on purpose**. A proof only we can read is not a proof.

### 3. The ledger was single-entry

`Account.balance` was mutated directly. Fees, FX spread, provider float, treasury and on-chain custody had no accounts to land in — they existed only as the arithmetic difference between what was debited and what was delivered. No trial balance, so nothing could be reconciled and there was nothing to hand an auditor.

Adds an append-only journal (`JournalEntry` + `JournalLine`) over a chart of accounts. Every posting balances to zero **per currency**, asserted in code before write — per currency rather than in USD, so a cross-currency posting can't hide an FX position; conversions must name `FX_PNL` explicitly, which makes the converter's spread visible instead of absorbed.

`Account.balance` becomes a projection, written in the same transaction. Reconciliation proves the two agree.

### 4. A crash mid-payment left money in an unknown state

A withdrawal committed the customer debit, then made three network calls, then committed a status. A crash in between meant the customer was debited and nothing would ever revisit it — the only recovery path was a webhook that might never arrive.

The deposit path had a sequencing bug on top: it asked B2BinPay to convert fiat→USDT and then, in the same function, **immediately requested a USDT payout** — paying out USDT that did not exist yet.

Settlement is now a planned sequence of `SettlementLeg` rows, written in the same transaction as the domain record, each idempotent on a deterministic `externalKey` that is handed to the partner as its idempotency key. A resume worker drives stalled legs forward. Transitions are enforced, not documented — `COMPLETED → IN_FLIGHT` is how you pay twice.

### 5. A retried request paid twice

`bankReferenceId` was described as an idempotency key, checked read-then-write, with **no unique constraint behind it** — two concurrent requests both passed. Withdrawals minted a fresh `trackingId` on every call, so a retried HTTP request simply paid again.

Adds `IdempotencyKey` arbitrated by the database (`create` on a unique key — exactly one caller wins) plus the missing `@@unique([senderBankId, bankReferenceId])`. Same key + different body is rejected as a client bug rather than served a cached response.

### 6. Also in this branch

- **Circuit breaker + persisted attempt log** per partner. A partner that was down was re-raced on every payout, adding the full 4s quote timeout to every payment until someone edited the bootstrap file. Every quote, funding and payout is now recorded — which is also what a partner's monthly statement gets reconciled against.
- **Transactional outbox** for member-bank webhooks, which were dispatched with a floating `.then()` and lost on any crash or partner 500. On this network the webhook *is* how a receiving bank learns it has money.
- **Reconciliation**: trial balance, projection drift, custody position, on-chain position, suspense hygiene, and settlements marked complete without a proof. Custody and on-chain are separate checks on purpose — that's what tells you whether the problem is ours or the custodian's.
- **Dockerfile fix**: it copied a `public/` directory that does not exist in this repo, so the image never built. Also now runs as non-root and has a real healthcheck.
- **DigitalOcean App Platform spec** with migrations as a `PRE_DEPLOY` job.

---

## On "real-time execution"

Worth being precise, because the product claim and the rail have to match.

The **Solana leg is genuinely real-time and provable** — seconds, sub-cent, with a signature anyone can verify.

The **USD wire to the payout partner is not**. B2BinPay debits our wallet instantly, but the money reaches the partner on banking rails and banking hours. So that leg completes as `AWAITING_CONFIRMATION`, never `COMPLETED`, and only the partner's confirmation closes it and clears suspense.

Since our partners cannot receive crypto, there is a genuine trade to make between two things this repo currently claims at once:

- **Zero pre-funded corridors** (the doctrine written throughout the code), and
- **Real-time execution.**

You can have either, not both. If the partner holds no float, the beneficiary waits for our wire. The only way the *recipient* experiences real-time is `PREFUNDED_FLOAT`: the partner pays from float they already hold, and our wire replenishes them off the critical path. That costs working capital per corridor, bounded by the float size.

Both modes are implemented on the same interface and selected per partner via `capability.prefundedFloat` — no code change to switch. `FundingPlan.payoutPrecedesFunding` carries which is in force, and replenishment failures are logged loudly without failing the customer's payout.

---

## Verification

All of the following now runs on macOS and was verified before this PR was opened:

- **166 unit tests pass** (11 files).
- **`tsc --noEmit` clean** across the whole repo, not just the new modules.
- **All 10 settlement-harness scenarios pass** — `SIMULATOR_ENABLED=true npm run simulate`. They were failing 10/10 when this branch was first written; see the addendum below for why.
- **The service boots**, and a full corridor runs end to end against it: `./scripts/demo.sh`.

```bash
npx prisma generate && npx tsc --noEmit && npx vitest run
SIMULATOR_ENABLED=true npm run simulate     # needs a scratch DATABASE_URL
```

The earlier note that Prisma binaries were unreachable applied to the sandbox this branch was authored in; it is not a problem on macOS.

## Required before deploying

```bash
./scripts/create-baseline-migration.sh
git add prisma/migrations && git commit -m "Add migration baseline"
```

There is no `prisma/migrations/` directory, which means `prisma migrate deploy` — what the DO pre-deploy job runs — **silently does nothing** and the deploy succeeds against an unmigrated database. CI now fails loudly if the baseline is missing rather than letting that through.

## Note on scope

This branch includes pre-existing uncommitted work in the tree (`b2binpay.ts`, `package.json`, `.gitignore`, `frontend/package.json`, `CLAUDE.md`). The registry changes depend on `B2B_SETTLEMENT_CURRENCIES` from the b2binpay change, so they had to go together.

## Follow-ups deliberately not in this PR

- **Netting.** Every transfer settles gross — one on-chain hop per payment. Solana fees make that survivable, but netting a window of bilateral flows to one leg per counterparty pair is the real structural advantage over SWIFT. Schema models were drafted and then removed rather than shipping unused tables.
- Migrating the legacy `debit`/`credit` helpers in `ledger.service.ts` onto the journal. Reconciliation's projection-drift check is the tripwire that catches one still being used.
- `handlePayoutRailConfirmed` matches withdrawals with `trackingId: { contains: … }` — a substring match on a money record.
- `Decimal(20,8)` columns are still read into JavaScript `number` across the older services.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01LpyPitkGnjFiJzhSKV1WjP

---

## Addendum — work added after the original description

The description above covers the settlement engine as first written. Roughly half the commits on this branch came later, from running the thing rather than reading it.

### Four money bugs, all found by the harness

Each of these moved money incorrectly, and none was visible until the scenarios could actually reach the code.

**Deposits credited the customer repeatedly.** `LEDGER_CREDIT` was the only leg not wrapped in `executeLeg`, so it never entered `IN_FLIGHT`, and `confirmLeg`'s `PENDING → COMPLETED` was an illegal transition that threw *after* the credit had committed. The leg stayed `PENDING` and every later attempt credited again. The harness showed a $10,000 deposit crediting $60,000. The resume worker runs every 15s, so in production a settled deposit would have paid out indefinitely.

**A recorded failure was read back as proof.** `recordFailure` writes a `SettlementProof` row so an on-chain error is preserved, and `proveSettlement` short-circuited on "a row exists" → `ALREADY_PROVEN`. The first attempt recorded the failure; the second found the record and called it proof. A transaction that landed on chain and *failed* completed its leg, and the corridor carried on to sell USDT and wire fiat that was never backed.

**A failed withdrawal kept the customer's money.** In the legacy orchestrator, the catch block marked the withdrawal `FAILED` and rethrew without reversing the debit. Reversal existed only on the partner webhooks, so any failure raised before a partner was contacted stranded the money. Reproduced four times against the demo: 12,000 KES debited and never returned.

**Permanent errors were retried.** A proof mismatch — wrong amount, wrong asset — returns the same answer however often it is asked, while the customer's money sits in suspense. `ProofMismatchError` now declares `retryable: false`.

### Compensation

`compensateWithdrawal` reverses the debit exactly, restores the balance projection, marks the withdrawal `REVERSED` and closes the open legs. `advanceWithdrawal` calls it when a leg has spent its retry budget. The `COMPENSATE` leg kind existed and nothing emitted it.

It refuses one case rather than faking it: once `CONVERT_CRYPTO_TO_FIAT` has completed the USDT has been sold, and putting the customer back means buying it again at today's rate — a treasury decision with a real cost, not a journal entry. That records `COMPENSATION_NEEDS_TREASURY`.

### The harness itself

It was failing 10/10, and the cause was not in the scenarios. A leg that ends at `AWAITING_CONFIRMATION` waits on a partner callback, and nothing played that part, so every settlement stalled at its first such leg. `settleExternals` delivers those callbacks, deliberately excluding `ONCHAIN_SETTLE` (which resolves by polling, and confirming it would skip the finality check the engine exists to enforce) and `PARTNER_PAYOUT` (whether a bank wire self-completes is what `withdrawal-happy` asserts).

### Nothing ran locally before this

`index.ts` called `dotenv.config()` in the function body, but ES imports are hoisted and evaluated first — so every module reading `process.env` at module scope captured `undefined`. `TREASURY_VAULT` was permanently `''` and Fireblocks rejected every transfer; `transfer.service.ts` built `CALLBACK_URL` as the literal string `"undefined/webhooks/b2binpay"`, which is what B2BinPay would have been told to call back. The startup credential check runs *after* `dotenv.config()` and so reported the values as present.

Also: the payout partners had no sandbox stub (B2BinPay and Fireblocks do), so no corridor could be exercised without real Safaricom credentials; and `DARAJA_B2C_FLOAT_ACCOUNT`, `CHOICEBANK_FLOAT_ACCOUNT` and `OPS_API_KEY` were required by code and missing from `.env.example`, so a correct setup by the documented steps still failed.

### Branding, docs and a demo

- **FinCruse → AxLink** in display text (129 replacements). The 57 lowercase `fincruise` identifiers are deliberately unchanged — they name the database, the Kafka topics, the Fireblocks vault label prefix and the package, each of which exists outside this repo and would break rather than rename. `/api/health` still reports `fincruise-settlement` because it echoes the package name.
- **`docs/ARCHITECTURE.md`** — where the code lives, opening with a task-to-file index.
- **README corrected against the code.** It documented `src/services/*` (moved three months ago), a `/monitor` visualiser, a `/demo` route and `/api/fireblocks/*` endpoints, none of which exist, and routed local currency through B2BinPay, which settles USD/EUR/GBP only.
- **`./scripts/demo.sh`** and a **Live Demo** tab that drive a real corridor against the running service, unlike `/api/simulate` which is narration over a hard-coded rate table.

### Still open

- `payload.signature` is read at `usd-corridor.service.ts:213` and written nowhere — the custody webhook that would carry it does not exist. The harness attaches it so the proof leg has something to verify; in production that path cannot complete.
- `brainrock.routes.ts` sets `status: COMPLETED` on `payment.sent` while bypassing the settlement legs. The webhooks now route through `confirmWithdrawalFromPartner`, but the two paths still disagree about what closes a withdrawal.
- The failure path on the legacy partner webhooks still bypasses the journal the same way the success path did.
