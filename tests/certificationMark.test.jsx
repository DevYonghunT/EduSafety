import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import CertificationMark from '../src/components/CertificationMark.jsx'
import ReviewReport from '../src/components/ReviewReport.jsx'

const COMMIT_SHA = '3ed41cb2c8329d5d47e276c3018a0c6c9f6a0878'
const repoMeta = { owner: 'DevYonghunT', repo: 'All-Ai-Tutor', branch: 'main', commitSha: COMMIT_SHA }
const actions = { mustFix: 0, shouldFix: 0, confirm: 0 }

function renderMark(summary, certification = { phase: 'idle' }, meta = repoMeta) {
  return renderToStaticMarkup(createElement(CertificationMark, {
    repoMeta: meta,
    summary,
    certification,
    onCertificationChange: () => {},
  }))
}

describe('최종 보고서 인증마크', () => {
  it('보류 판정은 참고로만 표시하고 발급 여부는 서버 재검사에 맡긴다', () => {
    const html = renderMark({ status: 'hold', actions: { ...actions, confirm: 15 } })

    expect(html).toContain('현재 보고서 판정은 보류입니다.')
    expect(html).toContain('사람 확인이 필요한 항목 15건은 참고 정보')
    expect(html).toContain('인증마크 발급 요청')
    expect(html).not.toContain('<img')
  })

  it('통과 후보 보고서에는 명시적인 서버 재검사 버튼을 표시한다', () => {
    const html = renderMark({ status: 'pass_candidate', actions })

    expect(html).toContain('서버 재검사 후 발급')
    expect(html).toContain('인증마크 발급 요청')
    expect(html).toContain('화면의 판정값은 전송하지 않습니다')
  })

  it('폴더 제출에는 GitHub exact commit 안내만 표시한다', () => {
    const html = renderMark(
      { status: 'pass_candidate', actions },
      { phase: 'idle' },
      { source: 'folder', name: '수업 앱', fingerprint: 'a'.repeat(64) },
    )

    expect(html).toContain('GitHub exact commit 필요')
    expect(html).not.toContain('인증마크 발급 요청')
  })

  it('발급 결과를 클릭 가능한 showcase와 정책·commit 정보로 표시한다', () => {
    const html = renderMark({ status: 'pass_candidate', actions }, {
      phase: 'issued',
      response: {
        outcome: 'ISSUED',
        existing: false,
        verificationUrl: 'https://edusafety.example/verify/uid',
        svgUrl: 'https://edusafety.example/api/badges/uid.svg?variant=showcase',
        badge: {
          uid: `0x${'a'.repeat(64)}`,
          status: 'VALID',
          commitSha: COMMIT_SHA,
          policy: { name: '교사 앱 안전 기준', policyVersion: 3 },
        },
      },
    })

    expect(html).toContain('인증마크가 발급됐습니다.')
    expect(html).toContain('href="https://edusafety.example/verify/uid"')
    expect(html).toContain('src="https://edusafety.example/api/badges/uid.svg?variant=showcase"')
    expect(html).toContain('3ed41cb')
    expect(html).toContain('교사 앱 안전 기준 v3')
  })

  it('서버가 발급한 결과는 비권위 클라이언트 종합판정과 무관하게 표시한다', () => {
    const html = renderMark({ status: 'hold', actions: { ...actions, confirm: 15 } }, {
      phase: 'issued',
      response: {
        outcome: 'ISSUED',
        existing: false,
        verificationUrl: 'https://edusafety.example/verify/uid',
        svgUrl: 'https://edusafety.example/api/badges/uid.svg?variant=showcase',
        badge: {
          uid: `0x${'a'.repeat(64)}`,
          status: 'VALID',
          commitSha: COMMIT_SHA,
          policy: { name: '서버 활성 정책', policyVersion: 2 },
        },
      },
    })

    expect(html).toContain('<img')
    expect(html).toContain('서버 활성 정책 v2')
    expect(html).not.toContain('현재 보고서 판정은 보류입니다.')
  })

  it('검증 실패 상태는 정상 showcase처럼 표시하지 않는다', () => {
    const html = renderMark({ status: 'pass_candidate', actions }, {
      phase: 'issued',
      response: {
        outcome: 'ISSUED',
        existing: true,
        verificationUrl: 'https://edusafety.example/verify/uid',
        svgUrl: 'https://edusafety.example/api/badges/uid.svg?variant=showcase',
        badge: {
          uid: `0x${'a'.repeat(64)}`,
          status: 'INVALID',
          reason: '서명 snapshot이 일치하지 않습니다.',
          commitSha: COMMIT_SHA,
          policy: { name: '교사 앱 안전 기준', policyVersion: 3 },
        },
      },
    })

    expect(html).toContain('인증 proof 검증 실패')
    expect(html).toContain('서명 snapshot이 일치하지 않습니다.')
    expect(html).not.toContain('<img')
  })

  it('서버 미발급 사유에서 일반 항목과 고정 안전 조건을 구분해 노출한다', () => {
    const html = renderMark({ status: 'pass_candidate', actions }, {
      phase: 'not_issued',
      response: {
        outcome: 'NOT_ISSUED',
        criteria: [{ criterionId: 'secure-config-baseline', criterionVersion: '1', result: 'FAIL', summary: '위험 기본값 발견' }],
        safetyBlockers: [{ blockerId: 'coverage_incomplete', version: '1', triggered: true, summary: '수집 불완전' }],
      },
    })

    expect(html).toContain('서버 재검사 결과 미발급')
    expect(html).toContain('certification-mark certification-attention')
    expect(html).toContain('class="certification-state">미발급')
    expect(html).toContain('secure-config-baseline')
    expect(html).toContain('coverage_incomplete')
    expect(html).not.toContain('<img')
  })

  it('종합 판정과 카테고리 프로필 사이에 인증마크를 배치한다', () => {
    const summary = { status: 'hold', actions: { ...actions, confirm: 2 }, categoryStates: {}, items: [] }
    const html = renderToStaticMarkup(createElement(ReviewReport, {
      repoMeta,
      track: 'subject_tool',
      protectionLevel: 'L0',
      appSummary: '',
      summary,
      judgments: {},
      overrides: {},
      humanInputs: {},
      coverage: null,
      gate: null,
      model: '',
      aiUsed: false,
      certification: { phase: 'idle' },
      onCertificationChange: () => {},
    }))

    expect(html.indexOf('class="report-status"')).toBeLessThan(html.indexOf('class="certification-mark'))
    expect(html.indexOf('class="certification-mark')).toBeLessThan(html.indexOf('카테고리별 상태 프로필'))
  })

  it('다른 저장소 subject에 속한 이전 발급 결과를 표시하지 않는다', () => {
    const html = renderMark({ status: 'pass_candidate', actions }, {
      phase: 'issued',
      subjectKey: `https://github.com/other/repository\0${'f'.repeat(40)}`,
      response: {
        outcome: 'ISSUED',
        verificationUrl: 'https://edusafety.example/verify/old',
        svgUrl: 'https://edusafety.example/api/badges/old.svg?variant=showcase',
        badge: {
          status: 'VALID',
          commitSha: 'f'.repeat(40),
          policy: { name: '이전 정책', policyVersion: 1 },
        },
      },
    })

    expect(html).toContain('인증마크 발급 요청')
    expect(html).not.toContain('/verify/old')
    expect(html).not.toContain('<img')
  })

  it('동적 상태를 중첩 live region 없이 한 번만 알린다', () => {
    const html = renderMark({ status: 'pass_candidate', actions }, {
      phase: 'not_issued',
      response: { outcome: 'NOT_ISSUED', criteria: [], safetyBlockers: [] },
    })

    expect(html).not.toContain('aria-live=')
    expect((html.match(/role="status"/g) || [])).toHaveLength(1)
  })
})
