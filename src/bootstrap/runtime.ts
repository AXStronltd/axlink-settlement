import type { AppConfig } from '../platform/config';

/** Process-only startup. Importing the HTTP app never registers providers or starts workers.
 * Legacy provider registrations are preserved for regression compatibility; Leg B is frozen.
 */
export async function startRuntime(cfg: AppConfig): Promise<void> {
  await import('./lp.bootstrap');
  await import('./baas.bootstrap');
  const { startPaymentValidator } = await import('../core/payment-validator.service');
  await startPaymentValidator();
  if (cfg.SETTLEMENT_WORKER_ENABLED) {
    const { startResumeWorker } = await import('../core/settlement/resume.worker');
    startResumeWorker();
  }
  if (cfg.OUTBOX_WORKER_ENABLED) {
    const { startOutboxWorker } = await import('../core/outbox.service');
    startOutboxWorker();
  }
}
