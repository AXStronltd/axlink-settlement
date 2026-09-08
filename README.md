# FinCruse Settlement Service

**Users see a neobank. Crypto never appears.** All conversion happens silently in the backend across five layers.

**No SWIFT.** No correspondent banks, no nostro accounts. Cross-border value
moves as USDT on Solana — seconds, ~$0.00025 in gas, provable on-chain.
B2BinPay handles the **USD ↔ USDT** hop in both directions at **1:1**, so the
internal transport never loses value. FX happens only where fiat meets a rail —
at collection and at payout — never in the crypto hop.

> Architecture and code layout: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · Deployment: [`docs/DEPLOY.md`](docs/DEPLOY.md) · Running locally: [`CLAUDE.md`](CLAUDE.md)

---

## Five-Layer Architecture

```
USER (app — sees fiat only, no crypto ever)
        │
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│                         FinCruse Platform                              │
│                                                                        │
│  LAYER 1 — FIAT RAILS         LAYER 2–3 — CRYPTO RAIL (hidden)        │
│  ┌────────────────────┐       ┌─────────────────┐  ┌───────────────┐  │
│  │ Daraja   (M-Pesa)  │ ←──→  │    B2BinPay     │→ │  Fireblocks   │  │
│  │ Choice Bank (Afr.) │       │  fiat ↔ USDT    │  │  USDT vaults  │  │
│  │ Brainrock (EU/UK)  │       │  USD/EUR/GBP    │  │  on Solana    │  │
│  │                    │       │  only           │  └───────────────┘  │
│  │ chosen per corridor│       └─────────────────┘                     │
│  └────────────────────┘                                                │
│                               LAYER 4 — SETTLEMENT ENGINE             │
│                               ┌────────────────────────────────────┐  │
│                               │ legs · journal · proof · reconcile │  │
│                               │ resumable, double-entry, provable  │  │
│                               └────────────────────────────────────┘  │
│                                                                        │
│                               LAYER 5 — LEDGER                        │
│                               ┌────────────────────────────────────┐  │
│                               │  Prisma + PostgreSQL               │  │
│                               │  Virtual fiat balances per user    │  │
│                               └────────────────────────────────────┘  │
│                                                                        │
│                        FinCruse Orchestrator                           │
│              (coordinates all five layers per transaction)             │
└───────────────────────────────────────────────────────────────────────┘
```

| Layer | Provider | Role |
|-------|----------|------|
| Fiat rails | **Daraja** · **Choice Bank** · **Brainrock** | Collection and payout. Chosen per corridor; the partner applies local FX |
| Liquidity | **B2BinPay** | USD ↔ USDT at 1:1, both directions. **Settles USD, EUR, GBP only** — never local currency |
| Custody | **Fireblocks** | Holds USDT per-user vault on Solana (~$0.00025 gas) |
| Settlement | **Legs + journal** | Resumable state machine, double-entry, on-chain proof |
| Ledger | **Prisma + PostgreSQL** | Tracks fiat balances, all flows atomic |

Revenue model: **FX spread baked into rate** — no visible fee. B2BinPay gives institutional rate, FinCruse marks up, user sees a clean rate.

---

## Complete User Journeys

### Journey 1 — User Signup

**What user sees:** "Account created. Your deposit details: GB29 XXXX XXXX ..."

```
POST /api/users { "email": "james@example.com", "name": "James", "currency": "KES" }

Orchestrator in parallel:
  → Fireblocks: createVaultAccount("fincruise_james@example.com")
  → Brainrock: createVirtualAccount({ userId, currency: "KES", country: "KE" })

Returns:
{
  "userId": "user_abc",
  "vaultId": "vault_123",           ← Fireblocks (internal, never shown)
  "currency": "KES",
  "depositAccount": {
    "iban": "GB29NWBK60161331926819",  ← shown to user as their account
    "bic":  "NWBKGB2L",
    "currency": "KES"
  }
}
```

---

### Journey 2 — Deposit (Fiat IN)

**What user sees:** "£500 received"  
**What happens behind the scenes:**

```
1. User sends £500 from Barclays → their FinCruse IBAN (Brainrock)

2. Brainrock → POST /api/webhooks/brainrock
   { "type": "payment.received", "data": { "accountId": "va_james", "amount": 500, "currency": "GBP" } }

3. Orchestrator finds user by brainrockAccountId
   → Creates BankDeposit record (status: PROCESSING)

4. B2BinPay on-ramp:
   → createDeposit() — tell B2BinPay to expect £500 GBP
   → createPayout(currencyId: "USDT_SOL", address: james.usdtAddress, amount: ~$634 USDT)
   → B2BinPay converts GBP → USDT, sends directly to James's Fireblocks vault address

5. Fireblocks → POST /api/webhooks/fireblocks
   { "type": "TRANSACTION_STATUS_UPDATED", "data": { "status": "COMPLETED", "assetId": "USDT_SOL", "destination": { "id": "vault_123" } } }

6. Webhook handler:
   → Finds user by vaultId
   → Finds pending BankDeposit
   → Ledger credit: +£500 GBP to James's account
   → BankDeposit status: COMPLETED

7. User sees: "£500 deposited" — zero crypto exposure
```

