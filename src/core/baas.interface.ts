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
 *  FinCruse never pre-funds corridor accounts.  Instead, for each
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
   * If true: provider handles USDT→fiat conversion + delivery atomically.
   * Registry passes usdtAmount in BaaSPayoutParams and skips B2BinPay JIT step.
   * (Thunes, direct MoMo FX providers)
   *
   * If false: registry converts USDT→fiat via B2BinPay first, then calls sendPayout.
   * Provider just needs to deliver the fiat amount.
   * (Daraja, ChoiceBank, Brainrock)
   */
  readonly atomicJit: boolean;

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

  /** Execute the payout. Idempotent — reference is the AxLink trackingId. */
  sendPayout(params: BaaSPayoutParams): Promise<BaaSPayoutResult>;
}
