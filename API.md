# AxLink Settlement API — Developer Reference

> **AxLink Network · Fireblocks USDT on Solana · Multi-rail BaaS**
>
> Built by AXSTRON. This document is for backend engineers integrating with or extending the AxLink settlement service. Every endpoint, every webhook, and every money-movement flow is documented here.

---

## Table of Contents

1. [What This System Does](#1-what-this-system-does)
2. [Architecture Overview](#2-architecture-overview)
3. [Settlement Flows](#3-settlement-flows)
4. [Running Locally](#4-running-locally)
5. [Environment Variables](#5-environment-variables)
6. [Supported Currencies & Corridors](#6-supported-currencies--corridors)
7. [API Endpoints](#7-api-endpoints)
   - [Health](#71-health)
   - [Users](#72-users)
   - [Cards](#73-cards)
   - [Quote (JIT RFQ)](#74-quote-jit-rfq)
   - [Transfers (P2P)](#75-transfers-p2p)
   - [Orchestrator (recommended)](#76-orchestrator-recommended)
   - [Withdrawals](#77-withdrawals)
   - [Deposits](#78-deposits)
   - [Simulate](#79-simulate)
8. [Webhooks — Inbound](#8-webhooks--inbound)
   - [B2BinPay](#81-b2binpay)
   - [Fireblocks](#82-fireblocks)
   - [Brainrock — Payments](#83-brainrock--payments)
   - [Brainrock — Card Authorization (real-time)](#84-brainrock--card-authorization-real-time)
   - [Brainrock — Card Settlement & Reversal](#85-brainrock--card-settlement--reversal)
   - [Daraja (M-Pesa)](#86-daraja-m-pesa)
   - [Choice Bank](#87-choice-bank)
9. [Error Responses](#9-error-responses)
10. [Kafka Events](#10-kafka-events)
11. [Data Models](#11-data-models)

---

## 1. What This System Does

AxLink is a **Banking as a Service (BaaS)** platform. Users get a bank account, virtual IBAN, and debit card. They see and spend local fiat only. The backend settles everything in **USDT on Solana** via Fireblocks vaults — users never know or care about USDT.

**Key properties:**
- **No SWIFT** — AxLink is the alternative. Settlement is vault-to-vault on Solana.
- **No prefunding** — corridors are funded Just-In-Time via RFQ. No idle capital.
- **Instant settlement** — Fireblocks vault-to-vault on Solana takes < 1 second.
- **Multi-LP** — B2BinPay + AxLink's own Fireblocks reserves compete in every RFQ. Best rate wins.
- **Kafka-gated** — every payment is validated by an event consumer before any ledger write. Rejected payments return `422 PAYMENT_REJECTED` with a clear reason.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER LAYER                               │
│   Mobile / Web App → sees local fiat (KES, GBP, NGN, etc.)     │
└───────────────────────────────┬─────────────────────────────────┘
                                │ REST API
┌───────────────────────────────▼─────────────────────────────────┐
│                    FINCRUISE SETTLEMENT API                      │
│                                                                  │
│  ┌─────────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐  │
│  │  Kafka Gate │  │ JIT RFQ  │  │  Ledger  │  │  Orchestr.  │  │
│  │  (validate) │  │ 3 LPs    │  │  (fiat)  │  │  (routing)  │  │
│  └─────────────┘  └──────────┘  └──────────┘  └─────────────┘  │
└──────────┬───────────────┬─────────────────────────┬────────────┘
           │               │                         │
           ▼               ▼                         ▼
    ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────┐
    │  FIREBLOCKS  │  │   B2BINPAY   │  │     LOCAL RAILS         │
    │  USDT/SOL   │  │  fiat↔USDT  │  │  Daraja · ChoiceBank    │
    │  vault-to   │  │  on/off-ramp │  │  Brainrock              │
    │  vault      │  │              │  │  (GBP/EUR/USD/KES/NGN…) │
    └─────────────┘  └──────────────┘  └─────────────────────────┘
```

### LP Tiers (JIT RFQ order)

| LP | ID | When it quotes |
|---|---|---|
| AxLink Fireblocks Vault | `axlink-fireblocks` | Always tries — drops out if treasury USDT < trade size |
| B2BinPay | `b2binpay` | Always quotes (external fiat LP) |
| AxLink Internal | `axlink` | Always quotes (rate-table fallback, last resort) |

Winner = highest `toAmount`. If `axlink-fireblocks` wins, settlement is **direct treasury → receiver vault** — no B2BinPay involvement.

---

## 3. Settlement Flows

### 3.1 Deposit (fiat → AxLink account)

```
User's bank / M-Pesa
    → fiat arrives at AxLink's rails account
    → rail webhook → POST /api/webhooks/brainrock (or /daraja/stk, /choicebank)
    → handleFiatArrived()
        → Kafka validation (user exists, KYC, currency, amount)
        → B2BinPay: fiat → USDT on-ramp
        → B2BinPay sends USDT to user's Fireblocks vault address
        → Fireblocks webhook confirms USDT received
        → Ledger: credit user's fiat balance
    → User sees +KES / +GBP / +NGN in their account
```

### 3.2 Withdrawal (AxLink account → bank)

```
User requests withdrawal
    → POST /api/orchestrator/withdraw
        → Kafka validation (balance, KYC, destination)
        → Ledger: debit user's fiat balance (immediate)
        → Fireblocks: user vault → treasury vault (USDT)
        → B2BinPay: off-ramp USDT → fiat (fills AxLink's treasury)
        → Corridor routing:
              KES → Daraja M-Pesa B2C
              NGN/GHS/ZAR/UGX/TZS → Choice Bank bank transfer
              GBP/EUR/USD/CAD → Brainrock Faster Payments / SEPA / ACH
        → Rail webhook confirms fiat delivered
```

### 3.3 P2P Transfer — same currency

```
POST /api/orchestrator/transfer  (fromCurrency == toCurrency)
    → Kafka validation
    → Ledger: debit sender
    → Fireblocks: sender vault → receiver vault (USDT, Solana, < 1s)
    → Ledger: credit receiver
    → Done — 0 B2BinPay calls
```

### 3.4 P2P Transfer — cross-currency

```
POST /api/orchestrator/transfer  (e.g. GBP → KES)
    → Kafka validation
    → JIT RFQ broadcast → all 3 LPs race → winner = best rate

    IF winner = axlink-fireblocks:
        → Fireblocks: treasury → receiver vault (no B2BinPay)

    IF winner = b2binpay or axlink:
        → B2BinPay on-ramp: sender fiat → USDT
        → Fireblocks: sender vault → receiver vault
        → B2BinPay off-ramp: USDT → receiver fiat

    → Ledger: debit sender, credit receiver
    → Done
```

### 3.5 Card spend

```
User taps Visa/Mastercard at merchant
    → Visa network → Brainrock → POST /api/webhooks/brainrock/card/authorize
        → Find card → check status (ACTIVE?)
        → Same currency: check balance → debit → APPROVED  (<30ms)
        → Cross-currency: AxLink FX rate → convert → check → debit → APPROVED  (<30ms)
        → Overdraft: DECLINED
    → Transaction settles (T+1): POST /api/webhooks/brainrock/card/settled
        → Status update only (ledger already debited on auth)
    → Merchant reversal: POST /api/webhooks/brainrock/card/reversed
        → Credit user back
```

---

## 4. Running Locally

```bash
npm install
cp .env.example .env        # fill in credentials
npx prisma db push          # sync schema to DB
npm run dev                 # starts on :4000
```

**Startup output (all systems healthy):**
```
AxLink Settlement running on http://localhost:4000
[AxLink LP] Registered: AxLink Fireblocks Vault (axlink-fireblocks)
[AxLink LP] Registered: B2BinPay (b2binpay)
[AxLink LP] Registered: AxLink Internal (axlink)
[AxLink] JIT RFQ system ready — 3 LPs registered
[EventBus] No KAFKA_BROKERS — using local in-process event bus (sandbox)
[Validator] Payment validator consumer started
```

In sandbox mode (no real credentials) every external service returns a stub — the full settlement logic still executes. Set `SANDBOX_AXLINK_VAULT_USDT=500000` to simulate a funded Fireblocks treasury vault.

---

## 5. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection (Prisma format) |
| `DIRECT_DATABASE_URL` | ✅ | Direct PostgreSQL URL (for PrismaPg adapter) |
| `API_BASE_URL` | ✅ | Public base URL used for webhook callback registration |
| `PORT` | — | HTTP port (default `4000`) |
| **Fireblocks** | | |
| `FIREBLOCKS_API_KEY` | prod | Fireblocks API key |
| `FIREBLOCKS_SECRET_KEY_PATH` | prod | Path to Fireblocks RSA private key file |
| `FIREBLOCKS_SANDBOX` | — | `"true"` to use Fireblocks sandbox environment |
| `FIREBLOCKS_TREASURY_VAULT` | prod | Vault ID for AxLink treasury (buffer + off-ramp) |
| `FIREBLOCKS_TREASURY_USDT_ADDRESS` | prod | On-chain USDT address of the treasury vault |
| `FIREBLOCKS_USDT_ASSET` | — | Asset ID (default `USDT_SOL`) |
| `FIREBLOCKS_WEBHOOK_PUBLIC_KEY` | prod | PEM public key for webhook signature verification |
| `SANDBOX_AXLINK_VAULT_USDT` | dev | Simulate treasury balance for AxLink Fireblocks LP (default `0`) |
| **B2BinPay** | | |
| `B2BINPAY_CLIENT_ID` | prod | OAuth client ID |
| `B2BINPAY_CLIENT_SECRET` | prod | OAuth client secret |
| `B2BINPAY_SANDBOX` | — | `"true"` for B2BinPay sandbox |
| `B2BINPAY_WALLET_ID` | prod | AxLink's B2BinPay master wallet |
| `B2BINPAY_CALLBACK_SECRET` | prod | HMAC secret for webhook verification |
| **Brainrock** | | |
| `BRAINROCK_API_KEY` | prod | Brainrock API key |
| `BRAINROCK_SANDBOX` | — | `"true"` for Brainrock sandbox |
| `BRAINROCK_TREASURY_ACCOUNT_ID` | prod | Brainrock account ID for outbound payments |
| `BRAINROCK_WEBHOOK_SECRET` | prod | HMAC secret for webhook verification |
| `BRAINROCK_CARD_PROGRAM_ID` | prod | Card program ID for issuing |
| **Daraja (M-Pesa)** | | |
| `DARAJA_CONSUMER_KEY` | prod | Safaricom consumer key |
| `DARAJA_CONSUMER_SECRET` | prod | Safaricom consumer secret |
| `DARAJA_SHORTCODE` | prod | B2C shortcode |
| `DARAJA_INITIATOR_NAME` | prod | Initiator name for B2C |
| `DARAJA_SECURITY_CREDENTIAL` | prod | Encrypted security credential |
| **Choice Bank** | | |
| `CHOICE_BANK_API_KEY` | prod | Choice Bank API key |
| **Kafka** | | |
| `KAFKA_BROKERS` | — | Comma-separated broker list e.g. `broker1:9092,broker2:9092`. If unset, uses local in-process EventEmitter (sandbox) |

---

## 6. Supported Currencies & Corridors

| Currency | Country | Collection Rail | Payout Rail |
|---|---|---|---|
| KES | Kenya | Daraja (M-Pesa STK Push) | Daraja (M-Pesa B2C) |
| NGN | Nigeria | Choice Bank | Choice Bank |
| GHS | Ghana | Choice Bank | Choice Bank |
| ZAR | South Africa | Choice Bank | Choice Bank |
| UGX | Uganda | Choice Bank | Choice Bank |
| TZS | Tanzania | Choice Bank | Choice Bank |
| GBP | United Kingdom | Brainrock (Faster Payments) | Brainrock (Faster Payments) |
| EUR | Europe | Brainrock (SEPA) | Brainrock (SEPA) |
| USD | USA | Brainrock (ACH) | Brainrock (ACH) |
| CAD | Canada | Brainrock (EFT) | Brainrock (EFT) |

All pairs are supported cross-currency — AxLink FX routes via USD internally. Example: KES → NGN goes KES → USD → NGN using the AxLink rate table.

---

## 7. API Endpoints

Base URL: `http://localhost:4000/api`

All requests: `Content-Type: application/json`
All error responses: `{ "error": "message", "code"?: "ERROR_CODE" }`

---

### 7.1 Health

#### `GET /health`

Check if the service is running.

**Response 200**
```json
{
  "status": "ok",
  "service": "fincruise-settlement",
  "timestamp": "2026-06-12T21:00:00.000Z",
  "sandbox": true,
  "callbackBase": "http://localhost:4000/api"
}
```

---

### 7.2 Users

#### `POST /users` — Create user

Creates a user account with a Fireblocks vault and Brainrock virtual IBAN provisioned automatically.

**Request**
```json
{
  "email": "alice@example.com",
  "name": "Alice Kamau",
  "currency": "KES"
}
```

`currency` — primary account currency. Supported: `KES NGN GHS ZAR UGX TZS GBP EUR USD`

**Response 201**
```json
{
  "userId": "cmqbeh9qd0000h2yj0ay3369r",
  "vaultId": "vault_sandbox_1234_abcdef",
  "currency": "KES",
  "depositAccount": {
    "iban": "GB29NWBK60161331926819",
    "bic": "BRCKGB2L",
    "currency": "KES"
  }
}
```

`depositAccount` is `null` if Brainrock is not configured (sandbox). The IBAN is the user's deposit account — they send bank transfers here and the funds land in their AxLink balance.

---

#### `GET /users/lookup?email=alice@example.com`

Find a user by email. Used in the P2P send flow to resolve the receiver.

**Response 200**
```json
{
  "id": "cmqbeh9qd0000h2yj0ay3369r",
  "name": "Alice Kamau",
  "email": "alice@example.com",
  "currency": "KES"
}
```

**Response 404** — user not found on AxLink.

---

#### `GET /users/:id`

Get a user's profile and all account balances.

**Response 200**
```json
{
  "id": "cmqbeh9qd0000h2yj0ay3369r",
  "email": "alice@example.com",
  "name": "Alice Kamau",
  "kycStatus": "APPROVED",
  "vaultId": "vault_sandbox_1234_abcdef",
  "virtualIban": "GB29NWBK60161331926819",
  "virtualIbanBic": "BRCKGB2L",
  "accounts": [
    { "currency": "KES", "balance": 125000, "balanceUsd": 968.99 },
    { "currency": "GBP", "balance": 200,    "balanceUsd": 254.00 }
  ]
}
```

`kycStatus` values: `PENDING` | `APPROVED` | `REJECTED`

---

#### `GET /users/:id/balance/:currency`

Get a single account balance. Fast single-row read.

**Response 200**
```json
{ "balance": 125000, "currency": "KES" }
```

---

### 7.3 Cards

#### `POST /users/:id/card` — Issue debit card

Issues a Visa or Mastercard debit card via Brainrock. **KYC must be `APPROVED`**. One active card per user.

**Request**
```json
{ "cardType": "virtual" }
```

`cardType`: `"virtual"` (default) | `"physical"`

**Response 201**
```json
{
  "cardId": "cmqbhl7q10000q7yjiftwtmx1",
  "last4": "4242",
  "brand": "visa",
  "cardType": "virtual",
  "currency": "KES",
  "status": "ACTIVE",
  "message": "Visa debit card issued. Spend anywhere Visa is accepted."
}
```

`currency` = user's primary account currency. Cross-currency card spend is automatically converted via AxLink FX at authorization time.

**Response 403** — KYC not approved.
**Response 409** — user already has an active card.

---

#### `GET /users/:id/cards` — List cards

**Response 200**
```json
{
  "cards": [
    {
      "id": "cmqbhl7q10000q7yjiftwtmx1",
      "providerCardId": "card_brainrock_xyz",
      "last4": "4242",
      "brand": "visa",
      "cardType": "virtual",
      "currency": "KES",
      "status": "ACTIVE",
      "createdAt": "2026-06-12T22:17:02.041Z"
    }
  ]
}
```

---

### 7.4 Quote (JIT RFQ)

Call this **before** a transfer to get a locked rate. Pass the `quoteId` to the transfer endpoint. The rate is held for **30 seconds**.

#### `POST /quote` — Request JIT quote

Broadcasts an RFQ to all registered LPs simultaneously. Returns the winner's rate.

**Request**
```json
{
  "fromCurrency": "GBP",
  "toCurrency": "KES",
  "fromAmount": 500
}
```

**Response 201**
```json
{
  "quoteId": "a1b2c3d4-...",
  "status": "ACTIVE",
  "from": { "currency": "GBP", "amount": 500 },
  "to":   { "currency": "KES", "amount": 80241.83 },
  "rate": 160.48,
  "fee": "No fee — margin is in the exchange rate",
  "rfq": {
    "winningLP":    "b2binpay",
    "lpQuoteRef":   "b2b_q_abc123",
    "lpRate":       163.80,
    "axlinkSpread": "1.8%",
    "customerRate": 160.48,
    "registeredLPs": ["AxLink Fireblocks Vault", "B2BinPay", "AxLink Internal"]
  },
  "revenueModel": {
    "type":          "FX spread (built into rate)",
    "fincruseRevenue": "$11.46 USD",
    "profitPerTx":   "$9.96 USD",
    "fireblocksGas": "$0.00025 (Solana/USDT)",
    "swiftNotPaid":  "$25 (not used)",
    "vsTraditional": "WorldRemit: 2.9% + SWIFT fee — no SWIFT"
  },
  "expiresIn":  30,
  "expiresAt":  "2026-06-12T22:17:32.000Z",
  "jit":        true,
  "zeroPrefund": true,
  "settlement": "USDT (Fireblocks / Solana) — AxLink internal"
}
```

---

#### `GET /quote/:id` — Check quote status

Returns the quote with a live `expiresIn` countdown. Status becomes `EXPIRED` after 30s and `EXECUTED` once used.

---

### 7.5 Transfers (P2P)

> **Prefer `/api/orchestrator/transfer`** (section 7.6) for new integrations. It validates via Kafka, handles JIT RFQ internally, and routes LP-aware. `/api/transfers` is a lower-level path.

#### `POST /transfers`

**Request**
```json
{
  "senderId":     "cmqbeh9qd0000h2yj0ay3369r",
  "receiverId":   "cmqbemknz000eh2yjjuuqp72t",
  "fromCurrency": "GBP",
  "toCurrency":   "KES",
  "amount":       100,
  "quoteId":      "a1b2c3d4-...",
  "note":         "rent"
}
```

`quoteId` is optional. Without it, AxLink runs a spot quote at execution time. With it, the locked rate is used.

**Response 201**
```json
{
  "transferId":    "cmqbgau5c0000gyyjmhslybus",
  "trackingId":    "p2p_d63d1dbc-...",
  "status":        "COMPLETED",
  "jit":           true,
  "fromCurrency":  "GBP",
  "toCurrency":    "KES",
  "fromAmount":    100,
  "toAmount":      16048.36,
  "fxRate":        160.4836,
  "flow":          "2 B2BinPay — cross-currency (JIT)",
  "fireblocksTxId": "tx_sandbox_...",
  "b2binpay": {
    "onrampId":  "dep_sandbox_...",
    "offrampId": "pay_sandbox_..."
  }
}
```

`flow` values:
- `"0 B2BinPay — same currency"` — Fireblocks vault-to-vault only
- `"2 B2BinPay — cross-currency (JIT)"` — full on-ramp + off-ramp
- `"Fireblocks treasury direct"` — AxLink Fireblocks LP won

---

#### `GET /transfers/:id`

Returns the raw transfer record from the database.

---

### 7.6 Orchestrator (recommended)

The orchestrator is the **primary settlement engine**. All three entry points validate via Kafka before touching the ledger.

#### `POST /orchestrator/transfer` — P2P transfer

This is the recommended endpoint for transfers. Runs the full Kafka validation + JIT RFQ + LP-aware routing.

**Request**
```json
{
  "senderId":     "cmqbeh9qd0000h2yj0ay3369r",
  "receiverId":   "cmqbemknz000eh2yjjuuqp72t",
  "fromCurrency": "GBP",
  "toCurrency":   "KES",
  "amount":       100,
  "quoteId":      "a1b2c3d4-...",
  "note":         "school fees"
}
```

**Response 201**
```json
{
  "transferId":   "cmqbgau5c0000gyyjmhslybus",
  "trackingId":   "p2p_d63d1dbc-...",
  "status":       "COMPLETED",
  "jit":          true,
  "flow":         "Ledger debit → B2BinPay on-ramp → Fireblocks → B2BinPay off-ramp → Ledger credit",
  "fromAmount":   100,
  "toAmount":     16048.36,
  "fxRate":       160.4836,
  "b2binpayCalls": 2,
  "fireblocksCalls": 1
}
```

**Validation errors (422)**
```json
{ "error": "Insufficient balance: has 50.00 GBP, needs 100 GBP", "code": "PAYMENT_REJECTED" }
{ "error": "Sender KYC not approved (status: PENDING)", "code": "PAYMENT_REJECTED" }
{ "error": "Maximum amount for GBP is 250,000", "code": "PAYMENT_REJECTED" }
{ "error": "Currency XYZ is not supported.", "code": "PAYMENT_REJECTED" }
```

---

#### `POST /orchestrator/withdraw` — Withdrawal

Withdraw from a user's AxLink balance to their bank account, mobile money, or IBAN.

**Request**
```json
{
  "userId":        "cmqbeh9qd0000h2yj0ay3369r",
  "currency":      "KES",
  "amount":        10000,
  "recipientName": "Alice Kamau",
  "destination": {
    "type":         "mpesa",
    "mobileNumber": "+254712345678"
  }
}
```

**Destination types by currency:**

| Currency | `type` | Required fields |
|---|---|---|
| KES | `mpesa` | `mobileNumber` (+254…) |
| NGN / GHS / ZAR / UGX / TZS | `bank_transfer` | `bankCode`, `bankAccountNumber` |
| GBP | `faster_payments` | `sortCode`, `accountNumber` |
| EUR | `sepa` | `iban`, `bic` |
| USD | `ach` | `routingNumber`, `accountNumber` |
| CAD | `eft` | `transitNumber`, `institutionNumber`, `accountNumber` |

`type` can be omitted — AxLink infers it from `currency` and `destination` fields.

**Response 201**
```json
{
  "withdrawalId": "cmqbgx...",
  "trackingId":   "wdr_e8f9...",
  "status":       "PENDING_PAYOUT",
  "flow":         "Ledger debit → Fireblocks vault → B2BinPay off-ramp → Brainrock → faster_payments",
  "message":      "Withdrawal of 10000 KES initiated to mpesa"
}
```

---

#### `POST /orchestrator/payout-rail/fiat-arrived` — Deposit trigger

Called when a fiat rail (M-Pesa, bank) confirms money has arrived for a user. This is the **inbound deposit entry point** — rails call this directly or it is called from the rail webhook handlers.

> In production, you do not call this directly. The rail webhooks in section 8 call it automatically. Call it directly only if you are testing a deposit or building a custom rail integration.

**Request**
```json
{
  "userId":       "cmqbeh9qd0000h2yj0ay3369r",
  "currency":     "KES",
  "amount":       50000,
  "rail":         "mpesa",
  "railReference": "QHX7YDNZ8P"
}
```

`rail` values: `mpesa` | `bank_transfer` | `rtgs` | `sepa` | `faster_payments` | `ach` | `swift`

**Response 201**
```json
{
  "depositId":  "cmqbgz...",
  "trackingId": "dep_f1a2...",
  "status":     "PENDING_FIREBLOCKS",
  "flow":       "mpesa → B2BinPay on-ramp → Fireblocks vault → Ledger credit",
  "message":    "50000 KES received. User balance updated."
}
```

The deposit status progresses: `PROCESSING` → `PENDING_FIREBLOCKS` → `COMPLETED`. The final `COMPLETED` step happens when Fireblocks fires its webhook confirming USDT landed in the vault.

---

#### `POST /orchestrator/payout-rail/confirmed` — Rail confirmation

Called by Daraja / Choice Bank / Brainrock webhooks when fiat payout reaches the end user. Moves withdrawal status to `COMPLETED`. On failure, reverses the ledger debit.

**Request**
```json
{
  "trackingId":   "wdr_e8f9...",
  "railReference": "QHX7YDNZ8P",
  "status":       "SUCCESS"
}
```

`status`: `"SUCCESS"` | `"FAILED"`

**Response 200** `{ "received": true, "status": "SUCCESS" }`

---

### 7.7 Withdrawals

Lower-level withdrawal endpoint (no Kafka validation). Use `/orchestrator/withdraw` instead for new integrations.

#### `POST /withdrawals`

```json
{
  "userId":      "cmqbeh9qd0000h2yj0ay3369r",
  "currency":    "GBP",
  "amount":      500,
  "bankAccount": "12345678",
  "bankName":    "Barclays UK",
  "note":        "rent"
}
```

#### `GET /withdrawals/:id` — Get withdrawal record

---

### 7.8 Deposits

Lower-level deposit endpoint. Use `/orchestrator/payout-rail/fiat-arrived` instead.

#### `POST /deposits/bank`

```json
{
  "userId":    "cmqbeh9qd0000h2yj0ay3369r",
  "currency":  "GBP",
  "amount":    1000,
  "bankName":  "HSBC UK",
  "reference": "FINCRUISE-REF-001"
}
```

#### `GET /deposits/:id` — Get deposit record

---

### 7.9 Simulate

Visual step-by-step simulation of settlement flows. No real money moves — used for demos, UI, and testing.

#### `GET /simulate/transfer?from=GBP&to=KES&amount=500`

Returns an array of steps showing the full settlement layer-by-layer.

**Response 200**
```json
{
  "steps": [
    {
      "step": 1, "total": 10,
      "layer": "AXLINK FX",
      "action": "JIT RFQ Broadcast — LPs race simultaneously",
      "detail": "Broadcasting to 2 LPs: B2BinPay, AxLink Internal. Best rate wins.",
      "duration": 45,
      "money": [{ "label": "Rate request", "amount": "500", "currency": "GBP", "direction": "info" }],
      "status": "done"
    }
  ]
}
```

Layers: `AXLINK FX` | `LEDGER` | `B2BINPAY` | `FIREBLOCKS` | `ORCHESTRATOR` | `BRAINROCK` | `CHOICE BANK` | `DARAJA` | `COMPLETE`

#### `GET /simulate/deposit?currency=NGN&amount=100000&rail=bank_transfer`
#### `GET /simulate/withdraw?currency=KES&amount=5000&rail=mpesa`

Same shape as simulate/transfer.

---

## 8. Webhooks — Inbound

These endpoints receive callbacks from external providers. Register them in each provider's dashboard.

All webhook endpoints respond `200 { "received": true }` immediately, even on soft errors, to prevent retries for business logic failures.

---

### 8.1 B2BinPay

**URL:** `POST /api/webhooks/b2binpay`
**Header:** `X-Callback-Signature: <HMAC-SHA256 of raw body using B2BINPAY_CALLBACK_SECRET>`

Receives transfer status updates for every on-ramp and off-ramp operation.

```json
{
  "data": {
    "id": "b2b_transfer_id",
    "attributes": {
      "status": 4,
      "amount": "127.06",
      "txid": "solana_tx_hash",
      "tracking_id": "onramp_p2p_...",
      "confirmations": 1
    }
  }
}
```

**Status codes:** `1` pending · `2` processing · `3` confirming · `4` completed · `5` failed · `6` cancelled

> Currently logs and returns `received: true`. Hook in your persistence logic here if you need real-time status updates stored to the database.

---

### 8.2 Fireblocks

**URL:** `POST /api/webhooks/fireblocks`
**Header:** `fireblocks-signature: <RSA signature>`
**Verification:** RSA signature using `FIREBLOCKS_WEBHOOK_PUBLIC_KEY`

When a USDT transfer **completes** and the destination is a known user vault, the handler automatically credits the user's fiat ledger balance.

```json
{
  "type": "TRANSACTION_STATUS_UPDATED",
  "data": {
    "id": "fb_tx_id",
    "status": "COMPLETED",
    "assetId": "USDT_SOL",
    "amount": 127.06,
    "txHash": "solana_hash",
    "externalTxId": "dep_f1a2...",
    "destination": { "id": "vault_alice_001", "name": "fincruise_alice" }
  }
}
```

**Trigger:** `status == COMPLETED` + `assetId starts with USDT` + destination vault belongs to a user → `credit(userId, currency, amount)` + marks deposit `COMPLETED`.

---

### 8.3 Brainrock — Payments

**URL:** `POST /api/webhooks/brainrock`
**Header:** `X-Brainrock-Signature: <HMAC-SHA256>`

| Event | Action |
|---|---|
| `payment.received` | Fiat arrived in user's virtual IBAN → triggers full deposit flow |
| `payment.sent` | Outbound fiat confirmed → marks withdrawal `COMPLETED` |
| `payment.failed` | Outbound failed → reverses ledger debit, marks `REVERSED` |

```json
{
  "type": "payment.received",
  "data": {
    "accountId": "brainrock_account_id",
    "paymentId": "brainrock_payment_id",
    "amount": 500,
    "currency": "GBP",
    "senderName": "John Smith",
    "reference": "FINCRUISE-REF-001"
  }
}
```

---

### 8.4 Brainrock — Card Authorization (real-time)

**URL:** `POST /api/webhooks/brainrock/card/authorize`
**Header:** `X-Brainrock-Signature: <HMAC-SHA256>`

⚠️ **Critical path — must respond in < 100ms.** Visa/Mastercard will decline if this times out.

Brainrock sends this the moment a user taps or swipes their card. AxLink checks balance, debits immediately, and returns the decision.

**Request from Brainrock:**
```json
{
  "authorization_id": "auth_brainrock_xyz",
  "card_id":          "card_brainrock_abc",
  "amount":           50.00,
  "currency":         "GBP",
  "merchant_name":    "Pret A Manger",
  "merchant_category": "restaurants"
}
```

**Response — Approved:**
```json
{
  "authorization_id": "auth_brainrock_xyz",
  "decision":         "approved",
  "decline_reason":   null,
  "timestamp":        "2026-06-12T22:17:11.000Z"
}
```

**Response — Declined:**
```json
{
  "authorization_id": "auth_brainrock_xyz",
  "decision":         "declined",
  "decline_reason":   "Insufficient balance",
  "timestamp":        "2026-06-12T22:17:11.000Z"
}
```

**Decline reasons:** `"Insufficient balance"` · `"Card is frozen"` · `"Card is cancelled"` · `"Card not found"` · `"Internal error"`

**Cross-currency spend:** If the card's debit currency differs from the POS currency, AxLink converts automatically using the live AxLink FX rate. Example: KES card, GBP spend → AxLink converts GBP → KES and debits KES. The FX rate and converted amount are stored on the `CardAuthorization` record.

**Debit pattern:** Ledger is debited immediately on authorization (not on settlement). This prevents overdraft. If the merchant reverses, the amount is credited back.

---

### 8.5 Brainrock — Card Settlement & Reversal

#### `POST /api/webhooks/brainrock/card/settled`

Transaction cleared (typically T+1). Status-only update — ledger was already debited at authorization.

```json
{ "authorization_id": "auth_brainrock_xyz" }
```

#### `POST /api/webhooks/brainrock/card/reversed`

Merchant reversal, chargeback, or expired authorization. Ledger debit is refunded.

```json
{
  "authorization_id": "auth_brainrock_xyz",
  "reason":           "merchant_reversal"
}
```

---

### 8.6 Daraja (M-Pesa)

#### STK Push result: `POST /api/webhooks/daraja/stk`

Handles M-Pesa STK push (collect from user). On success, triggers the deposit flow.

#### B2C result: `POST /api/webhooks/daraja/b2c/result`

Handles B2C payout result. On success, marks withdrawal `COMPLETED`. On failure, triggers the rail confirmation reversal flow.

#### B2C timeout: `POST /api/webhooks/daraja/b2c/timeout`

Handles B2C timeout — the payout timed out waiting for M-Pesa. Triggers reversal.

---

### 8.7 Choice Bank

**URL:** `POST /api/webhooks/choicebank`

Handles payment confirmation for NGN / GHS / ZAR / UGX / TZS bank transfers.

```json
{
  "event":     "payment.confirmed",
  "reference": "wdr_e8f9...",
  "status":    "SUCCESS",
  "amount":    50000,
  "currency":  "NGN"
}
```

---

## 9. Error Responses

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | — | Missing or invalid request field |
| 401 | — | Invalid webhook signature |
| 403 | — | KYC not approved (card issuance) |
| 404 | — | Resource not found |
| 409 | — | Conflict (e.g. duplicate card) |
| 422 | `PAYMENT_REJECTED` | Kafka validator rejected the payment. Reason in `error` field. No ledger change occurred. |
| 500 | — | Internal server error |

All 422 errors mean the payment was **rejected before any money moved**. The reason is always human-readable. Examples:

```json
{ "error": "Insufficient balance: has 50.00 GBP, needs 100 GBP", "code": "PAYMENT_REJECTED" }
{ "error": "Sender KYC not approved (status: PENDING)", "code": "PAYMENT_REJECTED" }
{ "error": "Sender fake-user-id-000 not found", "code": "PAYMENT_REJECTED" }
{ "error": "Currency XYZ is not supported.", "code": "PAYMENT_REJECTED" }
{ "error": "Maximum amount for GBP is 250,000", "code": "PAYMENT_REJECTED" }
{ "error": "Rail 'invalid_rail' is not supported.", "code": "PAYMENT_REJECTED" }
{ "error": "destination is required (bankAccountNumber/mobileNumber/iban)", "code": "PAYMENT_REJECTED" }
```

---

## 10. Kafka Events

AxLink uses Kafka (or local EventEmitter in sandbox) for two purposes:

### Payment Validation (request-reply)

Every orchestrator handler publishes a `payment.validation.requested` event **before** touching the ledger. The validator consumer responds with `payment.validation.result`. If `approved: false`, a `PAYMENT_REJECTED` error is thrown.

| Topic | Direction | Payload |
|---|---|---|
| `fincruise.payment.validation.requested` | API → validator | `{ correlationId, type, payload, timestamp }` |
| `fincruise.payment.validation.result` | validator → API | `{ correlationId, approved, reason?, timestamp }` |

`type` values: `P2P_TRANSFER` | `DEPOSIT` | `WITHDRAWAL`

### Operational Events

| Topic | Trigger | Payload |
|---|---|---|
| `fincruise.payment.settled` | AxLink Fireblocks LP stepped in as fallback (external LPs failed) | `{ event: 'rfq.axlink_fireblocks_fallback', pair, fromAmount, failedLPs }` |
| `fincruise.payment.failed` | Buffer EMPTY or CRITICAL (if buffer monitor is running) | `{ event: 'buffer.empty', severity: 'CRITICAL' }` |

**In sandbox:** No broker needed. Set `KAFKA_BROKERS=broker1:9092` in production to switch to real Kafka automatically.

---

## 11. Data Models

### User

| Field | Type | Description |
|---|---|---|
| `id` | cuid | Primary key |
| `email` | string unique | User email |
| `name` | string | Display name |
| `kycStatus` | string | `PENDING` \| `APPROVED` \| `REJECTED` |
| `vaultId` | string unique | Fireblocks vault ID |
| `usdtAddress` | string? | Fireblocks USDT on-chain address (set after vault creation) |
| `brainrockAccountId` | string? | Brainrock virtual account ID |
| `virtualIban` | string? | IBAN shown to user for deposits |
| `virtualIbanBic` | string? | BIC for the IBAN |
| `b2bWalletId` | string? | B2BinPay wallet ID |

### Account

One row per user per currency.

| Field | Type | Description |
|---|---|---|
| `userId` | string | FK → User |
| `currency` | string | ISO currency code |
| `balance` | decimal | Balance in local currency |
| `balanceUsd` | decimal | USD equivalent |

### Transfer

| Field | Type | Description |
|---|---|---|
| `trackingId` | string | `p2p_<uuid>` |
| `senderId` | string | FK → User |
| `receiverId` | string | FK → User |
| `fromCurrency` | string | |
| `toCurrency` | string | |
| `fromAmount` | decimal | What sender paid |
| `toAmount` | decimal | What receiver got |
| `usdtAmount` | decimal | USDT moved via Fireblocks |
| `fxRate` | decimal? | Rate applied |
| `status` | string | `PENDING` \| `PROCESSING` \| `COMPLETED` \| `FAILED` |
| `onrampId` | string? | B2BinPay on-ramp ID |
| `offrampId` | string? | B2BinPay off-ramp ID |
| `fbTxId` | string? | Fireblocks transaction ID |

### Card

| Field | Type | Description |
|---|---|---|
| `userId` | string | FK → User |
| `providerCardId` | string unique | Brainrock's card ID |
| `last4` | string | Last 4 digits |
| `brand` | string | `visa` \| `mastercard` |
| `cardType` | string | `virtual` \| `physical` |
| `currency` | string | Debit currency (user's primary currency) |
| `status` | string | `ACTIVE` \| `FROZEN` \| `CANCELLED` |

### CardAuthorization

| Field | Type | Description |
|---|---|---|
| `cardId` | string | FK → Card |
| `userId` | string | |
| `providerAuthId` | string unique | Brainrock's authorization ID |
| `amount` | decimal | Amount at POS |
| `spendCurrency` | string | Currency at POS |
| `debitAmount` | decimal | Amount debited from account |
| `debitCurrency` | string | User's account currency |
| `fxRate` | decimal? | Conversion rate if cross-currency |
| `merchantName` | string? | |
| `merchantCategory` | string? | |
| `status` | string | `PENDING` \| `APPROVED` \| `DECLINED` \| `SETTLED` \| `REVERSED` |
| `declineReason` | string? | Set if `DECLINED` |

---

*AxLink Settlement — AXSTRON*
*For internal use only. Do not share externally.*
