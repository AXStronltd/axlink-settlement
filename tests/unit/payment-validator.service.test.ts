import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Prisma mock (vi.hoisted ensures mockPrisma is ready when vi.mock factory runs) ──

const mockPrisma = vi.hoisted(() => ({
  user:    { findUnique: vi.fn() },
  account: { findUnique: vi.fn() },
}));

vi.mock('../../packages/core/ledger/ledger.service', () => ({
  prisma: mockPrisma,
}));

// ── Kafka mock (prevent real bus init) ────────────────────────────────────────

const subscribers: Record<string, Array<(e: unknown) => Promise<void>>> = {};
const mockBus = {
  publish: vi.fn(async (topic: string, event: unknown) => {
    setImmediate(() => {
      for (const h of subscribers[topic] ?? []) h(event).catch(() => {});
    });
  }),
  subscribe: vi.fn(async (topic: string, handler: (e: unknown) => Promise<void>) => {
    if (!subscribers[topic]) subscribers[topic] = [];
    subscribers[topic].push(handler);
  }),
  disconnect: vi.fn(async () => {}),
};

vi.mock('../../packages/core/events/kafka.service', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../packages/core/events/kafka.service')>();
  return {
    ...orig,
    getEventBus: vi.fn(async () => mockBus),
  };
});

import { startPaymentValidator } from '../../packages/settlement/transfers/payment-validator.service';
import { getEventBus, TOPICS } from '../../packages/core/events/kafka.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user_001',
    kycStatus: 'APPROVED',
    accounts: [{ currency: 'KES', balance: '10000' }],
    ...overrides,
  };
}

function makeAccount(balance = 10000, currency = 'KES') {
  return { balance: String(balance), currency };
}

async function validate(event: Parameters<typeof import('../../packages/core/events/kafka.service')['requestValidation']>[0]) {
  // Manually simulate what requestValidation does: publish → wait for result
  return new Promise<{ approved: boolean; reason?: string }>((resolve) => {
    const correlationId = 'test-correlation-' + Math.random();

    // Subscribe to result
    const resultSubs = subscribers[TOPICS.VALIDATION_RESULT] ?? [];
    const tempHandler = async (raw: unknown) => {
      const result = raw as { correlationId: string; approved: boolean; reason?: string };
      if (result.correlationId === correlationId) {
        const idx = (subscribers[TOPICS.VALIDATION_RESULT] ?? []).indexOf(tempHandler);
        if (idx >= 0) subscribers[TOPICS.VALIDATION_RESULT].splice(idx, 1);
        resolve(result);
      }
    };
    if (!subscribers[TOPICS.VALIDATION_RESULT]) subscribers[TOPICS.VALIDATION_RESULT] = [];
    subscribers[TOPICS.VALIDATION_RESULT].push(tempHandler);

    // Publish validation request
    mockBus.publish(TOPICS.VALIDATION_REQUESTED, {
      correlationId,
      type: event.type,
      payload: event.payload,
      timestamp: new Date().toISOString(),
    });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Payment Validator — P2P_TRANSFER', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    Object.keys(subscribers).forEach(k => delete subscribers[k]);
    await startPaymentValidator();
  });

  it('approves valid same-currency transfer', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(makeUser({ id: 'sender' }))
      .mockResolvedValueOnce(makeUser({ id: 'receiver' }));
    mockPrisma.account.findUnique.mockResolvedValueOnce(makeAccount(5000, 'KES'));

    const result = await validate({
      type: 'P2P_TRANSFER',
      payload: { senderId: 'sender', receiverId: 'receiver', fromCurrency: 'KES', toCurrency: 'KES', amount: 1000 },
    });
    expect(result.approved).toBe(true);
  });

  it('rejects self-transfer', async () => {
    const result = await validate({
      type: 'P2P_TRANSFER',
      payload: { senderId: 'same', receiverId: 'same', fromCurrency: 'KES', toCurrency: 'KES', amount: 100 },
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/same account/i);
  });

  it('rejects sender not found', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeUser());

    const result = await validate({
      type: 'P2P_TRANSFER',
      payload: { senderId: 'ghost', receiverId: 'real', fromCurrency: 'KES', toCurrency: 'KES', amount: 100 },
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/not found/i);
  });

  it('rejects KYC pending sender', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(makeUser({ kycStatus: 'PENDING' }))
      .mockResolvedValueOnce(makeUser());

    const result = await validate({
      type: 'P2P_TRANSFER',
      payload: { senderId: 'u1', receiverId: 'u2', fromCurrency: 'GBP', toCurrency: 'KES', amount: 100 },
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/KYC not approved/i);
    expect(result.reason).toMatch(/sender/i);
  });

  it('rejects KYC rejected receiver', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(makeUser())
      .mockResolvedValueOnce(makeUser({ kycStatus: 'REJECTED' }));

    const result = await validate({
      type: 'P2P_TRANSFER',
      payload: { senderId: 'u1', receiverId: 'u2', fromCurrency: 'KES', toCurrency: 'KES', amount: 100 },
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/receiver KYC/i);
  });

  it('rejects insufficient balance', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(makeUser())
      .mockResolvedValueOnce(makeUser());
    mockPrisma.account.findUnique.mockResolvedValueOnce(makeAccount(50, 'GBP'));

    const result = await validate({
      type: 'P2P_TRANSFER',
      payload: { senderId: 'u1', receiverId: 'u2', fromCurrency: 'GBP', toCurrency: 'KES', amount: 200 },
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/insufficient balance/i);
  });

  it('rejects unsupported fromCurrency', async () => {
    const result = await validate({
      type: 'P2P_TRANSFER',
      payload: { senderId: 'u1', receiverId: 'u2', fromCurrency: 'XYZ', toCurrency: 'KES', amount: 100 },
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/not supported/i);
  });

  it('rejects amount below minimum', async () => {
    const result = await validate({
      type: 'P2P_TRANSFER',
      payload: { senderId: 'u1', receiverId: 'u2', fromCurrency: 'KES', toCurrency: 'KES', amount: 1 }, // min is 10
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/minimum/i);
  });

  it('rejects amount above maximum', async () => {
    const result = await validate({
      type: 'P2P_TRANSFER',
      payload: { senderId: 'u1', receiverId: 'u2', fromCurrency: 'GBP', toCurrency: 'KES', amount: 999_999 }, // max GBP = 250k
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/maximum/i);
  });
});

describe('Payment Validator — DEPOSIT', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    Object.keys(subscribers).forEach(k => delete subscribers[k]);
    await startPaymentValidator();
  });

  it('approves valid mpesa deposit', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(makeUser());

    const result = await validate({
      type: 'DEPOSIT',
      payload: { userId: 'u1', currency: 'KES', amount: 5000, rail: 'mpesa' },
    });
    expect(result.approved).toBe(true);
  });

  it('approves brainrock deposit (was broken before fix)', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(makeUser());

    const result = await validate({
      type: 'DEPOSIT',
      payload: { userId: 'u1', currency: 'GBP', amount: 500, rail: 'brainrock' },
    });
    expect(result.approved).toBe(true);
  });

  it('approves choicebank deposit (was broken before fix)', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(makeUser());

    const result = await validate({
      type: 'DEPOSIT',
      payload: { userId: 'u1', currency: 'NGN', amount: 50000, rail: 'choicebank' },
    });
    expect(result.approved).toBe(true);
  });

  it('approves daraja_stk deposit (was broken before fix)', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(makeUser());

    const result = await validate({
      type: 'DEPOSIT',
      payload: { userId: 'u1', currency: 'KES', amount: 1000, rail: 'daraja_stk' },
    });
    expect(result.approved).toBe(true);
  });

  it('rejects invalid rail', async () => {
    const result = await validate({
      type: 'DEPOSIT',
      payload: { userId: 'u1', currency: 'KES', amount: 1000, rail: 'telegram_pay' },
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/not supported/i);
  });

  it('rejects KYC pending user', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(makeUser({ kycStatus: 'PENDING' }));

    const result = await validate({
      type: 'DEPOSIT',
      payload: { userId: 'u1', currency: 'KES', amount: 1000, rail: 'mpesa' },
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/KYC not approved/i);
  });

  it('rejects unknown user', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);

    const result = await validate({
      type: 'DEPOSIT',
      payload: { userId: 'ghost', currency: 'KES', amount: 1000, rail: 'mpesa' },
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/not found/i);
  });

  it('rejects missing userId', async () => {
    const result = await validate({
      type: 'DEPOSIT',
      payload: { currency: 'KES', amount: 1000, rail: 'mpesa' } as never,
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/userId is required/i);
  });
});

