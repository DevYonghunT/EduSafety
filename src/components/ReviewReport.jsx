// 심사 보고서 — 점수 없음: 종합판정 3값 + 카테고리별 상태 프로필 + 행동 중심 요약.
// 모든 인용은 텍스트 노드로만 렌더한다 (원칙 6 — HTML 실행 금지).
import { useState } from 'react'
import { RUBRIC_VERSION, TRACKS, CATEGORIES, AUTHORITY_LABELS } from '../data/rubric.js'
import { STATUS_LABELS, CATEGORY_STATE_LABELS, finalVerdict } from '../lib/reviewSummary.js'
import { PROTECTION_LEVELS } from '../lib/reviewAi.js'
import { buildSupplementRequest } from '../lib/supplementRequest.js'

export const VERDICT_LABELS = { ok: '충족', fail: '미충족', needs_human: '판단불가', na: '해당없음' }

const STATE_COLORS = {
  ok: 'var(--ok)',
  needs_human: 'var(--warn)',
  fail: '#e0641f',
  fail_required: 'var(--danger)',
}

const STATUS_COLORS = { pass_candidate: 'var(--ok)', hold: 'var(--warn)', fail_candidate: 'var(--danger)' }

export function verdictColor(v, item) {
  if (v === 'fail') return item.type === 'required' ? STATE_COLORS.fail_required : STATE_COLORS.fail
  if (v === 'needs_human') return STATE_COLORS.needs_human
  return STATE_COLORS.ok
}

export default function ReviewReport({ repoMeta, track, protectionLevel, appSummary, summary, judgments, overrides, humanInputs, coverage, gate }) {
  const today = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' })
  const [supplement, setSupplement] = useState(null)
  const [copied, setCopied] = useState(false)

  const copySupplement = async () => {
    const req = buildSupplementRequest({ repoMeta, summary, judgments, overrides, humanInputs, gate })
    setSupplement(req.text)
    try {
      await navigator.clipboard.writeText(req.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      // 클립보드 권한이 없으면 아래 텍스트를 직접 복사하도록 보여주기만 한다
    }
  }

  return (
    <div className="report">
      <div className="report-actions no-print">
        {summary.actions.confirm > 0 && (
          <button className="btn-secondary" onClick={copySupplement}>
            {copied ? '✅ 복사됨' : `📋 보완 요청서 복사 (${summary.actions.confirm}건)`}
          </button>
        )}
        <button className="btn-primary" onClick={() => window.print()}>🖨️ 인쇄 / PDF 저장</button>
      </div>
      {supplement && (
        <details className="supplement no-print" open>
          <summary>보완 요청서 미리보기 (제작 교사에게 전달)</summary>
          <textarea readOnly value={supplement} rows={12} />
        </details>
      )}

      <header className="report-head">
        <h2>🛡️ 에듀 세이프 심사 보고서</h2>
        <table className="meta-table">
          <tbody>
            <tr><th>심사 대상</th><td>{repoMeta.owner}/{repoMeta.repo} ({repoMeta.branch})</td></tr>
            <tr><th>고정 지점</th><td><code>커밋 {repoMeta.commitSha}</code> — 이 심사는 이 커밋에 대한 것이며, 이후 수정 시 효력이 없습니다.</td></tr>
            <tr><th>루브릭 버전</th><td>{RUBRIC_VERSION}</td></tr>
            <tr><th>분류</th><td>{TRACKS[track].icon} {TRACKS[track].label}</td></tr>
            <tr><th>보호 수준</th><td>{PROTECTION_LEVELS[protectionLevel].label} — {PROTECTION_LEVELS[protectionLevel].plain}</td></tr>
            {appSummary && <tr><th>앱 요약</th><td>{appSummary}</td></tr>}
            <tr><th>심사일</th><td>{today}</td></tr>
          </tbody>
        </table>
      </header>

      <section className="report-status" style={{ borderColor: STATUS_COLORS[summary.status] }}>
        <div className="status-word" style={{ color: STATUS_COLORS[summary.status] }}>{STATUS_LABELS[summary.status]}</div>
        <div className="status-actions">
          반드시 수정 <strong>{summary.actions.mustFix}</strong>건 ·
          권장 수정 <strong>{summary.actions.shouldFix}</strong>건 ·
          사람 확인 필요 <strong>{summary.actions.confirm}</strong>건
        </div>
        {summary.status === 'hold' && <p className="hint">판단불가 항목이 남아 있어 종합 판정은 보류입니다 (원칙 3).</p>}
      </section>

      <section>
        <h3>카테고리별 상태 프로필</h3>
        <div className="cat-grid">
          {Object.entries(summary.categoryStates).map(([cat, state]) => (
            <div key={cat} className="cat-card" style={{ borderTopColor: STATE_COLORS[state] }}>
              <div className="cat-name">{CATEGORIES[cat]}</div>
              <div className="cat-state" style={{ color: STATE_COLORS[state] }}>{CATEGORY_STATE_LABELS[state]}</div>
            </div>
          ))}
        </div>
      </section>

      {coverage && coverage.excludedFiles.length > 0 && (
        <section className="coverage-note">
          <h3>AI 검토 커버리지 고지</h3>
          <p>
            AI가 검토한 파일은 전체의 <strong>{coverage.coveragePercent}%</strong>입니다.
            제외: {coverage.excludedFiles.map((e) => `${e.path}(${e.reason})`).join(', ')}
          </p>
        </section>
      )}

      <section>
        <h3>판정표</h3>
        <table className="verdict-table">
          <thead>
            <tr><th>항목</th><th>법적 무게</th><th>판정</th><th>사유·근거</th></tr>
          </thead>
          <tbody>
            {summary.items.map((it) => {
              const v = finalVerdict(it, judgments, overrides, humanInputs)
              const ov = overrides[it.id]
              const j = it.aiVerifiable ? judgments[it.id] : humanInputs[it.id]
              return (
                <tr key={it.id}>
                  <td>
                    <div className="vt-q">{it.question}</div>
                    <div className="vt-id">{it.id}{it.type === 'required' ? ' · 필수' : ''}</div>
                  </td>
                  <td className="vt-auth">{AUTHORITY_LABELS[it.authority]}</td>
                  <td>
                    <span className="verdict-chip" style={{ background: verdictColor(v, it), opacity: v === 'na' ? 0.55 : 1 }}>
                      {VERDICT_LABELS[v] || '판단불가'}
                    </span>
                    {ov && <div className="vt-override">심사자 번복</div>}
                  </td>
                  <td className="vt-reason">
                    {ov ? `[번복 사유] ${ov.reason || '기재 없음'}` : j?.reason || '—'}
                    {!ov && j?.evidence?.slice(0, 2).map((e, i) => (
                      <div key={i} className="vt-evidence"><code>{e.file}</code>: {e.quote}</div>
                    ))}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      <section className="report-sign">
        <h3>심사 확인</h3>
        <p className="hint">AI 판정은 초안이며, 이 보고서의 최종 판정 권한과 책임은 심사자에게 있습니다 (원칙 4).</p>
        <div className="sign-row">
          <div className="sign-cell">심사자 성명: ______________</div>
          <div className="sign-cell">소속: ______________</div>
          <div className="sign-cell">서명: ______________</div>
        </div>
      </section>
    </div>
  )
}
