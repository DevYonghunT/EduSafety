import { describe, it, expect } from 'vitest'
import { rubricItems, TRACKS, CATEGORIES, AUTHORITY_LABELS } from '../src/data/rubric.js'

describe('루브릭 무결성 (T2 완료 기준)', () => {
  it('id 중복 없음', () => {
    const ids = rubricItems.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('모든 항목 필드 유효 (question·plain·authority·category 포함)', () => {
    for (const it of rubricItems) {
      expect(it.tracks.length).toBeGreaterThan(0)
      for (const t of it.tracks) expect(TRACKS[t]).toBeDefined()
      expect(['required', 'scored']).toContain(it.type)
      expect(it.weight).toBeGreaterThanOrEqual(1)
      expect(typeof it.aiVerifiable).toBe('boolean')
      expect(it.question.length).toBeGreaterThan(5)
      expect(it.plain.length).toBeGreaterThan(10)
      expect(Object.keys(AUTHORITY_LABELS)).toContain(it.authority)
      expect(Object.keys(CATEGORIES)).toContain(it.category)
    }
  })

  it('필수 10개 · 수동 6개 (기획서 6장 표 기준)', () => {
    expect(rubricItems.filter((i) => i.type === 'required').length).toBe(10)
    expect(rubricItems.filter((i) => !i.aiVerifiable).length).toBe(6)
  })

  it('모든 트랙에 필수 항목이 1개 이상', () => {
    for (const t of Object.keys(TRACKS)) {
      expect(rubricItems.some((i) => i.tracks.includes(t) && i.type === 'required')).toBe(true)
    }
  })

  it('교육 적절성 분류는 수동 항목만 (앱 전용 — 사람 심사 영역)', () => {
    for (const it of rubricItems.filter((i) => i.category === 'education')) {
      expect(it.aiVerifiable).toBe(false)
    }
  })
})
