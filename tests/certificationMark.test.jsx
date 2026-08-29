import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import CertificationMark, { EAS_PUBLIC_PROFILE, reportStatusMark } from '../src/components/CertificationMark.jsx'
import ReviewReport from '../src/components/ReviewReport.jsx'

const COMMIT_SHA = '3ed41cb2c8329d5d47e276c3018a0c6c9f6a0878'
const UID = `0x${'a'.repeat(64)}`
const REPORT_HASH = `0x${'b'.repeat(64)}`
const REPOSITORY_ID = 123456
const CANONICAL_REPOSITORY_URL = 'https://github.com/DevYonghunT/All-Ai-Tutor'
const ATTESTER = `0x${'c'.repeat(40)}`
const repoMeta = { owner: 'DevYonghunT', repo: 'All-Ai-Tutor', branch: 'main', commitSha: COMMIT_SHA }

const issuedCertification = {
  phase: 'issued',
  response: {
    outcome: 'ISSUED',
    verificationUrl: `https://edusafety.example/verify/${UID}`,
    badge: {
      uid: UID,
      status: 'VALID',
      integrityValid: true,
      attester: ATTESTER,
      commitSha: COMMIT_SHA,
      repository: {
        repositoryId: REPOSITORY_ID,
        canonicalRepositoryUrl: CANONICAL_REPOSITORY_URL,
      },
      issuedAt: '2026-08-29T01:00:00.000Z',
      proof: {
        uid: UID,
        attester: ATTESTER,
        signature: `0x${'d'.repeat(130)}`,
        primaryType: 'Attest',
        schemaUid: EAS_PUBLIC_PROFILE.schemaUid,
        statement: {
          subjectKey: `github:${REPOSITORY_ID}:${COMMIT_SHA}`,
          repositoryId: REPOSITORY_ID,
          canonicalRepositoryUrl: CANONICAL_REPOSITORY_URL,
          commitSha: COMMIT_SHA,
          reportHash: REPORT_HASH,
        },
        domain: {
          name: EAS_PUBLIC_PROFILE.domainName,
          version: EAS_PUBLIC_PROFILE.domainVersion,
          chainId: EAS_PUBLIC_PROFILE.chainId,
          verifyingContract: EAS_PUBLIC_PROFILE.verifyingContract,
        },
        message: {
          version: 2,
          schema: EAS_PUBLIC_PROFILE.schemaUid,
        },
      },
    },
  },
}

function summary(status, actions = {}) {
  return {
    status,
    actions: { mustFix: 0, shouldFix: 0, confirm: 0, ...actions },
    categoryStates: {},
    items: [],
  }
}

function reportProps(overrides = {}) {
  return {
    repoMeta,
    features: {},
    protectionLevel: 'L0',
    appSummary: '',
    summary: summary('hold', { confirm: 15 }),
    judgments: {},
    overrides: {},
    humanInputs: {},
    coverage: null,
    gate: null,
    model: '',
    aiUsed: false,
    ...overrides,
  }
}

