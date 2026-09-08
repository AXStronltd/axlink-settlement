# APPRA Settlement Service — Integration Guide

## What this service does

Handles the full crypto-rail settlement for APPRA. Users see a traditional digital bank — no crypto visible. Behind the scenes:

- **B2BinPay** (LP) — converts fiat ↔ USDT at institutional rates
- **Fireblocks** — custody + USDT vault per user on Solana (near-gasless)
- **Orchestrator** — coordinates the full flow automatically

## Architecture

```
Payout Rail (M-Pesa / Bank)
        ↓ webhook
APPRA Orchestrator
        ↓
B2BinPay: fiat → USDT ──→ sends directly to user's Fireblocks vault address
                                    ↓
                           Fireblocks webhook → APPRA
                                    ↓
                           Ledger credits user balance
```

Revenue model: **FX spread baked into rate** (no visible fee). B2BinPay charges institutional per-transaction fee. APPRA earns the spread difference. No SWIFT = much higher margins.

---

## Step 1 — Clone & install

```bash
git clone https://github.com/AXStronltd/fincruise-settlement.git
cd fincruise-settlement
npm install
cp .env.example .env
```

---

## Step 2 — B2BinPay sandbox credentials

1. Go to **https://sandbox.b2binpay.com**
2. Login → **Profile** → **Access list** → **API** tab → click **Regenerate**
3. Copy the 3 values that appear (shown ONCE only):

```env
B2BINPAY_CLIENT_ID=         # max 18 chars
B2BINPAY_CLIENT_SECRET=
B2BINPAY_CALLBACK_SECRET=
B2BINPAY_SANDBOX=true
```

4. Go to **Wallets** → copy your wallet ID:

```env
B2BINPAY_WALLET_ID=
```

---

## Step 3 — Fireblocks sandbox credentials

### Generate RSA key pair (one-time, on your machine)

```bash
# Generate private key (NEVER commit this file)
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out fireblocks_secret.key

# Generate CSR to upload to Fireblocks
openssl req -new -key fireblocks_secret.key -out fireblocks.csr \
  -subj "/C=KE/O=APPRA/CN=fincruise-settlement"
```

> **If Fireblocks was already set up as FinCruse**, these two names exist in
> their console and must match: the CSR subject of the registered API user,
> and the treasury vault's name. Either keep the old names or rename them in
> the Fireblocks console too — the rebrand does not reach across.


### Register with Fireblocks

1. Go to **https://sandbox.fireblocks.io**
2. **Settings** → **Users & API Keys** → **Add API User**
3. Name: `fincruise-settlement`, Role: `Editor`
4. In the CSR field: paste contents of `fireblocks.csr`
5. Click **Create** → copy the **API Key** shown

```env
FIREBLOCKS_API_KEY=          # paste here
FIREBLOCKS_SECRET_KEY_PATH=./fireblocks_secret.key
FIREBLOCKS_SANDBOX=true
FIREBLOCKS_USDT_ASSET=USDT_SOL
```

### Create APPRA treasury vault

In Fireblocks sandbox:
1. **Vaults** → **Add Vault Account** → name it `APPRA Treasury`
2. Add USDT_SOL asset → copy the vault ID

```env
FIREBLOCKS_TREASURY_VAULT=   # paste vault ID here
```

### Webhook public key

1. Fireblocks Console → **Webhooks** → **Public Key**
2. Set webhook URL: `https://api-finance.axstron.com/api/webhooks/fireblocks`
3. Copy the public key (full PEM):

```env
FIREBLOCKS_WEBHOOK_PUBLIC_KEY=-----BEGIN PUBLIC KEY-----
...
-----END PUBLIC KEY-----
```

---

## Step 4 — Database

```bash
# Run Prisma migration (creates all tables)
npx prisma migrate dev --name init

# Or for production
npx prisma migrate deploy
```

---

## Step 5 — Start the service

```bash
npm run dev        # development (ts-node, hot-ish)
npm run build      # compile to dist/
npm run start      # run compiled (production)
```

Health check:
```bash
curl http://localhost:4000/api/health
```

