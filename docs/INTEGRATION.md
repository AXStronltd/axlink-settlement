# Integration runbook

**Axstron Group — AxLink Settlement**

What to obtain from each provider, in what order, and how to prove each one
works before moving to the next.

Everything runs without credentials: unconfigured providers return shaped
stubs, so the service boots, quotes, and settles locally. That is deliberate —
you can exercise the whole corridor before signing anything. It also means an
unconfigured provider fails quietly in the direction of *looking fine*, so the
verification step after each provider is the part that matters.

---

## Order of work

Later steps depend on earlier ones, so do them in this order.

| # | Step | Blocks |
|---|---|---|
| 1 | Database + baseline migration | everything |
| 2 | Fireblocks | custody, on-chain proof, all settlement |
| 3 | B2BinPay | every fiat↔USDT conversion, both directions |
| 4 | One payout partner | payouts in that partner's currencies |
| 5 | Webhook URLs registered with each | nothing completes without these |
| 6 | Ops key + workers | reconciliation, resume, treasury |

A corridor needs **Fireblocks + B2BinPay + one payout partner**. Adding
partners after that is additive: one adapter and one line in
`bootstrap/baas.bootstrap.ts`.

---

## 1. Database

```bash
createdb axlink_settlement
DATABASE_URL=postgresql://user:pass@host:5432/axlink_settlement npx prisma migrate deploy
```

**If the database already exists and was created with `prisma db push`**, it
already has the tables and `migrate deploy` would try to create them again.
Mark the baseline applied instead, once per environment:

```bash
npx prisma migrate resolve --applied 00000000000000_init
```

`DIRECT_DATABASE_URL` is needed only if `DATABASE_URL` points at a connection
pooler — migrations cannot run through PgBouncer.

**Verify:** `npx prisma migrate status` reports no pending migrations.

---

## 2. Fireblocks — custody and on-chain proof

Generate the key pair locally. The private key never leaves your machine and is
never committed.

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out fireblocks_secret.key
openssl req -new -key fireblocks_secret.key -out fireblocks.csr \
  -subj "/C=KE/O=AxLink/CN=axlink-settlement"
```

In the Fireblocks console:

1. **Settings → Users & API Keys → Add API User**, role `Editor`, paste the CSR.
2. Copy the API key it shows.
3. **Vaults → Add Vault Account**, name it `AxLink Treasury`, add the `USDT_SOL`
   asset, copy the vault id and the deposit address.
4. **Webhooks →** set the URL to `https://<your-domain>/api/webhooks/fireblocks`
   and copy the public key (full PEM).

```env
FIREBLOCKS_API_KEY=
FIREBLOCKS_SECRET_KEY_PATH=./fireblocks_secret.key
FIREBLOCKS_TREASURY_VAULT=
FIREBLOCKS_SETTLEMENT_ADDRESS=
FIREBLOCKS_WEBHOOK_PUBLIC_KEY=
FIREBLOCKS_USDT_ASSET=USDT_SOL
FIREBLOCKS_SANDBOX=true
```

> **The CSR subject and the vault name live in the Fireblocks console.** If the
> API user was registered under an older organisation name, these must match
> what exists there — renaming in this repo does not reach across.

**`FIREBLOCKS_WEBHOOK_PUBLIC_KEY` is a security control, not a formality.**
When it is empty the signature check *passes everything*
(`fireblocks.ts` — `if (!pubKey) return true`). Convenient locally; in
production it means anyone who can reach the endpoint can credit any account.
Set it before the service is publicly reachable.

**Verify:** `curl localhost:4000/api/health` no longer lists
`FIREBLOCKS_API_KEY` among unset credentials at startup.

---

## 3. B2BinPay — the fiat ↔ USDT leg

Sandbox: <https://sandbox.b2binpay.com>. **Profile → Access list → API →
Regenerate.** Three values appear **once**:

```env
B2BINPAY_CLIENT_ID=          # max 18 characters
B2BINPAY_CLIENT_SECRET=
B2BINPAY_CALLBACK_SECRET=
B2BINPAY_WALLET_ID=          # Wallets tab
B2BINPAY_SANDBOX=true
```

Register the callback: `https://<your-domain>/api/webhooks/b2binpay`

**B2BinPay settles USD, EUR and GBP only** — never local currency. It converts
between fiat and USDT in both directions and nothing else. Local currency is
the payout partner's job. This is enforced in code
(`B2B_SETTLEMENT_CURRENCIES`), so a corridor that tries to route KES through it
is refused rather than silently mispriced.

**One commercial question to settle first:** confirm they will make **fiat bank
payouts to a third party** — the withdrawal path depends on wiring USD to your
payout partner's bank account. The code passes a bank identifier into a field
their API names `address`.

**Verify:** `POST /api/quote` with `{"fromCurrency":"GBP","toCurrency":"USD","fromAmount":100}`
returns `rfq.winningLP: "b2binpay"`. If it says `axlink`, B2BinPay is not
answering and the internal rate table is winning by default.

---

## 4. Payout partners

Each delivers local currency at the edge. You need at least one; add others as
corridors open.

### Brainrock — GBP, EUR, USD, CAD and other developed markets

```env
BRAINROCK_API_KEY=
BRAINROCK_WEBHOOK_SECRET=
BRAINROCK_TREASURY_ACCOUNT_ID=
BRAINROCK_SANDBOX=true
BRAINROCK_CARD_PROGRAM_ID=      # only if issuing cards
```

