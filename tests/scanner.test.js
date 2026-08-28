import { describe, it, expect } from 'vitest'
import rules from '../src/data/securityRules.js'
import { scanFiles, isScannablePath, countBySeverity, suspectDataFiles } from '../src/lib/scanner.js'

const f = (path, text) => ({ path, name: path.split('/').pop(), text })
const hit = (id, text) => {
  const r = rules.find((x) => x.id === id)
  r.pattern.lastIndex = 0
  return r.pattern.test(text)
}

describe('규칙 스캔 (T4 완료 기준)', () => {
  it('핵심 규칙 15종이 등록되어 있다', () => {
    expect(rules.length).toBe(15)
    expect(new Set(rules.map((r) => r.id)).size).toBe(15)
  })

  it('비밀키 매치/비매치', () => {
    expect(hit('anthropic-key', 'const k = "sk-ant-' + 'a'.repeat(24) + '"')).toBe(true)
    expect(hit('anthropic-key', 'const k = "sk-ant"')).toBe(false)
    expect(hit('aws-key', 'AKIAIOSFODNN7EXAMPLE')).toBe(true)
    expect(hit('google-api-key', 'AIza' + 'B'.repeat(35))).toBe(true)
  })

  it('열린 DB 규칙 매치/비매치', () => {
    expect(hit('db-open-write', 'allow write: if true;')).toBe(true)
    expect(hit('db-open-write', 'allow write: if request.auth != null;')).toBe(false)
    expect(hit('db-open-read', 'allow read: if true;')).toBe(true)
  })

  it('XSS류 매치', () => {
    expect(hit('eval-usage', 'eval(userCode)')).toBe(true)
    expect(hit('innerhtml-dynamic', 'el.innerHTML = userInput')).toBe(true)
  })

  it('발견 스니펫에서 비밀키가 마스킹된다', () => {
    const key = 'sk-ant-' + 'a'.repeat(30)
    const { findings } = scanFiles([f('app.js', `const k = "${key}"`)])
    const snippet = findings[0].occurrences[0].snippet
    expect(snippet).not.toContain(key)
    expect(snippet).toContain('****')
  })

  it('scanFiles 통합 — 심각도 순 정렬 + 집계', () => {
    const { findings } = scanFiles([
      f('rules.txt', 'allow write: if true;'),
      f('app.js', 'eval(x)\nfetch("http://insecure.com/a.js")'),
    ])
    expect(findings[0].rule.severity).toBe('critical')
    const counts = countBySeverity(findings)
    expect(counts.critical).toBe(1)
    expect(counts.warning).toBe(1)
    expect(counts.info).toBe(1)
  })

  it('경로 필터 — node_modules·바이너리 제외, .env 포함', () => {
    expect(isScannablePath('node_modules/x/index.js')).toBe(false)
    expect(isScannablePath('assets/logo.png')).toBe(false)
    expect(isScannablePath('.env')).toBe(true)
    expect(isScannablePath('src/app.jsx')).toBe(true)
  })

  it('읽지 못한 파일 중 학생 데이터 의심 파일을 이름으로 감지한다', () => {
    const paths = [
      'docs/3학년-명단.xlsx',
      'data/성적처리.hwp',
      'app.db',
      'img/학생사진.png',
      'assets/logo.png',
      'fonts/Pretendard.woff2',
      'app/StudentSignupForm.tsx',
    ]
    expect(suspectDataFiles(paths)).toEqual([
      'docs/3학년-명단.xlsx',
      'data/성적처리.hwp',
      'app.db',
      'img/학생사진.png',
      'app/StudentSignupForm.tsx',
    ])
  })

  it('의심 감지 오탐 방지 — upgrade/degrade 부분 일치·node_modules 제외', () => {
    expect(suspectDataFiles([
      'node_modules/undici/lib/api/api-upgrade.js',
      'node_modules/next/dist/client/graceful-degrade-boundary.js',
      'lib/upgradeinsecurerequests.js',
      'node_modules/some-lib/student-roster.xlsx',
    ])).toEqual([])
  })
})
