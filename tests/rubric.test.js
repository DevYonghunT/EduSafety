import { describe, it, expect } from 'vitest'
import { rubricItems, FEATURES, CATEGORIES, AUTHORITY_LABELS, featureProfile } from '../src/data/rubric.js'

describe('루브릭 무결성 (hackathon-2 — 적용 조건 기반)', () => {
  it('id 중복 없음, 총 30항목', () => {
    const ids = rubricItems.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(rubricItems.length).toBe(30)
  })

  it('모든 항목 필드 유효 (when·question·plain·authority·category 포함)', () => {
    for (const it of rubricItems) {
      expect(it.when === null || Object.keys(FEATURES).includes(it.when)).toBe(true)
      expect(['required', 'scored']).toContain(it.type)
      expect(it.weight).toBeGreaterThanOrEqual(1)
      expect(typeof it.aiVerifiable).toBe('boolean')
      expect(it.question.length).toBeGreaterThan(5)
      expect(it.plain.length).toBeGreaterThan(10)
      expect(Object.keys(AUTHORITY_LABELS)).toContain(it.authority)
      expect(Object.keys(CATEGORIES)).toContain(it.category)
    }
  })

  it('필수 10개 · 수동 6개 · 공통(무조건 적용) 14개', () => {
    expect(rubricItems.filter((i) => i.type === 'required').length).toBe(10)
    expect(rubricItems.filter((i) => !i.aiVerifiable).length).toBe(6)
    expect(rubricItems.filter((i) => i.when === null).length).toBe(14)
  })

  it('공통 항목에 필수가 포함된다 — 기능이 하나도 없어도 최소선은 심사된다', () => {
    expect(rubricItems.some((i) => i.when === null && i.type === 'required')).toBe(true)
  })

  it('교육 적절성 분류는 수동 항목만 (사람 심사 영역)', () => {
    for (const it of rubricItems.filter((i) => i.category === 'education')) {
      expect(it.aiVerifiable).toBe(false)
    }
  })

  it('기능 프로파일 문자열 — 활성 기능 요약', () => {
    expect(featureProfile({ studentFacing: true, handlesRealData: true })).toBe('학생 대면 · 실데이터 취급')
    expect(featureProfile({})).toContain('공통 기준만')
  })
})
