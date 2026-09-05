// AI 전송 전 로컬 마스킹·선별 (신뢰성 원칙 7·8).
// 데이터 파일은 내용을 보내지 않고 존재만 고지, 비밀키는 마스킹, 전송 상한은
// 우선순위 선별 + 커버리지 고지로 처리한다 — 조용한 절단 금지.
import rules from '../data/securityRules.js'
import { maskSecret, secretOf, SUSPECT_NAME } from './scanner.js'

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
// 확장자만으로는 명부를 못 거른다 — json·txt·xml 같은 데이터성 파일은 이름과 내용 모양까지 본다.
const DATA_LIKE_EXT = /\.(json|txt|xml|ya?ml|md)$/i
const PERSON_KEY = /(phone|전화|연락처|birth|생년|주민|rrn|jumin|학번|student_?(?:id|no|num)|email|이메일|address|주소|parent|보호자|학부모)/i
const NAME_KEY = /^(?:name|이름|성명|student_?name)$/i
const CLASS_KEY = /(class|반|grade|학년|number|번호|seat)/i
const PII_PATTERN = /\b01[016789]-?\d{3,4}-?\d{4}\b|\b\d{6}-[1-4]\d{6}\b|[\w.+-]+@[\w-]+\.[a-z]{2,}/gi
const LOW_PRIORITY = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.min\.(js|css)|bundle\.js)$/i
const HIGH_PRIORITY = /(^\.env|\.rules$|firestore|firebase\.json|vercel\.json|netlify|supabase|config|package\.json|index\.html)/i

const secretRules = rules.filter((r) => r.maskSecret)

export function redactSecrets(text) {
  let out = text
  for (const rule of secretRules) {
    const g = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g')
    // 콜백 인자: (전체 매치, 그룹들…, 위치, 원문) — 캡처 그룹이 있으면 비밀값 본체만 가린다.
    out = out.replace(g, (...args) => {
      const m = args.slice(0, -2)
      return maskSecret(m[0], secretOf(m))
    })
  }
  return out
}

function jsonLooksLikeRoster(text) {
  if (text.length > 2_000_000) return false
  let data
  try { data = JSON.parse(text) } catch { return false }
  const arrays = []
  const collect = (v, depth) => {
    if (depth > 3 || !v || typeof v !== 'object') return
    if (Array.isArray(v)) { arrays.push(v); return }
    for (const x of Object.values(v)) collect(x, depth + 1)
  }
  collect(data, 0)
  return arrays.some((arr) => {
    const objs = arr.filter((x) => x && typeof x === 'object' && !Array.isArray(x))
    if (objs.length < 5) return false
    const keys = [...new Set(objs.flatMap((o) => Object.keys(o)))]
    return keys.some((k) => PERSON_KEY.test(k)) || (keys.some((k) => NAME_KEY.test(k)) && keys.some((k) => CLASS_KEY.test(k)))
  })
}

// 전송 보류 사유를 돌려준다 (null이면 전송 대상). 코드 파일은 보류하지 않는다 — AI가 하드코딩된
// 실데이터를 봐야 R-admin-data 같은 항목을 판정할 수 있고, 그 값은 어차피 마스킹 규칙이 가린다.
export function withheldReason(file) {
  if (DATA_FILE.test(file.path)) return '데이터 파일(csv·tsv·sql)'
  if (!DATA_LIKE_EXT.test(file.path)) return null
  const name = file.path.split('/').pop()
  if (SUSPECT_NAME.test(name)) return '학생 데이터로 보이는 파일명'
  if (/\.json$/i.test(name) && jsonLooksLikeRoster(file.text)) return '학생 명부 모양의 JSON'
  const pii = (file.text.match(PII_PATTERN) || []).length
  if (pii >= 5) return `연락처·주민번호·이메일 형식 ${pii}건 포함`
  return null
}

function partition(files) {
  const dataFiles = []
  const candidates = []
  for (const f of files) {
    const reason = withheldReason(f)
    if (reason) dataFiles.push({ path: f.path, reason })
    else candidates.push({ ...f, priority: priorityOf(f) })
  }
  candidates.sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path))
  return { dataFiles, candidates }
}

const dataNoteFor = (dataFiles) => dataFiles.length > 0
  ? `\n===== 데이터 파일 고지 =====\n다음 파일은 데이터·학생 명부로 보여 개인정보 보호를 위해 내용을 전송하지 않았다 (존재만 고지): ${dataFiles.map((f) => `${f.path}(${f.reason})`).join(', ')}\n`
  : ''

// 커버리지 분모는 전송 대상 파일 수 — 일부러 보류한 데이터 파일을 분모에 넣으면 없는 공백을 경고하게 된다.
const coverageOf = (included, candidates) => (candidates.length === 0 ? 0 : Math.round((included / candidates.length) * 100))

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
  const { dataFiles, candidates } = partition(files)

  const includedFiles = []
  const excludedFiles = dataFiles.map((f) => ({ path: f.path, reason: `${f.reason} — 내용 미전송(존재만 고지)` }))
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

  parts.push(dataNoteFor(dataFiles))

  return { payloadText: parts.join(''), includedFiles, excludedFiles, dataFiles: dataFiles.map((f) => f.path), coveragePercent: coverageOf(includedFiles.length, candidates) }
}

/**
 * 분할 분석용 (원칙 8 개정): 호출 1회 한도를 넘는 저장소는 여러 묶음으로 나눠 전부 검토한다.
 * returns { chunks: [payloadText], includedFiles, excludedFiles, dataFiles, coveragePercent }
 */
export function buildAiPayloadChunks(files, perChunk = CHUNK_TOKENS, maxChunks = MAX_CHUNKS) {
  const { dataFiles, candidates } = partition(files)

  const includedFiles = []
  const excludedFiles = dataFiles.map((f) => ({ path: f.path, reason: `${f.reason} — 내용 미전송(존재만 고지)` }))
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

  const dataNote = dataNoteFor(dataFiles)
  const chunks = chunkParts.filter((p) => p.length > 0).map((p) => p.join('') + dataNote)

  return { chunks: chunks.length > 0 ? chunks : [dataNote || '(전송할 파일 없음)'], includedFiles, excludedFiles, dataFiles: dataFiles.map((f) => f.path), coveragePercent: coverageOf(includedFiles.length, candidates) }
}
