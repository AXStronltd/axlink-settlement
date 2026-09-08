# Architecture

**Axstron Group — APPRA Settlement Service**

How the code is laid out and where to find things.

| Doc | Answers |
|---|---|
| `README.md` | What the product does — layers, user journeys, revenue model |
| `docs/ARCHITECTURE.md` | Where the code lives and why — **this file** |
| `docs/DEPLOY.md` | How to ship it |
| `docs/GAP_ANALYSIS.md` | What is still missing |
| `CLAUDE.md` | How to run it locally |

---

## 1. Where do I look?

| I want to… | Open |
|---|---|
| See how we call M-Pesa / a bank | `src/providers/live/<partner>.ts` |
| See when a partner gets chosen | `src/providers/live/<partner>.baas.ts` |
| Change which partners are switched on | `src/bootstrap/baas.bootstrap.ts` |
| Understand USDT-vs-USD funding | `src/core/provider/capability.ts` |
| Follow the money on a withdrawal | `src/core/settlement/usd-corridor.service.ts` |
| See the double-entry rules | `src/core/settlement/journal.service.ts` |
| Find out why a settlement stalled | `src/core/settlement/leg.service.ts` |
| Check FX rates and spread | `src/core/fx.service.ts`, `smart-router.service.ts` |
| Add an HTTP endpoint | `src/routes/`, mounted in `src/index.ts` |
| Change the data model | `prisma/schema.prisma` (23 models) |

---

## 2. Invariants

**No SWIFT. Ever.** There is no correspondent bank, no nostro/vostro account
and no SWIFT message anywhere in this system. Cross-border value moves as USDT
on Solana — seconds, ~$0.00025, with a signature anyone can verify. That is the
entire argument for this network.

**Crypto is internal.** Payout partners see only "send X currency to Y
destination". A partner receives crypto *only* if explicitly marked
`cryptoLicensed: true`. `orchestrator.service.ts` states it;
`provider/capability.ts` enforces it — `resolveFundingPlan` refuses to build a
USDT funding plan for an unlicensed partner. A compliance guardrail, not a
config option.

**USD is the unit of account, and USD:USDT is 1:1 by construction.** Every
amount is converted to a USD value first, and the crypto hop carries that value
unchanged. In `fx.service.ts`: `USDT: 1.000` in the rate table, `getRate`
returns exactly `1` for any USD/USDT pair, and `usdToUsdt` returns its argument.

This matters because it means **the internal transport is value-preserving**.
Moving money through Fireblocks and Solana costs gas, never basis points.

FX happens only where fiat meets a rail, never in the crypto hop. A USD-in /
local-out corridor converts once, at payout. A GBP→KES transfer converts twice
— GBP→USD at collection, USD→KES at payout — because USD is the unit of
account and everything routes through it. Either way the USDT leg is free of
FX, so no rounding difference can accumulate in transport.

---

## 3. The layers

```
  USER  (sees local fiat only — never crypto)
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  1  COLLECTION / PAYOUT        Daraja · Choice Bank · Brainrock │
│     fiat in and out at the edges                                │
├─────────────────────────────────────────────────────────────────┤
│  2  LIQUIDITY                  B2BinPay · Fireblocks vault      │
│     fiat ↔ USDT.  B2BinPay settles USD/EUR/GBP only             │
├─────────────────────────────────────────────────────────────────┤
│  3  CUSTODY + PROOF            Fireblocks vaults · Solana       │
│     USDT transport, verified at `finalized`                     │
├─────────────────────────────────────────────────────────────────┤
│  4  SETTLEMENT ENGINE          legs · journal · proof · recon   │
│     resumable state machine + double-entry truth                │
├─────────────────────────────────────────────────────────────────┤
│  5  LEDGER                     Prisma + PostgreSQL              │
│     customer balances, atomic debit/credit                      │
└─────────────────────────────────────────────────────────────────┘
```

Layer 4 is new and is what the README predates. Everything above it used to
write straight to the ledger; now money moves as *legs* that survive a crash,
and every movement posts a balanced journal entry.

### B2BinPay is the USD leg in both directions

```
DEPOSIT      partner collects local fiat
             → B2BinPay:  USD  → USDT        (1:1, no value lost)
             → Solana:    USDT → user vault, verified at finalized
             → ledger:    credit the customer

WITHDRAWAL   ledger:      debit the customer
             → Solana:    USDT user vault → treasury, verified at finalized
             → B2BinPay:  USDT → USD         (1:1, no value lost)
             → wire USD to the payout partner, who applies local FX
```

Symmetric on purpose. B2BinPay only ever handles the **USD ↔ USDT** hop — it
never touches local currency in either direction, because it settles USD, EUR
and GBP only (`B2B_SETTLEMENT_CURRENCIES` in `b2binpay.ts`). Local currency is
the payout partner's job at the edge.

---

## 4. Repo map

