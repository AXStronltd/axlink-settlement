import { useState } from 'react'
import { createUser, getUser, lookupUser, type User, type CreateUserRes } from '../api'

const CURRENCIES = ['KES', 'NGN', 'GHS', 'ZAR', 'UGX', 'TZS', 'GBP', 'EUR', 'USD']
const FLAGS: Record<string, string> = { KES:'🇰🇪', NGN:'🇳🇬', GHS:'🇬🇭', ZAR:'🇿🇦', UGX:'🇺🇬', TZS:'🇹🇿', GBP:'🇬🇧', EUR:'🇪🇺', USD:'🇺🇸' }

export default function Users() {
  const [tab, setTab] = useState<'create' | 'lookup'>('create')

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-white">Users</h1>
        <p className="text-sm text-gray-500 mt-0.5">Create users and inspect balances</p>
      </div>

      <div className="flex gap-2 border-b border-gray-800 pb-0">
        {(['create', 'lookup'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition border-b-2 -mb-px ${tab === t ? 'border-brand-500 text-brand-400' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
            {t === 'create' ? 'Create User' : 'Lookup User'}
          </button>
        ))}
      </div>

      {tab === 'create' ? <CreateUserPanel /> : <LookupPanel />}
    </div>
  )
}

function CreateUserPanel() {
  const [form, setForm] = useState({ email: '', name: '', currency: 'NGN' })
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<CreateUserRes | null>(null)
  const [err, setErr] = useState('')

  const submit = async () => {
    if (!form.email || !form.name) { setErr('Email and name are required'); return }
    setLoading(true); setErr(''); setResult(null)
    try {
      const res = await createUser(form)
      setResult(res)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div className="card space-y-4">
        <h2 className="text-sm font-medium text-gray-300">New User</h2>
        <div>
          <label className="label">Email</label>
          <input className="input" placeholder="james@example.com"
            value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
        </div>
        <div>
          <label className="label">Full Name</label>
          <input className="input" placeholder="James Mwangi"
            value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        </div>
        <div>
          <label className="label">Primary Currency</label>
          <select className="input" value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}>
            {CURRENCIES.map(c => <option key={c} value={c}>{FLAGS[c]} {c}</option>)}
          </select>
        </div>
        {err && <p className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg p-2">{err}</p>}
        <button className="btn-primary w-full" onClick={submit} disabled={loading}>
          {loading ? 'Creating…' : 'Create User + Fireblocks Vault + Virtual IBAN'}
        </button>
      </div>

      {result && (
        <div className="card space-y-3">
          <div className="flex items-center gap-2">
            <span className="badge-green">Created</span>
            <span className="text-sm font-medium text-white">User provisioned</span>
          </div>
          <Field label="User ID" value={result.userId} mono />
          <Field label="Fireblocks Vault ID" value={result.vaultId} mono />
          <Field label="Currency" value={result.currency} />
          {result.depositAccount ? (
            <>
              <div className="border-t border-gray-800 pt-3">
                <div className="text-xs text-gray-500 mb-2">Deposit Account (Virtual IBAN)</div>
                <Field label="IBAN" value={result.depositAccount.iban} mono />
                <Field label="BIC" value={result.depositAccount.bic} mono />
              </div>
            </>
          ) : (
            <p className="text-xs text-yellow-400">Virtual IBAN not provisioned — configure BRAINROCK_API_KEY to enable</p>
          )}
        </div>
      )}
    </div>
  )
}

function LookupPanel() {
  const [email, setEmail] = useState('')
  const [userId, setUserId] = useState('')
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const lookupByEmail = async () => {
    if (!email) return
    setLoading(true); setErr(''); setUser(null)
    try {
      const found = await lookupUser(email)
      const full = await getUser(found.id)
      setUser(full)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }

  const lookupById = async () => {
    if (!userId) return
    setLoading(true); setErr(''); setUser(null)
    try {
      const full = await getUser(userId)
      setUser(full)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div className="space-y-4">
        <div className="card space-y-3">
          <h2 className="text-sm font-medium text-gray-300">Lookup by Email</h2>
          <input className="input" placeholder="user@example.com"
            value={email} onChange={e => setEmail(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && lookupByEmail()} />
          <button className="btn-primary w-full" onClick={lookupByEmail} disabled={loading || !email}>
            {loading ? 'Looking up…' : 'Find User'}
          </button>
        </div>
        <div className="card space-y-3">
          <h2 className="text-sm font-medium text-gray-300">Lookup by User ID</h2>
          <input className="input" placeholder="clx..."
            value={userId} onChange={e => setUserId(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && lookupById()} />
          <button className="btn-secondary w-full" onClick={lookupById} disabled={loading || !userId}>
            {loading ? 'Loading…' : 'Fetch User'}
          </button>
        </div>
        {err && <p className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg p-3">{err}</p>}
      </div>

      {user && (
        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-brand-600/30 border border-brand-600/50 flex items-center justify-center text-sm font-semibold text-brand-400">
                {user.name.charAt(0).toUpperCase()}
              </div>
              <div>
                <div className="text-sm font-medium text-white">{user.name}</div>
                <div className="text-xs text-gray-500">{user.email}</div>
              </div>
            </div>
            <KycBadge status={user.kycStatus} />
          </div>
          <Field label="User ID" value={user.id} mono />

          <div className="border-t border-gray-800 pt-3">
            <div className="text-xs text-gray-500 mb-2">Balances</div>
            {user.accounts.length === 0 && <p className="text-xs text-gray-500">No accounts yet</p>}
            {user.accounts.map(acc => (
              <div key={acc.currency} className="flex items-center justify-between py-1.5 border-b border-gray-800/50">
                <span className="text-sm text-gray-300">{FLAGS[acc.currency] ?? ''} {acc.currency}</span>
                <div className="text-right">
                  <div className="text-sm font-mono text-white">{acc.balance.toLocaleString()} {acc.currency}</div>
                  <div className="text-xs text-gray-500 mono">${acc.balanceUsd.toFixed(2)} USD</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = () => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) }
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs text-gray-500 flex-shrink-0 mr-3">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0">
        <span className={`text-xs text-gray-200 truncate ${mono ? 'font-mono' : ''}`}>{value}</span>
        <button onClick={copy} className="text-gray-600 hover:text-gray-400 flex-shrink-0 text-xs">{copied ? '✓' : '⎘'}</button>
      </div>
    </div>
  )
}

function KycBadge({ status }: { status: string }) {
  if (status === 'APPROVED') return <span className="badge-green">{status}</span>
  if (status === 'PENDING')  return <span className="badge-yellow">{status}</span>
  return <span className="badge-red">{status}</span>
}
