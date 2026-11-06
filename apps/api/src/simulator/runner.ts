/**
 * The harness.
 *
 * Installs stub ports, runs scenarios against the real engine, asserts the
 * global invariants after each one, and cleans up everything it created.
 *
 * Safety comes first here, because this thing deliberately stubs out payment
 * rails and writes to a database:
 *
 *   - `useTestPorts` refuses outright when NODE_ENV=production or
 *     SIMULATOR_ENABLED is not "true"
 *   - every row it creates is prefixed `sim_` and tracked, so cleanup is exact
 *     rather than a truncate
 *   - it refuses to run against a database that already holds non-simulated
 *     users, unless told explicitly that this is intended
 */

import { randomBytes } from 'crypto';
import { prisma } from '../../../../packages/core/ledger/ledger.service';
import { legsFor, confirmLeg } from '../../../../packages/settlement/orchestration/leg.service';
import { confirmPartnerPayout } from '../../../../packages/settlement/orchestration/usd-corridor.service';
import { useTestPorts, resetPorts } from '../../../../packages/providers/ports/runtime';
import { StubWorld, stubPorts } from './stubs';
import { SCENARIOS, CALLBACK_DRIVEN, type Scenario, type ScenarioContext } from './scenarios';
import { checkAll, postingsFor, type Check, type Scope } from './invariants';

export interface Assertion {
  claim: string;
  passed: boolean;
  detail?: string;
}

export interface ScenarioResult {
  id: string;
  title: string;
  proves: string;
  passed: boolean;
  durationMs: number;
  assertions: Assertion[];
  invariants: Check[];
  notes: string[];
  error?: string;
  postings?: Awaited<ReturnType<typeof postingsFor>>;
}

export interface RunReport {
  startedAt: string;
  durationMs: number;
  passed: boolean;
  total: number;
  failed: number;
  results: ScenarioResult[];
}

export class SimulatorRefused extends Error {
  readonly code = 'SIMULATOR_REFUSED';
  constructor(reason: string) {
    super(`Refusing to run the simulator: ${reason}`);
  }
}

const SIM_PREFIX = 'sim_';

/**
 * Refuse to touch a database that looks like it holds real data.
 *
 * A simulator that quietly runs against production is worse than no simulator,
 * and "I thought DATABASE_URL pointed at my local one" is the most ordinary
 * mistake there is.
 */
