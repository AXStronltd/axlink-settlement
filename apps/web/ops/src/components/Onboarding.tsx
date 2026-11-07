/**
 * Onboarding review queue — ops dashboard panel.
 * Shows all submitted applications; lets ops approve, reject, or request more info.
 */
import { useEffect, useState } from 'react'

const BASE = '/api'
function opsKey(): string { try { return sessionStorage.getItem('axlink.opsKey') ?? '' } catch { return '' } }
async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opsKey()}`, ...(opts?.headers ?? {}) }, ...opts })
  const d = await r.json(); if (!r.ok) throw new Error(d?.error?.message ?? `HTTP ${r.status}`); return d as T
}

type AppStatus = 'DRAFT' | 'SUBMITTED' | 'INFO_REQUESTED' | 'APPROVED' | 'REJECTED'

interface Application {
  id: string
  legalName: string
  tradingName?: string
  country: string
  kind: string
  contactName: string
  contactEmail: string
  regulatoryLicence?: string
  licensingAuthority?: string
  preferredAssets: string[]
  corridors: string[]
  expectedVolume?: string
  amlPolicyConfirmed: boolean
  uboDeclarationConfirmed: boolean
  termsAccepted: boolean
  status: AppStatus
  submittedAt?: string
  reviewedAt?: string
  reviewedBy?: string
  reviewNotes?: string
  rejectionReason?: string
  institutionId?: string
  documents: { id: string; docType: string; fileName: string; sizeBytes: number; uploadedAt: string }[]
}

const STATUS_COLORS: Record<AppStatus, string> = {
  DRAFT: 'bg-gray-800 text-gray-400',
  SUBMITTED: 'bg-blue-900/40 text-blue-400 border border-blue-700/40',
  INFO_REQUESTED: 'bg-yellow-900/40 text-yellow-400 border border-yellow-700/40',
  APPROVED: 'bg-green-900/40 text-green-400 border border-green-700/40',
  REJECTED: 'bg-red-900/40 text-red-400 border border-red-700/40',
}

export default function Onboarding() {
  const [apps, setApps] = useState<Application[]>([])
  const [filter, setFilter] = useState<AppStatus | 'ALL'>('SUBMITTED')
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Application | null>(null)
  const [action, setAction] = useState<'APPROVE' | 'REJECT' | 'REQUEST_INFO' | null>(null)
  const [notes, setNotes] = useState('')
  const [rejection, setRejection] = useState('')
  const [working, setWorking] = useState(false)
  const [result, setResult] = useState<{ type: 'success' | 'error'; msg: string; apiKey?: string } | null>(null)

  async function load() {
    setLoading(true)
    try {
      const d = await req<{ applications: Application[] }>(`/onboarding${filter !== 'ALL' ? `?status=${filter}` : ''}`)
      setApps(d.applications)
    } catch (e: any) { console.error(e) }
    setLoading(false)
  }

  useEffect(() => { load() }, [filter])

  async function submitReview() {
    if (!selected || !action) return
    setWorking(true); setResult(null)
    try {
      const d = await req<any>(`/onboarding/${selected.id}/review`, {
        method: 'POST',
        body: JSON.stringify({
          action,
          reviewedBy: 'ops@axlink.network',
          reviewNotes: notes || undefined,
          rejectionReason: action === 'REJECT' ? rejection : undefined,
        }),
      })
      if (action === 'APPROVE') {
        setResult({ type: 'success', msg: `Approved. Institution created.`, apiKey: d.sandboxApiKey })
      } else if (action === 'REJECT') {
        setResult({ type: 'success', msg: 'Application rejected.' })
      } else {
        setResult({ type: 'success', msg: 'Info requested — applicant can re-submit.' })
      }
      load(); setSelected(null); setAction(null); setNotes(''); setRejection('')
    } catch (e: any) {
      setResult({ type: 'error', msg: e.message })
    }
    setWorking(false)
  }

  const fmtDate = (s?: string) => s ? new Date(s).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }) : '—'
  const fmtSize = (n: number) => n > 1024*1024 ? `${(n/1024/1024).toFixed(1)} MB` : `${Math.round(n/1024)} KB`

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-white">Onboarding Review</h1>
          <p className="text-sm text-gray-500 mt-0.5">Review and approve institution membership applications</p>
        </div>
        <a href="/onboard" target="_blank" className="text-xs text-brand-400 hover:text-brand-300 border border-brand-700/40 px-3 py-1.5 rounded-lg">
          Preview onboarding form ↗
        </a>
      </div>

      {/* Result banner */}
      {result && (
        <div className={`rounded-xl p-4 text-sm ${result.type === 'success' ? 'bg-green-900/30 border border-green-700/40 text-green-300' : 'bg-red-900/30 border border-red-700/40 text-red-300'}`}>
          <div className="font-medium mb-1">{result.msg}</div>
          {result.apiKey && (
            <div className="mt-2">
              <div className="text-xs text-green-500 mb-1">Sandbox API key (shown once — deliver securely):</div>
              <code className="block bg-black/40 px-3 py-2 rounded text-green-400 text-xs font-mono break-all">{result.apiKey}</code>
            </div>
          )}
          <button onClick={() => setResult(null)} className="text-xs opacity-60 hover:opacity-100 mt-2">Dismiss</button>
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
        {(['ALL', 'SUBMITTED', 'INFO_REQUESTED', 'APPROVED', 'REJECTED', 'DRAFT'] as const).map(s => (
          <button key={s} onClick={() => setFilter(s)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition ${filter === s ? 'bg-brand-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
            {s === 'ALL' ? 'All' : s.replace('_', ' ')}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-gray-500 text-sm">Loading…</div>
        ) : apps.length === 0 ? (
          <div className="p-12 text-center text-gray-500 text-sm">No applications{filter !== 'ALL' ? ` with status ${filter}` : ''}.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-800">
              <tr className="text-xs text-gray-500">
                <th className="text-left px-5 py-3 font-medium">Institution</th>
                <th className="text-left px-4 py-3 font-medium">Country / Type</th>
                <th className="text-left px-4 py-3 font-medium">Contact</th>
                <th className="text-left px-4 py-3 font-medium">Docs</th>
                <th className="text-left px-4 py-3 font-medium">Submitted</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3"/>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {apps.map(a => (
                <tr key={a.id} className="hover:bg-gray-800/40 transition">
                  <td className="px-5 py-3.5">
                    <div className="font-medium text-white">{a.legalName}</div>
                    {a.tradingName && <div className="text-xs text-gray-500">{a.tradingName}</div>}
                  </td>
                  <td className="px-4 py-3.5">
                    <div className="text-gray-300">{a.country}</div>
                    <div className="text-xs text-gray-500">{a.kind}</div>
                  </td>
                  <td className="px-4 py-3.5">
                    <div className="text-gray-300">{a.contactName}</div>
                    <div className="text-xs text-gray-500">{a.contactEmail}</div>
                  </td>
                  <td className="px-4 py-3.5 text-gray-400">{a.documents.length}</td>
                  <td className="px-4 py-3.5 text-gray-400 text-xs">{fmtDate(a.submittedAt)}</td>
                  <td className="px-4 py-3.5">
                    <span className={`text-xs px-2 py-1 rounded-full font-medium ${STATUS_COLORS[a.status]}`}>{a.status.replace('_',' ')}</span>
                  </td>
                  <td className="px-4 py-3.5 text-right">
                    <button onClick={() => { setSelected(a); setAction(null); setNotes(''); setRejection(''); setResult(null) }}
                      className="text-xs text-brand-400 hover:text-brand-300 border border-brand-700/40 px-2.5 py-1 rounded">
                      Review
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Detail drawer */}
      {selected && (
        <div className="fixed inset-0 bg-black/70 z-50 flex justify-end" onClick={() => setSelected(null)}>
          <div className="w-full max-w-2xl bg-gray-900 h-full overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="p-6 border-b border-gray-800 flex items-start justify-between">
              <div>
                <div className="text-lg font-semibold text-white">{selected.legalName}</div>
                <div className="text-sm text-gray-500 mt-0.5">{selected.id}</div>
              </div>
              <button onClick={() => setSelected(null)} className="text-gray-500 hover:text-white text-xl">×</button>
            </div>

            <div className="p-6 space-y-6">
              {/* Institution */}
              <section>
                <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Institution</h3>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  {[
                    ['Country', selected.country], ['Type', selected.kind],
                    ['Licence', selected.regulatoryLicence || '—'], ['Authority', selected.licensingAuthority || '—'],
                    ['Assets', selected.preferredAssets.join(', ')], ['Volume', selected.expectedVolume || '—'],
                    ['Corridors', selected.corridors.join(', ') || '—'], ['Submitted', fmtDate(selected.submittedAt)],
                  ].map(([k,v]) => (
                    <div key={k}><span className="text-gray-500">{k}: </span><span className="text-gray-200">{v}</span></div>
                  ))}
                </div>
              </section>

              {/* Contact */}
              <section>
                <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Technical Contact</h3>
                <div className="text-sm space-y-1">
                  <div><span className="text-gray-500">Name: </span><span className="text-gray-200">{selected.contactName}</span></div>
                  <div><span className="text-gray-500">Email: </span><span className="text-gray-200">{selected.contactEmail}</span></div>
                </div>
              </section>

              {/* Declarations */}
              <section>
                <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Declarations</h3>
                <div className="space-y-1 text-sm">
                  {[['AML/CFT policy', selected.amlPolicyConfirmed], ['UBO declaration', selected.uboDeclarationConfirmed], ['Terms accepted', selected.termsAccepted]].map(([l,v]) => (
                    <div key={l as string} className="flex items-center gap-2">
                      <span className={v ? 'text-green-400' : 'text-red-400'}>{v ? '✓' : '✗'}</span>
                      <span className="text-gray-400">{l as string}</span>
                    </div>
                  ))}
                </div>
              </section>

              {/* Documents */}
              <section>
                <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Documents ({selected.documents.length})</h3>
                {selected.documents.length === 0 ? (
                  <div className="text-sm text-gray-600">No documents uploaded.</div>
                ) : (
                  <div className="space-y-2">
                    {selected.documents.map(d => (
                      <div key={d.id} className="flex items-center justify-between bg-gray-800 rounded-lg px-3 py-2.5">
                        <div>
                          <div className="text-sm text-gray-200">{d.fileName}</div>
                          <div className="text-xs text-gray-500">{d.docType.replace(/_/g,' ')} · {fmtSize(d.sizeBytes)}</div>
                        </div>
                        <a href={`/api/onboarding/${selected.id}/documents/${d.id}/download`}
                          target="_blank"
                          className="text-xs text-brand-400 hover:text-brand-300 border border-brand-700/40 px-2 py-1 rounded">
                          Download
                        </a>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Review action */}
              {(selected.status === 'SUBMITTED' || selected.status === 'INFO_REQUESTED') && (
                <section className="border-t border-gray-800 pt-5">
                  <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Compliance Review</h3>
                  <div className="flex gap-2 mb-4">
                    {(['APPROVE', 'REQUEST_INFO', 'REJECT'] as const).map(a => (
                      <button key={a} onClick={() => setAction(a)}
                        className={`flex-1 py-2 rounded-lg text-xs font-medium transition ${
                          action === a
                            ? a === 'APPROVE' ? 'bg-green-600 text-white' : a === 'REJECT' ? 'bg-red-600 text-white' : 'bg-yellow-600 text-white'
                            : 'bg-gray-800 text-gray-400 hover:text-gray-200'
                        }`}>
                        {a === 'REQUEST_INFO' ? 'Request info' : a.charAt(0) + a.slice(1).toLowerCase()}
                      </button>
                    ))}
                  </div>
                  {action && (
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs text-gray-400 mb-1">Internal compliance notes (not shown to applicant)</label>
                        <textarea value={notes} onChange={e => setNotes(e.target.value)}
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 resize-none outline-none focus:border-brand-600"
                          rows={3} placeholder="Add compliance notes…"/>
                      </div>
                      {action === 'REJECT' && (
                        <div>
                          <label className="block text-xs text-gray-400 mb-1">Rejection reason (shown to applicant)</label>
                          <textarea value={rejection} onChange={e => setRejection(e.target.value)}
                            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 resize-none outline-none focus:border-red-600"
                            rows={2} placeholder="e.g. Licence expired or invalid."/>
                        </div>
                      )}
                      <button onClick={submitReview} disabled={working}
                        className={`w-full py-2.5 rounded-lg text-sm font-medium transition ${
                          action === 'APPROVE' ? 'bg-green-600 hover:bg-green-700 text-white' :
                          action === 'REJECT' ? 'bg-red-600 hover:bg-red-700 text-white' :
                          'bg-yellow-600 hover:bg-yellow-700 text-white'
                        } disabled:opacity-50`}>
                        {working ? 'Processing…' : action === 'APPROVE' ? '✓ Approve & activate' : action === 'REJECT' ? 'Reject application' : 'Send info request'}
                      </button>
                    </div>
                  )}
                </section>
              )}

              {/* Already reviewed */}
              {(selected.status === 'APPROVED' || selected.status === 'REJECTED') && (
                <section className="border-t border-gray-800 pt-5">
                  <div className="text-sm text-gray-500">Reviewed {fmtDate(selected.reviewedAt)} by {selected.reviewedBy || '—'}</div>
                  {selected.reviewNotes && <div className="mt-2 text-sm text-gray-400"><span className="text-gray-600">Notes: </span>{selected.reviewNotes}</div>}
                  {selected.rejectionReason && <div className="mt-1 text-sm text-red-400"><span className="text-gray-600">Reason: </span>{selected.rejectionReason}</div>}
                  {selected.institutionId && <div className="mt-2 text-sm text-green-400"><span className="text-gray-600">Institution ID: </span><code className="font-mono">{selected.institutionId}</code></div>}
                </section>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
