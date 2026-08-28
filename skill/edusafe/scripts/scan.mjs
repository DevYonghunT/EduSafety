// 결정적 스캐너 — 프로젝트 폴더를 훑어 scan.json 을 만든다.
// 외부 의존성 0 (Node 내장 모듈만). 교사가 npm install 없이 실행한다 (spec REQ-4.2).
//
//   node edusafe/scripts/scan.mjs <projectRoot> [outPath]
//
// 기본 outPath 는 <projectRoot>/edusafe-report/scan.json 이다.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { join, extname, resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { rules, projectRules } from '../rules/scan-rules.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// spec REQ-5.7 — 포함 확장자
export const TEXT_EXT = [
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.html', '.htm', '.css', '.json',
  '.md', '.txt', '.csv', '.env', '.rules', '.sql', '.yml', '.yaml', '.toml',
]

// spec REQ-5.7 · REQ-8.1 — 제외 디렉터리 (edusafe-report/ 포함)
export const EXCLUDED_DIRS = ['node_modules', 'dist', '.next', 'build', 'out', '.git', 'edusafe-report']

const MAX_BYTES = 2 * 1024 * 1024
const SNIPPET_MAX = 200
const SNIPPET_LEAD = 40

// REQ-9.5·REQ-9.9 — 마스킹 대상 판정은 이 함수 한 곳에서만 한다.
// 규칙마다 손으로 확인하면 secretValue 만 붙이고 maskSecret 을 빠뜨린 규칙이
// 시크릿 원문을 scan.json 에 그대로 남긴다.
export const mustMask = (rule) => Boolean(rule.maskSecret || rule.secretValue)

// REQ-7.11 — 앞 6자 + ****
export const maskValue = (value) => value.slice(0, 6) + '****'

// REQ-9.5 — 마스킹 대상은 hit 을 만든 규칙의 매치만이 아니라 인용 안에 나타난
// 모든 시크릿 규칙의 매치다. rrn-field·nextpublic-secret·vite-env-secret 처럼
// 값이 아니라 이름을 매치하는 규칙이 있어서, 그 매치만 가리면 같은 줄의
// 주민등록번호·키가 그대로 남는다. 스택 필터는 적용하지 않는다 —
// 마스킹은 판정이 아니라 유출 방지라서 스택이 달라도 가려야 한다.
const MASK_PATTERNS = rules.filter((r) => mustMask(r) && r.pattern)

// 값의 끝을 알리는 문자. 매치 뒤에 이어지는 값을 여기까지 함께 가린다 —
// 패턴이 이름만 매치하거나(VITE_API_SECRET=sk-live-…) 값의 앞부분만 매치해도
// (supabase-service-role 의 eyJ… 는 JWT 의 첫 점에서 멈춘다) 뒤에 원문이 남기 때문이다.
const VALUE_STOP = /[\s'"`,;)\]}]/

// 규칙별로 순차 치환하지 않는다. 앞 규칙이 만든 **** 가 뒤 규칙의 매치를 가려 놓치기 때문에,
// 원본에서 모든 매치 구간을 먼저 모으고 값 끝까지 넓힌 뒤 겹치는 구간을 합쳐 한 번에 치환한다.
// 매치 뒤에 이어지는 값의 끝을 찾는다.
// ① 매치에 바로 붙은 연속 문자 (VITE_API_SECRET=sk-live-…)
// ② 공백을 사이에 둔 대입값 (VITE_API_SECRET = "…" · { NEXT_PUBLIC_AI_TOKEN: "…" })
//    — ① 만으로는 등호 앞 공백에서 멈춰 값이 그대로 남는다(리뷰 발견 1, node 로 실측).
function endOfValue(text, from) {
  // ① 은 대입 기호에서도 멈춘다. 여기서 `:` 를 삼켜 버리면 ② 가 대입을 알아보지 못해
  //    { NEXT_PUBLIC_AI_TOKEN: "…" } 형태의 값이 그대로 남는다.
  let end = from
  while (end < text.length && !VALUE_STOP.test(text[end]) && text[end] !== '=' && text[end] !== ':') end += 1

  let probe = end
  while (probe < text.length && /\s/.test(text[probe])) probe += 1
  if (probe >= text.length || (text[probe] !== '=' && text[probe] !== ':')) return end

  probe += 1
  while (probe < text.length && /\s/.test(text[probe])) probe += 1
  const quote = text[probe]
  if (quote === '"' || quote === "'" || quote === '`') {
    probe += 1
    while (probe < text.length && text[probe] !== quote) probe += 1
    if (probe < text.length) probe += 1 // 닫는 따옴표까지 포함
    return probe
  }
  while (probe < text.length && !VALUE_STOP.test(text[probe])) probe += 1
  return probe
}

export function maskSecrets(text) {
  const spans = []
  for (const rule of MASK_PATTERNS) {
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g'
    const re = new RegExp(rule.pattern.source, flags)
    let m
    while ((m = re.exec(text)) !== null) {
      if (m[0] === '') { re.lastIndex += 1; continue }
      spans.push([m.index, endOfValue(text, m.index + m[0].length)])
    }
  }
  if (spans.length === 0) return text

  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
    else merged.push([span[0], span[1]])
  }

  let out = ''
  let cursor = 0
  for (const [from, to] of merged) {
    out += text.slice(cursor, from) + maskValue(text.slice(from, to))
    cursor = to
  }
  return out + text.slice(cursor)
}

