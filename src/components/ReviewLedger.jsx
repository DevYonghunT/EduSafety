import { useState } from 'react'
import { listRecords, deleteRecord, exportJson } from '../lib/ledger.js'
import { TRACKS } from '../data/rubric.js'
import { STATUS_LABELS } from '../lib/reviewSummary.js'

const STATUS_CLASS = { pass_candidate: 'ok', hold: 'warn', fail_candidate: 'danger' }

export default function ReviewLedger() {
  const [records, setRecords] = useState(listRecords)

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

      {records.length === 0 ? (
        <p className="intro" style={{ marginTop: 16 }}>아직 저장된 심사가 없습니다. 보고서 화면에서 "심사 기록에 저장"을 누르면 여기에 쌓입니다.</p>
      ) : (
        <>
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
                    {r.commitSha ? `커밋 ${r.commitSha.slice(0, 12)}` : '폴더 제출'} · {TRACKS[r.track]?.label || r.track} · {r.protectionLevel} · {new Date(r.savedAt).toLocaleString('ko-KR')}
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
