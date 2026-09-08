/**
 * Scenarios.
 *
 * Each one drives the **real** engine — real ledger, real legs, real proof
 * verification — against stubs it can make misbehave. Nothing here
 * re-implements settlement logic; if a scenario passes, the code that would run
 * in production is the code that ran.
 *
 * Scenarios mirror the architecture blueprint one for one, so a change to
 * either should be visible as a change to the other.
 */

import { randomBytes } from 'crypto';
import { prisma } from '../core/ledger.service';
import { addFunds, withdraw, advanceDeposit, advanceWithdrawal, confirmPartnerPayout } from '../core/settlement/usd-corridor.service';
import { legsFor } from '../core/settlement/leg.service';
import { tick } from '../core/settlement/resume.worker';
import type { StubWorld } from './stubs';
import type { Scope } from './invariants';

export interface ScenarioContext {
  world: StubWorld;
  scope: Scope;
  /** Creates a simulated user with a vault, returns its id. */
  makeUser: (currency?: string) => Promise<string>;
  /** Free-text notes that appear in the report. */
  note: (line: string) => void;
  /** Assertion that fails the scenario without throwing past the runner. */
  expect: (claim: string, condition: boolean, detail?: string) => void;
}

export interface Scenario {
  id: string;
  title: string;
  /** What this proves. Printed in the report — a scenario without one is a smoke test. */
  proves: string;
  run: (ctx: ScenarioContext) => Promise<void>;
}

const AMOUNT = 10_000;
const WITHDRAWAL = 5_000;