---

## Step 6 — Create your first user + vault

```bash
# Creates a Fireblocks vault + ledger account for a user
curl -X POST http://localhost:4000/api/users \
  -H "Content-Type: application/json" \
  -d '{"email":"james@example.com","name":"James","currency":"KES"}'

# Returns:
# { "userId": "...", "vaultId": "vault_...", "currency": "KES" }
```

Then manually set `usdtAddress` (user's Fireblocks USDT_SOL deposit address):
```bash
# Get the address from Fireblocks for that vault's USDT_SOL asset
# Update in DB: UPDATE "User" SET "usdtAddress" = '...' WHERE id = '...';
```

---

## Live API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/quote` | JIT rate lock (30s) |
| GET | `/api/quote/:id` | Quote status |
| POST | `/api/users` | Create user + Fireblocks vault |
| GET | `/api/users/:id` | User balances |
| POST | `/api/orchestrator/transfer` | P2P transfer |
| POST | `/api/orchestrator/withdraw` | Withdrawal to bank/M-Pesa |
| POST | `/api/orchestrator/payout-rail/fiat-arrived` | Deposit webhook from payout partner |
| POST | `/api/orchestrator/payout-rail/confirmed` | Withdrawal confirmation |
| GET | `/api/rates?symbols=USDT,GBP` | Live exchange rates |
| GET | `/api/fireblocks/vaults` | List vaults |
| POST | `/api/fireblocks/vaults` | Create vault |
| GET | `/api/fireblocks/assets` | Supported assets |
| POST | `/api/webhooks/b2binpay` | B2BinPay callbacks |
| POST | `/api/webhooks/fireblocks` | Fireblocks callbacks |
| POST | `/api/webhooks/fireboks` | Alias (registered URL) |
| GET | `/monitor` | Live money flow visualiser |
| GET | `/demo` | End-to-end demo (Mike → James) |

---

## Key flow: Deposit (Fiat IN)

When a user sends KES via M-Pesa:

```
POST /api/orchestrator/payout-rail/fiat-arrived
{
  "userId": "user_james_id",
  "currency": "KES",
  "amount": 10000,
  "rail": "M-Pesa",
  "railReference": "QHX7Y8Z"
}
```

Orchestrator automatically:
1. Looks up user's `usdtAddress` (Fireblocks vault address)
2. Tells B2BinPay: convert KES → USDT, send to that address
3. B2BinPay sends USDT directly to Fireblocks vault
4. Fireblocks webhook confirms → ledger credits user

---

## Key flow: P2P Transfer (USD → KES)

```bash
# Step 1: Get live rate (30s lock)
curl -X POST http://localhost:4000/api/quote \
  -H "Content-Type: application/json" \
  -d '{"fromCurrency":"USD","toCurrency":"KES","fromAmount":300}'

# Returns: { quoteId, rate, toAmount, expiresIn: 30 }

# Step 2: Execute transfer at locked rate
curl -X POST http://localhost:4000/api/orchestrator/transfer \
  -H "Content-Type: application/json" \
  -d '{
    "senderId": "user_mike_id",
    "receiverId": "user_james_id",
    "fromCurrency": "USD",
    "toCurrency": "KES",
    "amount": 300,
    "quoteId": "q_abc123"
  }'
```

---

## Production webhook URLs (already registered)

| Service | URL |
|---------|-----|
| Fireblocks | `https://api-finance.axstron.com/api/webhooks/fireboks` |
| B2BinPay | `https://api-finance.axstron.com/api/webhooks/b2binpay` |

---

## Revenue model

APPRA earns via **FX spread** — no visible fee to user:
- B2BinPay gives institutional rate (close to mid-market)
- APPRA applies spread markup (e.g. 1.8% on USD→KES)
- User sees a clean rate — no fee line
- B2BinPay charges APPRA per-transaction at institutional grade
- Solana gas: ~$0.00025 per transaction
- No SWIFT, no correspondent banks

## Files never to commit

```
.env
fireblocks_secret.key
fireblocks.csr
```

All three are in `.gitignore`.
