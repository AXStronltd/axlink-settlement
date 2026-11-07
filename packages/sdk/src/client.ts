/**
 * AxLink Settlement Network — Institution SDK
 *
 * A typed TypeScript client for the AxLink v1 API.
 * Drop it into your backend; every method maps 1:1 to an API endpoint.
 *
 * @example
 * ```ts
 * import { AxLinkClient } from '@axlink/sdk';
 *
 * const axlink = new AxLinkClient({
 *   baseUrl: 'https://axlink-settlement.onrender.com',
 *   apiKey: process.env.AXLINK_API_KEY!,
 * });
 *
 * // Initiate a settlement of 10,000 USDT to a counterparty
 * const result = await axlink.settlements.create({
 *   counterpartyId: 'cp_galaxybank_01',
 *   assetId: 'USDT_SOL',
 *   amount: '10000',
 *   note: 'Invoice INV-2026-001',
 * });
 * console.log(result.settlementId, result.status);
 * ```
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AxLinkClientOptions {
  /** Base URL of the AxLink API, e.g. https://axlink-settlement.onrender.com */
  baseUrl: string;
  /** Institution API key (Bearer token) */
  apiKey: string;
  /** Optional: timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
}

export interface Institution {
  id: string;
  slug: string;
}

export interface InstitutionMe {
  institution: Institution;
  environment: 'SANDBOX' | 'PRODUCTION';
  scopes: string[];
}

export interface Asset {
  id: string;
  symbol: string;
  network: string;
  contract: string;
  decimals: number;
}

export interface Network {
  id: string;
  family: string;
  finality: string;
}

export interface AssetsResponse {
  assets: Asset[];
  networks: Network[];
}

export interface Wallet {
  id: string;
  label: string;
  network: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  depositAddress: string | null;
  custody: { provider: string; vaultId: string };
  environment?: 'SANDBOX' | 'PRODUCTION';
  balances?: WalletBalance[];
  createdAt: string;
}

export interface WalletBalance {
  asset: 'USDC_SOL' | 'USDT_SOL';
  /** Authoritative (from the journal), decimal string. */
  available: string;
  pending: string;
  updatedAt?: string;
}

export interface DepositAddress {
  walletId: string;
  network: string;
  address: string;
  assets: string[];
  custody: { provider: string; vaultId: string };
  note: string;
}

/** Public status of a deposit or transfer. The detailed stage is in `instructionStatus` / `stage`. */
export type SettlementStatus = 'PROCESSING' | 'COMPLETED' | 'FAILED';
export type DepositStatus = SettlementStatus;
export type DepositInstructionStage = 'PENDING' | 'RECEIVED' | 'SETTLED' | 'EXPIRED' | 'CANCELLED';

/** Custody evidence and on-chain finality, stated separately. */
export interface SettlementProof {
  custodyTxId: string | null;
  txHash: string | null;
  explorerUrl: string | null;
  finality: 'PENDING' | 'CUSTODY_CONFIRMED' | 'ON_CHAIN_FINALIZED' | 'SANDBOX_SIMULATED' | 'UNDER_REVIEW' | string;
  slot?: string | number | null;
}

export interface DepositInstruction {
  id: string;
  kind: 'DEPOSIT';
  status: DepositStatus;
  instructionStatus: DepositInstructionStage;
  walletId: string;
  asset: 'USDC_SOL' | 'USDT_SOL';
  expectedAmount: string;
  receivedAmount: string | null;
  reference: string | null;
  /** Put this in your custody transfer's external id when your custodian allows it; otherwise the exact amount matches. */
  trackingId: string;
  depositAddress: string | null;
  expiresAt: string;
  receivedAt: string | null;
  settledAt: string | null;
  createdAt: string;
  attention: { at: string; reason: string } | null;
  proof: SettlementProof | null;
}

export interface Balance {
  asset: 'USDC_SOL' | 'USDT_SOL';
  available: string;
  pending: string;
}

export interface BalancesResponse {
  institutionId: string;
  environment: string;
  balances: Balance[];
}

export type TransferStatus = SettlementStatus;
export type TransferStage =
  | 'AWAITING_APPROVAL' | 'APPROVED' | 'SUBMITTING' | 'SUBMITTED' | 'CONFIRMED' | 'SETTLED'
  | 'UNDER_REVIEW' | 'FAILED' | 'REJECTED' | 'CANCELLED';

