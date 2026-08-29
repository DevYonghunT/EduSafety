import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { renderMarkdown, recomputeSummary, validateReport, loadContract, MOE_DISCLAIMER, TRUST_BOUNDARY } from '../edusafe/scripts/render.mjs'
import { validReport, QUOTE } from './helpers/valid-report.mjs'

const items = JSON.parse(readFileSync('edusafe/rules/items.json', 'utf8')).items
const contract = loadContract()
const SUBCHECK_TOTAL = items.reduce((n, i) => n + i.subchecks.length, 0)

const MASKED = 'AIzaSy****'

// 판정이 섞인 보고서 — 전부 na 인 보고서만 렌더하면 표기 분기를 하나도 못 본다.
function mixedReport() {
  const r = validReport()
  // REQ-7.5 — 항목 판정은 하위 점검 중 최악이어야 하므로, 첫 하위 점검을 항목과 맞춘다.
  const set = (id, patch) => {
    const it = r.items.find((i) => i.item_id === id)
    Object.assign(it, patch)
    it.subchecks.forEach((s, i) => {
      const lead = i === 0
      s.verdict = lead ? patch.verdict : 'na'
      s.verification_level = lead ? patch.verification_level : 'none'
      s.sources = lead ? [...(patch.sources || [])] : []
      s.evidence = lead && (patch.verdict === 'pass' || patch.verdict === 'fail') ? [QUOTE] : []
      s.reason = lead && patch.verdict === 'needs_human' ? (patch.demotion_reason || null) : null
    })
  }

  set('R-secrets', {
    verdict: 'fail', verification_level: 'verified', sources: ['scanner'],
    applicability_reason: null,
    evidence: [{ ...QUOTE, file: 'src/app.js', line: 3, quote: `const k = '${MASKED}'` }],
  })
  set('S-tracking', {
    verdict: 'fail', verification_level: 'verified', sources: ['scanner'], applicability_reason: null,
    effective_severity: 'low', evidence: [QUOTE],
  })
  set('S-name-exposure', {
    verdict: 'fail', verification_level: 'verified', sources: ['code'], applicability_reason: null,
    effective_severity: 'medium', evidence: [QUOTE],
  })
  set('H-2fa', {
    verdict: 'pass', verification_level: 'attested', sources: ['teacher'], applicability_reason: null,
    evidence: [{ type: 'quote', source: 'teacher', file: '(교사 답변)', line: 0, quote: '2단계 인증을 켰습니다' }],
  })
  set('S-data-region', {
    verdict: 'needs_human', verification_level: 'none', sources: [], applicability_reason: null,
    demotion_reason: 'coverage-insufficient',
  })
  set('R-server-guard', {
    verdict: 'needs_human', verification_level: 'none', sources: [], applicability_reason: null,
    demotion_reason: 'unsupported-stack',
  })
  set('H-retention', {
    verdict: 'needs_human', verification_level: 'none', sources: [], applicability_reason: null,
  })

  const want = recomputeSummary(r.items)
  r.summary = { ...want, documentation_hits: 3 }
  // 서식1 상태도 다시 도출한다
  for (const row of r.moe_checklist) {
    const verdicts = row.mapped_items.map((id) => r.items.find((i) => i.item_id === id).verdict)
    row.status = verdicts.includes('fail') ? '미충족'
      : verdicts.includes('needs_human') ? '확인필요'
        : verdicts.every((v) => v === 'na') ? '해당없음' : '충족'
  }
  return r
}

