import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { validateReport, loadContract } from '../edusafe/scripts/render.mjs'

const items = JSON.parse(readFileSync('edusafe/rules/items.json', 'utf8')).items
const version = JSON.parse(readFileSync('edusafe/rules/version.json', 'utf8'))
const contract = loadContract()

import { validReport, QUOTE } from './helpers/valid-report.mjs'

// 계약 경로가 가리키는 첫 위치를 찾는다. 배열은 첫 원소를 쓴다.
function locate(report, path) {
  const parts = path.split('.')
  let node = report
  for (let i = 0; i < parts.length; i++) {
    const isArray = parts[i].endsWith('[]')
    const key = isArray ? parts[i].slice(0, -2) : parts[i]
    if (node === null || typeof node !== 'object') return null
    if (i === parts.length - 1 && !isArray) return { parent: node, key }
    let child = node[key]
    if (isArray) {
      if (!Array.isArray(child) || child.length === 0) return null
      if (i === parts.length - 1) return { parent: child, key: 0 }
      child = child[0]
    }
    node = child
  }
  return null
}

const at = (r, p) => { const l = locate(r, p); return l ? l.parent[l.key] : undefined }
const set = (r, p, v) => { const l = locate(r, p); if (l) l.parent[l.key] = v }
const del = (r, p) => {
  const l = locate(r, p)
  if (!l) return
  if (Array.isArray(l.parent)) l.parent.splice(l.key, 1)
  else delete l.parent[l.key]
}
const addKey = (r, p, k) => { const o = at(r, p); if (o && typeof o === 'object') o[k] = '검증되지 않는 값' }
const delInFirstElement = (r, p, k) => { const a = at(r, p); if (Array.isArray(a) && a[0]) delete a[0][k] }

function strategies(f) {
  const out = []
  // 원소 행(`X[]`)에 "필드 삭제"를 쓰면 배열의 유일한 원소를 지우는 셈인데, 빈 배열은
  // 계약 위반이 아니다(DB 경로가 없는 프로젝트는 정상). 대신 원소를 객체가 아닌 값으로 바꾼다.
  if (f.required) {
    if (f.path.endsWith('[]')) out.push(['원소를 스칼라로', (r) => set(r, f.path, '__not-an-object__')])
    else out.push(['필드 삭제', (r) => del(r, f.path)])
  }
  if (f.type.startsWith('string')) out.push(['문자열 자리에 숫자', (r) => set(r, f.path, 123)])
  if (f.type.startsWith('array<')) out.push(['배열을 객체로', (r) => set(r, f.path, {})])
  if (f.type.startsWith('object')) out.push(['객체를 배열로', (r) => set(r, f.path, [])])
  if (f.type === 'number') out.push(['숫자 자리에 문자열', (r) => set(r, f.path, '1')])
  if (f.type === 'boolean') out.push(['불리언 자리에 문자열', (r) => set(r, f.path, 'true')])
  if (f.allowed) out.push(['허용값 밖의 값', (r) => set(r, f.path, '__invalid__')])
  if (f.element_required) out.push([`원소 필수 키 ${f.element_required[0]} 삭제`, (r) => delInFirstElement(r, f.path, f.element_required[0])])
  if (f.keys) out.push(['키 목록 밖의 키 추가', (r) => addKey(r, f.path, '__unknown__')])
  return out
}

