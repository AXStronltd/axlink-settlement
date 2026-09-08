# AxLink Settlement — gap analysis

Reviewed at `aa21369` (+ uncommitted work in progress). ~9.1k LOC across
`src/core`, `src/providers`, `src/routes`, plus a React/Vite frontend.

The architecture is sound and the direction is right: fiat in → USDT on Solana as
the internal transport → fiat out, with pluggable LPs (`ILiquidityProvider`) and
pluggable payout partners (`IBaaSProvider`). What follows is what stands between
this and something a regulator, a partner bank, or a treasury team would accept.

Severity: **P0** blocks going live · **P1** blocks scale/audit · **P2** hygiene.

---

## 1. The ledger is single-entry — P0

`Account.balance` is mutated directly by `debit()` / `credit()` in
`ledger.service.ts`. `AuditLog` stores free-form JSON, not a journal.

Consequences:

- There is no way to prove `Σ debits = Σ credits`. No trial balance, no
  balance sheet, no way to answer "where did this money come from".
- Money that leaves a user account has no recorded counterparty account. Fees,
  FX spread, provider float, treasury, and on-chain custody are all invisible —
  they exist only as the *difference* between what was debited and what was paid.
- A partial failure leaves the ledger silently wrong with nothing to detect it.

**Fix:** an append-only journal (`JournalEntry` + `JournalLine`) where every
posting is balanced and written in the *same* database transaction as the balance
mutation, over a chart of accounts that includes system accounts
(treasury, provider float, fee income, FX P&L, on-chain custody, suspense).
Balances become a projection of the journal, and can be re-derived from it.

## 2. Money movement is not atomic and not recoverable — P0

`handleWithdrawalRequest` does: debit ledger (tx 1) → Fireblocks transfer
(network) → B2BinPay JIT conversion (network) → partner payout (network) →
update status (tx 2). Same shape in `handleP2PTransfer` and
`initiateInterbankTransfer`.

If the process dies between any two of those steps, the money is in an unknown
state and nothing in the system will ever revisit it. The only recovery path
that exists is `handlePayoutRailConfirmed`, which requires a webhook that may
never arrive.

**Fix:** a persisted state machine per settlement (`SettlementLeg` rows with
explicit statuses and attempt counters), driven forward by a worker that can
resume any leg after a crash, plus compensating entries rather than silent
`status: 'FAILED'`.

## 3. No idempotency on the money-moving entry points — P0

`InterbankTransfer` has `bankReferenceId` described as an idempotency key and
`checkIdempotency()` reads it — but there is **no unique constraint**, so two
concurrent requests with the same reference both pass the check and both settle.

The user-facing paths are worse: `handleWithdrawalRequest` mints a fresh
`trackingId` on every call. A retried HTTP request pays out twice.

**Fix:** `@@unique([senderBankId, bankReferenceId])` on `InterbankTransfer`, and
a general `IdempotencyKey` table with a request-hash guard and a stored response,
wrapped around every orchestrator entry point.

## 4. The Solana leg is asserted, never proven — P0

`InterbankTransfer.solanaTxHash` exists and is **never written** — both webhook
payloads hard-code `solanaTxHash: null`. Settlement is considered complete when
the Fireblocks SDK returns a transaction id, which means *submitted to
Fireblocks*, not *finalized on Solana*. Worse, `fireblocks.ts` swallows every
error and returns a fake `tx_sandbox_…` id, so in an unconfigured or
partially-failing environment the system reports settled transfers that never
touched a chain.

For a settlement network whose entire pitch is "not SWIFT, verifiable on-chain",
the on-chain proof is the product. It is currently missing.

**Fix:** resolve the real Solana signature from the Fireblocks transaction, poll
`getSignatureStatuses` to `finalized` commitment, and record signature + slot +
block time as an immutable `SettlementProof` before a transfer may be marked
`COMPLETED`. Also: stop returning stub transaction ids outside explicit sandbox
mode — fail loudly instead.

## 5. `atomicJit: boolean` cannot express real corridors — P0

Already identified in the working tree (`baas-registry.service.ts`): B2BinPay
settles USD/EUR/GBP only, so JIT-funding a KES payout via Daraja, an NGN payout
via Choice Bank, or GHS/ZAR is impossible. The code now throws rather than
stranding USDT — correct, but it means **the Africa corridors do not work at
all**, which is the core of the business.

The root cause is modelling capability as one boolean. What a partner actually
has is two separate lists: what it can be **funded in** (settlement currency)
and what it can **deliver** (payout currency), which may legitimately differ —
"fund me in USD, I deliver KES at my own FX" is the normal shape of an African
payout partner.

