import { describe, it, expect } from 'vitest'
import { validateJudgments, deriveProtectionLevel, extractJson } from '../src/lib/reviewAi.js'
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
    const raw = { judgments: [{ id: 'R-a', verdict: 'na', reason: '해당없음' }] }
    const { judgments, filled } = validateJudgments(raw, items, files)
    expect(judgments['S-b'].verdict).toBe('needs_human')
    expect(judgments['S-c'].verdict).toBe('needs_human')
    expect(filled).toEqual(['S-b', 'S-c'])
    expect(judgments['R-a'].verdict).toBe('na')
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
    expect(deriveProtectionLevel({ collectsPersonalInfo: true, hasAssessmentOrCompetition: true })).toBe('L2')
    expect(deriveProtectionLevel({ collectsSensitiveInfo: true })).toBe('L2')
  })

  it('extractJson — 코드펜스·잡담 섞인 응답에서 JSON만 추출', () => {
    expect(extractJson('결과는 다음과 같습니다.\n```json\n{"a": 1}\n```')).toEqual({ a: 1 })
    expect(extractJson('{"b": [1,2]} 끝')).toEqual({ b: [1, 2] })
    expect(() => extractJson('JSON 없음')).toThrow()
  })
})
