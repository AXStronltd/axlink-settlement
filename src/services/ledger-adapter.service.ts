// ── Ledger Adapter ─────────────────────────────────────────────────────────────
// Owns on-ramp / off-ramp execution toward B2BinPay (USD liquidity partner).
// Rate computation is handled by AxLink FX Engine (fx.service.ts) — not here.
// B2BinPay provides USD liquidity; it does NOT compute FX rates for us.
//
// JIT zero pre-funded: no corridor float, no pre-positioned treasury.

import { randomUUID } from 'crypto';
import { createDeposit, createPayout, calculatePayoutFee } from './b2binpay.service';
import { getRate } from './fx.service';

const WALLET_ID = process.env.B2BINPAY_WALLET_ID ?? '';
const CALLBACK  = `${process.env.API_BASE_URL ?? ''}/webhooks/b2binpay`;

// ── Rate query — AxLink FX Engine ────────────────────────────────────────────

export async function getBestLPRate(
  from: string,
  to: string,
): Promise<{ lpName: string; rate: { mid: number; bid: number; ask: number; spread: number; spreadPct: number; fetchedAt: number; source: string } }> {
  const mid = await getRate(from, to);
  const spread = mid * 0.002;
  return {
    lpName: 'AxLink',
    rate: { mid, bid: mid - spread, ask: mid + spread, spread: spread * 2, spreadPct: (spread * 2) / mid, fetchedAt: Date.now(), source: 'axlink' },
  };
}

// ── On-ramp: any fiat → USDT, deliver to Fireblocks address ─────────────────
// LP receives fiat, converts to USDT, pushes to the specified Fireblocks address.
// No treasury hop — USDT lands directly in the user's vault.

export interface OnRampResult {
  id: string;
  address?: string;   // LP-generated deposit address (if applicable)
}

export async function onRamp(params: {
  fromCurrency: string;
  usdtDestinationAddress: string;  // Fireblocks user vault address
  usdtAmount: number;
  trackingId: string;
  callbackUrl?: string;
  label?: string;
}): Promise<OnRampResult> {
  const cb = params.callbackUrl ?? CALLBACK;

  // Step 1: Create deposit address — LP monitors this for incoming fiat
  const deposit = await createDeposit({
    walletId: WALLET_ID,
    trackingId: params.trackingId,
    callbackUrl: cb,
    label: params.label ?? `FinCruse on-ramp ${params.fromCurrency}→USDT`,
  });

  // Step 2: LP converts and sends USDT directly to Fireblocks vault
  const payout = await createPayout({
    walletId:     WALLET_ID,
    currencyId:   'USDT_SOL',
    address:      params.usdtDestinationAddress,
    amount:       params.usdtAmount.toString(),
    feeAmount:    '0',                           // Solana is near-gasless
    trackingId:   `payout_${params.trackingId}`,
    callbackUrl:  `${cb}&step=fireblocks_credit`,
    idempotencyKey: randomUUID(),
    label:        `LP→Fireblocks ${params.usdtDestinationAddress}`,
  });

  return { id: payout.id, address: deposit.address };
}

// ── Off-ramp: USDT → any fiat, funds land in FinCruse's fiat treasury ────────
// Fiat treasury (Brainrock account) then routes to the payout rail (Brainrock /
// Choice Bank / Daraja). The orchestrator calls deliverFiat() separately.

export interface OffRampResult {
  id: string;
}

export async function offRamp(params: {
  toCurrency: string;
  toAmount: number;
  fiatDestinationAddress: string;  // Brainrock treasury or direct address
  trackingId: string;
  callbackUrl?: string;
  idempotencyKey?: string;
  label?: string;
}): Promise<OffRampResult> {
  const cb = params.callbackUrl ?? CALLBACK;

  const fee = await calculatePayoutFee({
    walletId:   WALLET_ID,
    address:    params.fiatDestinationAddress,
    amount:     params.toAmount.toString(),
    currencyId: params.toCurrency,
  });

  const payout = await createPayout({
    walletId:       WALLET_ID,
    currencyId:     params.toCurrency,
    address:        params.fiatDestinationAddress,
    amount:         params.toAmount.toString(),
    feeAmount:      fee.fee.medium,
    trackingId:     params.trackingId,
    callbackUrl:    cb,
    idempotencyKey: params.idempotencyKey ?? randomUUID(),
    label:          params.label ?? `FinCruse off-ramp USDT→${params.toCurrency}`,
  });

  return { id: payout.id };
}
