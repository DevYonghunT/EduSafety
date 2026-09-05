import { describe, it, expect } from 'vitest'
import rules from '../src/data/securityRules.js'
import { scanFiles, isScannablePath, countBySeverity, suspectDataFiles, maskSecret } from '../src/lib/scanner.js'

const f = (path, text) => ({ path, name: path.split('/').pop(), text })
const hit = (id, text) => {
  const r = rules.find((x) => x.id === id)
  r.pattern.lastIndex = 0
  return r.pattern.test(text)
}

describe('규칙 스캔 (T4 완료 기준)', () => {
  it('규칙 40종 이상, id 중복 없음, 필드 유효', () => {
    expect(rules.length).toBeGreaterThanOrEqual(40)
    expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length)
    for (const r of rules) {
      expect(['critical', 'warning', 'info']).toContain(r.severity)
      expect(r.pattern.flags).toContain('g')
      expect(r.fix.length).toBeGreaterThan(5)
    }
  })

  it('실심사 오탐 보정 — Firebase 웹 키는 정보 등급, 문서 파일·xmlns의 http는 제외', () => {
    const { findings } = scanFiles([
      f('js/firebase-init.js', 'const cfg = { apiKey: "AIza' + 'B'.repeat(35) + '", authDomain: "x" }'),
      f('assets/LICENSE.txt', 'http://creativecommons.org/publicdomain/zero/1.0/'),
      f('login.html', `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'>")`),
      f('docs/guide.md', 'allow write: if true;'),
    ])
    const ids = findings.map((x) => x.rule.id)
    expect(ids).toContain('firebase-web-key')
    expect(ids).not.toContain('google-api-key')
    expect(ids).not.toContain('http-resource')
    expect(ids).not.toContain('db-open-write')
  })

  it('신규 규칙 — 주민번호·javascript: URL·클라이언트 역할 플래그·점수 로컬 기록', () => {
    expect(hit('rrn-pattern', 'jumin: "990101-1234567"')).toBe(true)
    expect(hit('rrn-pattern', 'date: "2026-08-29"')).toBe(false)
    expect(hit('javascript-url', '<a href="javascript:void(0)">')).toBe(true)
    expect(hit('client-role-flag', "localStorage.setItem('mode', 'teacher')")).toBe(true)
    expect(hit('score-localstorage', "localStorage.setItem('score', total)")).toBe(true)
    expect(hit('prompt-password-gate', 'const pw = prompt("비밀번호를 입력하세요")')).toBe(true)
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

  it('긴 비밀값(JWT)도 잘리기 전에 가려지고, $& 같은 치환 패턴이 원문을 되살리지 않는다', () => {
    const jwt = 'eyJ' + 'a'.repeat(120) + '.eyJ' + 'b'.repeat(120) + '.' + 'c'.repeat(80)
    const { findings } = scanFiles([f('app.js', `const token = "${jwt}"; // ${'x'.repeat(50)}`)])
    const snippet = findings.find((x) => x.rule.id === 'jwt-hardcoded').occurrences[0].snippet
    expect(snippet).not.toContain('a'.repeat(30))
    expect(snippet).toContain('****')
    expect(maskSecret('key=AB$&CDEFGHIJKL', 'AB$&CDEFGHIJKL')).toBe('key=AB$&CD****KL')
    expect(maskSecret('k=$&', '$&')).toBe('k=****')
  })

  it('비밀번호·secret 할당은 값만 가리고 변수명은 남긴다', () => {
    const { findings } = scanFiles([f('app.js', 'const password = "hunter2222";')])
    expect(findings.find((x) => x.rule.id === 'hardcoded-password').occurrences[0].snippet).toBe('const password = "****";')
  })

  it('.env의 따옴표 없는 비밀값은 심각, 예시 파일·자리표시자는 제외', () => {
    const { findings } = scanFiles([
      f('.env', 'DB_PASSWORD=Sup3rS3cretDbPass!\nPORT=3000\nDATABASE_URL=postgres://app:Pa55w0rd!@db:5432/app'),
      f('.env.example', 'DB_PASSWORD=your_password_here'),
      f('README.md', 'OPENAI_API_KEY=sk-your-key-here'),
    ])
    const env = findings.find((x) => x.rule.id === 'env-secret-assignment')
    expect(env.rule.severity).toBe('critical')
    expect(env.occurrences.map((o) => o.file)).toEqual(['.env'])
    expect(env.occurrences[0].snippet).toBe('DB_PASSWORD=Sup3rS****s!')
    const conn = findings.find((x) => x.rule.id === 'connection-string-credentials')
    expect(conn.occurrences[0].snippet).not.toContain('Pa55w0rd!')
  })

  it('apiKey: "AIza…"는 Firebase 설정 파일에서만 정보 등급, 그 밖에서는 Google 키 유출(심각)', () => {
    const key = 'AIza' + 'C'.repeat(36)
    const { findings } = scanFiles([f('src/gemini.js', `const client = { apiKey: "${key}" }`)])
    const ids = findings.map((x) => x.rule.id)
    expect(ids).toContain('google-api-key')
    expect(ids).not.toContain('firebase-web-key')
    expect(findings.find((x) => x.rule.id === 'google-api-key').occurrences[0].snippet).not.toContain('C'.repeat(20))
  })

  it('scanFiles 통합 — 심각도 순 정렬 + 집계', () => {
    const { findings } = scanFiles([
      f('firestore.rules', 'allow write: if true;'),
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
