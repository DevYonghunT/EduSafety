import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { readSpec, specCategories } from './helpers/spec-parse.mjs'

const data = JSON.parse(readFileSync('edusafe/rules/items.json', 'utf8'))
const version = JSON.parse(readFileSync('edusafe/rules/version.json', 'utf8'))
const items = data.items

const METHODS = ['scanner', 'code', 'evidence', 'teacher']
const COVERAGE = ['scanner', 'history', 'build', 'code', 'evidence', 'teacher']
const STACKS = ['html', 'vite-react', 'nextjs', 'firebase', 'supabase']
const ABSENCE_PROOF = ['R-rrn', 'R-secrets', 'R-admin-data', 'S-injection', 'S-https', 'S-tracking', 'S-log-pii']

describe('items.json 무결성', () => {
  it('항목 id 가 유일하다', () => {
    const ids = items.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('하위 점검 id 가 항목 안에서 유일하다', () => {
    const dups = []
    for (const it of items) {
      const ids = it.subchecks.map((s) => s.id)
      if (new Set(ids).size !== ids.length) dups.push(it.id)
    }
    expect(dups, `하위 점검 id 중복: ${dups.join(', ')}`).toEqual([])
  })

  it('category 는 1~8, base_severity 는 high/medium/low 다', () => {
    const bad = items.filter(
      (i) => !Number.isInteger(i.category) || i.category < 1 || i.category > 8 ||
             !['high', 'medium', 'low'].includes(i.base_severity),
    )
    expect(bad.map((i) => i.id)).toEqual([])
  })

  it('중요도 분포가 상 14 · 중 18 · 하 5 다', () => {
    const count = (s) => items.filter((i) => i.base_severity === s).length
    expect({ high: count('high'), medium: count('medium'), low: count('low') })
      .toEqual({ high: 14, medium: 18, low: 5 })
  })

  it('methods 는 정해진 4개 중에서만 쓴다', () => {
    const bad = []
    for (const it of items) {
      if (!Array.isArray(it.methods) || it.methods.length === 0) { bad.push(`${it.id}: methods 없음`); continue }
      for (const m of it.methods) if (!METHODS.includes(m)) bad.push(`${it.id}: ${m}`)
    }
    expect(bad, bad.join('\n')).toEqual([])
  })

  it('required_coverage 는 정해진 6개 중에서만 쓴다', () => {
    const bad = []
    for (const it of items) {
      for (const s of it.subchecks) {
        if (!Array.isArray(s.required_coverage) || s.required_coverage.length === 0) {
          bad.push(`${it.id}.${s.id}: required_coverage 없음`); continue
        }
        for (const c of s.required_coverage) if (!COVERAGE.includes(c)) bad.push(`${it.id}.${s.id}: ${c}`)
      }
    }
    expect(bad, bad.join('\n')).toEqual([])
  })

  it('stacks 는 "all" 이거나 정해진 스택의 부분집합이다', () => {
    const bad = []
    for (const it of items) {
      for (const s of it.subchecks) {
        if (s.stacks === 'all') continue
        if (!Array.isArray(s.stacks) || s.stacks.length === 0) { bad.push(`${it.id}.${s.id}: stacks 형식 오류`); continue }
        for (const k of s.stacks) if (!STACKS.includes(k)) bad.push(`${it.id}.${s.id}: ${k}`)
      }
    }
    expect(bad, bad.join('\n')).toEqual([])
  })

  it('basis·why_risky·fix_hint 가 비어 있지 않다', () => {
    const bad = []
    for (const it of items) {
      for (const k of ['basis', 'why_risky', 'fix_hint', 'question']) {
        if (typeof it[k] !== 'string' || it[k].trim() === '') bad.push(`${it.id}.${k}`)
      }
      if (typeof it.applicability?.na_when !== 'string' || it.applicability.na_when.trim() === '') {
        bad.push(`${it.id}.applicability.na_when`)
      }
    }
    expect(bad, bad.join('\n')).toEqual([])
  })

  it('absence_proof: true 인 항목이 7개이고 그 목록이 정확하다', () => {
    const got = items.filter((i) => i.absence_proof === true).map((i) => i.id).sort()
    expect(got).toEqual([...ABSENCE_PROOF].sort())
  })

  it('version.json 과 items.json 의 rubric_version 이 같다', () => {
    expect(data.rubric_version).toBe(version.rubric_version)
    expect(data.schema_version).toBe(version.schema_version)
  })
})

// REQ-10.2(줄바꿈 LF 고정) · REQ-13.3(버전 정본)
describe('스캐폴드 규범', () => {
  it('REQ-10.2 — .gitattributes 가 줄바꿈을 LF 로 고정한다', () => {
    const attrs = readFileSync('.gitattributes', 'utf8')
    expect(attrs).toContain('* text=auto eol=lf')
  })

  it('REQ-10.2 — rules/ 의 데이터 파일에 CRLF 가 없다', () => {
    const bad = ['edusafe/rules/items.json', 'edusafe/rules/version.json']
      .filter((p) => readFileSync(p, 'utf8').includes(String.fromCharCode(13)))
    expect(bad, `CRLF 가 섞인 파일: ${bad.join(', ')}`).toEqual([])
  })

  it('REQ-13.3 — 버전 정본은 rules/version.json 이며 세 값을 갖는다', () => {
    expect(Object.keys(version).sort()).toEqual(['edusafe_version', 'rubric_version', 'schema_version'])
    for (const v of Object.values(version)) expect(typeof v).toBe('string')
    expect(version.edusafe_version).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

// spec §6 의 카테고리 소제목 ↔ items.json 의 categories
describe('④ 카테고리 제목 동기화', () => {
  it('카테고리 8개가 spec §6 소제목과 일치한다', () => {
    expect(data.categories).toEqual(specCategories(readSpec()))
    expect(data.categories).toHaveLength(8)
    expect(data.categories.map((c) => c.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('모든 항목의 category 가 정의된 카테고리를 가리킨다', () => {
    const known = new Set(data.categories.map((c) => c.number))
    expect(items.filter((i) => !known.has(i.category)).map((i) => i.id)).toEqual([])
  })
})
