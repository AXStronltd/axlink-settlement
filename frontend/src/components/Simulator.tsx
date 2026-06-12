import { useState, useEffect, useRef } from 'react'
import { simulateTransfer, simulateDeposit, simulateWithdraw, type SimStep } from '../api'

type Mode = 'transfer' | 'deposit' | 'withdraw'

const CURRENCIES = ['GBP', 'USD', 'EUR', 'CAD', 'KES', 'NGN', 'GHS', 'ZAR', 'UGX', 'TZS']
const FLAGS: Record<string, string> = {
  KES:'🇰🇪', NGN:'🇳🇬', GHS:'🇬🇭', ZAR:'🇿🇦', UGX:'🇺🇬', TZS:'🇹🇿',
  GBP:'🇬🇧', EUR:'🇪🇺', USD:'🇺🇸', CAD:'🇨🇦',
}
const RAILS: Record<string, string[]> = {
  // Daraja — Safaricom M-Pesa API (Kenya only)
  KES: ['Daraja (M-Pesa Kenya)', 'Choice Bank Transfer'],
  // Choice Bank — African bank rails
  UGX: ['Choice Bank Transfer'], TZS: ['Choice Bank Transfer'],
  NGN: ['Choice Bank Transfer'], GHS: ['Choice Bank Transfer'],
  ZAR: ['Choice Bank Transfer'],
  // Brainrock — EU, UK, USA, Canada
  GBP: ['Brainrock Faster Payments'], EUR: ['Brainrock SEPA'],
  USD: ['Brainrock ACH'], CAD: ['Brainrock EFT'],
}

const LAYER_COLOR: Record<string, string> = {
  'AXLINK FX':    'bg-brand-900/40 border-brand-700 text-brand-300',
  'LEDGER':       'bg-blue-900/40 border-blue-700 text-blue-300',
  'B2BINPAY':     'bg-amber-900/40 border-amber-700 text-amber-300',
  'FIREBLOCKS':   'bg-cyan-900/40 border-cyan-700 text-cyan-300',
  'ORCHESTRATOR': 'bg-indigo-900/40 border-indigo-700 text-indigo-300',
  'BRAINROCK':    'bg-purple-900/40 border-purple-700 text-purple-300',
  'CHOICE BANK':  'bg-green-900/40 border-green-700 text-green-300',
  'DARAJA':       'bg-teal-900/40 border-teal-700 text-teal-300',
  'COMPLETE':     'bg-emerald-900/40 border-emerald-700 text-emerald-300',
}

const MONEY_COLOR: Record<string, string> = {
  debit:  'text-red-400',
  credit: 'text-emerald-400',
  move:   'text-cyan-400',
  info:   'text-gray-400',
}

function railForCurrency(c: string): string {
  const r = RAILS[c]
  return r ? r[0] : 'Bank Transfer'
}

