import { useState } from 'react'
import { lookupUser, orchestratorWithdraw, type WithdrawRes } from '../api'

const CURRENCIES = ['KES', 'NGN', 'GHS', 'GBP', 'EUR', 'USD', 'ZAR', 'UGX', 'TZS']
const FLAGS: Record<string, string> = { KES:'🇰🇪', NGN:'🇳🇬', GHS:'🇬🇭', ZAR:'🇿🇦', UGX:'🇺🇬', TZS:'🇹🇿', GBP:'🇬🇧', EUR:'🇪🇺', USD:'🇺🇸' }

type DestType = 'mpesa' | 'bank_transfer' | 'faster_payments' | 'sepa'

const DEST_TYPES: Record<string, { label: string; type: DestType; fields: string[] }> = {
  mpesa:           { label: 'M-Pesa',          type: 'mpesa',           fields: ['mobileNumber'] },
  bank_transfer:   { label: 'Bank Transfer',    type: 'bank_transfer',   fields: ['bankCode', 'bankAccountNumber'] },
  faster_payments: { label: 'Faster Payments',  type: 'faster_payments', fields: ['sortCode', 'accountNumber'] },
  sepa:            { label: 'SEPA',             type: 'sepa',            fields: ['iban', 'bic'] },
}

const CURRENCY_DEST: Record<string, string> = {
  KES: 'mpesa', NGN: 'bank_transfer', GHS: 'mpesa', UGX: 'mpesa', TZS: 'mpesa',
  GBP: 'faster_payments', EUR: 'sepa', USD: 'bank_transfer', ZAR: 'bank_transfer',
}

export default function Withdrawals() {
  const [form, setForm] = useState({
    email: '', currency: 'NGN', amount: '', recipientName: '',
    destType: 'bank_transfer',
    mobileNumber: '', bankCode: '', bankAccountNumber: '', sortCode: '', accountNumber: '', iban: '', bic: '',
  })
  const [userId, setUserId] = useState('')
  const [userName, setUserName] = useState('')
  const [lookingUp, setLookingUp] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<WithdrawRes | null>(null)
  const [err, setErr] = useState('')

  const handleCurrencyChange = (c: string) => {
    setForm(f => ({ ...f, currency: c, destType: CURRENCY_DEST[c] ?? 'bank_transfer' }))
  }

  const resolveUser = async () => {
    if (!form.email) return
    setLookingUp(true); setErr('')
    try {
      const u = await lookupUser(form.email)
      setUserId(u.id); setUserName(u.name)
      if (!form.recipientName) setForm(f => ({ ...f, recipientName: u.name }))
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
      setUserId(''); setUserName('')
    } finally { setLookingUp(false) }
  }

  const buildDestination = () => {
    const base: Record<string, string> = { type: form.destType, name: form.recipientName }
    const dest = DEST_TYPES[form.destType]
    if (!dest) return base
    for (const field of dest.fields) {
      const val = form[field as keyof typeof form]
      if (val) base[field] = val
    }
    return base
  }

  const submit = async () => {
    if (!userId) { setErr('Resolve user first'); return }
    if (!form.amount || Number(form.amount) <= 0) { setErr('Enter a valid amount'); return }
    if (!form.recipientName) { setErr('Recipient name is required'); return }
    setLoading(true); setErr(''); setResult(null)
    try {
      const res = await orchestratorWithdraw({
        userId, currency: form.currency, amount: Number(form.amount),
        recipientName: form.recipientName, destination: buildDestination(),
      })
      setResult(res)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }

  const destConfig = DEST_TYPES[form.destType]

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-white">Withdrawals</h1>
        <p className="text-sm text-gray-500 mt-0.5">Send fiat from a user's FinCruse balance to their bank or mobile money</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="card space-y-4">
          <h2 className="text-sm font-medium text-gray-300">Withdrawal Request</h2>

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

          <div>
            <label className="label">Recipient Name</label>
            <input className="input" placeholder="Full legal name"
              value={form.recipientName} onChange={e => setForm(f => ({ ...f, recipientName: e.target.value }))} />
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
              <input className="input" type="number" min="0" placeholder="5000"
                value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
            </div>
          </div>

          {/* Destination type */}
          <div>
            <label className="label">Payment Method</label>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(DEST_TYPES).map(([key, d]) => (
                <button key={key}
                  onClick={() => setForm(f => ({ ...f, destType: key }))}
                  className={`px-3 py-2 rounded-lg text-xs font-medium border transition ${form.destType === key ? 'border-brand-500 bg-brand-600/20 text-brand-400' : 'border-gray-700 bg-gray-800 text-gray-400 hover:text-gray-200'}`}>
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          {/* Dynamic destination fields */}
          {destConfig && destConfig.fields.map(field => (
            <div key={field}>
              <label className="label">{fieldLabel(field)}</label>
              <input className="input" placeholder={fieldPlaceholder(field)}
                value={form[field as keyof typeof form]} onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))} />
            </div>
          ))}

          {err && <p className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg p-2">{err}</p>}
          <button className="btn-primary w-full" onClick={submit} disabled={loading || !userId}>
            {loading ? 'Processing…' : `Withdraw ${form.currency} via ${destConfig?.label ?? 'Bank'}`}
          </button>
        </div>

        <div className="space-y-4">
          {result && (
            <div className="card space-y-3">
              <div className="flex items-center gap-2">
                <span className="badge-yellow">Withdrawal Initiated</span>
              </div>
              <div className="space-y-2 text-sm">
                <ResultRow label="Withdrawal ID" value={result.withdrawalId} mono />
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
                Final COMPLETED status fires via Brainrock webhook when fiat reaches the destination.
              </div>
            </div>
          )}

          <div className="card">
            <div className="text-xs font-mono text-gray-500 mb-3 uppercase">Withdrawal Flow</div>
            <div className="space-y-2 text-xs text-gray-400">
              {[
                'Ledger debit (immediate)',
                'Fireblocks: user vault → FinCruse treasury (USDT)',
                'B2BinPay off-ramp: USDT → fiat to Brainrock treasury',
                `Brainrock: ${destConfig?.label ?? 'Bank'} to recipient`,
                'Brainrock webhook → withdrawal COMPLETED',
                'On failure: ledger auto-reversal',
              ].map((s, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="text-gray-600 w-4 flex-shrink-0">{i + 1}.</span>
                  <span>{s}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function fieldLabel(f: string): string {
  const m: Record<string, string> = {
    mobileNumber: 'Mobile Number', bankCode: 'Bank Code', bankAccountNumber: 'Account Number',
    sortCode: 'Sort Code', accountNumber: 'Account Number', iban: 'IBAN', bic: 'BIC/SWIFT',
  }
  return m[f] ?? f
}

function fieldPlaceholder(f: string): string {
  const m: Record<string, string> = {
    mobileNumber: '+234701234567', bankCode: 'GTB001', bankAccountNumber: '0123456789',
    sortCode: '60-16-13', accountNumber: '31926819', iban: 'GB29NWBK60161331926819', bic: 'NWBKGB2L',
  }
  return m[f] ?? ''
}

function ResultRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between py-1 border-b border-gray-800">
      <span className="text-gray-400">{label}</span>
      <span className={`text-white ${mono ? 'font-mono text-xs' : ''}`}>{value}</span>
    </div>
  )
}
