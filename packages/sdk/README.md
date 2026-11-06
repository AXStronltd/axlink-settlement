# @axlink/sdk

TypeScript client for the **AxLink Settlement Network** Institution API.

Leg A: USDT / USDC on Solana via Fireblocks. Banks plug their own fiat leg on top.

## Install

```bash
npm install @axlink/sdk
```

Requires Node.js 18+. Works in Bun and Deno with the Node compat layer.

## Quick start

```ts
import { AxLinkClient } from '@axlink/sdk';

const axlink = new AxLinkClient({
  baseUrl: 'https://axlink-settlement.onrender.com',
  apiKey: process.env.AXLINK_API_KEY!,   // issued by AxLink ops
});

// --- Verify who you are ---
const me = await axlink.institutions.me();
// { institution: { id: '...', slug: 'galaxy-bank' }, environment: 'SANDBOX', scopes: [...] }

// --- Provision a wallet ---
const wallet = await axlink.wallets.create({ label: 'Main settlement wallet' });

// --- Get a deposit address ---
const addr = await axlink.wallets.depositAddress({ walletId: wallet.id });
console.log(addr.address);   // e.g. "7xKX..."  — share this with your sender

// --- Send a settlement ---
const transfer = await axlink.transfers.create({
  counterpartyId: 'cp_galaxybank_01',
  assetId:        'USDT_SOL',
  amount:         '10000',           // in token units, not cents
  externalRef:    'INV-2026-001',    // your idempotency key; safe to retry
  note:           'Invoice payment',
});
// { id: 'tr_...', status: 'PENDING', ... }

// --- Poll or use webhooks ---
const status = await axlink.transfers.get(transfer.id);
// { status: 'SETTLED', proof: { txHash: '...', network: 'solana-mainnet', slot: 300000000 } }
```

## Webhooks

Register an endpoint and verify every delivery:

```ts
import { verifyAxLinkWebhook, AxLinkWebhookVerificationError } from '@axlink/sdk';
import express from 'express';

// 1. Register your endpoint (do this once, store the secret)
const { endpoint, secret } = await axlink.webhooks.create({
  url: 'https://your-bank.example.com/webhooks/axlink',
  events: ['transfer.settled', 'deposit.settled', 'settlement.received'],
});
// Store `secret` in your vault — it's shown exactly once.

// 2. Verify every delivery
app.post('/webhooks/axlink', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const event = verifyAxLinkWebhook({
      body:      req.body,                                       // Buffer — keep it raw
      signature: req.headers['x-axlink-signature'] as string,
      secret:    process.env.AXLINK_WEBHOOK_SECRET!,
    });

    switch (event.type) {
      case 'transfer.settled':
        console.log('Settled:', event.data.transferId, event.data.txHash);
        break;
      case 'deposit.settled':
        console.log('Deposit confirmed:', event.data.depositId);
        break;
      case 'settlement.received':
        console.log('Incoming settlement:', event.data.settlementId, event.data.amount);
        break;
    }

    res.sendStatus(200);
  } catch (err) {
    if (err instanceof AxLinkWebhookVerificationError) {
      res.status(400).json({ error: err.code });
    } else {
      res.sendStatus(500);
    }
  }
});
```

## Error handling

```ts
import { AxLinkClient, AxLinkError } from '@axlink/sdk';

try {
  await axlink.transfers.create({ ... });
} catch (err) {
  if (err instanceof AxLinkError) {
    console.error(err.statusCode, err.code, err.message);
    // e.g. 400  COUNTERPARTY_NOT_APPROVED  "Counterparty cp_xyz has not been approved"
  }
}
```

## API surface

| Resource | Methods |
|---|---|
| `axlink.institutions` | `me()` |
| `axlink.assets` | `list()` |
| `axlink.wallets` | `create()`, `list()`, `get()`, `depositAddress()`, `setSettlementDefault()` |
| `axlink.deposits` | `announce()`, `list()`, `get()`, `cancel()` |
| `axlink.settlements` | `get()` |
| `axlink.counterparties` | `create()`, `list()`, `get()`, `disable()` |
| `axlink.transfers` | `create()`, `list()`, `get()`, `cancel()` |
| `axlink.ledger` | `entries()` |
| `axlink.webhooks` | `create()`, `list()`, `disable()`, `deliveries()` |

Webhook helper: `verifyAxLinkWebhook({ body, signature, secret })`

## Sandbox

Point `baseUrl` at the sandbox API and use a sandbox API key.  
In sandbox mode all Fireblocks calls are stubbed — no real USDT moves.

```ts
const axlink = new AxLinkClient({
  baseUrl: 'https://axlink-settlement.onrender.com',  // sandbox and prod share the same host; environment is per key
  apiKey: process.env.AXLINK_SANDBOX_API_KEY!,
});
```

---

Generated from `openapi/openapi.json` — Leg A, AxLink Settlement Network.
