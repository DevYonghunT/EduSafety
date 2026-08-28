import { useState } from 'react'

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
        {view === 'about' && (
          <section className="panel">
            <h1>선생님이 만든 앱, 증거로 검증합니다</h1>
            <p className="intro">
              에듀 세이프는 교사가 바이브 코딩으로 만든 앱의 보안과 전반적 내용을 공인 기관의
              심사자가 최종 심사하기 위한 심사자 전용 시스템입니다. AI가 코드에서 증거를 수집해
              판정 초안을 만들고, 최종 판정은 사람이 합니다.
            </p>
          </section>
        )}
        {view === 'review' && (
          <section className="panel">
            <h1>앱 심사</h1>
            <p className="intro">심사 흐름 구현 예정 (T5~T7)</p>
          </section>
        )}
        {view === 'ledger' && (
          <section className="panel">
            <h1>심사 기록</h1>
            <p className="intro">브라우저 로컬 대장 구현 예정 (여유 기능)</p>
          </section>
        )}
      </main>

      <footer className="footer">
        에듀 세이프 — AI 판정은 초안이며 최종 판정 권한은 심사자에게 있습니다. · 도전형 해커톤 출품작 (팀 「우매한 봉우리」)
      </footer>
    </div>
  )
}
