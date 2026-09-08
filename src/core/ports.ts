/**
 * Ports — the seam between the settlement engine and the outside world.
 *
 * ══════════════════════════════════════════════════════════════════════
 *  WHY
 *
 *  The engine used to import B2BinPay, Fireblocks and the Solana RPC
 *  directly. That makes the interesting behaviour untestable: you cannot
 *  exercise "the chain says this transaction failed" or "the converter
 *  timed out" without either real credentials or a mocking framework that
 *  only works inside a test runner.
 *
 *  Everything the engine reaches outside itself now goes through this
 *  registry. Live implementations are the default and nothing changes at
 *  runtime; the simulator swaps them for controllable stubs and drives the
 *  real engine — real ledger, real legs, real invariant checks — against
 *  partners it can make misbehave on demand.
 * ══════════════════════════════════════════════════════════════════════
 *
 * This is a seam, not an abstraction layer. It deliberately mirrors the live
 * signatures rather than inventing a neutral interface: a port that reshapes
 * its provider's API is a place for the two to drift apart silently.
 */

import * as b2binpay from '../providers/live/b2binpay';
import * as fireblocks from '../providers/live/fireblocks';
import * as solana from '../providers/live/solana';

// ── Port shapes ───────────────────────────────────────────────────────────────

export interface ConverterPort {
  createDeposit: typeof b2binpay.createDeposit;
  createPayout: typeof b2binpay.createPayout;
}

export interface CustodyPort {
  createTransfer: typeof fireblocks.createTransfer;
  getTransaction: typeof fireblocks.getTransaction;
  getVaultAssetBalance: typeof fireblocks.getVaultAssetBalance;
}

export interface ChainPort {
  awaitFinality: typeof solana.awaitFinality;
  getTransaction: typeof solana.getTransaction;
  getSignatureStatus: typeof solana.getSignatureStatus;
  getTokenBalanceRaw: typeof solana.getTokenBalanceRaw;
}

export interface SettlementPorts {
  converter: ConverterPort;
  custody: CustodyPort;
  chain: ChainPort;
}

// ── Live wiring ───────────────────────────────────────────────────────────────

const LIVE: SettlementPorts = {
  converter: {
    createDeposit: b2binpay.createDeposit,
    createPayout: b2binpay.createPayout,
  },
  custody: {
    createTransfer: fireblocks.createTransfer,
    getTransaction: fireblocks.getTransaction,
    getVaultAssetBalance: fireblocks.getVaultAssetBalance,
  },
  chain: {
    awaitFinality: solana.awaitFinality,
    getTransaction: solana.getTransaction,
    getSignatureStatus: solana.getSignatureStatus,
    getTokenBalanceRaw: solana.getTokenBalanceRaw,
  },
};

let active: SettlementPorts = LIVE;
let overridden = false;

/** Current ports. Call this per use — never cache the result across a swap. */
export function ports(): SettlementPorts {
  return active;
}

export function isOverridden(): boolean {
  return overridden;
}

export class PortOverrideRefused extends Error {
  readonly code = 'PORT_OVERRIDE_REFUSED';
  constructor(reason: string) {
    super(`Refusing to replace settlement ports: ${reason}`);
  }
}

/**
 * Replace one or more ports. Returns a function that restores what was there
 * before, so a caller cannot leave the process in a swapped state by forgetting
 * to clean up.
 *
 * Guarded twice, because a process that can be talked into stubbing its own
 * payment rails is worse than one that cannot be tested:
 *
 *   - never when NODE_ENV=production
 *   - never unless SIMULATOR_ENABLED=true is set deliberately
 *
 * Both are checked at call time rather than at import, so enabling the
 * simulator is an explicit act in the environment that runs it.
 */
export function useTestPorts(overrides: Partial<SettlementPorts>): () => void {
  if (process.env.NODE_ENV === 'production') {
    throw new PortOverrideRefused('NODE_ENV is production');
  }
  if (process.env.SIMULATOR_ENABLED !== 'true') {
    throw new PortOverrideRefused(
      'SIMULATOR_ENABLED is not "true". Set it only in an environment where stubbing ' +
      'the payment rails is intended — never one holding customer funds.',
    );
  }

  const previous = active;
  active = {
    converter: { ...previous.converter, ...overrides.converter },
    custody: { ...previous.custody, ...overrides.custody },
    chain: { ...previous.chain, ...overrides.chain },
  };
  overridden = true;

  let restored = false;
  return () => {
    if (restored) return;
    active = previous;
    overridden = previous !== LIVE;
    restored = true;
  };
}

/** Hard reset to the live providers. Used by the harness between scenarios. */
export function resetPorts(): void {
  active = LIVE;
  overridden = false;
}
