import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { assertBalanced, UnbalancedPostingError } from '../core/settlement/journal.service';
import { AccountCode, accountTypeFor, isDebitNormal } from '../core/settlement/accounts';

const line = (account: string, amount: string, currency = 'USD') => ({ account, amount, currency });

describe('assertBalanced', () => {
  it('accepts a posting whose lines sum to zero', () => {
    expect(() =>
      assertBalanced('k', [
        line('CONVERTER:b2binpay:USD', '100'),
        line('USER:u1:USD', '-100'),
      ]),
    ).not.toThrow();
  });

  it('rejects a posting with a residual', () => {
    expect(() =>
      assertBalanced('k', [line('CONVERTER:b2binpay:USD', '100'), line('USER:u1:USD', '-99')]),
    ).toThrow(UnbalancedPostingError);
  });

  it('names the currency and the residual so the bug is findable', () => {
    try {
      assertBalanced('Withdrawal:x:debit', [line('USER:u1:USD', '100'), line('SUSPENSE:USD', '-97.5')]);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('Withdrawal:x:debit');
      expect((err as Error).message).toContain('USD=2.5');
    }
  });

  // The rule that keeps FX honest: a cross-currency posting must balance in
  // each currency separately, so an FX position cannot hide inside a posting
  // that only nets out after conversion.
  it('requires each currency to balance independently', () => {
    expect(() =>
      assertBalanced('fx', [
        line('CONVERTER:b2binpay:USD', '-100', 'USD'),
        line('CUSTODY:v1:USDT', '100', 'USDT'),
      ]),
    ).toThrow(UnbalancedPostingError);
  });

  it('accepts a conversion booked through a clearing account', () => {
    expect(() =>
      assertBalanced('fx', [
        line('CONVERTER:b2binpay:USD', '-100', 'USD'),
        line('FX_PNL:USD', '100', 'USD'),
        line('CUSTODY:v1:USDT', '99.8', 'USDT'),
        line('FX_PNL:USDT', '-99.8', 'USDT'),
      ]),
    ).not.toThrow();
  });

  it('tolerates sub-1e-10 rounding noise from an FX conversion', () => {
    expect(() =>
      assertBalanced('k', [line('TREASURY:USD', '100'), line('USER:u1:USD', '-100.00000000001')]),
    ).not.toThrow();
  });

  it('does not tolerate a cent', () => {
    expect(() =>
      assertBalanced('k', [line('TREASURY:USD', '100'), line('USER:u1:USD', '-100.01')]),
    ).toThrow(UnbalancedPostingError);
  });

  it('handles many lines across several currencies', () => {
    expect(() =>
      assertBalanced('multi', [
        line('USER:u1:USD', '50'),
        line('USER:u2:USD', '30'),
        line('FEE_INCOME:USD', '-5'),
        line('TREASURY:USD', '-75'),
        line('CUSTODY:v1:USDT', '10', 'USDT'),
        line('CUSTODY:v2:USDT', '-10', 'USDT'),
      ]),
    ).not.toThrow();
  });

  it('accepts Decimal and number as well as string amounts', () => {
    expect(() =>
      assertBalanced('k', [
        { account: 'TREASURY:USD', amount: new Prisma.Decimal('100'), currency: 'USD' },
        { account: 'USER:u1:USD', amount: -100, currency: 'USD' },
      ]),
    ).not.toThrow();
  });
});

describe('chart of accounts', () => {
  it('builds codes in the documented shape', () => {
    expect(AccountCode.user('u1', 'usd')).toBe('USER:u1:USD');
    expect(AccountCode.custody('vault_7', 'usdt')).toBe('CUSTODY:vault_7:USDT');
    expect(AccountCode.suspense('usd')).toBe('SUSPENSE:USD');
    expect(AccountCode.float('daraja', 'kes')).toBe('FLOAT:daraja:KES');
  });

  it('classifies each prefix with the right normal balance', () => {
    expect(accountTypeFor('USER:u1:USD')).toBe('LIABILITY');
    expect(accountTypeFor('TREASURY:USD')).toBe('ASSET');
    expect(accountTypeFor('CUSTODY:v1:USDT')).toBe('ASSET');
    expect(accountTypeFor('FEE_INCOME:USD')).toBe('INCOME');

    expect(isDebitNormal('ASSET')).toBe(true);
    expect(isDebitNormal('LIABILITY')).toBe(false);
  });

  // A free-form code would open a brand-new account and silently absorb money
  // rather than failing, so an unknown prefix has to raise.
  it('refuses an unknown prefix instead of opening an account for a typo', () => {
    expect(() => accountTypeFor('USERS:u1:USD')).toThrow(/Unknown account code prefix/);
  });
});
