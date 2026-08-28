import { describe, it, expect } from 'vitest'
import { buildSupplementRequest, classifyCause } from '../src/lib/supplementRequest.js'
import { computeSummary } from '../src/lib/reviewSummary.js'

const repoMeta = { owner: 'user', repo: 'app', branch: 'main', commitSha: 'abc123def4567890' }
const gateFail = { checks: [{ id: 'db-config', pass: false }] }
const gateOk = { checks: [{ id: 'db-config', pass: true }] }

describe('보완 요청서 — 원인별 3분류 (여유)', () => {
  it('수동 항목은 운영 증빙, 게이트 미비+접근 카테고리는 자료, 나머지는 코드 설명', () => {
    const manual = { id: 'H-x', aiVerifiable: false, category: 'notice' }
    const dbItem = { id: 'R-db', aiVerifiable: true, category: 'access' }
    const codeItem = { id: 'S-y', aiVerifiable: true, category: 'code' }
    expect(classifyCause(manual, {}, gateOk)).toBe('evidence')
    expect(classifyCause(dbItem, {}, gateFail)).toBe('materials')
    expect(classifyCause(dbItem, {}, gateOk)).toBe('clarify')
    expect(classifyCause(codeItem, {}, gateFail)).toBe('clarify')
  })

  it('판단불가 항목만 모아 요청문을 생성한다', () => {
    const summary = computeSummary('admin', {}, {}, {})
    const { text, count, buckets } = buildSupplementRequest({
      repoMeta, summary, judgments: {}, overrides: {}, humanInputs: {}, gate: gateFail,
    })
    expect(count).toBe(summary.items.length)
    expect(text).toContain('심사 보완 요청서')
    expect(text).toContain('user/app (커밋 abc123def456)')
    expect(buckets.evidence.length).toBeGreaterThan(0)
    expect(buckets.materials.length).toBeGreaterThan(0)
  })

  it('판단불가가 없으면 요청 0건', () => {
    const summary = computeSummary('admin', {}, {}, {})
    const overrides = Object.fromEntries(summary.items.map((it) => [it.id, { verdict: 'ok' }]))
    const { count } = buildSupplementRequest({ repoMeta, summary, judgments: {}, overrides, humanInputs: {}, gate: gateOk })
    expect(count).toBe(0)
  })
})
