/**
 * Solana RPC client — settlement verification.
 *
 * ══════════════════════════════════════════════════════════════════════
 *  WHY THIS IS SEPARATE FROM FIREBLOCKS
 *
 *  Fireblocks signs and broadcasts. That makes it the custodian, not the
 *  source of truth. `createTransaction` returning an id means "Fireblocks
 *  accepted a request" — it does not mean a transfer happened, and until
 *  now the system treated the two as the same thing and marked transfers
 *  COMPLETED on that basis. `fireblocks.ts` compounds it by catching every
 *  error and returning a synthetic `tx_sandbox_…` id, so a production
 *  environment with a bad API key reports a stream of settled transfers
 *  that never touched a chain.
 *
 *  The entire argument for not using SWIFT is that settlement is
 *  independently verifiable. That argument requires asking a node we do not
 *  control whether the transaction is on the ledger, at `finalized`
 *  commitment, and recording the answer. That is what this module does.
 * ══════════════════════════════════════════════════════════════════════
 *
 * Read-only by design. This module never signs and never holds a key —
 * signing stays with the custodian. Its only job is to verify and to report.
 */

// ── Configuration ─────────────────────────────────────────────────────────────

import { ASSETS, DEFAULT_SETTLEMENT_SYMBOL } from '../../../core/assets/registry';

const RPC_URL = () => process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const RPC_TIMEOUT_MS = Number(process.env.SOLANA_RPC_TIMEOUT_MS ?? 10_000);

/**
 * SPL mints we can settle in.
 *
 * USDT is the settlement asset: it is what the Fireblocks integration moves
 * (`USDT_SOL`) and what the treasury actually holds. USDC is listed because
 * the choice of settlement asset is a business decision that can change —
 * notably, USDT is not authorised as an e-money token under MiCA, which is
 * live for the Lithuanian entity. Keeping both here means switching, or
 * running a second asset per region, is a config change rather than a
 * refactor. Nothing hard-codes a mint outside this table.
 */
export const SOLANA_MINTS: Record<string, { mint: string; decimals: number }> = {
  // Derived from the asset registry (F6) — the registry is the only place a mint is written.
  USDT: { mint: ASSETS.USDT_SOL.contract, decimals: ASSETS.USDT_SOL.decimals },
  USDC: { mint: ASSETS.USDC_SOL.contract, decimals: ASSETS.USDC_SOL.decimals },
};

/** The asset settlements are denominated in. Override per environment. */
export const SETTLEMENT_ASSET = DEFAULT_SETTLEMENT_SYMBOL as keyof typeof SOLANA_MINTS;

export type Commitment = 'processed' | 'confirmed' | 'finalized';

/** Only `finalized` is settlement. Anything less can still be rolled back. */
export const SETTLEMENT_COMMITMENT: Commitment = 'finalized';

// ── JSON-RPC plumbing ─────────────────────────────────────────────────────────

