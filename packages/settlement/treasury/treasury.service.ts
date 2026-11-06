/**
 * AxLink Treasury — Corridor Float Rebalancer
 *
 * ════════════════════════════════════════════════════════════════════════
 *  This is the ONLY place in the codebase where USDT is converted to
 *  fiat by an external party (B2BinPay). Everything else is internal.
 *
 *  The corridor float accounts (Daraja, ChoiceBank, Brainrock) are
 *  pre-funded pools. Every user withdrawal draws from the pool.
 *  This service refills each pool when it drops below its low-water mark.
 *
 *  USDT stays in Fireblocks until this function runs.
 *  The payout partners (Daraja, ChoiceBank, Brainrock) see only:
 *    "AxLink deposited X KES/NGN/GBP into your account"
 *  They never see USDT, never see Solana.
 * ════════════════════════════════════════════════════════════════════════
 *
 * Corridors:
 *   KES / TZS / UGX  →  Daraja M-Pesa float (funded via Daraja API top-up)
 *   NGN / GHS / ZAR  →  ChoiceBank float     (funded via ChoiceBank API top-up)
 *   GBP / USD / EUR / CAD →  Brainrock treasury (funded via Brainrock inbound)
 */

import { randomUUID } from 'crypto';
import { converterCreatePayout as createPayout, converterPayoutFee as calculatePayoutFee, custodyTransfer as fbTransfer } from '../../providers/legacy';
import { audit } from '../../core/ledger/ledger.service';
import { toUSD, usdToUsdt } from '../fx-quotes/fx.service';

const USDT_ASSET        = process.env.FIREBLOCKS_USDT_ASSET          ?? 'USDT_SOL';
const TREASURY_VAULT    = process.env.FIREBLOCKS_TREASURY_VAULT       ?? '';
const B2B_WALLET_ID     = process.env.B2BINPAY_WALLET_ID              ?? '';
const BRAINROCK_TREASURY = process.env.BRAINROCK_TREASURY_ACCOUNT_ID  ?? '';
const CALLBACK          = `${process.env.API_BASE_URL}/webhooks/b2binpay`;

// ── Corridor config ───────────────────────────────────────────────────────────

interface CorridorConfig {
  currencies:     string[];
  provider:       'brainrock' | 'choicebank' | 'daraja';
  // The account AxLink sends fiat to when refilling this corridor.
  // B2BinPay converts USDT → fiat and sends here.
  treasuryAddress: string;
}

const CORRIDORS: CorridorConfig[] = [
  {
    currencies:      ['GBP', 'USD', 'EUR', 'CAD', 'AED'],
    provider:        'brainrock',
    treasuryAddress: BRAINROCK_TREASURY,
  },
  {
    currencies:      ['NGN', 'GHS', 'ZAR'],
    provider:        'choicebank',
    treasuryAddress: process.env.CHOICEBANK_TREASURY_ACCOUNT ?? '',
  },
  {
    currencies:      ['KES', 'TZS', 'UGX'],
    provider:        'daraja',
    treasuryAddress: process.env.DARAJA_FLOAT_ACCOUNT ?? '',
  },
];

function corridorFor(currency: string): CorridorConfig | undefined {
  return CORRIDORS.find(c => c.currencies.includes(currency.toUpperCase()));
}

// ── Public: refill a single corridor ─────────────────────────────────────────

export interface RebalanceParams {
  currency:  string;   // e.g. "KES"
  amount:    number;   // fiat amount to add to the corridor float
  operatorId: string;  // who triggered this (for audit trail)
}

export interface RebalanceResult {
  trackingId:  string;
  currency:    string;
  fiatAmount:  number;
  usdtAmount:  number;
  provider:    string;
  b2bPayoutId: string;
  fbTxId:      string | undefined;
}

export async function rebalanceCorridor(params: RebalanceParams): Promise<RebalanceResult> {
  const { currency, amount, operatorId } = params;
  const currN = currency.toUpperCase();

  const corridor = corridorFor(currN);
  if (!corridor) {
    throw new Error(`No corridor configured for ${currN}. Available: ${CORRIDORS.flatMap(c => c.currencies).join(', ')}`);
  }
  if (!corridor.treasuryAddress) {
    throw new Error(`Treasury address not configured for ${corridor.provider} corridor (${currN})`);
  }

  const trackingId  = `tsy_${randomUUID()}`;
  const usdAmount   = await toUSD(amount, currN);
  const usdtAmount  = usdToUsdt(usdAmount);

  // ── 1. Move USDT from AxLink treasury vault → B2BinPay wallet ───────────
  const fbTx = await fbTransfer({
    assetId:       USDT_ASSET,
    amount:        usdtAmount.toString(),
    sourceVaultId: TREASURY_VAULT,
    destVaultId:   B2B_WALLET_ID,             // B2BinPay's Fireblocks vault (AxLink-controlled)
    note:          `Treasury rebalance ${trackingId} — ${amount} ${currN} float`,
    externalTxId:  trackingId,
  });

  await audit('TreasuryRebalance', trackingId, 'FIREBLOCKS_SENT_TO_B2BINPAY', {
    usdtAmount, from: TREASURY_VAULT, to: B2B_WALLET_ID,
    fbTxId: fbTx?.id, operatorId,
    note: 'USDT handed to B2BinPay for conversion — still AxLink-controlled',
  });

  // ── 2. B2BinPay converts USDT → fiat, sends to AxLink corridor treasury ─
  // This is the ONLY time an external party (B2BinPay) touches USDT.
  // B2BinPay sends fiat to AxLink's treasury account for this corridor.
  // Daraja/ChoiceBank/Brainrock receive: "AxLink deposited X fiat" — no USDT.
  const estimate = await calculatePayoutFee({
    walletId:   B2B_WALLET_ID,
    address:    corridor.treasuryAddress,
    amount:     amount.toString(),
    currencyId: currN,
  });

  const b2bPayout = await createPayout({
    walletId:       B2B_WALLET_ID,
    currencyId:     currN,
    address:        corridor.treasuryAddress,
    amount:         amount.toString(),
    feeAmount:      estimate.fee.medium,
    trackingId:     `b2b_tsy_${trackingId}`,
    callbackUrl:    `${CALLBACK}?type=treasury&trackingId=${trackingId}`,
    idempotencyKey: randomUUID(),
    label:          `AxLink corridor float top-up: ${amount} ${currN} via ${corridor.provider}`,
  });

  await audit('TreasuryRebalance', trackingId, 'B2BINPAY_CONVERTING', {
    payoutId: b2bPayout.id,
    from: `${usdtAmount} USDT`,
    to:   `${amount} ${currN}`,
    provider: corridor.provider,
    destination: corridor.treasuryAddress,
    note: 'B2BinPay delivers fiat to AxLink corridor account — corridor sees fiat only',
  });

  return {
    trackingId,
    currency:    currN,
    fiatAmount:  amount,
    usdtAmount,
    provider:    corridor.provider,
    b2bPayoutId: b2bPayout.id,
    fbTxId:      fbTx?.id as string | undefined,
  };
}

// ── Public: get corridor status ───────────────────────────────────────────────

export function listCorridors() {
  return CORRIDORS.map(c => ({
    provider:   c.provider,
    currencies: c.currencies,
    configured: Boolean(c.treasuryAddress),
  }));
}
