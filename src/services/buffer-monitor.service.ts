/**
 * FinCruse Buffer Monitor
 *
 * Periodic health check on the Fireblocks treasury buffer.
 * Emits Kafka alerts and triggers replenishment automatically.
 *
 * Schedule:
 *   - Every 60 s: check balance
 *   - LOW  → async replenishment (non-blocking)
 *   - CRITICAL → Kafka alert + ops notification + replenishment
 *   - EMPTY    → Kafka alert + payments blocked by buffer.service
 */

import { getBufferBalance, getBufferHealth, replenishBuffer, BUFFER_THRESHOLDS } from './buffer.service';
import { getEventBus, TOPICS } from './kafka.service';

const CHECK_INTERVAL_MS = Number(process.env.BUFFER_MONITOR_INTERVAL_MS ?? 60_000);

let _monitorHandle: ReturnType<typeof setInterval> | null = null;
let _lastHealth = 'OK';

async function runCheck(): Promise<void> {
  try {
    const balance = await getBufferBalance();
    const health  = getBufferHealth(balance);

    if (health !== _lastHealth) {
      console.log(`[BufferMonitor] Health changed: ${_lastHealth} → ${health} (balance: ${balance.toFixed(2)} USDT)`);
      _lastHealth = health;
    }

    const bus = await getEventBus();

    if (health === 'EMPTY') {
      console.error('[BufferMonitor] 🚨 BUFFER EMPTY — all payments are blocked');
      await bus.publish(TOPICS.PAYMENT_FAILED, {
        event: 'buffer.empty',
        balanceUsdt: balance,
        message: 'Treasury buffer is empty. All payments halted. Immediate replenishment required.',
        timestamp: new Date().toISOString(),
        severity: 'CRITICAL',
      });
      return;
    }

    if (health === 'CRITICAL') {
      console.warn(`[BufferMonitor] ⚠️  Buffer CRITICAL: ${balance.toFixed(2)} USDT (threshold: ${BUFFER_THRESHOLDS.CRITICAL})`);
      await bus.publish(TOPICS.PAYMENT_FAILED, {
        event: 'buffer.critical',
        balanceUsdt: balance,
        threshold: BUFFER_THRESHOLDS.CRITICAL,
        message: `Buffer critically low. Transfers above $${BUFFER_THRESHOLDS.MAX_SINGLE_CRITICAL.toLocaleString()} suspended.`,
        timestamp: new Date().toISOString(),
        severity: 'CRITICAL',
      });
      // Trigger emergency replenishment
      replenishBuffer(BUFFER_THRESHOLDS.TARGET).catch(err =>
        console.error('[BufferMonitor] Emergency replenishment failed:', err)
      );
      return;
    }

    if (health === 'LOW') {
      console.warn(`[BufferMonitor] Buffer LOW: ${balance.toFixed(2)} USDT — replenishing to target`);
      replenishBuffer(BUFFER_THRESHOLDS.TARGET - balance).catch(err =>
        console.error('[BufferMonitor] Replenishment failed:', err)
      );
    }

  } catch (err) {
    console.error('[BufferMonitor] Health check failed:', err);
  }
}

export function startBufferMonitor(): void {
  if (_monitorHandle) return;
  console.log(`[BufferMonitor] Started — checking every ${CHECK_INTERVAL_MS / 1000}s`);
  // Run immediately then on interval
  runCheck();
  _monitorHandle = setInterval(runCheck, CHECK_INTERVAL_MS);
}

export function stopBufferMonitor(): void {
  if (_monitorHandle) {
    clearInterval(_monitorHandle);
    _monitorHandle = null;
    console.log('[BufferMonitor] Stopped');
  }
}
