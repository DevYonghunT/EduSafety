import { describe, it, expect } from 'vitest'
import { buildAiPayloadChunks } from '../src/lib/redact.js'
import { mergeJudgments } from '../src/lib/reviewAi.js'

const f = (path, text) => ({ path, name: path.split('/').pop(), text })

describe('분할 분석 — 원칙 8 개정 (호출 한도 초과 시 나눠서 전부 검토)', () => {
  it('호출 한도를 넘으면 여러 묶음으로 나눠 전부 포함한다', () => {
    const files = [
      f('index.html', 'a'.repeat(500)),
      f('src/app.js', 'b'.repeat(500)),
      f('src/big.js', 'c'.repeat(500)),
    ]
    const { chunks, includedFiles, excludedFiles, coveragePercent } = buildAiPayloadChunks(files, 800, 3)
    expect(chunks.length).toBeGreaterThan(1)
    expect(includedFiles).toHaveLength(3)
    expect(excludedFiles).toHaveLength(0)
    expect(coveragePercent).toBe(100)
  })

  it('분할 한도(최대 묶음 수)를 넘는 파일만 제외 + 사유 고지', () => {
    const files = [f('a.js', 'x'.repeat(700)), f('b.js', 'y'.repeat(700)), f('c.js', 'z'.repeat(700))]
    const { chunks, excludedFiles } = buildAiPayloadChunks(files, 800, 2)
    expect(chunks).toHaveLength(2)
    expect(excludedFiles).toHaveLength(1)
    expect(excludedFiles[0].reason).toContain('분할 한도')
  })

  it('데이터 파일 고지는 모든 묶음에 붙는다', () => {
    const files = [f('a.js', 'x'.repeat(700)), f('b.js', 'y'.repeat(700)), f('data/명단.csv', '김민준,010')]
    const { chunks } = buildAiPayloadChunks(files, 800, 3)
    for (const c of chunks) {
      expect(c).toContain('data/명단.csv')
      expect(c).not.toContain('010')
    }
  })
})

describe('판정 병합 — fail(위반 증거) > ok(충족 증거) > 판단불가 > 해당없음', () => {
  const items = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }]
  const j = (verdict, extra = {}) => ({ verdict, reason: 'r', evidence: [], ...extra })

  it('한 묶음이라도 위반 증거를 찾으면 미충족, 충족 증거는 판단불가를 이긴다', () => {
    const chunk1 = {
      judgments: { A: j('ok'), B: j('needs_human'), C: j('needs_human'), D: j('na') },
      demoted: [], filled: ['C'],
    }
    const chunk2 = {
      judgments: { A: j('fail', { evidence: [{ file: 'x.js', quote: 'bad()' }] }), B: j('ok'), C: j('needs_human', { demoted: true }), D: j('na') },
      demoted: ['C'], filled: [],
    }
    const { judgments, demoted, filled } = mergeJudgments([chunk1, chunk2], items)
    expect(judgments.A.verdict).toBe('fail')
    expect(judgments.A.evidence).toHaveLength(1)
    expect(judgments.B.verdict).toBe('ok')
    expect(judgments.C.verdict).toBe('needs_human')
    expect(judgments.D.verdict).toBe('na')
    expect(demoted).toEqual(['C'])
    expect(filled).toEqual([])
  })

  it('묶음이 하나면 그대로 통과', () => {
    const only = { judgments: { A: j('ok') }, demoted: [], filled: [] }
    expect(mergeJudgments([only], items)).toBe(only)
  })
})