---

### Journey 3 — P2P Transfer: Same Currency (GBP → GBP)

**What user sees:** "£300 sent to Sarah. Arrived instantly."

```
POST /api/orchestrator/transfer
{ "senderId": "mike", "receiverId": "sarah", "fromCurrency": "GBP", "toCurrency": "GBP", "amount": 300 }

Flow (0 B2BinPay calls, 1 Fireblocks):
  Ledger: debit Mike -£300
  Fireblocks: vault_mike → vault_sarah (USDT_SOL, ~$381)
  Ledger: credit Sarah +£300
  Done in ~2 seconds. No bank involved. No FX.
```

---

### Journey 4 — P2P Transfer: Cross-Border (GBP → KES)

**What Mike sees:** "£300 sent to James. Rate: 1 GBP = 159.20 KES"  
**What James sees:** "KSh 47,760 received from Mike"

```
Step 1 — JIT Rate Lock (30 seconds):
  POST /api/quote { "fromCurrency": "GBP", "toCurrency": "KES", "fromAmount": 300 }
  → B2BinPay institutional rate: 1 GBP = 162.04 KES
  → FinCruse applies 1.8% spread: customer rate = 159.12 KES
  → Locked for 30s. quoteId: "q_abc"

Step 2 — Execute (uses locked rate):
  POST /api/orchestrator/transfer
  { "senderId": "mike", "receiverId": "james", "fromCurrency": "GBP",
    "toCurrency": "KES", "amount": 300, "quoteId": "q_abc" }

  2a. Ledger: debit Mike -£300
  2b. B2BinPay on-ramp: £300 GBP → ~$381 USDT (credits FinCruse wallet)
  2c. Fireblocks: vault_mike → vault_james (~$381 USDT on Solana, gas $0.00025)
  2d. B2BinPay off-ramp: ~$381 USDT → ~$381 USD (B2BinPay settles USD/EUR/GBP only)
  2e. USD wired to Daraja; Daraja applies local FX and pays KSh 47,760 to James's M-Pesa
  2f. Ledger: credit James +KSh 47,760

  FinCruse earns: ~$6.87 USD spread on this transaction
  B2BinPay cost:  ~$1.14 USD institutional fee
  Profit:         ~$5.73 USD
  SWIFT cost:     $0 (not used)

Mike never sees: USDT, Fireblocks, Solana
James never sees: USDT, Fireblocks, Solana
```

---

### Journey 5 — Withdrawal (Fiat OUT)

**What user sees:** "KSh 10,000 sent to M-Pesa +254712345678"

```
POST /api/orchestrator/withdraw
{
  "userId": "user_james",
  "currency": "KES",
  "amount": 10000,
  "recipientName": "James Mwangi",
  "destination": { "type": "mpesa", "mobileNumber": "+254712345678" }
}

Flow:
  A. Balance check: James has ≥ KSh 10,000
  B. Ledger: debit James -KSh 10,000
  C. Fireblocks: vault_james → FinCruse treasury vault (USDT equivalent)
  D. B2BinPay off-ramp: USDT → USD (B2BinPay settles USD/EUR/GBP only)
  E. USD wired to Daraja; Daraja applies local FX and sends KSh 10,000 → +254712345678
  F. Partner webhook: "payment.sent" → withdrawal marked COMPLETED
     If payout fails: Brainrock fires "payment.failed" → ledger credit reversed automatically

James gets M-Pesa notification: "KSh 10,000 received from FinCruse"
```

---

## What to Connect (Blockchain Engineer)

### 1. Brainrock (Fiat Banking Layer)

**Provides:** Virtual IBANs per user, inbound payment webhooks, outbound bank/M-Pesa payments.

Setup:
1. Create account at Brainrock → get API key
2. Create FinCruse treasury account (for sending payouts)
3. Register webhook URL: `https://your-domain/api/webhooks/brainrock`

```env
BRAINROCK_API_KEY=
BRAINROCK_WEBHOOK_SECRET=
BRAINROCK_SANDBOX=true
BRAINROCK_TREASURY_ACCOUNT_ID=
```

**Integration files:** `src/providers/live/brainrock.ts` (API client) + `brainrock.baas.ts` (adapter)  
The API shape is pre-built. Map the method names to actual Brainrock endpoints.

> **Alternative:** Square (US corridors), Railsr/Bankable (EU), ClearBank (UK).  
> Same service interface — just change `BASE_URL` and field names.

---

