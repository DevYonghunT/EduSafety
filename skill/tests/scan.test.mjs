import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { maskSecrets } from '../edusafe/scripts/scan.mjs'

const SCAN = 'edusafe/scripts/scan.mjs'
const items = JSON.parse(readFileSync('edusafe/rules/items.json', 'utf8')).items

// 픽스처에 심는 값 — 어떤 hit 의 snippet 에도 원문 그대로 남으면 안 된다 (REQ-7.11·REQ-9.5)
const GOOGLE_KEY = 'AIzaSyD1234567890123456789012345678901234'
const RRN = '990101-1234567'
const COMMENT_SECRET = 'hunter2'
const SERVICE_ROLE = 'eyJabcdefghij'
const HARDCODED_PW = 's3cr3t-value'
const PLANTED = [GOOGLE_KEY, RRN, COMMENT_SECRET, SERVICE_ROLE, HARDCODED_PW]

const APP_JS = [
  '// 고의로 취약점을 심은 테스트용 코드입니다. 실제로 배포하지 마세요.',
  '// 비밀번호: ' + COMMENT_SECRET,
  "const googleKey = '" + GOOGLE_KEY + "'",
  'const serviceRole = "' + SERVICE_ROLE + '"',
  'const password = "' + HARDCODED_PW + '"',
  "const jumin = '" + RRN + "'",
  'export function login(pw) {',
  "  if (pw === '1234') { return true }",
  '  return false',
  '}',
  'export function show(el, name) {',
  "  el.innerHTML = '<b>' + name",
  '}',
  'export function report(user) {',
  '  console.log(user)',
  '}',
  'export async function all(sb) {',
  "  const { data } = await sb.from('students').select('*')",
  '  return data',
  '}',
].join('\n')

const INDEX_HTML = [
  '<!doctype html>',
  '<html lang="ko"><head><meta charset="utf-8" /><title>테스트</title></head>',
  '<body><img src="http://example.com/logo.png" alt="로고" /></body>',
  '</html>',
].join('\n')

const FIRESTORE_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} {',
  '      allow read, write: if true;',
  '    }',
  '  }',
  '}',
].join('\n')

// 한 줄이 500자를 넘고 줄 수가 (크기/200) 미만 → 압축 파일로 판정된다.
// scanMinified 인 google-api-key 는 돌고, 그렇지 않은 eval-usage 는 돌지 않아야 한다.
const MINIFIED = 'var a=1;'.repeat(300) + "eval('x');var k='" + GOOGLE_KEY + "';"

const SCHEMA_SQL = [
  'create table students (id uuid primary key, name text);',
  'create table safe_table (id uuid primary key);',
  'alter table safe_table enable row level security;',
].join('\n')

