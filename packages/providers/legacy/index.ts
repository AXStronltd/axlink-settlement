/**
 * Legacy facade (Step 2, slice 3).
 *
 * The frozen Leg B services (fiat on-ramp, interbank, treasury, legacy orchestrator) were written
 * against vendor modules directly. They are not being rewritten — they are frozen — but core code
 * must not name a vendor, so they reach the same functions through this one file, via the runtime
 * seam where one exists (so the settlement harness can stub them). When a flow is migrated to the
 * typed ports it stops importing from here; when this file is empty, the facade is deleted.
 */
import { ports } from '../ports/runtime';
import * as b2b from '../liquidity/b2binpay/b2binpay';
import * as brainrock from '../banking/brainrock/brainrock';

/** Custody: vault-to-vault or external transfer through the custodian (seam-routed). */
export const custodyTransfer = (...args: Parameters<ReturnType<typeof ports>['custody']['createTransfer']>) => ports().custody.createTransfer(...args);

/** Converter (B2BinPay) legacy fiat flows (seam-routed). */
export const converterCreateDeposit = (...args: Parameters<typeof b2b.createDeposit>) => ports().converter.createDeposit(...args);
export const converterCreatePayout = (...args: Parameters<typeof b2b.createPayout>) => ports().converter.createPayout(...args);
export const converterPayoutFee = b2b.calculatePayoutFee;

/** Brainrock (fiat on-ramp sessions) — Leg B, frozen. */
export const brainrockCreatePaymentSession = brainrock.createPaymentSession;
export type BrainrockDepositMethod = brainrock.DepositMethod;