describe('보고서 출력 심사 상태마크', () => {
  it('④ 보고서 화면에 서버 정책 조회 없이 상태마크를 바로 표시한다', () => {
    const html = renderToStaticMarkup(createElement(ReviewReport, reportProps()))

    expect(html).toContain('🖨️ 인쇄 / PDF 저장')
    expect(html).toContain('certification-mark decision-hold proof-none')
    expect(html).toContain('class="report-page-proof page-proof-unsigned"')
    expect(html.match(/class="certification-mark /g)).toHaveLength(1)
    expect(html.match(/class="report-page-proof /g)).toHaveLength(1)
    expect(html).not.toContain('활성 인증 정책')
    expect(html).not.toContain('인증마크 없이 출력')
    expect(html).not.toContain('발급 요청')
    expect(html.indexOf('에듀 세이프 심사 기록 확인')).toBeGreaterThan(html.indexOf('판정표'))
    expect(html.indexOf('에듀 세이프 심사 기록 확인')).toBeLessThan(html.indexOf('심사 확인'))
  })

  it.each([
    ['pass_candidate', { shouldFix: 2 }, 'decision-pass', '필수 요건 통과', '권장 수정 2건'],
    ['hold', { confirm: 15 }, 'decision-hold', '판정 보류', '사람 확인 15건'],
    ['fail_candidate', { mustFix: 3 }, 'decision-fail', '필수 요건 미충족', '반드시 수정 3건'],
  ])('%s 상태를 색상뿐 아니라 문구와 건수로 구분한다', (status, actions, className, label, detail) => {
    const html = renderToStaticMarkup(createElement(CertificationMark, {
      repoMeta,
      summary: summary(status, actions),
    }))

    expect(html).toContain(`certification-mark ${className} proof-none`)
    expect(html).toContain(label)
    expect(html).toContain(detail)
  })

  it('GitHub 보고서는 저장소와 고정 커밋을 표시한다', () => {
    expect(reportStatusMark(repoMeta, summary('pass_candidate'))).toMatchObject({
      target: 'DevYonghunT/All-Ai-Tutor',
      fixedPoint: {
        kind: 'Git commit',
        full: COMMIT_SHA,
        short: '3ed41cb2c832',
      },
    })
  })

  it('폴더 제출 보고서도 콘텐츠 지문에 고정된 상태마크를 출력한다', () => {
    const folderMeta = { source: 'folder', name: '수업 앱', fingerprint: 'a'.repeat(64) }
    const html = renderToStaticMarkup(createElement(ReviewReport, reportProps({ repoMeta: folderMeta })))

    expect(html).toContain('🖨️ 인쇄 / PDF 저장')
    expect(html).toContain('수업 앱')
    expect(html).toContain('콘텐츠 지문 aaaaaaaaaaaa')
  })

  it('미서명 보고서는 EAS 규격과 실제 발급 상태를 구분한다', () => {
    const html = renderToStaticMarkup(createElement(CertificationMark, {
      repoMeta,
      summary: summary('hold', { confirm: 1 }),
    }))

    expect(html).toContain('문서 식별·서명 연계 정보')
    expect(html).toContain('EAS Offchain v2 · EIP-712')
    expect(html).toContain('EAS UID·서명 없음')
    expect(html).toContain('EAS Offchain v2는 온체인 거래나 정부·공공기관 인증을 의미하지 않습니다.')
    expect(html).toContain('EDUSAFETY REVIEW RECORD')
    expect(html).not.toContain('EDUSAFETY SIGNED REVIEW RECORD')
    expect(html).not.toContain('EAS 서명 검증됨')
    expect(html).not.toContain('href=')
    expect(html).not.toContain('전체 항목 통과')
  })

  it('검증된 EAS proof가 있으면 상세 정보와 페이지별 UID 참조를 표시한다', () => {
    const html = renderToStaticMarkup(createElement(ReviewReport, reportProps({
      certification: issuedCertification,
      summary: summary('pass_candidate'),
    })))

    expect(html).toContain('EAS Offchain v2 서명 정보')
    expect(html).toContain('EAS 서명 검증됨')
    expect(html).toContain(UID)
    expect(html).toContain(REPORT_HASH)
    expect(html).toContain('이 PDF 파일 해시가 아님')
    expect(html).toContain(`href="https://edusafety.example/verify/${UID}"`)
    expect(html).toContain(`EAS UID ${UID.slice(0, 12)}…${UID.slice(-8)} · VALID`)
    expect(html).toContain('EDUSAFETY REPORT · EAS VALID')
  })

  it('다른 저장소나 commit의 proof를 현재 보고서에 붙이면 검증 실패로 표시한다', () => {
    const mismatched = structuredClone(issuedCertification)
    mismatched.response.badge.commitSha = '0'.repeat(40)
    const html = renderToStaticMarkup(createElement(ReviewReport, reportProps({
      certification: mismatched,
    })))

    expect(html).toContain('proof-invalid')
    expect(html).toContain('전자서명 검증 실패')
    expect(html).toContain('EDUSAFETY REPORT · EAS INVALID')
    expect(html).not.toContain('EAS 서명 검증됨')
  })
})
