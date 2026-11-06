import { Router, Request, Response } from 'express';

const router = Router();

// AxLink rate table — mirrors fx.service.ts AXLINK_SANDBOX_RATES
const RATES: Record<string, number> = {
  KES: 129.0, UGX: 3745.0, NGN: 1587.0, GHS: 16.1,
  ZAR: 18.5, TZS: 2680.0, GBP: 0.787, EUR: 0.926,
  USD: 1.0, USDT: 1.0, CAD: 1.37,
};

const AXLINK_SPREAD = 0.018; // 1.8% AxLink spread baked into customer rate

function toUSD(amount: number, currency: string): number {
  return amount / (RATES[currency] ?? 1);
}
function fromUSD(usd: number, currency: string): number {
  return usd * (RATES[currency] ?? 1);
}

function collectionRail(currency: string): string {
  if (currency === 'KES') return 'Daraja (M-Pesa Kenya)';
  if (['NGN', 'GHS', 'ZAR', 'UGX', 'TZS'].includes(currency)) return 'Choice Bank';
  return 'Brainrock';
}
function payoutRail(currency: string): string {
  if (currency === 'KES') return 'Daraja';
  if (['NGN', 'GHS', 'ZAR', 'UGX', 'TZS'].includes(currency)) return 'Choice Bank';
  return 'Brainrock';
}
function payoutLayer(currency: string): 'DARAJA' | 'CHOICE BANK' | 'BRAINROCK' {
  if (currency === 'KES') return 'DARAJA';
  if (['NGN', 'GHS', 'ZAR', 'UGX', 'TZS'].includes(currency)) return 'CHOICE BANK';
  return 'BRAINROCK';
}

const SYM: Record<string, string> = {
  GBP: '£', USD: '$', KES: 'KSh ', NGN: '₦', GHS: 'GH₵', EUR: '€', ZAR: 'R', UGX: 'USh ', TZS: 'TSh ',
};

interface SimStep {
  step: number; total: number; layer: string; action: string; detail: string;
  money: { label: string; amount: string; currency: string; direction: 'debit' | 'credit' | 'move' | 'info' }[];
  status: 'running' | 'done' | 'error'; duration: number;
}

// ── Same-currency — pure AxLink ledger, no LP, no Fireblocks ─────────────────
function buildSameCurrencySteps(fromN: string, amount: number): SimStep[] {
  const sf = SYM[fromN] ?? '';
  const total = 4;
  return [
    {
      step: 1, total, layer: 'AXLINK FX', action: 'Routing — same currency detected',
      detail: `Both sender and receiver hold ${fromN}. AxLink skips JIT RFQ, skips Fireblocks, skips all LPs. Pure ledger operation — instant, zero spread.`,
      money: [{ label: 'Flow', amount: 'Direct Ledger', currency: '', direction: 'info' }],
      status: 'done', duration: 300,
    },
    {
      step: 2, total, layer: 'LEDGER', action: `Debit sender — ${sf}${amount} ${fromN}`,
      detail: `Atomic debit from sender's ${fromN} virtual account. Balance check is inside the same database transaction — no race condition.`,
      money: [{ label: 'Sender', amount: `-${sf}${amount}`, currency: fromN, direction: 'debit' }],
      status: 'done', duration: 400,
    },
    {
      step: 3, total, layer: 'LEDGER', action: `Credit receiver — ${sf}${amount} ${fromN}`,
      detail: `Atomic credit to receiver's ${fromN} virtual account. One transaction covers both debit + credit — atomic, no partial state possible.`,
      money: [{ label: 'Receiver', amount: `+${sf}${amount}`, currency: fromN, direction: 'credit' }],
      status: 'done', duration: 400,
    },
    {
      step: 4, total, layer: 'COMPLETE', action: 'Settled — 0 LPs · 0 Fireblocks · 0 spread',
      detail: `Instant. No JIT RFQ, no Fireblocks USDT, no corridor float. AxLink ledger only.`,
      money: [
        { label: 'Sender paid', amount: `${sf}${amount}`, currency: fromN, direction: 'debit' },
        { label: 'Receiver got', amount: `${sf}${amount}`, currency: fromN, direction: 'credit' },
        { label: 'Spread', amount: '0%', currency: '', direction: 'info' },
      ],
      status: 'done', duration: 300,
    },
  ];
}

