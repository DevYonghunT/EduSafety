import { describe, it, expect } from 'vitest'
import { rubricItems } from '../src/data/rubric.js'
import { finalVerdict, computeSummary } from '../src/lib/reviewSummary.js'

const applicable = (features) => rubricItems.filter((it) => !it.when || features[it.when])
const fillAi = (features, verdict) => {
  const j = {}
  for (const it of applicable(features).filter((i) => i.aiVerifiable)) j[it.id] = { verdict }
  return j
}
const fillHuman = (features, verdict) => {
  const h = {}
  for (const it of applicable(features).filter((i) => !i.aiVerifiable)) h[it.id] = { verdict }
  return h
}
const BASE = {} // 기능 없음 — 공통 14항목만 적용

describe('판정 집계 (신뢰성 원칙 3·4 + hackathon-2 적용 조건)', () => {
  it('전부 충족이면 합격 후보', () => {
    const s = computeSummary(BASE, fillAi(BASE, 'ok'), {}, fillHuman(BASE, 'ok'))
    expect(s.status).toBe('pass_candidate')
    expect(s.actions.mustFix).toBe(0)
  })

  it('원칙 3: 판단불가가 하나라도 남으면 무조건 보류', () => {
    const j = fillAi(BASE, 'ok')
    j['R-secrets'] = { verdict: 'needs_human' }
    expect(computeSummary(BASE, j, {}, fillHuman(BASE, 'ok')).status).toBe('hold')
  })

  it('수동 항목 미입력(빈칸)도 판단불가로 수렴 → 보류', () => {
    const s = computeSummary(BASE, fillAi(BASE, 'ok'), {}, {})
    expect(s.status).toBe('hold')
    expect(s.actions.confirm).toBeGreaterThan(0)
  })

  it('필수 미충족이면 불합격 후보', () => {
    const j = fillAi(BASE, 'ok')
    j['R-db-locked'] = { verdict: 'fail' }
    const s = computeSummary(BASE, j, {}, fillHuman(BASE, 'ok'))
    expect(s.status).toBe('fail_candidate')
    expect(s.requiredFails.map((i) => i.id)).toContain('R-db-locked')
  })

  it('원칙 4: 심사자 오버라이드가 AI 판정을 이긴다', () => {
    const item = rubricItems.find((i) => i.id === 'R-secrets')
    expect(finalVerdict(item, { 'R-secrets': { verdict: 'fail' } }, { 'R-secrets': { verdict: 'ok' } }, {})).toBe('ok')
  })

  it('카테고리 상태 = 최악 판정 (필수 미충족 > 미충족 > 확인 필요 > 충족)', () => {
    const j = fillAi(BASE, 'ok')
    j['R-db-locked'] = { verdict: 'fail' }
    j['S-quota'] = { verdict: 'fail' }
    j['S-notice'] = { verdict: 'needs_human' }
    const s = computeSummary(BASE, j, {}, fillHuman(BASE, 'ok'))
    expect(s.categoryStates.access).toBe('fail_required')
    expect(s.categoryStates.code).toBe('fail')
    expect(s.categoryStates.notice).toBe('needs_human')
    expect(s.categoryStates.collect).toBe('ok')
  })

  it('단일 점수를 산출하지 않는다 (점수 폐지 결정)', () => {
    const s = computeSummary(BASE, fillAi(BASE, 'ok'), {}, fillHuman(BASE, 'ok'))
    expect(s.score).toBeUndefined()
  })

  // ── hackathon-2: 적용 조건 ──
  it('기능이 없으면 공통 14항목만 적용, 나머지는 조건 미해당', () => {
    const s = computeSummary(BASE, {}, {}, {})
    expect(s.items.length).toBe(14)
    expect(s.inapplicable.length).toBe(16)
  })

  it('기능을 켜면 해당 항목이 적용된다 — 학생 대면 +9, 실데이터 +2', () => {
    expect(computeSummary({ studentFacing: true }, {}, {}, {}).items.length).toBe(23)
    expect(computeSummary({ studentFacing: true, handlesRealData: true }, {}, {}, {}).items.length).toBe(25)
    expect(computeSummary({ studentFacing: true, handlesRealData: true, showsAiOutput: true, isLearningContent: true }, {}, {}, {}).items.length).toBe(30)
  })

  it('조건 미해당 항목은 판단불가·보류에 포함되지 않는다', () => {
    const s = computeSummary(BASE, fillAi(BASE, 'ok'), {}, fillHuman(BASE, 'ok'))
    expect(s.status).toBe('pass_candidate')
    expect(s.needsHuman.map((i) => i.id)).not.toContain('R-under14')
  })

  it('심사자 오버라이드가 있으면 조건 미해당 항목도 심사에 되살아난다', () => {
    const s = computeSummary(BASE, fillAi(BASE, 'ok'), { 'R-under14': { verdict: 'fail' } }, fillHuman(BASE, 'ok'))
    expect(s.items.map((i) => i.id)).toContain('R-under14')
    expect(s.status).toBe('fail_candidate')
  })
})
