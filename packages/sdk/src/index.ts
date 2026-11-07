/**
 * @axlink/sdk — AxLink Settlement Network Institution SDK
 *
 * @example
 * ```ts
 * import { AxLinkClient, verifyAxLinkWebhook } from '@axlink/sdk';
 *
 * const axlink = new AxLinkClient({
 *   baseUrl: 'https://axlink-settlement.onrender.com',
 *   apiKey: process.env.AXLINK_API_KEY!,
 * });
 * ```
 */

// Client + types
export {
  AxLinkClient,
  AxLinkError,
  type AxLinkClientOptions,
  type Institution,
  type InstitutionMe,
  type Asset,
  type Network,
  type AssetsResponse,
  type Wallet,
  type WalletBalance,
  type DepositAddress,
  type DepositInstruction,
  type DepositStatus,
  type SettlementProof,
  type Balance,
  type BalancesResponse,
  type Transfer,
  type TransferStatus,
  type TransferStage,
  type TransferCreateParams,
  type SettlementStatus,
  type DepositInstructionStage,
  type Counterparty,
  type LedgerEntry,
  type WebhookEndpoint,
  type WebhookDelivery,
  type Pagination,
} from './client';

// Webhook verification + event types
export {
  verifyAxLinkWebhook,
  AxLinkWebhookVerificationError,
  type AxLinkWebhookEvent,
  type WebhookEventType,
  type DepositReceivedEvent,
  type DepositSettledEvent,
  type DepositRejectedEvent,
  type DepositExpiredEvent,
  type TransferSubmittedEvent,
  type TransferSettledEvent,
  type TransferFailedEvent,
  type SettlementReceivedEvent,
  type DepositEventData,
  type TransferEventData,
  type SettlementEventData,
} from './webhook-verify';

export { default } from './client';
