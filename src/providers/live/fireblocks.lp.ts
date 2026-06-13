/**
 * AxLink Fireblocks LP
 *
 * AxLink's own Fireblocks USDT vault participates in the JIT RFQ as an internal LP.
 * It checks live vault balance before quoting — if capacity is insufficient it does
 * not bid. External LPs (B2BinPay) are always preferred when available. If they go
 * down or lose the race, AxLink Fireblocks wins and settlement goes directly
 * treasury → receiver vault with zero B2BinPay involvement.
 *
 * Tiered execution after RFQ:
 *   lpSource = 'b2binpay'          → B2BinPay on/off-ramp + Fireblocks (current flow)
 *   lpSource = 'axlink-fireblocks' → Fireblocks treasury → receiver vault (direct)
 *   lpSource = 'axlink'            → AxLink rate table; B2BinPay does the exchange
 */

import type { ILiquidityProvider, LPRate, LPQuote } from '../../core/lp.interface';
import { getRate, toUSD } from '../../core/fx.service';
import { getVaultAssetBalance } from './fireblocks';
import { randomUUID } from 'crypto';

const TREASURY_VAULT = process.env.FIREBLOCKS_TREASURY_VAULT ?? '';
const USDT_ASSET     = process.env.FIREBLOCKS_USDT_ASSET ?? 'USDT_SOL';

// Currencies AxLink Fireblocks LP can settle (all pairs AxLink's FX table supports)
const SUPPORTED = new Set([
  'KES', 'NGN', 'GHS', 'ZAR', 'UGX', 'TZS',
  'GBP', 'EUR', 'USD', 'USDT', 'CAD',
]);

function isSandbox(): boolean {
  const key = process.env.FIREBLOCKS_API_KEY ?? '';
  return !key || key.startsWith('your_') || key.startsWith('YOUR_');
}

async function getVaultUsdtBalance(): Promise<number> {
  // In sandbox, use SANDBOX_AXLINK_VAULT_USDT env var (default 0 = LP stays out unless set).
  // Set it to a non-zero value in .env to test the AxLink Fireblocks fallback path.
  if (isSandbox()) {
    return Number(process.env.SANDBOX_AXLINK_VAULT_USDT ?? 0);
  }
  try {
    const asset = await getVaultAssetBalance(TREASURY_VAULT, USDT_ASSET);
    return Number(asset?.available ?? asset?.total ?? 0);
  } catch {
    // If Fireblocks is unreachable, treat as zero capacity so LP drops out of RFQ
    return 0;
  }
}

export const axlinkFireblocksLP: ILiquidityProvider = {
  id:   'axlink-fireblocks',
  name: 'AxLink Fireblocks Vault',

  supportsRate(from: string, to: string): boolean {
    return SUPPORTED.has(from.toUpperCase()) && SUPPORTED.has(to.toUpperCase());
  },

  async getRate(from: string, to: string): Promise<LPRate> {
    const mid    = await getRate(from, to);
    // AxLink Fireblocks offers a tighter spread than axlinkInternalLP (0.002 vs 0.004)
    // because it has zero LP counterparty cost — direct vault settlement
    const spread = mid * 0.002;
    return {
      bid: mid - spread,
      ask: mid + spread,
      mid,
      spread: spread * 2,
      spreadPct: (spread * 2) / mid,
      fetchedAt: Date.now(),
      source: 'axlink-fireblocks',
    };
  },

  async requestQuote(from: string, to: string, fromAmount: number): Promise<LPQuote> {
    const fromN = from.toUpperCase();
    const toN   = to.toUpperCase();

    // 1. Check live Fireblocks vault USDT balance
    const availableUsdt = await getVaultUsdtBalance();

    // 2. How much USDT does this trade need?
    const usdNeeded = await toUSD(fromAmount, fromN);

    if (availableUsdt < usdNeeded) {
      throw new Error(
        `AxLink Fireblocks vault has ${availableUsdt.toFixed(2)} USDT ` +
        `— insufficient for ${usdNeeded.toFixed(2)} USDT trade. Falling through to next LP.`
      );
    }

    // 3. Quote at AxLink's internal rate (tighter spread — no B2BinPay middleman cost)
    const mid    = await getRate(fromN, toN);
    const spread = mid * 0.002;
    const rate   = mid - spread;

    return {
      id:         `axfb_${randomUUID().slice(0, 8)}`,
      from:       fromN,
      to:         toN,
      fromAmount,
      toAmount:   parseFloat((fromAmount * rate).toFixed(8)),
      rate,
      validUntil: Date.now() + 30_000,
      source:     'axlink-fireblocks',
      raw:        { availableUsdt, usdNeeded, vaultId: TREASURY_VAULT },
    };
  },
};
