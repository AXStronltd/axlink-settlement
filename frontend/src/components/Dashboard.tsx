import { useEffect, useState, useCallback } from 'react'
import { getHealth, type Health } from '../api'

// ── Corridors ─────────────────────────────────────────────────────────────────
const CORRIDORS = [
  { from: 'KES', to: 'UGX', ff: '🇰🇪', ft: '🇺🇬', rail: 'Daraja → Choice Bank',      speed: '< 30 s', spread: '1.8%', modes: ['P2P', 'B2C'] },
  { from: 'KES', to: 'TZS', ff: '🇰🇪', ft: '🇹🇿', rail: 'Daraja → Choice Bank',      speed: '< 30 s', spread: '1.8%', modes: ['P2P', 'B2C'] },
  { from: 'NGN', to: 'KES', ff: '🇳🇬', ft: '🇰🇪', rail: 'Choice Bank → Daraja',      speed: '< 45 s', spread: '2.0%', modes: ['P2P', 'B2C'] },
  { from: 'GBP', to: 'KES', ff: '🇬🇧', ft: '🇰🇪', rail: 'Brainrock → Daraja',        speed: '< 60 s', spread: '1.8%', modes: ['B2C', 'P2P'] },
  { from: 'GBP', to: 'NGN', ff: '🇬🇧', ft: '🇳🇬', rail: 'Brainrock → Choice Bank',   speed: '< 60 s', spread: '2.2%', modes: ['B2C', 'P2P'] },
  { from: 'EUR', to: 'KES', ff: '🇪🇺', ft: '🇰🇪', rail: 'Brainrock → Daraja',        speed: '< 60 s', spread: '1.8%', modes: ['B2B', 'B2C'] },
  { from: 'EUR', to: 'NGN', ff: '🇪🇺', ft: '🇳🇬', rail: 'Brainrock → Choice Bank',   speed: '< 60 s', spread: '2.2%', modes: ['B2B', 'B2C'] },
  { from: 'USD', to: 'KES', ff: '🇺🇸', ft: '🇰🇪', rail: 'Brainrock → Daraja',        speed: '< 30 s', spread: '1.8%', modes: ['B2B', 'B2C'] },
  { from: 'USD', to: 'NGN', ff: '🇺🇸', ft: '🇳🇬', rail: 'Brainrock → Choice Bank',   speed: '< 30 s', spread: '2.2%', modes: ['B2B', 'B2C'] },
  { from: 'GBP', to: 'GHS', ff: '🇬🇧', ft: '🇬🇭', rail: 'Brainrock → Choice Bank',   speed: '< 60 s', spread: '1.8%', modes: ['B2C', 'P2P'] },
  { from: 'EUR', to: 'ZAR', ff: '🇪🇺', ft: '🇿🇦', rail: 'Brainrock → Choice Bank',   speed: '< 60 s', spread: '1.8%', modes: ['B2B', 'B2C'] },
  { from: 'GBP', to: 'UGX', ff: '🇬🇧', ft: '🇺🇬', rail: 'Brainrock → Choice Bank',   speed: '< 60 s', spread: '1.8%', modes: ['B2C', 'P2P'] },
]

const MODE_COLOR: Record<string, string> = {
  B2B: 'bg-blue-900/40 text-blue-300 border-blue-800',
  B2C: 'bg-violet-900/40 text-violet-300 border-violet-800',
  P2P: 'bg-emerald-900/40 text-emerald-300 border-emerald-800',
}

