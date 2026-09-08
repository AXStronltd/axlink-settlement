import { useState, useEffect, useRef } from 'react'
import {
  lookupUser, initiateDeposit, getDepositStatus, triggerDeposit,
  type DepositMethod, type InitiateDepositRes, type DepositStatusRes,
} from '../api'

// Currencies Brainrock supports for user-initiated deposits
const ADD_FUNDS_CURRENCIES = ['GBP', 'EUR', 'USD', 'CAD', 'AED', 'CHF']
const FLAGS: Record<string, string> = {
  GBP: '🇬🇧', EUR: '🇪🇺', USD: '🇺🇸', CAD: '🇨🇦', AED: '🇦🇪', CHF: '🇨🇭',
  KES: '🇰🇪', NGN: '🇳🇬', GHS: '🇬🇭', ZAR: '🇿🇦', UGX: '🇺🇬', TZS: '🇹🇿',
}

const METHOD_LABELS: Record<DepositMethod, { label: string; icon: string; desc: string }> = {
  apple_pay:    { label: 'Apple Pay',    icon: '🍎', desc: 'Pay with Touch ID or Face ID' },
  google_pay:   { label: 'Google Pay',   icon: '🔵', desc: 'Pay from your Google Wallet' },
  open_banking: { label: 'Open Banking', icon: '🏦', desc: 'Instant bank transfer via your bank app' },
  bank_transfer: { label: 'Bank Transfer', icon: '⇄', desc: 'Standard bank-to-bank transfer' },
}

const CURRENCY_METHODS: Record<string, DepositMethod[]> = {
  GBP: ['open_banking', 'apple_pay', 'google_pay'],
  EUR: ['open_banking', 'apple_pay', 'google_pay'],
  USD: ['apple_pay', 'google_pay'],
  CAD: ['open_banking', 'apple_pay', 'google_pay'],
  AED: ['apple_pay', 'google_pay'],
  CHF: ['open_banking', 'apple_pay', 'google_pay'],
}

const STATUS_COLORS: Record<string, string> = {
  AWAITING_PAYMENT: 'text-yellow-400 bg-yellow-900/20 border-yellow-800',
  PROCESSING:       'text-blue-400 bg-blue-900/20 border-blue-800',
  COMPLETED:        'text-emerald-400 bg-emerald-900/20 border-emerald-800',
  FAILED:           'text-red-400 bg-red-900/20 border-red-800',
}

type Step = 'user' | 'amount' | 'method' | 'confirm' | 'pending' | 'done'