async function assertSafeDatabase(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new SimulatorRefused('NODE_ENV is production');
  }
  if (process.env.SIMULATOR_ENABLED !== 'true') {
    throw new SimulatorRefused(
      'SIMULATOR_ENABLED is not "true". Set it only where stubbing the payment rails is intended.',
    );
  }

  const real = await prisma.user.count({ where: { email: { not: { startsWith: SIM_PREFIX } } } });
  if (real > 0 && process.env.SIMULATOR_ALLOW_POPULATED_DB !== 'true') {
    throw new SimulatorRefused(
      `this database holds ${real} non-simulated user(s). Point DATABASE_URL at a scratch database, ` +
      `or set SIMULATOR_ALLOW_POPULATED_DB=true if you are certain (the harness only ever deletes its own rows).`,
    );
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────

export async function run(options: { only?: string[]; keepData?: boolean } = {}): Promise<RunReport> {
  await assertSafeDatabase();

  const world = new StubWorld();
  const restore = useTestPorts(stubPorts(world));

  const startedAt = new Date();
  const started = Date.now();
  const results: ScenarioResult[] = [];
  const chosen = options.only?.length
    ? SCENARIOS.filter(s => options.only!.includes(s.id))
    : SCENARIOS;

  if (options.only?.length) {
    const unknown = options.only.filter(id => !SCENARIOS.some(s => s.id === id));
    if (unknown.length) {
      restore();
      throw new SimulatorRefused(
        `unknown scenario(s): ${unknown.join(', ')}. Known: ${SCENARIOS.map(s => s.id).join(', ')}`,
      );
    }
  }

  try {
    for (const scenario of chosen) {
      results.push(await runOne(scenario, world, options.keepData ?? false));
    }
  } finally {
    restore();
    resetPorts();
  }

  const failed = results.filter(r => !r.passed).length;

  return {
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - started,
    passed: failed === 0,
    total: results.length,
    failed,
    results,
  };
}

async function runOne(scenario: Scenario, world: StubWorld, keepData: boolean): Promise<ScenarioResult> {
  world.reset();

  const scope: Scope = { userIds: [], depositIds: [], withdrawalIds: [] };
  const assertions: Assertion[] = [];
  const notes: string[] = [];
  const started = Date.now();
  let error: string | undefined;

  const ctx: ScenarioContext = {
    world,
    scope,
    note: line => notes.push(line),
    expect: (claim, condition, detail) => assertions.push({ claim, passed: condition, detail }),
    makeUser: async (currency = 'USD') => {
      const tag = randomBytes(5).toString('hex');
      const user = await prisma.user.create({
        data: {
          email: `${SIM_PREFIX}${tag}@simulator.local`,
          name: `Simulated User ${tag}`,
          vaultId: `${SIM_PREFIX}vault_${tag}`,
          usdtAddress: `${SIM_PREFIX}addr_${tag}`,
          kycStatus: 'APPROVED',
        },
      });
      await prisma.account.create({ data: { userId: user.id, currency, balance: 0, balanceUsd: 0 } });
      scope.userIds.push(user.id);
      return user.id;
    },
    settleExternals: async (entityType, entityId) => {
      const waiting = (await legsFor(entityType, entityId)).filter(
        l => l.status === 'AWAITING_CONFIRMATION' && CALLBACK_DRIVEN.has(l.kind),
      );
      for (const leg of waiting) {
        // A custody callback carries the on-chain hash, and ONCHAIN_SETTLE
        // reads it from payload.signature. In production the B2BinPay webhook
        // writes it (webhook.routes.ts); here there is no HTTP, so the harness
        // plays the same callback directly — signature included, or the proof
        // leg has nothing to verify.
        if (leg.kind === 'CUSTODY_TRANSFER') {
          const ref = leg.externalRef ?? leg.externalKey;
          const signature =
            world.signatureFor(ref) ?? world.broadcast(ref, (leg.amount ?? 0).toString());
          await prisma.settlementLeg.update({
            where: { id: leg.id },
            data: { payload: { ...((leg.payload as object) ?? {}), signature } },
          });
        }
        // A partner confirming a payout is not just a leg transition: it
        // clears suspense and closes the withdrawal. confirmPartnerPayout is
        // the only place that happens, and it is what the partner webhooks
        // call, so the harness calls it too rather than reimplementing it.
        if (leg.kind === 'PARTNER_PAYOUT' && entityType === 'Withdrawal') {
          await confirmPartnerPayout(entityId, leg.externalRef ?? leg.externalKey);
          continue;
        }
        await confirmLeg(leg.id, leg.externalRef ?? undefined);
      }
      return waiting.length;
    },
  };

  try {
    await scenario.run(ctx);
  } catch (err) {
    error = err instanceof Error ? `${err.message}` : String(err);
    assertions.push({ claim: 'scenario ran without an unexpected error', passed: false, detail: error });
  }

  // Invariants are checked whether or not the scenario's own claims held —
  // a scenario that fails its expectation AND corrupts the books is a
  // different problem from one that merely fails its expectation.
  let invariants: Check[] = [];
  try {
    invariants = await checkAll(scope);
  } catch (err) {
    invariants = [{ id: 'CHECK', name: 'invariant checks ran', passed: false, detail: String(err) }];
  }

  const postings = scope.withdrawalIds[0]
    ? await postingsFor('Withdrawal', scope.withdrawalIds[0])
    : scope.depositIds[0]
      ? await postingsFor('BankDeposit', scope.depositIds[0])
      : undefined;

  if (!keepData) await cleanup(scope);

  return {
    id: scenario.id,
    title: scenario.title,
    proves: scenario.proves,
    passed: assertions.every(a => a.passed) && invariants.every(i => i.passed) && !error,
    durationMs: Date.now() - started,
    assertions,
    invariants,
    notes,
    error,
    postings,
  };
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

/**
 * Delete exactly what this run created, in dependency order. Never a truncate:
 * the harness may be pointed at a database that holds other things, and a
 * cleanup that is broader than the run is its own kind of incident.
 */
export async function cleanup(scope: Scope): Promise<void> {
  const entityIds = [...scope.depositIds, ...scope.withdrawalIds];

  if (entityIds.length) {
    await prisma.settlementLeg.deleteMany({ where: { entityId: { in: entityIds } } });
    await prisma.settlementProof.deleteMany({ where: { entityId: { in: entityIds } } });
    await prisma.providerAttempt.deleteMany({ where: { entityId: { in: entityIds } } });
    await prisma.outboxEvent.deleteMany({ where: { entityId: { in: entityIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: entityIds } } });
    await prisma.idempotencyKey.deleteMany({ where: { entityId: { in: entityIds } } });

    // Journal lines cascade from their entry.
    await prisma.journalEntry.deleteMany({ where: { entityId: { in: entityIds } } });
  }

  if (scope.withdrawalIds.length) await prisma.withdrawal.deleteMany({ where: { id: { in: scope.withdrawalIds } } });
  if (scope.depositIds.length) await prisma.bankDeposit.deleteMany({ where: { id: { in: scope.depositIds } } });

  if (scope.userIds.length) {
    await prisma.account.deleteMany({ where: { userId: { in: scope.userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: scope.userIds } } });
  }

  // System ledger accounts (TREASURY, FX_PNL, SUSPENSE…) are created lazily and
  // shared. Leaving them is correct — they carry no balance once the entries
  // above are gone, and deleting them would race a concurrent run.
  await prisma.ledgerAccount.deleteMany({
    where: { code: { startsWith: 'USER:' }, userId: { in: scope.userIds } },
  });
  await prisma.ledgerAccount.deleteMany({ where: { code: { contains: `:${SIM_PREFIX}` } } });
}

/** Remove any simulated data left behind by an interrupted run. */
export async function cleanupOrphans(): Promise<{ users: number; deposits: number; withdrawals: number }> {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: SIM_PREFIX } },
    select: { id: true },
  });
  const userIds = users.map(u => u.id);
  if (userIds.length === 0) return { users: 0, deposits: 0, withdrawals: 0 };

  const deposits = await prisma.bankDeposit.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
  const withdrawals = await prisma.withdrawal.findMany({ where: { userId: { in: userIds } }, select: { id: true } });

  await cleanup({
    userIds,
    depositIds: deposits.map(d => d.id),
    withdrawalIds: withdrawals.map(w => w.id),
  });

  return { users: userIds.length, deposits: deposits.length, withdrawals: withdrawals.length };
}

export { SCENARIOS };
