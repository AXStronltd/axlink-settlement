import { useEffect, useState } from 'react'
import {
  getCorridors, createDemoUser, depositFiat, confirmUsdtLanded,
  createQuote, runTransfer, runWithdrawal,
  type Corridor,
} from '../api'

// Every hop the money makes, timed. The point of this page is that the numbers
// are real — each row is one API call against the running service, and the
// milliseconds are how long that call actually took.

type StepState = 'pending' | 'running' | 'done' | 'failed'

interface Step {
  key: string
  layer: string          // which part of the stack did the work
  label: string
  state: StepState
  ms?: number
  detail?: string
  error?: string
}

const BLANK: Step[] = [
  { key: 'users',    layer: 'LEDGER',     label: 'Open two accounts',              state: 'pending' },
  { key: 'deposit',  layer: 'RAIL',       label: 'Sender funds their account',     state: 'pending' },
  { key: 'confirm',  layer: 'CUSTODY',    label: 'Fireblocks confirms USDT landed', state: 'pending' },
  { key: 'quote',    layer: 'FX',         label: 'JIT RFQ — lock a rate',          state: 'pending' },
  { key: 'transfer', layer: 'SETTLEMENT', label: 'Move the money',                 state: 'pending' },
  { key: 'payout',   layer: 'PARTNER',    label: 'Pay out to local rail',          state: 'pending' },
]

const LAYER_COLOR: Record<string, string> = {
  LEDGER:     'text-sky-400 bg-sky-500/10 border-sky-500/20',
  RAIL:       'text-amber-400 bg-amber-500/10 border-amber-500/20',
  CUSTODY:    'text-violet-400 bg-violet-500/10 border-violet-500/20',
  FX:         'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  SETTLEMENT: 'text-brand-400 bg-brand-600/10 border-brand-600/20',
  PARTNER:    'text-rose-400 bg-rose-500/10 border-rose-500/20',
}

const DEST_FOR = (ccy: string): Record<string, string> =>
  ['KES', 'TZS', 'UGX'].includes(ccy)
    ? { type: 'mpesa', method: 'mobile_money', mobileNumber: '+254712345678' }
    : { type: 'bank_transfer', method: 'bank_transfer', accountNumber: '31926819', bankCode: '001' }

