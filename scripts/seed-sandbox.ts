/**
 * Seed the reference sandbox tenant — Galaxy Bank (`galaxy-bank-so`) — so the portal has something
 * real to connect to. Idempotent: re-running reuses the institution, environment and wallet and
 * issues a fresh API key only when asked (`--new-key`) or when none exists yet.
 *
 *   DATABASE_URL=… npx tsx scripts/seed-sandbox.ts            → prints the key once
 *   DATABASE_URL=… npx tsx scripts/seed-sandbox.ts --new-key  → revokes nothing, issues another key
 *
 * Nothing here touches production custody: the wallet is created on the SANDBOX environment and the
 * custody stub issues its vault; with real sandbox credentials the same call creates a real vault.
 */
import { prisma } from '../packages/core/ledger/ledger.service';
import { createInstitution, issueCredential } from '../packages/core/institutions/institution.service';
import { createWallet } from '../packages/core/wallets/wallet.service';
import { ApiError } from '../packages/shared/errors';

export const GALAXY = { slug: 'galaxy-bank-so', legalName: 'Galaxy Bank', country: 'SO', kind: 'BANK' as const, contactEmail: 'ops@galaxybank.so' };
export const PORTAL_SCOPES = ['wallets:read', 'wallets:write', 'deposits:read', 'deposits:write', 'settlements:read', 'counterparties:read', 'counterparties:write', 'transfers:read', 'transfers:write', 'ledger:read', 'webhooks:read', 'webhooks:write'];

export async function seedSandbox(opts: { newKey?: boolean; walletLabel?: string } = {}): Promise<{ institutionId: string; environmentId: string; walletId: string; apiKey: string | null }> {
  let inst = await prisma.institution.findUnique({ where: { slug: GALAXY.slug } });
  if (!inst) inst = await createInstitution(GALAXY);
  if (inst.status !== 'ACTIVE') inst = await prisma.institution.update({ where: { id: inst.id }, data: { status: 'ACTIVE' } });
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
      console.log(`Galaxy Bank sandbox: institution ${r.institutionId}, wallet ${r.walletId}`);
      console.log(r.apiKey ? `API key (shown once — paste it into the portal sign-in):\n${r.apiKey}` : 'An active key already exists; pass --new-key to issue another.');
      return prisma.$disconnect();
    })
    .catch(e => { console.error(e); process.exit(1); });
}
