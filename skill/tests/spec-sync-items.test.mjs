import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { readSpec, specItems } from './helpers/spec-parse.mjs'

const doc = specItems(readSpec())
const impl = JSON.parse(readFileSync('edusafe/rules/items.json', 'utf8')).items

describe('④ spec §6 ↔ items.json', () => {
  it('항목 id 집합이 양방향으로 같다', () => {
    expect([...doc.keys()].sort()).toEqual(impl.map((i) => i.id).sort())
  })

  it('항목 37개 · 하위 점검 134개다', () => {
    expect(impl).toHaveLength(37)
    expect(impl.reduce((n, i) => n + i.subchecks.length, 0)).toBe(134)
  })

  it('항목별 모든 필드가 문서와 일치한다', () => {
    const diffs = []
    for (const it of impl) {
      const d = doc.get(it.id)
      const eq = (k, a, b) => { if (String(a) !== String(b)) diffs.push(`${it.id}.${k}: 문서="${a}" 구현="${b}"`) }
      eq('question', d.question, it.question)
      eq('category', d.attrs['카테고리'], it.category)
      eq('base_severity', d.attrs['중요도'], it.base_severity)
      eq('methods', d.attrs['판정 방식'], it.methods.join(', '))
      eq('na_when', d.attrs['해당없음 조건'], it.applicability.na_when)
      eq('absence_proof', d.attrs['부재 증명 항목'], it.absence_proof ? '예' : '아니오')
      eq('basis', d.attrs['근거'], it.basis)
      eq('why_risky', d.why_risky, it.why_risky)
      eq('fix_hint', d.fix_hint, it.fix_hint)
      eq('subcheck ids', d.subchecks.map((s) => s.id).join('|'), it.subchecks.map((s) => s.id).join('|'))
      for (let k = 0; k < it.subchecks.length; k++) {
        const a = d.subchecks[k], b = it.subchecks[k]
        if (!a) continue
        eq(`${b.id}.text`, a.text, b.text)
        eq(`${b.id}.required_coverage`, a.required_coverage.join(','), b.required_coverage.join(','))
        eq(`${b.id}.stacks`, Array.isArray(a.stacks) ? a.stacks.join(',') : a.stacks,
                              Array.isArray(b.stacks) ? b.stacks.join(',') : b.stacks)
      }
    }
    expect(diffs, diffs.join('\n')).toEqual([])
  })
})
