/**
 * AxLink BaaS Provider Interface
 *
 * Every fiat payout partner implements this interface.
 * AxLink's core picks the best provider automatically — lowest fee,
 * fastest delivery, correct method (mobile vs bank vs card).
 *
 * ══════════════════════════════════════════════════════════════════════
 *  JIT LIQUIDITY MODEL (zero pre-funded corridors)
 *
 *  AxLink never pre-funds corridor accounts.  Instead, for each
 *  withdrawal the registry triggers a real-time USDT→fiat conversion
 *  (via B2BinPay or the winning LP) and immediately delivers fiat.
 *
 *  Two provider types:
 *    atomic:     provider handles conversion + delivery in one call
 *                (Thunes, direct MoMo APIs with FX capability)
 *    two-phase:  registry converts via B2BinPay first, then calls
 *                sendPayout with the funded fiat amount
 *                (Daraja, ChoiceBank, Brainrock)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  NO SWIFT.  All settlement is on AxLink (Solana/Fireblocks).
 *  External providers only ever receive: "send X currency to Y destination".
 */

// ── Delivery method ───────────────────────────────────────────────────────────

export type PayoutMethod =
  | 'mobile_money'    // M-Pesa, MTN MoMo, Orange Money, Wave, Airtel, etc.
  | 'bank_transfer'   // Bank account (sort code, IBAN, ACH routing, etc.)
  | 'card'            // Visa/Mastercard push-to-card (coming: Thunes Card)
  | 'cash'            // Cash pickup at agent network
  | 'wallet';         // Digital wallet (WeChat Pay, Alipay — via Thunes)

export type MobileProvider =
  | 'mpesa'           // Safaricom (Kenya, Tanzania, DRC, Mozambique, Egypt, Ghana)
  | 'mtn'             // MTN MoMo (Ghana, Nigeria, Uganda, Rwanda, Zambia, Cameroon, etc.)
  | 'orange'          // Orange Money (Mali, Senegal, Côte d'Ivoire, Cameroon, etc.)
  | 'airtel'          // Airtel Money (Uganda, Rwanda, Tanzania, Zambia, Malawi)
  | 'wave'            // Wave (Senegal, Côte d'Ivoire, Mali, Burkina Faso)
  | 'momo'            // Generic MoMo (used when provider not specified)
  | 'tigostar'        // Tigo/Star (Tanzania, Rwanda, Ghana)
  | 'zamtel'          // Zamtel Kwacha (Zambia)
  | 'glo'             // Glo (Nigeria)
  | 'evc'             // EVC Plus — Hormuud (Somalia). The dominant rail there.
  | 'zaad'            // ZAAD — Telesom (Somaliland)
  | 'sahal'           // Sahal — Golis (Puntland)
  | 'wechat'          // WeChat Pay (China)
  | 'alipay';         // Alipay (China)

// ── Unified payout destination ────────────────────────────────────────────────

export interface PaymentDestination {
  name: string;

  // How to deliver — mobile_money, bank_transfer, card, cash, wallet
  method?: PayoutMethod;

  // Mobile money
  mobileNumber?:   string;
  mobileProvider?: MobileProvider;    // which network (mpesa, mtn, orange…)

  // Bank transfer
  accountNumber?:     string;
  bankCode?:          string;
  bankAccountNumber?: string;         // alias used by some providers

  // UK Faster Payments
  sortCode?:          string;

  // SEPA / IBAN (EU/international)
  iban?:              string;
  bic?:               string;

  // USA — ACH
  routingNumber?:     string;

  // Canada — EFT
  transitNumber?:     string;
  institutionNumber?: string;

  // Card push
  cardNumber?:        string;

  // Routing hints
  countryCode?:       string;   // ISO 3166-1 alpha-2: 'KE', 'NG', 'CN', 'GB'
  type?:              string;   // legacy Brainrock rail type — kept for compat
}

// ── Deposit source (inbound from user) ───────────────────────────────────────

