import { issueCertificationBadge, settleCertificationRequest } from '../lib/certificationBadge.js'

const BADGE_STATUS_LABELS = {
  VALID: '유효',
  STALE: '현재 HEAD 변경',
  UNVERIFIED: '현재 상태 확인 불가',
  EXPIRED: '만료',
  REVOKED: '취소',
  INVALID: '검증 실패',
}

const COMMIT_SHA = /^[0-9a-f]{40}$/i
let requestSequence = 0

function repositoryUrl(repoMeta) {
  if (!repoMeta?.owner || !repoMeta?.repo) return null
  return `https://github.com/${repoMeta.owner}/${repoMeta.repo}`
}

function nonPassingResults(response) {
  const criteria = Array.isArray(response?.criteria)
    ? response.criteria
      .filter((item) => item?.result !== 'PASS')
      .map((item) => ({ ...item, id: item.criterionId, version: item.criterionVersion }))
    : []
  const blockers = Array.isArray(response?.safetyBlockers)
    ? response.safetyBlockers
      .filter((item) => item?.triggered === true || (item?.result && item.result !== 'PASS'))
      .map((item) => ({
        ...item,
        id: item.blockerId || item.controlId,
        version: item.version || item.controlVersion,
        result: item.triggered === true ? 'BLOCK' : item.result,
      }))
    : []
  return [...criteria, ...blockers]
}

function ReportContext({ summary }) {
  if (summary.status === 'pass_candidate') return null
  if (summary.status === 'hold') {
    return (
      <p className="certification-report-context">
        <strong>현재 보고서 판정은 보류입니다.</strong>{' '}
        사람 확인이 필요한 항목 {summary.actions.confirm}건은 참고 정보이며 인증 요청에는 전송하지 않습니다.
      </p>
    )
  }
  return (
    <p className="certification-report-context">
      <strong>현재 보고서 판정은 미충족입니다.</strong>{' '}
      이 종합판정은 참고 정보이며 인증마크 발급 여부는 서버의 활성 인증 정책으로 별도 결정합니다.
    </p>
  )
}

