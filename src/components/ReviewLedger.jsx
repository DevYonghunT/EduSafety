import { useEffect, useState } from 'react'
import { listRecords, deleteRecord, exportJson, fetchServerRecords } from '../lib/ledger.js'
import { STATUS_LABELS } from '../lib/reviewSummary.js'

const STATUS_CLASS = { pass_candidate: 'ok', hold: 'warn', fail_candidate: 'danger' }

function pilotStats(records) {
  const withCounts = records.filter((r) => r.counts && r.applicableItems)
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  const needsHumanRate = avg(withCounts.map((r) => r.counts.needs_human / r.applicableItems))
  const overrideRate = avg(withCounts.map((r) => (r.overrides || 0) / r.applicableItems))
  const statusDist = { pass_candidate: 0, hold: 0, fail_candidate: 0 }
  for (const r of records) if (statusDist[r.status] !== undefined) statusDist[r.status]++
  const cost = records.reduce((a, r) => a + (r.costUsd || 0), 0)
  const aiUsed = records.filter((r) => r.aiUsed).length
  return { needsHumanRate, overrideRate, statusDist, cost, aiUsed, measured: withCounts.length }
}

export default function ReviewLedger() {
  const [records, setRecords] = useState(listRecords)
  const stats = pilotStats(records)
  const [server, setServer] = useState(null)
  useEffect(() => { fetchServerRecords().then(setServer) }, [])

  const remove = (id) => {
    deleteRecord(id)
    setRecords(listRecords())
  }

  const download = () => {
    const blob = new Blob([exportJson()], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `edusafe-심사기록-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <section className="panel">
      <h1>📚 심사 기록</h1>
      <p className="intro">이 브라우저에 저장된 심사 대장입니다. 같은 앱의 재심사는 회차(🔁)로 연결됩니다.</p>
      {server && (
        <p className="hint">
          {server.available
            ? `☁️ 서버 대장: ${server.records.length}건 (관리자 세션 연결됨 — 저장 시 서버에도 기록됩니다)`
            : server.reason === 'login'
              ? '서버 대장은 관리자 로그인(/admin/login) 후 연결됩니다 — 지금은 이 브라우저 기록만 표시합니다.'
              : '서버 대장에 연결되지 않았습니다 — 이 브라우저 기록만 표시합니다.'}
        </p>
      )}

      {records.length === 0 ? (
        <p className="intro" style={{ marginTop: 16 }}>아직 저장된 심사가 없습니다. 보고서 화면에서 "심사 기록에 저장"을 누르면 여기에 쌓입니다.</p>
      ) : (
        <>
          <div className="scan-box">
            <strong>파일럿 지표 — 교육청 제안의 근거 데이터</strong>
            <div className="cat-grid">
              <div className="cat-card"><div className="cat-name">심사 건수</div><div className="cat-state">{records.length}건 (AI 사용 {stats.aiUsed})</div></div>
              <div className="cat-card"><div className="cat-name">평균 판단불가율</div><div className="cat-state">{stats.measured ? `${(stats.needsHumanRate * 100).toFixed(0)}%` : '—'}</div></div>
              <div className="cat-card"><div className="cat-name">평균 번복률</div><div className="cat-state">{stats.measured ? `${(stats.overrideRate * 100).toFixed(0)}%` : '—'}</div></div>
              <div className="cat-card"><div className="cat-name">종합 판정 분포</div><div className="cat-state">합격 후보 {stats.statusDist.pass_candidate} · 보류 {stats.statusDist.hold} · 불합격 후보 {stats.statusDist.fail_candidate}</div></div>
              <div className="cat-card"><div className="cat-name">누적 AI 비용</div><div className="cat-state">${stats.cost.toFixed(2)}</div></div>
            </div>
            <p className="hint">판단불가율·번복률은 통계 필드가 있는 기록({stats.measured}건)만 집계합니다. 낮을수록 AI 초안의 정확도가 높다는 뜻이고, 이 숫자가 루브릭 개정과 제안서의 근거가 됩니다.</p>
          </div>
          <div className="btn-row" style={{ marginBottom: 14 }}>
            <button className="btn-secondary" onClick={download}>⬇️ JSON 내보내기 ({records.length}건)</button>
          </div>
          <div className="ledger-list">
            {records.map((r) => (
              <div key={r.id} className="ledger-card">
                <div className="ledger-main">
                  <strong>{r.target}</strong>
                  {r.round > 1 && <span className="round-badge">🔁 {r.round}회차</span>}
                  <div className="hint">
                    {r.commitSha ? `커밋 ${r.commitSha.slice(0, 12)}` : '폴더 제출'} · {r.profile || r.track} · {r.protectionLevel} · {new Date(r.savedAt).toLocaleString('ko-KR')}
                  </div>
                </div>
                <div className={`ledger-status ledger-${STATUS_CLASS[r.status] || 'warn'}`}>{STATUS_LABELS[r.status] || r.status}</div>
                <button className="btn-secondary" onClick={() => remove(r.id)}>삭제</button>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