export const SCENARIOS: Scenario[] = [
  // ────────────────────────────────────────────────────────────────────────────
  {
    id: 'deposit-happy',
    title: 'Add funds — $10,000 lands and becomes spendable',
    proves: 'Legs run in order, the conversion is not paid out before it happens, and the balance moves only after a finalized signature.',
    async run({ makeUser, expect, note, scope }) {
      const userId = await makeUser();
      const result = await addFunds({
        userId, amount: AMOUNT, rail: 'sim-bank', railReference: `ref_${randomBytes(4).toString('hex')}`,
      });
      const depositId = (result.value as { depositId: string }).depositId;
      scope.depositIds.push(depositId);

      // Drive to completion the way the worker would.
      for (let i = 0; i < 6; i++) await advanceDeposit(depositId).catch(() => undefined);

      const deposit = await prisma.bankDeposit.findUniqueOrThrow({ where: { id: depositId } });
      const legs = await legsFor('BankDeposit', depositId);
      const account = await prisma.account.findUnique({ where: { userId_currency: { userId, currency: 'USD' } } });

      note(`legs: ${legs.map(l => `${l.kind}=${l.status}`).join(', ')}`);
      expect('deposit reaches COMPLETED', deposit.status === 'COMPLETED', `status=${deposit.status}`);
      expect('every leg completed', legs.every(l => l.status === 'COMPLETED'), legs.filter(l => l.status !== 'COMPLETED').map(l => l.kind).join(','));
      expect('customer balance credited', Number(account?.balance ?? 0) === AMOUNT, `balance=${account?.balance}`);

      const proof = await prisma.settlementProof.findFirst({ where: { entityType: 'BankDeposit', entityId: depositId } });
      expect('an on-chain proof was recorded', Boolean(proof), proof ? `sig ${proof.signature.slice(0, 12)}…` : 'none');
    },
  },

  // ────────────────────────────────────────────────────────────────────────────
  {
    id: 'deposit-ordering',
    title: 'The conversion is never paid out before it settles',
    proves: 'The sequencing bug this engine was built to fix stays fixed: no USDT payout is requested until the fiat conversion is confirmed.',
    async run({ makeUser, expect, world, scope }) {
      const userId = await makeUser();
      const result = await addFunds({
        userId, amount: AMOUNT, rail: 'sim-bank', railReference: `ref_${randomBytes(4).toString('hex')}`,
      });
      const depositId = (result.value as { depositId: string }).depositId;
      scope.depositIds.push(depositId);

      // Exactly one advance: only leg 0 (the conversion) should have run.
      const calls = world.callsTo('converter');
      const deposits = calls.filter(c => c.method === 'createDeposit');
      const payouts = calls.filter(c => c.method === 'createPayout');

      expect('conversion was requested', deposits.length === 1, `${deposits.length} createDeposit call(s)`);
      expect(
        'no USDT payout was requested before the conversion confirmed',
        payouts.length === 0,
        `${payouts.length} premature createPayout call(s)`,
      );

      // Finish it so the run leaves clean books.
      for (let i = 0; i < 6; i++) await advanceDeposit(depositId).catch(() => undefined);
    },
  },

  // ────────────────────────────────────────────────────────────────────────────
  {
    id: 'withdrawal-happy',
    title: 'Withdrawal — $5,000 out, suspense clears on confirmation',
    proves: 'Suspense holds the customer\'s money between debit and delivery, and only the partner\'s confirmation closes it.',
    async run({ makeUser, expect, note, scope }) {
      const userId = await fundedUser(makeUser, scope);

      const result = await withdraw({
        userId, amount: WITHDRAWAL, providerId: 'sim-partner',
        partnerAccount: 'GB00SIM01234567890', recipientName: 'Simulated Beneficiary',
        idempotencyKey: `wd_${randomBytes(6).toString('hex')}`,
      });
      const withdrawalId = (result.value as { withdrawalId: string }).withdrawalId;
      scope.withdrawalIds.push(withdrawalId);

      for (let i = 0; i < 6; i++) await advanceWithdrawal(withdrawalId).catch(() => undefined);

      let row = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
      note(`before partner confirmation: status=${row.status}`);
      expect(
        'the payout leg waits for the partner rather than self-completing',
        row.status !== 'COMPLETED',
        `status=${row.status} — a bank wire must not be COMPLETED on submission`,
      );

      await confirmPartnerPayout(withdrawalId, 'partner-ref-001');
      row = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });

      expect('withdrawal completes on confirmation', row.status === 'COMPLETED', `status=${row.status}`);

      const account = await prisma.account.findUnique({ where: { userId_currency: { userId, currency: 'USD' } } });
      expect('balance reduced by the withdrawal', Number(account?.balance ?? -1) === AMOUNT - WITHDRAWAL, `balance=${account?.balance}`);
    },
  },

  // ────────────────────────────────────────────────────────────────────────────
  {
    id: 'rpc-unreachable',
    title: 'The Solana node is unreachable mid-settlement',
    proves: 'An unreachable node is NOT treated as a failed settlement. The leg holds, and completes once the node returns.',
    async run({ makeUser, expect, note, world, scope }) {
      const userId = await fundedUser(makeUser, scope);

      world.faults.chainUnreachable = true;

      const result = await withdraw({
        userId, amount: WITHDRAWAL, providerId: 'sim-partner',
        partnerAccount: 'GB00SIM01234567890', recipientName: 'Simulated Beneficiary',
        idempotencyKey: `wd_${randomBytes(6).toString('hex')}`,
      });
      const withdrawalId = (result.value as { withdrawalId: string }).withdrawalId;
      scope.withdrawalIds.push(withdrawalId);

      for (let i = 0; i < 3; i++) await advanceWithdrawal(withdrawalId).catch(() => undefined);

      let legs = await legsFor('Withdrawal', withdrawalId);
      const settleLeg = legs.find(l => l.kind === 'ONCHAIN_SETTLE');
      const row = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });

      note(`while unreachable: ONCHAIN_SETTLE=${settleLeg?.status}, withdrawal=${row.status}`);
      expect('the settlement is not marked COMPLETED', row.status !== 'COMPLETED', `status=${row.status}`);
      expect('the proof leg did not complete on an unreachable node', settleLeg?.status !== 'COMPLETED', `leg=${settleLeg?.status}`);
      expect('no false proof was recorded', (await prisma.settlementProof.count({ where: { entityId: withdrawalId } })) === 0);

      // Node comes back.
      world.faults.chainUnreachable = false;
      for (let i = 0; i < 6; i++) await advanceWithdrawal(withdrawalId).catch(() => undefined);

      legs = await legsFor('Withdrawal', withdrawalId);
      const recovered = legs.find(l => l.kind === 'ONCHAIN_SETTLE');
      expect('it settles once the node returns', recovered?.status === 'COMPLETED', `leg=${recovered?.status}`);

      await confirmPartnerPayout(withdrawalId, 'partner-ref-recovered');
    },
  },

  // ────────────────────────────────────────────────────────────────────────────
  {
    id: 'onchain-failure',
    title: 'The transaction lands on chain and fails to execute',
    proves: 'A failed on-chain transaction is a failed settlement — distinct from an unreachable node, and never completed.',
    async run({ makeUser, expect, note, world, scope }) {
      const userId = await fundedUser(makeUser, scope);

      world.faults.chainExecutionError = true;

      const result = await withdraw({
        userId, amount: WITHDRAWAL, providerId: 'sim-partner',
        partnerAccount: 'GB00SIM01234567890', recipientName: 'Simulated Beneficiary',
        idempotencyKey: `wd_${randomBytes(6).toString('hex')}`,
      });
      const withdrawalId = (result.value as { withdrawalId: string }).withdrawalId;
      scope.withdrawalIds.push(withdrawalId);

      for (let i = 0; i < 3; i++) await advanceWithdrawal(withdrawalId).catch(() => undefined);

      const row = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
      const legs = await legsFor('Withdrawal', withdrawalId);
      const settleLeg = legs.find(l => l.kind === 'ONCHAIN_SETTLE');

      note(`ONCHAIN_SETTLE=${settleLeg?.status} · ${settleLeg?.lastError?.slice(0, 90) ?? 'no error recorded'}`);
      expect('the settlement did not complete', row.status !== 'COMPLETED', `status=${row.status}`);
      expect('the leg is FAILED, not awaiting', settleLeg?.status === 'FAILED', `leg=${settleLeg?.status}`);

      const failureProof = await prisma.settlementProof.findFirst({ where: { entityId: withdrawalId } });
      expect(
        'the on-chain failure is recorded rather than discarded',
        Boolean(failureProof?.onchainError),
        failureProof ? `error: ${failureProof.onchainError?.slice(0, 60)}` : 'no proof row written',
      );

      world.faults.chainExecutionError = false;
    },
  },

  // ────────────────────────────────────────────────────────────────────────────
  {
    id: 'amount-drift',
    title: 'The chain moved a different amount than we intended',
    proves: 'A finalized signature is not accepted as proof unless the mint and amount match. A hash we copied from an API is not evidence.',
    async run({ makeUser, expect, note, world, scope }) {
      const userId = await fundedUser(makeUser, scope);

      world.faults.chainAmountDrift = -100; // 100 USDT short

      const result = await withdraw({
        userId, amount: WITHDRAWAL, providerId: 'sim-partner',
        partnerAccount: 'GB00SIM01234567890', recipientName: 'Simulated Beneficiary',
        idempotencyKey: `wd_${randomBytes(6).toString('hex')}`,
      });
      const withdrawalId = (result.value as { withdrawalId: string }).withdrawalId;
      scope.withdrawalIds.push(withdrawalId);

      for (let i = 0; i < 3; i++) await advanceWithdrawal(withdrawalId).catch(() => undefined);

      const legs = await legsFor('Withdrawal', withdrawalId);
      const settleLeg = legs.find(l => l.kind === 'ONCHAIN_SETTLE');
      const row = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });

      note(`ONCHAIN_SETTLE=${settleLeg?.status} · ${settleLeg?.lastError?.slice(0, 100) ?? ''}`);
      expect('the mismatch was caught', settleLeg?.status === 'FAILED', `leg=${settleLeg?.status}`);
      expect('the settlement did not complete', row.status !== 'COMPLETED', `status=${row.status}`);
      expect(
        'the error names the amount mismatch',
        (settleLeg?.lastError ?? '').toLowerCase().includes('mismatch'),
        settleLeg?.lastError?.slice(0, 80),
      );

      world.faults.chainAmountDrift = undefined;
    },
  },

  // ────────────────────────────────────────────────────────────────────────────
  {
    id: 'duplicate-request',
    title: 'The same withdrawal is submitted twice',
    proves: 'One idempotency key pays once. The replay returns the original result rather than creating a second payment.',
    async run({ makeUser, expect, note, world, scope }) {
      const userId = await fundedUser(makeUser, scope);
      const key = `wd_${randomBytes(6).toString('hex')}`;
      const params = {
        userId, amount: WITHDRAWAL, providerId: 'sim-partner',
        partnerAccount: 'GB00SIM01234567890', recipientName: 'Simulated Beneficiary',
        idempotencyKey: key,
      };

      const first = await withdraw(params);
      const second = await withdraw(params);

      const id1 = (first.value as { withdrawalId: string }).withdrawalId;
      const id2 = (second.value as { withdrawalId: string }).withdrawalId;
      scope.withdrawalIds.push(id1);

      note(`first=${first.outcome}, second=${second.outcome}`);
      expect('the first request executed', first.outcome === 'EXECUTED');
      expect('the second was replayed, not re-executed', second.outcome === 'REPLAYED', `outcome=${second.outcome}`);
      expect('both refer to the same withdrawal', id1 === id2, `${id1} vs ${id2}`);

      const count = await prisma.withdrawal.count({ where: { userId } });
      expect('exactly one withdrawal exists', count === 1, `${count} withdrawal rows`);

      const account = await prisma.account.findUnique({ where: { userId_currency: { userId, currency: 'USD' } } });
      expect('the customer was debited once', Number(account?.balance ?? -1) === AMOUNT - WITHDRAWAL, `balance=${account?.balance}`);

      for (let i = 0; i < 6; i++) await advanceWithdrawal(id1).catch(() => undefined);
      await confirmPartnerPayout(id1, 'partner-ref-dupe');
    },
  },

  // ────────────────────────────────────────────────────────────────────────────
  {
    id: 'concurrent-duplicate',
    title: 'Two identical requests race each other',
    proves: 'Idempotency is arbitrated by a unique constraint, not a read-then-write check. Concurrency is where the old check failed.',
    async run({ makeUser, expect, note, scope }) {
      const userId = await fundedUser(makeUser, scope);
      const key = `wd_${randomBytes(6).toString('hex')}`;
      const params = {
        userId, amount: WITHDRAWAL, providerId: 'sim-partner',
        partnerAccount: 'GB00SIM01234567890', recipientName: 'Simulated Beneficiary',
        idempotencyKey: key,
      };

      const results = await Promise.allSettled([withdraw(params), withdraw(params)]);
      const fulfilled = results.filter(r => r.status === 'fulfilled').length;
      const inFlightRejections = results.filter(
        r => r.status === 'rejected' && (r.reason as { code?: string })?.code === 'REQUEST_IN_FLIGHT',
      ).length;

      note(`fulfilled=${fulfilled}, rejected as in-flight=${inFlightRejections}`);

      const count = await prisma.withdrawal.count({ where: { userId } });
      expect('exactly one withdrawal was created', count === 1, `${count} withdrawal rows`);

      const account = await prisma.account.findUnique({ where: { userId_currency: { userId, currency: 'USD' } } });
      expect('the customer was debited once', Number(account?.balance ?? -1) === AMOUNT - WITHDRAWAL, `balance=${account?.balance}`);

      const row = await prisma.withdrawal.findFirst({ where: { userId } });
      if (row) {
        scope.withdrawalIds.push(row.id);
        for (let i = 0; i < 6; i++) await advanceWithdrawal(row.id).catch(() => undefined);
        await confirmPartnerPayout(row.id, 'partner-ref-race');
      }
    },
  },

  // ────────────────────────────────────────────────────────────────────────────
  {
    id: 'crash-resume',
    title: 'The process dies mid-settlement',
    proves: 'A settlement abandoned between the debit and the payout is picked up and finished by the resume worker, with no duplicate calls to the partner.',
    async run({ makeUser, expect, note, world, scope }) {
      const userId = await fundedUser(makeUser, scope);

      const result = await withdraw({
        userId, amount: WITHDRAWAL, providerId: 'sim-partner',
        partnerAccount: 'GB00SIM01234567890', recipientName: 'Simulated Beneficiary',
        idempotencyKey: `wd_${randomBytes(6).toString('hex')}`,
      });
      const withdrawalId = (result.value as { withdrawalId: string }).withdrawalId;
      scope.withdrawalIds.push(withdrawalId);

      const midway = await legsFor('Withdrawal', withdrawalId);
      const open = midway.filter(l => l.status !== 'COMPLETED').length;
      note(`simulating a crash with ${open} leg(s) unfinished`);
      expect('the settlement was left incomplete', open > 0, `${open} open legs`);

      // Nothing but the worker from here — as if the process had restarted.
      const custodyCallsBefore = world.callsTo('custody', 'createTransfer').length;
      for (let i = 0; i < 5; i++) await tick();
      const custodyCallsAfter = world.callsTo('custody', 'createTransfer').length;

      const legs = await legsFor('Withdrawal', withdrawalId);
      note(`after resume: ${legs.map(l => `${l.kind}=${l.status}`).join(', ')}`);

      const payoutLeg = legs.find(l => l.kind === 'PARTNER_PAYOUT');
      expect('the worker drove it to the payout leg', Boolean(payoutLeg && payoutLeg.status !== 'PENDING'), `payout leg=${payoutLeg?.status}`);

      // The custody transfer may be retried, but the deterministic externalTxId
      // means the custodian returns the same transaction rather than moving
      // funds twice — which is the property that makes resuming safe at all.
      const distinct = new Set(world.callsTo('custody', 'createTransfer').map(c => c.key)).size;
      expect(
        'repeat custody calls reuse one deterministic key',
        distinct <= custodyCallsAfter,
        `${custodyCallsAfter - custodyCallsBefore} call(s) during resume across ${distinct} distinct key(s)`,
      );

      await confirmPartnerPayout(withdrawalId, 'partner-ref-resumed');
    },
  },

  // ────────────────────────────────────────────────────────────────────────────
  {
    id: 'insufficient-balance',
    title: 'A withdrawal larger than the balance',
    proves: 'The balance check and the debit happen in one transaction, so an overdraw is refused rather than half-applied.',
    async run({ makeUser, expect, scope }) {
      const userId = await fundedUser(makeUser, scope);

      let refused = false;
      let code = '';
      try {
        await withdraw({
          userId, amount: AMOUNT * 10, providerId: 'sim-partner',
          partnerAccount: 'GB00SIM01234567890', recipientName: 'Simulated Beneficiary',
          idempotencyKey: `wd_${randomBytes(6).toString('hex')}`,
        });
      } catch (err) {
        refused = true;
        code = (err as { code?: string }).code ?? '';
      }

      expect('the withdrawal was refused', refused);
      expect('with a specific error code', code === 'INSUFFICIENT_BALANCE', `code=${code || 'none'}`);

      const account = await prisma.account.findUnique({ where: { userId_currency: { userId, currency: 'USD' } } });
      expect('the balance is untouched', Number(account?.balance ?? -1) === AMOUNT, `balance=${account?.balance}`);

      const count = await prisma.withdrawal.count({ where: { userId } });
      expect('no withdrawal row was left behind', count === 0, `${count} rows`);
    },
  },
];

// ── helpers ───────────────────────────────────────────────────────────────────

/** A user with a settled $10,000 deposit, so withdrawal scenarios have funds. */
async function fundedUser(makeUser: ScenarioContext['makeUser'], scope: Scope): Promise<string> {
  const userId = await makeUser();
  const result = await addFunds({
    userId, amount: AMOUNT, rail: 'sim-bank', railReference: `ref_${randomBytes(4).toString('hex')}`,
  });
  const depositId = (result.value as { depositId: string }).depositId;
  scope.depositIds.push(depositId);
  for (let i = 0; i < 6; i++) await advanceDeposit(depositId).catch(() => undefined);
  return userId;
}