export interface Transfer {
  id: string;
  kind: 'TRANSFER';
  status: TransferStatus;
  stage: TransferStage;
  walletId: string;
  counterparty: { id: string; label?: string; address?: string; network?: string };
  asset: 'USDC_SOL' | 'USDT_SOL';
  amount: string;
  reference: string | null;
  idempotencyKey: string;
  approval: { required: boolean; by: string | null; at?: string } | null;
  proof: SettlementProof | null;
  attention?: true;
  reason?: string;
  submittedAt: string | null;
  confirmedAt: string | null;
  settledAt: string | null;
  createdAt: string;
}

export interface Counterparty {
  id: string;
  label: string;
  /** NETWORK = another AxLink institution (vault-to-vault); EXTERNAL = an on-chain address. */
  kind: 'NETWORK' | 'EXTERNAL';
  network: string;
  address: string | null;
  participant: string | null;
  status: 'PENDING_APPROVAL' | 'ACTIVE' | 'DISABLED';
  screening: { verdict: string; provider: string; at: string } | null;
  approvedAt: string | null;
  custodyWhitelisted: boolean;
  note: string | null;
  createdAt: string;
}

export interface LedgerEntry {
  id: string;
  account: string;
  amount: string;
  currency: string;
  entityType: string;
  entityId: string;
  createdAt: string;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  status: 'ACTIVE' | 'DISABLED';
  createdAt: string;
}

export interface WebhookDelivery {
  id: string;
  eventType: string;
  status: 'DELIVERED' | 'FAILED' | 'RETRYING';
  httpStatus?: number;
  attemptedAt: string;
}

export interface Pagination {
  limit?: number;
  cursor?: string;
}

// ── Error ─────────────────────────────────────────────────────────────────────

export class AxLinkError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
  ) {
    super(`AxLink [${code}] ${message}`);
    this.name = 'AxLinkError';
  }
}

// ── HTTP client ───────────────────────────────────────────────────────────────

class Http {
  constructor(private readonly opts: Required<AxLinkClientOptions>) {}

  private url(path: string): string {
    return `${this.opts.baseUrl.replace(/\/$/, '')}/api/v1${path}`;
  }

