import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { readSpec, specContract } from './helpers/spec-parse.mjs'

const doc = specContract(readSpec())
const impl = JSON.parse(readFileSync('edusafe/rules/report.contract.json', 'utf8'))

const joinPath = (p, k) => `${p}.${k}`
const docBy = new Map(doc.fields.map((f) => [f.path, f]))
const implBy = new Map(impl.fields.map((f) => [f.path, f]))

describe('⑥ spec §8.3 ↔ report.contract.json', () => {
  it('필드 경로 집합이 양방향으로 같다', () => {
    expect(impl.fields.map((f) => f.path).sort()).toEqual(doc.fields.map((f) => f.path).sort())
  })

  it('경로가 중복되지 않는다', () => {
    expect(implBy.size).toBe(impl.fields.length)
    expect(docBy.size).toBe(doc.fields.length)
  })

  it('경로별 타입·필수·제약·허용값·키·원소필수키·검증·렌더가 문서와 일치한다', () => {
    const diffs = []
    for (const f of impl.fields) {
      const d = docBy.get(f.path)
      const eq = (k, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${f.path}.${k}: 문서=${JSON.stringify(a)} 구현=${JSON.stringify(b)}`) }
      eq('type', d.type, f.type)
      eq('required', d.required, f.required)
      eq('spec_constraint', d.spec_constraint, f.spec_constraint)
      eq('allowed', d.allowed, f.allowed)
      eq('keys', d.keys, f.keys)
      eq('element_required', d.element_required, f.element_required)
      eq('validated_by', d.validated_by, f.validated_by)
      eq('rendered_in', d.rendered_in, f.rendered_in)
    }
    expect(diffs, diffs.join('\n')).toEqual([])
  })

  it('§8.3.5 evidence 판별 표가 문서와 일치한다', () => {
    expect(impl.evidence_types).toEqual(doc.evidence_types)
  })

  // REQ-8.11
  it('렌더 위치가 있는 모든 행은 검증 방법이 있다', () => {
    const bad = impl.fields.filter((f) => f.rendered_in.length > 0 && f.validated_by.length === 0)
    expect(bad.map((f) => f.path), '검증 없이 렌더되는 필드').toEqual([])
  })

  // REQ-8.25
  it('부모 키 목록의 키 중 렌더되는 것은 자체 행을 갖는다', () => {
    const orphans = []
    for (const f of impl.fields) {
      if (!f.keys || f.rendered_in.length === 0) continue
      for (const k of f.keys) if (!implBy.has(joinPath(f.path, k))) orphans.push(joinPath(f.path, k))
    }
    expect(orphans, '렌더되는데 자체 계약 행이 없는 키').toEqual([])
  })

  // REQ-8.26
  it('계약에 opaque 개념이 없다', () => {
    expect(impl.fields.some((f) => 'children' in f)).toBe(false)
  })

  // REQ-8.29 — 원소 필수 키는 원소 행의 키 목록에서 온다. 같은 목록을 두 곳에 적지 않는다.
  it('배열 행의 element_required 가 원소 행의 keys 와 같다', () => {
    const diffs = []
    for (const f of impl.fields) {
      if (!f.element_required) continue
      const m = f.spec_constraint.match(/원소는 (.+?) 행/)
      expect(m, `${f.path}: 원소 행 지시가 없습니다`).toBeTruthy()
      const el = implBy.get(m[1].trim())
      if (!el) { diffs.push(`${f.path}: 원소 행 ${m[1]} 없음`); continue }
      if (JSON.stringify(el.keys) !== JSON.stringify(f.element_required)) {
        diffs.push(`${f.path}: element_required 가 ${el.path}.keys 와 다름`)
      }
    }
    expect(diffs, diffs.join('\n')).toEqual([])
  })

  it('계약 버전이 version.json 과 맞물린다', () => {
    const version = JSON.parse(readFileSync('edusafe/rules/version.json', 'utf8'))
    expect(impl.schema_version).toBe(version.schema_version)
  })
})