let requestId = 0;

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

  try {
    const res = await fetch(RPC_URL(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw Object.assign(new Error(`Solana RPC ${method} returned HTTP ${res.status}`), {
        statusCode: res.status,
      });
    }

    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) {
      throw Object.assign(new Error(`Solana RPC ${method}: ${body.error.message}`), {
        code: `SOLANA_RPC_${body.error.code}`,
      });
    }
    return body.result as T;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw Object.assign(new Error(`Solana RPC ${method} timed out after ${RPC_TIMEOUT_MS}ms`), {
        statusCode: 408,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Signature status ──────────────────────────────────────────────────────────

export interface SignatureStatus {
  signature: string;
  found: boolean;
  slot: number | null;
  confirmations: number | null;
  commitment: Commitment | null;
  /** Non-null when the transaction landed on chain but failed to execute. */
  err: string | null;
}

/**
 * Current status of a signature.
 *
 * `searchTransactionHistory` is on because a settlement we are confirming may
 * be older than the node's recent-status cache, and reporting "not found" for
 * a transaction that finalized twenty minutes ago would be worse than the
 * extra latency.
 */
export async function getSignatureStatus(signature: string): Promise<SignatureStatus> {
  const result = await rpc<{
    value: Array<{
      slot: number;
      confirmations: number | null;
      confirmationStatus: Commitment | null;
      err: unknown;
    } | null>;
  }>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);

  const s = result.value[0];
  if (!s) {
    return { signature, found: false, slot: null, confirmations: null, commitment: null, err: null };
  }

  return {
    signature,
    found: true,
    slot: s.slot,
    confirmations: s.confirmations,
    commitment: s.confirmationStatus,
    err: s.err ? JSON.stringify(s.err) : null,
  };
}

export interface ConfirmedTransaction {
  signature: string;
  slot: number;
  blockTime: Date | null;
  feeLamports: bigint;
  err: string | null;
  /** Net SPL token movements, derived from pre/post token balances. */
  tokenTransfers: Array<{
    mint: string;
    owner: string | null;
    decimals: number;
    /** Signed change in the smallest unit. Negative = sent, positive = received. */
    changeRaw: bigint;
  }>;
}

/** Full transaction detail at the given commitment. */
export async function getTransaction(
  signature: string,
  commitment: Commitment = SETTLEMENT_COMMITMENT,
): Promise<ConfirmedTransaction | null> {
  const tx = await rpc<{
    slot: number;
    blockTime: number | null;
    meta: {
      fee: number;
      err: unknown;
      preTokenBalances?: TokenBalance[];
      postTokenBalances?: TokenBalance[];
    } | null;
  } | null>('getTransaction', [
    signature,
    { commitment, maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' },
  ]);

  if (!tx || !tx.meta) return null;

  return {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime ? new Date(tx.blockTime * 1000) : null,
    feeLamports: BigInt(tx.meta.fee ?? 0),
    err: tx.meta.err ? JSON.stringify(tx.meta.err) : null,
    tokenTransfers: diffTokenBalances(tx.meta.preTokenBalances ?? [], tx.meta.postTokenBalances ?? []),
  };
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

/**
 * Net token movement per (account, mint).
 *
 * Derived from balance deltas rather than by parsing instructions: a transfer
 * can be wrapped in a CPI, routed through a router program, or batched, and
 * instruction parsing gets that wrong in ways balance deltas cannot.
 */
function diffTokenBalances(pre: TokenBalance[], post: TokenBalance[]): ConfirmedTransaction['tokenTransfers'] {
  const key = (b: TokenBalance) => `${b.accountIndex}:${b.mint}`;
  const preMap = new Map(pre.map(b => [key(b), b]));
  const seen = new Set<string>();
  const out: ConfirmedTransaction['tokenTransfers'] = [];

  for (const p of post) {
    const k = key(p);
    seen.add(k);
    const before = preMap.get(k);
    const change = BigInt(p.uiTokenAmount.amount) - BigInt(before?.uiTokenAmount.amount ?? '0');
    if (change !== 0n) {
      out.push({
        mint: p.mint,
        owner: p.owner ?? before?.owner ?? null,
        decimals: p.uiTokenAmount.decimals,
        changeRaw: change,
      });
    }
  }

  // Accounts that were emptied and closed appear in pre but not post.
  for (const [k, b] of preMap) {
    if (seen.has(k)) continue;
    const change = -BigInt(b.uiTokenAmount.amount);
    if (change !== 0n) {
      out.push({ mint: b.mint, owner: b.owner ?? null, decimals: b.uiTokenAmount.decimals, changeRaw: change });
    }
  }

  return out;
}

// ── Confirmation with backoff ─────────────────────────────────────────────────

export interface AwaitFinalityOptions {
  /** Give up after this long. Default 90s — Solana finality is ~13s typical. */
  timeoutMs?: number;
  /** Poll interval. Default 1.5s. */
  intervalMs?: number;
  commitment?: Commitment;
}

export class SettlementNotFinalError extends Error {
  readonly code = 'SETTLEMENT_NOT_FINAL';
  /**
   * `execution_error`: the transaction landed and failed — definite, never retry.
   * `timeout`: not seen or not yet finalized within the deadline — unknown, retry later.
   * Conflating the two turns a lagging RPC node into a permanent "rejected" deposit.
   */
  readonly reason: 'execution_error' | 'timeout';
  constructor(signature: string, detail: string, reason: 'execution_error' | 'timeout' = 'timeout') {
    super(`Solana settlement ${signature} is not final: ${detail}`);
    this.reason = reason;
  }
}

/**
 * Poll until the signature reaches the target commitment.
 *
 * Three distinct outcomes, and conflating them is how money gets lost:
 *
 *   resolves            — on chain, at commitment, no execution error
 *   SettlementNotFinal  — landed but FAILED on chain, or timed out
 *   throws (RPC)        — we could not reach a node, which says nothing about
 *                         the transaction and must NOT be treated as failure
 */
export async function awaitFinality(
  signature: string,
  options: AwaitFinalityOptions = {},
): Promise<SignatureStatus> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const intervalMs = options.intervalMs ?? 1_500;
  const target = options.commitment ?? SETTLEMENT_COMMITMENT;
  const deadline = Date.now() + timeoutMs;

  let last: SignatureStatus | null = null;

  while (Date.now() < deadline) {
    last = await getSignatureStatus(signature);

    if (last.found && last.err) {
      throw new SettlementNotFinalError(signature, `on-chain execution error ${last.err}`, 'execution_error');
    }
    if (last.found && last.commitment && commitmentReached(last.commitment, target)) {
      return last;
    }

    await sleep(intervalMs);
  }

  throw new SettlementNotFinalError(
    signature,
    last?.found
      ? `still at '${last.commitment ?? 'unknown'}' after ${timeoutMs}ms (wanted '${target}')`
      : `not seen by the RPC node after ${timeoutMs}ms`,
    'timeout',
  );
}

const ORDER: Record<Commitment, number> = { processed: 0, confirmed: 1, finalized: 2 };

export function commitmentReached(actual: Commitment, target: Commitment): boolean {
  return ORDER[actual] >= ORDER[target];
}

// ── Balances ──────────────────────────────────────────────────────────────────

/**
 * Total balance of an SPL mint held by an owner, in the smallest unit.
 *
 * Sums every token account the owner holds for that mint — an owner can have
 * more than one, and reading only the associated token account will quietly
 * under-report during reconciliation.
 */
export async function getTokenBalanceRaw(owner: string, mint: string): Promise<bigint> {
  const res = await rpc<{
    value: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }>;
  }>('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed' }]);

  return res.value.reduce(
    (sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount),
    0n,
  );
}

/** Convenience wrapper returning a decimal string, for reporting only. */
export async function getTokenBalance(owner: string, asset: keyof typeof SOLANA_MINTS): Promise<string> {
  const { mint, decimals } = SOLANA_MINTS[asset];
  const raw = await getTokenBalanceRaw(owner, mint);
  return formatUnits(raw, decimals);
}

// ── Health ────────────────────────────────────────────────────────────────────

export async function health(): Promise<{ ok: boolean; slot?: number; version?: string; error?: string }> {
  try {
    const [slot, version] = await Promise.all([
      rpc<number>('getSlot', [{ commitment: 'finalized' }]),
      rpc<{ 'solana-core': string }>('getVersion', []),
    ]);
    return { ok: true, slot, version: version['solana-core'] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Units ─────────────────────────────────────────────────────────────────────

export function formatUnits(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export function parseUnits(value: string, decimals: number): bigint {
  const [whole, frac = ''] = value.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
