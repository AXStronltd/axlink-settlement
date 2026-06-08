import { Router, Request, Response } from 'express';

const router = Router();

const GBP_USD = 1.265;
const USD_KES = 129.35; // 1 USD = 129.35 KES (live rate, 05 Jun 2026)
const USD_NGN = 1580;
const USD_GHS = 15.2;
const PLATFORM_FEE = 0.015;

interface SimStep {
  step: number;
  total: number;
  layer: string;
  action: string;
  detail: string;
  money: { label: string; amount: string; currency: string; direction: 'debit' | 'credit' | 'move' | 'info' }[];
  status: 'running' | 'done' | 'error';
  duration: number;
}

function buildSteps(from: string, to: string, amount: number): SimStep[] {
  const fromN = from.toUpperCase();
  const toN = to.toUpperCase();
  const sameCurrency = fromN === toN;

  const fee = parseFloat((amount * PLATFORM_FEE).toFixed(2));
  const afterFee = amount - fee;

  // rate calculation
  let toUSD = afterFee;
  if (fromN === 'GBP') toUSD = afterFee * GBP_USD;
  else if (fromN === 'NGN') toUSD = afterFee / USD_NGN;
  else if (fromN === 'GHS') toUSD = afterFee / USD_GHS;

  const usdtAmount = parseFloat(toUSD.toFixed(2));

  let toAmount = usdtAmount;
  if (toN === 'KES') toAmount = parseFloat((usdtAmount * USD_KES).toFixed(2));
  else if (toN === 'NGN') toAmount = parseFloat((usdtAmount * USD_NGN).toFixed(2));
  else if (toN === 'GHS') toAmount = parseFloat((usdtAmount * USD_GHS).toFixed(2));
  else if (toN === 'GBP') toAmount = parseFloat((usdtAmount / GBP_USD).toFixed(2));

  const symbol: Record<string, string> = {
    GBP: '£', USD: '$', KES: 'KSh ', NGN: '₦', GHS: 'GH₵', EUR: '€', ZAR: 'R'
  };
  const sf = symbol[fromN] ?? '';
  const st = symbol[toN] ?? '';

  if (sameCurrency) {
    return [
      {
        step: 1, total: 5, layer: 'QUOTE ENGINE', action: 'JIT Rate Lock',
        detail: `Locking ${sf}${amount} ${fromN} → ${sf}${(amount * 0.985).toFixed(2)} ${toN} for 30 seconds`,
        money: [{ label: 'Locked amount', amount: `${sf}${amount}`, currency: fromN, direction: 'info' }],
        status: 'done', duration: 800,
      },
      {
        step: 2, total: 5, layer: 'LEDGER', action: 'Debit sender',
        detail: `Atomic debit — remove ${sf}${amount} from sender virtual account`,
        money: [{ label: 'Sender balance', amount: `-${sf}${amount}`, currency: fromN, direction: 'debit' }],
        status: 'done', duration: 600,
      },
      {
        step: 3, total: 5, layer: 'FIREBLOCKS', action: 'Vault-to-vault (USDT · Solana)',
        detail: `${usdtAmount} USDT: fb_vault_sender → fb_vault_receiver — no B2BinPay needed`,
        money: [{ label: 'USDT moved', amount: `${usdtAmount} USDT`, currency: 'USDT', direction: 'move' }],
        status: 'done', duration: 1200,
      },
      {
        step: 4, total: 5, layer: 'LEDGER', action: 'Credit receiver',
        detail: `Atomic credit — add ${sf}${(amount * 0.985).toFixed(2)} to receiver virtual account`,
        money: [{ label: 'Receiver balance', amount: `+${sf}${(amount * 0.985).toFixed(2)}`, currency: toN, direction: 'credit' }],
        status: 'done', duration: 600,
      },
      {
        step: 5, total: 5, layer: 'COMPLETE', action: 'Transfer settled',
        detail: `0 B2BinPay calls · 1 Fireblocks call · ${sf}0 corridor float`,
        money: [
          { label: 'Sender paid', amount: `${sf}${amount}`, currency: fromN, direction: 'debit' },
          { label: 'Receiver got', amount: `${sf}${(amount * 0.985).toFixed(2)}`, currency: toN, direction: 'credit' },
          { label: 'FinCruse fee', amount: `${sf}${fee}`, currency: fromN, direction: 'info' },
        ],
        status: 'done', duration: 500,
      },
    ];
  }

  return [
    {
      step: 1, total: 10, layer: 'QUOTE ENGINE', action: 'JIT Rate Lock',
      detail: `Fetching live rate from B2BinPay · Locking ${sf}${amount} ${fromN} → ${st}${toAmount.toLocaleString()} ${toN} for 30 seconds`,
      money: [
        { label: 'Sender pays', amount: `${sf}${amount}`, currency: fromN, direction: 'info' },
        { label: 'Rate locked', amount: `1 ${fromN} = ${(toAmount / amount).toFixed(4)} ${toN}`, currency: '', direction: 'info' },
      ],
      status: 'done', duration: 900,
    },
    {
      step: 2, total: 10, layer: 'LEDGER', action: 'Balance check + debit sender',
      detail: `Check sender has ${sf}${amount} ${fromN} · Atomic debit from virtual account`,
      money: [{ label: 'Sender balance', amount: `-${sf}${amount}`, currency: fromN, direction: 'debit' }],
      status: 'done', duration: 500,
    },
    {
      step: 3, total: 10, layer: 'B2BINPAY', action: 'ON-RAMP: fiat → USDT',
      detail: `POST /deposit/ · ${sf}${afterFee} ${fromN} fiat → ${usdtAmount} USDT`,
      money: [
        { label: 'Fiat in', amount: `${sf}${afterFee}`, currency: fromN, direction: 'debit' },
        { label: 'USDT out', amount: `${usdtAmount} USDT`, currency: 'USDT', direction: 'credit' },
      ],
      status: 'done', duration: 1400,
    },
    {
      step: 4, total: 10, layer: 'FIREBLOCKS', action: 'Vault move (USDT · Solana)',
      detail: `createTransaction() · ${usdtAmount} USDT: fb_vault_sender → fb_vault_receiver`,
      money: [{ label: 'USDT on Solana', amount: `${usdtAmount} USDT`, currency: 'USDT', direction: 'move' }],
      status: 'done', duration: 1600,
    },
    {
      step: 5, total: 10, layer: 'B2BINPAY', action: 'OFF-RAMP: USDT → USD (to FinCruse account)',
      detail: `POST /payout/ · ${usdtAmount} USDT → $${usdtAmount} USD sent to FinCruse's B2BinPay wallet. B2BinPay does NOT send KES directly — it sends USD equivalent.`,
      money: [
        { label: 'USDT in', amount: `${usdtAmount} USDT`, currency: 'USDT', direction: 'debit' },
        { label: 'USD to FinCruse', amount: `$${usdtAmount}`, currency: 'USD', direction: 'credit' },
      ],
      status: 'done', duration: 1400,
    },
    {
      step: 6, total: 10, layer: 'ORCHESTRATOR', action: `Convert USD → ${toN} for payout`,
      detail: `FinCruse converts $${usdtAmount} USD → ${st}${toAmount.toLocaleString()} ${toN} using locked quote rate. Selects local payout partner for ${toN} corridor.`,
      money: [
        { label: 'USD received', amount: `$${usdtAmount}`, currency: 'USD', direction: 'debit' },
        { label: `${toN} equivalent`, amount: `${st}${toAmount.toLocaleString()}`, currency: toN, direction: 'credit' },
      ],
      status: 'done', duration: 700,
    },
    {
      step: 7, total: 10, layer: 'PAYOUT PARTNER', action: `Local payout — ${toN} via M-Pesa/bank`,
      detail: `FinCruse instructs local payout partner (Cellulant / IntaSend / Flutterwave). Partner executes ${toN} delivery to receiver. M-Pesa STK push or bank transfer.`,
      money: [
        { label: 'Instructed', amount: `${st}${toAmount.toLocaleString()}`, currency: toN, direction: 'move' },
      ],
      status: 'done', duration: 1800,
    },
    {
      step: 8, total: 10, layer: 'PAYOUT PARTNER', action: 'Payout confirmation webhook',
      detail: `Local partner sends webhook to /api/orchestrator/payout-rail/confirmed. FinCruse verifies delivery. Only now does receiver balance update.`,
      money: [{ label: 'Delivery confirmed', amount: `${st}${toAmount.toLocaleString()}`, currency: toN, direction: 'info' }],
      status: 'done', duration: 600,
    },
    {
      step: 9, total: 10, layer: 'LEDGER', action: 'Credit receiver — confirmed delivery',
      detail: `Atomic credit: +${st}${toAmount.toLocaleString()} ${toN} to receiver virtual account. Triggered AFTER payout partner confirmation, not before.`,
      money: [{ label: 'Receiver balance', amount: `+${st}${toAmount.toLocaleString()}`, currency: toN, direction: 'credit' }],
      status: 'done', duration: 500,
    },
    {
      step: 10, total: 10, layer: 'COMPLETE', action: 'Transfer settled — JIT',
      detail: `2 B2BinPay calls · 1 Fireblocks · 1 Local payout partner · ${sf}0 corridor float · No pre-funding`,
      money: [
        { label: 'Sender paid', amount: `${sf}${amount}`, currency: fromN, direction: 'debit' },
        { label: 'FinCruse fee', amount: `${sf}${fee}`, currency: fromN, direction: 'info' },
        { label: 'B2BinPay paid', amount: `$${usdtAmount} USD`, currency: '', direction: 'info' },
        { label: 'Receiver got', amount: `${st}${toAmount.toLocaleString()}`, currency: toN, direction: 'credit' },
      ],
      status: 'done', duration: 500,
    },
  ];
}

