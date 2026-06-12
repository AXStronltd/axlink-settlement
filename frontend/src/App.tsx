import { useState } from 'react'
import Dashboard from './components/Dashboard'
import Users from './components/Users'
import Accounts from './components/Accounts'
import Transfers from './components/Transfers'
import Deposits from './components/Deposits'
import Withdrawals from './components/Withdrawals'
import Simulator from './components/Simulator'

type Page = 'dashboard' | 'users' | 'wallet' | 'transfers' | 'deposits' | 'withdrawals' | 'simulator'

const NAV: { id: Page; label: string; icon: string }[] = [
  { id: 'dashboard',   label: 'Dashboard',   icon: '▦' },
  { id: 'users',       label: 'Users',        icon: '◉' },
  { id: 'wallet',      label: 'Accounts',     icon: '▣' },
  { id: 'transfers',   label: 'Transfers',    icon: '⇄' },
  { id: 'deposits',    label: 'Deposits',     icon: '↓' },
  { id: 'withdrawals', label: 'Withdrawals',  icon: '↑' },
  { id: 'simulator',   label: 'Simulator',    icon: '▷' },
]

export default function App() {
  const [page, setPage] = useState<Page>('dashboard')

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col">
        <div className="p-5 border-b border-gray-800">
          <div className="text-xs font-mono text-brand-400 mb-0.5">AXSTRON</div>
          <div className="text-sm font-semibold text-white">FinCruse Settlement</div>
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
      </main>
    </div>
  )
}