export type DepositMethod =
  | 'stk_push'        // M-Pesa STK Push (Kenya)
  | 'mobile_money'    // Other mobile money (MTN, Orange, etc.)
  | 'virtual_iban'    // Brainrock virtual IBAN (EU/UK)
  | 'virtual_account' // ChoiceBank virtual account (Africa)
  | 'bank_transfer'   // Generic bank transfer
  | 'card';           // Card deposit (coming)

export interface DepositSource {
  method:           DepositMethod;
  mobileProvider?:  MobileProvider;
  countryCode?:     string;
  currency:         string;
  amount:           number;
  reference:        string;    // provider's transaction ID
}

// ── Beneficiary validation ───────────────────────────────────────────────────

export interface BeneficiaryCheck {
  currency: string;
  destination: PaymentDestination;
}

export interface BeneficiaryVerdict {
  /**
   * True only when the partner positively confirmed the account. An error, a
   * timeout or an unsupported rail is not a verification — it is an absence of
   * one, and must not be read as a pass.
   */
  verified: boolean;

  /**
   * The name the partner holds for the account.
   *
   * Worth surfacing to whoever is sending: an account number can be valid and
   * still belong to the wrong person, and the name is the only signal that
   * distinguishes the two.
   */
  accountName?: string;

  /** The partner's own reason when it refuses. */
  reason?: string;
}

// ── Collection — asking a partner to take money in ───────────────────────────

export interface CollectionRequest {
  currency: string;
  /**
   * Omitted for a standing instrument such as a virtual IBAN, which accepts
   * whatever the customer sends. Required for anything that names a figure —
   * an STK push, a card session.
   */
  amount?: number;
  method: DepositMethod;
  /** Our user, so the partner can be asked for their standing instrument. */
  customerRef: string;
  /** Our tracking id. Echoed back on the webhook that confirms payment. */
  reference: string;
  countryCode?: string;
  /** Where to send a push — the payer's own number, not a beneficiary's. */
  mobileNumber?: string;
  /** Where to return the customer after a hosted payment page. */
  returnUrl?: string;
}

/**
 * How the customer is told to pay.
 *
 * Three genuinely different shapes, not one with optional fields: a virtual
 * IBAN is an account that already exists and waits, a hosted page is a link
 * that expires, and an STK push is a prompt already on someone's phone. A
 * caller must handle the one it gets, and a shared shape with everything
 * optional would let it forget.
 */
export type CollectionInstructions =
  | {
      kind: 'bank_account';
      accountNumber?: string;
      iban?: string;
      bic?: string;
      bankName?: string;
      /** The customer must quote this, or the credit cannot be attributed. */
      reference: string;
    }
  | { kind: 'redirect'; url: string; expiresAt?: string }
  | { kind: 'push'; sentTo: string };

export interface CollectionResult {
  providerId: string;
  /** The partner's own id for this collection. */
  collectionId: string;
  /**
   * AWAITING_PAYMENT — the customer has not paid yet.
   * PROCESSING       — the partner has the money and is clearing it.
   *
   * Never COMPLETED from this call. Money is confirmed by the partner's
   * webhook and proved before the ledger moves; a partner saying "created"
   * is not a customer having paid.
   */
  status: 'AWAITING_PAYMENT' | 'PROCESSING';
  instructions: CollectionInstructions;
  expiresAt?: string;
}

// ── BaaS Quote ────────────────────────────────────────────────────────────────

export interface BaaSQuote {
  providerId:        string;
  currency:          string;
  amount:            number;
  fee:               number;           // AxLink's cost in USD
  feePercent:        number;
  estimatedMinutes:  number;
  validUntil:        number;           // ms timestamp
}

// ── Payout params ─────────────────────────────────────────────────────────────

export interface BaaSPayoutParams {
  currency:      string;
  amount:        number;
  destination:   PaymentDestination;
  reference:     string;
  description:   string;
  usdtAmount?:   number;   // provided for atomic JIT providers
}

// ── Payout result ─────────────────────────────────────────────────────────────

export interface BaaSPayoutResult {
  providerId:        string;
  paymentId:         string;
  status:            string;
  estimatedMinutes?: number;
}