describe('계약 위반은 렌더 전에 거부된다', () => {
  const rendered = contract.fields.filter((f) => f.rendered_in.length > 0)

  it('렌더되는 필드가 하나 이상이다', () => expect(rendered.length).toBeGreaterThan(0))

  it('정상 보고서는 오류가 없다', () => {
    expect(validateReport(validReport(), items, contract)).toEqual([])
  })

  for (const f of rendered) {
    for (const [label, damage] of strategies(f)) {
      it(`${f.path} — ${label}`, () => {
        const r = validReport()
        damage(r)
        expect(validateReport(r, items, contract), `${f.path} 훼손이 통과됨`).not.toEqual([])
      })
    }
  }

  // REQ-12.6 — 계약에 행을 추가하면 거부 테스트가 자동으로 늘어난다.
  // 그러려면 렌더되는 모든 행이 최소 하나의 훼손 전략을 가져야 한다.
  it('렌더되는 모든 계약 행이 최소 하나의 거부 테스트를 만든다 (REQ-12.6)', () => {
    const barren = rendered.filter((f) => strategies(f).length === 0)
    expect(barren.map((f) => f.path), '거부 테스트가 생성되지 않는 계약 행').toEqual([])
    expect(rendered.reduce((n, f) => n + strategies(f).length, 0)).toBeGreaterThan(200)
  })

  // REQ-8.12 — 검증기·렌더러·테스트가 모두 같은 한 파일을 읽는다
  it('loadContract() 가 edusafe/rules/report.contract.json 을 그대로 읽는다 (REQ-8.12)', () => {
    const onDisk = JSON.parse(readFileSync('edusafe/rules/report.contract.json', 'utf8'))
    expect(loadContract()).toEqual(onDisk)
  })

  it('허용되지 않은 키를 거부한다', () => {
    const r = validReport()
    r.items[0].새로운필드 = '검증되지 않는 값'
    expect(validateReport(r, items, contract).join(' ')).toMatch(/허용되지 않은 필드/)
  })

  it('negative_scan 근거에서 rules 를 빼면 거부한다', () => {
    const r = validReport()
    r.items[0].evidence = [{ type: 'negative_scan', source: 'scanner' }]
    expect(validateReport(r, items, contract).join(' ')).toMatch(/evidence/)
  })

  it('quote 근거에 negative_scan 전용 키를 넣으면 거부한다', () => {
    const r = validReport()
    r.items[0].evidence = [{ ...QUOTE, rules: ['y'] }]
    expect(validateReport(r, items, contract).join(' ')).toMatch(/evidence/)
  })

  it('needs_human 소계 합이 total 과 다르면 거부한다', () => {
    const r = validReport()
    r.summary.needs_human.coverage += 1
    expect(validateReport(r, items, contract).join(' ')).toMatch(/needs_human/)
  })

  it('하위 점검이 하나라도 빠지면 거부한다 (REQ-8.14)', () => {
    const r = validReport()
    r.items[0].subchecks.pop()
    expect(validateReport(r, items, contract).join(' ')).toMatch(/하위 점검/)
  })

  it('하위 점검 개수는 같고 id 만 다르면 거부한다', () => {
    const r = validReport()
    r.items[0].subchecks[0].id = 'made-up-subcheck'
    expect(validateReport(r, items, contract).join(' ')).toMatch(/하위 점검/)
  })

  it('na 인데 verification_level 이 none 이 아니면 거부한다 (REQ-7.25)', () => {
    const r = validReport()
    r.items[0].verification_level = 'verified'
    expect(validateReport(r, items, contract).join(' ')).toMatch(/verification_level/)
  })

  it('pass 인데 근거가 없으면 거부한다 (REQ-7.7)', () => {
    const r = validReport()
    r.items[1].verdict = 'pass'
    r.items[1].verification_level = 'verified'
    r.items[1].evidence = []
    expect(validateReport(r, items, contract).join(' ')).toMatch(/근거가 없습니다/)
  })

  it('na 인데 applicability_reason 이 null 이면 거부한다 (REQ-7.10)', () => {
    const r = validReport()
    r.items[0].applicability_reason = null
    expect(validateReport(r, items, contract).join(' ')).toMatch(/applicability_reason/)
  })

  it('인용이 200자를 넘으면 거부한다 (REQ-7.12)', () => {
    const r = validReport()
    r.items[0].evidence = [{ ...QUOTE, quote: 'x'.repeat(201) }]
    expect(validateReport(r, items, contract).join(' ')).toMatch(/200자/)
  })

  it('근거가 항목당 4개를 넘으면 거부한다 (REQ-7.12)', () => {
    const r = validReport()
    r.items[0].evidence = [QUOTE, QUOTE, QUOTE, QUOTE, QUOTE]
    expect(validateReport(r, items, contract).join(' ')).toMatch(/4개 이내/)
  })

  it('§6 문안을 고치면 거부한다', () => {
    const r = validReport()
    r.items[0].why_risky = '내가 다듬은 문장'
    expect(validateReport(r, items, contract).join(' ')).toMatch(/§6 문안/)
  })

  it('서식1 상태가 재계산과 다르면 거부한다 (REQ-8.22)', () => {
    const r = validReport()
    r.moe_checklist[0].status = '충족'
    expect(validateReport(r, items, contract).join(' ')).toMatch(/moe_checklist/)
  })

  it('버전이 version.json 과 다르면 거부한다', () => {
    const r = validReport()
    r.edusafe_version = '9.9.9'
    expect(validateReport(r, items, contract).join(' ')).toMatch(/edusafe_version/)
  })
})
