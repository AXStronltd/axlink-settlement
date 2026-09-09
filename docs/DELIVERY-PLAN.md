# Delivery plan — flows, integration, handover

**AxLink Settlement.** Settlement infrastructure for the APPRA banking
platform. No end users, no SWIFT, no crypto visible outside this system.

This plan is ordered by what blocks what. Each phase has an exit test that must
pass before the next begins.

---

## The fact this plan exists to fix

There are **two settlement paths**, and the customer's money is on the older one.

| | Legacy path | Settlement engine |
|---|---|---|
| Code | `core/orchestrator.service.ts`, `core/transfer.service.ts` | `core/settlement/usd-corridor.service.ts` |
| Legs, resumable after a crash | ✗ | ✓ |
| Double-entry journal | ✗ | ✓ |
| On-chain proof before completing | ✗ | ✓ |
| Idempotency by unique constraint | ✗ | ✓ |
| Compensation on failure | ✗ | ✓ |
| **Who calls it** | **every platform route** | the harness and `/api/settlement/*` |

Everything built into the engine — crash recovery, provable settlement, the
invariants the harness checks — currently runs on test traffic. The path that
moves real money has none of it.

Nothing else in this plan matters as much as closing that gap, and it cannot be
closed in one step: each flow has to move across on its own, with its own test,
because each can fail differently.

---

## Phase 1 — Ledger and internal settlement *(mostly done)*

The engine itself. Complete and proven by the harness.

| Piece | State |
|---|---|
| Double-entry journal, balances to zero per currency | ✓ |
| Settlement legs, resumable | ✓ |
| On-chain proof at `finalized` | ✓ |
| Idempotency | ✓ |
| Compensation for failure after debit | ✓ |
| Reconciliation: trial balance, drift, custody | ✓ |
| Provider registry, capability routing, health | ✓ |
| Service authentication on money-moving routes | ✓ |
| **Collection as a provider operation** | **✗ — the gap** |

**Exit test:** `SIMULATOR_ENABLED=true npm run simulate` — 10/10, six invariants
per scenario. Passing today.

### 1a. Collection *(next piece of work)*

Inbound money has no provider abstraction. `IBaaSProvider` has no collection
method; `deposit.service.ts:20` calls Brainrock directly. So adding a
collection partner still means editing core — the coupling the registry removed
for payouts, still fully present inbound.

- `collect()` on the contract, optional like `sendPayout`
- `COLLECTION` routed through the same `getBestProvider`
- A mock collection provider, and the switching test

**Exit test:** a mock collection provider is selected, and disabling it fails
over to a second, with no change in core.

---

## Phase 2 — Move the flows onto the engine

One flow at a time. Each is independently reversible, and each keeps the legacy
path callable until its replacement has run in the pilot.

### 2a. Deposit

`handleFiatArrived` → `addFunds`. Smallest blast radius: a failed deposit
leaves the customer where they started, and no money has left the system.

**Exit test:** deposit credits only after a finalized on-chain proof; the
harness's `deposit-happy` and `deposit-ordering` scenarios run against the
platform route, not just the engine.

### 2b. Withdrawal

`handleWithdrawalRequest` → `withdraw`. The one that matters most: it is the
only flow where money leaves, and the only one where a failure can leave a
customer short.

Do not start this until 2a has run in the pilot for a full reconciliation
cycle. A withdrawal bug is discovered by a customer, not by a test.

**Exit test:** `withdrawal-happy`, `onchain-failure` and `amount-drift` against
the platform route. Suspense flat at close of day.

### 2c. Transfer

`handleP2PTransfer` → engine. Least urgent: internal, both sides are ours, and
a failure is recoverable by ledger correction.

**Exit test:** trial balance zero across both customers.

### 2d. Retire the legacy path

Delete `orchestrator.service.ts` and the money-moving half of
`transfer.service.ts` once nothing calls them. Not before: a dead code path
that still compiles is a path something can be pointed back at.

---

## Phase 3 — Providers, one at a time

Only after the flows are on the engine. Integrating a provider into the legacy
path means doing the work twice.

Per provider, the whole change:

```
src/providers/live/<name>.ts        API client — auth, URLs, formats, errors
src/providers/live/<name>.baas.ts   adapter + capability declaration
src/bootstrap/baas.bootstrap.ts     one line
src/__tests__/<name>.test.ts        adapter tests
```

**Nothing in core.** If a provider needs a core change, the abstraction has
failed and that is the bug to fix — not the provider.

Order, by what unblocks the most:

