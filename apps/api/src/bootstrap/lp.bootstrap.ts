// ── AxLink LP Bootstrap ───────────────────────────────────────────────────────
// Registers all Liquidity Providers into the JIT RFQ system at startup.
// Import ONCE in index.ts after dotenv.config() so env vars are loaded.
//
// Adding a new LP: implement ILiquidityProvider, import here, call registerLP().
// The RFQ broadcast picks it up automatically — zero other code changes.
//
// Current LPs:
//   1. AxLink Internal  — built-in fallback, any pair in AxLink's rate table
//   2. B2BinPay         — fiat liquidity, major + African corridor rates
//   Future: Kraken, Binance, Coinbase Prime, any institutional LP

import { registerLP } from '../../../../packages/providers/registry/lp-registry.service';
import { axlinkInternalLP } from '../../../../packages/settlement/fx-quotes/fx.service';
import { b2binpayLP } from '../../../../packages/providers/liquidity/b2binpay/b2binpay';
import { axlinkFireblocksLP } from '../../../../packages/providers/custody/fireblocks/fireblocks.lp';

registerLP(axlinkFireblocksLP); // AxLink's own USDT vault — bids when it has capacity; direct settlement when it wins
registerLP(b2binpayLP);         // external fiat LP — competes on corridor rates
registerLP(axlinkInternalLP);   // always-available rate-table fallback (last resort)

console.log('[AxLink] JIT RFQ system ready — 3 LPs registered (Fireblocks vault + B2BinPay + AxLink internal)');