**Fix:** replace the boolean with a capability descriptor
(`settlementCurrencies`, `payoutCurrencies`, `methods`, `countries`, limits) and
a funding-plan resolver that picks the settlement currency and records who bears
the FX. Existing providers keep working through a compatibility shim derived
from `atomicJit` + `supportedCurrencies`.

## 6. No provider health, no retry, no attempt record — P1

`getBestProvider` races every registered provider on every payout with a 4s
timeout. A partner that is down is re-raced on each transaction, adding 4s of
latency to every payment. There is no backoff, no circuit breaker, and no
persisted record of what any provider was asked or answered — so there is
nothing to reconcile a partner's statement against, and nothing to build
routing decisions on.

**Fix:** per-provider circuit breaker (closed → open → half-open) fed by a
persisted `ProviderAttempt` log, and bounded retry with jitter on idempotent
operations.

## 7. Webhooks are fire-and-forget — P1

`initiateInterbankTransfer` dispatches member-bank webhooks with a floating
`.then()`; `webhookAttempts` is in the schema and never incremented. A crash or
a partner's 500 loses the notification permanently. For a network where the
webhook *is* how the receiving bank learns it has money, this is a correctness
bug, not an ops annoyance.

**Fix:** transactional outbox — the event row is written in the same transaction
as the state change, a worker delivers with backoff and records attempts.

## 8. Gross settlement only — P1

Every single transfer produces its own on-chain hop. Solana fees are near zero,
so this is survivable, but it forfeits the main structural advantage of running
your own network: a thousand transfers between two member banks in a window
should net to **one** settlement leg. It also means per-transfer confirmation
latency is on the critical path of every payment.

**Fix:** settlement batches with bilateral netting over a configurable window;
gross (immediate) settlement remains available per transfer and stays the
default for user-facing withdrawals.

## 9. Nothing reconciles — P1

No process compares ledger balances against Fireblocks vault balances, against
on-chain token balances, or against provider statements. The `getBankStatement`
endpoint reports what the database believes, with nothing checking that belief.

**Fix:** a reconciliation run that produces a trial balance and compares
ledger USDT against custody and on-chain positions, recording breaks.

## 10. Deployment cannot be reproduced — P1

There is no `prisma/migrations/` directory. `CLAUDE.md` documents the workaround:
use `prisma db push`. That is fine on a laptop and unacceptable for a regulated
production database — no version history, no review of schema changes, no
rollback, and `prisma migrate deploy` in a deploy pipeline silently does nothing.

**Fix:** a real baseline migration plus per-change migrations, and a pre-deploy
migration job in the DigitalOcean App Platform spec.

## 11. Smaller items — P2

- `handlePayoutRailConfirmed` finds the withdrawal with
  `trackingId: { contains: trackingId }` — a substring match on a money record.
  Should be an exact lookup.
- On payout failure the user is credited back the gross amount; the Fireblocks
  leg is not reversed and the JIT conversion cost is absorbed silently with no
  journal entry.
- Statuses are free strings; `PENDING_FIREBLOCKS` and `PENDING_PAYOUT` are used
  in code but appear in no schema comment or enum. No transition validation.
- `Decimal(20,8)` in the database is read into JavaScript `number` everywhere
  (`Number(account.balance)`), which reintroduces float error on values the
  schema went to the trouble of storing exactly.
- `redis` is a dependency and is imported nowhere.
- `getSupportedCorridors()` infers methods by probing `canHandle` with fake
  destinations (`accountNumber: '123'`) — it will drift from reality the moment
  a provider validates its inputs.

---

## What this branch changes

Ordered by what unblocks the most:

| # | Gap | Change |
|---|-----|--------|
| 5 | Corridors dead | Capability descriptor + funding-plan resolver |
| 1 | Single-entry | Double-entry journal + chart of accounts |
| 3 | Double-spend on retry | `IdempotencyKey` + unique constraint |
| 4 | Unproven settlement | Solana finality confirmation + `SettlementProof` |
| 2 | Unrecoverable | `SettlementLeg` state machine + resume worker |
| 6 | Blind routing | Circuit breaker + `ProviderAttempt` |
| 7 | Lost webhooks | Transactional outbox |
| 8 | Gross-only | Netting batches |
| 9 | No reconciliation | Trial balance + custody/on-chain comparison |
| 10 | Irreproducible deploy | Baseline migration + DO App Platform spec |

Items 11 are noted but out of scope for this branch.