function buildDepositSteps(currency: string, amount: number, rail: string): SimStep[] {
  const sf = ({ GBP:'£',USD:'$',KES:'KSh ',NGN:'₦',GHS:'GH₵',EUR:'€' } as Record<string,string>)[currency] ?? '';
  const usd = currency === 'GBP' ? amount * 1.265 : currency === 'KES' ? amount / 129.35 : amount;
  const usdt = parseFloat(usd.toFixed(2));

  return [
    {
      step:1, total:7, layer:'PAYOUT RAIL', action:`${rail} — fiat received`,
      detail:`FinCruse payout partner receives ${sf}${amount} ${currency} via ${rail}. Sends webhook to FinCruse Orchestrator with user ID + amount + reference.`,
      money:[{label:'Fiat arrived',amount:`${sf}${amount}`,currency,direction:'credit'}],
      status:'done', duration:900,
    },
    {
      step:2, total:7, layer:'ORCHESTRATOR', action:'handleFiatArrived() — looks up user vault',
      detail:`Orchestrator receives event. Looks up user's Fireblocks vault address (usdtAddress). This is the direct destination for B2BinPay USDT output. No treasury vault needed.`,
      money:[{label:'USD base',amount:`$${usd.toFixed(2)}`,currency:'USD',direction:'info'},{label:'USDT to send',amount:`${usdt} USDT`,currency:'USDT',direction:'info'}],
      status:'done', duration:600,
    },
    {
      step:3, total:7, layer:'B2BINPAY', action:'ON-RAMP: fiat → USDT, send to Fireblocks vault address',
      detail:`B2BinPay converts ${sf}${amount} ${currency} → ${usdt} USDT. Destination = user's Fireblocks vault address (usdtAddress). B2BinPay sends USDT directly to Fireblocks — no FinCruse treasury.`,
      money:[{label:'Fiat in',amount:`${sf}${amount}`,currency,direction:'debit'},{label:'USDT → Fireblocks',amount:`${usdt} USDT`,currency:'USDT',direction:'credit'}],
      status:'done', duration:1400,
    },
    {
      step:4, total:7, layer:'FIREBLOCKS', action:'USDT lands in user vault — no movement needed',
      detail:`B2BinPay sends ${usdt} USDT directly to vault_user Solana address. Fireblocks detects inbound USDT. No vault-to-vault transfer required — B2BinPay targeted the vault directly.`,
      money:[{label:'USDT received',amount:`${usdt} USDT`,currency:'USDT',direction:'credit'}],
      status:'done', duration:1200,
    },
    {
      step:5, total:7, layer:'FIREBLOCKS', action:'Webhook → FinCruse: USDT confirmed in vault',
      detail:`Fireblocks fires webhook to /api/webhooks/fireblocks. Status: COMPLETED. FinCruse matches vault ID → user → pending deposit. Triggers ledger credit.`,
      money:[{label:'Confirmation',amount:`${usdt} USDT in vault`,currency:'',direction:'info'}],
      status:'done', duration:700,
    },
    {
      step:6, total:7, layer:'LEDGER', action:'Credit user balance — confirmed by Fireblocks',
      detail:`Atomic credit: +${sf}${amount} ${currency} to user virtual account. Triggered ONLY after Fireblocks confirms USDT in vault — not before.`,
      money:[{label:'User balance',amount:`+${sf}${amount}`,currency,direction:'credit'}],
      status:'done', duration:500,
    },
    {
      step:7, total:7, layer:'COMPLETE', action:'Deposit settled — 10/10 flow',
      detail:`User sees ${sf}${amount} ${currency}. B2BinPay → Fireblocks direct (no treasury). 1 B2BinPay call · 0 Fireblocks transfers · $0 corridor float. Each user vault paired permanently.`,
      money:[
        {label:'Balance added',amount:`+${sf}${amount}`,currency,direction:'credit'},
        {label:'Treasury hops',amount:'0',currency:'',direction:'info'},
        {label:'B2B institutional fee',amount:`$${(usdt*0.003+0.00025).toFixed(4)}`,currency:'',direction:'info'},
      ],
      status:'done', duration:400,
    },
  ];
}