export default function CertificationMark({ repoMeta, summary, certification, onCertificationChange = () => {} }) {
  const githubUrl = repositoryUrl(repoMeta)
  const hasExactCommit = Boolean(githubUrl && COMMIT_SHA.test(repoMeta?.commitSha || ''))
  const subjectKey = hasExactCommit ? `${githubUrl}\0${repoMeta.commitSha.toLowerCase()}` : null
  const state = certification?.subjectKey && certification.subjectKey !== subjectKey
    ? { phase: 'idle' }
    : certification || { phase: 'idle' }
  const reportPassed = summary?.status === 'pass_candidate'
  const busy = state.phase === 'loading'

  const requestBadge = async () => {
    if (!hasExactCommit || busy) return
    const requestId = `${subjectKey}:${++requestSequence}`
    onCertificationChange({ phase: 'loading', subjectKey, requestId })
    const updateCurrentRequest = (next) => {
      onCertificationChange((current) => settleCertificationRequest(current, { subjectKey, requestId }, next))
    }
    try {
      const response = await issueCertificationBadge({
        repositoryUrl: githubUrl,
        commitSha: repoMeta.commitSha.toLowerCase(),
      })
      updateCurrentRequest({
        phase: response.outcome === 'ISSUED' ? 'issued' : 'not_issued',
        response,
      })
    } catch (error) {
      updateCurrentRequest({
        phase: 'error',
        error: {
          code: error?.code || 'CERTIFICATION_REQUEST_FAILED',
          message: error?.message || '인증마크 발급 요청을 처리하지 못했습니다.',
        },
      })
    }
  }

  const issued = state.phase === 'issued' && state.response?.outcome === 'ISSUED'
  const badge = issued ? state.response.badge : null
  const statusLabel = badge ? (BADGE_STATUS_LABELS[badge.status] || badge.status) : null
  const badgeTone = badge?.status === 'VALID'
    ? 'issued'
    : ['INVALID', 'REVOKED', 'EXPIRED'].includes(badge?.status) ? 'invalid' : badge ? 'attention' : null
  const panelTone = badgeTone
    || (state.phase === 'not_issued' ? 'attention'
      : state.phase === 'error' ? 'invalid'
        : reportPassed ? 'ready' : 'waiting')
  const stateLabel = issued
    ? statusLabel
    : busy ? '재검사 중'
      : state.phase === 'not_issued' ? '미발급'
        : state.phase === 'error' ? '요청 실패'
          : hasExactCommit ? '서버 확인 필요' : '미발급'
  const failedResults = state.phase === 'not_issued' ? nonPassingResults(state.response) : []

  return (
    <section
      className={`certification-mark certification-${panelTone}`}
      aria-labelledby="certification-mark-title"
      aria-busy={busy}
    >
      <div className="certification-mark-head">
        <div>
          <h3 id="certification-mark-title">인증마크</h3>
          <p className="certification-kind">EAS Offchain v2 기반 가스리스 서명 인증마크</p>
        </div>
        <span className="certification-state">
          {stateLabel}
        </span>
      </div>

      {!hasExactCommit && (
        <div className="certification-message">
          <strong>GitHub exact commit 필요</strong>
          <p>폴더 제출물은 Git commit에 고정할 수 없어 인증마크 발급 대상에 포함하지 않습니다.</p>
        </div>
      )}

      {hasExactCommit && state.phase === 'idle' && (
        <div className="certification-message">
          <ReportContext summary={summary} />
          <strong>서버 재검사 후 발급</strong>
          <p>화면의 판정값은 전송하지 않습니다. 서버가 이 커밋을 다시 분석해 활성 정책의 선택 항목을 모두 통과한 경우에만 발급합니다.</p>
          <button type="button" className="btn-primary no-print" onClick={requestBadge}>
            인증마크 발급 요청
          </button>
        </div>
      )}

      {hasExactCommit && busy && (
        <div className="certification-message" role="status">
          <strong>저장소와 선택 항목을 다시 확인하고 있습니다</strong>
          <p>exact commit 수집, 고정 안전 조건 검사, 서명 검증을 마칠 때까지 잠시 기다려 주세요.</p>
        </div>
      )}

      {hasExactCommit && state.phase === 'error' && (
        <div className="certification-message certification-error" role="alert">
          <strong>발급 요청을 완료하지 못했습니다</strong>
          <p>{state.error?.message}</p>
          <button type="button" className="btn-secondary no-print" onClick={requestBadge}>다시 시도</button>
        </div>
      )}

      {hasExactCommit && state.phase === 'not_issued' && (
        <div className="certification-message certification-not-issued" role="status">
          <strong>서버 재검사 결과 미발급</strong>
          <p>활성 정책의 선택 항목 또는 고정 안전 조건을 모두 통과하지 못했습니다.</p>
          {failedResults.length > 0 && (
            <ul>
              {failedResults.map((item) => (
                <li key={`${item.id}-${item.version}`}>
                  <code>{item.id}</code> — {item.result}
                  {item.summary ? ` · ${item.summary}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {issued && badge.status !== 'INVALID' && (
        <div className="certification-result" role="status">
          <a
            className="certification-showcase"
            href={state.response.verificationUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="인증마크 공개 검증 페이지 열기"
          >
            <img
              src={state.response.svgUrl}
              alt={`EduSafety 인증마크, 상태 ${statusLabel}, 커밋 ${badge.commitSha.slice(0, 7)}`}
              width="560"
              height="172"
            />
          </a>
          <div className="certification-proof-summary">
            <strong>{state.response.existing ? '기존 인증마크를 확인했습니다.' : '인증마크가 발급됐습니다.'}</strong>
            <p>커밋 <code>{badge.commitSha.slice(0, 7)}</code> · {badge.policy.name} v{badge.policy.policyVersion}</p>
            {badge.status !== 'VALID' && <p className="certification-status-note">{badge.reason}</p>}
            <a href={state.response.verificationUrl} target="_blank" rel="noopener noreferrer">공개 검증 보기</a>
          </div>
        </div>
      )}

      {issued && badge.status === 'INVALID' && (
        <div className="certification-message certification-error" role="alert">
          <strong>인증 proof 검증 실패</strong>
          <p>{badge.reason || '저장된 인증 데이터를 유효한 것으로 확인할 수 없습니다.'}</p>
          <a href={state.response.verificationUrl} target="_blank" rel="noopener noreferrer">검증 상세 보기</a>
        </div>
      )}

      <p className="certification-limit">
        특정 Git commit에 대한 정적 분석 및 선택된 심사 항목의 통과 결과입니다. 블록체인 기록 없음 · 실제 배포 서비스 전체를 보증하지 않습니다.
      </p>
    </section>
  )
}
