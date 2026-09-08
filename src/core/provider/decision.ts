/**
 * The record of a routing decision.
 *
 * Routing that returns only a winner cannot answer the question actually asked
 * during an incident: *why did this payment go to B when A also serves KES?*
 * Reconstructing that after the fact means re-deriving capability state that
 * has since changed — provider limits move, breakers open and close, a partner
 * gets disabled. The answer has to be captured at the moment of the decision or
 * it is gone.
 *
 * So every selection produces one of these: who won, what they matched, and
 * every provider that was considered and passed over, each with the specific
 * check that excluded it.
 */

import type { RejectionReason, ProviderOperation } from './capability';

export interface RejectedProvider {
  providerId: string;
  reason: RejectionReason | 'CIRCUIT_OPEN' | 'DISABLED' | 'QUOTE_FAILED';
  /** Human-readable specifics: "maximum is 500000 KES", "serves COLLECTION". */
  detail?: string;
}

export interface RoutingDecision {
  /** Ties this decision to the payment it routed, and to the attempt log. */
  correlationId: string;
  operation: ProviderOperation;
  currency: string;
  amount: number;

  /** Null when nothing could serve the request — `rejected` then says why. */
  selectedProviderId: string | null;

  /** Capability checks the winner passed, e.g. ['currency:KES', 'method:mobile_money']. */
  matched: string[];

  /**
   * Why this one rather than another. Populated when more than one provider
   * could have served the request — with a single candidate there is no
   * choice to explain.
   */
  selectionBasis?: string;

  /** Everything considered and passed over, with the check that excluded it. */
  rejected: RejectedProvider[];

  /** How long the decision took. Quoting is the expensive part: it is I/O. */
  latencyMs: number;

  decidedAt: string;
}

/** One line, for logs. The full object goes to the attempt record. */
export function summarise(d: RoutingDecision): string {
  const head = d.selectedProviderId
    ? `→ ${d.selectedProviderId} for ${d.amount} ${d.currency} (${d.operation})`
    : `→ NO ROUTE for ${d.amount} ${d.currency} (${d.operation})`;

  const why = d.selectionBasis ? ` · ${d.selectionBasis}` : '';
  const passed = d.rejected.length
    ? ` · passed over: ${d.rejected.map(r => `${r.providerId}(${r.reason})`).join(', ')}`
    : '';

  return `${head}${why}${passed} · ${d.latencyMs}ms`;
}

/**
 * The no-route case, as a decision rather than a bare throw.
 *
 * "No provider available" is the least useful thing routing can say. The
 * rejection list turns it into "Daraja does not cover NG, Choice Bank's
 * maximum is 500000, Brainrock is circuit-broken" — which is actionable, and
 * is usually one missing capability declaration rather than a real gap.
 */
export function noRouteError(decision: RoutingDecision): Error & { code: string; statusCode: number; decision: RoutingDecision } {
  const detail = decision.rejected.length
    ? decision.rejected.map(r => `${r.providerId}: ${r.reason}${r.detail ? ` (${r.detail})` : ''}`).join('; ')
    : 'no providers are registered for this operation';

  return Object.assign(
    new Error(
      `No provider can ${decision.operation} ${decision.amount} ${decision.currency}. ${detail}`,
    ),
    { code: 'NO_PROVIDER_ROUTE', statusCode: 422, decision },
  );
}