function buildWithdrawSteps(currency: string, amount: number, rail: string): SimStep[] {
  const sf = ({ GBP:'£',USD:'$',KES:'KSh ',NGN:'₦',GHS:'GH₵',EUR:'€' } as Record<string,string>)[currency] ?? '';
  const usd = currency === 'GBP' ? amount * 1.265 : currency === 'KES' ? amount / 129.5 : amount;
  const usdt = parseFloat(usd.toFixed(2));

  return [
    {
      step:1,total:7,layer:'ORCHESTRATOR',action:'handleWithdrawalRequest() — initiated',
      detail:`User requests withdraw ${sf}${amount} ${currency} to ${rail}. Orchestrator validates balance + starts flow.`,
      money:[{label:'Requested',amount:`${sf}${amount}`,currency,direction:'info'}],
      status:'done',duration:600,
    },
    {
      step:2,total:7,layer:'LEDGER',action:'Balance check + debit user',
      detail:`Check user has ${sf}${amount} ${currency}. Atomic debit from virtual account. Cannot be reversed unless payout rail fails.`,
      money:[{label:'User balance',amount:`-${sf}${amount}`,currency,direction:'debit'}],
      status:'done',duration:500,
    },
    {
      step:3,total:7,layer:'FIREBLOCKS',action:'Vault debit — User vault → Treasury',
      detail:`${usdt} USDT: fb_vault_user → fb_treasury_vault. Fireblocks createTransaction()`,
      money:[{label:'USDT moved',amount:`${usdt} USDT`,currency:'USDT',direction:'move'}],
      status:'done',duration:1200,
    },
    {
      step:4,total:7,layer:'B2BINPAY',action:'OFF-RAMP: USDT → fiat',
      detail:`POST /payout/ · ${usdt} USDT → ${sf}${amount} ${currency} fiat. B2BinPay instructs payout partner.`,
      money:[{label:'USDT in',amount:`${usdt} USDT`,currency:'USDT',direction:'debit'},{label:'Fiat out',amount:`${sf}${amount}`,currency,direction:'credit'}],
      status:'done',duration:1400,
    },
    {
      step:5,total:7,layer:'PAYOUT RAIL',action:`${rail} — send fiat to user`,
      detail:`Payout partner executes ${rail} to user's account. (M-Pesa STK push / bank RTGS / bank transfer)`,
      money:[{label:'Fiat sent',amount:`${sf}${amount}`,currency,direction:'credit'}],
      status:'done',duration:1600,
    },
    {
      step:6,total:7,layer:'ORCHESTRATOR',action:'handlePayoutRailConfirmed() — webhook',
      detail:`Payout rail sends confirmation webhook. Orchestrator marks withdrawal COMPLETED.`,
      money:[],
      status:'done',duration:500,
    },
    {
      step:7,total:7,layer:'COMPLETE',action:'Withdrawal settled',
      detail:`User receives ${sf}${amount} ${currency} via ${rail}. 1 B2BinPay off-ramp · 1 Fireblocks debit.`,
      money:[{label:'User received',amount:`${sf}${amount}`,currency,direction:'credit'},{label:'Corridor float',amount:'$0',currency:'',direction:'info'}],
      status:'done',duration:400,
    },
  ];
}

// SSE stream — each step fires with a delay so browser renders it live
// Return all steps as JSON — browser animates through them with setTimeout
router.get('/transfer', (req: Request, res: Response) => {
  const from = (req.query['from'] as string) ?? 'GBP';
  const to   = (req.query['to']   as string) ?? 'KES';
  const amount = parseFloat((req.query['amount'] as string) ?? '500');
  res.json({ steps: buildSteps(from, to, amount) });
});

router.get('/deposit', (req: Request, res: Response) => {
  const currency = (req.query['currency'] as string) ?? 'KES';
  const amount   = parseFloat((req.query['amount'] as string) ?? '10000');
  const rail     = (req.query['rail'] as string) ?? 'M-Pesa';
  res.json({ steps: buildDepositSteps(currency, amount, rail) });
});

router.get('/withdraw', (req: Request, res: Response) => {
  const currency = (req.query['currency'] as string) ?? 'KES';
  const amount   = parseFloat((req.query['amount'] as string) ?? '5000');
  const rail     = (req.query['rail'] as string) ?? 'M-Pesa';
  res.json({ steps: buildWithdrawSteps(currency, amount, rail) });
});

export default router;
