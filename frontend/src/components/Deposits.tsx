import { useState } from 'react'
import { lookupUser, triggerDeposit, type DepositRes } from '../api'

const CURRENCIES = ['KES', 'NGN', 'GHS', 'GBP', 'EUR', 'USD', 'ZAR', 'UGX', 'TZS']
const FLAGS: Record<string, string> = { KES:'🇰🇪', NGN:'🇳🇬', GHS:'🇬🇭', ZAR:'🇿🇦', UGX:'🇺🇬', TZS:'🇹🇿', GBP:'🇬🇧', EUR:'🇪🇺', USD:'🇺🇸' }
const RAILS: Record<string, string[]> = {
  KES: ['M-Pesa', 'Bank Transfer', 'RTGS'],
  NGN: ['Bank Transfer', 'RTGS'],
  GHS: ['Mobile Money', 'Bank Transfer'],
  GBP: ['Faster Payments', 'Bank Transfer', 'SWIFT'],
  EUR: ['SEPA', 'SWIFT'],
  USD: ['ACH', 'Wire', 'SWIFT'],
  ZAR: ['Bank Transfer', 'RTGS'],
  UGX: ['M-Pesa', 'Bank Transfer'],
  TZS: ['M-Pesa', 'Bank Transfer'],
}

export default function Deposits() {
  const [form, setForm] = useState({ email: '', currency: 'NGN', amount: '', rail: 'Bank Transfer', reference: '' })
  const [userId, setUserId] = useState('')
  const [userName, setUserName] = useState('')
  const [lookingUp, setLookingUp] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<DepositRes | null>(null)
  const [err, setErr] = useState('')

  const handleCurrencyChange = (c: string) => {
    const rails = RAILS[c] ?? ['Bank Transfer']
    setForm(f => ({ ...f, currency: c, rail: rails[0] }))
  }

  const resolveUser = async () => {
    if (!form.email) return
    setLookingUp(true); setErr('')
    try {
      const u = await lookupUser(form.email)
      setUserId(u.id); setUserName(u.name)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
      setUserId(''); setUserName('')
    } finally { setLookingUp(false) }
  }

  const submit = async () => {
    if (!userId) { setErr('Resolve user first'); return }
    if (!form.amount || Number(form.amount) <= 0) { setErr('Enter a valid amount'); return }
    setLoading(true); setErr(''); setResult(null)
    try {
      const res = await triggerDeposit({
        userId,
        currency: form.currency,
        amount: Number(form.amount),
        rail: form.rail,
        railReference: form.reference || `manual_${Date.now()}`,
      })
      setResult(res)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }

  const availableRails = RAILS[form.currency] ?? ['Bank Transfer']

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-white">Deposits</h1>
        <p className="text-sm text-gray-500 mt-0.5">Trigger a fiat-arrived event — simulates a bank/M-Pesa deposit landing for a user</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-4">
          <div className="card space-y-4">
            <h2 className="text-sm font-medium text-gray-300">Deposit Details</h2>

            {/* User lookup */}
            <div>
              <label className="label">User Email</label>
              <div className="flex gap-2">
                <input className="input" placeholder="user@example.com"
                  value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && resolveUser()} />
                <button className="btn-secondary flex-shrink-0" onClick={resolveUser} disabled={lookingUp || !form.email}>
                  {lookingUp ? '…' : 'Find'}
                </button>
              </div>
              {userName && (
                <div className="mt-1.5 flex items-center gap-1.5 text-xs text-emerald-400">
                  <span>✓</span><span>{userName}</span>
                  <span className="text-gray-600 mono">{userId.slice(0, 12)}…</span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Currency</label>
                <select className="input" value={form.currency} onChange={e => handleCurrencyChange(e.target.value)}>
                  {CURRENCIES.map(c => <option key={c} value={c}>{FLAGS[c]} {c}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Amount</label>
                <input className="input" type="number" min="0" placeholder="10000"
                  value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
              </div>
            </div>

            <div>
              <label className="label">Payment Rail</label>
              <select className="input" value={form.rail} onChange={e => setForm(f => ({ ...f, rail: e.target.value }))}>
                {availableRails.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>

            <div>
              <label className="label">Reference (optional)</label>
              <input className="input" placeholder="Bank ref / M-Pesa transaction ID"
                value={form.reference} onChange={e => setForm(f => ({ ...f, reference: e.target.value }))} />
            </div>

            {err && <p className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg p-2">{err}</p>}
            <button className="btn-primary w-full" onClick={submit} disabled={loading || !userId}>
              {loading ? 'Processing…' : `Trigger ${form.currency} Deposit via ${form.rail}`}
            </button>
          </div>

          {/* Flow explanation */}
          <div className="card">
            <div className="text-xs font-mono text-gray-500 mb-3 uppercase">What happens</div>
            <div className="space-y-2 text-xs text-gray-400">
              {[
                `${form.rail} → FinCruse webhook`,
                `Orchestrator finds user by ID`,
                `B2BinPay: ${form.currency} fiat → USDT`,
                `B2BinPay sends USDT → Fireblocks vault`,
                `Fireblocks webhook → ledger credit`,
                `User sees +${form.amount || '?'} ${form.currency} balance`,
              ].map((step, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="text-gray-600 w-4 flex-shrink-0">{i + 1}.</span>
                  <span>{step}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {result && (
          <div className="card space-y-3">
            <div className="flex items-center gap-2">
              <span className="badge-green">Deposit Triggered</span>
            </div>
            <div className="space-y-2 text-sm">
              <ResultRow label="Deposit ID" value={result.depositId} mono />
              <ResultRow label="Tracking ID" value={result.trackingId} mono />
              <ResultRow label="Status" value={result.status} />
            </div>
            <div className="bg-gray-800/60 rounded-lg p-3">
              <div className="text-xs text-gray-500 mb-1">Flow</div>
              <div className="text-xs mono text-gray-300">{result.flow}</div>
            </div>
            <div className="bg-gray-800/60 rounded-lg p-3">
              <div className="text-xs text-gray-500 mb-1">Message</div>
              <div className="text-xs text-gray-300">{result.message}</div>
            </div>
            <div className="text-xs text-yellow-400 bg-yellow-900/20 border border-yellow-800 rounded-lg p-2">
              Ledger credit fires after Fireblocks confirms USDT received — check user balance after webhook fires.
            </div>
          </div>
        )}
      </div>
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