// ── Rails ─────────────────────────────────────────────────────────────────────
const RAILS = [
  { zone: 'EU · UK · NA',    name: 'Brainrock',       desc: 'GBP · EUR · USD · CAD — SEPA · Faster Payments · SWIFT · ACH · EFT collection', dir: 'IN',       dot: 'bg-violet-400', color: 'border-violet-700/50 bg-violet-900/10' },
  { zone: 'AFRICA — BANK',   name: 'Choice Bank',     desc: 'NGN · GHS · ZAR · KES · UGX · TZS — bank accounts across Africa, in & out',     dir: 'IN / OUT', dot: 'bg-green-400',  color: 'border-green-700/50 bg-green-900/10' },
  { zone: 'KENYA — MOBILE',  name: 'Daraja',          desc: 'KES instant collection & payout via Safaricom M-Pesa (Daraja API) — Kenya only', dir: 'IN / OUT', dot: 'bg-teal-400',   color: 'border-teal-700/50 bg-teal-900/10' },
  { zone: 'FIAT LIQUIDITY',  name: 'B2BinPay',        desc: 'Fiat liquidity LP — competes in JIT RFQ for on-ramp/off-ramp rates. Wins → executes. Loses → does nothing', dir: 'LP',  dot: 'bg-amber-400',  color: 'border-amber-700/50 bg-amber-900/10' },
  { zone: 'VALUE BRIDGE',    name: 'Fireblocks USDT',  desc: 'USDT on Solana via Fireblocks vault — AxLink internal settlement token. Vault-to-vault: sender → receiver. <$0.001 gas. Users never see USDT.', dir: 'USDT', dot: 'bg-cyan-400', color: 'border-cyan-700/50 bg-cyan-900/10' },
  { zone: 'AXLINK · FX',     name: 'AxLink FX Engine',desc: 'JIT RFQ broadcast to all LPs simultaneously · best rate wins · AxLink adds spread · KES→USD→UGX internal', dir: 'RATE', dot: 'bg-brand-400', color: 'border-brand-700/50 bg-brand-900/10' },
  { zone: 'AXLINK · CORE',   name: 'AxLink Ledger',   desc: 'Virtual fiat accounts per user · USD as internal value unit · atomic debit/credit · pluggable LP registry', dir: 'CORE', dot: 'bg-indigo-400', color: 'border-indigo-700/50 bg-indigo-900/10' },
]

