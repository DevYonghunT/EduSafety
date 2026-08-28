import { RUBRIC_VERSION } from '../data/rubric.js'

const MARK_STATES = {
  pass_candidate: {
    className: 'certification-issued',
    symbol: '✓',
    label: '필수 요건 통과',
    summary: (actions) => `권장 수정 ${actions.shouldFix}건 · 사람 확인 ${actions.confirm}건`,
  },
  hold: {
    className: 'certification-attention',
    symbol: '!',
    label: '판정 보류',
    summary: (actions) => `사람 확인 ${actions.confirm}건 · 확인 완료 전 통과로 보지 않음`,
  },
  fail_candidate: {
    className: 'certification-invalid',
    symbol: '×',
    label: '필수 요건 미충족',
    summary: (actions) => `반드시 수정 ${actions.mustFix}건 · 수정 후 재심사 필요`,
  },
}

function fixedPoint(repoMeta) {
  if (repoMeta?.commitSha) return `커밋 ${repoMeta.commitSha.slice(0, 12)}`
  if (repoMeta?.fingerprint) return `콘텐츠 지문 ${repoMeta.fingerprint.slice(0, 12)}`
  return '고정 지점 정보 없음'
}

function targetName(repoMeta) {
  if (repoMeta?.owner && repoMeta?.repo) return `${repoMeta.owner}/${repoMeta.repo}`
  return repoMeta?.name || '제출물'
}

export function reportStatusMark(repoMeta, summary) {
  const state = MARK_STATES[summary?.status] || MARK_STATES.hold
  const actions = {
    mustFix: Number(summary?.actions?.mustFix) || 0,
    shouldFix: Number(summary?.actions?.shouldFix) || 0,
    confirm: Number(summary?.actions?.confirm) || 0,
  }
  return {
    ...state,
    detail: state.summary(actions),
    target: targetName(repoMeta),
    fixedPoint: fixedPoint(repoMeta),
  }
}

export default function CertificationMark({ repoMeta, summary }) {
  const mark = reportStatusMark(repoMeta, summary)

  return (
    <section
      className={`certification-mark ${mark.className} print-only`}
      aria-labelledby="report-status-mark-title"
    >
      <div className="certification-mark-head">
        <div>
          <h3 id="report-status-mark-title">에듀 세이프 심사 상태마크</h3>
          <p className="certification-kind">루브릭 {RUBRIC_VERSION} · 보고서 출력본 판정 요약</p>
        </div>
        <span className="certification-state">{mark.label}</span>
      </div>

      <div className="report-mark-body">
        <span className="report-mark-symbol" aria-hidden="true">{mark.symbol}</span>
        <div className="report-mark-copy">
          <strong>{mark.label}</strong>
          <p>{mark.detail}</p>
          <p className="report-mark-subject"><span>{mark.target}</span> · <code>{mark.fixedPoint}</code></p>
        </div>
      </div>

      <p className="certification-limit">
        이 표시는 고정된 제출물에 대한 본 심사 보고서의 판정 요약이며, 별도로 발급되거나 검증되는 증명서가 아닙니다.
      </p>
    </section>
  )
}