export default function Simulator() {
  const [mode, setMode] = useState<Mode>('transfer')
  const [fromCurr, setFromCurr] = useState('GBP')
  const [toCurr, setToCurr] = useState('NGN')
  const [currency, setCurrency] = useState('NGN')
  const [amount, setAmount] = useState('500')
  const [rail, setRail] = useState('Choice Bank Transfer')
  const [steps, setSteps] = useState<SimStep[]>([])
  const [active, setActive] = useState(-1)
  const [running, setRunning] = useState(false)
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [err, setErr] = useState('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // runId lets us cancel stale advance() closures when a new run starts
  const runIdRef = useRef(0)

  const stopTimer = () => { if (timerRef.current) clearTimeout(timerRef.current) }

  const hardReset = () => {
    stopTimer(); setSteps([]); setActive(-1); setDone(false); setErr(''); setRunning(false); setLoading(false)
  }

  // mode change: full reset (no steps to keep)
  useEffect(() => { hardReset() }, [mode]) // eslint-disable-line react-hooks/exhaustive-deps

  const stopRun = () => {
    stopTimer()
    runIdRef.current++ // invalidate any in-flight advance()
    setRunning(false)
    setDone(false)
  }

  const run = async () => {
    if (loading || running) return // prevent double-fire
    stopTimer()
    const myRunId = ++runIdRef.current
    setLoading(true); setErr(''); setRunning(false); setDone(false); setActive(-1)

    try {
      let result: { steps: SimStep[] }
      if (mode === 'transfer') result = await simulateTransfer(fromCurr, toCurr, Number(amount))
      else if (mode === 'deposit') result = await simulateDeposit(currency, Number(amount), rail)
      else result = await simulateWithdraw(currency, Number(amount), rail)

      // If a newer run was started while we were fetching, discard this result
      if (myRunId !== runIdRef.current) return

      const s = result.steps
      if (!s || s.length === 0) { setErr('No steps returned from simulator'); setLoading(false); return }

      // Update steps atomically then start animation — no blank-flash window
      setSteps(s); setLoading(false); setRunning(true)

      const advance = (idx: number) => {
        if (myRunId !== runIdRef.current) return // stale run cancelled
        if (idx >= s.length) { setRunning(false); setDone(true); setActive(s.length - 1); return }
        setActive(idx)
        timerRef.current = setTimeout(() => advance(idx + 1), s[idx].duration)
      }
      advance(0)
    } catch (e: unknown) {
      if (myRunId !== runIdRef.current) return
      setErr(e instanceof Error ? e.message : String(e))
      setLoading(false)
    }
  }

  const progress = steps.length > 0 ? Math.round(((active + 1) / steps.length) * 100) : 0
  const currentStep = active >= 0 ? steps[active] : null
  const availableRails = mode !== 'transfer' ? (RAILS[currency] ?? ['Bank Transfer']) : []
  const btnBusy = loading || running

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-white">Flow Simulator</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Watch AxLink execute step by step — JIT RFQ broadcasts to all LPs · Fireblocks USDT on Solana · local rails at the edges
        </p>
      </div>

      {/* Mode tabs */}
      <div className="flex gap-2">
        {(['transfer', 'deposit', 'withdraw'] as Mode[]).map(m => (
          <button key={m} onClick={() => setMode(m)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${mode === m ? 'bg-brand-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}>
            {m === 'transfer' ? '⇄ P2P Transfer' : m === 'deposit' ? '↓ Deposit' : '↑ Withdrawal'}
          </button>
        ))}
      </div>

      {/* Config bar */}
      <div className="card">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 items-end">
          {mode === 'transfer' ? (
            <>
              <div>
                <label className="label">From</label>
                <select className="input" value={fromCurr} onChange={e => setFromCurr(e.target.value)}>
                  {CURRENCIES.map(c => <option key={c} value={c}>{FLAGS[c] ?? ''} {c}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Amount</label>
                <input className="input" type="number" value={amount} onChange={e => setAmount(e.target.value)} />
              </div>
              <div>
                <label className="label">To</label>
                <select className="input" value={toCurr} onChange={e => setToCurr(e.target.value)}>
                  {CURRENCIES.map(c => <option key={c} value={c}>{FLAGS[c] ?? ''} {c}</option>)}
                </select>
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="label">Currency</label>
                <select className="input" value={currency} onChange={e => {
                  const c = e.target.value
                  setCurrency(c); setRail(railForCurrency(c))
                }}>
                  {CURRENCIES.map(c => <option key={c} value={c}>{FLAGS[c] ?? ''} {c}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Amount</label>
                <input className="input" type="number" value={amount} onChange={e => setAmount(e.target.value)} />
              </div>
              <div>
                <label className="label">Rail</label>
                <select className="input" value={rail} onChange={e => setRail(e.target.value)}>
                  {availableRails.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            </>
          )}
          <div>
            <button
              className="btn-primary w-full"
              onClick={running ? stopRun : run}
              disabled={loading}
            >
              {loading ? 'Loading…' : running ? '■ Stop' : done ? '↺ Run Again' : '▷ Run'}
            </button>
          </div>
        </div>

        {/* Rail badge */}
        {mode === 'transfer' && (
          <div className="mt-3 flex items-center gap-3 text-xs">
            <RailBadge currency={fromCurr} label="Sender rail" />
            <span className="text-gray-600">→</span>
            <RailBadge currency={toCurr} label="Receiver rail" />
            {fromCurr === toCurr
              ? <span className="badge-blue ml-2">Direct Ledger · 0 LPs · 0 float</span>
              : <span className="badge-yellow ml-2">JIT RFQ · 2 LPs race · Fireblocks USDT</span>}
          </div>
        )}

        {err && <p className="mt-3 text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg p-2">{err}</p>}
      </div>

      {steps.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Step list */}
          <div className="lg:col-span-1 space-y-1.5">
            <div className="flex items-center justify-between mb-2">
              <span className={`text-xs ${done ? 'text-emerald-400' : loading ? 'text-gray-500' : running ? 'text-brand-400' : 'text-gray-500'}`}>
                {done ? '✓ Complete' : loading ? '⏳ Fetching steps…' : running ? '● Running…' : steps.length > 0 ? 'Stopped' : 'Ready'}
              </span>
              <span className="text-xs mono text-gray-500">{steps.length > 0 ? `${Math.max(active + 1, 0)}/${steps.length}` : '—'}</span>
            </div>
            <div className="h-1 bg-gray-800 rounded-full overflow-hidden mb-3">
              <div className={`h-full rounded-full transition-all duration-300 ${loading ? 'bg-gray-600 animate-pulse w-full' : 'bg-brand-500'}`}
                style={{ width: loading ? '100%' : `${progress}%` }} />
            </div>

            {steps.map((s, i) => {
              const isActive = i === active
              const isPast = i < active
              const cls = isActive
                ? (LAYER_COLOR[s.layer] ?? 'bg-gray-800 border-gray-700 text-gray-200')
                : isPast
                  ? 'bg-gray-800/20 border-gray-700/20 text-gray-600'
                  : 'bg-gray-800/10 border-gray-800 text-gray-700'
              return (
                <button key={i} onClick={() => setActive(i)}
                  className={`w-full text-left rounded-lg border p-2.5 transition ${cls}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono font-semibold tracking-wide">{s.layer}</span>
                    <span className="text-xs opacity-50">{s.step}</span>
                  </div>
                  <div className="text-xs mt-0.5 truncate opacity-80">{s.action}</div>
                </button>
              )
            })}
          </div>

          {/* Detail panel */}
          <div className="lg:col-span-2 space-y-4">
            {currentStep && (
              <>
                <div className={`rounded-xl border p-5 ${LAYER_COLOR[currentStep.layer] ?? 'bg-gray-800 border-gray-700'}`}>
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-mono font-bold tracking-widest opacity-70 uppercase">{currentStep.layer}</span>
                    <span className="text-xs opacity-50">Step {currentStep.step} / {currentStep.total}</span>
                  </div>
                  <h3 className="text-base font-semibold text-white mb-2">{currentStep.action}</h3>
                  <p className="text-sm opacity-80 leading-relaxed">{currentStep.detail}</p>
                </div>

                {currentStep.money.length > 0 && (
                  <div className="card">
                    <div className="text-xs font-mono text-gray-500 mb-3 uppercase tracking-wider">Money Movement</div>
                    <div className="space-y-0">
                      {currentStep.money.map((m, i) => (
                        <div key={i} className="flex items-center justify-between py-2.5 border-b border-gray-800/60 last:border-0">
                          <span className="text-xs text-gray-400">{m.label}</span>
                          <div className="text-right">
                            <div className={`text-sm font-mono font-semibold ${MONEY_COLOR[m.direction]}`}>{m.amount}</div>
                            {m.currency && <div className="text-xs text-gray-600">{m.currency}</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {done && (
              <div className="card border-emerald-700 bg-emerald-900/20">
                <div className="flex items-center gap-3 text-emerald-400">
                  <span className="text-2xl">✓</span>
                  <div>
                    <div className="font-semibold">Settlement Complete</div>
                    <div className="text-xs text-emerald-500 mt-0.5">
                      {steps.length} layers executed · JIT RFQ · Fireblocks USDT · User sees fiat only
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function RailBadge({ currency, label }: { currency: string; label: string }) {
  const isDaraja    = currency === 'KES'
  const isChoice    = ['NGN', 'GHS', 'ZAR', 'UGX', 'TZS'].includes(currency)
  const isBrainrock = ['GBP', 'USD', 'EUR', 'CAD'].includes(currency)
  const color    = isDaraja ? 'text-teal-400' : isChoice ? 'text-green-400' : isBrainrock ? 'text-violet-400' : 'text-gray-400'
  const provider = isDaraja ? 'Daraja' : isChoice ? 'Choice Bank' : isBrainrock ? 'Brainrock' : 'Bank'
  return (
    <span className="text-gray-500">
      {label}: <span className={`font-medium ${color}`}>{currency} → {provider}</span>
    </span>
  )
}
