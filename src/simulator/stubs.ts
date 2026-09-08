/**
 * Controllable stand-ins for the converter, the custodian and a Solana node.
 *
 * These are not mocks in the "returns a canned value" sense. They keep enough
 * state to behave like the real thing across a multi-leg settlement — a payout
 * requested twice with the same idempotency key returns the *same* payment, a
 * signature reaches `finalized` only after the configured number of polls, and
 * the chain reports the token movement that was actually asked for.
 *
 * That fidelity is the point. A stub that always succeeds immediately proves
 * only that the happy path compiles.
 *
 * Every failure the engine is supposed to survive is a switch on `Faults`.
 */

import { randomBytes } from 'crypto';
import type { ConverterPort, CustodyPort, ChainPort } from '../core/ports';
import {
  SOLANA_MINTS,
  SETTLEMENT_ASSET,
  SettlementNotFinalError,
  parseUnits,
  type Commitment,
  type SignatureStatus,
} from '../providers/live/solana';

// ── Fault injection ───────────────────────────────────────────────────────────

export interface Faults {
  /** RPC is unreachable. Distinct from "the transaction failed" — the engine must not confuse them. */
  chainUnreachable?: boolean;
  /** The transaction lands on chain and fails to execute. */
  chainExecutionError?: boolean;
  /** Polls before the signature reaches `finalized`. 0 = immediate. */
  finalityDelayPolls?: number;
  /** The chain moved a different amount than we intended — the proof must refuse. */
  chainAmountDrift?: number;
  /** The custodian accepts the request but never broadcasts. */
  custodyNeverBroadcasts?: boolean;
  /** The custodian errors on transfer. */
  custodyFails?: boolean;
  /** The converter errors. */
  converterFails?: boolean;
  /** The converter times out (408 — retryable, and NOT a confirmed failure). */
  converterTimesOut?: boolean;
}

// ── Call log ──────────────────────────────────────────────────────────────────

export interface StubCall {
  port: 'converter' | 'custody' | 'chain';
  method: string;
  key?: string;
  at: number;
}

/**
 * Shared state across the three stubs, so a settlement behaves coherently:
 * the custodian's transaction id maps to a signature the chain then knows about.
 */
export class StubWorld {
  faults: Faults = {};
  readonly calls: StubCall[] = [];

  /** custodyTxId → chain signature */
  private readonly broadcasts = new Map<string, string>();
  /** signature → { amountRaw, polls } */
  private readonly onchain = new Map<string, { amountRaw: bigint; polls: number; slot: number }>();
  /** idempotency key → payment id, so a repeated request returns the same payment */
  private readonly payments = new Map<string, string>();
  /** payment id → the amount requested, for assertions */
  readonly payouts = new Map<string, { amount: string; currency: string; address: string }>();

  private slot = 250_000_000;

  reset(): void {
    this.faults = {};
    this.calls.length = 0;
    this.broadcasts.clear();
    this.onchain.clear();
    this.payments.clear();
    this.payouts.clear();
  }

  record(port: StubCall['port'], method: string, key?: string): void {
    this.calls.push({ port, method, key, at: Date.now() });
  }

  callsTo(port: StubCall['port'], method?: string): StubCall[] {
    return this.calls.filter(c => c.port === port && (method ? c.method === method : true));
  }

  /** Deterministic-looking base58 signature. Long enough to pass eyeball checks. */
  newSignature(): string {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const bytes = randomBytes(88);
    return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
  }

  /** Register a broadcast so the chain stub can answer for it later. */
  broadcast(custodyTxId: string, amountDecimal: string): string {
    const signature = this.newSignature();
    const decimals = SOLANA_MINTS[SETTLEMENT_ASSET].decimals;
    const drift = this.faults.chainAmountDrift ?? 0;
    const effective = (Number(amountDecimal) + drift).toFixed(decimals);

    this.broadcasts.set(custodyTxId, signature);
    this.onchain.set(signature, {
      amountRaw: parseUnits(effective, decimals),
      polls: 0,
      slot: ++this.slot,
    });
    return signature;
  }

  signatureFor(custodyTxId: string): string | undefined {
    return this.broadcasts.get(custodyTxId);
  }

  onchainRecord(signature: string) {
    return this.onchain.get(signature);
  }

  /** Idempotent payment id — the same key always yields the same payment. */
  paymentFor(key: string, prefix: string): { id: string; repeated: boolean } {
    const existing = this.payments.get(key);
    if (existing) return { id: existing, repeated: true };
    const id = `${prefix}_${randomBytes(6).toString('hex')}`;
    this.payments.set(key, id);
    return { id, repeated: false };
  }
}

const timeout = (label: string) =>
  Object.assign(new Error(`${label} timed out`), { statusCode: 408, retryable: true });

// ── Converter ─────────────────────────────────────────────────────────────────

export function stubConverter(world: StubWorld): ConverterPort {
  return {
    async createDeposit(params) {
      world.record('converter', 'createDeposit', params.trackingId);
      if (world.faults.converterFails) throw Object.assign(new Error('converter rejected the deposit'), { statusCode: 502 });
      if (world.faults.converterTimesOut) throw timeout('converter createDeposit');

      const { id } = world.paymentFor(params.trackingId, 'dep');
      return { id, address: `stub-address-${id}` } as unknown as Awaited<
        ReturnType<ConverterPort['createDeposit']>
      >;
    },

    async createPayout(params) {
      world.record('converter', 'createPayout', params.idempotencyKey ?? params.trackingId);
      if (world.faults.converterFails) throw Object.assign(new Error('converter rejected the payout'), { statusCode: 502 });
      if (world.faults.converterTimesOut) throw timeout('converter createPayout');

      // Keyed on the idempotency key the engine supplies. A retried leg must
      // come back with the SAME payment id — that is the property the whole
      // resume design depends on, so the stub enforces it rather than assuming.
      const key = params.idempotencyKey ?? params.trackingId;
      const { id } = world.paymentFor(key, 'pay');
      world.payouts.set(id, { amount: params.amount, currency: params.currencyId, address: params.address });
      return { id, status: 1 } as unknown as Awaited<ReturnType<ConverterPort['createPayout']>>;
    },
  };
}

