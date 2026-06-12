// ── AxLink LP Registry — JIT RFQ Broadcast ───────────────────────────────────
// Holds all registered Liquidity Providers.
// On every cross-currency transfer, AxLink broadcasts a JIT RFQ to ALL capable LPs
// simultaneously. The LP returning the best rate for the client wins.
//
// Adding a new LP: implement ILiquidityProvider, call registerLP() in lp-bootstrap.ts.
// No other code changes needed — the RFQ system picks it up automatically.
//
// LP competition model:
//   RFQ broadcast → all LPs race → best toAmount wins → losing LPs don't execute
//   Zero cost to losing LPs. AxLink captures best rate for each transfer.

import type { ILiquidityProvider, LPRate, LPQuote } from './lp.interface';

const providers: ILiquidityProvider[] = [];

export function registerLP(lp: ILiquidityProvider): void {
  if (providers.find(p => p.id === lp.id)) return; // idempotent
  providers.push(lp);
  console.log(`[AxLink LP] Registered: ${lp.name} (${lp.id})`);
}

export function getRegisteredLPs(): Array<{ id: string; name: string }> {
  return providers.map(p => ({ id: p.id, name: p.name }));
}

// ── Indicative rate (non-binding) ────────────────────────────────────────────
// Used for display, pre-flight checks, simulator. Not used for execution.

export async function getBestRate(from: string, to: string): Promise<{ lp: ILiquidityProvider; rate: LPRate }> {
  const fromN = from.toUpperCase();
  const toN   = to.toUpperCase();
  const candidates = providers.filter(p => p.supportsRate(fromN, toN));
  if (candidates.length === 0) throw new Error(`No LP registered that supports ${fromN}:${toN}`);

  const settled = await Promise.allSettled(
    candidates.map(async lp => ({ lp, rate: await lp.getRate(fromN, toN) })),
  );
  const successful = settled
    .filter((r): r is PromiseFulfilledResult<{ lp: ILiquidityProvider; rate: LPRate }> => r.status === 'fulfilled')
    .map(r => r.value);

  if (successful.length === 0) throw new Error(`All LPs failed for ${fromN}:${toN}`);
  return successful.reduce((best, curr) => curr.rate.mid > best.rate.mid ? curr : best);
}

export async function getRate(from: string, to: string): Promise<LPRate> {
  const { rate } = await getBestRate(from, to);
  return rate;
}

// ── JIT RFQ Broadcast ────────────────────────────────────────────────────────
// Sends a binding RFQ to all capable LPs simultaneously.
// All LPs respond within RFQ_TIMEOUT_MS; the one with the highest toAmount wins.
// Losing LP quotes are never executed — they expire naturally.
//
// This is the function called by quote.service.ts for every cross-currency transfer.

const RFQ_TIMEOUT_MS = 600; // max ms to wait for all LP responses

export interface RFQResult {
  winner: ILiquidityProvider;
  quote: LPQuote;
  allResponses: Array<{ lp: string; toAmount: number; latencyMs: number; error?: string }>;
}

export async function broadcastRFQ(
  from: string,
  to: string,
  fromAmount: number,
): Promise<RFQResult> {
  const fromN = from.toUpperCase();
  const toN   = to.toUpperCase();
  const candidates = providers.filter(p => p.supportsRate(fromN, toN));

  if (candidates.length === 0) {
    throw new Error(`No LP registered that supports ${fromN}:${toN} — ensure lp-bootstrap.ts runs at startup`);
  }

  const deadline = Date.now() + RFQ_TIMEOUT_MS;
  const t0 = Date.now();

  // Race all LPs — collect results within timeout
  const settled = await Promise.allSettled(
    candidates.map(async lp => {
      const lpT0 = Date.now();
      const quote = await lp.requestQuote(fromN, toN, fromAmount);
      return { lp, quote, latencyMs: Date.now() - lpT0 };
    }),
  );

  const elapsed = Date.now() - t0;
  const successful = settled
    .filter((r): r is PromiseFulfilledResult<{ lp: ILiquidityProvider; quote: LPQuote; latencyMs: number }> =>
      r.status === 'fulfilled' && Date.now() < deadline,
    )
    .map(r => r.value);

  const allResponses = settled.map((r, i) =>
    r.status === 'fulfilled'
      ? { lp: r.value.lp.id, toAmount: r.value.quote.toAmount, latencyMs: r.value.latencyMs }
      : { lp: candidates[i].id, toAmount: 0, latencyMs: RFQ_TIMEOUT_MS, error: (r.reason as Error)?.message },
  );

  console.log(`[AxLink RFQ] ${fromN}→${toN} ${fromAmount}: ${candidates.length} LPs, ${successful.length} responded in ${elapsed}ms`);
  allResponses.forEach(r => console.log(`  [${r.lp}] toAmount=${r.toAmount} latency=${r.latencyMs}ms${r.error ? ' ERR:'+r.error : ''}`));

  if (successful.length === 0) {
    const errors = settled
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map(r => (r.reason instanceof Error ? r.reason.message : String(r.reason)))
      .join('; ');
    throw new Error(`All LPs failed for ${fromN}:${toN}: ${errors}`);
  }

  // Winner = LP offering the most toAmount (best rate for the client)
  const winner = successful.reduce((best, curr) =>
    curr.quote.toAmount > best.quote.toAmount ? curr : best,
  );

  console.log(`[AxLink RFQ] Winner: ${winner.lp.id} — ${winner.quote.toAmount} ${toN} @ rate ${winner.quote.rate.toFixed(6)}`);

  return { winner: winner.lp, quote: winner.quote, allResponses };
}
