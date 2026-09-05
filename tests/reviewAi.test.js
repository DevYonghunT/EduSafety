import { describe, it, expect } from 'vitest'
import { validateJudgments, deriveProtectionLevel, extractJson, estimateCost, addUsage, emptyUsage } from '../src/lib/reviewAi.js'
import { redactSecrets, buildAiPayload } from '../src/lib/redact.js'

const files = [
  { path: 'src/app.js', name: 'app.js', text: 'const name = prompt("이름 입력")\nlocalStorage.setItem("students", name)' },
  { path: 'index.html', name: 'index.html', text: '<meta charset="utf-8">' },
]
const items = [
  { id: 'R-a', type: 'required', aiVerifiable: true },
  { id: 'S-b', type: 'scored', aiVerifiable: true },
  { id: 'S-c', type: 'scored', aiVerifiable: true },
]

describe('검증·강등 — 원칙 1·2 (T6)', () => {
  it('원칙 1: 근거 인용 없는 충족/미충족은 판단불가로 강등', () => {
    const raw = { judgments: [
      { id: 'R-a', verdict: 'fail', reason: '근거 없음', evidence: [] },
      { id: 'S-b', verdict: 'ok', reason: '지어낸 인용', evidence: [{ file: 'src/app.js', quote: '존재하지 않는 코드조각' }] },
      { id: 'S-c', verdict: 'ok', reason: '실제 인용', evidence: [{ file: 'src/app.js', quote: 'localStorage.setItem("students", name)' }] },
    ] }
    const { judgments, demoted } = validateJudgments(raw, items, files)
    expect(judgments['R-a'].verdict).toBe('needs_human')
    expect(judgments['S-b'].verdict).toBe('needs_human')
    expect(judgments['S-c'].verdict).toBe('ok')
    expect(demoted).toEqual(['R-a', 'S-b'])
  })

  it('원칙 2: AI 응답에서 누락된 항목은 판단불가로 채운다', () => {
    const raw = { judgments: [{ id: 'S-b', verdict: 'na', reason: '해당없음' }] }
    const { judgments, filled } = validateJudgments(raw, items, files)
    expect(judgments['R-a'].verdict).toBe('needs_human')
    expect(judgments['S-c'].verdict).toBe('needs_human')
    expect(filled).toEqual(['R-a', 'S-c'])
    expect(judgments['S-b'].verdict).toBe('na')
  })

  it('원칙 3 보강: 필수 항목의 해당없음은 심사자 확인(판단불가)으로 내린다 — 전부 na로 합격 후보 만들기 차단', () => {
    const raw = { judgments: [
      { id: 'R-a', verdict: 'na', reason: '해당없음' },
      { id: 'S-b', verdict: 'na', reason: '해당없음' },
      { id: 'S-c', verdict: 'na', reason: '해당없음' },
    ] }
    const { judgments, demoted } = validateJudgments(raw, items, files)
    expect(judgments['R-a'].verdict).toBe('needs_human')
    expect(demoted).toEqual(['R-a'])
    expect(judgments['S-b'].verdict).toBe('na')
  })

  it('원칙 1 보강: 인용은 AI가 지목한 파일 안에서만 인정, 8자 미만·다른 파일 인용은 강등', () => {
    const raw = { judgments: [
      { id: 'R-a', verdict: 'ok', reason: '다른 파일 인용', evidence: [{ file: 'index.html', quote: 'localStorage.setItem("students", name)' }] },
      { id: 'S-b', verdict: 'ok', reason: '짧은 인용', evidence: [{ file: 'src/app.js', quote: 'name' }] },
      { id: 'S-c', verdict: 'fail', reason: '경로 표기 차이', evidence: [{ file: './src/app.js', quote: 'prompt("이름 입력")' }] },
    ] }
    const { judgments, demoted } = validateJudgments(raw, items, files)
    expect(judgments['R-a'].verdict).toBe('needs_human')
    expect(judgments['S-b'].verdict).toBe('needs_human')
    expect(judgments['S-c'].verdict).toBe('fail')
    expect(demoted).toEqual(['R-a', 'S-b'])
  })

  it('엉뚱한 verdict 값·깨진 응답도 판단불가로 수렴', () => {
    const raw = { judgments: [{ id: 'R-a', verdict: '통과!' }, null, { noId: true }] }
    const { judgments } = validateJudgments(raw, items, files)
    expect(judgments['R-a'].verdict).toBe('needs_human')
  })
})

