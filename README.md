# FinCruse Settlement Service

Crypto-rail settlement backend for FinCruse. Users interact with a traditional digital bank — no crypto visible. Behind the scenes: **B2BinPay** converts fiat ↔ USDT, **Fireblocks** holds per-user USDT vaults on Solana, and the **Orchestrator** coordinates the full flow automatically.

---

## Architecture

```
User (fiat)
    │
    ▼
FinCruse Orchestrator  ──────────────────────────────────────┐
    │                                                         │
    ├── DEPOSIT (fiat IN)                                     │
    │   Payout rail webhook → B2BinPay on-ramp               │
    │   → USDT sent directly to user's Fireblocks vault       │
    │   → Fireblocks webhook confirms → Ledger credits user   │
    │                                                         │
    ├── WITHDRAWAL (fiat OUT)                                 │
    │   Ledger debit → Fireblocks vault → B2BinPay off-ramp   │
    │   → Payout rail (M-Pesa / bank) → User                  │
    │                                                         │
    └── P2P TRANSFER (user → user)                           │
        Same currency: 0 B2BinPay, 1 Fireblocks vault move   │
        Cross-currency: B2BinPay on-ramp + Fireblocks + off-ramp

Revenue model: FX spread baked into rate — no visible fee to user.
No SWIFT. Solana gas ≈ $0.00025 per tx.
```

---

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js + TypeScript |
| Framework | Express 5 |
| ORM | Prisma 7 + PostgreSQL |
| Crypto custody | Fireblocks (USDT_SOL) |
| Liquidity provider | B2BinPay v3 |
| Settlement rail | Solana (via Fireblocks) |

---

## What's Already Built

- Full orchestrator: deposit, withdrawal, P2P transfer flows
- JIT quote engine with 30s rate lock + FX spread revenue model
- Atomic ledger (debit / credit with balance checks)
- Fireblocks vault management (create, list, transfer)
- B2BinPay on-ramp / off-ramp / fee estimation
- Webhook handlers with signature verification (B2BinPay HMAC + Fireblocks RSA)
- Live flow visualiser at `/monitor`
- End-to-end demo at `/demo`
- Audit log on every transaction event

---

## External Integrations to Connect

These are the three external systems the blockchain engineer needs to wire up. Everything else is done.

### 1. Fireblocks (Crypto Custody)

**What it does:** Holds per-user USDT vaults on Solana. Every FinCruse user gets one Fireblocks vault. B2BinPay sends USDT directly to the vault address — no treasury hop.

