import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { readSpec, specMoe, specMoeDisclaimer } from './helpers/spec-parse.mjs'
import { moeStatusFor, MOE_DISCLAIMER, validateReport, loadContract } from '../edusafe/scripts/render.mjs'
import { validReport } from './helpers/valid-report.mjs'

const moe = JSON.parse(readFileSync('edusafe/rules/moe-checklist.json', 'utf8'))
const items = JSON.parse(readFileSync('edusafe/rules/items.json', 'utf8')).items
const doc = specMoe(readSpec())

const CRITERIA = ['1-1', '1-2', '1-3', '2-1', '3-1', '4-1', '5-1', '5-2', '5-3']

describe('교육부 [서식 1] 매핑', () => {
  it('기준이 9개이고 번호가 정확하다', () => {
    expect(moe.criteria).toHaveLength(9)
    expect(moe.criteria.map((c) => c.criterion)).toEqual(CRITERIA)
  })

  it('spec §8.6 과 양방향으로 일치한다', () => {
    expect(moe.criteria.map((c) => ({ criterion: c.criterion, text: c.text, note: c.note, mapped_items: c.mapped_items })))
      .toEqual(doc)
  })

  it('모든 mapped_items 가 items.json 에 실재한다', () => {
    const known = new Set(items.map((i) => i.id))
    const ghosts = moe.criteria.flatMap((c) => c.mapped_items.filter((id) => !known.has(id)))
    expect([...new Set(ghosts)]).toEqual([])
  })

  it('매핑되지 않은 기준이 없다', () => {
    expect(moe.criteria.filter((c) => c.mapped_items.length === 0).map((c) => c.criterion)).toEqual([])
  })

  it('disclaimer 가 REQ-8.23 문구와 문자열이 같다', () => {
    const fromSpec = specMoeDisclaimer(readSpec())
    expect(moe.disclaimer).toBe(fromSpec)
    expect(MOE_DISCLAIMER).toBe(fromSpec)
  })
})

// REQ-8.22 — 매핑 항목이 여럿이면 REQ-7.3 의 순서로 최악을 택한다
describe('서식1 상태 산출 규칙 (REQ-8.22)', () => {
  const report = (pairs) => pairs.map(([item_id, verdict]) => ({ item_id, verdict }))

  it('하나라도 fail 이면 미충족', () => {
    expect(moeStatusFor(['A', 'B'], report([['A', 'pass'], ['B', 'fail']]))).toBe('미충족')
  })

  it('fail 없고 하나라도 needs_human 이면 확인필요', () => {
    expect(moeStatusFor(['A', 'B'], report([['A', 'pass'], ['B', 'needs_human']]))).toBe('확인필요')
  })

  it('전부 na 면 해당없음', () => {
    expect(moeStatusFor(['A', 'B'], report([['A', 'na'], ['B', 'na']]))).toBe('해당없음')
  })

  it('전부 pass 면 충족', () => {
    expect(moeStatusFor(['A', 'B'], report([['A', 'pass'], ['B', 'pass']]))).toBe('충족')
  })

  it('pass 와 na 가 섞이면 충족', () => {
    expect(moeStatusFor(['A', 'B'], report([['A', 'pass'], ['B', 'na']]))).toBe('충족')
  })

  it('매핑 항목을 보고서에서 찾지 못하면 확인필요', () => {
    expect(moeStatusFor(['없는항목'], report([['A', 'pass']]))).toBe('확인필요')
  })
})

// Task 4·5 에서 미뤄둔 검사 — moe-checklist.json 이 생긴 뒤에야 완성된다
describe('검증기와의 연결', () => {
  it('서식1 을 한 줄짜리 임의 표로 바꾸면 거부한다', () => {
    const r = validReport()
    r.moe_checklist = [{ criterion: '1-1', text: '임의 문구', mapped_items: ['S-minimal'], status: '해당없음' }]
    expect(validateReport(r, items, loadContract()).join('\n')).toMatch(/빠진 기준/)
  })

  it('§8.6 문안을 고치면 거부한다', () => {
    const r = validReport()
    r.moe_checklist[0].text = '내가 다듬은 문장'
    expect(validateReport(r, items, loadContract()).join('\n')).toMatch(/§8.6 문안과 다릅니다/)
  })

  it('§8.6 매핑을 바꾸면 거부한다', () => {
    const r = validReport()
    r.moe_checklist[0].mapped_items = ['R-rrn']
    expect(validateReport(r, items, loadContract()).join('\n')).toMatch(/§8.6 매핑과 다릅니다/)
  })

  it('정상 보고서는 9개 기준을 모두 담고 통과한다', () => {
    const r = validReport()
    expect(r.moe_checklist).toHaveLength(9)
    expect(validateReport(r, items, loadContract())).toEqual([])
  })
})
