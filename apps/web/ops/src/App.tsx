import { useState } from 'react'
import Dashboard from './components/Dashboard'
import Users from './components/Users'
import Accounts from './components/Accounts'
import Transfers from './components/Transfers'
import Deposits from './components/Deposits'
import Withdrawals from './components/Withdrawals'
import Simulator from './components/Simulator'
import LiveDemo from './components/LiveDemo'
import { getStoredOpsKey, storeOpsKey } from './api'

type Page = 'dashboard' | 'users' | 'wallet' | 'transfers' | 'deposits' | 'withdrawals' | 'simulator' | 'livedemo'

const NAV: { id: Page; label: string; icon: string }[] = [
  { id: 'dashboard',   label: 'Dashboard',   icon: '▦' },
  { id: 'users',       label: 'Users',        icon: '◉' },
  { id: 'wallet',      label: 'Accounts',     icon: '▣' },
  { id: 'transfers',   label: 'Transfers',    icon: '⇄' },
  { id: 'deposits',    label: 'Deposits',     icon: '↓' },
  { id: 'withdrawals', label: 'Withdrawals',  icon: '↑' },
  { id: 'simulator',   label: 'Simulator',    icon: '▷' },
  { id: 'livedemo',    label: 'Live Demo',    icon: '◈' },
]

function LoginModal({ onLogin }: { onLogin: () => void }) {
  const [key, setKey] = useState('')
  const [error, setError] = useState('')

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!key.trim()) { setError('Enter your operator key'); return }
    storeOpsKey(key.trim())
    onLogin()
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-xs font-mono text-brand-400 mb-1 tracking-widest">AXSTRON</div>
          <div className="text-xl font-semibold text-white">AxLink Settlement</div>
          <div className="text-sm text-gray-500 mt-1">Ops Dashboard</div>
        </div>
        <form onSubmit={submit} className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Operator Key (OPS_API_KEY)</label>
            <input
              type="password"
              className="input"
              placeholder="Enter your operator key"
              value={key}
              onChange={e => { setKey(e.target.value); setError('') }}
              autoFocus
            />
            {error && <p className="text-red-400 text-xs mt-1">{error}</p>}
          </div>
          <button type="submit" className="btn-primary w-full">Sign in</button>
          <div className="text-center">
            <span className="text-xs text-gray-600 font-mono">Sandbox mode · no credentials required</span>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function App() {
  const [page, setPage] = useState<Page>('dashboard')
  const [authed, setAuthed] = useState(() => !!getStoredOpsKey())

  if (!authed) return <LoginModal onLogin={() => setAuthed(true)} />

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col">
        <div className="p-5 border-b border-gray-800">
          <div className="text-xs font-mono text-brand-400 mb-0.5">AXSTRON</div>
          <div className="text-sm font-semibold text-white">AxLink Settlement</div>
          <div className="text-xs text-gray-500 mt-0.5">Ops Dashboard</div>
        </div>
        <nav className="flex-1 p-3 space-y-0.5">
          {NAV.map(n => (
            <button
              key={n.id}
              onClick={() => setPage(n.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition text-left ${
                page === n.id
                  ? 'bg-brand-600/20 text-brand-400 border border-brand-600/30'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
              }`}
            >
              <span className="text-base w-4 text-center">{n.icon}</span>
              {n.label}
            </button>
          ))}
        </nav>
        <div className="p-4 border-t border-gray-800">
          <div className="text-xs text-gray-600 mono">v1.0.0 · settlement</div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto">
        {page === 'dashboard'   && <Dashboard />}
        {page === 'users'       && <Users />}
        {page === 'wallet'      && <Accounts />}
        {page === 'transfers'   && <Transfers />}
        {page === 'deposits'    && <Deposits />}
        {page === 'withdrawals' && <Withdrawals />}
        {page === 'simulator'   && <Simulator />}
        {page === 'livedemo'    && <LiveDemo />}
      </main>
    </div>
  )
}
