import { useEffect, useState, useCallback } from 'react'
import { getHealth, type Health } from '../api'

// ── Settlement corridors (institution-to-institution) ─────────────────────────
const CORRIDORS = [
  { from: 'USD', to: 'EUR', via: 'USDT/SOL', speed: '< 30 s', finality: 'On-chain proof', regions: 'US → EU' },
  { from: 'GBP', to: 'USD', via: 'USDT/SOL', speed: '< 30 s', finality: 'On-chain proof', regions: 'UK → US' },
  { from: 'EUR', to: 'GBP', via: 'USDT/SOL', speed: '< 30 s', finality: 'On-chain proof', regions: 'EU → UK' },
  { from: 'USD', to: 'SGD', via: 'USDT/SOL', speed: '< 45 s', finality: 'On-chain proof', regions: 'US → APAC' },
  { from: 'GBP', to: 'AED', via: 'USDT/SOL', speed: '< 45 s', finality: 'On-chain proof', regions: 'UK → MENA' },
  { from: 'EUR', to: 'CAD', via: 'USDT/SOL', speed: '< 30 s', finality: 'On-chain proof', regions: 'EU → CA' },
]

// ── Settlement layers ─────────────────────────────────────────────────────────
const LAYERS = [
  { name: 'Sending Institution',   desc: 'Debits customer account · sends settlement instruction to AxLink via API',           role: 'SENDER',   color: 'border-blue-700/50 bg-blue-900/10',    dot: 'bg-blue-400' },
  { name: 'AxLink Orchestrator',   desc: 'Validates instruction · locks quote · routes via Fireblocks · writes journal entry', role: 'ENGINE',   color: 'border-brand-700/50 bg-brand-900/10',  dot: 'bg-brand-400' },
  { name: 'Fireblocks Vault',      desc: 'USDT/SOL vault-to-vault transfer between sending and receiving institution vaults',  role: 'CUSTODY',  color: 'border-violet-700/50 bg-violet-900/10', dot: 'bg-violet-400' },
  { name: 'Solana Network',        desc: 'Finalises the USDT transfer on-chain · AxLink polls until `finalized` status',       role: 'RAIL',     color: 'border-cyan-700/50 bg-cyan-900/10',    dot: 'bg-cyan-400' },
  { name: 'Settlement Proof',      desc: 'Public endpoint returns Solana tx signature · receiving institution verifies independently', role: 'PROOF', color: 'border-emerald-700/50 bg-emerald-900/10', dot: 'bg-emerald-400' },
  { name: 'Receiving Institution', desc: 'Credits beneficiary account · settlement complete with cryptographic proof',         role: 'RECEIVER', color: 'border-teal-700/50 bg-teal-900/10',    dot: 'bg-teal-400' },
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
            <div className="text-xs font-mono text-brand-400 tracking-widest uppercase mb-2">AXSTRON · AxLink Settlement Network</div>
            <h1 className="text-2xl font-bold text-white">Institutional Crypto Settlement Infrastructure</h1>
            <p className="text-brand-300 font-semibold mt-1 text-base">Institution → USDT/Solana → Institution. No SWIFT. No Prefunding. Cryptographic Proof.</p>
            <p className="text-sm text-gray-400 mt-3 max-w-2xl leading-relaxed">
              AxLink is a <span className="text-white font-medium">bank-to-bank settlement network</span> built on
              Fireblocks custody and Solana finality. Sending institutions debit their customer,
              AxLink moves <span className="text-brand-300 font-medium">USDT on Solana</span> vault-to-vault via Fireblocks,
              and the receiving institution credits their customer — all in under 60 seconds with
              an <span className="text-white font-medium">on-chain settlement proof</span>.
            </p>
          </div>
          <div className="flex flex-col gap-2 flex-shrink-0 items-end">
            {health
              ? <span className="badge-green px-3 py-1">● Online</span>
              : healthErr
              ? <span className="badge-red px-3 py-1">● Backend Offline</span>
              : <span className="badge-gray px-3 py-1">● Checking…</span>}
            {health?.sandbox && <span className="badge-blue text-xs">Sandbox</span>}
            {lastUpdated && <span className="text-xs text-gray-600">Updated {lastUpdated}</span>}
          </div>
        </div>

        {/* Key stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-8">
          {[
            { label: 'Settlement Time',    value: '< 60 s',     sub: 'end-to-end' },
            { label: 'Settlement Rail',    value: 'USDT/SOL',   sub: 'Solana mainnet' },
            { label: 'Custody',            value: 'Fireblocks', sub: 'vault-to-vault' },
            { label: 'Finality Proof',     value: 'On-chain',   sub: 'public endpoint' },
          ].map(s => (
            <div key={s.label} className="rounded-xl border border-gray-800 bg-gray-900/60 p-4">
              <div className="text-lg font-bold text-white">{s.value}</div>
              <div className="text-xs text-gray-400 mt-0.5">{s.label}</div>
              <div className="text-xs text-gray-600 mt-0.5">{s.sub}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Settlement Flow ───────────────────────────────────────────────── */}
      <div>
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-widest mb-4">Settlement Flow</h2>
        <div className="space-y-2">
          {LAYERS.map((layer, i) => (
            <div key={layer.name} className={`rounded-xl border p-4 flex items-start gap-4 ${layer.color}`}>
              <div className="flex items-center gap-3 w-8 flex-shrink-0">
                <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${layer.dot}`} />
                <span className="text-xs text-gray-600 font-mono">{i + 1}</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-white">{layer.name}</span>
                  <span className="text-xs font-mono text-gray-500 border border-gray-700 rounded px-1.5 py-0.5">{layer.role}</span>
                </div>
                <p className="text-xs text-gray-400 mt-1 leading-relaxed">{layer.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Active Corridors ──────────────────────────────────────────────── */}
      <div>
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-widest mb-4">Active Settlement Corridors</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {CORRIDORS.map(c => (
            <div key={`${c.from}-${c.to}`} className="rounded-xl border border-gray-800 bg-gray-900/60 p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-base font-bold text-white">{c.from}</span>
                <span className="text-gray-500 text-sm">→</span>
                <span className="text-base font-bold text-white">{c.to}</span>
                <span className="ml-auto text-xs font-mono text-brand-400 border border-brand-800 rounded px-1.5 py-0.5">{c.via}</span>
              </div>
              <div className="text-xs text-gray-500">{c.regions}</div>
              <div className="flex items-center gap-3 mt-2">
                <span className="text-xs text-emerald-400">⚡ {c.speed}</span>
                <span className="text-xs text-gray-500">· {c.finality}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── API Surface ───────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-widest mb-4">API Surface for Institutions</h2>
        <div className="rounded-xl border border-gray-800 bg-gray-900/60 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left p-3 text-xs text-gray-500 font-medium">Endpoint</th>
                <th className="text-left p-3 text-xs text-gray-500 font-medium">Purpose</th>
                <th className="text-left p-3 text-xs text-gray-500 font-medium hidden sm:table-cell">Auth</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {[
                { method: 'POST', path: '/api/institutions',                    purpose: 'Onboard institution, provision Fireblocks vault',  auth: 'OPS_API_KEY' },
                { method: 'POST', path: '/api/quote',                           purpose: 'Get settlement rate (30s JIT lock)',                auth: 'Bearer' },
                { method: 'POST', path: '/api/orchestrator/transfer',           purpose: 'Execute cross-border settlement',                  auth: 'Bearer' },
                { method: 'GET',  path: '/api/settlement/proof/:type/:id',      purpose: 'Retrieve on-chain Solana proof (public)',           auth: 'None' },
                { method: 'GET',  path: '/api/settlement/stuck',                purpose: 'Monitor stalled settlements (ops)',                 auth: 'OPS_API_KEY' },
                { method: 'GET',  path: '/api/health',                          purpose: 'Health check',                                     auth: 'None' },
              ].map(r => (
                <tr key={r.path} className="hover:bg-gray-800/30 transition">
                  <td className="p-3 font-mono text-xs">
                    <span className={`mr-2 font-bold ${r.method === 'GET' ? 'text-emerald-400' : 'text-brand-400'}`}>{r.method}</span>
                    <span className="text-gray-300">{r.path}</span>
                  </td>
                  <td className="p-3 text-xs text-gray-400">{r.purpose}</td>
                  <td className="p-3 text-xs text-gray-500 hidden sm:table-cell font-mono">{r.auth}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Proof endpoint note ───────────────────────────────────────────── */}
      <div className="rounded-xl border border-emerald-800/40 bg-emerald-900/10 p-5">
        <div className="text-xs font-mono text-emerald-400 uppercase tracking-widest mb-1">Settlement Proof</div>
        <p className="text-sm text-gray-300 leading-relaxed">
          Every settlement produces a Solana transaction signature stored against the transfer.
          The proof endpoint is <span className="text-white font-medium">intentionally public</span> —
          a receiving institution can verify the on-chain finality of any AxLink settlement
          independently, without trusting AxLink. That is the guarantee.
        </p>
        <div className="mt-3 font-mono text-xs text-gray-500 bg-gray-900 rounded-lg p-3">
          GET /api/settlement/proof/transfer/:transferId
        </div>
      </div>

    </div>
  )
}
