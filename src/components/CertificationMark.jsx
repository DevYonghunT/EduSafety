import { RUBRIC_VERSION } from '../data/rubric.js'

export const EAS_PUBLIC_PROFILE = Object.freeze({
  standard: 'EAS Offchain v2 · EIP-712',
  network: 'Base Sepolia',
  chainId: '84532',
  domainName: 'EAS Attestation',
  domainVersion: '1.2.0',
  schemaUid: '0xf58b8b212ef75ee8cd7e8d803c37c03e0519890502d5e99ee2412aae1456cafe',
  verifyingContract: '0x4200000000000000000000000000000000000021',
})

const MARK_STATES = {
  pass_candidate: {
    className: 'decision-pass',
    symbol: '✓',
    label: '필수 요건 통과',
    summary: (actions) => `권장 수정 ${actions.shouldFix}건 · 사람 확인 ${actions.confirm}건`,
  },
  hold: {
    className: 'decision-hold',
    symbol: '!',
    label: '판정 보류',
    summary: (actions) => `사람 확인 ${actions.confirm}건 · 확인 완료 전 통과로 보지 않음`,
  },
  fail_candidate: {
    className: 'decision-fail',
    symbol: '×',
    label: '필수 요건 미충족',
    summary: (actions) => `반드시 수정 ${actions.mustFix}건 · 수정 후 재심사 필요`,
  },
}

const PROOF_STATUS_LABELS = {
  VALID: 'EAS 서명 검증됨',
  STALE: '서명 유효 · 현재 HEAD 변경',
  UNVERIFIED: '서명 유효 · 현행성 확인 불가',
  EXPIRED: '전자서명 만료',
  REVOKED: '전자서명 취소',
  INVALID: '전자서명 검증 실패',
}

const HASH_32 = /^0x[0-9a-f]{64}$/i
const ADDRESS = /^0x[0-9a-f]{40}$/i
const SIGNATURE = /^0x[0-9a-f]{130}$/i
const PROOF_STATUSES = new Set(Object.keys(PROOF_STATUS_LABELS))

function fixedPoint(repoMeta) {
  if (repoMeta?.commitSha) {
    return { kind: 'Git commit', full: repoMeta.commitSha, short: repoMeta.commitSha.slice(0, 12) }
  }
  if (repoMeta?.fingerprint) {
    return { kind: 'SHA-256 콘텐츠 지문', full: repoMeta.fingerprint, short: repoMeta.fingerprint.slice(0, 12) }
  }
  return { kind: '제출물 식별값', full: '정보 없음', short: '정보 없음' }
}

function targetName(repoMeta) {
  if (repoMeta?.owner && repoMeta?.repo) return `${repoMeta.owner}/${repoMeta.repo}`
  return repoMeta?.name || '제출물'
}

function githubRepositoryKey(value) {
  try {
    const url = new URL(value)
    const segments = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean)
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || segments.length !== 2) return null
    return `${segments[0].toLowerCase()}/${segments[1].replace(/\.git$/i, '').toLowerCase()}`
  } catch {
    return null
  }
}

function safeVerificationUrl(value, uid) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    if (url.pathname !== `/verify/${uid}` || url.search || url.hash) return null
    return url.href
  } catch {
    return null
  }
}

