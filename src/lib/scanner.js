// 결정적 규칙 스캔 엔진 — AI가 아니라 정규식이 판단하므로 같은 입력에 항상 같은 결과.
// 발견 스니펫의 비밀값은 저장 전에 마스킹한다 (신뢰성 원칙 7).
import rules from '../data/securityRules.js'

const TEXT_EXTENSIONS = /\.(html?|css|jsx?|tsx?|mjs|cjs|json|txt|md|vue|svelte|rules|env|yml|yaml|xml|py|csv|tsv|sql)$/i
const SKIP_PATH = /(^|\/)(node_modules|\.git|dist|build|\.next|coverage|vendor)(\/|$)/
export const MAX_FILE_SIZE = 2 * 1024 * 1024

export function isScannablePath(path) {
  if (SKIP_PATH.test(path)) return false
  const name = path.split('/').pop()
  return TEXT_EXTENSIONS.test(name) || /^\.env/.test(name)
}

// 마스킹 형태 — 10자 이하는 전부, 그 이상은 앞 6자·뒤 2자만 남긴다.
export function maskedValue(match) {
  return match.length <= 10 ? '****' : `${match.slice(0, 6)}****${match.slice(-2)}`
}

// replace()의 치환 문자열은 $&·$` 같은 패턴을 해석해 비밀값이 되돌아올 수 있다 — 분할·연결로 치환한다.
export function maskSecret(snippet, match) {
  if (!match || !snippet.includes(match)) return snippet
  return snippet.split(match).join(maskedValue(match))
}

// 규칙에 캡처 그룹이 있으면 그 값(비밀값 본체)만 가린다 — 변수명·구조는 남겨 AI와 심사자가 맥락을 볼 수 있게.
export function secretOf(m) {
  return m.slice(1).find((g) => typeof g === 'string' && g.length > 0) ?? m[0]
}

function makeSnippet(line, secret, shouldMask) {
  let snippet = line.trim()
  let anchor = secret
  if (shouldMask) {
    // 자르기 전에 먼저 가린다 — 잘린 뒤에는 원문 매치가 사라져 마스킹이 무효가 된다 (긴 JWT·키).
    snippet = maskSecret(snippet, secret)
    anchor = maskedValue(secret)
  }
  if (snippet.length > 160) {
    const idx = Math.max(0, snippet.indexOf(anchor) - 40)
    snippet = (idx > 0 ? '…' : '') + snippet.slice(idx, idx + 140) + '…'
  }
  return snippet
}

// skipFiles / skipLine은 정규식 또는 함수(경로·줄, 파일 전문) — 파일 맥락(예: Firebase 설정 파일인지)을 볼 수 있게.
const skipsFile = (rule, f) =>
  Boolean(rule.skipFiles) && (typeof rule.skipFiles === 'function' ? rule.skipFiles(f.path, f.text) : rule.skipFiles.test(f.path))
const skipsLine = (rule, line, f) =>
  Boolean(rule.skipLine) && (typeof rule.skipLine === 'function' ? rule.skipLine(line, f.text) : rule.skipLine.test(line))

/**
 * files: [{ path, name, text }]
 * returns { findings: [{ rule, occurrences: [{ file, line, snippet }] }], scannedCount }
 */
export function scanFiles(files) {
  const byRule = new Map()
  let scannedCount = 0

  for (const f of files) {
    scannedCount++
    const lines = f.text.split('\n')
    for (const rule of rules) {
      if (skipsFile(rule, f)) continue
      for (let i = 0; i < lines.length; i++) {
        if (skipsLine(rule, lines[i], f)) continue
        rule.pattern.lastIndex = 0
        const m = rule.pattern.exec(lines[i])
        if (!m) continue
        if (!byRule.has(rule.id)) byRule.set(rule.id, { rule, occurrences: [] })
        const bucket = byRule.get(rule.id)
        if (bucket.occurrences.length < 50) {
          const secret = rule.maskSecret ? secretOf(m) : m[0]
          bucket.occurrences.push({ file: f.path, line: i + 1, snippet: makeSnippet(lines[i], secret, rule.maskSecret) })
        }
      }
    }
  }

  const order = { critical: 0, warning: 1, info: 2 }
  const findings = [...byRule.values()].sort((a, b) => order[a.rule.severity] - order[b.rule.severity])
  return { findings, scannedCount }
}

// 내용을 읽지 못하는 파일이라도 이름은 안다 — 학생 데이터일 수 있는 파일을 이름으로
// 골라 심사자가 직접 열어보게 한다 (조용한 제외 금지의 파일명 층위).
// 영문 키워드는 단어 시작 위치만 매치 — 'upgrade'/'degrade'가 'grade'로 잡히지 않게.
const SUSPECT_EXT = /\.(xlsx?|hwpx?|docx?|db|sqlite3?|accdb|mdb)$/i
export const SUSPECT_NAME = /(학생|명단|성적|상담|연락처|주소록|출석|반배정|생기부)|(?<![a-z])(roster|student|grade)/i

export function isVendorPath(path) {
  return SKIP_PATH.test(path)
}

export function suspectDataFiles(paths) {
  return paths.filter((p) => {
    if (isVendorPath(p)) return false
    const name = p.split('/').pop()
    return SUSPECT_EXT.test(name) || SUSPECT_NAME.test(name)
  })
}

// 수집 상한에 걸릴 때 무엇을 먼저 읽을지 — 보안 설정 > 코드 > 문서 순.
export function loadPriority(path) {
  const name = path.split('/').pop()
  if (/\.rules$|^\.env|firestore|firebase\.json|vercel\.json|supabase|package\.json/i.test(name)) return 0
  if (/\.(md|txt)$/i.test(name)) return 2
  return 1
}

export function countBySeverity(findings) {
  const counts = { critical: 0, warning: 0, info: 0 }
  for (const f of findings) counts[f.rule.severity]++
  return counts
}
