import { useState } from 'react'
import ReviewMode from './components/ReviewMode.jsx'
import ReviewLedger from './components/ReviewLedger.jsx'
import AboutPage from './components/AboutPage.jsx'
import SkillPage from './components/SkillPage.jsx'
import SecurityAuditPage from './components/SecurityAuditPage.jsx'

// 순서가 곧 흐름이다 — 교사가 먼저 스스로 점검하고(스킬), 그다음 심사를 받는다.
const TABS = [
  { key: 'about', label: '🏠 소개' },
  { key: 'skill', label: '🧰 스킬' },
  { key: 'review', label: '⚖️ 심사' },
  { key: 'security', label: '🔎 URL 검사' },
  { key: 'ledger', label: '📚 심사 기록' },
]

export default function App() {
  const [view, setView] = useState('about')

  return (
    <div className="app">
      <header className="header">
        <button type="button" className="logo" onClick={() => setView('about')}>
          🛡️ <strong>에듀 세이프</strong>
          <span className="logo-sub">교사 제작 앱 심사·검수 시스템</span>
        </button>
        <nav className="tabs" aria-label="주 메뉴">
          {TABS.map((t) => (
            <button
              type="button"
              key={t.key}
              className={view === t.key ? 'tab active' : 'tab'}
              aria-pressed={view === t.key}
              onClick={() => setView(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="main">
        {view === 'about' && <AboutPage onStart={() => setView('review')} />}
        {view === 'skill' && <SkillPage />}
        {view === 'review' && <ReviewMode />}
        {view === 'security' && <SecurityAuditPage />}
        {view === 'ledger' && <ReviewLedger />}
      </main>

      <footer className="footer">
        에듀 세이프 — AI 판정은 초안이며 최종 판정 권한은 심사자에게 있습니다. · 도전형 해커톤 출품작 (팀 「우매함의 봉우리」 — 덕수고 김용훈, 증산중 서호성, 명지중 이승열)
      </footer>
    </div>
  )
}