function proofDetails(certification, repoMeta) {
  const response = certification?.phase === 'issued' ? certification.response : null
  const badge = response?.outcome === 'ISSUED' ? response.badge : null
  if (!badge) {
    return {
      hasProof: false,
      invalidProof: false,
      className: 'proof-none',
      statusLabel: 'EAS UID·서명 없음',
    }
  }

  const proof = badge?.proof
  const uid = badge?.uid
  const schemaUid = proof?.schemaUid
  const attester = badge?.attester
  const reportHash = proof?.statement?.reportHash
  const chainId = String(proof?.domain?.chainId || '')
  const verifyingContract = proof?.domain?.verifyingContract
  const expectedRepository = repoMeta?.owner && repoMeta?.repo
    ? `${String(repoMeta.owner).toLowerCase()}/${String(repoMeta.repo).toLowerCase()}`
    : null
  const repositoryId = proof?.statement?.repositoryId
  const commitSha = String(repoMeta?.commitSha || '').toLowerCase()
  const verificationUrl = safeVerificationUrl(response?.verificationUrl, uid)
  const subjectMatches = Boolean(
    expectedRepository
    && /^[0-9a-f]{40}$/i.test(commitSha)
    && githubRepositoryKey(badge?.repository?.canonicalRepositoryUrl) === expectedRepository
    && githubRepositoryKey(proof?.statement?.canonicalRepositoryUrl) === expectedRepository
    && badge?.commitSha?.toLowerCase() === commitSha
    && proof?.statement?.commitSha?.toLowerCase() === commitSha
    && Number.isSafeInteger(repositoryId)
    && repositoryId > 0
    && proof?.statement?.subjectKey === `github:${repositoryId}:${commitSha}`
  )
  const hasProof = Boolean(
    HASH_32.test(uid || '')
    && proof?.uid?.toLowerCase() === uid.toLowerCase()
    && HASH_32.test(schemaUid || '')
    && schemaUid.toLowerCase() === EAS_PUBLIC_PROFILE.schemaUid
    && HASH_32.test(reportHash || '')
    && ADDRESS.test(attester || '')
    && proof?.attester?.toLowerCase() === attester.toLowerCase()
    && SIGNATURE.test(proof?.signature || '')
    && proof?.domain?.name === EAS_PUBLIC_PROFILE.domainName
    && proof?.domain?.version === EAS_PUBLIC_PROFILE.domainVersion
    && chainId === EAS_PUBLIC_PROFILE.chainId
    && verifyingContract?.toLowerCase() === EAS_PUBLIC_PROFILE.verifyingContract
    && proof?.primaryType === 'Attest'
    && proof?.message?.version === 2
    && proof?.message?.schema?.toLowerCase() === schemaUid.toLowerCase()
    && subjectMatches
    && verificationUrl
    && badge?.integrityValid === true
    && PROOF_STATUSES.has(badge?.status),
  )

  if (!hasProof) {
    return {
      hasProof: false,
      invalidProof: true,
      className: 'proof-invalid',
      statusLabel: '전자서명 검증 실패',
      uid: HASH_32.test(uid || '') ? uid : null,
    }
  }

  const status = badge.status
  return {
    hasProof: true,
    invalidProof: false,
    className: `proof-${String(status).toLowerCase()}`,
    status,
    statusLabel: PROOF_STATUS_LABELS[status] || 'EAS 서명 상태 확인',
    uid,
    schemaUid,
    attester,
    reportHash,
    chainId,
    verifyingContract,
    issuedAt: badge.issuedAt,
    verificationUrl,
  }
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

function SealEmblem({ compact = false }) {
  return (
    <span className={compact ? 'seal-emblem seal-emblem-compact' : 'seal-emblem'} aria-hidden="true">
      <svg viewBox="0 0 48 48" role="presentation">
        <path d="M24 5 39 10v11c0 10-6 17-15 22C15 38 9 31 9 21V10l15-5Z" />
        <path d="M17 23h14M17 17h14M20 29h8" />
      </svg>
      {!compact && <span>EDUSAFETY</span>}
    </span>
  )
}

export function PrintPageProof({ repoMeta, certification }) {
  const point = fixedPoint(repoMeta)
  const proof = proofDetails(certification, repoMeta)
  const hasSignedProof = proof.hasProof && proof.status !== 'INVALID'
  const pageState = hasSignedProof ? `EAS ${proof.status}` : proof.invalidProof ? 'EAS INVALID' : 'UNSIGNED'
  const label = hasSignedProof
    ? `EAS UID ${proof.uid.slice(0, 12)}…${proof.uid.slice(-8)} · ${proof.status}`
    : `${point.kind} ${point.short}`

  return (
    <div className={`report-page-proof page-proof-${pageState.toLowerCase().replace(' ', '-')}`} aria-hidden="true">
      <span><SealEmblem compact /> EDUSAFETY REPORT · {pageState}</span>
      <code>{label}</code>
    </div>
  )
}

function ProofInformation({ proof, point }) {
  if (!proof.hasProof) {
    return (
      <div className="certification-proof" aria-labelledby="proof-information-title">
        <div className="certification-proof-heading">
          <h4 id="proof-information-title">문서 식별·서명 연계 정보</h4>
          <span className={`proof-status ${proof.invalidProof ? 'proof-status-invalid' : 'proof-status-none'}`}>
            {proof.statusLabel}
          </span>
        </div>
        <dl className="certification-proof-list">
          <div><dt>문서 기준</dt><dd><code>{point.kind} {point.full}</code></dd></div>
          <div><dt>서명 상태</dt><dd>{proof.invalidProof ? '제공된 EAS proof의 무결성을 확인하지 못함' : '이 보고서에는 EAS UID와 전자서명이 생성되지 않음'}</dd></div>
          <div><dt>연계 규격</dt><dd>{EAS_PUBLIC_PROFILE.standard} 지원</dd></div>
          <div><dt>연계 기준</dt><dd>{EAS_PUBLIC_PROFILE.network} · Chain ID {EAS_PUBLIC_PROFILE.chainId}</dd></div>
        </dl>
      </div>
    )
  }

  return (
    <div className="certification-proof" aria-labelledby="proof-information-title">
      <div className="certification-proof-heading">
        <h4 id="proof-information-title">EAS Offchain v2 서명 정보</h4>
        <span className={`proof-status ${proof.status === 'VALID' ? 'proof-status-valid' : 'proof-status-caution'}`}>
          {proof.statusLabel}
        </span>
      </div>
      <dl className="certification-proof-list">
        <div><dt>Attestation UID</dt><dd><code>{proof.uid}</code></dd></div>
        <div><dt>분석 snapshot</dt><dd><code>{proof.reportHash}</code><small>서버 분석 snapshot 해시 · 이 PDF 파일 해시가 아님</small></dd></div>
        <div><dt>발급자</dt><dd><code>{proof.attester}</code></dd></div>
        <div><dt>서명 도메인</dt><dd>Chain ID {proof.chainId} · <code>{proof.verifyingContract}</code></dd></div>
        <div><dt>Schema UID</dt><dd><code>{proof.schemaUid}</code></dd></div>
        <div><dt>발급 시각</dt><dd>{proof.issuedAt || '정보 없음'}</dd></div>
      </dl>
      {proof.verificationUrl && (
        <a className="certification-proof-link" href={proof.verificationUrl} target="_blank" rel="noopener noreferrer">
          EAS 전자서명 검증 정보 보기
        </a>
      )}
    </div>
  )
}

export default function CertificationMark({ repoMeta, summary, certification }) {
  const mark = reportStatusMark(repoMeta, summary)
  const proof = proofDetails(certification, repoMeta)
  const signed = proof.hasProof && proof.status !== 'INVALID'
  const invalid = proof.invalidProof || proof.status === 'INVALID'

  return (
    <section
      className={`certification-mark ${mark.className} ${proof.className}`}
      aria-labelledby="report-status-mark-title"
    >
      <header className="certification-mark-head">
        <SealEmblem />
        <div className="certification-title-copy">
          <p className="certification-eyebrow">{signed ? 'EDUSAFETY SIGNED REVIEW RECORD' : 'EDUSAFETY REVIEW RECORD'}</p>
          <h3 id="report-status-mark-title">{signed ? '에듀 세이프 서명 심사 기록' : '에듀 세이프 심사 기록 확인'}</h3>
          <p>{invalid ? '연결된 전자서명의 무결성을 확인하지 못했습니다.' : '에듀 세이프 심사 절차로 이 고정 제출물을 검토한 기록입니다.'}</p>
        </div>
        <span className="certification-state">{mark.label}</span>
      </header>

      <div className="certification-content-grid">
        <div className="certification-decision">
          <p className="certification-section-label">심사 판정 · 루브릭 {RUBRIC_VERSION}</p>
          <div className="report-mark-body">
            <span className="report-mark-symbol" aria-hidden="true">{mark.symbol}</span>
            <div className="report-mark-copy">
              <strong>{mark.label}</strong>
              <p>{mark.detail}</p>
              <p className="report-mark-subject"><span>{mark.target}</span> · <code>{mark.fixedPoint.kind} {mark.fixedPoint.short}</code></p>
            </div>
          </div>
        </div>

        <ProofInformation proof={proof} point={mark.fixedPoint} />
      </div>

      <p className="certification-limit">
        이 마크는 에듀 세이프 형식으로 생성된 심사 기록과 고정 제출물의 판정 요약을 표시합니다.
        {' '}EAS UID가 함께 표시된 경우에만 전자서명 검증이 가능하며, 페이지 상단 UID는 같은 증명을 가리키는 참조값이지 각 페이지의 개별 서명이 아닙니다.
        {' '}EAS Offchain v2는 온체인 거래나 정부·공공기관 인증을 의미하지 않습니다.
      </p>
    </section>
  )
}