// ── Cross-currency — JIT RFQ → Fireblocks USDT vault → local rail ─────────────
function buildCrossCurrencySteps(fromN: string, toN: string, amount: number): SimStep[] {
  const sf = SYM[fromN] ?? '';
  const st = SYM[toN] ?? '';
  const usdAmount  = toUSD(amount, fromN);
  const usdStr     = usdAmount.toFixed(2);
  const toAmount   = parseFloat((fromUSD(usdAmount, toN) * (1 - AXLINK_SPREAD)).toFixed(2));
  const colRail    = collectionRail(fromN);
  const payRail    = payoutRail(toN);
  const payL       = payoutLayer(toN);
  const total      = 10;

  return [
    {
      step: 1, total, layer: 'AXLINK FX', action: 'JIT RFQ Broadcast — LPs race simultaneously',
      detail: `AxLink detects cross-currency: ${fromN}→${toN}. Broadcasts binding RFQ to all registered LPs at once: AxLink Internal, B2BinPay (+ any future LP). Each LP responds with their best rate for ${sf}${amount} ${fromN}→USD. Best toAmount wins.`,
      money: [
        { label: 'RFQ: AxLink Internal', amount: `≈ $${(usdAmount * 0.996).toFixed(2)} USD`, currency: '', direction: 'info' },
        { label: 'RFQ: B2BinPay', amount: `≈ $${(usdAmount * 0.997).toFixed(2)} USD`, currency: '', direction: 'info' },
        { label: '→ Winner', amount: `$${usdStr} USD (best offer)`, currency: '', direction: 'move' },
      ],
      status: 'done', duration: 600,
    },
    {
      step: 2, total, layer: 'AXLINK FX', action: `Apply AxLink spread — ${(AXLINK_SPREAD * 100).toFixed(1)}%`,
      detail: `Winning LP rate is the institutional mid. AxLink adds ${(AXLINK_SPREAD * 100).toFixed(1)}% spread — AxLink's revenue, baked into the rate. No fee line shown to the user. Customer rate = LP rate × (1 − spread).`,
      money: [
        { label: 'USD base (LP rate)', amount: `$${usdStr}`, currency: '', direction: 'info' },
        { label: `${toN} to deliver`, amount: `${st}${toAmount.toLocaleString()}`, currency: toN, direction: 'info' },
        { label: 'AxLink spread', amount: `${(AXLINK_SPREAD * 100).toFixed(1)}%`, currency: '', direction: 'info' },
      ],
      status: 'done', duration: 300,
    },
    {
      step: 3, total, layer: 'LEDGER', action: 'Balance check + debit sender',
      detail: `Check sender holds ${sf}${amount} ${fromN}. Atomic debit — balance locked. If insufficient, flow aborts and JIT quote is burned.`,
      money: [{ label: 'Sender', amount: `-${sf}${amount}`, currency: fromN, direction: 'debit' }],
      status: 'done', duration: 400,
    },
    {
      step: 4, total, layer: 'B2BINPAY', action: `On-ramp: ${fromN} → USD liquidity`,
      detail: `Winning LP (B2BinPay) receives the on-ramp instruction. ${colRail} collected ${sf}${amount} ${fromN} from sender. B2BinPay provides $${usdStr} USD equivalent into AxLink's account. Liquidity provision — not rate computation.`,
      money: [
        { label: `${fromN} collected`, amount: `${sf}${amount}`, currency: fromN, direction: 'debit' },
        { label: 'USD provided', amount: `$${usdStr}`, currency: 'USD', direction: 'credit' },
      ],
      status: 'done', duration: 800,
    },
    {
      step: 5, total, layer: 'FIREBLOCKS', action: `Vault-to-vault USDT — $${usdStr} on Solana`,
      detail: `Fireblocks moves ${usdStr} USDT from sender's vault (fb_vault_sender) to receiver's vault (fb_vault_receiver) on Solana. USDT is AxLink's internal value carrier — users never see it. Gas: ~$0.00025. Settlement: ~400ms.`,
      money: [
        { label: 'USDT moved', amount: `${usdStr} USDT`, currency: 'USDT', direction: 'move' },
        { label: 'Route', amount: 'sender vault → receiver vault', currency: '', direction: 'info' },
        { label: 'Gas', amount: '~$0.00025', currency: '', direction: 'info' },
      ],
      status: 'done', duration: 800,
    },
    {
      step: 6, total, layer: 'AXLINK FX', action: `Convert USDT → ${toN} at locked rate`,
      detail: `AxLink FX Engine applies the JIT-locked rate: $${usdStr} USDT → ${st}${toAmount.toLocaleString()} ${toN}. Computed from AxLink's own rate table (USD as internal base). Amount is now immutable for this transfer.`,
      money: [
        { label: 'USDT in', amount: `${usdStr} USDT`, currency: 'USDT', direction: 'debit' },
        { label: `${toN} out`, amount: `${st}${toAmount.toLocaleString()}`, currency: toN, direction: 'credit' },
      ],
      status: 'done', duration: 300,
    },
    {
      step: 7, total, layer: 'LEDGER', action: `Credit receiver — ${st}${toAmount.toLocaleString()} ${toN}`,
      detail: `Atomic credit to receiver's ${toN} virtual account on AxLink ledger.`,
      money: [{ label: 'Receiver balance', amount: `+${st}${toAmount.toLocaleString()}`, currency: toN, direction: 'credit' }],
      status: 'done', duration: 400,
    },
    {
      step: 8, total, layer: payL, action: `Off-ramp: disburse ${toN} via ${payRail}`,
      detail: `AxLink instructs ${payRail} to deliver ${st}${toAmount.toLocaleString()} ${toN} to receiver's ${payL === 'DARAJA' ? 'M-Pesa wallet (Kenya)' : payL === 'CHOICE BANK' ? 'bank account' : 'account'}. Pure fiat at this stage — no USDT.`,
      money: [{ label: 'Fiat delivered', amount: `${st}${toAmount.toLocaleString()}`, currency: toN, direction: 'credit' }],
      status: 'done', duration: 1200,
    },
    {
      step: 9, total, layer: payL, action: '"payment.sent" — payout confirmed',
      detail: `${payRail} fires webhook to AxLink: { type: "payment.sent" }. Transfer marked COMPLETED. If payout fails, AxLink auto-reverses the ledger debit and retries with fallback rail.`,
      money: [{ label: 'Payout status', amount: 'CONFIRMED', currency: '', direction: 'info' }],
      status: 'done', duration: 400,
    },
    {
      step: 10, total, layer: 'COMPLETE', action: 'Settled — JIT RFQ · Fireblocks USDT · local rail',
      detail: `2 LPs competed · Fireblocks USDT vault-to-vault on Solana · ${colRail} collected · ${payRail} disbursed · $0 corridor float · No SWIFT. AxLink is the alternative.`,
      money: [
        { label: 'Sender paid', amount: `${sf}${amount}`, currency: fromN, direction: 'debit' },
        { label: 'Receiver got', amount: `${st}${toAmount.toLocaleString()}`, currency: toN, direction: 'credit' },
        { label: 'AxLink spread', amount: `${(AXLINK_SPREAD * 100).toFixed(1)}%`, currency: '', direction: 'info' },
        { label: 'Corridor float', amount: '$0', currency: '', direction: 'info' },
      ],
      status: 'done', duration: 400,
    },
  ];
}

