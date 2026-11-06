/**
 * Step 2 backfill: give every legacy User that has a custody vault and an institution a Wallet row,
 * in the institution's SANDBOX environment (production wallets are created deliberately, never
 * backfilled). Idempotent: users already linked (Wallet.legacyUserId) are skipped. Balances start at
 * the user's existing canonical-asset Account balances so the projection matches the ledger.
 *
 *   DATABASE_URL=... npx ts-node scripts/backfill-wallets.ts [--dry-run]
 */
import { prisma } from '../packages/core/ledger/ledger.service';
import { isAssetId } from '../packages/core/assets/registry';

async function main() {
  const dry = process.argv.includes('--dry-run');
  const users = await prisma.user.findMany({ where: { institutionId: { not: null }, wallet: null }, include: { accounts: true } });
  let created = 0;
  for (const u of users) {
    const env = await prisma.apiEnvironment.findUnique({ where: { institutionId_kind: { institutionId: u.institutionId!, kind: 'SANDBOX' } } });
    if (!env) { console.log(`skip ${u.id}: institution ${u.institutionId} has no SANDBOX environment`); continue; }
    // A wallet may already own this vault (created through the API after the user row): link, don't duplicate.
    const existing = await prisma.wallet.findUnique({ where: { custodyProvider_custodyVaultId: { custodyProvider: 'fireblocks', custodyVaultId: u.vaultId } } });
    if (existing) {
      if (existing.institutionId !== u.institutionId) { console.log(`skip ${u.id}: vault ${u.vaultId} belongs to wallet ${existing.id} of another institution — operator review`); continue; }
      if (existing.legacyUserId && existing.legacyUserId !== u.id) { console.log(`skip ${u.id}: wallet ${existing.id} already linked to user ${existing.legacyUserId}`); continue; }
      console.log(`${dry ? '[dry] ' : ''}link user ${u.id} → existing wallet ${existing.id}`);
      if (!dry) await prisma.wallet.update({ where: { id: existing.id }, data: { legacyUserId: u.id } });
      continue;
    }
    const balances = u.accounts.filter(a => isAssetId(a.currency)).map(a => ({ assetId: a.currency, available: a.balance }));
    console.log(`${dry ? '[dry] ' : ''}wallet for user ${u.id} vault ${u.vaultId} institution ${u.institutionId} balances ${JSON.stringify(balances.map(b => [b.assetId, b.available.toString()]))}`);
    if (dry) continue;
    await prisma.wallet.create({ data: { institutionId: u.institutionId!, environmentId: env.id, label: u.name || u.email, custodyVaultId: u.vaultId, network: 'solana-mainnet', legacyUserId: u.id, balances: { create: balances } } });
    created++;
  }
  console.log(`${created} wallet(s) created, ${users.length - created} skipped`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
