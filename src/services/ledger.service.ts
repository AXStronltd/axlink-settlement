import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { toUSD } from './fx.service';

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
}) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email: data.email, name: data.name, vaultId: data.vaultId },
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

export async function getBalance(userId: string, currency: string) {
  const account = await prisma.account.findUnique({
    where: { userId_currency: { userId, currency } },
  });
  return account ? Number(account.balance) : 0;
}

export async function checkSufficientBalance(
  userId: string,
  currency: string,
  amount: number,
): Promise<void> {
  const balance = await getBalance(userId, currency);
  if (balance < amount) {
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
  amount: number,
) {
  const usdAmount = await toUSD(amount, currency);

  const account = await tx.account.findUniqueOrThrow({
    where: { userId_currency: { userId, currency } },
  });

  if (Number(account.balance) < amount) {
    throw new Error(`Insufficient balance: ${account.balance} ${currency} < ${amount}`);
  }

  return tx.account.update({
    where: { userId_currency: { userId, currency } },
    data: {
      balance: { decrement: new Prisma.Decimal(amount) },
      balanceUsd: { decrement: new Prisma.Decimal(usdAmount) },
    },
  });
}

// ── Atomic credit ─────────────────────────────────────────────────────────────

export async function credit(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  userId: string,
  currency: string,
  amount: number,
) {
  const usdAmount = await toUSD(amount, currency);

  await tx.account.upsert({
    where: { userId_currency: { userId, currency } },
    update: {
      balance: { increment: new Prisma.Decimal(amount) },
      balanceUsd: { increment: new Prisma.Decimal(usdAmount) },
    },
    create: {
      userId,
      currency,
      balance: new Prisma.Decimal(amount),
      balanceUsd: new Prisma.Decimal(usdAmount),
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
