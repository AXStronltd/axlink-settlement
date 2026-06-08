import { Router, Request, Response } from 'express';
import path from 'path';

const router = Router();

const GBP_USD = 1.265;
const USD_KES = 129.35; // 1 USD = 129.35 KES (live rate, 05 Jun 2026)
const USD_NGN = 1580;
const USD_GHS = 15.2;
// FinCruse Revenue Model: FX Spread — NO per-transaction fee to users
// B2BinPay gives FinCruse institutional rate → FinCruse marks up → that's revenue
// B2BinPay charges FinCruse per transaction at institutional grade

const SPREAD_MARKUP: Record<string, number> = {
  'USD:KES': 0.018, 'USD:NGN': 0.022, 'USD:GHS': 0.020,
  'GBP:KES': 0.018, 'GBP:NGN': 0.022, 'GBP:GHS': 0.020,
  'EUR:KES': 0.018, 'EUR:NGN': 0.022,
  'USD:GBP': 0.008, 'GBP:USD': 0.008, 'USD:EUR': 0.008,
  'USD:USD': 0.005, 'NGN:USD': 0.022,
};
const TRAD: Record<string, { provider: string; fee: string }> = {
  'USD:KES': { provider: 'Western Union', fee: '3–5% markup + $5 + SWIFT $25' },
  'USD:NGN': { provider: 'Remitly',       fee: '3.5% + correspondent $15–30' },
  'USD:GHS': { provider: 'WorldRemit',    fee: '3% + $3.99 + SWIFT $25' },
  'GBP:KES': { provider: 'WorldRemit',    fee: '2.9% + SWIFT $15–25' },
  'USD:GBP': { provider: 'Wise',          fee: '1.5% + SWIFT $10–15' },
};
const B2B_INSTITUTIONAL = 0.003; // B2BinPay per-tx institutional fee to FinCruse
const SWIFT_COST        = 25;
const SOLANA_GAS        = 0.00025;

function getSpread(from: string, to: string): number {
  return SPREAD_MARKUP[`${from}:${to}`] ?? 0.018;
}
function getTrad(from: string, to: string) {
  return TRAD[`${from}:${to}`] ?? { provider: 'Traditional bank', fee: '3–5% + SWIFT $25–50' };
}

const SYMS: Record<string, string> = { USD:'$', GBP:'£', KES:'KSh ', NGN:'₦', GHS:'GH₵', EUR:'€' };
const FLAGS: Record<string, string> = { USD:'🇺🇸', GBP:'🇬🇧', KES:'🇰🇪', NGN:'🇳🇬', GHS:'🇬🇭', EUR:'🇪🇺' };
const RAILS: Record<string, string> = { KES:'M-Pesa', NGN:'Bank Transfer', GHS:'Mobile Money', USD:'ACH', GBP:'Faster Payments', EUR:'SEPA' };

function toUSD(amount: number, currency: string): number {
  if (currency === 'GBP') return amount * GBP_USD;
  if (currency === 'KES') return amount / USD_KES;
  if (currency === 'NGN') return amount / USD_NGN;
  if (currency === 'GHS') return amount / USD_GHS;
  return amount;
}
function fromUSD(usd: number, currency: string): number {
  if (currency === 'GBP') return usd / GBP_USD;
  if (currency === 'KES') return usd * USD_KES;
  if (currency === 'NGN') return usd * USD_NGN;
  if (currency === 'GHS') return usd * USD_GHS;
  return usd;
}

