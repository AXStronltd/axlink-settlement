import { useState, useCallback } from 'react'
import { getUser, lookupUser, type User } from '../api'

const FLAGS: Record<string, string> = {
  KES: '🇰🇪', NGN: '🇳🇬', GHS: '🇬🇭', ZAR: '🇿🇦',
  UGX: '🇺🇬', TZS: '🇹🇿', GBP: '🇬🇧', EUR: '🇪🇺', USD: '🇺🇸',
}

const CURRENCY_COLOR: Record<string, string> = {
  GBP: 'border-violet-700 bg-violet-900/20 text-violet-300',
  EUR: 'border-blue-700 bg-blue-900/20 text-blue-300',
  USD: 'border-emerald-700 bg-emerald-900/20 text-emerald-300',
  NGN: 'border-green-700 bg-green-900/20 text-green-300',
  KES: 'border-teal-700 bg-teal-900/20 text-teal-300',
  GHS: 'border-yellow-700 bg-yellow-900/20 text-yellow-300',
  ZAR: 'border-orange-700 bg-orange-900/20 text-orange-300',
  UGX: 'border-pink-700 bg-pink-900/20 text-pink-300',
  TZS: 'border-rose-700 bg-rose-900/20 text-rose-300',
}

export default function Accounts() {
  const [query, setQuery] = useState('')
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const search = useCallback(async () => {
    const q = query.trim()
    if (!q) return
    setLoading(true); setErr(''); setUser(null)
    try {
      let found: User
      if (q.includes('@')) {
        const lu = await lookupUser(q)
        found = await getUser(lu.id)
      } else {
        found = await getUser(q)
      }
      setUser(found)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }, [query])

  const totalUsd = user?.accounts.reduce((s, a) => s + a.balanceUsd, 0) ?? 0

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-white">Accounts</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Multi-currency bank accounts — local currency balances, virtual IBAN, card &amp; vault info.
          Backend is USDT on Fireblocks — account holders see local fiat only.
        </p>
      </div>

      {/* BaaS info strip */}
      <div className="rounded-xl border border-brand-700/30 bg-brand-900/10 px-5 py-3 flex flex-wrap gap-6 text-xs text-gray-400">
        <span><span className="text-brand-300 font-mono">Account</span> — multi-currency bank account, local fiat balance</span>
        <span><span className="text-cyan-300 font-mono">Card</span> — debit/prepaid card linked to the account, spend anywhere</span>
        <span><span className="text-amber-300 font-mono">Virtual IBAN</span> — receive incoming bank wires (GBP/EUR/USD)</span>
        <span><span className="text-gray-400 font-mono">Fireblocks USDT</span> — backend only, user never sees it</span>
      </div>

      {/* Search */}
      <div className="card">
        <h2 className="text-sm font-medium text-gray-300 mb-3">Find Account</h2>
        <div className="flex gap-3">
          <input
            className="input flex-1"
            placeholder="Email or User ID (clx…)"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && search()}
          />
          <button className="btn-primary px-6" onClick={search} disabled={loading || !query.trim()}>
            {loading ? 'Loading…' : 'Open Account'}
          </button>
        </div>
        {err && <p className="mt-3 text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg p-2">{err}</p>}
      </div>

      {user && (
        <>
          {/* Profile bar */}
          <div className="card flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-brand-600/30 border-2 border-brand-600/50 flex items-center justify-center text-lg font-bold text-brand-400 flex-shrink-0">
              {user.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-base font-semibold text-white">{user.name}</div>
              <div className="text-xs text-gray-400 mono">{user.email}</div>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <KycBadge status={user.kycStatus} />
              <div className="text-right">
                <div className="text-xs text-gray-500">Total Balance</div>
                <div className="text-base font-mono font-semibold text-white">${totalUsd.toFixed(2)}</div>
                <div className="text-xs text-gray-600 mt-0.5">USD equivalent</div>
              </div>
            </div>
          </div>

          {/* Card strip */}
          <div className="rounded-xl border border-cyan-800/40 bg-cyan-900/10 p-4 flex items-center gap-5 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="w-10 h-7 rounded bg-gradient-to-br from-cyan-700 to-brand-700 border border-cyan-600/30 flex items-center justify-center flex-shrink-0">
                <span className="text-white font-bold text-xs">▣</span>
              </div>
              <div>
                <div className="text-sm font-semibold text-white">AxLink Debit Card</div>
                <div className="text-xs text-gray-400">Linked to this account · spend in local currency globally</div>
              </div>
            </div>
            <div className="flex gap-4 text-xs text-gray-500 ml-auto flex-wrap">
              <span>Card network: <span className="text-gray-300">Visa / Mastercard</span></span>
              <span>Spend currency: <span className="text-gray-300">account default</span></span>
              <span>Backend: <span className="text-gray-400">USDT · Fireblocks · invisible</span></span>
            </div>
          </div>

          {/* Balance cards */}
          <div>
            <div className="text-xs font-mono text-gray-500 uppercase tracking-wider mb-3">Account Balances</div>
            {user.accounts.length === 0 ? (
              <div className="card text-sm text-gray-500 text-center py-8">No currency accounts yet — complete onboarding to activate.</div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
                {user.accounts.map(acc => {
                  const colorClass = CURRENCY_COLOR[acc.currency] ?? 'border-gray-700 bg-gray-800/40 text-gray-300'
                  const pct = totalUsd > 0 ? (acc.balanceUsd / totalUsd) * 100 : 0
                  return (
                    <div key={acc.currency} className={`rounded-xl border p-4 ${colorClass}`}>
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-lg">{FLAGS[acc.currency] ?? '🌐'}</span>
                        <span className="text-xs font-mono font-semibold">{acc.currency}</span>
                      </div>
                      <div className="text-xl font-mono font-bold text-white">
                        {acc.balance.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </div>
                      <div className="text-xs text-gray-400 mt-0.5">{acc.currency}</div>
                      <div className="mt-3 pt-3 border-t border-white/10 flex items-center justify-between">
                        <span className="text-xs text-gray-400">${acc.balanceUsd.toFixed(2)}</span>
                        <span className="text-xs text-gray-500">{pct.toFixed(1)}%</span>
                      </div>
                      <div className="mt-2 h-1 rounded-full bg-white/10">
                        <div className="h-1 rounded-full bg-current opacity-60" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Deposit & Vault info */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Virtual IBAN */}
            <div className="card space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-gray-300">Incoming Wires (Virtual IBAN)</h2>
                {user.virtualIban ? <span className="badge-green">Active</span> : <span className="badge-gray">Not provisioned</span>}
              </div>
              {user.virtualIban ? (
                <>
                  <CopyField label="IBAN" value={user.virtualIban} />
                  {user.virtualIbanBic && <CopyField label="BIC / SWIFT" value={user.virtualIbanBic} />}
                  <p className="text-xs text-gray-500 pt-1">
                    Account holder sends GBP / EUR / USD here via SEPA, Faster Payments, or SWIFT.
                    Credits appear in their local currency balance — no crypto knowledge needed.
                  </p>
                </>
              ) : (
                <p className="text-xs text-yellow-400">Virtual IBAN not provisioned — configure <span className="mono">BRAINROCK_API_KEY</span> to enable.</p>
              )}
            </div>

            {/* Fireblocks Vault — ops view */}
            <div className="card space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-gray-300">Fireblocks Vault <span className="text-xs text-gray-600 font-normal">(ops only — hidden from user)</span></h2>
                {user.vaultId ? <span className="badge-blue">Custody</span> : <span className="badge-gray">No vault</span>}
              </div>
              {user.vaultId && (
                <>
                  <CopyField label="Vault ID" value={user.vaultId} />
                  <CopyField label="Account ID" value={user.id} />
                  <p className="text-xs text-gray-500 pt-1">
                    USDT (Solana) is held here. Every cross-currency settlement routes vault-to-vault.
                    The account holder sees local fiat only — USDT is the internal settlement layer.
                  </p>
                </>
              )}
              {!user.vaultId && (
                <p className="text-xs text-gray-500">Vault will be provisioned at first deposit. Account holder is unaware of this.</p>
              )}
            </div>
          </div>

          {/* AxLink routing rules */}
          <div className="card space-y-4">
            <div>
              <h2 className="text-sm font-medium text-gray-300">How This Account Settles</h2>
              <p className="text-xs text-gray-500 mt-1">Account holder sends/receives fiat — AxLink handles everything underneath.</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

              {/* Same currency */}
              <div className="rounded-xl border border-gray-700 bg-gray-800/40 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0" />
                  <span className="text-xs font-mono text-emerald-400 uppercase tracking-wide">Same Currency</span>
                </div>
                <div className="text-sm font-semibold text-white">Direct Ledger — instant, zero spread</div>
                <p className="text-xs text-gray-400 leading-relaxed">
                  KES account sending to another KES account: pure ledger debit/credit.
                  No FX, no Fireblocks, no LPs. Account holder sees it as a normal bank transfer.
                </p>
                <div className="flex items-center gap-2 pt-1 text-xs font-mono text-gray-500">
                  <span className="bg-gray-700 rounded px-2 py-0.5">KES</span>
                  <span>→</span>
                  <span className="bg-gray-700 rounded px-2 py-0.5">KES</span>
                  <span className="ml-auto text-emerald-400">0% · instant</span>
                </div>
              </div>

              {/* Cross currency */}
              <div className="rounded-xl border border-brand-700/50 bg-brand-900/15 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-brand-400 flex-shrink-0" />
                  <span className="text-xs font-mono text-brand-400 uppercase tracking-wide">Cross Currency · Cross Border</span>
                </div>
                <div className="text-sm font-semibold text-white">AxLink FX · Fireblocks USDT bridge</div>
                <p className="text-xs text-gray-400 leading-relaxed">
                  GBP account sending to a KES account: JIT RFQ → Fireblocks USDT vault-to-vault →
                  AxLink FX converts → receiver gets KES. Both sides see local fiat only.
                  USDT is never surfaced.
                </p>
                <div className="flex items-center gap-2 pt-1 text-xs font-mono text-gray-500">
                  <span className="bg-gray-800 rounded px-2 py-0.5">GBP</span>
                  <span>→</span>
                  <span className="bg-cyan-900/40 border border-cyan-800 rounded px-2 py-0.5 text-cyan-400">USDT</span>
                  <span>→</span>
                  <span className="bg-gray-800 rounded px-2 py-0.5">KES</span>
                  <span className="ml-auto text-brand-400">1.8% spread</span>
                </div>
              </div>

            </div>
            <p className="text-xs text-gray-600">
              Use the <span className="text-gray-400">Transfers</span>, <span className="text-gray-400">Deposits</span>, and <span className="text-gray-400">Withdrawals</span> tabs to move funds.
            </p>
          </div>
        </>
      )}
    </div>
  )
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) }
  return (
    <div>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="flex items-center gap-2 bg-gray-800/60 rounded-lg px-3 py-2 border border-gray-700/50">
        <span className="font-mono text-xs text-gray-200 flex-1 truncate">{value}</span>
        <button onClick={copy} className="text-gray-500 hover:text-gray-300 text-xs flex-shrink-0 transition">
          {copied ? '✓' : '⎘'}
        </button>
      </div>
    </div>
  )
}

function KycBadge({ status }: { status: string }) {
  if (status === 'APPROVED') return <span className="badge-green">{status}</span>
  if (status === 'PENDING')  return <span className="badge-yellow">{status}</span>
  return <span className="badge-red">{status}</span>
}
