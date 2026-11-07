# Liquidity leg — conversion through B2BinPay (plan for owner approval)

*Owner decision 2026-11-07: B2BinPay is AxLink's liquidity provider (LP) for conversion. Pairs: USDT ↔ USDC,
stablecoin → fiat (off-ramp), fiat → stablecoin (on-ramp). Stablecoins only (no BTC/ETH). This is the milestone
after Leg A; Leg A (USDC/USDT settlement on Solana via Fireblocks) is unchanged.*

## What a bank can do when this ships

| Conversion | Bank action | Outcome |
|---|---|---|
| USDT ↔ USDC | Quote, then convert from its AxLink wallet | Target asset credited in the same wallet |
| Off-ramp | Quote USDT/USDC → USD/EUR/…, then convert | Fiat paid to the bank's verified account |
| On-ramp | Quote fiat → USDT/USDC, then send fiat to the LP instructions | Stablecoin credited to its AxLink wallet |

## The rules (same discipline as Leg A)

1. **Quote first.** `POST /v1/conversions/quotes`: LP rate, LP fee and AxLink spread shown separately, fixed
   expiry. Quotes are persisted (today `quote.service.ts` keeps them in memory: lost on restart, not shared).
2. **Execute once.** `POST /v1/conversions` with the quote id and an `Idempotency-Key`; a retry never converts
   twice. The LP order carries our id as its client reference, and recovery looks it up before any retry.
3. **Reserve before moving.** The source amount is reserved in the double-entry ledger before the LP is called;
   released on failure, posted on fill. Exact decimals only (today `fx.service.ts` uses floating point; replaced).
4. **Credit on evidence.** Stablecoin credits only on LP confirmation and, where on-chain, a finalized signature;
   fiat payouts only on the LP's payout confirmation.
5. **Reconcile.** LP balances and orders against the ledger; mismatches go to the operator exception queue.
6. **Limits and approval.** Per-institution limits; above a threshold an operator approves.
7. **Signed callbacks.** B2BinPay callbacks verified (`B2BINPAY_CALLBACK_SECRET`) and deduplicated, like
   Fireblocks webhooks.
8. **Vendor behind the port.** B2BinPay stays in `packages/providers/liquidity/b2binpay` behind
   `liquidity.port.ts`; core and settlement never import it.

## Slices (each: branch, tests, fresh review, owner approval)

| # | Slice | Done when |
|---|---|---|
| 0 | Read-only connectivity: auth, wallets, rates for USDT/USDC | Sandbox credentials authenticate; wallet networks known |
| 1 | Persisted quotes + Decimal FX + `POST /v1/conversions/quotes` | Contract test; quote survives restart; expiry enforced |
| 2 | USDT ↔ USDC execution with ledger reservation | Sandbox end-to-end: quote → convert → credited once |
| 3 | Off-ramp: verified payout accounts per institution, payout execution | Sandbox payout confirmed; failure releases reservation |
| 4 | On-ramp: deposit instructions from the LP, credit on confirmation | Sandbox on-ramp credited once |
| 5 | Reconciliation + operator views + dashboard Convert screen | Clean reconciliation after all sandbox runs |

## Open questions for the owner

- **Network:** B2BinPay sandbox wallet `1662` and the payout address `0x9824…` are Ethereum. AxLink wallets are
  Solana. Either B2BinPay holds Solana USDT/USDC wallets, or conversions route through an EVM leg (a cross-chain
  step the blueprint places later). Slice 0 answers which.
- **Spread:** AxLink's margin on top of the LP rate, per pair.
- **Fiat currencies and payout rails** for the off-ramp (and who verifies bank accounts).
- **Licensing:** stablecoin ↔ fiat conversion for third parties is a regulated activity in most jurisdictions.

## Status

- 2026-11-07: sandbox credentials received; authentication **failed** (401, secret likely truncated). Credentials
  are stored outside the repository (`~/.axlink/b2binpay.sandbox.env`), never committed.