export default function LiveDemo() {
  const [corridors, setCorridors] = useState<Corridor[]>([])
  const [from, setFrom]   = useState('USD')
  const [to, setTo]       = useState('KES')
  const [amount, setAmount] = useState(1000)
  const [send, setSend]   = useState(300)
  const [steps, setSteps] = useState<Step[]>(BLANK)
  const [running, setRunning] = useState(false)
  const [summary, setSummary] = useState<Record<string, string> | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)

  useEffect(() => {
    getCorridors()
      .then(r => setCorridors(r.currencies))
      .catch(e => setFatal(
        `${e.message}. The Live Demo needs the backend running with DEMO_ENABLED=true.`))
  }, [])

  const set = (key: string, patch: Partial<Step>) =>
    setSteps(prev => prev.map(s => (s.key === key ? { ...s, ...patch } : s)))

  /** Run one step, timing it. Throws to stop the corridor at the first failure. */
  async function timed<T>(key: string, fn: () => Promise<T>): Promise<T> {
    set(key, { state: 'running' })
    const t0 = performance.now()
    try {
      const out = await fn()
      set(key, { state: 'done', ms: Math.round(performance.now() - t0) })
      return out
    } catch (e) {
      const err = e as Error
      set(key, { state: 'failed', ms: Math.round(performance.now() - t0), error: err.message })
      throw err
    }
  }

  async function run() {
    setRunning(true); setSummary(null); setFatal(null)
    setSteps(BLANK.map(s => ({ ...s })))
    const t0 = performance.now()

    try {
      const { sender, receiver } = await timed('users', async () => {
        const [sender, receiver] = await Promise.all([
          createDemoUser({ name: 'Sender', currency: from }),
          createDemoUser({ name: 'Receiver', currency: to }),
        ])
        return { sender, receiver }
      })
      set('users', { detail: `${from} sender · ${to} receiver` })

      const dep = await timed('deposit', () => depositFiat({
        userId: sender.id, currency: from, amount,
        rail: 'bank_transfer', railReference: `demo_${Date.now()}`,
      }))
      set('deposit', { detail: `${amount} ${from} — ${dep.status}, balance still 0` })

      await timed('confirm', () => confirmUsdtLanded({
        vaultId: sender.vaultId, trackingId: dep.trackingId, amount,
      }))
      set('confirm', { detail: `balance now ${amount} ${from}` })

      const quote = await timed('quote', () => createQuote({
        fromCurrency: from, toCurrency: to, fromAmount: send,
      })) as unknown as {
        quoteId: string; rate: number
        to: { amount: number }
        rfq?: { winningLP?: string; axlinkSpread?: string }
        revenueModel?: { axlinkRevenue?: string }
      }
      set('quote', {
        detail: `1 ${from} = ${quote.rate?.toFixed(4)} ${to} · LP ${quote.rfq?.winningLP ?? '—'}`,
      })

      await timed('transfer', () => runTransfer({
        senderId: sender.id, receiverId: receiver.id,
        fromCurrency: from, toCurrency: to, amount: send, quoteId: quote.quoteId,
      }))
      set('transfer', { detail: `${send} ${from} → ${quote.to?.amount?.toLocaleString()} ${to}` })

      const payoutAmount = Math.max(1, Math.floor((quote.to?.amount ?? 0) / 2))
      const wd = await timed('payout', () => runWithdrawal({
        userId: receiver.id, currency: to, amount: payoutAmount,
        recipientName: 'Receiver', destination: DEST_FOR(to),
      }))
      set('payout', { detail: `${payoutAmount.toLocaleString()} ${to} — ${wd.status}` })

      setSummary({
        'Total time':      `${Math.round(performance.now() - t0)} ms`,
        'Moves':           '6',
        'Rate':            `1 ${from} = ${quote.rate?.toFixed(4)} ${to}`,
        'Recipient gets':  `${quote.to?.amount?.toLocaleString()} ${to}`,
        'Winning LP':      quote.rfq?.winningLP ?? '—',
        'Spread':          quote.rfq?.axlinkSpread ?? '—',
        'Revenue':         quote.revenueModel?.axlinkRevenue ?? '—',
        'Payout rail':     corridors.find(c => c.code === to)?.rail ?? '—',
        'SWIFT hops':      '0',
      })
    } catch {
      // The failing step already shows its own error.
    } finally {
      setRunning(false)
    }
  }

  const opt = (c: Corridor) =>
    `${c.flag}  ${c.code} · ${c.country}${c.deliverable ? '' : '  (no payout partner)'}`

  return (
    <div className="p-8 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-white">Live Demo</h1>
        <p className="text-sm text-gray-400 mt-1">
          Drives the real corridor — real accounts, real ledger, real JIT quote, real
          webhook. Every duration below is how long that call actually took.
        </p>
      </div>

      {fatal && (
        <div className="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">
          {fatal}
        </div>
      )}

      {/* Corridor picker */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-5 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <label className="text-sm">
            <span className="block text-gray-400 mb-1.5">From</span>
            <select value={from} onChange={e => setFrom(e.target.value)}
              className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-gray-200">
              {corridors.map(c => <option key={c.code} value={c.code}>{opt(c)}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-gray-400 mb-1.5">To</span>
            <select value={to} onChange={e => setTo(e.target.value)}
              className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-gray-200">
              {corridors.map(c => <option key={c.code} value={c.code}>{opt(c)}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-gray-400 mb-1.5">Fund account</span>
            <input type="number" value={amount} min={1}
              onChange={e => setAmount(Number(e.target.value))}
              className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-gray-200" />
          </label>
          <label className="text-sm">
            <span className="block text-gray-400 mb-1.5">Send</span>
            <input type="number" value={send} min={1}
              onChange={e => setSend(Number(e.target.value))}
              className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-gray-200" />
          </label>
        </div>

        <button onClick={run} disabled={running || !!fatal}
          className="mt-4 px-5 py-2.5 rounded-lg bg-brand-600 hover:bg-brand-500 disabled:opacity-40
                     disabled:cursor-not-allowed text-white text-sm font-medium transition">
          {running ? 'Running…' : `Run ${from} → ${to}`}
        </button>

        {to && !corridors.find(c => c.code === to)?.deliverable && (
          <p className="mt-3 text-xs text-amber-400">
            No registered payout partner delivers {to}. It can be priced and settled
            internally, but the payout step will fail — which is itself worth seeing.
          </p>
        )}
      </div>

      {/* Steps */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/60 divide-y divide-gray-800">
        {steps.map((s, i) => (
          <div key={s.key} className="flex items-start gap-4 px-5 py-4">
            <div className="w-6 text-center pt-0.5">
              {s.state === 'done'    && <span className="text-emerald-400">✓</span>}
              {s.state === 'failed'  && <span className="text-rose-400">✕</span>}
              {s.state === 'running' && <span className="text-brand-400 animate-pulse">●</span>}
              {s.state === 'pending' && <span className="text-gray-700">{i + 1}</span>}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2.5 flex-wrap">
                <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${LAYER_COLOR[s.layer]}`}>
                  {s.layer}
                </span>
                <span className={s.state === 'pending' ? 'text-gray-500' : 'text-gray-200'}>
                  {s.label}
                </span>
              </div>
              {s.detail && <div className="text-xs text-gray-500 mt-1">{s.detail}</div>}
              {s.error  && <div className="text-xs text-rose-400 mt-1 font-mono">{s.error}</div>}
            </div>

            <div className="text-xs font-mono text-gray-500 pt-0.5 w-16 text-right">
              {s.ms !== undefined ? `${s.ms} ms` : ''}
            </div>
          </div>
        ))}
      </div>

      {/* Summary */}
      {summary && (
        <div className="mt-6 rounded-xl border border-gray-800 bg-gray-900/60 p-5">
          <div className="text-sm font-medium text-white mb-3">Result</div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3">
            {Object.entries(summary).map(([k, v]) => (
              <div key={k}>
                <div className="text-xs text-gray-500">{k}</div>
                <div className="text-sm text-gray-200 font-mono mt-0.5">{v}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