function buildSteps(from: string, to: string, amount: number): SimStep[] {
  const fromN = from.toUpperCase();
  const toN   = to.toUpperCase();
  return fromN === toN
    ? buildSameCurrencySteps(fromN, amount)
    : buildCrossCurrencySteps(fromN, toN, amount);
}

// ── Deposit ───────────────────────────────────────────────────────────────────
function buildDepositSteps(currency: string, amount: number, rail: string): SimStep[] {
  const sf   = SYM[currency] ?? '';
  const usd  = toUSD(amount, currency);
  const usdt = parseFloat(usd.toFixed(2));
  const total = 6;

  return [
    {
      step: 1, total, layer: 'BRAINROCK', action: `Inbound fiat — ${rail}`,
      detail: `User sends ${sf}${amount} ${currency} to their AxLink virtual IBAN (provisioned by Brainrock). Brainrock detects the payment and webhooks AxLink with amount + accountId.`,
      money: [{ label: 'Fiat arrived', amount: `${sf}${amount}`, currency, direction: 'credit' }],
      status: 'done', duration: 800,
    },
    {
      step: 2, total, layer: 'ORCHESTRATOR', action: 'Match user by virtual IBAN',
      detail: `Webhook: POST /api/webhooks/brainrock. AxLink matches accountId → user → Fireblocks vault. USD value: $${usdt}. Fireblocks USDT to credit: ${usdt} USDT.`,
      money: [{ label: 'USD base', amount: `$${usdt}`, currency: 'USD', direction: 'info' }],
      status: 'done', duration: 400,
    },
    {
      step: 3, total, layer: 'AXLINK FX', action: 'JIT RFQ — LP provides USD liquidity',
      detail: `AxLink broadcasts RFQ: "who gives best USD for ${sf}${amount} ${currency}?" Winning LP (B2BinPay) confirms $${usdt} USD provision. AxLink records USDT amount for Fireblocks credit.`,
      money: [
        { label: 'Winning LP', amount: 'B2BinPay', currency: '', direction: 'info' },
        { label: 'USDT to credit', amount: `${usdt} USDT`, currency: 'USDT', direction: 'info' },
      ],
      status: 'done', duration: 600,
    },
    {
      step: 4, total, layer: 'FIREBLOCKS', action: `Credit ${usdt} USDT → user vault`,
      detail: `Fireblocks moves ${usdt} USDT from AxLink treasury vault to user's Fireblocks vault on Solana. Gas: ~$0.00025. Vault credit triggers ledger update.`,
      money: [{ label: 'USDT in vault', amount: `+${usdt} USDT`, currency: 'USDT', direction: 'credit' }],
      status: 'done', duration: 800,
    },
    {
      step: 5, total, layer: 'LEDGER', action: `Atomic credit — ${sf}${amount} ${currency}`,
      detail: `AxLink credits +${sf}${amount} ${currency} to user's virtual account. Triggered after Fireblocks confirms USDT. BankDeposit → COMPLETED.`,
      money: [{ label: 'User balance', amount: `+${sf}${amount}`, currency, direction: 'credit' }],
      status: 'done', duration: 400,
    },
    {
      step: 6, total, layer: 'COMPLETE', action: 'Deposit settled — user sees fiat only',
      detail: `+${sf}${amount} ${currency} in user's AxLink balance. Fireblocks USDT and Brainrock are invisible. 1 LP RFQ · 1 Fireblocks vault credit · $0 treasury float.`,
      money: [
        { label: 'Balance added', amount: `+${sf}${amount}`, currency, direction: 'credit' },
        { label: 'Treasury hops', amount: '0', currency: '', direction: 'info' },
      ],
      status: 'done', duration: 300,
    },
  ];
}

