/**
 * FinCruse Payment Validator
 *
 * Subscribes to `fincruise.payment.validation.requested` and publishes
 * `fincruise.payment.validation.result`. Runs before any ledger write.
 *
 * Rules:
 *  - User(s) must exist and be KYC_APPROVED
 *  - Sender ≠ receiver
 *  - Amount must be > 0 and within per-currency limits
 *  - Sufficient balance for transfers and withdrawals
 *  - Currency must be supported
 *  - Rail must be valid for deposits
 */

import { getEventBus, TOPICS, type ValidationRequestedEvent, type ValidationResultEvent } from './kafka.service';
import { prisma } from './ledger.service';

// ── Supported currencies & rails ──────────────────────────────────────────────

const SUPPORTED_CURRENCIES = new Set([
  'KES', 'NGN', 'GHS', 'ZAR', 'UGX', 'TZS',   // Africa
  'GBP', 'EUR', 'USD', 'USDT', 'CAD', 'AED',    // Global
]);

const SUPPORTED_RAILS = new Set([
  'mpesa', 'bank_transfer', 'rtgs', 'sepa', 'faster_payments', 'ach', 'swift',
]);

// Per-currency transfer limits (min / max in the local currency unit)
const LIMITS: Record<string, { min: number; max: number }> = {
  KES: { min: 10,    max: 10_000_000 },
  NGN: { min: 100,   max: 100_000_000 },
  GHS: { min: 1,     max: 500_000 },
  ZAR: { min: 5,     max: 1_000_000 },
  UGX: { min: 1_000, max: 100_000_000 },
  TZS: { min: 1_000, max: 100_000_000 },
  GBP: { min: 1,     max: 250_000 },
  EUR: { min: 1,     max: 250_000 },
  USD: { min: 1,     max: 250_000 },
};

const DEFAULT_LIMIT = { min: 0.01, max: 1_000_000 };

// ── Validation helpers ────────────────────────────────────────────────────────

async function fetchUser(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    include: { accounts: true },
  });
}

function checkCurrency(currency: string): string | null {
  if (!currency) return 'Currency is required';
  if (!SUPPORTED_CURRENCIES.has(currency.toUpperCase())) {
    return `Currency ${currency} is not supported. Supported: ${[...SUPPORTED_CURRENCIES].join(', ')}`;
  }
  return null;
}

function checkAmount(amount: number, currency: string): string | null {
  if (!amount || amount <= 0) return 'Amount must be greater than 0';
  if (!Number.isFinite(amount)) return 'Amount must be a finite number';
  const lim = LIMITS[currency.toUpperCase()] ?? DEFAULT_LIMIT;
  if (amount < lim.min) return `Minimum amount for ${currency} is ${lim.min}`;
  if (amount > lim.max) return `Maximum amount for ${currency} is ${lim.max.toLocaleString()}`;
  return null;
}

async function checkBalance(userId: string, currency: string, amount: number): Promise<string | null> {
  const account = await prisma.account.findUnique({
    where: { userId_currency: { userId, currency: currency.toUpperCase() } },
  });
  if (!account) return `No ${currency} account found for user ${userId}`;
  if (Number(account.balance) < amount) {
    return `Insufficient balance: has ${Number(account.balance).toFixed(2)} ${currency}, needs ${amount} ${currency}`;
  }
  return null;
}

// ── Validate by payment type ──────────────────────────────────────────────────

