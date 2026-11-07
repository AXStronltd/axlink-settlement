import type { AppConfig } from '../../../../packages/shared/config';
import { ACTIVE_NETWORK } from '../../../../packages/core/assets/registry';

/** Process-only startup. Importing the HTTP app never registers providers or starts workers.
 * Legacy provider registrations are preserved for regression compatibility; Leg B is frozen.
 */
export async function startRuntime(cfg: AppConfig): Promise<void> {
  // Providers on the ports (Step 2): core never imports a vendor; the registry hands adapters out.
  const { registerCustodyProvider, registerLiquidityProvider, registerBlockchainProvider, freezeProviders } = await import('../../../../packages/providers/registry/provider-registry');
  const { fireblocksCustodyProvider } = await import('../../../../packages/providers/custody/fireblocks/fireblocks.custody-provider');
  const { b2binpayLiquidityProvider } = await import('../../../../packages/providers/liquidity/b2binpay/b2binpay.liquidity-provider');
  const { solanaBlockchainProvider } = await import('../../../../packages/providers/blockchain/solana/solana.blockchain-provider');
  registerCustodyProvider(fireblocksCustodyProvider); registerLiquidityProvider(b2binpayLiquidityProvider); registerBlockchainProvider(ACTIVE_NETWORK, solanaBlockchainProvider);
  freezeProviders(); // replacements after boot: refused in production, SIMULATOR_ENABLED=true elsewhere
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
  // Step 2: expire stale deposit instructions (emits deposit.expired).
  if (process.env.DEPOSIT_SWEEPER_ENABLED !== 'false') {
    const { startDepositInstructionSweeper } = await import('../../../../packages/settlement/deposits/deposit-instruction.service');
    startDepositInstructionSweeper();
    const { startTransferSweeper } = await import('../../../../packages/settlement/transfers/settlement-transfer.service');
    startTransferSweeper();
  }
}
