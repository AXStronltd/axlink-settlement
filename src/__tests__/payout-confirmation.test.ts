import { describe, it, expect, vi, beforeEach } from 'vitest';

// State the fakes read from, reset per test.
let withdrawalRow: { id: string; trackingId: string; status: string } | null = null;
let legs: Array<{ kind: string; status: string }> = [];

const updateWithdrawal = vi.fn(async () => ({}));
const auditLog = vi.fn(async () => undefined);
const confirmPartnerPayout = vi.fn(async () => undefined);

vi.mock('../core/ledger.service', () => ({
  prisma: {
    withdrawal: {
      findUnique: vi.fn(async () => withdrawalRow),
      update: (...args: unknown[]) => updateWithdrawal(...(args as [])),
    },
  },
  audit: (...args: unknown[]) => auditLog(...(args as [])),
}));

vi.mock('../core/settlement/leg.service', () => ({
  legsFor: vi.fn(async () => legs),
}));

vi.mock('../core/settlement/usd-corridor.service', () => ({
  confirmPartnerPayout: (...args: unknown[]) => confirmPartnerPayout(...(args as [])),
}));

import { confirmWithdrawalFromPartner } from '../core/settlement/payout-confirmation.service';

const call = () =>
  confirmWithdrawalFromPartner({
    withdrawalId: 'wdr_1',
    partnerReference: 'MPESA_TX_9',
    providerId: 'daraja',
  });

beforeEach(() => {
  vi.clearAllMocks();
  withdrawalRow = { id: 'wdr_1', trackingId: 'wdr_abc', status: 'PENDING_PAYOUT' };
  legs = [];
});

describe('confirmWithdrawalFromPartner', () => {
  // The bug this module exists for: all three webhooks used to write
  // status: COMPLETED directly, so the leg was never confirmed and the
  // journal entry clearing suspense never posted.
  it('routes through the settlement engine when a payout leg exists', async () => {
    legs = [{ kind: 'PARTNER_PAYOUT', status: 'AWAITING_CONFIRMATION' }];

    expect(await call()).toBe('SETTLED');
    expect(confirmPartnerPayout).toHaveBeenCalledWith('wdr_1', 'MPESA_TX_9');
    // Must NOT bypass the engine with a direct write.
    expect(updateWithdrawal).not.toHaveBeenCalled();
  });

  // Calling confirmPartnerPayout blindly would silently no-op here, leaving
  // pre-settlement-engine withdrawals stuck in PENDING_PAYOUT forever.
  it('falls back to a direct close when there is no payout leg', async () => {
    legs = [{ kind: 'LEDGER_DEBIT', status: 'COMPLETED' }];

    expect(await call()).toBe('LEGACY');
    expect(confirmPartnerPayout).not.toHaveBeenCalled();
    expect(updateWithdrawal).toHaveBeenCalledWith({
      where: { id: 'wdr_1' },
      data: { status: 'COMPLETED' },
    });
  });

  it('records that the legacy close left no journal entry', async () => {
    legs = [];
    await call();

    const [entityType, entityId, event, data] = auditLog.mock.calls[0] as unknown as [
      string, string, string, Record<string, unknown>,
    ];
    expect(entityType).toBe('Withdrawal');
    expect(entityId).toBe('wdr_1');
    expect(event).toBe('COMPLETED_WITHOUT_SETTLEMENT');
    expect(data.providerId).toBe('daraja');
  });

  // Partners re-deliver webhooks. A second delivery must not post the
  // suspense-clearing entry twice.
  it('is idempotent against webhook re-delivery', async () => {
    withdrawalRow = { id: 'wdr_1', trackingId: 'wdr_abc', status: 'COMPLETED' };
    legs = [{ kind: 'PARTNER_PAYOUT', status: 'COMPLETED' }];

    expect(await call()).toBe('ALREADY_CLOSED');
    expect(confirmPartnerPayout).not.toHaveBeenCalled();
    expect(updateWithdrawal).not.toHaveBeenCalled();
  });

  it('reports an unknown withdrawal rather than throwing', async () => {
    withdrawalRow = null;

    expect(await call()).toBe('NOT_FOUND');
    expect(confirmPartnerPayout).not.toHaveBeenCalled();
    expect(updateWithdrawal).not.toHaveBeenCalled();
  });
});
