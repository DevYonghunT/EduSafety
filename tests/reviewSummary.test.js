import { describe, it, expect } from 'vitest'
import { rubricItems } from '../src/data/rubric.js'
import { finalVerdict, computeSummary } from '../src/lib/reviewSummary.js'

// admin 트랙의 AI 항목 전부에 verdict를 채우는 도우미
const fillAi = (track, verdict) => {
  const j = {}
  for (const it of rubricItems.filter((i) => i.tracks.includes(track) && i.aiVerifiable)) {
    j[it.id] = { verdict }
  }
  return j
}
const fillHuman = (track, verdict) => {
  const h = {}
  for (const it of rubricItems.filter((i) => i.tracks.includes(track) && !i.aiVerifiable)) {
    h[it.id] = { verdict }
  }
  return h
}

describe('판정 집계 (T3 완료 기준 — 신뢰성 원칙 3·4)', () => {
  it('전부 충족이면 합격 후보', () => {
    const s = computeSummary('admin', fillAi('admin', 'pass'), {}, fillHuman('admin', 'pass'))
    expect(s.status).toBe('pass_candidate')
    expect(s.actions.mustFix).toBe(0)
  })

  it('원칙 3: 판단불가가 하나라도 남으면 무조건 보류', () => {
    const j = fillAi('admin', 'pass')
    j['R-secrets'] = { verdict: 'needs_human' }
    const s = computeSummary('admin', j, {}, fillHuman('admin', 'pass'))
    expect(s.status).toBe('hold')
  })

  it('수동 항목 미입력(빈칸)도 판단불가로 수렴 → 보류', () => {
    const s = computeSummary('admin', fillAi('admin', 'pass'), {}, {})
    expect(s.status).toBe('hold')
    expect(s.actions.confirm).toBeGreaterThan(0)
  })

  it('필수 미충족이면 불합격 후보', () => {
    const j = fillAi('admin', 'pass')
    j['R-db-locked'] = { verdict: 'fail' }
    const s = computeSummary('admin', j, {}, fillHuman('admin', 'pass'))
    expect(s.status).toBe('fail_candidate')
    expect(s.requiredFails.map((i) => i.id)).toContain('R-db-locked')
  })

  it('원칙 4: 심사자 오버라이드가 AI 판정을 이긴다', () => {
    const item = rubricItems.find((i) => i.id === 'R-secrets')
    expect(finalVerdict(item, { 'R-secrets': { verdict: 'fail' } }, { 'R-secrets': { verdict: 'pass' } }, {})).toBe('pass')
  })

  it('카테고리 상태 = 최악 판정 (필수 미충족 > 미충족 > 확인 필요 > 충족)', () => {
    const j = fillAi('admin', 'pass')
    j['R-db-locked'] = { verdict: 'fail' } // access 카테고리, 필수
    j['S-quota'] = { verdict: 'fail' } // code 카테고리, 점수
    j['S-notice'] = { verdict: 'needs_human' } // notice 카테고리
    const s = computeSummary('admin', j, {}, fillHuman('admin', 'pass'))
    expect(s.categoryStates.access).toBe('fail_required')
    expect(s.categoryStates.code).toBe('fail')
    expect(s.categoryStates.notice).toBe('needs_human')
    expect(s.categoryStates.collect).toBe('ok')
  })

  it('단일 점수를 산출하지 않는다 (점수 폐지 결정)', () => {
    const s = computeSummary('admin', fillAi('admin', 'pass'), {}, fillHuman('admin', 'pass'))
    expect(s.score).toBeUndefined()
  })

  it('알 수 없는 트랙은 합격 후보가 될 수 없다', () => {
    expect(computeSummary('nonsense', {}, {}, {}).status).toBe('hold')
  })
})
