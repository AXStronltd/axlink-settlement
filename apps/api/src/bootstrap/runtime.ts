import type { AppConfig } from '../../../../packages/shared/config';

/** Process-only startup. Importing the HTTP app never registers providers or starts workers.
 * Legacy provider registrations are preserved for regression compatibility; Leg B is frozen.
 */
export async function startRuntime(cfg: AppConfig): Promise<void> {
  // Wallet custody adapter (Step 2): core never imports the provider; it is handed in here.
  const { setWalletCustody } = await import('../../../../packages/core/wallets/wallet.service');
  const { fireblocksWalletCustody } = await import('../../../../packages/providers/custody/fireblocks/fireblocks.wallet-custody');
  setWalletCustody(fireblocksWalletCustody);
  await import('./lp.bootstrap');
  await import('./baas.bootstrap');
  const { startPaymentValidator } = await import('../../../../packages/settlement/transfers/payment-validator.service');
  await startPaymentValidator();
  if (cfg.SETTLEMENT_WORKER_ENABLED) {
    const { startResumeWorker } = await import('../../../../packages/settlement/orchestration/resume.worker');
    startResumeWorker();
  }
  if (cfg.OUTBOX_WORKER_ENABLED) {
    const { startOutboxWorker } = await import('../../../../packages/core/events/outbox.service');
    startOutboxWorker();
  }
}
