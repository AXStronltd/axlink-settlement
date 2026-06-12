/**
 * FinCruse Fireblocks Treasury Buffer
 *
 * The buffer is a pre-funded USDT pool in the AxLink treasury vault.
 * Every settlement draws from it instantly (Solana vault-to-vault, <1 s).
 * B2BinPay replenishes it asynchronously — never in the user's critical path.
 *
 * Why this matters
 * ─────────────────
 * Without buffer:  Alice GBP → B2BinPay on-ramp (wait) → Fireblocks → B2BinPay off-ramp (wait) → Bob KES
 * With buffer:     Alice GBP debit (instant) → treasury USDT → Bob vault (instant) → B2BinPay async
 *
 * Thresholds (all in USDT)
 * ─────────────────────────
 *   BUFFER_HIGH     $2 000 000   stop topping up
 *   BUFFER_TARGET   $1 000 000   refill to here
 *   BUFFER_LOW       $200 000    trigger async buy
 *   BUFFER_CRITICAL   $50 000    block large transfers, alert ops
 */

import { randomUUID } from 'crypto';
import { createTransfer, getVaultAssetBalance } from './fireblocks.service';
import { createPayout } from './b2binpay.service';
import { getEventBus, TOPICS } from './kafka.service';

// ── Config ────────────────────────────────────────────────────────────────────

const TREASURY_VAULT  = process.env.FIREBLOCKS_TREASURY_VAULT ?? '';
const B2B_WALLET_ID   = process.env.B2BINPAY_WALLET_ID ?? '';
const USDT_ASSET      = process.env.FIREBLOCKS_USDT_ASSET ?? 'USDT_SOL';
const CALLBACK        = `${process.env.API_BASE_URL ?? 'http://localhost:4000/api'}/webhooks/b2binpay`;

export const BUFFER_THRESHOLDS = {
  HIGH:     Number(process.env.BUFFER_HIGH_USDT     ?? 2_000_000),
  TARGET:   Number(process.env.BUFFER_TARGET_USDT   ?? 1_000_000),
  LOW:      Number(process.env.BUFFER_LOW_USDT       ?? 200_000),
  CRITICAL: Number(process.env.BUFFER_CRITICAL_USDT ??  50_000),
  MAX_SINGLE_CRITICAL: Number(process.env.BUFFER_MAX_TX_CRITICAL ?? 10_000), // block single tx > this when CRITICAL
};

export type BufferHealth = 'OK' | 'LOW' | 'CRITICAL' | 'EMPTY';

export interface BufferStatus {
  balanceUsdt: number;
  health: BufferHealth;
  thresholds: typeof BUFFER_THRESHOLDS;
  replenishmentPending: boolean;
  lastCheckedAt: string;
}

// ── Sandbox in-memory balance ─────────────────────────────────────────────────
// When Fireblocks is not configured (sandbox mode), we maintain an in-memory
// float balance so the buffer logic is exercised identically.

const SANDBOX_INITIAL_USDT = Number(process.env.SANDBOX_BUFFER_USDT ?? 1_000_000);
let   _sandboxBalance       = SANDBOX_INITIAL_USDT;
let   _replenishmentPending = false;

function isSandbox(): boolean {
  const key  = process.env.FIREBLOCKS_API_KEY ?? '';
  const path = process.env.FIREBLOCKS_SECRET_KEY_PATH ?? '';
  return !(key && path && !key.startsWith('your_') && !key.startsWith('YOUR_'));
}

// ── Balance ───────────────────────────────────────────────────────────────────

export async function getBufferBalance(): Promise<number> {
  if (isSandbox()) return _sandboxBalance;

  try {
    const asset = await getVaultAssetBalance(TREASURY_VAULT, USDT_ASSET);
    return Number(asset?.available ?? asset?.total ?? 0);
  } catch (err) {
    console.warn('[Buffer] Could not read treasury balance — using last known:', err);
    return _sandboxBalance;
  }
}

export function getBufferHealth(balanceUsdt: number): BufferHealth {
  if (balanceUsdt <= 0)                              return 'EMPTY';
  if (balanceUsdt <= BUFFER_THRESHOLDS.CRITICAL)     return 'CRITICAL';
  if (balanceUsdt <= BUFFER_THRESHOLDS.LOW)          return 'LOW';
  return 'OK';
}

export async function getBufferStatus(): Promise<BufferStatus> {
  const balanceUsdt = await getBufferBalance();
  return {
    balanceUsdt,
    health: getBufferHealth(balanceUsdt),
    thresholds: BUFFER_THRESHOLDS,
    replenishmentPending: _replenishmentPending,
    lastCheckedAt: new Date().toISOString(),
  };
}

// ── Draw ──────────────────────────────────────────────────────────────────────
// Instantly moves USDT from treasury → destination vault.
// Throws if buffer is EMPTY or if CRITICAL and amount > MAX_SINGLE_CRITICAL.

