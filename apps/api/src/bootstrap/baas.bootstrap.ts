/**
 * BaaS provider registration — runs once at startup.
 *
 * AxLink BaaS stack (zero pre-funded, JIT liquidity):
 *
 *  REGION          PROVIDER         METHOD          CURRENCIES
 *  ─────────────── ──────────────── ─────────────── ──────────────────────────
 *  Africa          Daraja           mobile_money    KES, TZS, UGX (Safaricom)
 *  Africa          MTN MoMo         mobile_money    GHS, NGN, UGX, RWF, ZMW, XOF, XAF…
 *  Africa          Orange Money     mobile_money    XOF, XAF, GNF (Francophone)
 *  Africa/China    Choice Bank      bank_transfer   NGN, GHS, ZAR, KES, TZS, RWF, CNY…
 *  EU/UK/USA/CA    Brainrock        bank_transfer   GBP, USD, EUR, CAD, AED, CHF…
 *  Global          Thunes           both            XOF, INR, PHP, BDT, CNY, MXN, BRL…
 *  Global          PSP/Card (stub)  card            Any (Visa Direct, Mastercard Send)
 *
 *  To enable a provider: uncomment its lines below.
 *  To add a new partner: create providers/<name>.baas.ts, import + register here.
 *  Nothing else in the codebase needs to change.
 */

import { registerBaaSProvider } from '../../../../packages/providers/registry/baas-registry.service';

// ── Active providers ──────────────────────────────────────────────────────────

import { DarajaBaaSProvider }     from '../../../../packages/providers/banking/daraja/daraja.baas';
import { ChoiceBankBaaSProvider } from '../../../../packages/providers/banking/choicebank/choicebank.baas';
import { BrainrockBaaSProvider }  from '../../../../packages/providers/banking/brainrock/brainrock.baas';

registerBaaSProvider(new DarajaBaaSProvider());       // M-Pesa: KES, TZS, UGX
registerBaaSProvider(new ChoiceBankBaaSProvider());   // Bank: Africa + CNY
registerBaaSProvider(new BrainrockBaaSProvider());    // Bank: EU, UK, USA, Canada

// ── Enable when credentials are set ──────────────────────────────────────────

// MTN MoMo — covers GHS, NGN, UGX, RWF, ZMW, XOF, XAF and more
// Env: MTNMOMO_PRIMARY_KEY, MTNMOMO_API_USER, MTNMOMO_API_KEY
// import { MtnMomoBaaSProvider } from './providers/mtnmomo.baas';
// registerBaaSProvider(new MtnMomoBaaSProvider());

// Orange Money — XOF (Senegal, CI, Mali, BF), XAF, GNF
// Env: ORANGE_MONEY_CLIENT_ID, ORANGE_MONEY_CLIENT_SECRET, ORANGE_MONEY_MERCHANT_KEY
// import { OrangeMoneyBaaSProvider } from './providers/orange.baas';
// registerBaaSProvider(new OrangeMoneyBaaSProvider());

// Thunes — global atomic JIT: XOF, INR, PHP, BDT, VND, MXN, BRL, CNY…
// Env: THUNES_CLIENT_ID, THUNES_API_KEY
// import { ThunesBaaSProvider } from './providers/thunes.baas';
// registerBaaSProvider(new ThunesBaaSProvider());

// ── Placeholder: PSP / Card processor ────────────────────────────────────────
// To add Visa Direct, Mastercard Send, or any card push provider:
// 1. Create providers/visadirect.baas.ts implementing IBaaSProvider
// 2. Import and uncomment here
// registerBaaSProvider(new VisaDirectBaaSProvider());