// ── Withdrawal ────────────────────────────────────────────────────────────────
function buildWithdrawSteps(currency: string, amount: number, rail: string): SimStep[] {
  const sf   = SYM[currency] ?? '';
  const usd  = toUSD(amount, currency);
  const usdt = parseFloat(usd.toFixed(2));
  const payL = payoutLayer(currency);
  const payR = payoutRail(currency);
  const total = 7;

  return [
    {
      step: 1, total, layer: 'ORCHESTRATOR', action: 'Withdrawal validated',
      detail: `User requests ${sf}${amount} ${currency} via ${rail}. AxLink validates KYC + balance. Destination: { type: "${payL === 'DARAJA' ? 'mpesa' : 'bank_transfer'}", ... }.`,
      money: [{ label: 'Requested', amount: `${sf}${amount}`, currency, direction: 'info' }],
      status: 'done', duration: 400,
    },
    {
      step: 2, total, layer: 'LEDGER', action: 'Balance check + debit',
      detail: `Atomic debit: -${sf}${amount} ${currency}. If payout fails, AxLink auto-reverses this debit. Funds stay in AxLink until payout confirms.`,
      money: [{ label: 'User balance', amount: `-${sf}${amount}`, currency, direction: 'debit' }],
      status: 'done', duration: 400,
    },
    {
      step: 3, total, layer: 'FIREBLOCKS', action: `Vault debit — ${usdt} USDT → treasury`,
      detail: `Fireblocks moves ${usdt} USDT from user vault to AxLink treasury vault on Solana. Gas: ~$0.00025. This releases USDT value for the off-ramp.`,
      money: [{ label: 'USDT moved', amount: `${usdt} USDT`, currency: 'USDT', direction: 'move' }],
      status: 'done', duration: 800,
    },
    {
      step: 4, total, layer: 'AXLINK FX', action: 'JIT RFQ — LP off-ramp to fiat',
      detail: `AxLink broadcasts RFQ: "who delivers ${sf}${amount} ${currency} for $${usdt} USDT?" Winning LP (B2BinPay) accepts and routes fiat to ${payR}. AxLink rate table confirms the conversion.`,
      money: [
        { label: 'USDT in', amount: `${usdt} USDT`, currency: 'USDT', direction: 'debit' },
        { label: 'Fiat to disburse', amount: `${sf}${amount}`, currency, direction: 'credit' },
      ],
      status: 'done', duration: 600,
    },
    {
      step: 5, total, layer: payL, action: `${payR}: deliver ${currency} to user`,
      detail: `${payR} receives disbursement from AxLink. Delivers ${sf}${amount} ${currency} to user's ${payL === 'DARAJA' ? 'M-Pesa wallet (Kenya)' : payL === 'CHOICE BANK' ? 'bank account' : 'account'} via ${rail}.`,
      money: [{ label: 'Fiat delivered', amount: `${sf}${amount}`, currency, direction: 'credit' }],
      status: 'done', duration: 1400,
    },
    {
      step: 6, total, layer: payL, action: '"payment.sent" — confirmed',
      detail: `${payR} webhooks AxLink: { type: "payment.sent" }. Withdrawal → COMPLETED. If payment.failed → ledger auto-reversed, Fireblocks USDT returned to user vault.`,
      money: [{ label: 'Status', amount: 'CONFIRMED', currency: '', direction: 'info' }],
      status: 'done', duration: 400,
    },
    {
      step: 7, total, layer: 'COMPLETE', action: 'User receives fiat — USDT never visible',
      detail: `User receives ${sf}${amount} ${currency} via ${rail}. Fireblocks USDT was the internal bridge — invisible. 1 LP RFQ · 1 Fireblocks vault move · 1 ${payR} · $0 float.`,
      money: [
        { label: 'User received', amount: `${sf}${amount}`, currency, direction: 'credit' },
        { label: 'Corridor float', amount: '$0', currency: '', direction: 'info' },
      ],
      status: 'done', duration: 300,
    },
  ];
}

router.get('/transfer', (req: Request, res: Response) => {
  const from   = (req.query['from']   as string) ?? 'GBP';
  const to     = (req.query['to']     as string) ?? 'KES';
  const amount = parseFloat((req.query['amount'] as string) ?? '500');
  res.json({ steps: buildSteps(from, to, amount) });
});

router.get('/deposit', (req: Request, res: Response) => {
  const currency = (req.query['currency'] as string) ?? 'GBP';
  const amount   = parseFloat((req.query['amount'] as string) ?? '500');
  const rail     = (req.query['rail']     as string) ?? 'Brainrock Faster Payments';
  res.json({ steps: buildDepositSteps(currency, amount, rail) });
});

router.get('/withdraw', (req: Request, res: Response) => {
  const currency = (req.query['currency'] as string) ?? 'KES';
  const amount   = parseFloat((req.query['amount'] as string) ?? '5000');
  const rail     = (req.query['rail']     as string) ?? 'Daraja (M-Pesa Kenya)';
  res.json({ steps: buildWithdrawSteps(currency, amount, rail) });
});

export default router;