// ── Custody ───────────────────────────────────────────────────────────────────

export function stubCustody(world: StubWorld): CustodyPort {
  return {
    async createTransfer(params) {
      world.record('custody', 'createTransfer', params.externalTxId);
      if (world.faults.custodyFails) throw Object.assign(new Error('custodian rejected the transfer'), { statusCode: 502 });

      // externalTxId is the leg's deterministic key, so a resumed leg gets the
      // same custody transaction back rather than creating a second transfer.
      const { id } = world.paymentFor(params.externalTxId ?? params.amount, 'fbtx');
      if (!world.faults.custodyNeverBroadcasts) world.broadcast(id, params.amount);
      return { id, status: 'SUBMITTED', assetId: params.assetId, amount: params.amount } as Awaited<
        ReturnType<CustodyPort['createTransfer']>
      >;
    },

    async getTransaction(txId) {
      world.record('custody', 'getTransaction', txId);
      const signature = world.signatureFor(txId);
      // No signature yet is a normal intermediate state, not an error: the
      // custodian has accepted the request and has not broadcast.
      return { id: txId, status: signature ? 'COMPLETED' : 'BROADCASTING', txHash: signature } as Awaited<
        ReturnType<CustodyPort['getTransaction']>
      >;
    },

    async getVaultAssetBalance(vaultAccountId, assetId) {
      world.record('custody', 'getVaultAssetBalance', vaultAccountId);
      return { id: assetId, total: '0', available: '0' } as Awaited<
        ReturnType<CustodyPort['getVaultAssetBalance']>
      >;
    },
  };
}

// ── Chain ─────────────────────────────────────────────────────────────────────

export function stubChain(world: StubWorld): ChainPort {
  const unreachable = () =>
    Object.assign(new Error('Solana RPC unreachable'), { statusCode: 503, retryable: true });

  return {
    async getSignatureStatus(signature): Promise<SignatureStatus> {
      world.record('chain', 'getSignatureStatus', signature);
      if (world.faults.chainUnreachable) throw unreachable();

      const rec = world.onchainRecord(signature);
      if (!rec) {
        return { signature, found: false, slot: null, confirmations: null, commitment: null, err: null };
      }
      if (world.faults.chainExecutionError) {
        return { signature, found: true, slot: rec.slot, confirmations: 0, commitment: 'confirmed', err: '{"InstructionError":[0,{"Custom":1}]}' };
      }

      rec.polls += 1;
      const needed = world.faults.finalityDelayPolls ?? 0;
      const commitment: Commitment = rec.polls > needed ? 'finalized' : 'confirmed';
      return { signature, found: true, slot: rec.slot, confirmations: rec.polls, commitment, err: null };
    },

    async awaitFinality(signature, options) {
      world.record('chain', 'awaitFinality', signature);
      if (world.faults.chainUnreachable) throw unreachable();

      const rec = world.onchainRecord(signature);
      if (!rec) throw new SettlementNotFinalError(signature, 'not seen by the RPC node');
      if (world.faults.chainExecutionError) {
        throw new SettlementNotFinalError(signature, 'on-chain execution error {"InstructionError":[0,{"Custom":1}]}');
      }
      // The real implementation polls; the stub resolves the same shape at once
      // so scenarios run in milliseconds. Slow finality is modelled by
      // finalityDelayPolls on getSignatureStatus, which the resume path uses.
      const needed = world.faults.finalityDelayPolls ?? 0;
      rec.polls += 1;
      if (rec.polls <= needed) {
        throw new SettlementNotFinalError(signature, `still at 'confirmed' (poll ${rec.polls} of ${needed})`);
      }
      return {
        signature,
        found: true,
        slot: rec.slot,
        confirmations: rec.polls,
        commitment: (options?.commitment ?? 'finalized') as Commitment,
        err: null,
      };
    },

    async getTransaction(signature) {
      world.record('chain', 'getTransaction', signature);
      if (world.faults.chainUnreachable) throw unreachable();

      const rec = world.onchainRecord(signature);
      if (!rec) return null;

      return {
        signature,
        slot: rec.slot,
        blockTime: new Date(),
        feeLamports: 5000n,
        err: null,
        tokenTransfers: [
          {
            mint: SOLANA_MINTS[SETTLEMENT_ASSET].mint,
            owner: 'stub-treasury-owner',
            decimals: SOLANA_MINTS[SETTLEMENT_ASSET].decimals,
            changeRaw: rec.amountRaw,
          },
        ],
      };
    },

    async getTokenBalanceRaw(owner) {
      world.record('chain', 'getTokenBalanceRaw', owner);
      if (world.faults.chainUnreachable) throw unreachable();
      return 0n;
    },
  };
}

/** All three, sharing one world. */
export function stubPorts(world: StubWorld) {
  return { converter: stubConverter(world), custody: stubCustody(world), chain: stubChain(world) };
}
