/**
 * Stub screening provider — sandbox only. Answers CLEAR for every address except those listed in
 * SCREENING_DENYLIST (comma-separated, "address" or "address:REVIEW"), which lets tests and demos
 * exercise the REVIEW and BLOCKED paths. Never CLEARs silently in production: `configured()` is
 * false, and the counterparty service refuses unscreened external addresses there.
 */
import type { ScreeningProvider, ScreeningResult } from '../../ports/screening.port';

function denylist(): Map<string, 'REVIEW' | 'BLOCKED'> {
  const m = new Map<string, 'REVIEW' | 'BLOCKED'>();
  for (const raw of (process.env.SCREENING_DENYLIST ?? '').split(',')) {
    const [addr, verdict] = raw.trim().split(':');
    if (addr) m.set(addr, verdict === 'REVIEW' ? 'REVIEW' : 'BLOCKED');
  }
  return m;
}

export const stubScreeningProvider: ScreeningProvider = {
  id: 'screening-stub',
  configured: () => false,
  async screenAddress(address): Promise<ScreeningResult> {
    const v = denylist().get(address);
    return { provider: 'screening-stub', verdict: v ?? 'CLEAR', risk: v === 'BLOCKED' ? 100 : v === 'REVIEW' ? 60 : 0, reasons: v ? [`listed in SCREENING_DENYLIST as ${v}`] : ['sandbox stub: no screening provider configured'], at: new Date().toISOString() };
  },
  async health() { return { ok: true, detail: 'sandbox stub — no screening provider configured' }; },
};
