import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { toUSDDecimal } from './fx.service';

// PrismaPg adapter requires a standard postgres:// URL, not prisma+postgres://.
// Lazy init so env vars are loaded (dotenv runs in index.ts before first request).
let _prisma: PrismaClient | null = null;
function getPrisma(): PrismaClient {
  if (!_prisma) {
    const pgUrl = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
    const adapter = new PrismaPg({ connectionString: pgUrl });
    _prisma = new PrismaClient({ adapter } as ConstructorParameters<typeof PrismaClient>[0]);
  }
  return _prisma;
}
const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    return (getPrisma() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

// ── User & account management ─────────────────────────────────────────────────

export async function createUser(data: {
  email: string;
  name: string;
  vaultId: string;
  currency: string; // primary currency
  institutionId?: string | null; // F4: owning tenant
}) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email: data.email, name: data.name, vaultId: data.vaultId, institutionId: data.institutionId ?? null },
    });
    await tx.account.create({
      data: { userId: user.id, currency: data.currency, balance: 0, balanceUsd: 0 },
    });
    return user;
  });
}

export async function getUser(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { accounts: true },
  });
}

export async function getUserByEmail(email: string) {
  return prisma.user.findUnique({
    where: { email },
    include: { accounts: true },
  });
}

export async function getOrCreateAccount(userId: string, currency: string) {
  return prisma.account.upsert({
    where: { userId_currency: { userId, currency } },
    update: {},
    create: { userId, currency, balance: 0, balanceUsd: 0 },
  });
}

// ── Balance checks ────────────────────────────────────────────────────────────

/** Exact balance. Read paths that must emit JSON numbers call `.toNumber()` at the edge, never here. */
export async function getBalance(userId: string, currency: string): Promise<Prisma.Decimal> {
  const account = await prisma.account.findUnique({
    where: { userId_currency: { userId, currency } },
  });
  return account ? account.balance : new Prisma.Decimal(0);
}

/** @deprecated alias kept for callers written against the remediation branch. */
export const getBalanceDecimal = getBalance;

export async function checkSufficientBalance(
  userId: string,
  currency: string,
  amount: number,
): Promise<void> {
  const balance = await getBalanceDecimal(userId, currency);
  if (balance.lt(new Prisma.Decimal(amount))) {
    throw new Error(
      `Insufficient balance. Available: ${balance} ${currency}, Required: ${amount} ${currency}`,
    );
  }
}

// ── Atomic debit ──────────────────────────────────────────────────────────────

export async function debit(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  userId: string,
  currency: string,
  amount: Prisma.Decimal.Value,
) {
  // F5: Decimal end to end. Callers may still pass a number for small sandbox amounts; it is
  // converted once, here, and never compared or summed as a float.
  const amt = new Prisma.Decimal(amount);
  if (!amt.isPositive() || amt.isZero()) throw new Error(`debit amount must be positive, got ${amt.toString()}`);
  const usdAmount = toUSDDecimal(amt, currency);

  const account = await tx.account.findUniqueOrThrow({
    where: { userId_currency: { userId, currency } },
  });

  if (account.balance.lt(amt)) {
    throw new Error(`Insufficient balance: ${account.balance} ${currency} < ${amt.toString()}`);
  }

  return tx.account.update({
    where: { userId_currency: { userId, currency } },
    data: {
      balance: { decrement: amt },
      balanceUsd: { decrement: usdAmount },
    },
  });
}

// ── Atomic credit ─────────────────────────────────────────────────────────────

export async function credit(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  userId: string,
  currency: string,
  amount: Prisma.Decimal.Value,
) {
  const amt = new Prisma.Decimal(amount);
  if (!amt.isPositive() || amt.isZero()) throw new Error(`credit amount must be positive, got ${amt.toString()}`);
  const usdAmount = toUSDDecimal(amt, currency);

  await tx.account.upsert({
    where: { userId_currency: { userId, currency } },
    update: {
      balance: { increment: amt },
      balanceUsd: { increment: usdAmount },
    },
    create: {
      userId,
      currency,
      balance: amt,
      balanceUsd: usdAmount,
    },
  });
}

// ── Audit log ─────────────────────────────────────────────────────────────────

export async function audit(
  entityType: string,
  entityId: string,
  event: string,
  data: object,
) {
  await prisma.auditLog.create({ data: { entityType, entityId, event, data } });
}

export { prisma };
