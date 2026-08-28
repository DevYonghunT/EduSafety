import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import CertificationMark, { reportStatusMark } from '../src/components/CertificationMark.jsx'
import ReviewReport from '../src/components/ReviewReport.jsx'

const COMMIT_SHA = '3ed41cb2c8329d5d47e276c3018a0c6c9f6a0878'
const repoMeta = { owner: 'DevYonghunT', repo: 'All-Ai-Tutor', branch: 'main', commitSha: COMMIT_SHA }

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
    expect(html).toContain('certification-mark certification-attention')
    expect(html).not.toContain('print-only')
    expect(html.match(/class="certification-mark /g)).toHaveLength(1)
    expect(html).not.toContain('활성 인증 정책')
    expect(html).not.toContain('인증마크 없이 출력')
    expect(html).not.toContain('발급 요청')
    expect(html.indexOf('에듀 세이프 심사 상태마크')).toBeGreaterThan(html.indexOf('판정표'))
    expect(html.indexOf('에듀 세이프 심사 상태마크')).toBeLessThan(html.indexOf('심사 확인'))
  })

  it.each([
    ['pass_candidate', { shouldFix: 2 }, 'certification-issued', '필수 요건 통과', '권장 수정 2건'],
    ['hold', { confirm: 15 }, 'certification-attention', '판정 보류', '사람 확인 15건'],
    ['fail_candidate', { mustFix: 3 }, 'certification-invalid', '필수 요건 미충족', '반드시 수정 3건'],
  ])('%s 상태를 색상뿐 아니라 문구와 건수로 구분한다', (status, actions, className, label, detail) => {
    const html = renderToStaticMarkup(createElement(CertificationMark, {
      repoMeta,
      summary: summary(status, actions),
    }))

    expect(html).toContain(`certification-mark ${className}`)
    expect(html).toContain(label)
    expect(html).toContain(detail)
  })

  it('GitHub 보고서는 저장소와 고정 커밋을 표시한다', () => {
    expect(reportStatusMark(repoMeta, summary('pass_candidate'))).toMatchObject({
      target: 'DevYonghunT/All-Ai-Tutor',
      fixedPoint: '커밋 3ed41cb2c832',
    })
  })

  it('폴더 제출 보고서도 콘텐츠 지문에 고정된 상태마크를 출력한다', () => {
    const folderMeta = { source: 'folder', name: '수업 앱', fingerprint: 'a'.repeat(64) }
    const html = renderToStaticMarkup(createElement(ReviewReport, reportProps({ repoMeta: folderMeta })))

    expect(html).toContain('🖨️ 인쇄 / PDF 저장')
    expect(html).toContain('수업 앱')
    expect(html).toContain('콘텐츠 지문 aaaaaaaaaaaa')
  })

  it('서버 발급·검증 증명서로 오해할 표현이나 링크를 넣지 않는다', () => {
    const html = renderToStaticMarkup(createElement(CertificationMark, {
      repoMeta,
      summary: summary('hold', { confirm: 1 }),
    }))

    expect(html).toContain('별도로 발급되거나 검증되는 증명서가 아닙니다.')
    expect(html).not.toContain('EAS')
    expect(html).not.toContain('UID')
    expect(html).not.toContain('href=')
    expect(html).not.toContain('전체 항목 통과')
  })
})
