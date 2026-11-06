/**
 * Screening port (Step 2, slice 7): is this external address one we may pay?
 *
 * AxLink does not decide sanctions exposure itself; a screening provider (Chainalysis, Elliptic,
 * TRM, …) does, behind this port. The verdict is recorded on the counterparty and drives its
 * status: CLEAR → the usual path, REVIEW → operator approval even in sandbox, BLOCKED → refused.
 * With no provider configured the stub answers CLEAR and says so; production refuses to register
 * unscreened external addresses unless SCREENING_OPTIONAL=true is set deliberately.
 */
import type { ProviderHealth } from './common';

export type ScreeningVerdict = 'CLEAR' | 'REVIEW' | 'BLOCKED';

export interface ScreeningResult {
  provider: string;
  verdict: ScreeningVerdict;
  /** 0 (no risk) … 100; provider-specific scale normalised by the adapter */
  risk: number | null;
  reasons: string[];
  at: string; // ISO
}

export interface ScreeningProvider {
  readonly id: string;
  configured(): boolean;
  screenAddress(address: string, chain: string): Promise<ScreeningResult>;
  health(): Promise<ProviderHealth>;
}
