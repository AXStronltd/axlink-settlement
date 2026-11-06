/**
 * Seed the reference sandbox tenant — AxLink Reference Institution (`axlink-reference`) — so the
 * portal and the tests have something real to connect to. It is an internal stand-in, not a client:
 * real institutions are created by operations after onboarding and receive keys only then. Idempotent: re-running reuses the institution, environment and wallet and
 * issues a fresh API key only when asked (`--new-key`) or when none exists yet.
 *
 *   npm run seed:sandbox             → prints the key once (on a terminal)
 *   npm run seed:sandbox -- --new-key  → revokes nothing, issues another key
 *
 * Nothing here touches production custody: the wallet is created on the SANDBOX environment and the
 * custody stub issues its vault; with real sandbox credentials the same call creates a real vault.
 */
import { prisma } from '../packages/core/ledger/ledger.service';
import { createInstitution, issueCredential } from '../packages/core/institutions/institution.service';
import { createWallet } from '../packages/core/wallets/wallet.service';
import { ApiError } from '../packages/shared/errors';

export const REFERENCE = { slug: 'axlink-reference', legalName: 'AxLink Reference Institution (sandbox)', country: 'KE', kind: 'BANK' as const, contactEmail: 'ops@axlink.network' };
/** @deprecated name kept for older scripts */
export const GALAXY = REFERENCE;
export const PORTAL_SCOPES = ['wallets:read', 'wallets:write', 'deposits:read', 'deposits:write', 'settlements:read', 'counterparties:read', 'counterparties:write', 'transfers:read', 'transfers:write', 'ledger:read', 'webhooks:read', 'webhooks:write'];

export async function seedSandbox(opts: { newKey?: boolean; walletLabel?: string } = {}): Promise<{ institutionId: string; environmentId: string; walletId: string; apiKey: string | null }> {
  // Never against production: this issues a broad sandbox key and, with real custody credentials, creates a real vault.
  if (process.env.NODE_ENV === 'production' && !process.argv.includes('--allow-production')) throw new Error('seed-sandbox refuses to run with NODE_ENV=production (pass --allow-production if you really mean it)');
  let inst = await prisma.institution.findUnique({ where: { slug: REFERENCE.slug } });
  if (!inst) { inst = await createInstitution(REFERENCE); inst = await prisma.institution.update({ where: { id: inst.id }, data: { status: 'ACTIVE' } }); }
  // An institution operations suspended stays suspended; the seed never re-activates.
  if (inst.status !== 'ACTIVE') throw new Error(`reference institution is ${inst.status}; operations must re-activate it explicitly`);
  const env = await prisma.apiEnvironment.findUniqueOrThrow({ where: { institutionId_kind: { institutionId: inst.id, kind: 'SANDBOX' } } });

  const label = opts.walletLabel ?? 'Treasury';
  let wallet = await prisma.wallet.findFirst({ where: { environmentId: env.id, label } });
  if (!wallet) {
    try { wallet = await createWallet({ institutionId: inst.id, environmentKind: 'SANDBOX', label }); }
    catch (e) { if (e instanceof ApiError && e.code === 'WALLET_EXISTS') wallet = (await prisma.wallet.findFirst({ where: { environmentId: env.id, label } }))!; else throw e; }
  }

  const existingKeys = await prisma.apiCredential.count({ where: { environmentId: env.id, revokedAt: null } });
  let apiKey: string | null = null;
  if (opts.newKey || existingKeys === 0) {
    const r = await issueCredential(inst.id, 'SANDBOX', `portal ${new Date().toISOString().slice(0, 10)}`, PORTAL_SCOPES);
    apiKey = r.rawKey;
  }
  return { institutionId: inst.id, environmentId: env.id, walletId: wallet.id, apiKey };
}

if (require.main === module) {
  seedSandbox({ newKey: process.argv.includes('--new-key') })
    .then(r => {
      console.log(`Reference sandbox institution ${r.institutionId}, wallet ${r.walletId}`);
      if (!r.apiKey) console.log('An active key already exists; pass --new-key to issue another (keys are never revoked by this script).');
      else if (process.stdout.isTTY || process.argv.includes('--print-key')) console.log(`API key (shown once — paste it into the portal sign-in):\n${r.apiKey}`);
      else console.log('API key issued but not printed (stdout is not a terminal); re-run with --print-key to print it.');
      return prisma.$disconnect();
    })
    .catch(e => { console.error(e); process.exit(1); });
}