### 2. Fireblocks (Crypto Custody)

1. [sandbox.fireblocks.io](https://sandbox.fireblocks.io) → **Settings → Users & API Keys → Add API User**
2. Generate keys:
   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out fireblocks_secret.key
   openssl req -new -key fireblocks_secret.key -out fireblocks.csr \
     -subj "/C=KE/O=FinCruse/CN=fincruise-settlement"
   ```
3. Upload `fireblocks.csr` → copy API Key
4. Create treasury vault → add USDT_SOL → copy vault ID
5. Set webhook URL → copy public key

```env
FIREBLOCKS_API_KEY=
FIREBLOCKS_SECRET_KEY_PATH=./fireblocks_secret.key
FIREBLOCKS_SANDBOX=true
FIREBLOCKS_USDT_ASSET=USDT_SOL
FIREBLOCKS_TREASURY_VAULT=
FIREBLOCKS_SETTLEMENT_ADDRESS=
FIREBLOCKS_WEBHOOK_PUBLIC_KEY=
```

**Integration files:** `src/providers/live/fireblocks.ts` (API client) + `fireblocks.lp.ts` (LP adapter) — complete, no changes needed.

---

### 3. B2BinPay (Liquidity Provider)

1. [sandbox.b2binpay.com](https://sandbox.b2binpay.com) → **Profile → Access list → API → Regenerate**
2. Copy 3 credentials (shown once)
3. Copy wallet ID from **Wallets**
4. Register callback: `https://your-domain/api/webhooks/b2binpay`

```env
B2BINPAY_CLIENT_ID=
B2BINPAY_CLIENT_SECRET=
B2BINPAY_CALLBACK_SECRET=
B2BINPAY_WALLET_ID=
B2BINPAY_SANDBOX=true
```

**Integration file:** `src/providers/live/b2binpay.ts` — API client and LP adapter in one file. Complete, no changes needed.

---

### 4. Database

```bash
DATABASE_URL=postgresql://user:pass@host:5432/fincruise_settlement
npx prisma db push        # no migrations dir — schema is pushed directly
```

---

## Quick Start

```bash
git clone <repo>
cd fincruise-settlement
npm install
cp .env.example .env
# Fill in .env

npx prisma db push
npx prisma generate
npm run dev
```

Health check:
```bash
curl http://localhost:4000/api/health
```

---

## API Reference

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/users` | Create user + Fireblocks vault + Brainrock IBAN |
| GET | `/api/users/:id` | User + all balances |
| POST | `/api/quote` | JIT rate lock (30s, spread baked in) |
| GET | `/api/quote/:id` | Quote status + countdown |
| POST | `/api/orchestrator/transfer` | P2P transfer (same or cross-currency) |
| POST | `/api/orchestrator/withdraw` | Withdraw to bank / M-Pesa |
| POST | `/api/orchestrator/payout-rail/fiat-arrived` | Manual deposit trigger |
| POST | `/api/orchestrator/payout-rail/confirmed` | Manual payout confirmation |
| GET | `/api/network/rates` | Live FX rates — **requires bank bearer auth** |
| POST | `/api/webhooks/brainrock` | Brainrock inbound payment events |
| POST | `/api/webhooks/b2binpay` | B2BinPay transfer status |
| POST | `/api/webhooks/fireblocks` | Fireblocks transaction confirmation |
| POST | `/api/webhooks/daraja/*` | M-Pesa B2C and STK callbacks |
| POST | `/api/webhooks/choicebank` | Choice Bank transfer status |
| GET | `/api/settlement/proof/:type/:id` | On-chain settlement proof (public) |
| GET | `/api/settlement/books/*` | Journal, balances — **`OPS_API_KEY`** |
| GET | `/api/simulate/*` | Narrated demo flows (no DB, no partners) |

---

## Withdrawal Destination Examples

```json
// M-Pesa (Kenya, Tanzania, Uganda, Ghana, Nigeria)
{ "type": "mpesa", "mobileNumber": "+254712345678" }

// UK Faster Payments
{ "type": "faster_payments", "sortCode": "60-16-13", "accountNumber": "31926819" }

// SEPA (EU)
{ "type": "sepa", "iban": "DE89370400440532013000", "bic": "COBADEFFXXX" }

// African bank transfer
{ "type": "bank_transfer", "bankCode": "KCB001", "bankAccountNumber": "1234567890" }
```

---

## Registered Webhook URLs (Production)

| Service | URL |
|---------|-----|
| Brainrock | `https://api-finance.axstron.com/api/webhooks/brainrock` |
| Fireblocks | `https://api-finance.axstron.com/api/webhooks/fireblocks` |
| B2BinPay | `https://api-finance.axstron.com/api/webhooks/b2binpay` |

---

## Files Never to Commit

```
.env
fireblocks_secret.key
fireblocks.csr
```