describe('Payment Validator — WITHDRAWAL', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    Object.keys(subscribers).forEach(k => delete subscribers[k]);
    await startPaymentValidator();
  });

  it('approves valid withdrawal', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(makeUser());
    mockPrisma.account.findUnique.mockResolvedValueOnce(makeAccount(50000, 'KES'));

    const result = await validate({
      type: 'WITHDRAWAL',
      payload: { userId: 'u1', currency: 'KES', amount: 10000, destination: { mobileNumber: '+254712345678' } },
    });
    expect(result.approved).toBe(true);
  });

  it('rejects empty destination', async () => {
    const result = await validate({
      type: 'WITHDRAWAL',
      payload: { userId: 'u1', currency: 'KES', amount: 100, destination: {} },
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/destination is required/i);
  });

  it('rejects missing destination', async () => {
    const result = await validate({
      type: 'WITHDRAWAL',
      payload: { userId: 'u1', currency: 'KES', amount: 100 } as never,
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/destination is required/i);
  });

  it('rejects insufficient balance', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(makeUser());
    mockPrisma.account.findUnique.mockResolvedValueOnce(makeAccount(500, 'GBP'));

    const result = await validate({
      type: 'WITHDRAWAL',
      payload: { userId: 'u1', currency: 'GBP', amount: 1000, destination: { iban: 'GB29NWBK...' } },
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/insufficient balance/i);
  });

  it('rejects KYC not approved', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(makeUser({ kycStatus: 'REJECTED' }));

    const result = await validate({
      type: 'WITHDRAWAL',
      payload: { userId: 'u1', currency: 'GBP', amount: 100, destination: { iban: 'GB29NWBK...' } },
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/KYC not approved/i);
  });
});

describe('Payment Validator — edge cases', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    Object.keys(subscribers).forEach(k => delete subscribers[k]);
    await startPaymentValidator();
  });

  it('rejects unknown payment type', async () => {
    const result = await validate({
      type: 'CRYPTO_SWAP' as never,
      payload: { amount: 100 } as never,
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/unknown payment type/i);
  });

  it('rejects zero amount', async () => {
    const result = await validate({
      type: 'DEPOSIT',
      payload: { userId: 'u1', currency: 'KES', amount: 0, rail: 'mpesa' },
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/greater than 0/i);
  });
});