const MODES = [
  { id: 'B2B', label: 'Business to Business', color: 'border-blue-700 bg-blue-900/15', badge: 'text-blue-300 bg-blue-900/40 border-blue-800', points: ['Bulk payroll — Africa & diaspora', 'Supplier cross-border payables', 'High-value same-day settlement', 'Rate locked at quote (30 s JIT)'] },
  { id: 'B2C', label: 'Business to Consumer', color: 'border-violet-700 bg-violet-900/15', badge: 'text-violet-300 bg-violet-900/40 border-violet-800', points: ['Scale payouts to end customers', 'Gig-economy & marketplace pay', 'Bank or mobile money delivery', 'Per-transfer transparent pricing'] },
  { id: 'P2P', label: 'Person to Person',     color: 'border-emerald-700 bg-emerald-900/15', badge: 'text-emerald-300 bg-emerald-900/40 border-emerald-800', points: ['Diaspora remittance — no SWIFT', 'Friend-to-friend cross-currency', 'Sender sees exact amount recipient gets', 'Spend received funds instantly on card'] },
]

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null)
  const [healthErr, setHealthErr] = useState(false)
  const [lastUpdated, setLastUpdated] = useState('')

  const fetchAll = useCallback(async () => {
    try { const h = await getHealth(); setHealth(h); setHealthErr(false) }
    catch { setHealthErr(true) }
    setLastUpdated(new Date().toLocaleTimeString())
  }, [])

  useEffect(() => { fetchAll(); const t = setInterval(fetchAll, 30_000); return () => clearInterval(t) }, [fetchAll])

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-8">

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-brand-700/40 bg-gradient-to-br from-brand-900/25 via-gray-900 to-gray-900 p-8">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <div className="text-xs font-mono text-brand-400 tracking-widest uppercase mb-2">AXSTRON · FinCruse Settlement</div>
            <h1 className="text-2xl font-bold text-white">Banking as a Service — Instant Cross-Border</h1>
            <p className="text-brand-300 font-semibold mt-1 text-base">Accounts · Cards · Transfers · No SWIFT. No Prefunding.</p>
            <p className="text-sm text-gray-400 mt-3 max-w-2xl leading-relaxed">
              Users get a <span className="text-white font-medium">bank account</span> and <span className="text-white font-medium">card</span> in their local currency.
              They send, receive, and spend exactly like a traditional bank — but the backend settles via
              the <span className="text-brand-300 font-medium">AxLink network</span> using Fireblocks USDT.
              Account holders never see USDT, never touch SWIFT, never wait 3 days.
            </p>
          </div>
          <div className="flex flex-col gap-2 flex-shrink-0 items-end">
            {health
              ? <span className="badge-green px-3 py-1">● Online</span>
              : healthErr
              ? <span className="badge-red px-3 py-1">● Backend Offline</span>
              : <span className="badge-gray px-3 py-1">● Checking…</span>}
            <span className="badge-blue text-xs">Sandbox</span>
          </div>
        </div>
        <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: 'Settlement',  value: '< 60 sec',   sub: 'account → account' },
            { label: 'Prefunding',  value: 'Zero',       sub: 'JIT liquidity via AxLink' },
            { label: 'Corridors',   value: `${CORRIDORS.length} active`, sub: 'Africa · EU · NA' },
            { label: 'Account type', value: 'BaaS',      sub: 'account + card + IBAN' },
          ].map(s => (
            <div key={s.label} className="bg-gray-900/70 rounded-xl border border-gray-700/50 p-4">
              <div className="text-xs text-gray-500 mb-1">{s.label}</div>
              <div className="text-lg font-bold font-mono text-white">{s.value}</div>
              <div className="text-xs text-gray-600 mt-0.5">{s.sub}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Live example ─────────────────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center gap-2 mb-5">
          <h2 className="text-sm font-medium text-gray-300">Live Example — How AxLink Moves Money</h2>
          <span className="badge-green text-xs">P2P</span>
        </div>

        {/* Flow */}
        <div className="flex items-stretch gap-0 flex-wrap justify-center">

          {/* Step 1 — Sender */}
          <div className="flex flex-col items-center">
            <div className="rounded-xl border border-teal-700 bg-teal-900/20 px-6 py-4 text-center min-w-[160px]">
              <div className="text-2xl mb-1">🇰🇪</div>
              <div className="text-xs font-mono text-teal-400 uppercase tracking-wide">Sender · Kenya</div>
              <div className="text-xl font-bold font-mono text-white mt-2">10,000 KES</div>
              <div className="text-xs text-gray-400 mt-1">Sends from account<br/>or card</div>
            </div>
          </div>

          <Arrow />

          {/* Step 2 — AxLink inbound */}
          <div className="flex flex-col items-center">
            <div className="rounded-xl border border-gray-600 bg-gray-800/60 px-5 py-4 text-center min-w-[150px]">
              <div className="text-xs font-mono text-gray-500 uppercase tracking-wide mb-2">AxLink · Inbound</div>
              <div className="text-xs text-gray-400">KES received</div>
              <div className="text-sm font-mono text-gray-300 mt-1">10,000 KES</div>
              <div className="text-xs text-gray-500 mt-1">Daraja rail</div>
            </div>
          </div>

          <Arrow />

          {/* Step 3 — AxLink FX core */}
          <div className="flex flex-col items-center">
            <div className="rounded-xl border border-brand-600 bg-brand-900/30 px-6 py-4 text-center min-w-[170px]">
              <div className="text-xs font-mono text-brand-400 uppercase tracking-wide mb-2">AxLink · FX Engine</div>
              <div className="text-xs text-gray-400">Internal USD value</div>
              <div className="text-base font-mono font-semibold text-brand-300 mt-1">≈ $76.40 USD</div>
              <div className="text-xs text-gray-500 mt-1">Live rate · never<br/>exposed to users</div>
            </div>
          </div>

          <Arrow />

          {/* Step 4 — AxLink outbound */}
          <div className="flex flex-col items-center">
            <div className="rounded-xl border border-gray-600 bg-gray-800/60 px-5 py-4 text-center min-w-[150px]">
              <div className="text-xs font-mono text-gray-500 uppercase tracking-wide mb-2">AxLink · Outbound</div>
              <div className="text-xs text-gray-400">UGX calculated</div>
              <div className="text-sm font-mono text-gray-300 mt-1">≈ 285,000 UGX</div>
              <div className="text-xs text-gray-500 mt-1">Choice Bank rail</div>
            </div>
          </div>

          <Arrow />

          {/* Step 5 — Recipient */}
          <div className="flex flex-col items-center">
            <div className="rounded-xl border border-emerald-700 bg-emerald-900/20 px-6 py-4 text-center min-w-[160px]">
              <div className="text-2xl mb-1">🇺🇬</div>
              <div className="text-xs font-mono text-emerald-400 uppercase tracking-wide">Recipient · Uganda</div>
              <div className="text-xl font-bold font-mono text-white mt-2">285,000 UGX</div>
              <div className="text-xs text-gray-400 mt-1">Credited to account<br/>or spendable on card</div>
            </div>
          </div>

        </div>

        {/* Key points */}
        <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-3">
          <Note icon="⚡" label="End-to-end time" value="< 30 seconds" />
          <Note icon="🔒" label="USD exposed to users" value="Never — internal only" />
          <Note icon="📡" label="SWIFT involved" value="Zero — AxLink routes direct" />
        </div>

        <div className="mt-4 rounded-lg bg-gray-800/50 border border-gray-700/50 p-3 text-xs text-gray-400 leading-relaxed">
          <span className="text-brand-400 font-mono font-medium">AxLink FX Engine</span> computes KES→USD→UGX using AXSTRON's own managed rate table.
          <span className="text-amber-400 font-mono"> B2BinPay</span> provides USD liquidity — it is not the FX rate source.
          Local rails (Daraja for Kenya, Choice Bank for Uganda, Brainrock for EU/UK) handle real-world fiat at the edges.
          <span className="text-gray-500"> SWIFT is never in the chain.</span>
        </div>
      </div>

      {/* ── Transfer modes ────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-xs font-mono text-gray-500 uppercase tracking-wider mb-3">Who We Serve</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {MODES.map(m => (
            <div key={m.id} className={`rounded-xl border p-5 ${m.color}`}>
              <div className={`text-xs font-mono font-bold tracking-widest border rounded px-2 py-0.5 inline-flex mb-3 ${m.badge}`}>{m.id}</div>
              <div className="text-sm font-semibold text-white mb-3">{m.label}</div>
              <ul className="space-y-2">
                {m.points.map(p => (
                  <li key={p} className="flex items-start gap-2 text-xs text-gray-300">
                    <span className="text-gray-600 mt-0.5 flex-shrink-0">·</span>{p}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      {/* ── Active corridors ──────────────────────────────────────────────── */}
      <div className="card">
        <h2 className="text-sm font-medium text-gray-300 mb-4">Active Corridors</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-600 border-b border-gray-800">
                {['From', '', 'To', 'Rail', 'Speed', 'Spread', 'Modes'].map(h => (
                  <th key={h} className="text-left pb-2.5 pr-4 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CORRIDORS.map((c, i) => (
                <tr key={i} className="border-b border-gray-800/40 hover:bg-gray-800/20 transition">
                  <td className="py-2.5 pr-4 font-mono text-sm text-gray-200"><span className="mr-1.5">{c.ff}</span>{c.from}</td>
                  <td className="py-2.5 pr-4 text-gray-600 text-xs">→</td>
                  <td className="py-2.5 pr-4 font-mono text-sm text-gray-200"><span className="mr-1.5">{c.ft}</span>{c.to}</td>
                  <td className="py-2.5 pr-4 text-xs text-gray-400 font-mono">{c.rail}</td>
                  <td className="py-2.5 pr-4"><span className="badge-green text-xs">{c.speed}</span></td>
                  <td className="py-2.5 pr-4 font-mono text-brand-400 text-xs">{c.spread}</td>
                  <td className="py-2.5 flex gap-1 flex-wrap pt-3">
                    {c.modes.map(m => (
                      <span key={m} className={`text-xs border rounded px-1.5 py-0.5 font-mono ${MODE_COLOR[m]}`}>{m}</span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-600 mt-3 mono">
          All corridors are routed through AxLink. USD is the internal unit of value — no USD is held or sent externally.
        </p>
      </div>

      {/* ── AxLink vs SWIFT ───────────────────────────────────────────────── */}
      <div className="card">
        <h2 className="text-sm font-medium text-gray-300 mb-4">AxLink Network vs SWIFT</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-xl border border-red-900/40 bg-red-900/10 p-5">
            <div className="text-xs font-mono text-red-500 uppercase tracking-wider mb-4">Traditional SWIFT</div>
            <div className="space-y-2.5">
              {[
                ['Speed',               '2–5 business days'],
                ['Intermediaries',      '1–3 correspondent banks'],
                ['Cost to sender',      '$25–45 flat + hidden FX markup'],
                ['FX visibility',       'Rate hidden until after send'],
                ['Prefunding required', 'Yes — capital locked in Nostro'],
                ['Card spending',        'Not included — separate product'],
                ['Operating hours',     'Batch — not 24/7'],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between text-xs gap-4">
                  <span className="text-gray-500">{k}</span>
                  <span className="text-red-300 mono text-right">{v}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-emerald-900/40 bg-emerald-900/10 p-5">
            <div className="text-xs font-mono text-emerald-400 uppercase tracking-wider mb-4">FinCruse · AxLink Network</div>
            <div className="space-y-2.5">
              {[
                ['Speed',               '< 60 seconds end-to-end'],
                ['Intermediaries',      'Zero — AxLink routes direct'],
                ['Cost to sender',      '1.8–2.2% spread, shown upfront'],
                ['FX visibility',       'Exact rate locked before send'],
                ['Prefunding required', 'Zero — just-in-time via AxLink'],
                ['Card spending',        'Debit/prepaid card — local currency'],
                ['Operating hours',     '24/7 — always on'],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between text-xs gap-4">
                  <span className="text-gray-500">{k}</span>
                  <span className="text-emerald-300 mono text-right">{v}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Rails ─────────────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-xs font-mono text-gray-500 uppercase tracking-wider mb-3">Settlement Rails</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {RAILS.map(r => (
            <div key={r.name} className={`rounded-xl border p-4 ${r.color}`}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${r.dot}`} />
                  <span className="text-xs font-mono text-gray-400">{r.zone}</span>
                </div>
                <span className="text-xs mono text-gray-600 bg-gray-800/60 px-2 py-0.5 rounded">{r.dir}</span>
              </div>
              <div className="text-sm font-semibold text-white">{r.name}</div>
              <div className="text-xs text-gray-400 mt-2 leading-relaxed">{r.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Health ───────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-medium text-gray-300">Service Health</h2>
          <div className="flex items-center gap-3">
            {lastUpdated && <span className="text-xs text-gray-600 mono">Updated {lastUpdated}</span>}
            <button onClick={fetchAll} className="btn-secondary text-xs px-3 py-1.5">Refresh</button>
          </div>
        </div>
        {health ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Stat label="Service"  value={health.service} />
            <Stat label="Status"   value="Online" green />
            <Stat label="Mode"     value={health.sandbox ? 'Sandbox' : 'Production'} highlight={!health.sandbox} />
            <Stat label="API Base" value={health.callbackBase.replace('http://', '')} mono />
          </div>
        ) : healthErr ? (
          <p className="text-sm text-red-400">Backend unreachable at <code className="mono">localhost:4000</code> — run <code className="mono">npm run dev</code></p>
        ) : (
          <p className="text-sm text-gray-500">Checking backend…</p>
        )}
      </div>

    </div>
  )
}

function Arrow() {
  return (
    <div className="flex items-center px-1 self-center">
      <span className="text-gray-600 text-lg select-none">→</span>
    </div>
  )
}

function Note({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 bg-gray-800/40 rounded-xl border border-gray-700/50 p-3">
      <span className="text-base flex-shrink-0 mt-0.5">{icon}</span>
      <div>
        <div className="text-xs text-gray-500">{label}</div>
        <div className="text-sm font-medium text-white mt-0.5">{value}</div>
      </div>
    </div>
  )
}

function Stat({ label, value, mono, highlight, green }: { label: string; value: string; mono?: boolean; highlight?: boolean; green?: boolean }) {
  return (
    <div>
      <div className="text-xs text-gray-500 mb-0.5">{label}</div>
      <div className={`text-sm truncate ${mono ? 'font-mono' : 'font-medium'} ${highlight ? 'text-amber-400' : green ? 'text-emerald-400' : 'text-white'}`}>{value}</div>
    </div>
  )
}
