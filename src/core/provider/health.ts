/**
 * Provider health.
 *
 * ══════════════════════════════════════════════════════════════════════
 *  WHY FOUR STATES AND NOT A BOOLEAN
 *
 *  Every provider in this repo returns a shaped stub when its credentials are
 *  absent, so the service boots and every corridor runs on an empty `.env`.
 *  That is deliberate and worth keeping — but it means "the call succeeded"
 *  and "the partner is reachable" are different facts, and a boolean cannot
 *  hold both.
 *
 *  Reported as one green light, an unconfigured provider looks identical to a
 *  working one. The dashboard says healthy; the partner has never been
 *  contacted. At 3am that is the difference between "the partner is down" and
 *  "we were never talking to them", and those have opposite responses.
 * ══════════════════════════════════════════════════════════════════════
 *
 *   HEALTHY       credentials present, partner answered
 *   UNHEALTHY     credentials present, partner did not answer or errored
 *   UNCONFIGURED  no credentials — nothing has been attempted
 *   STUB          credentials absent and the adapter is serving stub responses,
 *                 which is normal locally and an incident in production
 *
 * UNCONFIGURED and STUB are both "not really connected". They are separate
 * because the first is a provider nobody has set up yet and the second is one
 * actively answering requests with fabricated data.
 */

import { breakerState, type BreakerState } from './circuit-breaker';
import { providerHealth as attemptHistory } from './attempt.service';

export type HealthState = 'HEALTHY' | 'UNHEALTHY' | 'UNCONFIGURED' | 'STUB';

/** What an adapter reports about itself. The adapter alone knows if it is configured. */
export interface AdapterHealth {
  state: HealthState;
  /** True only when a real request reached the partner. */
  reachable: boolean;
  latencyMs?: number;
  detail?: string;
}

export interface ProviderHealthReport extends AdapterHealth {
  providerId: string;
  checkedAt: string;
  /** Independent of the health probe: the breaker reflects real traffic. */
  breaker: BreakerState;
  /** Observed behaviour over the recent window, from the attempt log. */
  recent?: {
    attempts: number;
    moneyOperations: number;
    successRate: number | null;
    avgLatencyMs: number | null;
  };
}

/** A provider that can be asked whether it is reachable. Optional by design. */
export interface HealthReporting {
  readonly id: string;
  healthCheck?(): Promise<AdapterHealth>;
}

/**
 * A provider that declares no `healthCheck` is not assumed healthy.
 *
 * Assuming health for anything that has not answered is how a dashboard ends
 * up green while money is failing. Absent a probe, the honest report is that
 * we do not know, so this returns UNCONFIGURED rather than HEALTHY.
 */
export const UNKNOWN: AdapterHealth = {
  state: 'UNCONFIGURED',
  reachable: false,
  detail: 'Provider does not implement healthCheck()',
};

/**
 * Health for one provider: what it says about itself, plus what its traffic
 * says about it.
 *
 * A probe can succeed while real payouts fail — a reachable API is not a
 * working corridor — so the breaker state and the recent success rate travel
 * alongside the probe rather than being folded into it.
 */
export async function checkProvider(
  provider: HealthReporting,
  history?: Awaited<ReturnType<typeof attemptHistory>>,
): Promise<ProviderHealthReport> {
  const started = Date.now();

  let adapter: AdapterHealth;
  if (!provider.healthCheck) {
    adapter = UNKNOWN;
  } else {
    try {
      adapter = await provider.healthCheck();
    } catch (err) {
      // A probe that throws is a partner that did not answer. That is a
      // health result, not an error to propagate — one unreachable provider
      // must not fail the health report for all of them.
      adapter = {
        state: 'UNHEALTHY',
        reachable: false,
        latencyMs: Date.now() - started,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const recent = history?.find(h => h.providerId === provider.id);

  return {
    providerId: provider.id,
    ...adapter,
    checkedAt: new Date().toISOString(),
    breaker: breakerState(provider.id),
    ...(recent
      ? {
          recent: {
            attempts: recent.attempts,
            moneyOperations: recent.moneyOperations,
            successRate: recent.successRate,
            avgLatencyMs: recent.avgLatencyMs,
          },
        }
      : {}),
  };
}

/**
 * Health for every provider, probed concurrently.
 *
 * The attempt history is read once and shared rather than queried per
 * provider — it is one grouped query over a table that grows with every
 * payment.
 */
export async function checkAll(
  providers: HealthReporting[],
  windowHours = 24,
): Promise<ProviderHealthReport[]> {
  const history = await attemptHistory(windowHours).catch(() => undefined);
  return Promise.all(providers.map(p => checkProvider(p, history)));
}

/**
 * Whether a report should be treated as connected to a real partner.
 *
 * Deliberately not `state !== 'UNHEALTHY'`: STUB and UNCONFIGURED are not
 * failures, but they are not connectivity either, and calling them healthy is
 * the exact mistake this module exists to prevent.
 */
export function isLive(report: ProviderHealthReport): boolean {
  return report.state === 'HEALTHY' && report.reachable;
}