function makeProject(files) {
  const root = mkdtempSync(join(tmpdir(), 'edusafe-scan-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

function runScan(root) {
  const out = root + '-scan.json'
  execFileSync(process.execPath, [SCAN, root, out], { stdio: 'pipe' })
  return JSON.parse(readFileSync(out, 'utf8'))
}

let root
let scan

beforeAll(() => {
  root = makeProject({
    'package.json': JSON.stringify({ name: 'tmp-app', dependencies: { '@supabase/supabase-js': '^2.0.0' } }),
    'index.html': INDEX_HTML,
    'src/app.js': APP_JS,
    'firestore.rules': FIRESTORE_RULES,
    'supabase/schema.sql': SCHEMA_SQL,
    'docs/guide.md': '문서 예제입니다.\n\n    const k = "' + GOOGLE_KEY + '"\n',
    'node_modules/pkg/leak.js': "const k = '" + GOOGLE_KEY + "'\n",
    'data/3반_명단.xlsx': 'xlsx 자리표시자',
    'data/student-guide.xlsx': 'xlsx 자리표시자',
    'data/roster-template.xlsx': 'xlsx 자리표시자',
    'data/scores.test.csv': 'col1,col2\n1,2\n',
    'assets/blob.json': Buffer.from([0x7b, 0x00, 0x7d]),
    'big.js': 'x'.repeat(2 * 1024 * 1024 + 10),
    // REQ-8.1 — 직전 실행 결과는 스캔 대상이 아니다
    'edusafe-report/edusafe-report.json': '{"leaked":"' + GOOGLE_KEY + '"}',
    // REQ-9.6 — 압축 파일에서는 scanMinified 규칙만 돈다
    'bundle.min.js': MINIFIED,
    'src/plain.js': "eval('1+1')\n",
  })
  scan = runScan(root)
})

afterAll(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
    rmSync(root + '-scan.json', { force: true })
  }
})

const hitRules = () => new Set(scan.hits.map((h) => h.rule))

describe('scan.mjs 회귀', () => {
  it('1. 심어놓은 취약 코드가 기대 규칙으로 hit 한다', () => {
    const expected = [
      'google-api-key', 'plaintext-password-compare', 'innerhtml-dynamic',
      'http-resource', 'console-sensitive', 'supabase-select-star', 'firestore-open-write',
    ]
    const got = hitRules()
    expect(expected.filter((r) => !got.has(r)), 'hit 하지 않은 기대 규칙').toEqual([])
  })

  it('2. node_modules 안의 키는 hit 하지 않는다 (excluded-dir)', () => {
    expect(scan.hits.filter((h) => h.file.includes('node_modules'))).toEqual([])
    expect(scan.files_skipped).toContainEqual({ path: 'node_modules', reason: 'excluded-dir' })
    expect(scan.files.map((f) => f.path).filter((p) => p.includes('node_modules'))).toEqual([])
  })

  it('3. 건너뛴 파일의 사유가 서로 구분되는 문자열이다 (REQ-9.8)', () => {
    const reasonOf = (p) => scan.files_skipped.find((s) => s.path === p)?.reason
    expect(reasonOf('big.js')).toBe('too-large')
    expect(reasonOf('assets/blob.json')).toBe('binary')
    expect(reasonOf('data/3반_명단.xlsx')).toBe('unsupported-extension')
    expect(reasonOf('node_modules')).toBe('excluded-dir')
    // 네 사유가 모두 서로 다른 문자열이어야 한다
    const four = ['big.js', 'assets/blob.json', 'data/3반_명단.xlsx', 'node_modules'].map(reasonOf)
    expect(new Set(four).size).toBe(4)
  })

  it('4. maskSecret 규칙의 snippet 에 원본 키가 남지 않는다', () => {
    const keyHits = scan.hits.filter((h) => h.rule === 'google-api-key')
    expect(keyHits.length).toBeGreaterThan(0)
    for (const h of keyHits) expect(h.snippet).not.toContain(GOOGLE_KEY)
  })

  it('5. files[] 의 모든 항목에 sha256 이 있다', () => {
    expect(scan.files.length).toBeGreaterThan(0)
    for (const f of scan.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('6. 스택 필터 — 신호 없는 빈 폴더에서는 스택 전용 규칙이 돌지 않는다', () => {
    const empty = makeProject({})
    const emptyScan = runScan(empty)
    expect(emptyScan.stacks_detected).toEqual([])
    expect(emptyScan.rules_run).not.toContain('no-rules-file')
    expect(emptyScan.rules_run).not.toContain('firestore-open-write')
    expect(emptyScan.hits).toEqual([])

    const fb = makeProject({ 'firestore.rules': FIRESTORE_RULES })
    const fbScan = runScan(fb)
    expect(fbScan.stacks_detected).toContain('firebase')
    expect(fbScan.rules_run).toContain('no-rules-file')
    expect(fbScan.rules_run).toContain('firestore-open-write')

    rmSync(empty, { recursive: true, force: true })
    rmSync(empty + '-scan.json', { force: true })
    rmSync(fb, { recursive: true, force: true })
    rmSync(fb + '-scan.json', { force: true })
  })

  it('7. 문서 파일의 hit 은 documentation: true 로 기록된다 (REQ-7.14)', () => {
    const docHits = scan.hits.filter((h) => h.file === 'docs/guide.md')
    expect(docHits.length).toBeGreaterThan(0)
    for (const h of docHits) expect(h.documentation).toBe(true)
    const codeHits = scan.hits.filter((h) => h.file === 'src/app.js')
    expect(codeHits.length).toBeGreaterThan(0)
    for (const h of codeHits) expect(h.documentation).toBe(false)
  })

  it('8. 모든 hit 의 item·subcheck 가 items.json 에 실재한다', () => {
    const bad = scan.hits.filter((h) => {
      const it = items.find((i) => i.id === h.item)
      return !it || !it.subchecks.some((s) => s.id === h.subcheck)
    })
    expect([...new Set(bad.map((h) => `${h.rule} → ${h.item}::${h.subcheck}`))]).toEqual([])
  })

  it('9. admin-data-file-present 가 견본·양식·테스트 파일을 오탐하지 않는다', () => {
    const found = scan.hits.filter((h) => h.rule === 'admin-data-file-present').map((h) => h.file)
    expect(found).toEqual(['data/3반_명단.xlsx'])
  })

  it('10. supabase-rls-missing 은 RLS 를 켠 테이블을 보고하지 않는다', () => {
    const found = scan.hits.filter((h) => h.rule === 'supabase-rls-missing')
    expect(found).toHaveLength(1)
    expect(found[0].snippet).toContain('students')
    expect(found[0].snippet).not.toContain('safe_table')
  })

  it('11. 심어놓은 시크릿 원문이 어떤 snippet 에도 남지 않는다', () => {
    const leaked = []
    for (const h of scan.hits) {
      for (const secret of PLANTED) if (h.snippet.includes(secret)) leaked.push(`${h.rule} @ ${h.file}:${h.line}`)
    }
    expect([...new Set(leaked)], '시크릿 원문이 남은 hit').toEqual([])
  })

  it('rules_run 이 실제로 돌린 규칙 목록이다 (REQ-9.4)', () => {
    expect(scan.rules_run.length).toBeGreaterThan(0)
    const ran = new Set(scan.rules_run)
    expect([...hitRules()].filter((r) => !ran.has(r)), 'rules_run 에 없는데 hit 한 규칙').toEqual([])
  })
})

// REQ-9.5 — 마스킹 대상은 hit 을 만든 규칙의 매치만이 아니라 인용 안의 모든 시크릿 규칙 매치이며,
// 매치에 이어지는 값 끝까지 함께 가린다.
describe('maskSecrets (REQ-9.5)', () => {
  const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJvbGUiOiJzZXJ2aWNlX3JvbGUifQ.dQw4w9WgXcQsignature'

  it('이름을 매치하는 규칙이어도 같은 줄의 값이 남지 않는다', () => {
    const out = maskSecrets("const jumin = '990101-1234567'")
    expect(out).not.toContain('990101-1234567')
    expect(out).toContain('jumin****')
  })

  it('환경변수 이름만 매치해도 = 뒤의 값이 남지 않는다 (VITE_ · NEXT_PUBLIC_)', () => {
    const vite = maskSecrets('VITE_API_SECRET=sk-live-9f3a2b7c1d8e4f6a0b2c')
    expect(vite).not.toContain('sk-live-9f3a2b7c1d8e4f6a0b2c')
    const next = maskSecrets('NEXT_PUBLIC_SUPABASE_ANON_TOKEN=' + JWT)
    expect(next).not.toContain(JWT)
  })

  it('JWT 의 첫 점까지만 매치해도 payload·signature 가 남지 않는다', () => {
    const out = maskSecrets('const serviceRoleKey = "' + JWT + '"')
    for (const part of JWT.split('.')) expect(out).not.toContain(part)
  })

  it('값 끝을 알리는 문자에서 멈춰 과하게 가리지 않는다', () => {
    expect(maskSecrets('console.log(user)')).toMatch(/\)$/)
    expect(maskSecrets("if (pw === '1234') { return true }")).toContain('{ return true }')
  })

  it('시크릿이 없는 문장은 그대로 둔다', () => {
    const plain = 'students 테이블에 enable row level security 가 없습니다'
    expect(maskSecrets(plain)).toBe(plain)
  })
})

describe('제외 범위와 압축 파일', () => {
  it('REQ-8.1 — edusafe-report/ 는 스캔 대상에서 제외된다', () => {
    expect(scan.hits.filter((h) => h.file.startsWith('edusafe-report'))).toEqual([])
    expect(scan.files.map((f) => f.path).filter((p) => p.startsWith('edusafe-report'))).toEqual([])
    expect(scan.files_skipped).toContainEqual({ path: 'edusafe-report', reason: 'excluded-dir' })
  })

  it('REQ-9.6 — 압축 파일에서는 scanMinified 규칙만 돈다', () => {
    const bundle = scan.files.find((f) => f.path === 'bundle.min.js')
    expect(bundle, 'bundle.min.js 가 스캔되지 않았습니다').toBeTruthy()
    expect(bundle.minified, 'bundle.min.js 가 압축으로 판정되지 않았습니다').toBe(true)

    const inBundle = scan.hits.filter((h) => h.file === 'bundle.min.js').map((h) => h.rule)
    expect(inBundle, 'scanMinified 규칙이 압축 파일에서 돌지 않았습니다').toContain('google-api-key')
    expect(inBundle, 'scanMinified 없는 규칙이 압축 파일에서 돌았습니다').not.toContain('eval-usage')

    // 압축이 아닌 파일에서는 같은 규칙이 정상 동작한다
    const plain = scan.hits.filter((h) => h.file === 'src/plain.js').map((h) => h.rule)
    expect(plain).toContain('eval-usage')
    expect(scan.files.find((f) => f.path === 'src/plain.js').minified).toBe(false)
  })
})
