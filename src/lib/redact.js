// AI 전송 전 로컬 마스킹·선별 (신뢰성 원칙 7·8).
// 데이터 파일은 내용을 보내지 않고 존재만 고지, 비밀키는 마스킹, 전송 상한은
// 우선순위 선별 + 커버리지 고지로 처리한다 — 조용한 절단 금지.
import rules from '../data/securityRules.js'
import { maskSecret } from './scanner.js'

export const MAX_PAYLOAD_CHARS = 150_000
export const CHUNK_TOKENS = 100_000
export const MAX_CHUNKS = 3

// 문자 수가 아니라 추정 토큰으로 묶음 예산을 잡는다 — 한글 위주 파일은 글자당 1토큰에
// 가까워서, 문자 수 기준이면 컨텍스트 한도(400 오류)를 넘길 수 있다.
export function estimateTokens(s) {
  let ascii = 0
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 128) ascii++
  }
  return Math.ceil(ascii / 3.5) + (s.length - ascii)
}

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

/**
 * 분할 분석용 (원칙 8 개정): 호출 1회 한도를 넘는 저장소는 여러 묶음으로 나눠 전부 검토한다.
 * returns { chunks: [payloadText], includedFiles, excludedFiles, dataFiles, coveragePercent }
 */
export function buildAiPayloadChunks(files, perChunk = CHUNK_TOKENS, maxChunks = MAX_CHUNKS) {
  const dataFiles = files.filter((f) => DATA_FILE.test(f.path))
  const candidates = files
    .filter((f) => !DATA_FILE.test(f.path))
    .map((f) => ({ ...f, priority: priorityOf(f) }))
    .sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path))

  const includedFiles = []
  const excludedFiles = dataFiles.map((f) => ({ path: f.path, reason: '데이터 파일 — 내용 미전송(존재만 고지)' }))
  const chunkParts = [[]]
  let used = 0

  for (const f of candidates) {
    const safe = redactSecrets(f.text)
    const block = `\n===== 파일: ${f.path} =====\n${safe}\n`
    const cost = estimateTokens(block)
    if (cost > perChunk) {
      excludedFiles.push({ path: f.path, reason: '단일 파일이 호출 1회 한도를 초과 — 제외' })
      continue
    }
    if (used + cost > perChunk) {
      if (chunkParts.length >= maxChunks) {
        excludedFiles.push({ path: f.path, reason: `분할 한도(${maxChunks}회 호출) 초과 — 제외` })
        continue
      }
      chunkParts.push([])
      used = 0
    }
    chunkParts[chunkParts.length - 1].push(block)
    includedFiles.push(f.path)
    used += cost
  }

  const dataNote = dataFiles.length > 0
    ? `\n===== 데이터 파일 고지 =====\n다음 데이터 파일이 저장소에 존재하지만 개인정보 보호를 위해 내용은 전송하지 않았다: ${dataFiles.map((f) => f.path).join(', ')}\n`
    : ''
  const chunks = chunkParts.filter((p) => p.length > 0).map((p) => p.join('') + dataNote)

  const scannableTotal = files.length
  const coveragePercent = scannableTotal === 0 ? 0 : Math.round((includedFiles.length / scannableTotal) * 100)
  return { chunks: chunks.length > 0 ? chunks : [dataNote || '(전송할 파일 없음)'], includedFiles, excludedFiles, dataFiles: dataFiles.map((f) => f.path), coveragePercent }
}