| # | Provider | Unblocks | Note |
|---|---|---|---|
| 1 | B2BinPay | every corridor | client exists; needs the adapter and collection |
| 2 | Fireblocks | custody, proof | exists; needs conformance to the contract |
| 3 | One payout partner per live corridor | that corridor | Daraja, Choice Bank or Brainrock |
| 4 | Cybrid / Flutterwave / Fincra | new corridors | not started |

**Two commercial answers are needed before each partner is coded**, because
they change the corridor's behaviour, not just its configuration:

- **Will they accept stablecoin?** Yes → `cryptoLicensed: true`, `ATOMIC_USDT`,
  instant with no float. No → every mode contains a bank wire.
- **Will they hold float?** Yes → `prefundedFloat: true`, real-time for the
  recipient, at the cost of working capital and credit exposure to that partner.

**Exit test per provider:** its adapter tests pass, it appears in
`/api/settlement/providers` with the right capabilities, and a corridor runs end
to end in sandbox.

---

## Phase 4 — Handover

What a tech lead needs in order to own this.

**Documentation** — already written, to be reviewed rather than produced:
`docs/ARCHITECTURE.md` (structure), `docs/INTEGRATION.md` (per-provider
credentials, in order), `docs/DEPLOY.md`, `CLAUDE.md` (invariants), and this
plan.

**Walkthrough**, in this order — it is the fastest route to trusting the system:

1. Run the harness. Ten scenarios, six invariants, under a second.
2. Break one deliberately — set `chainExecutionError` — and watch compensation
   reverse the withdrawal and clear suspense.
3. Run `./scripts/demo.sh` end to end.
4. Read the invariants in `CLAUDE.md`. Those are the rules a change must not break.

**Operational handover:**

- `SETTLEMENT_API_KEY` issued to the platform, `OPS_API_KEY` held by ops only
- `npx prisma migrate resolve --applied 00000000000000_init` on every existing database
- `FIREBLOCKS_WEBHOOK_PUBLIC_KEY` set — empty means the signature check passes everything
- `DARAJA_INITIATOR_NAME` matches the Safaricom portal exactly
- `APP_URL` set wherever Brainrock is configured
- `SOLANA_RPC_URL` on a dedicated node, not the public endpoint
- Alerting on: `GET /api/settlement/stuck` non-empty, suspense non-zero at close,
  any `REVERSAL_FAILED` or `COMPENSATION_NEEDS_TREASURY` audit event

---

## Phase 5 — Test, then test flight

**Test** — sandbox, no real money:

- Harness green
- Each live corridor end to end in sandbox
- Every failure mode: partner down, timeout, wrong amount on chain, duplicate request
- Reconciliation clean over a simulated day

**Test flight** — real money, deliberately constrained:

| Constraint | Why |
|---|---|
| One corridor | One set of partner behaviours to learn |
| One payout partner | Isolates whose failure you are seeing |
| A capped amount, set in `capability.limits` | The cap is enforced by routing, not by hope |
| Known recipients only | A wrong payout can be recovered by asking |
| Daily reconciliation, read by a person | The point of a pilot is noticing |

**Go/no-go for wider traffic:**

- Suspense flat at every close, without intervention
- `/api/settlement/stuck` empty each morning
- Every completed settlement carries an on-chain proof
- No `COMPENSATION_NEEDS_TREASURY` events
- At least one real failure observed, and handled correctly

That last one matters most. A pilot where nothing failed has not tested the
part of the system most likely to lose money.

---

## Sequence

```
Phase 1a  collection                    ← next
Phase 2a  deposit on the engine
          ↓ one reconciliation cycle in pilot
Phase 2b  withdrawal on the engine
Phase 2c  transfer
Phase 2d  retire the legacy path
Phase 3   providers, one at a time
Phase 4   handover
Phase 5   test → test flight → wider
```

Phases 2 and 3 can overlap only where a provider is being added to a flow that
already runs on the engine. Adding a provider to the legacy path is work that
has to be done twice.

---

## What is deliberately not in this plan

**Core isolation.** Eleven files in `src/core/` import providers directly. Real,
worth fixing, and a large mechanical diff — best done between phases, when
nothing is in flight.

**The LP registry.** Conversion runs through a second registry
(`lp.interface.ts`). Merging it with the payout registry buys little before
there is a second converter, and costs a large refactor now.

**Netting.** Every payment settles gross, one on-chain hop each. Solana fees
make that survivable; netting is the structural advantage over SWIFT, and it is
a later project, not a prerequisite.