// ── The interface every BaaS provider must implement ─────────────────────────

export interface IBaaSProvider {
  readonly id:                   string;
  readonly name:                 string;
  readonly supportedCurrencies:  string[];

  /**
   * Structured capability. Strongly preferred over `atomicJit`, which cannot
   * express the ordinary case of "fund me in USD, I deliver KES" and therefore
   * made every local-currency corridor unreachable.
   *
   * Omit it and one is derived from the legacy fields — see
   * `provider/capability.ts`. The derived version deliberately does NOT infer
   * crypto licensing, so a legacy `atomicJit: true` provider fails closed
   * rather than continuing to receive crypto on an assumption.
   */
  readonly capability?: import('./provider/capability').ProviderCapability;

  /**
   * If true: provider handles USDT→fiat conversion + delivery atomically.
   * Registry passes usdtAmount in BaaSPayoutParams and skips the JIT step.
   * (Thunes, direct MoMo FX providers)
   *
   * If false: the converter produces the settlement currency first, then
   * sendPayout delivers it. (Daraja, ChoiceBank, Brainrock)
   *
   * @deprecated Superseded by `capability.settlementCurrencies`. Optional so a
   * new provider need not declare a legacy flag it does not use; treated as
   * false when omitted. Retained because `deriveCapability` still reads it for
   * providers that predate the capability model.
   */
  readonly atomicJit?: boolean;

  /**
   * Fine-grained check — does this provider handle THIS currency + method + destination?
   * Daraja: needs mobileNumber.
   * ChoiceBank bank: needs accountNumber + bankCode.
   * Brainrock: needs IBAN / sort code / routing.
   * MTN MoMo: needs mobileNumber, method = mobile_money.
   */
  canHandle(currency: string, destination: PaymentDestination): boolean;

  /**
   * Fee quote. Used to pick the cheapest/fastest provider when multiple can handle.
   */
  getQuote(currency: string, amount: number, destination: PaymentDestination): Promise<BaaSQuote>;

  /**
   * Execute the payout. Idempotent — reference is the AxLink trackingId.
   *
   * Optional, because a provider should not be forced to implement a capability
   * it does not have: a collection-only or conversion-only partner has no
   * payout to make. Declare `PAYOUT` in `capability.operations` and the
   * orchestrator will only route payouts to providers that implement this; omit
   * it, and the registry refuses the registration rather than discovering the
   * gap at payment time.
   */
  sendPayout?(params: BaaSPayoutParams): Promise<BaaSPayoutResult>;

  /**
   * Resolve a beneficiary before paying them.
   *
   * Several partners can confirm that an account exists and return the name on
   * it — GIB verifies a SIPS beneficiary, and Flutterwave and Choice Bank offer
   * the same. It is the one check that catches a wrong account number *before*
   * money moves, which is the only point at which it is cheap to catch.
   *
   * Optional: a partner that cannot do this is not thereby unusable, it simply
   * offers no pre-flight. Callers must treat an absent method as "unknown",
   * never as "verified".
   */
  validateBeneficiary?(request: BeneficiaryCheck): Promise<BeneficiaryVerdict>;

  /**
   * Take money in from a customer.
   *
   * Optional, like `sendPayout`: a payout-only partner has nothing to collect.
   * Declare `COLLECTION` in `capability.operations` and the registry requires
   * this at registration rather than discovering it when a customer is waiting
   * to fund an account.
   *
   * Returns instructions, not a credit. The ledger moves when the partner's
   * webhook confirms and the settlement engine proves it — never on the
   * strength of this call returning.
   */
  collect?(request: CollectionRequest): Promise<CollectionResult>;

  /**
   * Is this provider actually reachable?
   *
   * Optional, but its absence is reported as UNCONFIGURED rather than assumed
   * healthy — see `provider/health.ts`. The adapter is the only thing that
   * knows whether its credentials are real, so this cannot be answered from
   * outside it.
   */
  healthCheck?(): Promise<import('./provider/health').AdapterHealth>;
}
