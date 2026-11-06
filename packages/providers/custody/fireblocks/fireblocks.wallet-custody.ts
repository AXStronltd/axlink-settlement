/** Fireblocks implementation of the wallet custody interface (registered at boot). */
import type { WalletCustody } from '../../../core/wallets/wallet.service';
import { providerAssetId } from '../../../core/assets/registry';
import { randomBytes } from 'crypto';
import { createVaultAccount, createVaultAssetAddress, isConfigured } from './fireblocks';

export const fireblocksWalletCustody: WalletCustody = {
  provider: 'fireblocks',
  configured: () => isConfigured(),
  async createVault(label, clientRef) {
    if (!isConfigured()) return { vaultId: `vault_sbx_${clientRef.slice(0, 12)}_${randomBytes(6).toString('hex')}` };
    const v = await createVaultAccount(label, true);
    if (!v.id || String(v.id).includes('_sandbox_')) throw new Error('Fireblocks did not return a real vault id');
    return { vaultId: String(v.id) };
  },
  async createDepositAddress(vaultId, asset) {
    if (!isConfigured()) return { address: `sbx_${asset.network}_${vaultId}`.slice(0, 44) };
    return createVaultAssetAddress(vaultId, providerAssetId('fireblocks', asset.id));
  },
};
