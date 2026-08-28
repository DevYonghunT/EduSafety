import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  renderHtml, renderMarkdown, recomputeSummary, validateReport, loadContract,
  escapeHtml, escapeAttr, escapeUrl, moeStatusFor, MOE_DISCLAIMER, TRUST_BOUNDARY,
} from '../edusafe/scripts/render.mjs'
import { validReport, QUOTE } from './helpers/valid-report.mjs'

const items = JSON.parse(readFileSync('edusafe/rules/items.json', 'utf8')).items
const categories = JSON.parse(readFileSync('edusafe/rules/items.json', 'utf8')).categories
const contract = loadContract()
const TEMPLATE = readFileSync('edusafe/templates/report.html', 'utf8')
const SUBCHECK_TOTAL = items.reduce((n, i) => n + i.subchecks.length, 0)
const MASKED = 'AIzaSy****'

const render = (r) => renderHtml(r, items, TEMPLATE)

function mixedReport() {
  const r = validReport()
  const set = (id, patch) => {
    const it = r.items.find((i) => i.item_id === id)
    Object.assign(it, patch)
    it.subchecks.forEach((s, i) => {
      const lead = i === 0
      s.verdict = lead ? patch.verdict : 'na'
      s.verification_level = lead ? patch.verification_level : 'none'
      s.sources = lead ? [...(patch.sources || [])] : []
      s.evidence = lead && (patch.verdict === 'pass' || patch.verdict === 'fail') ? [patch.evidence[0]] : []
      s.reason = lead && patch.verdict === 'needs_human' ? (patch.demotion_reason || null) : null
    })
  }
  const shared = { ...QUOTE, file: 'src/app.js', line: 3, quote: `const k = '${MASKED}'` }
  set('R-secrets', { verdict: 'fail', verification_level: 'verified', sources: ['scanner'], applicability_reason: null, evidence: [shared] })
  // 같은 근거를 두 항목이 인용한다 (REQ-7.13 중복 접기)
  set('R-admin-data', { verdict: 'fail', verification_level: 'verified', sources: ['scanner'], applicability_reason: null, evidence: [shared] })
  set('S-tracking', { verdict: 'fail', verification_level: 'verified', sources: ['scanner'], applicability_reason: null, effective_severity: 'low', evidence: [QUOTE] })
  set('S-name-exposure', { verdict: 'fail', verification_level: 'verified', sources: ['code'], applicability_reason: null, effective_severity: 'medium', evidence: [QUOTE] })
  set('H-2fa', { verdict: 'pass', verification_level: 'attested', sources: ['teacher'], applicability_reason: null, evidence: [QUOTE] })
  set('S-data-region', { verdict: 'needs_human', verification_level: 'none', sources: [], applicability_reason: null, demotion_reason: 'coverage-insufficient' })
  r.summary = { ...recomputeSummary(r.items), documentation_hits: 3 }
  for (const row of r.moe_checklist) row.status = moeStatusFor(row.mapped_items, r.items)
  return r
}

