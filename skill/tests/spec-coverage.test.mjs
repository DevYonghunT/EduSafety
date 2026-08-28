import { describe, it, expect } from 'vitest'
import { readSpec, readPlan, specReqs, planTasks } from './helpers/spec-parse.mjs'

const spec = readSpec()
const plan = readPlan()
const reqs = specReqs(spec)
const tasks = planTasks(plan)
const assigned = new Set(tasks.flatMap((t) => t.implements))

describe('REQ 커버리지', () => {
  it('① spec 의 모든 REQ 가 어떤 Task 에 할당돼 있다', () => {
    const missing = [...reqs.keys()].filter((r) => !assigned.has(r))
    expect(missing, `구현 계획에 할당되지 않은 REQ: ${missing.join(', ')}`).toEqual([])
  })

  it('② 구현 계획이 참조한 REQ 가 spec 에 실재한다', () => {
    const ghosts = [...assigned].filter((r) => !reqs.has(r))
    expect(ghosts, `spec 에 없는 REQ 를 참조함: ${ghosts.join(', ')}`).toEqual([])
  })

  it('③ 전사 인용문이 spec 원문과 문자열이 일치한다', () => {
    const diffs = []
    for (const t of tasks) {
      for (const r of t.implements) {
        if (!t.quotes.has(r)) { diffs.push(`Task ${t.n}: ${r} 전사 누락`); continue }
        if (t.quotes.get(r) !== reqs.get(r)) diffs.push(`Task ${t.n}: ${r} 전사가 원문과 다름`)
      }
    }
    expect(diffs, diffs.join('\n')).toEqual([])
  })

  it('Task 는 0~9 가 모두 있다', () => {
    expect(tasks.map((t) => t.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
})