router.get('/steps', (req: Request, res: Response) => {
  const fromCurr  = ((req.query['from']   as string) ?? 'USD').toUpperCase();
  const toCurr    = ((req.query['to']     as string) ?? 'KES').toUpperCase();
  const amount    = parseFloat((req.query['amount'] as string) ?? '300');
  const sender    = (req.query['sender']  as string) ?? 'Mike';
  const receiver  = (req.query['receiver'] as string) ?? 'James';

  const sf  = SYMS[fromCurr] ?? '';
  const st  = SYMS[toCurr]   ?? '';
  const ff  = FLAGS[fromCurr] ?? '';
  const ft  = FLAGS[toCurr]   ?? '';
  const rail = RAILS[toCurr] ?? 'Bank Transfer';

  const spreadPct       = getSpread(fromCurr, toCurr);
  const trad            = getTrad(fromCurr, toCurr);
  // Institutional rate B2BinPay gives FinCruse (very close to mid-market)
  const institutionalRate = USD_KES * (1 + 0.002); // B2BinPay ~0.2% off mid-market
  // Customer rate = institutional rate × (1 - our spread markup) — this IS our revenue
  const customerRate    = institutionalRate * (1 - spreadPct);
  const fee             = 0;    // NO explicit fee — revenue is in the rate spread
  const afterFee        = amount;
  const usdAmount        = parseFloat(toUSD(amount, fromCurr).toFixed(2));
  const usdtAmount       = usdAmount;
  // What James receives — calculated at customer rate (spread baked in)
  const toAmount         = parseFloat((amount * (toCurr === 'KES' ? customerRate : fromUSD(usdAmount, toCurr) / amount)).toFixed(2));
  const toAmountAtMid    = parseFloat(fromUSD(usdAmount, toCurr).toFixed(2)); // what mid-market would give
  const rate             = parseFloat((toAmount / amount).toFixed(4));
  // FinCruse revenue = difference between institutional rate and customer rate
  const spreadRevenue    = parseFloat((toAmountAtMid - toAmount).toFixed(2)); // in toCurrency
  const spreadRevenueUsd = parseFloat((usdAmount * spreadPct).toFixed(2));
  const b2bFee           = parseFloat((usdAmount * B2B_INSTITUTIONAL + SOLANA_GAS).toFixed(4));
  const profitUsd        = parseFloat((spreadRevenueUsd - b2bFee).toFixed(2));

  const senderStartBal  = fromCurr === 'USD' ? 3200 : fromCurr === 'GBP' ? 2480 : 150000;
  const receiverStartBal = toCurr  === 'KES' ? 12000 : toCurr === 'NGN' ? 80000 : 500;

  const steps = [
    {
      id: 1,
      // What user sees
      user: {
        screen: 'sender',
        title: `${sender} opens FinCruse`,
        body: `Balance: ${sf}${senderStartBal.toLocaleString()} ${fromCurr}`,
        action: `Taps "Send Money"`,
        highlight: false,
      },
      // What backend does
      api: {
        method: null,
        endpoint: null,
        label: 'User opens app — no API call yet',
        detail: 'FinCruse loads user profile and account balance from the ledger.',
        service: 'LEDGER',
        request: null,
        response: { balance: `${sf}${senderStartBal.toLocaleString()}`, currency: fromCurr },
      },
      duration: 1000,
    },
    {
      id: 2,
      user: {
        screen: 'sender',
        title: 'Enter transfer details',
        body: `Send to: ${receiver} ${ft} Kenya\nAmount: ${sf}${amount} ${fromCurr}`,
        action: 'App requests live rate',
        highlight: false,
      },
      api: {
        method: 'POST',
        endpoint: '/api/quote',
        label: 'JIT Rate Lock — B2BinPay institutional rate + FinCruse spread',
        detail: `B2BinPay gives FinCruse institutional rate. FinCruse adds ${(spreadPct*100).toFixed(1)}% spread (baked into rate — no visible fee). Rate locked 30 seconds.`,
        service: 'QUOTE ENGINE',
        request: { fromCurrency: fromCurr, toCurrency: toCurr, fromAmount: amount },
        response: {
          quoteId: 'q_abc123',
          b2bInstitutionalRate: `1 ${fromCurr} = ${(toCurr === 'KES' ? institutionalRate : rate * 1.018).toFixed(4)} ${toCurr}`,
          fincruseSpread: `${(spreadPct*100).toFixed(1)}% — FinCruse revenue built into rate`,
          customerRate: `1 ${fromCurr} = ${rate} ${toCurr}`,
          fromAmount: amount,
          toAmount,
          fee: 'No fee — rate includes margin',
          expiresIn: '30s',
        },
      },
      duration: 1200,
    },
    {
      id: 3,
      user: {
        screen: 'sender',
        title: 'Confirm screen',
        body: `${sender} sees:\n${sf}${amount} ${fromCurr} → ${st}${toAmount.toLocaleString()} ${toCurr}\nRate: 1 ${fromCurr} = ${rate} ${toCurr}\nFee: None`,
        action: `${sender} taps "Confirm & Send"`,
        highlight: true,
      },
      api: {
        method: null,
        endpoint: null,
        label: 'Rate displayed to user — 30s countdown',
        detail: `${sender} sees ONLY fiat amounts and the exchange rate. No USDT, no Fireblocks, no B2BinPay visible.`,
        service: 'UI',
        request: null,
        response: null,
      },
      duration: 1500,
    },
    {
      id: 4,
      user: {
        screen: 'sender',
        title: 'Processing...',
        body: `Sending ${sf}${amount} to ${receiver}...`,
        action: 'Spinner shows',
        highlight: false,
      },
      api: {
        method: 'POST',
        endpoint: '/api/orchestrator/transfer',
        label: 'Orchestrator — validates + debits sender',
        detail: `Check ${sender} has ${sf}${amount} ${fromCurr}. Atomic ledger debit. Create transfer record.`,
        service: 'ORCHESTRATOR',
        request: { senderId: 'user_mike', receiverId: 'user_james', fromCurrency: fromCurr, toCurrency: toCurr, amount, quoteId: 'q_abc123' },
        response: { transferId: 'txn_xyz789', status: 'PROCESSING', senderBalance: `${sf}${(senderStartBal - amount).toLocaleString()}` },
      },
      duration: 700,
    },
    {
      id: 5,
      user: {
        screen: 'sender',
        title: 'Still processing...',
        body: `Converting ${fromCurr} to delivery currency...`,
        action: 'Backend converts fiat → USDT',
        highlight: false,
      },
      api: {
        method: 'POST',
        endpoint: '/api/b2binpay/deposit',
        label: `B2BinPay ON-RAMP — ${fromCurr} fiat → USDT`,
        detail: `${sf}${afterFee} ${fromCurr} sent to B2BinPay. They convert to ${usdtAmount} USDT and credit FinCruse's B2BinPay wallet.`,
        service: 'B2BINPAY',
        request: { walletId: 'b2b_wallet_fincruse', amount: afterFee, currency: fromCurr },
        response: { depositId: 'dep_b2b_001', usdt_received: `${usdtAmount} USDT`, status: 'CONFIRMED' },
      },
      duration: 1400,
    },
    {
      id: 6,
      user: {
        screen: 'sender',
        title: 'Still processing...',
        body: 'Securing transfer on blockchain...',
        action: 'USDT moves on Solana',
        highlight: false,
      },
      api: {
        method: 'POST',
        endpoint: '/api/fireblocks/transfer',
        label: 'Fireblocks — USDT vault move on Solana (gas ≈ $0.00025)',
        detail: `${usdtAmount} USDT: vault_mike → treasury_vault. Solana settlement — effectively gasless at $0.00025 per tx. A SWIFT transfer costs $25–50 and takes 1–5 days. This takes seconds.`,
        service: 'FIREBLOCKS',
        request: { assetId: 'USDT_SOL', amount: usdtAmount, sourceVaultId: 'vault_mike', destVaultId: 'treasury_vault' },
        response: { txId: 'fb_tx_99z', status: 'COMPLETED', txHash: '5xKj...mN3p', gasFee: '$0.00025', swiftEquivalent: '$25–50', settlementTime: '~2 seconds' },
      },
      duration: 1600,
    },
    {
      id: 7,
      user: {
        screen: 'sender',
        title: 'Almost done...',
        body: 'Preparing local delivery...',
        action: 'B2BinPay sends USD to FinCruse',
        highlight: false,
      },
      api: {
        method: 'POST',
        endpoint: '/api/b2binpay/payout',
        label: `B2BinPay OFF-RAMP — USDT → USD to FinCruse account`,
        detail: `${usdtAmount} USDT → $${usdtAmount} USD deposited to FinCruse's account. B2BinPay does NOT deliver ${toCurr} directly. FinCruse receives USD.`,
        service: 'B2BINPAY',
        request: { walletId: 'b2b_wallet_fincruse', amount: usdtAmount, currencyId: 'USD' },
        response: { payoutId: 'pay_b2b_002', usd_sent: `$${usdtAmount}`, destination: 'FinCruse USD account', status: 'PAID' },
      },
      duration: 1400,
    },
    {
      id: 8,
      user: {
        screen: 'both',
        title: 'Converting to local currency...',
        body: `$${usdtAmount} USD → ${st}${toAmount.toLocaleString()} ${toCurr}`,
        action: 'Orchestrator converts + routes to payout partner',
        highlight: false,
      },
      api: {
        method: 'POST',
        endpoint: '/api/orchestrator/payout-local',
        label: `Orchestrator — USD → ${toCurr} + instruct payout partner`,
        detail: `FinCruse converts $${usdtAmount} USD → ${st}${toAmount.toLocaleString()} ${toCurr} using locked quote rate. Instructs local payout partner to deliver via ${rail}.`,
        service: 'ORCHESTRATOR',
        request: { amount: usdtAmount, fromCurrency: 'USD', toCurrency: toCurr, receiverId: 'user_james', rail },
        response: { localAmount: `${st}${toAmount.toLocaleString()}`, rail, payoutRef: 'pp_intasend_4421' },
      },
      duration: 800,
    },
    {
      id: 9,
      user: {
        screen: 'receiver',
        title: `${receiver} receives money`,
        body: `${receiver} gets ${rail} notification:\n"${st}${toAmount.toLocaleString()} ${toCurr} received"`,
        action: `${rail} delivers ${st}${toAmount.toLocaleString()} ${toCurr}`,
        highlight: true,
      },
      api: {
        method: 'POST',
        endpoint: '/api/payout-partner/send',
        label: `Payout Partner (Cellulant/IntaSend) — ${rail} delivery`,
        detail: `Local payout partner executes ${rail} to ${receiver}'s account. ${receiver} receives ${st}${toAmount.toLocaleString()} ${toCurr}. No crypto involved.`,
        service: 'PAYOUT PARTNER',
        request: { amount: toAmount, currency: toCurr, recipient: 'james_mpesa_254...', rail },
        response: { ref: 'mpesa_OEL7YH', status: 'SUCCESS', delivered: `${st}${toAmount.toLocaleString()} ${toCurr}` },
      },
      duration: 1800,
    },
    {
      id: 10,
      user: {
        screen: 'receiver',
        title: `${receiver}'s FinCruse balance updates`,
        body: `Balance: ${st}${(receiverStartBal + toAmount).toLocaleString()} ${toCurr}\n+${st}${toAmount.toLocaleString()} from ${sender}`,
        action: 'Payout partner webhook → ledger credit',
        highlight: false,
      },
      api: {
        method: 'POST',
        endpoint: '/api/orchestrator/payout-rail/confirmed',
        label: 'Payout confirmation webhook → Ledger credit',
        detail: `Payout partner confirms delivery. Orchestrator credits ${receiver}'s ledger. Transfer marked COMPLETED.`,
        service: 'ORCHESTRATOR',
        request: { trackingId: 'txn_xyz789', railReference: 'mpesa_OEL7YH', status: 'SUCCESS' },
        response: { receiverBalance: `${st}${(receiverStartBal + toAmount).toLocaleString()}`, transferStatus: 'COMPLETED' },
      },
      duration: 600,
    },
    {
      id: 11,
      user: {
        screen: 'both',
        title: 'Done — both users notified',
        body: `${sender} ${ff}: "${sf}${amount} sent ✓"\n${receiver} ${ft}: "${st}${toAmount.toLocaleString()} received ✓"`,
        action: 'Push notifications sent',
        highlight: true,
      },
      api: {
        method: null,
        endpoint: null,
        label: 'Transfer complete — no crypto visible to users',
        detail: `${sender} sees ${sf}${amount} ${fromCurr} deducted. ${receiver} sees ${st}${toAmount.toLocaleString()} ${toCurr} credited. Zero crypto exposure.`,
        service: 'COMPLETE',
        request: null,
        response: {
          sender: `${sf}${(senderStartBal - amount).toLocaleString()} ${fromCurr}`,
          receiver: `${st}${(receiverStartBal + toAmount).toLocaleString()} ${toCurr}`,
          fee: `${sf}${fee}`,
          b2binpayCalls: 2,
          fireblocksCalls: 1,
          corridorFloat: '$0',
          totalTime: '~28 seconds',
        },
      },
      duration: 500,
    },
  ];

  // Legacy block removed — margin now calculated above via spread model

  res.json({
    summary: {
      sender:   { name: sender,   country: fromCurr, flag: ff, amount: `${sf}${amount}`,                 currency: fromCurr },
      receiver: { name: receiver, country: toCurr,   flag: ft, amount: `${st}${toAmount.toLocaleString()}`, currency: toCurr },
      fee:              'None — no per-transaction fee',
      rate:             `1 ${fromCurr} = ${rate} ${toCurr}`,
      institutionalRate:`1 ${fromCurr} = ${institutionalRate.toFixed(4)} ${toCurr} (B2BinPay gives FinCruse)`,
      spreadPct:        `${(spreadPct*100).toFixed(1)}%`,
      b2binpayCalls:    2,
      fireblocksCalls:  1,
      corridorFloat:    '$0',
      margin: {
        revenueModel:       'FX spread — baked into rate, no visible fee',
        spreadRevenue:      `${st}${spreadRevenue} ${toCurr} / $${spreadRevenueUsd} USD per transaction`,
        b2bInstitutionalFee:`$${b2bFee} (B2BinPay per-tx institutional grade)`,
        solanaTxFee:        `$${SOLANA_GAS}`,
        swiftNotPaid:       `$${SWIFT_COST} (SWIFT not used)`,
        profitPerTx:        `$${profitUsd} USD`,
        traditionalProvider: trad.provider,
        traditionalComparison: `${trad.provider}: ${trad.fee} — we skip SWIFT, they can't`,
        insight:            `B2BinPay charges FinCruse per transaction at institutional grade. FinCruse earns $${spreadRevenueUsd} spread on this transaction. Cost is $${b2bFee}. Profit: $${profitUsd}.`,
      },
    },
    steps,
  });
});

router.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '../../public/demo.html'));
});

export default router;