Webhook: `https://<your-domain>/api/webhooks/brainrock`

### Daraja / M-Pesa — KES, TZS, UGX mobile money

<https://developer.safaricom.co.ke> → create an app → enable **B2C**.

```env
DARAJA_CONSUMER_KEY=
DARAJA_CONSUMER_SECRET=
DARAJA_SHORTCODE=
DARAJA_INITIATOR_NAME=
DARAJA_SECURITY_CREDENTIAL=     # initiator password encrypted with Safaricom's cert
DARAJA_PASSKEY=                 # STK Push only
DARAJA_SANDBOX=true
```

Webhooks: `/api/webhooks/daraja/b2c/result`, `/b2c/timeout`, `/stk`

### Choice Bank — NGN, GHS, ZAR, RWF, XOF, XAF, CNY

```env
CHOICE_BANK_API_KEY=
CHOICE_BANK_WEBHOOK_SECRET=
CHOICE_BANK_SANDBOX=true
```

Webhook: `https://<your-domain>/api/webhooks/choicebank`

### Float accounts — set **both** names

Each partner needs an account we wire settlement funds to. Payouts and the
treasury rebalancer currently read it under different names, so setting one
leaves the other pointing at an empty string:

| Partner | Payouts read | Rebalancer reads |
|---|---|---|
| Daraja | `DARAJA_B2C_FLOAT_ACCOUNT` | `DARAJA_FLOAT_ACCOUNT` |
| Choice Bank | `CHOICEBANK_FLOAT_ACCOUNT` | `CHOICEBANK_TREASURY_ACCOUNT` |
| Brainrock | `BRAINROCK_TREASURY_ACCOUNT_ID` | same |

Set both names of each pair to the same value until they are unified.
`jitFundProvider` throws without the payout one — a withdrawal cannot be funded
if there is nowhere to send the money.

### Two questions per partner that decide the corridor

Neither is an engineering choice, and both change what the customer experiences:

**Will they accept stablecoin?** If yes, set `cryptoLicensed: true` on their
capability and the corridor uses `ATOMIC_USDT` — instant, no float, no bank
wire on the critical path. This is the only mode that is both instant and
zero-prefunded. If no, every other mode contains a bank wire, and a wire is
either before the payout (not instant) or after it (needs float).

**Will they hold float?** If yes, set `prefundedFloat: true` and the beneficiary
is paid from money already with them while your wire replenishes behind it.
That buys real-time at the cost of working capital *and* credit exposure to
that partner.

---

## 5. Ops and workers

```env
OPS_API_KEY=                    # required by /api/ops/* and /api/settlement/*
API_BASE_URL=https://<your-domain>/api
SOLANA_RPC_URL=
SETTLEMENT_WORKER_ENABLED=true
OUTBOX_WORKER_ENABLED=true
RECON_ONCHAIN_ADDRESSES=        # treasury addresses reconciliation checks
```

Ops endpoints **fail closed**: with no `OPS_API_KEY` they return 503 rather
than opening up. That is intended — but it also means reconciliation and the
settlement views are unavailable until it is set.

---

## Verifying, in order

Each step exercises more than the last. Stop at the first failure.

```bash
# 1 — the service boots and reports which credentials are still unset
npm run dev
curl -s localhost:4000/api/health

# 2 — quoting works and the right LP wins
curl -s -X POST localhost:4000/api/quote -H 'Content-Type: application/json' \
  -d '{"fromCurrency":"USD","toCurrency":"KES","fromAmount":300}'

# 3 — a full corridor, against the real API
./scripts/demo.sh

# 4 — the engine itself, against a scratch database
DATABASE_URL=postgresql://…/axlink_harness SIMULATOR_ENABLED=true npm run simulate
```

The startup log names every credential still unset. Read it: that line is the
difference between "sandbox mode" and "silently not talking to a partner".

The harness is the strongest signal — 10 scenarios covering ordering, crash
recovery, idempotency, unreachable nodes, failed transactions and amount drift,
each also asserting six global invariants. Nothing in it re-implements
settlement logic; if it passes, the code that would run in production is the
code that ran.

---

## Before going live

- [ ] `FIREBLOCKS_WEBHOOK_PUBLIC_KEY` set — the check passes everything while empty
- [ ] `OPS_API_KEY` set, and not shared with banks or customers
- [ ] All webhook URLs registered with each provider and reachable from outside
- [ ] Migration baseline resolved on every existing database
- [ ] `NODE_ENV=production` — this disables the harness and the demo API outright
- [ ] `DEMO_ENABLED` unset. It issues KYC-approved accounts
- [ ] `*_SANDBOX=false` on every provider
- [ ] `.env`, `fireblocks_secret.key` and `fireblocks.csr` are not in the repo

### Decisions still open

**Partner FX is not in the quoted spread.** A corridor where neither side is
USD converts twice — ours at collection, the partner's at payout. The 1.80% the
router applies is only ours; whatever the partner takes on their leg is
invisible to it. Settle who carries that margin before quoting such a corridor.

**Float currency is an FX position.** A float held in the payout currency makes
you long that currency on the whole balance, continuously — not per
transaction. Sizing the float is also sizing that position.

**Float has no low-water mark.** `PREFUNDED_FLOAT` is selected on a boolean;
nothing reads the `FLOAT:<partner>:<CCY>` balance. A drained float fails at the
moment of payment, which is worse than the slow wire it was chosen to avoid.
