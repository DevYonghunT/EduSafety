import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { readSpec, readPlan, specRules, specItems } from './helpers/spec-parse.mjs'
import { rules, projectRules } from '../edusafe/rules/scan-rules.mjs'
import { mustMask } from '../edusafe/scripts/scan.mjs'

const doc = specRules(readSpec())
const items = specItems(readSpec())
const impl = [...rules, ...projectRules]

const flagsOf = (r) => [r.scanMinified && 'scanMinified', r.maskSecret && 'maskSecret', r.secretValue && 'secretValue'].filter(Boolean)

describe('⑤ spec §9·§9.1 ↔ scan-rules.mjs', () => {
  it('규칙 id 집합이 양방향으로 같다 (패턴 44 · 프로젝트 4)', () => {
    expect(rules).toHaveLength(44)
    expect(projectRules).toHaveLength(4)
    expect([...doc.keys()].sort()).toEqual(impl.map((r) => r.id).sort())
    expect([...doc.values()].filter((d) => d.kind === 'pattern')).toHaveLength(44)
  })

  it('규칙별 item·subcheck·severity·stacks·플래그·제목이 문서와 일치한다', () => {
    const diffs = []
    for (const r of impl) {
      const d = doc.get(r.id)
      const eq = (k, a, b) => { if (String(a) !== String(b)) diffs.push(`${r.id}.${k}: 문서="${a}" 구현="${b}"`) }
      eq('item', d.item, r.item)
      eq('subcheck', d.subcheck, r.subcheck)
      eq('severity', d.severity, r.severity)
      eq('stacks', d.stacks, Array.isArray(r.stacks) ? r.stacks.join(', ') : r.stacks)
      eq('title', d.title, r.title)
      if (d.kind === 'pattern') eq('flags', d.flags.join(', ') || '—', flagsOf(r).join(', ') || '—')
    }
    expect(diffs, diffs.join('\n')).toEqual([])
  })

  it('⑨ 모든 규칙의 item::subcheck 가 spec §6 에 실재한다', () => {
    const bad = impl.filter((r) => {
      const it = items.get(r.item)
      return !it || !it.subchecks.some((s) => s.id === r.subcheck)
    })
    expect(bad.map((r) => `${r.id} → ${r.item}::${r.subcheck}`)).toEqual([])
  })

  it('패턴 규칙은 g 플래그를, 프로젝트 규칙은 check 함수를 갖는다', () => {
    expect(rules.filter((r) => !r.pattern.flags.includes('g')).map((r) => r.id)).toEqual([])
    expect(projectRules.filter((r) => typeof r.check !== 'function').map((r) => r.id)).toEqual([])
  })

  it('⑧ secretValue 인데 마스킹되지 않는 규칙이 없다', () => {
    const unmasked = impl.filter((r) => r.secretValue && !mustMask(r))
    expect(unmasked.map((r) => r.id), '시크릿을 평문으로 남길 규칙').toEqual([])
  })
})

// 리뷰 발견 5 — id·항목·severity·플래그만 대조하면 정규식 본문이 드리프트해도 통과한다.
// spec §9 는 "정규식·판정 함수 전문은 구현 계획 Task 2 에 있다"고 못 박으므로,
// 그 블록과 scan-rules.mjs 를 문자 단위로 묶는다. 규칙을 고치려면 계획서를 먼저 고쳐야 한다.
describe('⑬ plan Task 2 ↔ scan-rules.mjs 원문 대조', () => {
  const impl = readFileSync('edusafe/rules/scan-rules.mjs', 'utf8')
  const plan = readPlan()
  const NL = String.fromCharCode(10)
  const block = (text, head) => {
    const a = text.indexOf(head)
    if (a < 0) throw new Error(`블록을 찾지 못했습니다: ${head}`)
    const b = text.indexOf(NL + ']', a)
    if (b < 0) throw new Error(`블록의 끝을 찾지 못했습니다: ${head}`)
    return text.slice(a, b + 2)
  }

  for (const head of ['export const rules = [', 'export const projectRules = [']) {
    it(`${head.trim()} 블록이 계획서 원문과 문자 단위로 같다`, () => {
      expect(block(impl, head)).toBe(block(plan, head))
    })
  }

  it('정규식을 한 글자만 바꿔도 이 대조가 깨진다 (자기 검사)', () => {
    const tampered = block(impl, 'export const rules = [').replace('/AIza[', '/AIZA[')
    expect(tampered).not.toBe(block(plan, 'export const rules = ['))
  })
})