**Steps:**
1. Go to [sandbox.fireblocks.io](https://sandbox.fireblocks.io) → **Settings → Users & API Keys → Add API User**
2. Generate RSA key pair locally:
   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out fireblocks_secret.key
   openssl req -new -key fireblocks_secret.key -out fireblocks.csr \
     -subj "/C=KE/O=FinCruse/CN=fincruise-settlement"
   ```
3. Upload `fireblocks.csr` → copy the API Key shown
4. Create treasury vault: **Vaults → Add Vault Account → name "FinCruse Treasury"** → add USDT_SOL asset → copy vault ID
5. Set webhook URL in Console: `https://your-domain/api/webhooks/fireblocks`
6. Copy the Fireblocks public key (Console → Webhooks → Public Key)

**Env vars to fill:**
```env
FIREBLOCKS_API_KEY=
FIREBLOCKS_SECRET_KEY_PATH=./fireblocks_secret.key
FIREBLOCKS_SANDBOX=true
FIREBLOCKS_USDT_ASSET=USDT_SOL
FIREBLOCKS_TREASURY_VAULT=
FIREBLOCKS_SETTLEMENT_ADDRESS=
FIREBLOCKS_WEBHOOK_PUBLIC_KEY=
```

**Integration point in code:**
- `src/services/fireblocks.service.ts` — vault CRUD, transfers, webhook verification
- `src/routes/webhook.routes.ts` — Fireblocks webhook handler (credits ledger on USDT confirmed)

---

### 2. B2BinPay (Liquidity Provider — fiat ↔ USDT)

**What it does:** Converts fiat → USDT (on-ramp) and USDT → fiat (off-ramp) at institutional rates. FinCruse marks up the rate — that's the revenue.

**Steps:**
1. Go to [sandbox.b2binpay.com](https://sandbox.b2binpay.com) → **Profile → Access list → API → Regenerate**
2. Copy the 3 credentials shown (shown ONCE)
3. Go to **Wallets** → copy your wallet ID
4. Register callback URL in B2BinPay dashboard: `https://your-domain/api/webhooks/b2binpay`

**Env vars to fill:**
```env
B2BINPAY_CLIENT_ID=
B2BINPAY_CLIENT_SECRET=
B2BINPAY_CALLBACK_SECRET=
B2BINPAY_WALLET_ID=
B2BINPAY_SANDBOX=true
```

**Integration point in code:**
- `src/services/b2binpay.service.ts` — auth, deposits, payouts, rates, webhook HMAC
- `src/routes/webhook.routes.ts` — B2BinPay webhook handler

---

### 3. Database (PostgreSQL)

**Steps:**
```bash
# Set DATABASE_URL in .env, then:
npx prisma migrate dev --name init   # dev
npx prisma migrate deploy            # production
```

**Schema:** `prisma/schema.prisma` — User, Account, Transfer, Withdrawal, BankDeposit, CryptoBuy, AuditLog

---

## Quick Start

```bash
git clone <repo>
cd fincruise-settlement
npm install
cp .env.example .env
# Fill in .env (see External Integrations above)

npx prisma migrate dev --name init
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
| POST | `/api/users` | Create user + Fireblocks vault |
| GET | `/api/users/:id` | User + balances |
| POST | `/api/quote` | JIT rate lock (30s) |
| GET | `/api/quote/:id` | Quote status |
| POST | `/api/orchestrator/transfer` | P2P transfer |
| POST | `/api/orchestrator/withdraw` | Withdrawal to bank/M-Pesa |
| POST | `/api/orchestrator/payout-rail/fiat-arrived` | Deposit webhook from payout partner |
| POST | `/api/orchestrator/payout-rail/confirmed` | Withdrawal confirmation |
| GET | `/api/rates?symbols=USDT,GBP` | Live FX rates |
| GET | `/api/fireblocks/vaults` | List vaults |
| POST | `/api/fireblocks/vaults` | Create vault |
| GET | `/api/fireblocks/assets` | Supported assets |
| POST | `/api/webhooks/b2binpay` | B2BinPay callbacks |
| POST | `/api/webhooks/fireblocks` | Fireblocks callbacks |
| GET | `/monitor` | Live money flow visualiser |
| GET | `/demo` | End-to-end demo |

---

## Deposit Flow (Fiat IN)

```bash
POST /api/orchestrator/payout-rail/fiat-arrived
{
  "userId": "user_james_id",
  "currency": "KES",
  "amount": 10000,
  "rail": "M-Pesa",
  "railReference": "QHX7Y8Z"
}
```

Orchestrator:
1. Looks up user's Fireblocks USDT vault address
2. Tells B2BinPay: convert KES → USDT, send to that vault address
3. B2BinPay sends USDT directly to Fireblocks
4. Fireblocks webhook fires → ledger credits user

---

## P2P Transfer Flow (USD → KES)

```bash
# 1. Lock rate for 30s
POST /api/quote
{ "fromCurrency": "USD", "toCurrency": "KES", "fromAmount": 300 }
# → { "quoteId": "q_abc123", "rate": 127.05, "toAmount": 38115, "expiresIn": 30 }

# 2. Execute at locked rate
POST /api/orchestrator/transfer
{
  "senderId": "user_mike",
  "receiverId": "user_james",
  "fromCurrency": "USD",
  "toCurrency": "KES",
  "amount": 300,
  "quoteId": "q_abc123"
}
```

---

## Files Never to Commit

```
.env
fireblocks_secret.key
fireblocks.csr
```

All three are in `.gitignore`.

---

## Production Webhook URLs

| Service | URL |
|---------|-----|
| Fireblocks | `https://your-domain/api/webhooks/fireblocks` |
| B2BinPay | `https://your-domain/api/webhooks/b2binpay` |

Update `API_BASE_URL` in `.env` to your production domain before deploying.
