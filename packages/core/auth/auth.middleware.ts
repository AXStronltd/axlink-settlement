import { createHash, randomBytes } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { prisma } from '../ledger/ledger.service';

// Extend Express Request to carry the authenticated bank
declare global {
  namespace Express {
    interface Request {
      bank?: {
        id: string;
        name: string;
        networkId: string;
        vaultId: string;
        dailyLimitUsd: number;
        corridorLimits: Record<string, number> | null;
        webhookUrl: string | null;
        webhookSecret: string | null;
      };
    }
  }
}

function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

// Middleware for bank API routes — requires Bearer token
export async function requireBankAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Authorization header. Use: Bearer <api-key>', code: 'UNAUTHORIZED' });
    return;
  }

  const rawKey = header.slice(7).trim();
  if (!rawKey) {
    res.status(401).json({ error: 'Empty API key', code: 'UNAUTHORIZED' });
    return;
  }

  const keyHash = hashApiKey(rawKey);
  const bank = await prisma.bank.findUnique({ where: { apiKeyHash: keyHash } });

  if (!bank) {
    res.status(401).json({ error: 'Invalid API key', code: 'UNAUTHORIZED' });
    return;
  }

  if (bank.status !== 'ACTIVE') {
    res.status(403).json({ error: `Bank account is ${bank.status}. Contact AxLink support.`, code: 'BANK_SUSPENDED' });
    return;
  }

  req.bank = {
    id:              bank.id,
    name:            bank.name,
    networkId:       bank.networkId,
    vaultId:         bank.vaultId,
    dailyLimitUsd:   Number(bank.dailyLimitUsd),
    corridorLimits:  bank.corridorLimits as Record<string, number> | null,
    webhookUrl:      bank.webhookUrl,
    webhookSecret:   bank.webhookSecret,
  };

  next();
}

// Generate a random API key and return { rawKey, hash }
// rawKey is shown once at registration; hash is stored in DB
export function generateApiKey(): { rawKey: string; hash: string } {
  const rawKey = `axlk_live_${randomBytes(24).toString('base64url')}`; // CSPRNG — Math.random is not a key source
  return { rawKey, hash: hashApiKey(rawKey) };
}
