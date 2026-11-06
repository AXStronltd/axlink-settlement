/**
 * Deposit Service — user-initiated Add Funds flow
 *
 * Three payment methods are supported for fiat entry:
 *   apple_pay     — Brainrock JS SDK, Apple Pay sheet on device
 *   google_pay    — Brainrock JS SDK, Google Pay sheet on device
 *   open_banking  — PSD2 redirect: user authorises at their bank, fiat sent via Faster Payments / SEPA
 *
 * In all three cases the money lands in AxLink's Brainrock SEGREGATED account
 * (ring-fenced from AxLink operating funds — regulatory requirement).
 * Brainrock fires payment.received webhook → handleFiatArrived → B2BinPay converts fiat→USDT
 * → Fireblocks sends USDT to user vault → ledger credits user in their local currency.
 *
 * NO crypto is ever visible to the user. They put in GBP, they see GBP credited.
 */

import { randomUUID }         from 'crypto';
import { prisma }             from '../../core/ledger/ledger.service';
import { toUSD, usdToUsdt }   from '../fx-quotes/fx.service';
import { brainrockCreatePaymentSession as createPaymentSession, type BrainrockDepositMethod as DepositMethod } from '../../providers/legacy';

// Currencies Brainrock supports for user-initiated deposits
const BRAINROCK_DEPOSIT_CURRENCIES = new Set(['GBP', 'EUR', 'USD', 'CAD', 'AED', 'CHF']);

// Methods available per currency
const METHOD_AVAILABILITY: Record<string, DepositMethod[]> = {
  GBP: ['open_banking', 'apple_pay', 'google_pay'],
  EUR: ['open_banking', 'apple_pay', 'google_pay'],
  USD: ['apple_pay', 'google_pay'],
  CAD: ['open_banking', 'apple_pay', 'google_pay'],
  AED: ['apple_pay', 'google_pay'],
  CHF: ['open_banking', 'apple_pay', 'google_pay'],
};

export function getAvailableMethods(currency: string): DepositMethod[] {
  return METHOD_AVAILABILITY[currency.toUpperCase()] ?? [];
}

export async function initiateDeposit(params: {
  userId:   string;
  currency: string;
  amount:   number;
  method:   DepositMethod;
}) {
  const { userId, currency, amount, method } = params;
  const curr = currency.toUpperCase();

  if (!BRAINROCK_DEPOSIT_CURRENCIES.has(curr)) {
    throw Object.assign(
      new Error(`${curr} deposits via ${method} are not available. Supported: ${[...BRAINROCK_DEPOSIT_CURRENCIES].join(', ')}`),
      { code: 'UNSUPPORTED_CURRENCY', statusCode: 422 },
    );
  }

  const available = getAvailableMethods(curr);
  if (!available.includes(method)) {
    throw Object.assign(
      new Error(`${method} is not available for ${curr}. Available: ${available.join(', ')}`),
      { code: 'UNSUPPORTED_METHOD', statusCode: 422 },
    );
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw Object.assign(new Error(`User ${userId} not found`), { code: 'NOT_FOUND', statusCode: 404 });

  const trackingId = `dep_${randomUUID()}`;
  const usdAmount  = await toUSD(amount, curr);
  const usdtAmount = usdToUsdt(usdAmount);

  // Create deposit record in AWAITING_PAYMENT state — updated when webhook fires
  const deposit = await prisma.bankDeposit.create({
    data: {
      trackingId,
      userId,
      currency: curr,
      amount,
      usdAmount,
      usdtAmount,
      bankName: 'brainrock',
      method,
      status: 'AWAITING_PAYMENT',
    },
  });

  // Call Brainrock to create the payment session
  // Returns checkoutUrl (open_banking redirect) or clientToken (Apple/Google Pay SDK)
  const session = await createPaymentSession({
    userId,
    currency: curr,
    amount,
    method,
    trackingId,
  });

  // Store session ID and checkout URL so we can match the incoming webhook
  await prisma.bankDeposit.update({
    where: { id: deposit.id },
    data: {
      sessionId:   session.sessionId,
      checkoutUrl: session.checkoutUrl,
      reference:   session.sessionId,
    },
  });

  return {
    depositId:   deposit.id,
    trackingId,
    method,
    currency:    curr,
    amount,
    usdEquivalent: Number(usdAmount.toFixed(2)),
    status:      'AWAITING_PAYMENT',
    // Payment method specifics:
    checkoutUrl: session.checkoutUrl,      // Open Banking: redirect here
    clientToken: session.clientToken,      // Apple Pay / Google Pay: pass to JS SDK
    sessionId:   session.sessionId,
    expiresAt:   session.expiresAt,
    segregatedAccount: {
      note: 'Funds held in AxLink segregated account at Brainrock — ring-fenced from operational funds',
      provider: 'Brainrock',
    },
  };
}

export async function getDepositStatus(depositId: string, userId: string) {
  const deposit = await prisma.bankDeposit.findFirst({
    where: { id: depositId, userId },
    select: {
      id: true, trackingId: true, currency: true, amount: true,
      usdAmount: true, method: true, status: true,
      sessionId: true, checkoutUrl: true,
      onrampId: true, fbTxId: true,
      createdAt: true, updatedAt: true,
    },
  });

  if (!deposit) throw Object.assign(new Error('Deposit not found'), { code: 'NOT_FOUND', statusCode: 404 });

  const statusLabel: Record<string, string> = {
    AWAITING_PAYMENT: 'Waiting for payment to complete',
    PROCESSING:       'Payment received — converting to USDT internally',
    COMPLETED:        'Funds credited to your account',
    FAILED:           'Payment failed — no funds taken',
  };

  return {
    ...deposit,
    amount:    Number(deposit.amount),
    usdAmount: Number(deposit.usdAmount),
    statusLabel: statusLabel[deposit.status] ?? deposit.status,
    flow: buildFlowDescription(deposit.status, deposit.method ?? 'unknown'),
  };
}

export async function listUserDeposits(userId: string, limit = 20) {
  const deposits = await prisma.bankDeposit.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true, trackingId: true, currency: true, amount: true,
      method: true, status: true, createdAt: true,
    },
  });
  return deposits.map(d => ({ ...d, amount: Number(d.amount) }));
}

function buildFlowDescription(status: string, method: string): string {
  const methodLabel: Record<string, string> = {
    apple_pay:    'Apple Pay',
    google_pay:   'Google Pay',
    open_banking: 'Open Banking',
    bank_transfer: 'Bank Transfer',
  };
  const m = methodLabel[method] ?? method;
  switch (status) {
    case 'AWAITING_PAYMENT':
      return `${m} → AxLink segregated account (Brainrock) → awaiting confirmation`;
    case 'PROCESSING':
      return `${m} confirmed → B2BinPay converting fiat→USDT (internal) → Fireblocks vault`;
    case 'COMPLETED':
      return `${m} → Brainrock segregated account → B2BinPay (internal) → Fireblocks → ledger credited`;
    case 'FAILED':
      return `${m} payment failed or cancelled — ledger unchanged`;
    default:
      return `${m} → AxLink internal settlement`;
  }
}