  async request<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs);

    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method,
        headers: {
          'Authorization': `Bearer ${this.opts.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...extraHeaders,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError') throw new AxLinkError(0, 'TIMEOUT', `Request timed out after ${this.opts.timeoutMs}ms`);
      throw new AxLinkError(0, 'NETWORK_ERROR', e.message);
    } finally {
      clearTimeout(timeout);
    }

    const json = await res.json().catch(() => ({})) as Record<string, unknown>;

    if (!res.ok) {
      const err = (json.error as Record<string, string> | undefined) ?? {};
      throw new AxLinkError(
        res.status,
        String(err.code ?? 'API_ERROR'),
        String(err.message ?? json.message ?? `HTTP ${res.status}`),
        res.headers.get('x-request-id') ?? undefined,
      );
    }

    return json as T;
  }

  get<T>(path: string)                       { return this.request<T>('GET',    path); }
  post<T>(path: string, body: unknown, headers?: Record<string, string>) { return this.request<T>('POST', path, body, headers); }
  delete<T>(path: string, body?: unknown)    { return this.request<T>('DELETE', path, body); }
}

/** Body of POST /v1/transfers and /v1/settlements. */
export interface TransferCreateParams {
  /** Your wallet the funds leave from. */
  walletId: string;
  counterpartyId: string;
  asset: 'USDC_SOL' | 'USDT_SOL';
  /** Decimal string, at most the asset's 6 decimals. */
  amount: string;
  reference?: string;
  /** Sent as the Idempotency-Key header. */
  idempotencyKey: string;
}

// ── Resource clients ──────────────────────────────────────────────────────────

class InstitutionsResource {
  constructor(private readonly http: Http) {}

  /** Who am I — institution profile, environment, and API scopes. */
  me(): Promise<InstitutionMe> {
    return this.http.get('/institutions/me');
  }
}

class AssetsResource {
  constructor(private readonly http: Http) {}

  /** Supported assets (USDC_SOL, USDT_SOL) and networks (Solana). */
  list(): Promise<AssetsResponse> {
    return this.http.get('/assets');
  }
}

class WalletsResource {
  constructor(private readonly http: Http) {}

  /** Provision a new institutional wallet (Fireblocks custody vault). */
  create(params: { label: string; network?: string }): Promise<Wallet> {
    return this.http.post('/wallets', params);
  }

  /** List your wallets in this environment. */
  list(): Promise<Wallet[]> {
    return this.http.get('/wallets');
  }

  /** One wallet with balances. */
  get(id: string): Promise<Wallet & { balances: WalletBalance[] }> {
    return this.http.get(`/wallets/${id}`);
  }

  /** Request the receiving address for a wallet (one address accepts all supported assets). */
  depositAddress(params: { walletId: string; asset?: 'USDC_SOL' | 'USDT_SOL' }): Promise<DepositAddress> {
    return this.http.post('/custody/deposit-addresses', params);
  }

  /** Designate this wallet as the default receiver for incoming network settlements. */
  setSettlementDefault(id: string): Promise<{ settlementWalletId: string; environment: string }> {
    return this.http.post(`/wallets/${id}/settlement-default`, {});
  }
}

class DepositsResource {
  constructor(private readonly http: Http) {}

  /**
   * Announce an incoming on-chain deposit.
   * AxLink watches for it, verifies the mint and amount, and emits deposit.settled.
   */
  announce(params: {
    walletId: string;
    asset: 'USDC_SOL' | 'USDT_SOL';
    /** Exact amount you will send, as a decimal string (e.g. "10000" or "250.5"). The receipt must match it. */
    amount: string;
    /** Your own reference, echoed on events. */
    reference?: string;
    /** How long the instruction stays open (default 72h, max 720h). */
    ttlHours?: number;
  }): Promise<DepositInstruction> {
    return this.http.post('/deposits', params);
  }

  /** List deposit instructions (newest first). */
  list(params?: { status?: DepositInstructionStage }): Promise<DepositInstruction[]> {
    const q = new URLSearchParams();
    if (params?.status) q.set('status', params.status);
    return this.http.get(`/deposits${q.size ? `?${q}` : ''}`);
  }

  /** One deposit instruction by id. */
  get(id: string): Promise<DepositInstruction> {
    return this.http.get(`/deposits/${id}`);
  }

  /** Cancel a PENDING instruction. */
  cancel(id: string): Promise<DepositInstruction> {
    return this.http.post(`/deposits/${id}/cancel`, {});
  }
}

class SettlementsResource {
  constructor(private readonly http: Http) {}

  /**
   * Get settlement status and on-chain proof.
   * Answers for both deposit instructions and outbound transfers.
   */
  get(id: string): Promise<{ id: string; status: TransferStatus | DepositStatus; proof?: SettlementProof }> {
    return this.http.get(`/settlements/${id}`);
  }

  /**
   * Settle to a counterparty (the blueprint's POST /v1/settlements; same contract as transfers.create).
   * For a network counterparty the funds move vault-to-vault inside custody and the receiver is credited
   * at on-chain finality.
   */
  async create(params: TransferCreateParams): Promise<Transfer> {
    const { idempotencyKey, ...body } = params;
    if (!idempotencyKey) throw new AxLinkError(0, 'IDEMPOTENCY_KEY_REQUIRED', 'settlements.create needs an idempotencyKey');
    return this.http.post('/settlements', body, { 'Idempotency-Key': idempotencyKey });
  }
}

class CounterpartiesResource {
  constructor(private readonly http: Http) {}

  /**
   * Register a counterparty — an external wallet address to settle funds to.
   * Counterparties require operator approval before use.
   */
  create(params: { label: string; note?: string; network?: string } & (
    /** Another institution on the AxLink network, by its slug — settled vault-to-vault inside custody. */
    | { participant: string; address?: never }
    /** An external Solana wallet address. */
    | { address: string; participant?: never }
  )): Promise<Counterparty> {
    return this.http.post('/counterparties', params);
  }

  /** List your registered counterparties. */
  list(): Promise<Counterparty[]> {
    return this.http.get('/counterparties');
  }

  /** One counterparty by id. */
  get(id: string): Promise<Counterparty> {
    return this.http.get(`/counterparties/${id}`);
  }

  /** Disable a counterparty (re-enabling requires operator action). */
  disable(id: string): Promise<void> {
    return this.http.delete(`/counterparties/${id}`);
  }
}

class TransfersResource {
  constructor(private readonly http: Http) {}

  /**
   * Initiate an outbound settlement of USDC or USDT to a registered counterparty.
   * This is the primary action of the AxLink API.
   *
   * @param params.idempotencyKey - Required. Retrying with the same key returns the original transfer and never
   *   pays twice; use a fresh key for a new payment (e.g. your payment instruction id).
   */
  async create(params: TransferCreateParams): Promise<Transfer> {
    const { idempotencyKey, ...body } = params;
    if (!idempotencyKey) throw new AxLinkError(0, 'IDEMPOTENCY_KEY_REQUIRED', 'transfers.create needs an idempotencyKey');
    return this.http.post('/transfers', body, { 'Idempotency-Key': idempotencyKey });
  }

  /** List transfers. */
  list(params?: { stage?: TransferStage }): Promise<Transfer[]> {
    const q = new URLSearchParams();
    if (params?.stage) q.set('status', params.stage);
    return this.http.get(`/transfers${q.size ? `?${q}` : ''}`);
  }

  /** Transfer status, stage and on-chain proof. */
  get(id: string): Promise<Transfer> {
    return this.http.get(`/transfers/${id}`);
  }

  /** Cancel a transfer still awaiting approval. */
  cancel(id: string): Promise<Transfer> {
    return this.http.post(`/transfers/${id}/cancel`, {});
  }
}

class LedgerResource {
  constructor(private readonly http: Http) {}

  /**
   * Authorised journal history — entries touching this institution's accounts.
   * Use for reconciliation and audit.
   */
  entries(params?: Pagination & {
    asset?: 'USDC_SOL' | 'USDT_SOL';
    entityType?: string;
    entityId?: string;
  }): Promise<{ entries: LedgerEntry[]; nextCursor: string | null }> {
    const q = new URLSearchParams();
    if (params?.limit)       q.set('limit',      String(params.limit));
    if (params?.cursor)      q.set('cursor',     params.cursor);
    if (params?.asset)       q.set('asset',      params.asset);
    if (params?.entityType)  q.set('entityType', params.entityType);
    if (params?.entityId)    q.set('entityId',   params.entityId);
    return this.http.get(`/ledger/entries?${q}`);
  }
}

class WebhooksResource {
  constructor(private readonly http: Http) {}

  /**
   * Register a signed webhook endpoint.
   * Returns a secret (shown once) — store it; AxLink uses it to sign every delivery.
   * Verify: X-AxLink-Signature: t=<unix>,v1=<HMAC-SHA256(secret, t + "." + body)>
   */
  create(params: {
    url: string;
    events?: Array<
      | 'deposit.received' | 'deposit.settled' | 'deposit.rejected' | 'deposit.expired'
      | 'transfer.submitted' | 'transfer.settled' | 'transfer.failed'
      | 'settlement.received' | '*'
    >;
  }): Promise<WebhookEndpoint & { secret: string; note: string }> {
    return this.http.post('/webhook-endpoints', params);
  }

  /** List your webhook endpoints. */
  list(): Promise<WebhookEndpoint[]> {
    return this.http.get('/webhook-endpoints');
  }

  /** Disable a webhook endpoint. */
  disable(id: string): Promise<void> {
    return this.http.delete(`/webhook-endpoints/${id}`);
  }

  /** Recent deliveries to an endpoint (last 50). */
  deliveries(id: string): Promise<{ deliveries: WebhookDelivery[] }> {
    return this.http.get(`/webhook-endpoints/${id}/deliveries`);
  }
}

// ── Main client ───────────────────────────────────────────────────────────────

/**
 * AxLink Settlement Network — Institution API Client
 *
 * @example
 * ```ts
 * import { AxLinkClient } from '@axlink/sdk';
 *
 * const axlink = new AxLinkClient({
 *   baseUrl: 'https://axlink-settlement.onrender.com',
 *   apiKey: process.env.AXLINK_API_KEY!,
 * });
 *
 * const me = await axlink.institutions.me();
 * // { institution: { id: '...', slug: 'galaxy-bank' }, environment: 'SANDBOX', scopes: [...] }
 *
 * const transfer = await axlink.transfers.create({
 *   counterpartyId: 'cp_....',
 *   assetId: 'USDT_SOL',
 *   amount: '10000',
 *   note: 'Invoice INV-2026-001',
 * });
 * // { id: 'tr_...', status: 'PENDING', ... }
 * ```
 */
export class AxLinkClient {
  readonly institutions: InstitutionsResource;
  readonly assets:       AssetsResource;
  readonly wallets:      WalletsResource;
  readonly deposits:     DepositsResource;
  readonly settlements:  SettlementsResource;
  readonly counterparties: CounterpartiesResource;
  readonly transfers:    TransfersResource;
  readonly ledger:       LedgerResource;
  readonly webhooks:     WebhooksResource;

  constructor(opts: AxLinkClientOptions) {
    const http = new Http({ timeoutMs: 30_000, ...opts });
    this.institutions  = new InstitutionsResource(http);
    this.assets        = new AssetsResource(http);
    this.wallets       = new WalletsResource(http);
    this.deposits      = new DepositsResource(http);
    this.settlements   = new SettlementsResource(http);
    this.counterparties = new CounterpartiesResource(http);
    this.transfers     = new TransfersResource(http);
    this.ledger        = new LedgerResource(http);
    this.webhooks      = new WebhooksResource(http);
  }
}

export default AxLinkClient;
