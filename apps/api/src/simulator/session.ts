/**
 * Live stub session.
 *
 * The scenario runner installs stubs, runs, and tears them down. Driving the
 * system by hand needs the opposite: stubs that stay installed while you click
 * through a settlement, with faults you can flip *mid-flight* — start a
 * withdrawal, take the RPC node down between legs, watch what the engine does,
 * bring it back.
 *
 * One session per process. Two would be ambiguous: the ports registry is
 * process-wide, so a second session would silently steal the first one's rails.
 */

import { randomBytes } from 'crypto';
import { prisma } from '../../../../packages/core/ledger/ledger.service';
import { useTestPorts, resetPorts, isOverridden } from '../../../../packages/providers/ports/runtime';
import { StubWorld, stubPorts, type Faults } from './stubs';
import { cleanup, SimulatorRefused } from './runner';
import type { Scope } from './invariants';

export interface SessionInfo {
  active: boolean;
  startedAt: string | null;
  users: number;
  deposits: number;
  withdrawals: number;
  faults: Faults;
  /** Calls made to the stubbed rails, newest last. The audit trail of a hand-run. */
  callCount: number;
}

let world: StubWorld | null = null;
let restore: (() => void) | null = null;
let startedAt: Date | null = null;
let scope: Scope = { userIds: [], depositIds: [], withdrawalIds: [] };

const SIM_PREFIX = 'sim_';

export function isActive(): boolean {
  return world !== null;
}

export function currentWorld(): StubWorld {
  if (!world) {
    throw Object.assign(new Error('No stub session is running. Start one first.'), {
      code: 'NO_SESSION',
      statusCode: 409,
    });
  }
  return world;
}

export function currentScope(): Scope {
  return scope;
}

/**
 * The scope without throwing when no session is running.
 *
 * The console polls `/state` continuously, including before a session starts
 * and after it stops — that view should render empty, not error.
 */
export function currentScopeSafe(): Scope {
  return world ? scope : { userIds: [], depositIds: [], withdrawalIds: [] };
}

/**
 * Install the stubs and keep them installed.
 *
 * The same two guards as everything else in the simulator apply, enforced
 * inside `useTestPorts` rather than here — one place decides whether this
 * process may have its payment rails replaced.
 */
export function start(): SessionInfo {
  if (world) return info();

  if (isOverridden()) {
    throw new SimulatorRefused('the ports are already overridden by something else in this process');
  }

  world = new StubWorld();
  restore = useTestPorts(stubPorts(world));
  startedAt = new Date();
  scope = { userIds: [], depositIds: [], withdrawalIds: [] };

  console.warn('[harness] Live stub session started — converter, custody and chain are simulated in this process');
  return info();
}

/**
 * Restore the live rails. Optionally delete everything the session created —
 * on by default, because leaving simulated rows in a database you are about to
 * point at something real is how a test balance becomes a production balance.
 */
export async function stop(options: { keepData?: boolean } = {}): Promise<{ stopped: boolean; cleaned: boolean }> {
  if (!world) return { stopped: false, cleaned: false };

  restore?.();
  resetPorts();

  let cleaned = false;
  if (!options.keepData) {
    await cleanup(scope);
    cleaned = true;
  }

  world = null;
  restore = null;
  startedAt = null;
  scope = { userIds: [], depositIds: [], withdrawalIds: [] };

  console.warn(`[harness] Live stub session stopped${cleaned ? ' and simulated data removed' : ' — data kept'}`);
  return { stopped: true, cleaned };
}

export function info(): SessionInfo {
  return {
    active: world !== null,
    startedAt: startedAt?.toISOString() ?? null,
    users: scope.userIds.length,
    deposits: scope.depositIds.length,
    withdrawals: scope.withdrawalIds.length,
    faults: world?.faults ?? {},
    callCount: world?.calls.length ?? 0,
  };
}

/** Flip faults on a running session. Partial — omitted keys keep their value. */
export function setFaults(faults: Partial<Faults>): Faults {
  const w = currentWorld();
  for (const [key, value] of Object.entries(faults)) {
    if (value === null || value === undefined || value === false) {
      delete (w.faults as Record<string, unknown>)[key];
    } else {
      (w.faults as Record<string, unknown>)[key] = value;
    }
  }
  return w.faults;
}

export function clearFaults(): Faults {
  const w = currentWorld();
  w.faults = {};
  return w.faults;
}

/** What the stubbed rails were asked to do, for the activity feed. */
export function calls(limit = 60) {
  const w = currentWorld();
  return w.calls.slice(-limit).map(c => ({ ...c, at: new Date(c.at).toISOString() }));
}

// ── Test subjects ─────────────────────────────────────────────────────────────

export async function createUser(params: { name?: string; currency?: string } = {}) {
  currentWorld();
  const tag = randomBytes(4).toString('hex');

  const user = await prisma.user.create({
    data: {
      email: `${SIM_PREFIX}${tag}@simulator.local`,
      name: params.name?.trim() || `Test User ${tag}`,
      vaultId: `${SIM_PREFIX}vault_${tag}`,
      usdtAddress: `${SIM_PREFIX}addr_${tag}`,
      kycStatus: 'APPROVED',
    },
  });
  await prisma.account.create({
    data: { userId: user.id, currency: params.currency ?? 'USD', balance: 0, balanceUsd: 0 },
  });

  scope.userIds.push(user.id);
  return { id: user.id, name: user.name, email: user.email, vaultId: user.vaultId };
}

export function trackDeposit(id: string): void {
  if (!scope.depositIds.includes(id)) scope.depositIds.push(id);
}

export function trackWithdrawal(id: string): void {
  if (!scope.withdrawalIds.includes(id)) scope.withdrawalIds.push(id);
}

/** Users created in this session, with their current balances. */
export async function subjects() {
  if (scope.userIds.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { id: { in: scope.userIds } },
    include: { accounts: true },
    orderBy: { createdAt: 'asc' },
  });

  return users.map(u => ({
    id: u.id,
    name: u.name,
    vaultId: u.vaultId,
    balances: u.accounts.map(a => ({ currency: a.currency, balance: a.balance.toString() })),
  }));
}
