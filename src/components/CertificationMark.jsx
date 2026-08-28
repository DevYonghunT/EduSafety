const BADGE_STATUS_LABELS = {
  VALID: '유효',
  STALE: '현재 HEAD 변경',
  UNVERIFIED: '현재 상태 확인 불가',
  EXPIRED: '만료',
  REVOKED: '취소',
}

const COMMIT_SHA = /^[0-9a-f]{40}$/i

function repositoryUrl(repoMeta) {
  if (!repoMeta?.owner || !repoMeta?.repo) return null
  return `https://github.com/${repoMeta.owner}/${repoMeta.repo}`
}

export function certificationSubject(repoMeta) {
  const githubUrl = repositoryUrl(repoMeta)
  if (!githubUrl || !COMMIT_SHA.test(repoMeta?.commitSha || '')) return null
  return {
    repositoryUrl: githubUrl,
    commitSha: repoMeta.commitSha.toLowerCase(),
    subjectKey: `${githubUrl}\0${repoMeta.commitSha.toLowerCase()}`,
  }
}

export function printableCertification(repoMeta, certification) {
  const subject = certificationSubject(repoMeta)
  if (!subject || certification?.subjectKey !== subject.subjectKey) return null
  if (certification.phase !== 'issued' || certification.response?.outcome !== 'ISSUED') return null
  if (certification.response.badge?.status === 'INVALID') return null
  return certification.response
}

export default function CertificationMark({ repoMeta, certification }) {
  const response = printableCertification(repoMeta, certification)
  if (!response) return null

  const badge = response.badge
  const statusLabel = BADGE_STATUS_LABELS[badge.status] || badge.status

  return (
    <section className="certification-mark certification-issued print-only" aria-label="보고서 인증마크">
      <div className="certification-mark-head">
        <div>
          <h3>인증마크</h3>
          <p className="certification-kind">EAS Offchain v2 기반 가스리스 서명 인증마크</p>
        </div>
        <span className="certification-state">{statusLabel}</span>
      </div>
      <div className="certification-result">
        <a
          className="certification-showcase"
          href={response.verificationUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="인증마크 공개 검증 페이지 열기"
        >
          <img
            src={response.svgUrl}
            alt={`EduSafety 인증마크, 상태 ${statusLabel}, 커밋 ${badge.commitSha.slice(0, 7)}`}
            width="560"
            height="172"
          />
        </a>
        <div className="certification-proof-summary">
          <strong>이 보고서 출력 시점에 확인된 인증마크입니다.</strong>
          <p>커밋 <code>{badge.commitSha.slice(0, 7)}</code> · {badge.policy.name} v{badge.policy.policyVersion}</p>
          {badge.status !== 'VALID' && <p className="certification-status-note">{badge.reason}</p>}
          <a href={response.verificationUrl} target="_blank" rel="noopener noreferrer">공개 검증 보기</a>
        </div>
      </div>
      <p className="certification-limit">
        특정 Git commit을 서버의 고정 심사 기준으로 정적 분석한 결과입니다. 블록체인에 기록되지 않으며 실제 배포 서비스 전체를 보증하지 않습니다.
      </p>
    </section>
  )
}