async function validate(event: ValidationRequestedEvent): Promise<{ approved: boolean; reason?: string }> {
  const { type, payload } = event;

  if (type === 'P2P_TRANSFER') {
    const { senderId, receiverId, fromCurrency, toCurrency, amount } = payload;

    if (!senderId)     return { approved: false, reason: 'senderId is required' };
    if (!receiverId)   return { approved: false, reason: 'receiverId is required' };
    if (!fromCurrency) return { approved: false, reason: 'fromCurrency is required' };
    if (!toCurrency)   return { approved: false, reason: 'toCurrency is required' };

    if (senderId === receiverId) return { approved: false, reason: 'Sender and receiver cannot be the same account' };

    const currErr = checkCurrency(fromCurrency) ?? checkCurrency(toCurrency);
    if (currErr) return { approved: false, reason: currErr };

    const amtErr = checkAmount(amount, fromCurrency);
    if (amtErr) return { approved: false, reason: amtErr };

    const [sender, receiver] = await Promise.all([fetchUser(senderId), fetchUser(receiverId)]);

    if (!sender)   return { approved: false, reason: `Sender ${senderId} not found` };
    if (!receiver) return { approved: false, reason: `Receiver ${receiverId} not found` };

    if (sender.kycStatus !== 'APPROVED') {
      return { approved: false, reason: `Sender KYC not approved (status: ${sender.kycStatus})` };
    }
    if (receiver.kycStatus !== 'APPROVED') {
      return { approved: false, reason: `Receiver KYC not approved (status: ${receiver.kycStatus})` };
    }

    const balErr = await checkBalance(senderId, fromCurrency, amount);
    if (balErr) return { approved: false, reason: balErr };

    return { approved: true };
  }

  if (type === 'DEPOSIT') {
    const { userId, currency, amount, rail } = payload;

    if (!userId)   return { approved: false, reason: 'userId is required' };
    if (!currency) return { approved: false, reason: 'currency is required' };
    if (!rail)     return { approved: false, reason: 'rail is required' };

    if (!SUPPORTED_RAILS.has(rail.toLowerCase())) {
      return { approved: false, reason: `Rail '${rail}' is not supported. Valid: ${[...SUPPORTED_RAILS].join(', ')}` };
    }

    const currErr = checkCurrency(currency);
    if (currErr) return { approved: false, reason: currErr };

    const amtErr = checkAmount(amount, currency);
    if (amtErr) return { approved: false, reason: amtErr };

    const user = await fetchUser(userId);
    if (!user) return { approved: false, reason: `User ${userId} not found` };
    if (user.kycStatus !== 'APPROVED') {
      return { approved: false, reason: `User KYC not approved (status: ${user.kycStatus}). Deposits blocked until KYC is complete.` };
    }

    return { approved: true };
  }

  if (type === 'WITHDRAWAL') {
    const { userId, currency, amount, destination } = payload;

    if (!userId)   return { approved: false, reason: 'userId is required' };
    if (!currency) return { approved: false, reason: 'currency is required' };

    if (!destination || typeof destination !== 'object' || Object.keys(destination).length === 0) {
      return { approved: false, reason: 'destination is required (bankAccountNumber/mobileNumber/iban)' };
    }

    const currErr = checkCurrency(currency);
    if (currErr) return { approved: false, reason: currErr };

    const amtErr = checkAmount(amount, currency);
    if (amtErr) return { approved: false, reason: amtErr };

    const user = await fetchUser(userId);
    if (!user) return { approved: false, reason: `User ${userId} not found` };
    if (user.kycStatus !== 'APPROVED') {
      return { approved: false, reason: `User KYC not approved (status: ${user.kycStatus}). Withdrawals blocked until KYC is complete.` };
    }

    const balErr = await checkBalance(userId, currency, amount);
    if (balErr) return { approved: false, reason: balErr };

    return { approved: true };
  }

  return { approved: false, reason: `Unknown payment type: ${type}` };
}

// ── Start consumer ────────────────────────────────────────────────────────────

export async function startPaymentValidator(): Promise<void> {
  const bus = await getEventBus();

  await bus.subscribe(TOPICS.VALIDATION_REQUESTED, async (raw) => {
    const event = raw as ValidationRequestedEvent;

    console.log(`[Validator] Validating ${event.type} (correlationId: ${event.correlationId})`);

    let result: { approved: boolean; reason?: string };
    try {
      result = await validate(event);
    } catch (err) {
      result = { approved: false, reason: `Validator internal error: ${err instanceof Error ? err.message : String(err)}` };
    }

    const response: ValidationResultEvent = {
      correlationId: event.correlationId,
      approved: result.approved,
      reason: result.reason,
      timestamp: new Date().toISOString(),
    };

    if (result.approved) {
      console.log(`[Validator] ✅ APPROVED ${event.type} (correlationId: ${event.correlationId})`);
    } else {
      console.warn(`[Validator] ❌ REJECTED ${event.type}: ${result.reason} (correlationId: ${event.correlationId})`);
    }

    await bus.publish(TOPICS.VALIDATION_RESULT, response);
  });

  console.log('[Validator] Payment validator consumer started');
}
