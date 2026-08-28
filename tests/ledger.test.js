import { describe, it, expect } from 'vitest'
import { saveRecord, listRecords, deleteRecord, targetKey } from '../src/lib/ledger.js'

const memStorage = () => {
  const m = new Map()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }
}

describe('심사 기록 대장 (여유)', () => {
  it('같은 대상 재심사는 회차가 올라간다', () => {
    const s = memStorage()
    const target = targetKey({ owner: 'u', repo: 'app', commitSha: 'abc' })
    const r1 = saveRecord({ target, status: 'hold', savedAt: '2026-08-28T21:00:00' }, s)
    const r2 = saveRecord({ target, status: 'pass_candidate', savedAt: '2026-08-28T22:00:00' }, s)
    expect(r1.round).toBe(1)
    expect(r2.round).toBe(2)
    expect(listRecords(s)[0].status).toBe('pass_candidate')
  })

  it('삭제와 빈 저장소 처리', () => {
    const s = memStorage()
    const r = saveRecord({ target: 't', savedAt: 'x' }, s)
    deleteRecord(r.id, s)
    expect(listRecords(s)).toEqual([])
  })
})