describe('renderHtml (REQ-8.16 ~ REQ-8.19)', () => {
  const report = mixedReport()
  const html = render(report)

  it('렌더 대상 보고서가 계약을 통과한다', () => {
    expect(validateReport(report, items, contract)).toEqual([])
  })

  it('1. script 태그가 결과 HTML 에 없다 (JS 없음)', () => {
    expect(html).not.toContain('<script')
    expect(html.toLowerCase()).not.toContain('javascript:')
    // 태그 안의 on* 인라인 핸들러가 없다 (본문 글자로 남은 것은 무해하므로 태그 안만 본다)
    expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i)
  })

  it('2. CSP 메타가 spec 이 정한 값 그대로 들어 있다', () => {
    expect(html).toContain(
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">',
    )
  })

  it('3. 인용의 위험한 문자가 컨텍스트별로 이스케이프된다', () => {
    const r = validReport()
    r.items[0].evidence = [{ ...QUOTE, quote: '</script><img src=x onerror=alert(1)>"\'&' }]
    const out = render(r)
    // 태그로 해석될 수 있는 형태가 남지 않았는지 본다.
    // 이스케이프된 "글자"에 onerror= 가 남는 것은 정상이다 — 태그가 아니라 본문이다.
    expect(out).not.toContain('</script>')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;')
    expect(out).toContain('&quot;&#39;&amp;')
  })

  it('3. 파일 경로에 태그를 넣어도 속성·본문이 깨지지 않는다', () => {
    const r = validReport()
    r.items[0].evidence = [{ ...QUOTE, file: '"><b>깨짐</b>' }]
    const out = render(r)
    expect(out).not.toContain('<b>깨짐</b>')
    expect(out).toContain('&lt;b&gt;')
  })

  it('4. 보고서 JSON 이 HTML 에 통째로 내장돼 있지 않다 (REQ-8.19)', () => {
    expect(html).not.toContain('"schema_version"')
    expect(html).not.toContain(JSON.stringify(report).slice(0, 60))
  })

  it('5. 마스킹된 값이 마스킹된 채로 나온다', () => {
    expect(html).toContain(MASKED)
    expect(html).not.toContain('AIzaSyD1234567890')
  })

  it(`6. 항목 37개와 하위 점검 ${SUBCHECK_TOTAL}개가 전부 나온다`, () => {
    const missingItems = items.filter((i) => !html.includes(`id="item-${i.id}"`))
    expect(missingItems.map((i) => i.id), 'HTML 에 빠진 항목').toEqual([])
    const missingSubs = []
    for (const it of items) for (const s of it.subchecks) if (!html.includes(s.id)) missingSubs.push(`${it.id}.${s.id}`)
    expect(missingSubs, 'HTML 에 빠진 하위 점검').toEqual([])
  })

  it('7. db_paths 의 controls 5축이 표의 5열로 나온다', () => {
    const header = html.match(/<tr><th>테이블<\/th>.*?<\/tr>/)
    expect(header, 'DB 도달 경로 표 머리글을 찾지 못했습니다').toBeTruthy()
    for (const col of ['인증', '소유권', '역할', '검증', '호출제한']) expect(header[0]).toContain(col)
  })

  it('8. destinations 가 표로 나온다', () => {
    expect(html).toContain('외부 전송 — 목적지 인벤토리')
    expect(html).toContain('Supabase')
  })

  it('9. 구성 순서가 REQ-8.17 과 같다', () => {
    const order = [
      '종합 판정', 'class="panel p-meta"', 'class="panel p-cov"', 'class="panel p-moe"',
      'class="panel p-db"', 'class="panel p-dest"', '항목별 판정', '확인 세션 기록', '적용 범위와 신뢰 경계',
    ]
    const positions = order.map((m) => ({ m, at: html.indexOf(m) }))
    expect(positions.filter((p) => p.at < 0).map((p) => p.m), '찾지 못한 구성 요소').toEqual([])
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i].at, `${positions[i].m} 가 ${positions[i - 1].m} 보다 앞에 있습니다`)
        .toBeGreaterThan(positions[i - 1].at)
    }
  })

  it('10. 종합 판정 카드의 다섯 수치가 summary 와 같다', () => {
    const s = report.summary
    for (const n of [s.must_fix, s.recommended, s.info, s.needs_human.total, s.teacher_confirmed]) {
      expect(html).toContain(`<span class="n">${n}건</span>`)
    }
    expect(html).toContain(`커버리지 부족 ${s.needs_human.coverage}`)
  })

  it('10. 🔴 가 0일 때 "통과" 라고 쓰지 않는다 (REQ-7.21)', () => {
    const clean = validReport()
    const out = render(clean)
    expect(clean.summary.must_fix).toBe(0)
    expect(out).toContain('반드시 수정 항목 없음')
    expect(out).not.toContain('통과')
  })

  it('11. 문서 hit 건수를 별도로 남긴다 (REQ-7.16)', () => {
    expect(html).toContain('문서에서 발견(참고) 3건')
  })

  it('REQ-7.13 — 같은 근거가 여러 항목에 인용되면 접어서 표시한다', () => {
    expect(html).toMatch(/에서도 인용/)
  })

  it('REQ-7.20 — 집계는 effective_severity 로 센다', () => {
    // S-tracking 은 base low, S-name-exposure 는 base medium 으로 두었다
    expect(report.summary.info).toBe(1)
    expect(report.summary.recommended).toBe(1)
    expect(report.summary.must_fix).toBe(2)
  })

  it('미충족 중 🔴 만 펼쳐 두고 나머지는 "먼저 볼 것" 으로 안내한다', () => {
    expect(html).toContain('먼저 볼 것')
    const opened = html.match(/<details id="item-[^"]+" open>/g) || []
    expect(opened).toHaveLength(report.summary.must_fix)
  })

  it('카테고리 제목이 spec §6 소제목으로 나온다', () => {
    for (const c of categories) expect(html).toContain(`카테고리 ${c.number}. ${c.title}`)
  })

  it('다섯 개 정보 탭이 JS 없이 라디오로 동작한다', () => {
    for (const id of ['t-meta', 't-cov', 't-moe', 't-db', 't-dest']) {
      expect(html).toContain(`id="${id}"`)
      expect(html).toContain(`for="${id}"`)
    }
    expect(html).toContain('name="infotab"')
  })

  it('인쇄 선택지가 있고 인쇄 시 모두 펼치는 규칙이 들어 있다', () => {
    expect(html).toContain('인쇄·PDF 저장할 때 모두 펼쳐서 출력하기')
    expect(html).toContain('#print-all:checked ~ main .panel')
    expect(html).toContain('#print-all:checked ~ main details > *:not(summary)')
  })

  it('서식1 고정 문구와 신뢰 경계 문구가 있다 (REQ-8.23 · REQ-11.1)', () => {
    expect(html).toContain(escapeHtml(MOE_DISCLAIMER))
    expect(html).toContain(escapeHtml(TRUST_BOUNDARY))
  })

  it('자리표시자가 남지 않는다', () => {
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/)
  })

  it('자리표시자가 빠진 템플릿은 렌더를 거부한다', () => {
    expect(() => renderHtml(report, items, TEMPLATE.replace('{{CATEGORIES}}', ''))).toThrow(/자리표시자/)
  })

  it('HTML 과 MD 가 같은 판정 수치를 담는다 (REQ-4.3)', () => {
    const md = renderMarkdown(report, items)
    const s = report.summary
    expect(md).toContain(`🔴 배포 전 반드시 수정  ${s.must_fix}건`)
    expect(html).toContain(`<span class="n">${s.must_fix}건</span>`)
  })
})

describe('이스케이프 함수 (REQ-8.18)', () => {
  it('escapeHtml 이 다섯 문자를 모두 바꾼다', () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  })

  it('escapeHtml 이 앰퍼샌드를 이중 인코딩하지 않고 먼저 처리한다', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })

  it('escapeAttr 이 따옴표를 막는다', () => {
    expect(escapeAttr('" onload="alert(1)')).not.toContain('"')
  })

  it('escapeUrl 이 javascript: 스킴을 버린다', () => {
    expect(escapeUrl('javascript:alert(1)')).toBe('#')
    expect(escapeUrl('  JaVaScRiPt:alert(1)')).toBe('#')
    expect(escapeUrl('data:text/html,<b>')).toBe('#')
    expect(escapeUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(escapeUrl('#item-R-rrn')).toBe('#item-R-rrn')
  })

  it('null·undefined 를 빈 문자열로 다룬다', () => {
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
  })
})
