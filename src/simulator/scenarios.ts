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
import { legsFor, confirmLeg } from '../core/settlement/leg.service';
import { tick } from '../core/settlement/resume.worker';
import type { StubWorld } from './stubs';
import type { Scope } from './invariants';
import { getProviderById, registerBaaSProvider } from '../core/baas-registry.service';
import { MockProvider } from '../providers/mock/mock.baas';

/**
 * A KES payout partner, registered once for the instruct scenario.
 *
 * Registered rather than stubbed because the engine resolves the partner it
 * was funded to through the registry — the same lookup production makes.
 */
function instructPartner(): MockProvider {
  const existing = getProviderById('sim-instruct') as MockProvider | undefined;
  if (existing) return existing;

  const partner = new MockProvider({
    id: 'sim-instruct',
    capability: {
      settlementCurrencies: ['USD'],
      payoutCurrencies: ['KES'],
      methods: ['mobile_money'],
      countries: ['KE'],
      operations: ['PAYOUT'],
      partnerAppliesFx: true,
    },
  });
  registerBaaSProvider(partner);
  return partner;
}

export interface ScenarioContext {
  world: StubWorld;
  scope: Scope;
  /** Creates a simulated user with a vault, returns its id. */
  makeUser: (currency?: string) => Promise<string>;
  /** Free-text notes that appear in the report. */
  note: (line: string) => void;
  /** Assertion that fails the scenario without throwing past the runner. */
  expect: (claim: string, condition: boolean, detail?: string) => void;
  /**
   * Deliver the callbacks the outside world would send.
   *
   * A leg that ends at AWAITING_CONFIRMATION is waiting on an asynchronous
   * partner: B2BinPay confirming a fiat→USDT conversion, the custodian
   * confirming a payout. In production a webhook completes it. Nothing did so
   * here, so every settlement stalled at its first such leg and no scenario
   * could reach its own claim.
   *
   * ONCHAIN_SETTLE is deliberately excluded — it resolves by polling the chain
   * stub, so advanceDeposit finishes it. Confirming it here would skip the
   * finality check the engine exists to enforce, and `rpc-unreachable` and
   * `onchain-failure` would pass while proving nothing.
   *
   * Returns how many legs it confirmed.
   */
  settleExternals: (entityType: string, entityId: string) => Promise<number>;
}

/** Legs completed by a partner callback rather than by our own polling. */
// PARTNER_PAYOUT is deliberately absent. A bank wire completing is the thing
// several scenarios are testing — withdrawal-happy asserts it must NOT
// self-complete — so confirming it here would make those assertions vacuous.
// Scenarios call confirmPartnerPayout themselves, as the webhook does.
const CALLBACK_DRIVEN = new Set(['CONVERT_FIAT_TO_CRYPTO', 'CUSTODY_TRANSFER']);
export { CALLBACK_DRIVEN };

/**
 * Push a settlement forward the way production does: our worker advances what
 * it can, partners confirm what they owe us, repeat until nothing moves.
 */