describe('AI 전송 전 마스킹·선별 — 원칙 7·8 (T6)', () => {
  it('원칙 7: 비밀키는 마스킹 후 전송', () => {
    const key = 'sk-ant-' + 'a'.repeat(30)
    const out = redactSecrets(`const k = "${key}"`)
    expect(out).not.toContain(key)
    expect(out).toContain('****')
  })

  it('원칙 7: 데이터 파일은 내용 미전송, 존재만 고지', () => {
    const withData = [...files, { path: 'data/students.csv', name: 'students.csv', text: '김민준,010-1234-5678' }]
    const { payloadText, excludedFiles, dataFiles } = buildAiPayload(withData)
    expect(payloadText).not.toContain('010-1234-5678')
    expect(payloadText).toContain('data/students.csv')
    expect(dataFiles).toEqual(['data/students.csv'])
    expect(excludedFiles[0].reason).toContain('데이터 파일')
  })

  it('원칙 8: 상한 초과 시 후순위(잠금파일)부터 제외 + 커버리지 고지', () => {
    const big = [
      { path: 'package-lock.json', name: 'package-lock.json', text: 'x'.repeat(900) },
      { path: 'src/app.js', name: 'app.js', text: 'y'.repeat(500) },
      { path: 'index.html', name: 'index.html', text: 'z'.repeat(100) },
    ]
    const { includedFiles, excludedFiles, coveragePercent } = buildAiPayload(big, 800)
    expect(includedFiles).toContain('src/app.js')
    expect(includedFiles).toContain('index.html')
    expect(excludedFiles.map((e) => e.path)).toContain('package-lock.json')
    expect(coveragePercent).toBe(67)
  })
})

describe('보호 수준 도출 + JSON 추출 (T6)', () => {
  it('보호 수준은 기능에서 결정적으로 도출된다', () => {
    expect(deriveProtectionLevel({})).toBe('L0')
    expect(deriveProtectionLevel({ collectsPersonalInfo: true })).toBe('L1')
    expect(deriveProtectionLevel({ handlesRealData: true })).toBe('L1')
    expect(deriveProtectionLevel({ collectsPersonalInfo: true, hasAssessmentOrCompetition: true })).toBe('L2')
    expect(deriveProtectionLevel({ collectsSensitiveInfo: true })).toBe('L2')
  })

  it('extractJson — 코드펜스·잡담 섞인 응답에서 JSON만 추출', () => {
    expect(extractJson('결과는 다음과 같습니다.\n```json\n{"a": 1}\n```')).toEqual({ a: 1 })
    expect(extractJson('{"b": [1,2]} 끝')).toEqual({ b: [1, 2] })
    expect(() => extractJson('JSON 없음')).toThrow()
  })
})

describe('비용 집계 (심사 1건 비용 고지)', () => {
  it('모델 단가로 토큰 사용량을 달러로 환산하고 누적한다', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    expect(estimateCost(usage, 'claude-opus-5')).toBeCloseTo(5 + 2.5, 6)
    expect(estimateCost(usage, 'claude-sonnet-5')).toBeCloseTo(2 + 1, 6)
    expect(estimateCost({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }, 'claude-opus-5')).toBeCloseTo(0.5, 6)
    const acc = addUsage(addUsage(emptyUsage(), usage, 'claude-opus-5'), usage, 'claude-opus-5')
    expect(acc.calls).toBe(2)
    expect(acc.input).toBe(2_000_000)
    expect(acc.costUsd).toBeCloseTo(15, 6)
  })
})
