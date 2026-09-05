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

  it('폴더 제출은 폴더명이 같아도 지문이 다르면 다른 대상이다', () => {
    const a = targetKey({ source: 'folder', name: 'myapp', fingerprint: 'a'.repeat(64) })
    const b = targetKey({ source: 'folder', name: 'myapp', fingerprint: 'b'.repeat(64) })
    expect(a).not.toBe(b)
    expect(a).toBe(targetKey({ source: 'folder', name: 'myapp', fingerprint: 'a'.repeat(64) }))
  })

  it('삭제와 빈 저장소 처리', () => {
    const s = memStorage()
    const r = saveRecord({ target: 't', savedAt: 'x' }, s)
    deleteRecord(r.id, s)
    expect(listRecords(s)).toEqual([])
  })
})

describe('서버 대장 동기화', () => {
  const entry = { target: 'u/app', commitSha: 'a'.repeat(40), status: 'hold', rubricVersion: 'core-1', protectionLevel: 'L1', profile: 'p', savedAt: 'x' }
  const json = (status, body) => ({ status, ok: status < 400, json: async () => body })

  it('관리자 세션이 없으면 로컬만 저장하고 이유를 알린다', async () => {
    const { syncRecordToServer } = await import('../src/lib/ledger.js')
    const fetchImpl = async () => json(401, {})
    expect(await syncRecordToServer(entry, fetchImpl)).toEqual({ synced: false, reason: 'login' })
  })

  it('세션이 있으면 CSRF 토큰을 붙여 저장하고 서버 회차를 돌려준다', async () => {
    const { syncRecordToServer } = await import('../src/lib/ledger.js')
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url, init })
      if (url === '/api/admin/session') return json(200, { csrfToken: 'tok' })
      return json(201, { record: { id: 'r1', round: 2 } })
    }
    const result = await syncRecordToServer(entry, fetchImpl)
    expect(result).toEqual({ synced: true, id: 'r1', round: 2 })
    expect(calls[1].init.headers['x-csrf-token']).toBe('tok')
    expect(JSON.parse(calls[1].init.body)).toMatchObject({ target: 'u/app', commitSha: 'a'.repeat(40), record: entry })
  })

  it('서버 대장 테이블이 없으면(503) 로컬만 유지', async () => {
    const { syncRecordToServer } = await import('../src/lib/ledger.js')
    const fetchImpl = async (url) => (url === '/api/admin/session' ? json(200, { csrfToken: 't' }) : json(503, {}))
    expect(await syncRecordToServer(entry, fetchImpl)).toEqual({ synced: false, reason: 'unavailable' })
  })
})