export async function drive(
  ctx: ScenarioContext,
  kind: 'BankDeposit' | 'Withdrawal',
  id: string,
  rounds = 8,
): Promise<void> {
  const advance = kind === 'BankDeposit' ? advanceDeposit : advanceWithdrawal;
  for (let i = 0; i < rounds; i++) {
    await advance(id).catch(() => undefined);
    await ctx.settleExternals(kind, id);
    const legs = await legsFor(kind, id);
    if (legs.every(l => l.status === 'COMPLETED')) return;
  }
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
    async run(ctx) {
      const { makeUser, expect, note, scope } = ctx;
      const userId = await makeUser();
      const result = await addFunds({
        userId, amount: AMOUNT, rail: 'sim-bank', railReference: `ref_${randomBytes(4).toString('hex')}`,
      });
      const depositId = (result.value as { depositId: string }).depositId;
      scope.depositIds.push(depositId);

      // Drive to completion the way production does: our worker advances what
      // it can, partners confirm what they owe us.
      await drive(ctx, 'BankDeposit', depositId);

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
    async run(ctx) {
      const { makeUser, expect, world, scope } = ctx;
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
      await drive(ctx, 'BankDeposit', depositId, 6);
    },
  },

  // ────────────────────────────────────────────────────────────────────────────
  {
    id: 'withdrawal-happy',
    title: 'Withdrawal — $5,000 out, suspense clears on confirmation',
    proves: 'Suspense holds the customer\'s money between debit and delivery, and only the partner\'s confirmation closes it.',
    async run(ctx) {
      const { makeUser, expect, note, scope } = ctx;
      const userId = await fundedUser(ctx);

      const result = await withdraw({
        userId, amount: WITHDRAWAL, providerId: 'sim-partner',
        partnerAccount: 'GB00SIM01234567890', recipientName: 'Simulated Beneficiary',
        idempotencyKey: `wd_${randomBytes(6).toString('hex')}`,
      });
      const withdrawalId = (result.value as { withdrawalId: string }).withdrawalId;
      scope.withdrawalIds.push(withdrawalId);

      await drive(ctx, 'Withdrawal', withdrawalId, 6);

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
    async run(ctx) {
      const { makeUser, expect, note, world, scope } = ctx;
      const userId = await fundedUser(ctx);

      world.faults.chainUnreachable = true;

      const result = await withdraw({
        userId, amount: WITHDRAWAL, providerId: 'sim-partner',
        partnerAccount: 'GB00SIM01234567890', recipientName: 'Simulated Beneficiary',
        idempotencyKey: `wd_${randomBytes(6).toString('hex')}`,
      });
      const withdrawalId = (result.value as { withdrawalId: string }).withdrawalId;
      scope.withdrawalIds.push(withdrawalId);

      await drive(ctx, 'Withdrawal', withdrawalId, 3);

      let legs = await legsFor('Withdrawal', withdrawalId);
      const settleLeg = legs.find(l => l.kind === 'ONCHAIN_SETTLE');
      const row = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });

      note(`while unreachable: ONCHAIN_SETTLE=${settleLeg?.status}, withdrawal=${row.status}`);
      expect('the settlement is not marked COMPLETED', row.status !== 'COMPLETED', `status=${row.status}`);
      expect('the proof leg did not complete on an unreachable node', settleLeg?.status !== 'COMPLETED', `leg=${settleLeg?.status}`);
      expect('no false proof was recorded', (await prisma.settlementProof.count({ where: { entityId: withdrawalId } })) === 0);

      // Node comes back.
      world.faults.chainUnreachable = false;
      await drive(ctx, 'Withdrawal', withdrawalId, 6);

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
    async run(ctx) {
      const { makeUser, expect, note, world, scope } = ctx;
      const userId = await fundedUser(ctx);

      world.faults.chainExecutionError = true;

      const result = await withdraw({
        userId, amount: WITHDRAWAL, providerId: 'sim-partner',
        partnerAccount: 'GB00SIM01234567890', recipientName: 'Simulated Beneficiary',
        idempotencyKey: `wd_${randomBytes(6).toString('hex')}`,
      });
      const withdrawalId = (result.value as { withdrawalId: string }).withdrawalId;
      scope.withdrawalIds.push(withdrawalId);

      // Far enough to see the failure AND to reach a settled end state:
      // the leg exhausts, compensation reverses the debit, suspense clears.
      await drive(ctx, 'Withdrawal', withdrawalId, 5);

      const row = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
      const legs = await legsFor('Withdrawal', withdrawalId);
      const settleLeg = legs.find(l => l.kind === 'ONCHAIN_SETTLE');

      note(`ONCHAIN_SETTLE=${settleLeg?.status} · ${settleLeg?.lastError?.slice(0, 90) ?? 'no error recorded'}`);
      expect('the settlement did not complete', row.status !== 'COMPLETED', `status=${row.status}`);
      // FAILED while retries remain, COMPENSATED once the withdrawal has been
      // reversed. The claim is that it is not awaiting and never COMPLETED —
      // an unreachable node holds, a failed transaction does not.
      expect(
        'the leg is failed or compensated, not awaiting',
        settleLeg?.status === 'FAILED' || settleLeg?.status === 'COMPENSATED',
        `leg=${settleLeg?.status}`,
      );

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
    async run(ctx) {
      const { makeUser, expect, note, world, scope } = ctx;
      const userId = await fundedUser(ctx);

      world.faults.chainAmountDrift = -100; // 100 USDT short

      const result = await withdraw({
        userId, amount: WITHDRAWAL, providerId: 'sim-partner',
        partnerAccount: 'GB00SIM01234567890', recipientName: 'Simulated Beneficiary',
        idempotencyKey: `wd_${randomBytes(6).toString('hex')}`,
      });
      const withdrawalId = (result.value as { withdrawalId: string }).withdrawalId;
      scope.withdrawalIds.push(withdrawalId);

      await drive(ctx, 'Withdrawal', withdrawalId, 3);

      const legs = await legsFor('Withdrawal', withdrawalId);
      const settleLeg = legs.find(l => l.kind === 'ONCHAIN_SETTLE');
      const row = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });

      note(`ONCHAIN_SETTLE=${settleLeg?.status} · ${settleLeg?.lastError?.slice(0, 100) ?? ''}`);
      // FAILED while retries remain, COMPENSATED once the withdrawal has been
      // reversed. Both mean the mismatch was caught; only COMPLETED would not.
      expect(
        'the mismatch was caught',
        settleLeg?.status === 'FAILED' || settleLeg?.status === 'COMPENSATED',
        `leg=${settleLeg?.status}`,
      );
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
    async run(ctx) {
      const { makeUser, expect, note, world, scope } = ctx;
      const userId = await fundedUser(ctx);
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

      await drive(ctx, 'Withdrawal', id1, 6);
      await confirmPartnerPayout(id1, 'partner-ref-dupe');
    },
  },

  // ────────────────────────────────────────────────────────────────────────────
  {
    id: 'concurrent-duplicate',
    title: 'Two identical requests race each other',
    proves: 'Idempotency is arbitrated by a unique constraint, not a read-then-write check. Concurrency is where the old check failed.',
    async run(ctx) {
      const { makeUser, expect, note, scope } = ctx;
      const userId = await fundedUser(ctx);
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
        await drive(ctx, 'Withdrawal', row.id, 6);
        await confirmPartnerPayout(row.id, 'partner-ref-race');
      }
    },
  },

  // ────────────────────────────────────────────────────────────────────────────
  {
    id: 'crash-resume',
    title: 'The process dies mid-settlement',
    proves: 'A settlement abandoned between the debit and the payout is picked up and finished by the resume worker, with no duplicate calls to the partner.',
    async run(ctx) {
      const { makeUser, expect, note, world, scope } = ctx;
      const userId = await fundedUser(ctx);

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
      // Only the worker drives — but a restarted process still receives the
      // partner callbacks it was waiting on, so those keep arriving. Without
      // them every leg parks at AWAITING_CONFIRMATION and the worker can never
      // reach the payout, which would make this scenario prove nothing.
      for (let i = 0; i < 5; i++) {
        await tick();
        await ctx.settleExternals('Withdrawal', withdrawalId);
      }
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
    async run(ctx) {
      const { makeUser, expect, scope } = ctx;
      const userId = await fundedUser(ctx);

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
  // ────────────────────────────────────────────────────────────────────────────
  {
    id: 'partner-instruct',
    title: 'USD to the partner, KES to the beneficiary',
    proves: 'A partner that delivers a different currency is told who to pay, and only after it has been funded.',
    async run(ctx) {
      const { expect, note, scope } = ctx;
      const partner = instructPartner();
      const before = partner.payouts.length;
      const userId = await fundedUser(ctx);

      const result = await withdraw({
        userId,
        amount: WITHDRAWAL,
        providerId: 'sim-instruct',
        partnerAccount: 'GB00SIM01234567890',
        recipientName: 'Simulated Beneficiary',
        idempotencyKey: `wd_${randomBytes(6).toString('hex')}`,
        // The corridor that needs the leg: we wire USD, they pay KES.
        destination: { name: 'Simulated Beneficiary', method: 'mobile_money', mobileNumber: '+254712345678' },
        payoutCurrency: 'KES',
      });
      const withdrawalId = (result.value as { withdrawalId: string }).withdrawalId;
      scope.withdrawalIds.push(withdrawalId);

      await drive(ctx, 'Withdrawal', withdrawalId, 8);

      // The funding wire is confirmed by the converter's callback, exactly as
      // in production. Until it lands the instruct leg must not run, which is
      // the ordering this scenario exists to prove.
      const funded = (await legsFor('Withdrawal', withdrawalId))
        .find(l => l.kind === 'PARTNER_PAYOUT');
      expect(
        'the partner is not instructed while funding is unconfirmed',
        (await legsFor('Withdrawal', withdrawalId)).find(l => l.kind === 'PARTNER_INSTRUCT')?.status === 'PENDING',
        'instruct leg waited',
      );
      if (funded) await confirmLeg(funded.id, 'b2b-wire-landed');

      await drive(ctx, 'Withdrawal', withdrawalId, 8);

      const legs = await legsFor('Withdrawal', withdrawalId);
      const funding = legs.find(l => l.kind === 'PARTNER_PAYOUT');
      const instruct = legs.find(l => l.kind === 'PARTNER_INSTRUCT');
      note(`legs: ${legs.map(l => `${l.kind}=${l.status}`).join(', ')}`);

      expect('an instruct leg was planned', Boolean(instruct), instruct ? 'present' : 'MISSING');
      expect(
        'the partner was funded before being instructed',
        funding?.status === 'COMPLETED',
        `funding=${funding?.status}`,
      );

      const instructed = partner.payouts.slice(before);
      expect('the partner was told who to pay', instructed.length === 1, `${instructed.length} instruction(s)`);
      expect(
        'in the beneficiary currency, to the beneficiary',
        instructed[0]?.currency === 'KES' && instructed[0]?.destination.mobileNumber === '+254712345678',
        `${instructed[0]?.currency} → ${instructed[0]?.destination?.mobileNumber}`,
      );

      const beforeConfirm = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
      expect(
        'accepting an instruction is not delivery',
        beforeConfirm.status !== 'COMPLETED',
        `status=${beforeConfirm.status} — the beneficiary has not confirmed`,
      );

      await confirmPartnerPayout(withdrawalId, 'partner-ref-instructed');
      const after = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
      expect('the partner confirming closes it', after.status === 'COMPLETED', `status=${after.status}`);
    },
  },
];

// ── helpers ───────────────────────────────────────────────────────────────────

/** A user with a settled $10,000 deposit, so withdrawal scenarios have funds. */
async function fundedUser(ctx: ScenarioContext): Promise<string> {
  const { scope } = ctx;
  const userId = await ctx.makeUser();
  const result = await addFunds({
    userId, amount: AMOUNT, rail: 'sim-bank', railReference: `ref_${randomBytes(4).toString('hex')}`,
  });
  const depositId = (result.value as { depositId: string }).depositId;
  scope.depositIds.push(depositId);
  await drive(ctx, 'BankDeposit', depositId);
  return userId;
}
