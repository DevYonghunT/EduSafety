import { describe, it, expect } from 'vitest'
import { rubricItems, FEATURES, CATEGORIES, AUTHORITY_LABELS, featureProfile } from '../src/data/rubric.js'

describe('루브릭 무결성 (core-1 — 스킬×앱 통합 정본)', () => {
  it('id 중복 없음, 총 37항목', () => {
    const ids = rubricItems.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(rubricItems.length).toBe(37)
  })

  it('모든 항목 필드 유효 (when·level·question·plain·authority·category 포함)', () => {
    for (const it of rubricItems) {
      expect(it.when === null || Object.keys(FEATURES).includes(it.when)).toBe(true)
      expect([null, 'L0', 'L1', 'L2']).toContain(it.level)
      expect(['required', 'scored']).toContain(it.type)
      expect(it.weight).toBeGreaterThanOrEqual(1)
      expect(typeof it.aiVerifiable).toBe('boolean')
      expect(it.question.length).toBeGreaterThan(5)
      expect(it.plain.length).toBeGreaterThan(10)
      expect(Object.keys(AUTHORITY_LABELS)).toContain(it.authority)
      expect(Object.keys(CATEGORIES)).toContain(it.category)
    }
  })

  it('필수 14개 · 수동 8개 · 공통(무조건 적용) 15개 (대조표 권고 반영)', () => {
    expect(rubricItems.filter((i) => i.type === 'required').length).toBe(14)
    expect(rubricItems.filter((i) => !i.aiVerifiable).length).toBe(8)
    expect(rubricItems.filter((i) => i.when === null).length).toBe(15)
  })

  it('통합 반영 확인 — 이름 통일·흡수·승격', () => {
    const ids = new Set(rubricItems.map((i) => i.id))
    // 이름 통일 (스킬 이름 채택)
    expect(ids.has('S-injection')).toBe(true)
    expect(ids.has('S-xss')).toBe(false)
    expect(ids.has('S-abuse-limit')).toBe(true)
    expect(ids.has('R-third-party')).toBe(true)
    expect(ids.has('R-admin-ext')).toBe(false)
    // 흡수 (S-consent+S-notice → S-privacy-notice)
    expect(ids.has('S-privacy-notice')).toBe(true)
    expect(ids.has('S-consent')).toBe(false)
    expect(ids.has('S-notice')).toBe(false)
    // 코어 승격 8건
    for (const id of ['S-upload-exposure', 'S-password-storage', 'R-server-guard', 'S-name-exposure', 'S-api-overfetch', 'H-breach-ready', 'H-school-approval', 'S-teacher-gate']) {
      expect(ids.has(id)).toBe(true)
    }
    // 상 ↔ 필수 정렬
    expect(rubricItems.find((i) => i.id === 'S-sensitive').type).toBe('required')
  })

  it('L0 공통 기본선은 조건 없이 모든 앱에 적용된다', () => {
    for (const it of rubricItems.filter((i) => i.level === 'L0')) {
      expect(it.when).toBe(null)
    }
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
