import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import CertificationMark, {
  certificationSubject,
  printableCertification,
} from '../src/components/CertificationMark.jsx'
import ReviewReport from '../src/components/ReviewReport.jsx'

const COMMIT_SHA = '3ed41cb2c8329d5d47e276c3018a0c6c9f6a0878'
const repoMeta = { owner: 'DevYonghunT', repo: 'All-Ai-Tutor', branch: 'main', commitSha: COMMIT_SHA }
const subjectKey = `https://github.com/DevYonghunT/All-Ai-Tutor\0${COMMIT_SHA}`
const actions = { mustFix: 0, shouldFix: 0, confirm: 0 }

function issuedCertification(overrides = {}) {
  return {
    phase: 'issued',
    subjectKey,
    response: {
      outcome: 'ISSUED',
      existing: false,
      verificationUrl: `https://edusafety.example/verify/0x${'a'.repeat(64)}`,
      svgUrl: `https://edusafety.example/api/badges/0x${'a'.repeat(64)}.svg?variant=showcase`,
      badge: {
        uid: `0x${'a'.repeat(64)}`,
        status: 'VALID',
        commitSha: COMMIT_SHA,
        policy: { name: 'EduSafety 고정 기준', policyVersion: 3 },
      },
    },
    ...overrides,
  }
}

function reportProps(overrides = {}) {
  return {
    repoMeta,
    track: 'subject_tool',
    protectionLevel: 'L0',
    appSummary: '',
    summary: { status: 'hold', actions, categoryStates: {}, items: [] },
    judgments: {},
    overrides: {},
    humanInputs: {},
    coverage: null,
    gate: null,
    model: '',
    aiUsed: false,
    certification: { phase: 'idle' },
    onCertificationChange: () => {},
    ...overrides,
  }
}

describe('보고서 출력 인증마크', () => {
  it('exact GitHub commit을 정규화된 출력 subject로 만든다', () => {
    expect(certificationSubject(repoMeta)).toEqual({
      repositoryUrl: 'https://github.com/DevYonghunT/All-Ai-Tutor',
      commitSha: COMMIT_SHA,
      subjectKey,
    })
    expect(certificationSubject({ source: 'folder', fingerprint: 'a'.repeat(64) })).toBeNull()
  })

  it('발급 전에는 보고서 본문에 인증 카드나 항목별 발급 메뉴를 표시하지 않는다', () => {
    const html = renderToStaticMarkup(createElement(ReviewReport, reportProps()))

    expect(html).toContain('인증마크 포함 인쇄 / PDF 저장')
    expect(html).not.toContain('인증마크 발급 요청')
    expect(html).not.toContain('class="certification-mark')
    expect(html).not.toContain('선택 항목')
  })

  it('인쇄 시 재검증된 발급 결과는 출력 전용 영역으로 렌더한다', () => {
    const certification = issuedCertification()
    const html = renderToStaticMarkup(createElement(CertificationMark, { repoMeta, certification }))

    expect(html).toContain('certification-mark certification-issued print-only')
    expect(html).toContain('이 보고서 출력 시점에 확인된 인증마크입니다.')
    expect(html).toContain('EduSafety 고정 기준 v3')
    expect(html).toContain('variant=showcase')
    expect(html).toContain(`href="${certification.response.verificationUrl}"`)
  })

  it('화면에 캐시된 과거 발급 결과는 인쇄 재검증 전까지 출력 영역에 재사용하지 않는다', () => {
    const html = renderToStaticMarkup(createElement(ReviewReport, reportProps({
      certification: issuedCertification(),
    })))

    expect(html).not.toContain('class="certification-mark')
    expect(html).toContain('인증마크 포함 인쇄 / PDF 저장')
  })

  it('다른 저장소의 결과와 INVALID proof는 출력하지 않는다', () => {
    const otherSubject = issuedCertification({
      subjectKey: `https://github.com/other/repository\0${'f'.repeat(40)}`,
    })
    expect(printableCertification(repoMeta, otherSubject)).toBeNull()

    const invalid = issuedCertification({
      response: {
        ...issuedCertification().response,
        badge: { ...issuedCertification().response.badge, status: 'INVALID' },
      },
    })
    expect(printableCertification(repoMeta, invalid)).toBeNull()
    expect(renderToStaticMarkup(createElement(CertificationMark, { repoMeta, certification: invalid }))).toBe('')
  })

  it('폴더 제출 보고서는 인증마크 없이 출력된다는 점을 알린다', () => {
    const folderMeta = { source: 'folder', name: '수업 앱', fingerprint: 'a'.repeat(64) }
    const html = renderToStaticMarkup(createElement(ReviewReport, reportProps({ repoMeta: folderMeta })))

    expect(html).toContain('🖨️ 인쇄 / PDF 저장')
    expect(html).toContain('인증마크 없이 출력됩니다.')
    expect(html).not.toContain('인증마크 포함 인쇄')
  })

  it('인증마크 한계 문구는 고정 전체 기준과 오프체인 범위를 정확히 설명한다', () => {
    const html = renderToStaticMarkup(createElement(CertificationMark, {
      repoMeta,
      certification: issuedCertification(),
    }))

    expect(html).toContain('서버의 고정 심사 기준')
    expect(html).toContain('블록체인에 기록되지 않으며')
    expect(html).not.toContain('선택된 심사 항목')
  })
})
