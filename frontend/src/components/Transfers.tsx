import { useState, useEffect, useRef } from 'react'
import { lookupUser, createQuote, orchestratorTransfer, type QuoteRes, type TransferRes } from '../api'

const CURRENCIES = ['KES', 'NGN', 'GHS', 'GBP', 'EUR', 'USD', 'ZAR', 'UGX', 'TZS']
const FLAGS: Record<string, string> = { KES:'🇰🇪', NGN:'🇳🇬', GHS:'🇬🇭', ZAR:'🇿🇦', UGX:'🇺🇬', TZS:'🇹🇿', GBP:'🇬🇧', EUR:'🇪🇺', USD:'🇺🇸' }

type Step = 'form' | 'quote' | 'confirm' | 'result'

export default function Transfers() {
  const [step, setStep] = useState<Step>('form')
  const [form, setForm] = useState({ senderEmail: '', receiverEmail: '', fromCurrency: 'GBP', toCurrency: 'NGN', amount: '' })
  const [senderId, setSenderId] = useState('')
  const [receiverId, setReceiverId] = useState('')
  const [senderName, setSenderName] = useState('')
  const [receiverName, setReceiverName] = useState('')
  const [quote, setQuote] = useState<QuoteRes | null>(null)
  const [result, setResult] = useState<TransferRes | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [countdown, setCountdown] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (quote && step === 'confirm') {
      setCountdown(quote.expiresIn)
      timerRef.current = setInterval(() => {
        setCountdown(c => {
          if (c <= 1) { clearInterval(timerRef.current!); setStep('form'); setErr('Quote expired — request a new one'); return 0 }
          return c - 1
        })
      }, 1000)
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [quote, step])

  const fetchQuote = async () => {
    if (!form.senderEmail || !form.receiverEmail || !form.amount) {
      setErr('All fields are required'); return
    }
    setLoading(true); setErr('')
    try {
      const [s, r] = await Promise.all([lookupUser(form.senderEmail), lookupUser(form.receiverEmail)])
      setSenderId(s.id); setSenderName(s.name)
      setReceiverId(r.id); setReceiverName(r.name)
      const q = await createQuote({ fromCurrency: form.fromCurrency, toCurrency: form.toCurrency, fromAmount: Number(form.amount) })
      setQuote(q); setStep('confirm')
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }

  const executeTransfer = async () => {
    if (!quote) return
    setLoading(true); setErr('')
    try {
      const res = await orchestratorTransfer({
        senderId, receiverId,
        fromCurrency: form.fromCurrency, toCurrency: form.toCurrency,
        amount: Number(form.amount), quoteId: quote.quoteId,
      })
      setResult(res); setStep('result')
      if (timerRef.current) clearInterval(timerRef.current)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }

  const reset = () => {
    setStep('form'); setQuote(null); setResult(null); setErr('')
    if (timerRef.current) clearInterval(timerRef.current)
  }

  const currencySymbol = (c: string) => ({ GBP: '£', EUR: '€', USD: '$', KES: 'KSh ', NGN: '₦', GHS: 'GH₵', ZAR: 'R', UGX: 'USh ', TZS: 'TSh ' }[c] ?? '')

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-white">P2P Transfers</h1>
        <p className="text-sm text-gray-500 mt-0.5">Send between FinCruse users — same or cross-currency</p>
      </div>

      {/* Progress */}
      <div className="flex items-center gap-2">
        {(['form', 'confirm', 'result'] as const).map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium ${step === s ? 'bg-brand-600 text-white' : (step === 'confirm' && i < 1) || step === 'result' ? 'bg-gray-700 text-gray-400' : 'bg-gray-800 text-gray-600'}`}>{i + 1}</div>
            <span className={`text-xs ${step === s ? 'text-gray-200' : 'text-gray-600'}`}>{s === 'form' ? 'Details' : s === 'confirm' ? 'Confirm' : 'Done'}</span>
            {i < 2 && <div className="w-6 h-px bg-gray-800" />}
          </div>
        ))}
      </div>

      {step === 'form' && (
        <div className="card space-y-4 max-w-lg">
          <h2 className="text-sm font-medium text-gray-300">Transfer Details</h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Sender Email</label>
              <input className="input" placeholder="mike@example.com"
                value={form.senderEmail} onChange={e => setForm(f => ({ ...f, senderEmail: e.target.value }))} />
            </div>
            <div>
              <label className="label">Receiver Email</label>
              <input className="input" placeholder="james@example.com"
                value={form.receiverEmail} onChange={e => setForm(f => ({ ...f, receiverEmail: e.target.value }))} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label">From</label>
              <select className="input" value={form.fromCurrency} onChange={e => setForm(f => ({ ...f, fromCurrency: e.target.value }))}>
                {CURRENCIES.map(c => <option key={c} value={c}>{FLAGS[c]} {c}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Amount</label>
              <input className="input" type="number" min="0" placeholder="300"
                value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
            </div>
            <div>
              <label className="label">To</label>
              <select className="input" value={form.toCurrency} onChange={e => setForm(f => ({ ...f, toCurrency: e.target.value }))}>
                {CURRENCIES.map(c => <option key={c} value={c}>{FLAGS[c]} {c}</option>)}
              </select>
            </div>
          </div>
          {form.fromCurrency === form.toCurrency && (
            <div className="badge-blue text-xs p-2 rounded-lg">Same currency — 0 B2BinPay calls, 1 Fireblocks vault move</div>
          )}
          {form.fromCurrency !== form.toCurrency && (
            <div className="badge-yellow text-xs p-2 rounded-lg">Cross-currency — 2 B2BinPay calls + 1 Fireblocks + JIT rate lock</div>
          )}
          {err && <p className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg p-2">{err}</p>}
          <button className="btn-primary w-full" onClick={fetchQuote} disabled={loading}>
            {loading ? 'Fetching quote…' : 'Get Live Quote →'}
          </button>
        </div>
      )}

      {step === 'confirm' && quote && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="card space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-gray-300">Rate Locked</h2>
              <div className={`mono text-sm font-semibold ${countdown <= 10 ? 'text-red-400' : 'text-brand-400'}`}>
                {countdown}s
              </div>
            </div>
            <div className="space-y-3">
              <div className="flex justify-between items-center py-2 border-b border-gray-800">
                <span className="text-sm text-gray-400">Sender</span>
                <span className="text-sm text-white">{senderName}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-gray-800">
                <span className="text-sm text-gray-400">Receiver</span>
                <span className="text-sm text-white">{receiverName}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-gray-800">
                <span className="text-sm text-gray-400">Sending</span>
                <span className="text-sm font-semibold text-white">{currencySymbol(form.fromCurrency)}{form.amount} {form.fromCurrency}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-gray-800">
                <span className="text-sm text-gray-400">Receiving</span>
                <span className="text-sm font-semibold text-emerald-400">{currencySymbol(form.toCurrency)}{quote.to.amount.toLocaleString()} {form.toCurrency}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-gray-800">
                <span className="text-sm text-gray-400">Rate</span>
                <span className="text-sm mono text-white">1 {form.fromCurrency} = {quote.rate.toFixed(4)} {form.toCurrency}</span>
              </div>
              <div className="flex justify-between items-center py-2">
                <span className="text-sm text-gray-400">Fee</span>
                <span className="text-sm text-emerald-400">{quote.fee}</span>
              </div>
            </div>
            <div className="text-xs text-gray-600 mono">Quote ID: {quote.quoteId}</div>
            {err && <p className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg p-2">{err}</p>}
            <div className="flex gap-2">
              <button className="btn-secondary flex-1" onClick={reset}>Back</button>
              <button className="btn-primary flex-1" onClick={executeTransfer} disabled={loading}>
                {loading ? 'Processing…' : 'Confirm & Send'}
              </button>
            </div>
          </div>
          <div className="card space-y-4">
            <h3 className="text-xs font-mono text-gray-500 uppercase tracking-wider">RFQ · Revenue</h3>
            <div className="space-y-2 text-xs">
              <RevRow label="Winning LP" value={quote.rfq.winningLP} />
              <RevRow label="LP rate (institutional)" value={quote.rfq.lpRate.toFixed(6)} />
              <RevRow label="Customer rate" value={quote.rfq.customerRate.toFixed(6)} />
              <RevRow label="AxLink spread" value={quote.rfq.axlinkSpread} />
              <RevRow label="LPs in RFQ" value={quote.rfq.registeredLPs.join(', ')} />
              <div className="border-t border-gray-800 pt-2 space-y-2">
                <RevRow label="FinCruse profit" value={quote.revenueModel.profitPerTx} positive />
                <RevRow label="Fireblocks gas" value={quote.revenueModel.fireblocksGas} />
                <RevRow label="SWIFT avoided" value={quote.revenueModel.swiftNotPaid} />
                <RevRow label="vs Traditional" value={quote.revenueModel.vsTraditional} />
              </div>
            </div>
          </div>
        </div>
      )}

      {step === 'result' && result && (
        <div className="card max-w-lg space-y-4">
          <div className="flex items-center gap-2">
            <span className="badge-green text-sm">✓ Transfer Complete</span>
          </div>
          <div className="space-y-2 text-sm">
            <ResultRow label="Transfer ID" value={result.transferId} mono />
            <ResultRow label="Tracking ID" value={result.trackingId} mono />
            <ResultRow label="Status" value={result.status} />
            <ResultRow label="From Amount" value={`${result.fromAmount}`} />
            <ResultRow label="To Amount" value={`${result.toAmount}`} />
            <ResultRow label="FX Rate" value={`${result.fxRate}`} mono />
            <ResultRow label="B2BinPay Calls" value={`${result.b2binpayCalls}`} />
            <ResultRow label="Fireblocks Calls" value={`${result.fireblocksCalls}`} />
            <div className="bg-gray-800/60 rounded-lg p-3 mt-2">
              <div className="text-xs text-gray-500 mb-1">Flow</div>
              <div className="text-xs mono text-gray-300">{result.flow}</div>
            </div>
          </div>
          <button className="btn-primary w-full" onClick={reset}>New Transfer</button>
        </div>
      )}
    </div>
  )
}

function RevRow({ label, value, positive }: { label: string; value: string; positive?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-500">{label}</span>
      <span className={`mono ${positive ? 'text-emerald-400' : 'text-gray-300'}`}>{value}</span>
    </div>
  )
}

function ResultRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between py-1 border-b border-gray-800">
      <span className="text-gray-400">{label}</span>
      <span className={`text-white ${mono ? 'font-mono text-xs' : ''}`}>{value}</span>
    </div>
  )
}
