import { useState } from 'react'
import ReviewMode from './components/ReviewMode.jsx'
import ReviewLedger from './components/ReviewLedger.jsx'
import AboutPage from './components/AboutPage.jsx'

const TABS = [
  { key: 'about', label: '🏠 소개' },
  { key: 'review', label: '⚖️ 심사' },
  { key: 'ledger', label: '📚 심사 기록' },
]

export default function App() {
  const [view, setView] = useState('about')

  return (
    <div className="app">
      <header className="header">
        <button className="logo" onClick={() => setView('about')}>
          🛡️ <strong>에듀 세이프</strong>
          <span className="logo-sub">교사 제작 앱 심사·검수 시스템</span>
        </button>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.key} className={view === t.key ? 'tab active' : 'tab'} onClick={() => setView(t.key)}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="main">
        {view === 'about' && <AboutPage onStart={() => setView('review')} />}
        {view === 'review' && <ReviewMode />}
        {view === 'ledger' && <ReviewLedger />}
      </main>

      <footer className="footer">
        에듀 세이프 — AI 판정은 초안이며 최종 판정 권한은 심사자에게 있습니다. · 도전형 해커톤 출품작 (팀 「우매한 봉우리」)
      </footer>
    </div>
  )
}