// REQ-7.14 — 문서 파일 여부
export function isDocumentation(relPath) {
  const lower = relPath.toLowerCase()
  const ext = extname(lower)
  if (ext === '.md' || ext === '.txt') return true
  return lower.includes('docs/') || lower.includes('.claude/') || lower.includes('.agents/')
}

// 압축 판정: 500자를 넘는 줄이 있고, 파일 전체 줄 수가 (파일 크기 / 200) 미만
export function isMinified(text, byteLength) {
  const lines = text.split('\n')
  return lines.some((l) => l.length > 500) && lines.length < byteLength / 200
}

const isIncludedName = (name) => {
  if (name === '.env' || name.startsWith('.env.')) return true
  return TEXT_EXT.includes(extname(name).toLowerCase())
}

// 0단계 스택 감지. 아무 신호도 없으면 빈 배열을 돌려준다 —
// 빈 폴더를 ["html"] 로 단정하면 미지원 프로젝트가 지원 스택으로 오인된다 (REQ-9.3).
export function detectStacks(root, files = []) {
  const stacks = new Set()
  const there = (p) => existsSync(join(root, p))
  let pkg = null
  try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) } catch { pkg = null }
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {}
  const has = (n) => Object.prototype.hasOwnProperty.call(deps, n)

  if (has('next')) stacks.add('nextjs')
  if (has('vite')) stacks.add('vite-react')
  if (has('react') && !has('vite') && !has('next')) stacks.add('vite-react')
  if (there('firebase.json') || there('firestore.rules') || there('database.rules.json')) stacks.add('firebase')
  // 리뷰 발견 3 — 설정 파일 없이 SDK 만 쓰는 앱이 흔하고, 바로 그 경우가
  // "Firebase 를 쓰는데 보안 규칙 파일이 없다"를 알려야 하는 대표 사례다.
  // 파일 존재만 보면 no-rules-file·firebase-no-appcheck 가 도달 불가능해진다.
  if (has('firebase') || files.some((f) => /initializeApp\s*\(/.test(f.text))) stacks.add('firebase')
  if (there('supabase') || has('@supabase/supabase-js')) stacks.add('supabase')
  if (files.some((f) => /\.html?$/i.test(f.path))) stacks.add('html')
  return [...stacks]
}

// 폴더 순회. 건너뛴 파일은 사유를 서로 구분되는 문자열로 남긴다 (REQ-9.8).
// 제외 디렉터리는 내려가지 않고 그 디렉터리 자체를 한 줄로 기록한다.
function walk(root) {
  const files = []
  const skipped = []

  const visit = (absDir, relDir) => {
    let entries
    try { entries = readdirSync(absDir, { withFileTypes: true }) } catch {
      skipped.push({ path: relDir || '.', reason: 'read-error' })
      return
    }
    for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const abs = join(absDir, e.name)
      const rel = relDir ? `${relDir}/${e.name}` : e.name

      if (e.isSymbolicLink()) { skipped.push({ path: rel, reason: 'symlink' }); continue }
      if (e.isDirectory()) {
        if (EXCLUDED_DIRS.includes(e.name)) { skipped.push({ path: rel, reason: 'excluded-dir' }); continue }
        visit(abs, rel)
        continue
      }
      if (!e.isFile()) continue
      if (!isIncludedName(e.name)) { skipped.push({ path: rel, reason: 'unsupported-extension' }); continue }

      let size
      try { size = statSync(abs).size } catch { skipped.push({ path: rel, reason: 'read-error' }); continue }
      if (size > MAX_BYTES) { skipped.push({ path: rel, reason: 'too-large' }); continue }

      let buf
      try { buf = readFileSync(abs) } catch { skipped.push({ path: rel, reason: 'read-error' }); continue }
      if (buf.subarray(0, 8192).includes(0)) { skipped.push({ path: rel, reason: 'binary' }); continue }

      const text = buf.toString('utf8')
      files.push({
        path: rel,
        text,
        sha256: createHash('sha256').update(buf).digest('hex'),
        minified: isMinified(text, buf.length),
      })
    }
  }

  visit(root, '')
  return { files, skipped }
}

