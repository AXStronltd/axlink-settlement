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

import { registerLP } from './lp-registry.service';
import { axlinkInternalLP } from './fx.service';
import { b2binpayLP } from './b2binpay.service';

registerLP(axlinkInternalLP); // always-available fallback
registerLP(b2binpayLP);       // fiat liquidity — competes on corridor rates

console.log('[AxLink] JIT RFQ system ready — LPs registered');
