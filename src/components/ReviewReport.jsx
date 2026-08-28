// 심사 보고서 — 점수 없음: 종합판정 3값 + 카테고리별 상태 프로필 + 행동 중심 요약.
// 모든 인용은 텍스트 노드로만 렌더한다 (원칙 6 — HTML 실행 금지).
import { useState } from 'react'
import { RUBRIC_VERSION, FEATURES, featureProfile, CATEGORIES, AUTHORITY_LABELS, rubricItems } from '../data/rubric.js'
import { STATUS_LABELS, CATEGORY_STATE_LABELS, finalVerdict } from '../lib/reviewSummary.js'
import { PROTECTION_LEVELS } from '../lib/reviewAi.js'
import { buildSupplementRequest, CAUSES } from '../lib/supplementRequest.js'
import CertificationMark from './CertificationMark.jsx'

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

export default function ReviewReport({ repoMeta, features, protectionLevel, appSummary, summary, judgments, overrides, humanInputs, coverage, gate, model, aiUsed, certification, onCertificationChange }) {
  const today = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' })
  const [showSupplement, setShowSupplement] = useState(false)
  const [copied, setCopied] = useState(false)

  const targetLabel = repoMeta.commitSha ? `${repoMeta.owner}/${repoMeta.repo} (${repoMeta.branch})` : `${repoMeta.name} (폴더 제출)`
  const pinLabel = repoMeta.commitSha ? `커밋 ${repoMeta.commitSha}` : `SHA-256 지문 ${repoMeta.fingerprint}`

  const copySupplement = async () => {
    const req = buildSupplementRequest({ repoMeta, summary, judgments, overrides, humanInputs, gate })
    try {
      await navigator.clipboard.writeText(req.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      window.alert(req.text)
    }
  }

  // ── 보완 요청서 문서 뷰 (인쇄/PDF용 — 제작 교사에게 전달하는 공식 문서) ──
  if (showSupplement) {
    const req = buildSupplementRequest({ repoMeta, summary, judgments, overrides, humanInputs, gate })
    return (
      <div className="report">
        <div className="report-actions no-print">
          <button className="btn-secondary" onClick={() => setShowSupplement(false)}>← 보고서로 돌아가기</button>
          <button className="btn-secondary" onClick={copySupplement}>{copied ? '✅ 복사됨' : '📋 텍스트 복사'}</button>
          <button className="btn-primary" onClick={() => window.print()}>🖨️ 인쇄 / PDF 저장</button>
        </div>

        <header className="report-head">
          <h2>🛡️ 에듀 세이프 심사 보완 요청서</h2>
          <table className="meta-table">
            <tbody>
              <tr><th>대상</th><td>{targetLabel}</td></tr>
              <tr><th>고정 지점</th><td><code>{pinLabel}</code></td></tr>
              <tr><th>요청일</th><td>{today}</td></tr>
              <tr><th>요청 항목</th><td>총 <strong>{req.count}</strong>건 — 아래 원인별로 정리했습니다</td></tr>
            </tbody>
          </table>
        </header>

        <p className="intro">
          선생님, 제출해 주신 앱의 심사 중 아래 항목들은 지금 자료만으로 판정할 수 없었습니다.
          보완해 주시면 같은 기준으로 심사를 이어가겠습니다. 각 항목의 쉬운 설명은 이 확인이 왜 필요한지에 대한 안내입니다.
        </p>

        {Object.entries(CAUSES).map(([key, cause]) => req.buckets[key].length > 0 && (
          <section key={key}>
            <h3>{cause.title}</h3>
            <p className="hint">{cause.ask}</p>
            <ul className="law-list">
              {req.buckets[key].map((it) => (
                <li key={it.id}>
                  <strong>{it.question}</strong> <span className="vt-id">{it.id}{it.type === 'required' ? ' · 필수' : ''}</span>
                  <div className="hint">{it.plain}</div>
                </li>
              ))}
            </ul>
          </section>
        ))}

        <section className="report-sign">
          <h3>회신 안내</h3>
          <p className="hint">보완 후 다시 제출해 주시면 같은 기준(루브릭 {RUBRIC_VERSION})으로 재심사합니다. 재심사는 새 제출물의 지문에 다시 고정됩니다.</p>
          <div className="sign-row">
            <div className="sign-cell">심사자 성명: ______________</div>
            <div className="sign-cell">연락처: ______________</div>
            <div className="sign-cell">회신 기한: ______________</div>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="report">
      <div className="report-actions no-print">
        {summary.actions.confirm > 0 && (
          <button className="btn-secondary" onClick={() => setShowSupplement(true)}>
            📄 보완 요청서 ({summary.actions.confirm}건) — 보기·인쇄
          </button>
        )}
        <button className="btn-primary" onClick={() => window.print()}>🖨️ 인쇄 / PDF 저장</button>
      </div>

      <header className="report-head">
        <h2>🛡️ 에듀 세이프 심사 보고서</h2>
        <table className="meta-table">
          <tbody>
            <tr><th>심사 대상</th><td>{repoMeta.commitSha ? `${repoMeta.owner}/${repoMeta.repo} (${repoMeta.branch})` : `${repoMeta.name} (폴더 제출)`}</td></tr>
            <tr><th>고정 지점</th><td><code>{repoMeta.commitSha ? `커밋 ${repoMeta.commitSha}` : `SHA-256 지문 ${repoMeta.fingerprint}`}</code> — 이 심사는 이 제출물에 대한 것이며, 이후 수정하면 지문이 달라져 효력이 없습니다.</td></tr>
            <tr><th>루브릭 버전</th><td>{RUBRIC_VERSION}</td></tr>
            <tr><th>기능 프로파일</th><td>{featureProfile(features)} — 적용 심사 항목 {summary.items.length} / {rubricItems.length}</td></tr>
            <tr><th>보호 수준</th><td>{PROTECTION_LEVELS[protectionLevel].label} — {PROTECTION_LEVELS[protectionLevel].plain}</td></tr>
            {appSummary && <tr><th>앱 요약</th><td>{appSummary}</td></tr>}
            <tr><th>AI 분석 고지</th><td>
              {aiUsed
                ? `Anthropic API(${model}) 사용 — 데이터 파일 내용 미전송, 비밀키 마스킹 후 전송${coverage ? `, 검토 커버리지 ${coverage.coveragePercent}%` : ''}. AI 판정은 초안이며 근거 미확인 판정은 자동 강등됨.`
                : 'AI 분석 미사용 — 심사자 수동 판정으로만 진행됨 (외부 전송 없음).'}
            </td></tr>
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

      <CertificationMark
        repoMeta={repoMeta}
        summary={summary}
        certification={certification}
        onCertificationChange={onCertificationChange}
      />

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
                    <div className="vt-id">{it.id}{it.type === 'required' ? ' · 필수' : ''}{it.level ? ` · ${it.level}` : ''}</div>
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

      {summary.inapplicable?.length > 0 && (
        <section>
          <h3>조건 미해당 항목 (자동 '해당없음' 처리 — 투명성 고지)</h3>
          <ul className="law-list">
            {summary.inapplicable.map((it) => (
              <li key={it.id}><strong>{it.question}</strong> — 적용 조건 "{FEATURES[it.when].label}"이 이 앱에 해당하지 않아 심사에서 제외됨</li>
            ))}
          </ul>
        </section>
      )}

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
