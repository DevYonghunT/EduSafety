import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { readSpec, specSession } from './helpers/spec-parse.mjs'
import { validateReport, loadContract } from '../edusafe/scripts/render.mjs'
import { validReport } from './helpers/valid-report.mjs'

const impl = JSON.parse(readFileSync('edusafe/rules/session.json', 'utf8')).sessions
const items = JSON.parse(readFileSync('edusafe/rules/items.json', 'utf8')).items
const doc = specSession(readSpec())

// 고유 키는 item_id 하나가 아니라 (item_id, kind) 조합이다 — S-auth-hardening 이 두 행을 갖는다
const key = (s) => `${s.item_id}|${s.kind}`
const docBy = new Map(doc.map((s) => [key(s), s]))
const implBy = new Map(impl.map((s) => [key(s), s]))

describe('⑦ spec §7.5 ↔ session.json', () => {
  it('(item_id, kind) 조합이 양방향으로 같다', () => {
    expect([...implBy.keys()].sort()).toEqual([...docBy.keys()].sort())
  })

  it('조합이 중복되지 않는다', () => {
    expect(implBy.size).toBe(impl.length)
    expect(docBy.size).toBe(doc.length)
  })

  it('S-auth-hardening 은 증거형·확인형 두 행을 갖는다', () => {
    expect(impl.filter((s) => s.item_id === 'S-auth-hardening').map((s) => s.kind).sort())
      .toEqual(['evidence', 'teacher'])
  })

  it('질문 문구·답변 형식·갱신 대상이 문서와 일치한다', () => {
    const diffs = []
    for (const s of impl) {
      const d = docBy.get(key(s))
      const eq = (k, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${key(s)}.${k}: 문서=${JSON.stringify(a)} 구현=${JSON.stringify(b)}`) }
      eq('question', d.question, s.question)
      eq('answer_type', d.answer_type, s.answer_type)
      eq('updates', d.updates, s.updates)
    }
    expect(diffs, diffs.join('\n')).toEqual([])
  })

  it('kind 는 evidence 또는 teacher 뿐이다', () => {
    expect(impl.filter((s) => !['evidence', 'teacher'].includes(s.kind)).map(key)).toEqual([])
  })

  // 이 검사가 없으면 확인형 항목을 추가하면서 질문을 빠뜨려도 아무도 모른다
  it('methods 에 evidence·teacher 가 있는 항목은 §7.5 에 행이 있다', () => {
    const need = items.filter((i) => i.methods.some((m) => m === 'evidence' || m === 'teacher'))
    const covered = new Set(impl.map((s) => s.item_id))
    expect(need.filter((i) => !covered.has(i.id)).map((i) => i.id), '질문이 없는 확인형 항목').toEqual([])
  })

  it('세션의 kind 가 그 항목의 methods 안에 있다', () => {
    const bad = []
    for (const s of impl) {
      const it = items.find((i) => i.id === s.item_id)
      if (!it) { bad.push(`${key(s)}: items.json 에 없는 항목`); continue }
      if (!it.methods.includes(s.kind)) bad.push(`${key(s)}: 판정 방식에 ${s.kind} 가 없음`)
    }
    expect(bad, bad.join('\n')).toEqual([])
  })

  it('updates 의 하위 점검 id 가 그 항목에 실재한다', () => {
    const bad = []
    for (const s of impl) {
      if (s.updates === 'all') continue
      const it = items.find((i) => i.id === s.item_id)
      if (!it) continue
      const known = new Set(it.subchecks.map((x) => x.id))
      for (const u of s.updates) if (!known.has(u)) bad.push(`${key(s)}: ${u}`)
    }
    expect(bad, bad.join('\n')).toEqual([])
  })

  it('updates 가 "all" 인 항목은 하위 점검이 하나 이상이다', () => {
    // 하위 점검이 없으면 교사 답변이 갱신할 대상이 없어 판정이 바뀌지 않는다
    const bad = impl
      .filter((s) => s.updates === 'all')
      .filter((s) => {
        const it = items.find((i) => i.id === s.item_id)
        return it && it.subchecks.length === 0
      })
      .map(key)
    expect(bad, '갱신 대상이 없는 확인 세션').toEqual([])
  })

  it('행 수를 상수로 박지 않고 문서에서 세어 쓴다', () => {
    expect(impl).toHaveLength(doc.length)
    expect(new Set(impl.map((s) => s.item_id)).size).toBe(new Set(doc.map((s) => s.item_id)).size)
  })
})

// REQ-7.24 — 질문 문구를 구현자가 지어내지 않는다. 보고서에 실린 질문도 정본과 대조한다.
describe('검증기와의 연결', () => {
  it('세션 질문을 고치면 거부한다', () => {
    const r = validReport()
    r.session[0].question = '제가 지어낸 질문입니다'
    expect(validateReport(r, items, loadContract()).join('\n')).toMatch(/§7.5 질문과 다릅니다/)
  })

  it('§7.5 에 없는 (항목, kind) 조합이면 거부한다', () => {
    const r = validReport()
    r.session[0].item_id = 'R-rrn'
    expect(validateReport(r, items, loadContract()).join('\n')).toMatch(/§7.5 에 없는 조합/)
  })

  it('정본 질문을 그대로 실은 보고서는 통과한다', () => {
    expect(validateReport(validReport(), items, loadContract())).toEqual([])
  })
})
