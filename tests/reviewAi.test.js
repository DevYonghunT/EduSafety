import { describe, it, expect } from 'vitest'
import { validateJudgments, deriveProtectionLevel, extractJson, estimateCost, addUsage, emptyUsage, filesNamedBy, scanHitItems, mergeJudgments, priceFor } from '../src/lib/reviewAi.js'
import { redactSecrets, buildAiPayload, buildAiPayloadChunks, withheldReason } from '../src/lib/redact.js'

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
    const raw = { judgments: [{ id: 'S-b', verdict: 'na', reason: '해당없음', evidence: [{ file: 'src/app.js', quote: 'prompt("이름 입력")' }] }] }
    const { judgments, filled } = validateJudgments(raw, items, files)
    expect(judgments['R-a'].verdict).toBe('needs_human')
    expect(judgments['S-c'].verdict).toBe('needs_human')
    expect(filled).toEqual(['R-a', 'S-c'])
    expect(judgments['S-b'].verdict).toBe('na')
  })

  it('원칙 3 보강: 필수 항목의 해당없음은 심사자 확인으로, 점수 항목의 해당없음도 인용 없이는 판단불가', () => {
    const raw = { judgments: [
      { id: 'R-a', verdict: 'na', reason: '해당없음', evidence: [{ file: 'src/app.js', quote: 'prompt("이름 입력")' }] },
      { id: 'S-b', verdict: 'na', reason: '근거 없는 해당없음' },
      { id: 'S-c', verdict: 'na', reason: '근거 있는 해당없음', evidence: [{ file: 'src/app.js', quote: 'prompt("이름 입력")' }] },
    ] }
    const { judgments, demoted } = validateJudgments(raw, items, files)
    expect(judgments['R-a'].verdict).toBe('needs_human')
    expect(judgments['S-b'].verdict).toBe('needs_human')
    expect(judgments['S-c'].verdict).toBe('na')
    expect(demoted).toEqual(['R-a', 'S-b'])
  })

  it('인용은 마스킹된 전송본 기준으로도 대조된다 — 비밀번호 줄을 인용한 미충족이 기각되지 않는다', () => {
    const withSecret = [{ path: 'src/auth.js', name: 'auth.js', text: 'const password = "hunter2222";\nlogin(password)' }]
    const masked = redactSecrets(withSecret[0].text)
    expect(masked).toBe('const password = "****";\nlogin(password)')
    const raw = { judgments: [{ id: 'S-b', verdict: 'fail', reason: '하드코딩 비밀번호', evidence: [{ file: 'src/auth.js', quote: 'const password = "****"' }] }] }
    const { judgments } = validateJudgments(raw, items, withSecret)
    expect(judgments['S-b'].verdict).toBe('fail')
  })

  it('파일명만 준 인용은 후보가 하나일 때만 인정 — admin/config.js와 student/config.js는 구분 못 하면 기각', () => {
    const two = [
      { path: 'admin/config.js', name: 'config.js', text: 'export const role = "admin-only"' },
      { path: 'student/config.js', name: 'config.js', text: 'export const role = "student-open"' },
      { path: 'index.html', name: 'index.html', text: '<meta charset="utf-8">' },
    ]
    expect(filesNamedBy(two, 'config.js')).toEqual([])
    expect(filesNamedBy(two, 'student/config.js').map((f) => f.path)).toEqual(['student/config.js'])
    expect(filesNamedBy(two, 'my-repo/index.html').map((f) => f.path)).toEqual(['index.html'])
    const raw = { judgments: [{ id: 'S-b', verdict: 'ok', reason: 'x', evidence: [{ file: 'config.js', quote: 'role = "student-open"' }] }] }
    expect(validateJudgments(raw, items, two).judgments['S-b'].verdict).toBe('needs_human')
  })

  it('규칙 스캔이 위반 후보를 찾은 항목에 AI가 충족을 주면 심사자 확인으로 넘긴다', () => {
    const scanFindings = [
      { rule: { id: 'anthropic-key', severity: 'critical', ruleFor: 'R-a' }, occurrences: [] },
      { rule: { id: 'firebase-web-key', severity: 'info', ruleFor: 'S-b' }, occurrences: [] },
    ]
    const scanHits = scanHitItems(scanFindings)
    expect([...scanHits]).toEqual(['R-a'])
    const raw = { judgments: [
      { id: 'R-a', verdict: 'ok', reason: '키 없음', evidence: [{ file: 'src/app.js', quote: 'localStorage.setItem("students", name)' }] },
      { id: 'S-b', verdict: 'ok', reason: '정보 등급은 충돌 아님', evidence: [{ file: 'src/app.js', quote: 'localStorage.setItem("students", name)' }] },
    ] }
    const { judgments, demoted } = validateJudgments(raw, items, files, { scanHits })
    expect(judgments['R-a'].verdict).toBe('needs_human')
    expect(judgments['R-a'].reason).toContain('규칙 스캔')
    expect(judgments['S-b'].verdict).toBe('ok')
    expect(demoted).toEqual(['R-a'])
  })

  it('묶음 병합은 최종 판정과 무관하게 강등 사실을 집계한다', () => {
    const chunk1 = { judgments: { 'S-b': { verdict: 'ok', reason: 'r', evidence: [{ file: 'a', quote: 'b' }] } }, demoted: [], filled: [] }
    const chunk2 = { judgments: { 'S-b': { verdict: 'needs_human', reason: 'r', evidence: [], demoted: true } }, demoted: ['S-b'], filled: [] }
    const merged = mergeJudgments([chunk1, chunk2], [{ id: 'S-b' }])
    expect(merged.judgments['S-b'].verdict).toBe('ok')
    expect(merged.demoted).toEqual(['S-b'])
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

  it('원칙 7: .env의 따옴표 없는 비밀값·접속 문자열 비밀번호도 마스킹된다 (값만 가리고 키 이름은 남긴다)', () => {
    const env = 'PORT=3000\nDB_PASSWORD=Sup3rS3cretDbPass!\nexport SESSION_SECRET="abcdefghijklmnop"\nDATABASE_URL=postgres://app:Pa55w0rd!@db.example.com:5432/app\n'
    const out = redactSecrets(env)
    expect(out).toContain('PORT=3000')
    expect(out).toContain('DB_PASSWORD=')
    expect(out).not.toContain('Sup3rS3cretDbPass!')
    expect(out).not.toContain('abcdefghijklmnop')
    expect(out).not.toContain('Pa55w0rd!')
    expect(out).toContain('postgres://app:')
  })

  it('원칙 7: 학생 명부 모양의 JSON·PII가 많은 txt는 확장자와 무관하게 내용을 보내지 않는다', () => {
    const roster = JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ name: `학생${i}`, phone: `010-1234-56${70 + i}` })))
    const quiz = JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ id: i, question: `q${i}`, choices: ['a', 'b'] })))
    expect(withheldReason({ path: 'data/people.json', text: roster })).toContain('명부')
    expect(withheldReason({ path: 'data/quiz.json', text: quiz })).toBeNull()
    expect(withheldReason({ path: 'src/app.js', text: roster })).toBeNull()
    expect(withheldReason({ path: 'notes/3반-학생.txt', text: 'x' })).toContain('파일명')
    expect(withheldReason({ path: 'notes/contacts.txt', text: Array.from({ length: 5 }, (_, i) => `a${i}@school.kr`).join('\n') })).toContain('5건')
    const { chunks, excludedFiles, coveragePercent } = buildAiPayloadChunks([
      { path: 'data/people.json', name: 'people.json', text: roster },
      { path: 'src/app.js', name: 'app.js', text: 'ok' },
    ])
    expect(chunks[0]).not.toContain('010-1234')
    expect(chunks[0]).toContain('data/people.json')
    expect(excludedFiles[0].path).toBe('data/people.json')
    expect(coveragePercent).toBe(100)
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

  it('응답의 model 이름(날짜 접미·대체 모델)으로 단가를 찾는다', () => {
    expect(priceFor('claude-sonnet-5-20260601').id).toBe('claude-sonnet-5')
    expect(priceFor('claude-fable-5-1').id).toBe('claude-fable-5-1')
    expect(priceFor('claude-haiku-4-5-20251001').id).toBe('claude-sonnet-5')
    expect(priceFor(undefined).id).toBe('claude-opus-5')
  })
})