```
src/
├── index.ts              Express app: env checks, route mounts, worker start
├── middleware/           Bank bearer-token auth (`requireBankAuth`)
├── bootstrap/            Registers LPs and payout partners at startup
├── core/                 Business logic
│   ├── provider/         Choosing and talking to a payout partner
│   └── settlement/       Moving money, and proving it moved
├── providers/
│   ├── live/             Integrations in use
│   └── coming-soon/      Written, not registered — awaiting credentials
├── routes/               HTTP surface
└── __tests__/            Vitest — 160 tests
prisma/schema.prisma      23 models
frontend/                 React + Vite operator UI
```

### core/ — flat services

These predate the settlement engine and carry the original flows.

| File | Owns |
|---|---|
| `ledger.service.ts` | Prisma client; `debit` / `credit` / `getBalance` |
| `fx.service.ts` | The rate table. **USD is the internal unit.** Also exports `axlinkInternalLP`, the always-available fallback quoter |
| `quote.service.ts` | JIT quotes, 30s binding window |
| `smart-router.service.ts` | Classifies each quote into a route type, setting spread and rate-floor protection |
| `orchestrator.service.ts` | Deposit / withdrawal / transfer entry points |
| `transfer.service.ts` | Same-currency (pure ledger) vs cross-currency (FX + rails) |
| `deposit.service.ts` | User-initiated Add Funds (Apple Pay, Google Pay, bank) |
| `treasury.service.ts` | Corridor float rebalancing |
| `interbank.service.ts` | Member-bank transfers and daily limits |
| `lp-registry.service.ts` · `lp.interface.ts` | JIT RFQ broadcast; best rate wins |
| `baas-registry.service.ts` · `baas.interface.ts` | Payout partner selection and fiat delivery |
| `kafka.service.ts` | Event bus — real Kafka if `KAFKA_BROKERS`, else in-process |
| `payment-validator.service.ts` | Gates every payment **before any ledger write** |
| `idempotency.service.ts` | Atomic insert-then-check, replacing a read-then-write that let duplicate references both settle |
| `outbox.service.ts` | Transactional outbox, so a restart cannot lose a webhook |
| `bank-webhook.service.ts` | HMAC-signed delivery to member banks, with backoff |

---

## 5. The provider layer

**Every partner is two files.** That is the whole convention.

| Partner | API client | Adapter |
|---|---|---|
| Daraja / M-Pesa | `daraja.ts` (309) | `daraja.baas.ts` (78) |
| Choice Bank | `choicebank.ts` (221) | `choicebank.baas.ts` (73) |
| Brainrock | `brainrock.ts` (335) | `brainrock.baas.ts` (70) |
| Fireblocks | `fireblocks.ts` (219) | `fireblocks.lp.ts` (108) |
| B2BinPay | `b2binpay.ts` (436) | *same file* — `b2binpayLP` |
| Solana | `solana.ts` (350) | *none* — read directly |

The **client** speaks the partner's vocabulary: auth, endpoints, signature
verification. No business logic.

The **adapter** is ~70 lines and does one job: translate that partner into our
vocabulary via `canHandle`, `getQuote`, `sendPayout`, plus a `capability` block
declaring what we can fund it in and what it can pay out.

Two deviations worth knowing before you go looking:

- **`b2binpay.ts` holds both** client and adapter in one file. Everything else splits them.
- **`solana.ts` has no adapter** — it is not a partner. It is a read-only chain client called by `settlement/proof.service.ts`.

There are **two** interfaces: `ILiquidityProvider` for anyone quoting a rate
(Fireblocks vault, B2BinPay, AxLink internal) and `IBaaSProvider` for anyone
delivering fiat (Daraja, Choice Bank, Brainrock).

**Registered:** Daraja (KES/TZS/UGX), Choice Bank (Africa + CNY), Brainrock (EU/UK/US/CA).
**Written, dormant:** Thunes, MTN MoMo, Orange — one uncommented line each.
Thunes is the only one declaring `atomicJit = true`, so it is the template for
a crypto-licensed partner.

### Funding modes

A partner declares what we can **fund** it in and what it can **pay out**,
separately. `resolveFundingPlan` then picks:

| Mode | We send | Who converts | Instant? |
|---|---|---|---|
| `ATOMIC_USDT` | USDT | partner | **Yes** — requires `cryptoLicensed: true` |
| `PREFUNDED_FLOAT` | fiat, afterwards | partner | **Yes** — partner pays from float we hold; our wire replenishes |
| `DIRECT_FIAT` | the payout currency | nobody | No — gated on a bank wire |
| `PARTNER_FX` | USD/EUR/GBP | partner | No — gated on a bank wire |

The trade is structural. Every mode except `ATOMIC_USDT` contains a bank wire,
and a wire is either *before* the payout (not instant) or *after* it (needs
float). `payoutPrecedesFunding` records which.

Supporting files: `circuit-breaker.ts` skips failing partners so a dead one
does not add 4s to every payout; `retry.ts` is deliberately narrow, since
retrying a payment is how you pay twice; `attempt.service.ts` logs every
question asked of a partner and every answer received.

---

## 6. The settlement engine

