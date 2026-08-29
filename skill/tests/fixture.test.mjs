import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { rules, projectRules } from '../edusafe/rules/scan-rules.mjs'

const FIXTURE = 'fixtures/vulnerable-app'
const golden = JSON.parse(readFileSync('fixtures/golden.json', 'utf8'))
const items = JSON.parse(readFileSync('edusafe/rules/items.json', 'utf8')).items
const allRules = [...rules, ...projectRules]

let outDir
let scan

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'edusafe-fixture-'))
  const out = join(outDir, 'scan.json')
  execFileSync(process.execPath, ['edusafe/scripts/scan.mjs', FIXTURE, out], { stdio: 'pipe' })
  scan = JSON.parse(readFileSync(out, 'utf8'))
})

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})

// REQ-12.1 — 부재 증명 항목은 픽스처에 신호가 없으면 스캐너가 고장 나 있어도 pass 한다.
// 항목마다 최소 하나의 신호를 심고 1:1 로 묶어 그 자리를 없앤다.
describe('부재 증명 항목 ↔ 픽스처 신호 1:1', () => {
  it('부재 증명 항목 전수에 골든 신호가 정의돼 있다', () => {
    const absence = items.filter((i) => i.absence_proof).map((i) => i.id)
    expect(absence.sort()).toEqual(Object.keys(golden.absence_proof_signals).sort())
  })

  it('신호로 지정한 규칙이 실제로 hit 한다', () => {
    const hit = new Set(scan.hits.map((h) => h.rule))
    const dead = []
    for (const [item, ruleIds] of Object.entries(golden.absence_proof_signals)) {
      if (!ruleIds.some((r) => hit.has(r))) dead.push(`${item}: ${ruleIds.join('/')} 중 hit 없음`)
    }
    expect(dead, dead.join('\n')).toEqual([])
  })

  it('신호로 지정한 규칙이 그 항목을 가리킨다', () => {
    const bad = []
    for (const [item, ruleIds] of Object.entries(golden.absence_proof_signals)) {
      for (const id of ruleIds) {
        const r = allRules.find((x) => x.id === id)
        if (!r) bad.push(`${id} 규칙이 없음`)
        else if (r.item !== item) bad.push(`${id} 는 ${r.item} 을 가리킴 (${item} 아님)`)
      }
    }
    expect(bad, bad.join('\n')).toEqual([])
  })
})

describe('골든 스캔 대조', () => {
  it('expect_items 가 37개 전수다', () => {
    expect(Object.keys(golden.expect_items).sort()).toEqual(items.map((i) => i.id).sort())
  })

  it('expect_items 의 값이 판정값 4개 중 하나다', () => {
    const bad = Object.entries(golden.expect_items)
      .filter(([, v]) => !['pass', 'fail', 'na', 'needs_human'].includes(v))
    expect(bad).toEqual([])
  })

  it('must_hit 이 전부 hit 한다', () => {
    const hit = new Set(scan.hits.map((h) => h.rule))
    const missing = golden.expect_scan.must_hit.filter((r) => !hit.has(r))
    expect(missing, `hit 하지 않은 must_hit 규칙: ${missing.join(', ')}`).toEqual([])
  })

  it('must_not_hit 이 하나도 hit 하지 않는다', () => {
    const hit = new Set(scan.hits.map((h) => h.rule))
    const wrong = golden.expect_scan.must_not_hit.filter((r) => hit.has(r))
    expect(wrong, `hit 하면 안 되는 규칙이 hit 함: ${wrong.join(', ')}`).toEqual([])
  })

  it('골든에 적힌 규칙 id 가 전부 실재한다', () => {
    const known = new Set(allRules.map((r) => r.id))
    const ghosts = [...golden.expect_scan.must_hit, ...golden.expect_scan.must_not_hit]
      .filter((r) => !known.has(r))
    expect(ghosts).toEqual([])
  })

  it('must_hit 규칙이 스택 필터로 걸러지지 않고 실제로 실행된다', () => {
    // 픽스처에 package.json 이 없으면 supabase·vite-react 스택이 감지되지 않아
    // supabase-select-star·dangerously-set-inner-html 이 아예 돌지 않는다(실측).
    const ran = new Set(scan.rules_run)
    const notRun = golden.expect_scan.must_hit.filter((r) => !ran.has(r))
    expect(notRun, `스택 필터에 걸려 실행되지 않은 must_hit 규칙: ${notRun.join(', ')}`).toEqual([])
  })

  it('픽스처에서 네 스택이 모두 감지된다', () => {
    expect([...scan.stacks_detected].sort()).toEqual(['firebase', 'html', 'supabase', 'vite-react'])
  })
})