export async function drawFromBuffer(params: {
  amountUsdt: number;
  destVaultId: string;
  trackingId: string;
  note?: string;
}): Promise<{ txId: string; drawnUsdt: number }> {
  const { amountUsdt, destVaultId, trackingId, note } = params;

  const balance = await getBufferBalance();
  const health  = getBufferHealth(balance);

  if (health === 'EMPTY') {
    throw new Error('[Buffer] Treasury buffer is empty — all payments halted. Replenishment required.');
  }

  if (health === 'CRITICAL' && amountUsdt > BUFFER_THRESHOLDS.MAX_SINGLE_CRITICAL) {
    throw new Error(
      `[Buffer] Buffer CRITICAL ($${balance.toLocaleString()} USDT). ` +
      `Transfers above $${BUFFER_THRESHOLDS.MAX_SINGLE_CRITICAL.toLocaleString()} are temporarily suspended. ` +
      `Small payments still processing.`
    );
  }

  if (amountUsdt > balance) {
    throw new Error(
      `[Buffer] Insufficient buffer: need ${amountUsdt.toFixed(2)} USDT, have ${balance.toFixed(2)} USDT`
    );
  }

  // Fireblocks vault-to-vault: treasury → receiver vault (Solana, <1 s)
  const tx = await createTransfer({
    assetId:       USDT_ASSET,
    amount:        amountUsdt.toFixed(6),
    sourceVaultId: TREASURY_VAULT,
    destVaultId,
    note:          note ?? `FinCruse buffer draw ${trackingId}`,
    externalTxId:  `buf_${trackingId}`,
  });

  // Update sandbox balance
  if (isSandbox()) _sandboxBalance -= amountUsdt;

  console.log(
    `[Buffer] Drew ${amountUsdt.toFixed(2)} USDT → vault ${destVaultId} ` +
    `(remaining: ${(balance - amountUsdt).toFixed(2)} USDT)`
  );

  // Trigger async replenishment if balance is getting low
  const remaining = balance - amountUsdt;
  if (remaining <= BUFFER_THRESHOLDS.LOW && !_replenishmentPending) {
    scheduleReplenishment(BUFFER_THRESHOLDS.TARGET - remaining).catch(err =>
      console.error('[Buffer] Replenishment scheduling failed:', err)
    );
  }

  return { txId: String(tx?.id ?? `sandbox_${trackingId}`), drawnUsdt: amountUsdt };
}

// ── Replenishment ─────────────────────────────────────────────────────────────
// Buys USDT from B2BinPay and sends to the treasury vault.
// Runs asynchronously — never blocks a user transaction.

export async function replenishBuffer(amountUsdt: number): Promise<{ orderId: string }> {
  if (_replenishmentPending) {
    console.log('[Buffer] Replenishment already in progress — skipping duplicate');
    return { orderId: 'pending' };
  }

  const needed = Math.min(amountUsdt, BUFFER_THRESHOLDS.HIGH - (await getBufferBalance()));
  if (needed <= 0) {
    console.log('[Buffer] Buffer already at or above HIGH threshold — no replenishment needed');
    return { orderId: 'not_needed' };
  }

  _replenishmentPending = true;
  console.log(`[Buffer] Replenishing ${needed.toFixed(2)} USDT into treasury vault ${TREASURY_VAULT}`);

  try {
    // B2BinPay creates a USDT payout to the treasury vault's on-chain address
    // In production this triggers: B2BinPay USD balance → USDT → Solana treasury address
    const orderId = `buf_replenish_${randomUUID()}`;

    if (!isSandbox()) {
      await createPayout({
        walletId:      B2B_WALLET_ID,
        currencyId:    'USDT_SOL',
        address:       process.env.FIREBLOCKS_TREASURY_USDT_ADDRESS ?? TREASURY_VAULT,
        amount:        needed.toFixed(6),
        feeAmount:     '0',
        trackingId:    orderId,
        callbackUrl:   `${CALLBACK}?action=buffer_replenishment`,
        idempotencyKey: randomUUID(),
        label:          `AxLink buffer replenishment — ${needed.toFixed(2)} USDT`,
      });
    } else {
      // Sandbox: simulate async delivery (2 s delay)
      setTimeout(() => {
        _sandboxBalance += needed;
        _replenishmentPending = false;
        console.log(`[Buffer] (sandbox) Replenishment complete — balance now ${_sandboxBalance.toFixed(2)} USDT`);
      }, 2_000);
      return { orderId };
    }

    await getEventBus().then(bus =>
      bus.publish(TOPICS.PAYMENT_SETTLED, {
        event: 'buffer.replenishment.requested',
        amountUsdt: needed,
        orderId,
        timestamp: new Date().toISOString(),
      })
    );

    return { orderId };

  } catch (err) {
    _replenishmentPending = false;
    console.error('[Buffer] Replenishment failed:', err);
    throw err;
  }
}

// Fire-and-forget replenishment helper used internally
async function scheduleReplenishment(amountUsdt: number): Promise<void> {
  try {
    await replenishBuffer(amountUsdt);
  } catch (err) {
    console.error('[Buffer] scheduleReplenishment failed:', err);
  }
}

// Called by B2BinPay webhook when replenishment USDT arrives at treasury
export function markReplenishmentComplete(amountUsdt: number): void {
  if (isSandbox()) _sandboxBalance += amountUsdt;
  _replenishmentPending = false;
  console.log(`[Buffer] Replenishment confirmed — added ${amountUsdt} USDT to treasury`);
}