| File | Owns |
|---|---|
| `accounts.ts` | Chart of accounts — structured string codes, readable without a join |
| `journal.service.ts` | Double-entry. Every posting balances to zero per currency, asserted before write |
| `leg.service.ts` | Crash recovery — settlements as resumable state machines |
| `proof.service.ts` | Turns a custodian's promise into evidence: the Solana signature at `finalized` |
| `reconciliation.service.ts` | Checks the system's beliefs against outside witnesses |
| `resume.worker.ts` | Drives stalled settlements forward |
| `usd-corridor.service.ts` | The USD corridor — first flow on this engine |

### Chart of accounts

| Prefix | Type | Meaning |
|---|---|---|
| `USER:` | liability | we owe the customer |
| `BANK:` | liability | we owe a member bank |
| `TREASURY:` | asset | our own funds |
| `CUSTODY:` | asset | in a named Fireblocks vault |
| `ONCHAIN:` | asset | provably on Solana, keyed by SPL mint |
| `FLOAT:` | asset | our money sitting at a payout partner |
| `CONVERTER:` | asset | in transit at B2BinPay |
| `FEE_INCOME:` · `FX_PNL:` | income | revenue, realised FX |
| `SUSPENSE:` | liability | identified but not yet attributable |

`SUSPENSE` and `CONVERTER` are transient. A suspense balance surviving an
end-of-day close is an operational incident, not an accounting detail.

### Legs

Kinds: `LEDGER_DEBIT`, `LEDGER_CREDIT`, `CONVERT_FIAT_TO_CRYPTO`,
`CONVERT_CRYPTO_TO_FIAT`, `CUSTODY_TRANSFER`, `ONCHAIN_SETTLE`,
`PARTNER_PAYOUT`, `COMPENSATE`.

Statuses: `PENDING` → `IN_FLIGHT` → `AWAITING_CONFIRMATION` → `COMPLETED`,
plus `FAILED`, `COMPENSATED`, `ABANDONED`. Terminal: the last three.

A USD withdrawal:

```
0  customer balance debited                 LEDGER_DEBIT
1  USDT user vault → treasury               CUSTODY_TRANSFER
2  Solana signature verified at finalized   ONCHAIN_SETTLE
3  B2BinPay converts USDT → USD             CONVERT_CRYPTO_TO_FIAT
4  USD wired to the payout partner          PARTNER_PAYOUT
```

Leg 2 exists so no customer balance moves on a custodian's acknowledgement
alone. Leg 4 completes as `AWAITING_CONFIRMATION`, not `COMPLETED` — a bank
wire settles on banking rails, and only the partner's confirmation closes it.

---

## 7. HTTP surface

| Mount | Purpose | Auth |
|---|---|---|
| `/api/quote`, `/api/simulate` | Quotes; narrated demo flows | — |
| `/api` (users, transfers, cards) | Core customer API | — |
| `/api/deposits`, `/api/orchestrator` | Add Funds; transfers and withdrawals | — |
| `/api/network` | Member-bank API, incl. `/rates` | bearer |
| `/api/ops`, `/api/settlement` | Treasury and settlement operations | `OPS_API_KEY` |
| `/api/webhooks` | B2BinPay, Fireblocks, Brainrock, Daraja, Choice Bank | per-partner signature |

Bank auth is middleware; the `OPS_API_KEY` guard is a local function duplicated
in `treasury.routes.ts` and `settlement.routes.ts`. Both **fail closed** when
the key is unset — though they disagree on the code, 500 vs 503.

`/api/settlement/proof/:entityType/:entityId` is deliberately public: a proof
only we can read is not a proof.

---

## 8. Adding things

- **An LP** — implement `ILiquidityProvider`, add one `registerLP()` line. It joins the RFQ automatically.
- **A payout partner** — write the API client and an `IBaaSProvider` adapter declaring its `capability`, add one `registerBaaSProvider()` line.
- **A corridor** — model on `usd-corridor.service.ts`. The leg machine and journal are corridor-agnostic.

---

## 9. Boundaries

- **Sandbox is the default.** With no credentials, every provider is stubbed and startup says so. Quotes, routing and the ledger still run.
- **`simulate.routes.ts` is self-contained narration.** Its own rate table; touches no service and no database. Good for showing the architecture, useless as a test of it.
- **`confirmPartnerPayout` has one caller** — the manual ops route. Until a partner webhook drives it, every withdrawal parks in suspense awaiting an operator. Note `brainrock.routes.ts` separately sets `status: COMPLETED` on `payment.sent`, bypassing the legs entirely; the two paths need reconciling.
- **`prisma/migrations/` does not exist.** Use `prisma db push`.

---

## Relationship to the README

The README is the front door: what the product does, the user journeys, the
revenue model. This file is the structural reference underneath it.

Both were reconciled against the code. The README previously described the
pre-`core/` layout — `src/services/*.service.ts`, a `/monitor` visualiser, a
`/demo` route and `/api/fireblocks/*` endpoints, none of which exist — and
routed local currency through B2BinPay, which settles USD/EUR/GBP only. Those
are corrected. If you find a third disagreement, the code wins and both docs
are wrong.
