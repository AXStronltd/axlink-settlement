/**
 * Demo endpoints for the Live Demo UI.
 *
 * Two things the UI cannot do for itself, because both are decisions rather
 * than API calls in production:
 *
 *   - approving KYC
 *   - assigning a Fireblocks USDT deposit address to a user
 *
 * In production the first is a compliance decision and the second comes back
 * from Fireblocks when the vault is created. For a demo they are setup, so
 * they live here rather than being faked inside the UI.
 *
 * Mounted only when DEMO_ENABLED=true, and never when NODE_ENV=production.
 * A route that hands out KYC-approved accounts has no business existing in a
 * live deployment, regardless of what the env says.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { prisma, createUser } from '../../../../packages/core/ledger/ledger.service';
import { getSupportedCorridors } from '../../../../packages/providers/registry/baas-registry.service';
import { createVaultAccount } from '../../../../packages/providers/custody/fireblocks/fireblocks';

const router = Router();

/** Which country each currency is presented as, for the UI's corridor picker. */
const COUNTRY: Record<string, { country: string; flag: string; rail: string }> = {
  USD: { country: 'United States',  flag: '🇺🇸', rail: 'Bank transfer / ACH' },
  GBP: { country: 'United Kingdom', flag: '🇬🇧', rail: 'Faster Payments' },
  EUR: { country: 'Eurozone',       flag: '🇪🇺', rail: 'SEPA' },
  CAD: { country: 'Canada',         flag: '🇨🇦', rail: 'EFT' },
  KES: { country: 'Kenya',          flag: '🇰🇪', rail: 'M-Pesa' },
  NGN: { country: 'Nigeria',        flag: '🇳🇬', rail: 'Bank transfer' },
  GHS: { country: 'Ghana',          flag: '🇬🇭', rail: 'Bank / MoMo' },
  ZAR: { country: 'South Africa',   flag: '🇿🇦', rail: 'Bank transfer' },
  UGX: { country: 'Uganda',         flag: '🇺🇬', rail: 'Mobile money' },
  TZS: { country: 'Tanzania',       flag: '🇹🇿', rail: 'Mobile money' },
};

/** Currencies the FX engine can price. Mirrors fx.service's rate table. */
const PRICEABLE = ['USD', 'GBP', 'EUR', 'CAD', 'KES', 'NGN', 'GHS', 'ZAR', 'UGX', 'TZS'];

router.get('/corridors', (_req: Request, res: Response) => {
  const delivery = getSupportedCorridors();
  res.json({
    currencies: PRICEABLE.map(code => ({
      code,
      ...(COUNTRY[code] ?? { country: code, flag: '🏳️', rail: 'unknown' }),
      // Whether a registered payout partner can actually deliver this currency.
      // Priceable and deliverable are different questions.
      deliverable: Boolean(delivery[code]),
      providers: delivery[code]?.providers ?? [],
    })),
  });
});

/**
 * A customer who is ready to transact: vault created, KYC approved, USDT
 * address assigned. Everything the demo needs and nothing it does not.
 */
router.post('/user', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, currency } = req.body as { name?: string; currency?: string };
    const ccy = (currency ?? 'USD').toUpperCase();
    const who = name ?? 'Demo User';
    const tag = randomBytes(4).toString('hex');

    const vault = await createVaultAccount(`demo_${tag}`, true).catch(() => null);
    const vaultId = (vault as { id?: string } | null)?.id ?? `vault_demo_${tag}`;

    // Same helper the real endpoint uses — creates the user and its Account row
    // in one transaction, so the demo user is shaped like any other.
    const user = await createUser({
      email: `demo_${tag}@axlink.test`,
      name: who,
      vaultId,
      currency: ccy,
    });

    // Setup, not business logic — see the file header.
    await prisma.user.update({
      where: { id: user.id },
      data: { kycStatus: 'APPROVED', usdtAddress: `SoLDemo${tag}` },
    });

    res.json({ id: user.id, name: user.name, vaultId, currency: ccy });
  } catch (err) {
    next(err);
  }
});

export default router;