// 줄 시작 오프셋 목록 → 매치 위치의 줄 번호(1부터)와 그 줄의 텍스트
function lineStarts(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return starts
}

function lineOf(starts, index) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= index) lo = mid
    else hi = mid - 1
  }
  return lo
}

// 줄 전체를 먼저 마스킹한 뒤 창을 잘라낸다. 창을 먼저 자르면 경계에 걸친 시크릿이
// 잘려 패턴에 걸리지 않고 조각이 그대로 남는다.
function buildSnippet(lineText, offsetInLine) {
  const masked = maskSecrets(lineText)
  if (masked.length <= SNIPPET_MAX) return masked
  const anchor = maskSecrets(lineText.slice(0, offsetInLine)).length
  const from = Math.max(0, anchor - SNIPPET_LEAD)
  return masked.slice(from, from + SNIPPET_MAX)
}

export function scanProject(root) {
  const absRoot = resolve(root)
  const { files, skipped } = walk(absRoot)
  const allPaths = [...files.map((f) => f.path), ...skipped.map((s) => s.path)]
  const stacks = detectStacks(absRoot, files)

  // REQ-9.3 스택 필터 — 패턴 규칙과 프로젝트 규칙 모두에 적용한다
  const inStack = (r) => r.stacks === 'all' || r.stacks.some((s) => stacks.includes(s))
  const activePattern = rules.filter(inStack)
  const activeProject = projectRules.filter(inStack)

  const hits = []

  for (const file of files) {
    const starts = lineStarts(file.text)
    const lineText = (n) => {
      const from = starts[n]
      const to = n + 1 < starts.length ? starts[n + 1] - 1 : file.text.length
      return file.text.slice(from, to).replace(/\r$/, '')
    }

    for (const rule of activePattern) {
      // REQ-9.6 — 압축 파일에서는 scanMinified 규칙만 돌린다
      if (file.minified && !rule.scanMinified) continue

      const re = new RegExp(rule.pattern.source, rule.pattern.flags)
      let m
      while ((m = re.exec(file.text)) !== null) {
        if (m[0] === '') { re.lastIndex += 1; continue }
        const n = lineOf(starts, m.index)
        const text = lineText(n)
        if (rule.excludeLine && rule.excludeLine.test(text)) continue

        const offsetInLine = m.index - starts[n]
        hits.push({
          rule: rule.id, item: rule.item, subcheck: rule.subcheck, severity: rule.severity,
          file: file.path, line: n + 1,
          snippet: buildSnippet(text, offsetInLine),
          documentation: isDocumentation(file.path),
        })
      }
    }
  }

  // 프로젝트 규칙은 파일 순회가 끝난 뒤 한 번씩 부른다
  const plainFiles = files.map((f) => ({ path: f.path, text: f.text }))
  for (const rule of activeProject) {
    for (const found of rule.check(plainFiles, allPaths) || []) {
      hits.push({
        rule: rule.id, item: rule.item, subcheck: rule.subcheck, severity: rule.severity,
        file: found.file, line: found.line,
        snippet: maskSecrets(String(found.snippet)).slice(0, SNIPPET_MAX),
        documentation: isDocumentation(String(found.file)),
      })
    }
  }

  let version = null
  try { version = JSON.parse(readFileSync(join(HERE, '../rules/version.json'), 'utf8')).edusafe_version } catch { version = null }

  return {
    version,
    scanned_at: new Date().toISOString(),
    root: absRoot,
    stacks_detected: stacks,
    files_scanned: files.length,
    files: files.map((f) => ({ path: f.path, sha256: f.sha256, minified: f.minified })),
    files_skipped: skipped,
    extensions: TEXT_EXT,
    excluded_dirs: EXCLUDED_DIRS,
    // REQ-9.4 — 이번 실행에서 실제로 돌린 규칙 id 목록.
    // 부재 증명 항목의 negative_scan 근거가 이 목록을 인용한다.
    rules_run: [...activePattern.map((r) => r.id), ...activeProject.map((r) => r.id)],
    hits,
  }
}

function main(argv) {
  const root = argv[0]
  if (!root) {
    console.error('사용법: node scan.mjs <projectRoot> [outPath]')
    process.exit(2)
  }
  const out = argv[1] ? resolve(argv[1]) : join(resolve(root), 'edusafe-report', 'scan.json')
  const result = scanProject(root)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n')
  console.log(`스캔 완료: 파일 ${result.files_scanned}개 · 규칙 ${result.rules_run.length}개 · hit ${result.hits.length}건`)
  console.log(`결과: ${out}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