describe('renderMarkdown (REQ-8.20)', () => {
  const report = mixedReport()
  const md = renderMarkdown(report, items)

  it('렌더 대상 보고서가 계약을 통과한다', () => {
    expect(validateReport(report, items, contract)).toEqual([])
  })

  it('항목 37개가 전부 나온다', () => {
    const missing = items.filter((i) => !md.includes(`#### ${i.id} —`))
    expect(missing.map((i) => i.id), 'MD 에 빠진 항목').toEqual([])
    expect(items).toHaveLength(37)
  })

  it(`하위 점검 ${SUBCHECK_TOTAL}개가 전부 나온다`, () => {
    const missing = []
    for (const it of items) for (const s of it.subchecks) if (!md.includes(s.id)) missing.push(`${it.id}.${s.id}`)
    expect(missing, 'MD 에 빠진 하위 점검').toEqual([])
  })

  it('db_paths 의 controls 5축이 표의 열로 나온다', () => {
    const header = md.split('\n').find((l) => l.startsWith('| 테이블 |'))
    expect(header).toBeTruthy()
    for (const col of ['인증', '소유권', '역할', '검증', '호출제한']) expect(header).toContain(col)
  })

  it('destinations 가 표로 나온다', () => {
    expect(md).toContain('## 목적지 인벤토리')
    expect(md).toContain('Supabase')
  })

  it('coverage 의 status 와 reason 이 출력된다', () => {
    expect(md).toContain('### coverage')
    expect(md).toContain('no-git')          // history.reason
    expect(md).toContain('non-interactive') // build.reason
    expect(md).toContain('session-skipped') // teacher.reason
  })

  it('needs_human 네 수치가 전부 출력된다', () => {
    const nh = report.summary.needs_human
    expect(nh.total).toBe(3)
    expect(md).toContain(`❓ 판단불가             ${nh.total}건`)
    expect(md).toContain(`커버리지 부족 ${nh.coverage}`)
    expect(md).toContain(`미지원 스택 ${nh.unsupported}`)
    expect(md).toContain(`미답변 ${nh.unanswered}`)
  })

  it('종합 판정 수치가 summary 와 같다', () => {
    const s = report.summary
    expect(md).toContain(`🔴 배포 전 반드시 수정  ${s.must_fix}건`)
    expect(md).toContain(`🟡 권장 수정            ${s.recommended}건`)
    expect(md).toContain(`⚪ 참고                 ${s.info}건`)
    expect(md).toContain(`✍️ 교사 확인 항목       ${s.teacher_confirmed}건`)
    expect(s.must_fix).toBe(1)
    expect(s.recommended).toBe(1)
    expect(s.info).toBe(1)
    expect(s.teacher_confirmed).toBe(1)
  })

  it('마스킹된 값이 마스킹된 채로 남는다', () => {
    expect(md).toContain(MASKED)
    expect(md).not.toContain('AIzaSyD1234567890')
  })

  it('교사 확인 pass 는 검증된 충족과 다르게 표기된다 (REQ-7.2)', () => {
    expect(md).toContain('교사 확인: 충족')
  })

  it('서식1 대조표와 고정 문구가 있다 (REQ-8.23)', () => {
    expect(md).toContain('## 교육부 [서식 1] 필수기준 대조표')
    expect(md).toContain(MOE_DISCLAIMER)
  })

  it('신뢰 경계 문구가 있다 (REQ-11.1)', () => {
    expect(md).toContain(TRUST_BOUNDARY)
  })

  it('적용 범위 각주가 있다', () => {
    expect(md).toContain('## 적용 범위 각주')
    expect(md).toContain('제4조 단서')
  })

  it('문서 hit 건수를 남긴다 (REQ-7.16)', () => {
    expect(md).toContain('문서에서 발견(참고) 3건')
  })

  it('🔴 가 0일 때 "통과" 라고 쓰지 않는다 (REQ-7.21)', () => {
    const clean = validReport()
    const mdClean = renderMarkdown(clean, items)
    expect(clean.summary.must_fix).toBe(0)
    expect(mdClean).toContain('반드시 수정 항목 없음')
    expect(mdClean).not.toContain('통과')
  })

  it('표를 깨뜨리는 파이프를 이스케이프한다', () => {
    const r = validReport()
    r.db_paths[0].table = 'a|b'
    const out = renderMarkdown(r, items)
    const row = out.split('\n').find((l) => l.includes('a'))
    expect(out).not.toContain('| a|b |')
  })
})

// ── Codex 리뷰(Task 4) 반영 회귀 — 렌더 ───────────────────────────────────
describe('리뷰 반영 회귀 — MD 렌더', () => {
  it('발견 7 — 하위 점검의 근거가 MD 에 나온다', () => {
    const r = validReport()
    r.items[0].subchecks[0].evidence = [{ ...QUOTE, quote: 'SUBCHECK-EVIDENCE-MARKER' }]
    const md = renderMarkdown(r, items)
    expect(md).toContain('하위 점검 근거')
    expect(md).toContain('SUBCHECK-EVIDENCE-MARKER')
  })

  it('발견 7 — DB 도달 경로의 근거가 MD 에 나온다', () => {
    const r = validReport()
    r.db_paths[0].evidence = [{ ...QUOTE, quote: 'DBPATH-EVIDENCE-MARKER' }]
    const md = renderMarkdown(r, items)
    expect(md).toContain('경로별 근거')
    expect(md).toContain('DBPATH-EVIDENCE-MARKER')
  })

  it('발견 7 — 계약이 렌더 대상이라 표시한 evidence 가 전부 렌더된다', () => {
    const r = validReport()
    r.items[0].evidence = [{ ...QUOTE, quote: 'ITEM-EV' }]
    r.items[0].subchecks[0].evidence = [{ ...QUOTE, quote: 'SUB-EV' }]
    r.db_paths[0].evidence = [{ ...QUOTE, quote: 'DB-EV' }]
    const md = renderMarkdown(r, items)
    for (const marker of ['ITEM-EV', 'SUB-EV', 'DB-EV']) expect(md, `${marker} 가 렌더되지 않음`).toContain(marker)
  })

  it('발견 8 — 인용 안의 백틱이 코드 스팬을 깨뜨리지 않는다', () => {
    const r = validReport()
    r.items[0].evidence = [{ ...QUOTE, quote: 'const x = `secret`' }]
    const line = renderMarkdown(r, items).split('\n').find((l) => l.includes('const x ='))
    // 내용의 백틱(1개)보다 긴 울타리(2개)로 감싸고 양옆에 공백을 둔다
    expect(line).toContain('`` const x = `secret` ``')
  })

  it('발견 8 — 백틱이 없는 인용은 그대로 한 겹 코드 스팬이다', () => {
    const r = validReport()
    r.items[0].evidence = [{ ...QUOTE, quote: 'const a = 1' }]
    const line = renderMarkdown(r, items).split('\n').find((l) => l.includes('const a = 1'))
    expect(line).toContain('`const a = 1`')
  })
})