export default function Deposits() {
  const [step, setStep] = useState<Step>('user')
  const [email, setEmail] = useState('')
  const [userId, setUserId] = useState('')
  const [userName, setUserName] = useState('')
  const [currency, setCurrency] = useState('GBP')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<DepositMethod>('open_banking')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [session, setSession] = useState<InitiateDepositRes | null>(null)
  const [status, setStatus] = useState<DepositStatusRes | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Admin trigger state (ops panel)
  const [showOps, setShowOps] = useState(false)
  const [opsRail, setOpsRail] = useState('Faster Payments')
  const [opsRef, setOpsRef] = useState('')
  const [opsResult, setOpsResult] = useState<{ depositId: string; trackingId: string; status: string } | null>(null)

  const availableMethods = CURRENCY_METHODS[currency] ?? ['bank_transfer']

  // When currency changes, reset method if current choice isn't available
  useEffect(() => {
    if (!availableMethods.includes(method)) setMethod(availableMethods[0])
  }, [currency])

  // Poll deposit status after initiation
  useEffect(() => {
    if (!session || !userId) return
    pollRef.current = setInterval(async () => {
      try {
        const s = await getDepositStatus(session.depositId, userId)
        setStatus(s)
        if (s.status === 'COMPLETED' || s.status === 'FAILED') {
          clearInterval(pollRef.current!)
          setStep('done')
        }
      } catch {}
    }, 3000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [session, userId])

  const resolveUser = async () => {
    if (!email) return
    setLoading(true); setErr('')
    try {
      const u = await lookupUser(email)
      setUserId(u.id); setUserName(u.name)
      setStep('amount')
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }

  const startDeposit = async () => {
    if (!userId || !amount || Number(amount) <= 0) return
    setLoading(true); setErr('')
    try {
      const res = await initiateDeposit({ userId, currency, amount: Number(amount), method })
      setSession(res)
      setStep('pending')
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }

  const triggerOpsDeposit = async () => {
    if (!userId || !amount) return
    setLoading(true); setErr('')
    try {
      const res = await triggerDeposit({
        userId, currency, amount: Number(amount),
        rail: opsRail, railReference: opsRef || `ops_${Date.now()}`,
      })
      setOpsResult({ depositId: res.depositId, trackingId: res.trackingId, status: res.status })
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }

  const reset = () => {
    setStep('user'); setSession(null); setStatus(null); setErr('')
    setAmount(''); setEmail(''); setUserId(''); setUserName('')
    if (pollRef.current) clearInterval(pollRef.current)
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-white">Add Funds</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Apple Pay · Google Pay · Open Banking — fiat lands in AxLink segregated account,
          AxLink converts internally, user sees local currency credited
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">

        {/* ── Left: stepper form ── */}
        <div className="lg:col-span-3 space-y-4">

          {/* Step 1: User */}
          <div className={`card space-y-3 transition-opacity ${step !== 'user' && userId ? 'opacity-60' : ''}`}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-gray-300">1 · Identify User</h2>
              {userId && <span className="text-xs text-emerald-400">✓ {userName}</span>}
            </div>
            {step === 'user' && (
              <div className="flex gap-2">
                <input className="input" placeholder="user@example.com"
                  value={email} onChange={e => setEmail(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && resolveUser()} />
                <button className="btn-primary flex-shrink-0" onClick={resolveUser} disabled={loading || !email}>
                  {loading ? '…' : 'Find'}
                </button>
              </div>
            )}
          </div>

          {/* Step 2: Currency + Amount */}
          {(step === 'amount' || step === 'method' || step === 'confirm') && (
            <div className="card space-y-4">
              <h2 className="text-sm font-medium text-gray-300">2 · Amount</h2>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Currency</label>
                  <select className="input" value={currency} onChange={e => setCurrency(e.target.value)}>
                    {ADD_FUNDS_CURRENCIES.map(c => (
                      <option key={c} value={c}>{FLAGS[c]} {c}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">Amount</label>
                  <input className="input" type="number" min="1" placeholder="500"
                    value={amount} onChange={e => setAmount(e.target.value)} />
                </div>
              </div>
              {step === 'amount' && (
                <button className="btn-primary w-full"
                  disabled={!amount || Number(amount) <= 0}
                  onClick={() => setStep('method')}>
                  Continue
                </button>
              )}
            </div>
          )}

          {/* Step 3: Payment Method */}
          {(step === 'method' || step === 'confirm') && (
            <div className="card space-y-3">
              <h2 className="text-sm font-medium text-gray-300">3 · Payment Method</h2>
              <div className="space-y-2">
                {availableMethods.map(m => {
                  const meta = METHOD_LABELS[m]
                  return (
                    <button key={m}
                      onClick={() => setMethod(m)}
                      className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all text-left
                        ${method === m
                          ? 'border-cyan-500 bg-cyan-900/20 text-white'
                          : 'border-gray-700 bg-gray-800/40 text-gray-400 hover:border-gray-500'}`}>
                      <span className="text-2xl w-8 flex-shrink-0">{meta.icon}</span>
                      <div>
                        <div className="font-medium text-sm">{meta.label}</div>
                        <div className="text-xs text-gray-500">{meta.desc}</div>
                      </div>
                      {method === m && <span className="ml-auto text-cyan-400 text-xs">✓</span>}
                    </button>
                  )
                })}
              </div>
              {step === 'method' && (
                <button className="btn-primary w-full" onClick={() => setStep('confirm')}>
                  Continue
                </button>
              )}
            </div>
          )}

          {/* Step 4: Confirm */}
          {step === 'confirm' && (
            <div className="card space-y-4">
              <h2 className="text-sm font-medium text-gray-300">4 · Confirm</h2>
              <div className="bg-gray-800/60 rounded-lg p-4 space-y-2 text-sm">
                <Row label="User"    value={userName} />
                <Row label="Amount"  value={`${FLAGS[currency]} ${Number(amount).toLocaleString()} ${currency}`} />
                <Row label="Method"  value={METHOD_LABELS[method].label} />
                <Row label="To"      value="AxLink segregated account (Brainrock)" />
              </div>
              <div className="text-xs text-gray-500 bg-gray-800/40 rounded-lg p-3 border border-gray-700">
                Funds are held in a ring-fenced segregated account at Brainrock, separate from AxLink
                operational funds. AxLink converts fiat → USDT internally — you will never see crypto.
              </div>
              {err && <p className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg p-2">{err}</p>}
              <button className="btn-primary w-full" onClick={startDeposit} disabled={loading}>
                {loading ? 'Initiating…' : `Pay ${Number(amount).toLocaleString()} ${currency} via ${METHOD_LABELS[method].label}`}
              </button>
            </div>
          )}

          {/* Step 5: Pending — payment in progress */}
          {(step === 'pending' || step === 'done') && session && (
            <div className="card space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-gray-300">Payment Status</h2>
                {step === 'pending' && (
                  <span className="flex items-center gap-1.5 text-xs text-blue-400">
                    <span className="animate-pulse w-2 h-2 rounded-full bg-blue-400 inline-block" />
                    Waiting for {METHOD_LABELS[session.method].label}…
                  </span>
                )}
              </div>

              {/* Payment action card */}
              <div className="bg-gray-800/60 rounded-lg p-4 space-y-3">
                {session.method === 'open_banking' && (
                  <div className="space-y-2">
                    <p className="text-xs text-gray-400">
                      You'll be redirected to your bank to authorise the payment.
                      Once authorised, funds arrive in the AxLink segregated account
                      and your balance is credited automatically.
                    </p>
                    <a href={session.checkoutUrl} target="_blank" rel="noreferrer"
                      className="btn-primary w-full text-center block">
                      🏦 Open Bank App to Authorise
                    </a>
                  </div>
                )}
                {(session.method === 'apple_pay' || session.method === 'google_pay') && (
                  <div className="space-y-2">
                    <p className="text-xs text-gray-400">
                      {session.method === 'apple_pay'
                        ? 'Your Apple Pay sheet is ready. Complete payment with Touch ID or Face ID.'
                        : 'Your Google Pay sheet is ready. Complete payment from your Google Wallet.'}
                    </p>
                    <div className="border border-dashed border-gray-600 rounded-lg p-4 text-center text-gray-500 text-sm">
                      {session.method === 'apple_pay' ? '🍎 Apple Pay sheet' : '🔵 Google Pay sheet'} would
                      launch here via the Brainrock JS SDK
                    </div>
                    <code className="text-xs text-gray-600 block break-all">
                      clientToken: {session.clientToken ?? session.sessionId}
                    </code>
                  </div>
                )}
              </div>

              {/* Live status polling */}
              {status && (
                <div className={`rounded-lg border p-3 text-sm ${STATUS_COLORS[status.status] ?? 'text-gray-400 border-gray-700'}`}>
                  <div className="font-medium">{status.statusLabel}</div>
                  <div className="text-xs mt-1 opacity-70">{status.flow}</div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 text-xs text-gray-500">
                <div>Session ID<br /><span className="font-mono text-gray-400">{session.sessionId.slice(0, 16)}…</span></div>
                <div>Expires<br /><span className="text-gray-400">{new Date(session.expiresAt).toLocaleTimeString()}</span></div>
              </div>

              {step === 'done' && status?.status === 'COMPLETED' && (
                <div className="text-center space-y-3">
                  <div className="text-3xl">✅</div>
                  <p className="text-emerald-400 font-medium">
                    {Number(session.amount).toLocaleString()} {session.currency} added to your account
                  </p>
                  <button className="btn-secondary w-full" onClick={reset}>Add More Funds</button>
                </div>
              )}

              {step === 'done' && status?.status === 'FAILED' && (
                <div className="text-center space-y-3">
                  <div className="text-3xl">❌</div>
                  <p className="text-red-400 font-medium">Payment failed — no funds were taken</p>
                  <button className="btn-secondary w-full" onClick={reset}>Try Again</button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Right: flow diagram + ops panel ── */}
        <div className="lg:col-span-2 space-y-4">

          {/* Flow diagram */}
          <div className="card">
            <div className="text-xs font-mono text-gray-500 mb-3 uppercase">End-to-End Flow</div>
            <div className="space-y-2 text-xs">
              {[
                { icon: '👤', label: 'User', detail: `Picks ${METHOD_LABELS[method]?.label ?? 'payment method'}`, active: step === 'confirm' },
                { icon: '💳', label: 'Brainrock', detail: 'Creates payment session', active: step === 'pending' },
                { icon: '🏦', label: 'Segregated Account', detail: `${amount || '?'} ${currency} lands ring-fenced`, active: step === 'pending' && status?.status === 'AWAITING_PAYMENT' },
                { icon: '🔔', label: 'AxLink Webhook', detail: 'payment.received fires', active: status?.status === 'PROCESSING' },
                { icon: '🔄', label: 'B2BinPay (internal)', detail: `${currency} → USDT (users never see this)`, active: status?.status === 'PROCESSING' },
                { icon: '🔐', label: 'Fireblocks Vault', detail: 'USDT in user vault (internal)', active: status?.status === 'PROCESSING' },
                { icon: '✅', label: 'Ledger Credit', detail: `+${amount || '?'} ${currency} visible to user`, active: status?.status === 'COMPLETED' },
              ].map((s, i) => (
                <div key={i} className={`flex items-start gap-2 p-2 rounded transition-colors
                  ${s.active ? 'bg-cyan-900/20 border border-cyan-800/50' : ''}`}>
                  <span className="text-base w-6 flex-shrink-0">{s.icon}</span>
                  <div>
                    <div className={`font-medium ${s.active ? 'text-cyan-300' : 'text-gray-400'}`}>{s.label}</div>
                    <div className="text-gray-600">{s.detail}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 pt-3 border-t border-gray-800 text-xs text-gray-600">
              No SWIFT · No crypto visible to user · JIT conversion internal to AxLink
            </div>
          </div>

          {/* Ops trigger panel */}
          <div className="card">
            <button className="flex items-center justify-between w-full text-xs text-gray-500"
              onClick={() => setShowOps(v => !v)}>
              <span>⚙ Ops: simulate fiat-arrived webhook</span>
              <span>{showOps ? '▲' : '▼'}</span>
            </button>
            {showOps && (
              <div className="mt-3 space-y-3">
                <p className="text-xs text-gray-600">
                  Triggers handleFiatArrived directly — as if a bank webhook just fired.
                  Use this in sandbox when you don't have real Apple Pay configured.
                </p>
                {!userId && <p className="text-xs text-yellow-500">Resolve a user above first</p>}
                <div>
                  <label className="label">Rail</label>
                  <select className="input" value={opsRail} onChange={e => setOpsRail(e.target.value)}>
                    {['Faster Payments', 'SEPA', 'ACH', 'Open Banking', 'Bank Transfer'].map(r =>
                      <option key={r}>{r}</option>
                    )}
                  </select>
                </div>
                <div>
                  <label className="label">Rail Reference (optional)</label>
                  <input className="input" placeholder="auto-generated"
                    value={opsRef} onChange={e => setOpsRef(e.target.value)} />
                </div>
                {err && <p className="text-xs text-red-400">{err}</p>}
                <button className="btn-secondary w-full text-xs" onClick={triggerOpsDeposit}
                  disabled={loading || !userId || !amount}>
                  {loading ? '…' : 'Trigger Deposit Webhook'}
                </button>
                {opsResult && (
                  <div className="text-xs space-y-1 text-gray-400">
                    <div>Deposit <span className="font-mono text-gray-300">{opsResult.depositId}</span></div>
                    <div>Status <span className="text-emerald-400">{opsResult.status}</span></div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-1 border-b border-gray-800 last:border-0">
      <span className="text-gray-500">{label}</span>
      <span className="text-white text-right">{value}</span>
    </div>
  )
}
