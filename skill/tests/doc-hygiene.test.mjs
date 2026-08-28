import { describe, it, expect } from 'vitest'
import { readSpec, readPlan, specStepTable, specRuleIds, planTasks } from './helpers/spec-parse.mjs'

const spec = readSpec()
const plan = readPlan()

// 드라이브 문자 절대경로. 뒤에 실제 경로 문자가 와야 매치된다 —
// REQ-0.7 이 예시로 쓴 `C:\…`(말줄임표)는 걸리지 않는다.
const DRIVE_PATH = /\b[A-Za-z]:[\/][A-Za-z0-9._-]/g

describe('문서 위생', () => {
  it('⑩ 두 문서에 드라이브 문자 절대경로가 없다', () => {
    for (const [name, text] of [['spec', spec], ['plan', plan]]) {
      const hits = text.match(DRIVE_PATH) || []
      expect(hits, `${name} 에 저장소 밖 절대경로: ${hits.join(', ')}`).toEqual([])
    }
  })

  it('⑪ 대기·승인이 있는 단계는 "사람이 없을 때"가 정의돼 있다', () => {
    const rows = specStepTable(spec)
    expect(rows.length).toBeGreaterThan(0)
    const bad = rows
      .filter((r) => r.waits.includes('있음'))
      .filter((r) => !r.headless || r.headless === '—' || r.headless === '')
    expect(bad.map((r) => r.step), '무인 동작이 정의되지 않은 대기 지점').toEqual([])
  })

  it('⑫ spec §9·§9.1 의 규칙 id 48개가 전부 Task 2 에 정규식 또는 판정 함수와 함께 등장한다', () => {
    const ids = specRuleIds(spec)
    expect(ids).toHaveLength(48)
    const task2 = planTasks(plan).find((t) => t.n === 2).body

    // id 가 적힌 줄부터 그 객체 블록이 끝나는 "  }," 까지를 잘라, 그 안에 pattern 또는 check 가 있는지 본다.
    const blockOf = (id) => {
      const at = task2.search(new RegExp(`id: ["']${id}["']`))
      if (at < 0) return null
      const rest = task2.slice(at)
      const end = rest.search(/\n  \},/)
      return end < 0 ? rest : rest.slice(0, end)
    }

    const missing = ids.filter((id) => blockOf(id) === null)
    expect(missing, `Task 2 에 없는 규칙: ${missing.join(', ')}`).toEqual([])

    const noImpl = ids.filter((id) => !/\bpattern:|\bcheck\(/.test(blockOf(id)))
    expect(noImpl, `정규식도 판정 함수도 없는 규칙: ${noImpl.join(', ')}`).toEqual([])
  })
})
