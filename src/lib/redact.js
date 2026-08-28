// AI 전송 전 로컬 마스킹·선별 (신뢰성 원칙 7·8).
// 데이터 파일은 내용을 보내지 않고 존재만 고지, 비밀키는 마스킹, 전송 상한은
// 우선순위 선별 + 커버리지 고지로 처리한다 — 조용한 절단 금지.
import rules from '../data/securityRules.js'
import { maskSecret } from './scanner.js'

export const MAX_PAYLOAD_CHARS = 150_000

const DATA_FILE = /\.(csv|tsv|sql)$/i
const LOW_PRIORITY = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.min\.(js|css)|bundle\.js)$/i
const HIGH_PRIORITY = /(^\.env|\.rules$|firestore|firebase\.json|vercel\.json|netlify|supabase|config|package\.json|index\.html)/i

const secretRules = rules.filter((r) => r.maskSecret)

export function redactSecrets(text) {
  let out = text
  for (const rule of secretRules) {
    const g = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g')
    out = out.replace(g, (m) => maskSecret(m, m))
  }
  return out
}

function priorityOf(file) {
  const name = file.path.split('/').pop()
  if (LOW_PRIORITY.test(name)) return 2
  if (HIGH_PRIORITY.test(name) || HIGH_PRIORITY.test(file.path)) return 0
  return 1
}

/**
 * files: [{path, name, text}]
 * returns { payloadText, includedFiles, excludedFiles: [{path, reason}], dataFiles, coveragePercent }
 */
export function buildAiPayload(files, maxChars = MAX_PAYLOAD_CHARS) {
  const dataFiles = files.filter((f) => DATA_FILE.test(f.path))
  const candidates = files
    .filter((f) => !DATA_FILE.test(f.path))
    .map((f) => ({ ...f, priority: priorityOf(f) }))
    .sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path))

  const includedFiles = []
  const excludedFiles = dataFiles.map((f) => ({ path: f.path, reason: '데이터 파일 — 내용 미전송(존재만 고지)' }))
  const parts = []
  let used = 0

  for (const f of candidates) {
    const safe = redactSecrets(f.text)
    const block = `\n===== 파일: ${f.path} =====\n${safe}\n`
    if (used + block.length > maxChars) {
      excludedFiles.push({ path: f.path, reason: '전송 상한(150k자) 초과 — 우선순위 선별에서 제외' })
      continue
    }
    parts.push(block)
    includedFiles.push(f.path)
    used += block.length
  }

  if (dataFiles.length > 0) {
    parts.push(`\n===== 데이터 파일 고지 =====\n다음 데이터 파일이 저장소에 존재하지만 개인정보 보호를 위해 내용은 전송하지 않았다: ${dataFiles.map((f) => f.path).join(', ')}\n`)
  }

  const scannableTotal = files.length
  const coveragePercent = scannableTotal === 0 ? 0 : Math.round((includedFiles.length / scannableTotal) * 100)
  return { payloadText: parts.join(''), includedFiles, excludedFiles, dataFiles: dataFiles.map((f) => f.path), coveragePercent }
}
