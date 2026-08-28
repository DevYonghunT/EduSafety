// 보고서 렌더러 — edusafe-report.json 을 계약으로 검증하고 MD·HTML 로 렌더한다.
// 외부 의존성 0 (Node 내장 모듈만).
//
//   node edusafe/scripts/render.mjs <stagingDir>
//
// AI 는 edusafe-report.json 만 작성하고, 사람이 읽는 형식은 전부 여기서 나온다 (spec REQ-4.3).
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rules as scanRules } from '../rules/scan-rules.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES = join(HERE, '..', 'rules')

export const loadContract = () => JSON.parse(readFileSync(join(RULES, 'report.contract.json'), 'utf8'))
export const loadItems = () => JSON.parse(readFileSync(join(RULES, 'items.json'), 'utf8')).items
export const loadVersion = () => JSON.parse(readFileSync(join(RULES, 'version.json'), 'utf8'))

export const joinPath = (path, key) => `${path}.${key}`

// 계약 행의 path + 객체 행의 keys 로 만든 자식 경로 + evidence 판별 표의 허용 키.
export function allowedPaths(contract) {
  const set = new Set()
  for (const f of contract.fields) {
    set.add(f.path)
    if (f.keys) for (const k of f.keys) set.add(joinPath(f.path, k))
  }
  // REQ-8.28: evidence[] 아래는 type 별 허용 키의 합집합으로 연다.
  // 합집합만으로 열면 quote 원소에 rules 를 넣어도 통과하므로, type 별 정확 일치는 검사 4번이 따로 잡는다.
  const evidenceKeys = new Set(Object.values(contract.evidence_types).flat())
  for (const f of contract.fields) {
    if (!/(^|\.)evidence$/.test(f.path)) continue
    set.add(`${f.path}[]`)
    for (const k of evidenceKeys) set.add(`${f.path}[].${k}`)
  }
  return set
}

// 보고서를 순회하며 나타나는 모든 키 경로를 모은다. 배열 인덱스는 [] 로 정규화한다.
function collectPaths(value, path, out) {
  if (path !== '') out.add(path)
  if (Array.isArray(value)) {
    // 스칼라 원소는 자기 경로를 만들지 않는다. array<string> 의 원소까지 경로로 세면
    // 계약에 없는 `project.stack[]` 같은 경로가 생겨 정상 보고서가 거부된다.
    // 스칼라 원소의 값은 그 배열 행의 allowed 로 검사한다.
    for (const v of value) {
      if (v !== null && typeof v === 'object') collectPaths(v, `${path}[]`, out)
    }
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const k of Object.keys(value)) collectPaths(value[k], path === '' ? k : `${path}.${k}`, out)
  }
}

// 계약 경로가 가리키는 실제 값들을 찾는다. `items[].subchecks[].id` 처럼 배열을 건너뛴다.
function valuesAt(report, path) {
  let cursor = [{ value: report, where: '' }]
  for (const part of path.split('.')) {
    const isArray = part.endsWith('[]')
    const key = isArray ? part.slice(0, -2) : part
    const next = []
    for (const c of cursor) {
      if (c.value === null || c.value === undefined || typeof c.value !== 'object') continue
      const where = c.where === '' ? key : `${c.where}.${key}`
      const child = c.value[key]
      if (child === undefined) { next.push({ value: undefined, where, missing: true }); continue }
      if (!isArray) { next.push({ value: child, where }); continue }
      if (!Array.isArray(child)) { next.push({ value: child, where, notArray: true }); continue }
      child.forEach((el, i) => next.push({ value: el, where: `${where}[${i}]` }))
    }
    cursor = next
  }
  return cursor
}

function typeOk(type, value) {
  const nullable = type.endsWith('?')
  const base = nullable ? type.slice(0, -1) : type
  if (value === null) return nullable
  if (base === 'string') return typeof value === 'string'
  if (base === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (base === 'boolean') return typeof value === 'boolean'
  if (base.startsWith('array<')) return Array.isArray(value)
  if (base.startsWith('object')) return value !== null && typeof value === 'object' && !Array.isArray(value)
  return false
}

// 계약의 제약 칸 중 기계적으로 판정할 수 있는 것들
function constraintErrors(field, value, where) {
  const c = field.spec_constraint
  const out = []
  if (value === null || value === undefined) return out
  if (c.startsWith('0 이상 정수')) {
    if (!Number.isInteger(value) || value < 0) out.push(`${where}: 0 이상 정수여야 합니다 (받은 값 ${JSON.stringify(value)})`)
  }
  if (c === '비어 있지 않음') {
    if (typeof value !== 'string' || value.trim() === '') out.push(`${where}: 비어 있지 않은 문자열이어야 합니다`)
  }
  if (c === '1~8') {
    if (!Number.isInteger(value) || value < 1 || value > 8) out.push(`${where}: 1~8 범위여야 합니다 (받은 값 ${JSON.stringify(value)})`)
  }
  return out
}

// 훼손된 보고서가 들어와도 검증기가 죽지 않게 한다 — 죽으면 "거부"가 아니라 크래시다
const asArray = (v) => (Array.isArray(v) ? v : [])

// spec §8.3.5 — evidence 키의 타입. 키 집합만 보고 값 타입을 안 보면
// rules 가 문자열이어도 통과해 렌더에서 크래시한다(리뷰에서 실측).
const EVIDENCE_KEY_TYPES = {
  type: 'string',
  source: 'string',
  file: 'string',
  line: 'number',
  quote: 'string',
  rules: 'array<string>',
  files_scanned: 'number',
}
const EVIDENCE_SOURCES = ['scanner', 'code', 'evidence', 'teacher']

// REQ-7.3 우선순위 — 검증된 fail > needs_human > 교사확인 pass > 검증된 pass > na
const VERDICT_RANK = { fail: 0, needs_human: 1, pass: 2, na: 3 }

// REQ-7.5 — 하위 점검이 있는 항목의 판정은 하위 점검 중 최악이다.
// na 인 하위 점검은 집계에서 제외하되, 전부 na 면 항목도 na 다.
export function rollupVerdict(subchecks) {
  const verdicts = asArray(subchecks).map((s) => s && s.verdict).filter((v) => typeof v === 'string')
  if (verdicts.length === 0) return null // 하위 점검이 없는 항목은 이 규칙의 대상이 아니다
  if (verdicts.every((v) => v === 'na')) return 'na'
  const ranked = verdicts.filter((v) => v !== 'na').sort((a, b) => (VERDICT_RANK[a] ?? 9) - (VERDICT_RANK[b] ?? 9))
  return ranked[0]
}

const SEVERITY_BUCKET = { high: 'must_fix', medium: 'recommended', low: 'info' }

// REQ-7.26 — needs_human 항목의 사유를 정해진 우선순위로 하나만 센다.
// coverage-insufficient · unsupported-stack 은 사유 문자열로 식별하고,
// 둘 다 아니면 확인 세션 미답변(unanswered)으로 본다 — 세 소계의 합이 total 이어야 하므로
// needs_human 항목은 반드시 셋 중 하나에 속한다.
export function needsHumanBucket(item) {
  const reasons = [item.demotion_reason, ...asArray(item.subchecks).map((s) => s && s.reason)]
    .filter((r) => typeof r === 'string').join(' ')
  if (reasons.includes('coverage-insufficient')) return 'coverage'
  if (reasons.includes('unsupported-stack')) return 'unsupported'
  return 'unanswered'
}

// REQ-8.22 — 매핑 항목이 여럿이면 REQ-7.3 의 순서로 최악을 택한다.
export function moeStatusFor(mappedItems, itemsInReport) {
  const verdicts = mappedItems
    .map((id) => itemsInReport.find((i) => i.item_id === id))
    .filter(Boolean)
    .map((i) => i.verdict)
  if (verdicts.length === 0) return '확인필요'
  if (verdicts.includes('fail')) return '미충족'
  if (verdicts.includes('needs_human')) return '확인필요'
  if (verdicts.every((v) => v === 'na')) return '해당없음'
  return '충족'
}

export function recomputeSummary(reportItems) {
  const summary = {
    must_fix: 0, recommended: 0, info: 0, teacher_confirmed: 0,
    needs_human: { total: 0, coverage: 0, unsupported: 0, unanswered: 0 },
  }
  for (const it of reportItems) {
    if (it.verdict === 'fail') {
      // REQ-7.20 — 집계는 base_severity 가 아니라 effective_severity 로 센다
      const bucket = SEVERITY_BUCKET[it.effective_severity]
      if (bucket) summary[bucket] += 1
    }
    if (it.verdict === 'pass' && it.verification_level === 'attested') summary.teacher_confirmed += 1
    if (it.verdict === 'needs_human') {
      summary.needs_human[needsHumanBucket(it)] += 1
      summary.needs_human.total += 1
    }
  }
  return summary
}

export function validateReport(report, items, contract, scan = null) {
  const errors = []
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    return ['보고서가 객체가 아닙니다']
  }
  const version = loadVersion()

  // 1. 허용되지 않은 키 거부 (REQ-8.10 · REQ-8.24)
  const allowed = allowedPaths(contract)
  const seen = new Set()
  collectPaths(report, '', seen)
  for (const p of [...seen].sort()) {
    if (!allowed.has(p)) errors.push(`허용되지 않은 필드: ${p}`)
  }

  // 2·3. 필수·타입·허용값·원소 필수 키
  for (const field of contract.fields) {
    for (const found of valuesAt(report, field.path)) {
      if (found.missing || found.value === undefined) {
        if (field.required) errors.push(`필수 필드 누락: ${found.where}`)
        continue
      }
      if (!typeOk(field.type, found.value)) {
        errors.push(`${found.where}: 타입이 ${field.type} 이어야 합니다 (받은 값 ${Array.isArray(found.value) ? 'array' : typeof found.value})`)
        continue
      }
      if (field.allowed && found.value !== null) {
        const values = Array.isArray(found.value) ? found.value : [found.value]
        for (const v of values) {
          if (!field.allowed.includes(v)) errors.push(`${found.where}: 허용값이 아닙니다 — ${JSON.stringify(v)}`)
        }
      }
      errors.push(...constraintErrors(field, found.value, found.where))
      // array<T> 는 배열 여부만이 아니라 원소 타입까지 본다.
      // 이게 없으면 array<string> 에 숫자를 넣어도 통과해 렌더에 그대로 나온다(리뷰에서 실측).
      const elementType = field.type.match(/^array<(\w+)>/)
      if (elementType && Array.isArray(found.value)) {
        found.value.forEach((el, i) => {
          const ok = elementType[1] === 'string'
            ? typeof el === 'string'
            : el !== null && typeof el === 'object' && !Array.isArray(el)
          if (!ok) errors.push(`${found.where}[${i}]: 원소는 ${elementType[1]} 이어야 합니다`)
        })
      }
      if (field.element_required && Array.isArray(found.value)) {
        found.value.forEach((el, i) => {
          if (el === null || typeof el !== 'object' || Array.isArray(el)) {
            errors.push(`${found.where}[${i}]: 객체여야 합니다`)
            return
          }
          for (const k of field.element_required) {
            if (!(k in el)) errors.push(`${found.where}[${i}]: 원소 필수 키 누락 — ${k}`)
          }
        })
      }
    }
  }

  // 4. evidence 판별 (REQ-8.27)
  const evidenceTypes = contract.evidence_types
  for (const field of contract.fields) {
    if (!/(^|\.)evidence$/.test(field.path)) continue
    for (const found of valuesAt(report, field.path)) {
      if (!Array.isArray(found.value)) continue
      found.value.forEach((el, i) => {
        const at = `${found.where}[${i}]`
        if (el === null || typeof el !== 'object' || Array.isArray(el)) { errors.push(`${at}: evidence 원소는 객체여야 합니다`); return }
        const keys = Object.keys(evidenceTypes)
        if (!keys.includes(el.type)) { errors.push(`${at}: evidence type 은 ${keys.join('·')} 중 하나여야 합니다 — ${JSON.stringify(el.type)}`); return }
        const expected = [...evidenceTypes[el.type]].sort()
        const got = Object.keys(el).sort()
        if (JSON.stringify(expected) !== JSON.stringify(got)) {
          errors.push(`${at}: evidence(${el.type}) 의 키는 정확히 ${expected.join('·')} 여야 합니다 — 받은 키 ${got.join('·') || '(없음)'}`)
          return
        }
        // 키 집합이 맞아도 값 타입이 틀리면 렌더가 크래시한다 (spec §8.3.5)
        for (const k of expected) {
          const want = EVIDENCE_KEY_TYPES[k]
          if (!want) continue
          if (!typeOk(want, el[k])) { errors.push(`${at}.${k}: 타입이 ${want} 이어야 합니다`); continue }
          if (want === 'array<string>' && el[k].some((x) => typeof x !== 'string')) {
            errors.push(`${at}.${k}: 원소는 string 이어야 합니다`)
          }
          if (want === 'number' && (!Number.isInteger(el[k]) || el[k] < 0)) {
            errors.push(`${at}.${k}: 0 이상 정수여야 합니다`)
          }
        }
        if (typeof el.source === 'string' && !EVIDENCE_SOURCES.includes(el.source)) {
          errors.push(`${at}.source: 허용값이 아닙니다 — ${JSON.stringify(el.source)}`)
        }
      })
    }
  }

  const reportItems = asArray(report.items).filter((i) => i !== null && typeof i === 'object' && !Array.isArray(i))

  // 5. 항목 전수와 하위 점검 전수 (REQ-7.8 · REQ-8.14)
  // 집합만 비교하면 중복 id 를 놓친다(리뷰에서 실측). 개수와 중복도 함께 본다.
  const specIds = items.map((i) => i.id).sort()
  const gotIds = reportItems.map((i) => i.item_id).filter((v) => typeof v === 'string').sort()
  const missing = specIds.filter((id) => !gotIds.includes(id))
  const extra = gotIds.filter((id) => !specIds.includes(id))
  const dupes = [...new Set(gotIds.filter((id, i) => gotIds.indexOf(id) !== i))]
  if (missing.length) errors.push(`items 에 빠진 항목: ${missing.join(', ')}`)
  if (extra.length) errors.push(`items 에 없는 항목이 있습니다: ${extra.join(', ')}`)
  if (dupes.length) errors.push(`items 에 중복된 항목: ${dupes.join(', ')}`)
  if (reportItems.length !== specIds.length) {
    errors.push(`items 는 정확히 ${specIds.length}개여야 합니다 (받은 개수 ${reportItems.length})`)
  }
  for (const it of reportItems) {
    const def = items.find((i) => i.id === it.item_id)
    if (!def) continue
    const want = def.subchecks.map((s) => s.id).sort()
    const got = asArray(it.subchecks).map((s) => s && s.id).filter((v) => typeof v === 'string').sort()
    for (const id of want.filter((x) => !got.includes(x))) errors.push(`${it.item_id}: 하위 점검 ${id} 누락`)
    for (const id of got.filter((x) => !want.includes(x))) errors.push(`${it.item_id}: 정의에 없는 하위 점검 ${id}`)
    const subDupes = [...new Set(got.filter((id, i) => got.indexOf(id) !== i))]
    if (subDupes.length) errors.push(`${it.item_id}: 중복된 하위 점검 ${subDupes.join(', ')}`)
    if (asArray(it.subchecks).length !== want.length) {
      errors.push(`${it.item_id}: 하위 점검은 ${want.length}개여야 합니다 (받은 개수 ${asArray(it.subchecks).length})`)
    }

    // REQ-7.5 — 항목 판정은 하위 점검 중 최악이어야 한다.
    // 이 검사가 없으면 하위 점검의 fail 이 항목에서 na 로 조용히 사라진다(리뷰에서 실측).
    const rolled = rollupVerdict(it.subchecks)
    if (rolled !== null && it.verdict !== rolled) {
      errors.push(`${it.item_id}: 항목 판정이 하위 점검 중 최악(${rolled})과 다릅니다 — 보고서 ${it.verdict}`)
    }
    // §6 과 일치해야 하는 문안
    for (const key of ['why_risky', 'fix_hint', 'basis']) {
      if (it[key] !== def[key]) errors.push(`${it.item_id}.${key}: §6 문안과 다릅니다`)
    }
  }

  // 6. verification_level 정합 (REQ-7.25)
  const levelCheck = (verdict, level, at) => {
    if ((verdict === 'na' || verdict === 'needs_human') && level !== 'none') {
      errors.push(`${at}: verdict 가 ${verdict} 이면 verification_level 은 none 이어야 합니다`)
    }
  }
  for (const it of reportItems) {
    levelCheck(it.verdict, it.verification_level, `${it.item_id}`)
    for (const s of asArray(it.subchecks)) levelCheck(s.verdict, s.verification_level, `${it.item_id}.${s.id}`)
  }

  // 7·8. 근거 필수 (REQ-7.7) · na 사유 필수 (REQ-7.10)
  for (const it of reportItems) {
    if ((it.verdict === 'pass' || it.verdict === 'fail') && (!Array.isArray(it.evidence) || it.evidence.length === 0)) {
      errors.push(`${it.item_id}: verdict 가 ${it.verdict} 인데 근거가 없습니다`)
    }
    if (it.verdict === 'na' && (it.applicability_reason === null || it.applicability_reason === undefined)) {
      errors.push(`${it.item_id}: verdict 가 na 인데 applicability_reason 이 없습니다`)
    }
    // REQ-7.7 은 판정 일반에 대한 규범이다. 하위 점검도 판정이므로 같이 적용한다.
    for (const sub of asArray(it.subchecks)) {
      if (!sub || (sub.verdict !== 'pass' && sub.verdict !== 'fail')) continue
      if (!Array.isArray(sub.evidence) || sub.evidence.length === 0) {
        errors.push(`${it.item_id}.${sub.id}: verdict 가 ${sub.verdict} 인데 근거가 없습니다`)
      }
    }
    // 11. 인용 길이·개수 (REQ-7.12)
    if (Array.isArray(it.evidence) && it.evidence.length > 4) {
      errors.push(`${it.item_id}: 근거는 항목당 4개 이내여야 합니다 (${it.evidence.length}개)`)
    }
  }
  for (const field of contract.fields) {
    if (!/(^|\.)evidence$/.test(field.path)) continue
    for (const found of valuesAt(report, field.path)) {
      if (!Array.isArray(found.value)) continue
      found.value.forEach((el, i) => {
        if (el && typeof el.quote === 'string' && el.quote.length > 200) {
          errors.push(`${found.where}[${i}]: 인용은 200자 이내여야 합니다 (${el.quote.length}자)`)
        }
      })
    }
  }

  // 9. summary 재계산 대조 (REQ-7.22 · REQ-7.26)
  if (report.summary && typeof report.summary === 'object') {
    const want = recomputeSummary(reportItems)
    for (const k of ['must_fix', 'recommended', 'info', 'teacher_confirmed']) {
      if (report.summary[k] !== want[k]) errors.push(`summary.${k}: items[] 재계산 값과 다릅니다 (보고서 ${report.summary[k]} · 재계산 ${want[k]})`)
    }
    const nh = report.summary.needs_human
    if (nh && typeof nh === 'object') {
      for (const k of ['total', 'coverage', 'unsupported', 'unanswered']) {
        if (nh[k] !== want.needs_human[k]) errors.push(`summary.needs_human.${k}: items[] 재계산 값과 다릅니다 (보고서 ${nh[k]} · 재계산 ${want.needs_human[k]})`)
      }
      if (nh.total !== nh.coverage + nh.unsupported + nh.unanswered) {
        errors.push('summary.needs_human.total 이 세 소계의 합과 다릅니다')
      }
    }
  }

  // 10. 서식1 상태 재계산 대조 (REQ-8.22)
  if (Array.isArray(report.moe_checklist)) {
    const criteria = report.moe_checklist.map((m) => m && m.criterion)
    const criterionDupes = [...new Set(criteria.filter((c, i) => criteria.indexOf(c) !== i))]
    if (criterionDupes.length) errors.push(`moe_checklist 에 중복된 기준: ${criterionDupes.join(', ')}`)
    for (const row of report.moe_checklist) {
      if (!row || !Array.isArray(row.mapped_items)) continue
      // 매핑이 비면 status 가 무조건 "확인필요" 가 되어 어떤 값이든 통과한다(리뷰에서 실측)
      if (row.mapped_items.length === 0) {
        errors.push(`moe_checklist[${row.criterion}]: mapped_items 가 비어 있습니다`)
        continue
      }
      const want = moeStatusFor(row.mapped_items, reportItems)
      if (row.status !== want) errors.push(`moe_checklist[${row.criterion}].status: 재계산 값과 다릅니다 (보고서 ${row.status} · 재계산 ${want})`)
      for (const id of row.mapped_items) {
        if (!items.some((i) => i.id === id)) errors.push(`moe_checklist[${row.criterion}]: items.json 에 없는 항목 ${id}`)
      }
    }
  }

  // documentation_hits 는 scan.json 에서 다시 센다 (§8.3.1 "계약 + scan.json 재계산 대조").
  // secretValue 규칙의 문서 hit 은 판정 근거로 그대로 쓰므로(REQ-7.15) 각주 집계에서 뺀다.
  if (scan && Array.isArray(scan.hits) && report.summary && typeof report.summary === 'object') {
    const secretRules = new Set(scanRules.filter((r) => r.secretValue).map((r) => r.id))
    const want = scan.hits.filter((h) => h.documentation && !secretRules.has(h.rule)).length
    if (report.summary.documentation_hits !== want) {
      errors.push(`summary.documentation_hits: scan.json 재계산 값과 다릅니다 (보고서 ${report.summary.documentation_hits} · 재계산 ${want})`)
    }
  }

  // 12. 버전 일치
  if (report.edusafe_version !== version.edusafe_version) errors.push(`edusafe_version 이 version.json 과 다릅니다`)
  if (report.rubric_version !== version.rubric_version) errors.push(`rubric_version 이 version.json 과 다릅니다`)

  return errors
}

// ── MD 렌더 (REQ-8.20) ───────────────────────────────────────────────────
// HTML 과 같은 정보를 담는다. Node 가 없어 이 스크립트를 못 돌릴 때는
// 에이전트가 같은 내용을 직접 작성한다 (REQ-8.21).

const PIPE_ESCAPE = String.fromCharCode(92) + '|'

// 표 칸 안에서 파이프와 줄바꿈은 표를 깨뜨린다
const esc = (v) => String(v === null || v === undefined ? '' : v)
  .split('|').join(PIPE_ESCAPE)
  .split('\n').join(' ')
  .split('\r').join('')

const yesNo = (v) => (v === true ? '예' : v === false ? '아니오' : esc(v))

// CommonMark 규칙 — 내용에 백틱이 있으면 그보다 긴 울타리를 쓴다.
// 고정 길이 백틱으로 감싸면 인용 안의 백틱이 코드 스팬을 깨뜨린다.
const BACKTICK = String.fromCharCode(96)
function codeSpan(text) {
  const s = String(text === null || text === undefined ? '' : text).split('\n').join(' ').split('\r').join('')
  const runs = s.match(new RegExp(BACKTICK + '+', 'g')) || []
  const fence = BACKTICK.repeat(Math.max(0, ...runs.map((r) => r.length)) + 1)
  const pad = s.startsWith(BACKTICK) || s.endsWith(BACKTICK) ? ' ' : ''
  return fence + pad + s + pad + fence
}

// 계약이 렌더 대상으로 표시한 근거는 항목·하위 점검·DB 경로 세 곳 모두에서 나와야 한다(REQ-8.11).
function evidenceLines(list, indent = '') {
  const out = []
  for (const e of asArray(list)) {
    if (!e || typeof e !== 'object') continue
    if (e.type === 'quote') {
      out.push(`${indent}- ${codeSpan(`${e.file}:${e.line}`)} (${esc(e.source)}) — ${codeSpan(e.quote)}`)
    } else {
      out.push(`${indent}- 부재 증명: 규칙 ${esc(asArray(e.rules).join(', '))} 로 파일 ${e.files_scanned}개 검사 (${esc(e.source)})`)
    }
  }
  return out
}

// spec §7.1 — 출처에 따라 표기가 갈린다. 교사 확인은 검증된 충족과 섞지 않는다.
export function verdictLabel(verdict, level) {
  if (verdict === 'pass') return level === 'attested' ? '교사 확인: 충족' : '충족'
  if (verdict === 'fail') return '미충족'
  if (verdict === 'na') return '해당없음'
  return '판단불가'
}

export const MOE_DISCLAIMER =
  '이 표는 교육부 [서식 1] 작성에 참고하는 자료이며, 학교운영위원회 심의나 서식 제출을 대체하지 않습니다. 최종 확인·작성은 학교가 합니다.'

export const TRUST_BOUNDARY =
  '이 보고서는 거울이지 증명서가 아닙니다 — 인증은 교육청 심사에서 코드를 직접 재검사합니다.'

// spec §6 의 적용 범위 각주
export const SCOPE_FOOTNOTES = [
  '고시 **제3조**: "보유 수·유형·정보주체에게 미치는 영향 등을 고려하여 **스스로의 환경에 맞는** 조치" — 교사 앱에 대기업 수준을 요구하지 않는다.',
  '고시 **제4조 단서**: 1만명 미만을 처리하는 소상공인·개인·단체는 **내부 관리계획 수립·시행 생략 가능**. 단 제5~13조(접근권한·접근통제·암호화·파기 등)는 적용된다.',
  '접속기록 보관(제8조)·악성프로그램(제9조)·물리적 안전조치(제10조)는 코드 밖 운영 영역이라 이 스킬의 검사 대상이 아니며, 보고서 각주로만 안내한다.',
]

function coverageRows(coverage) {
  const rows = [['runtime', esc(coverage.runtime), '—']]
  for (const axis of ['scanner', 'history', 'build', 'code', 'evidence', 'teacher']) {
    const c = coverage[axis] || {}
    rows.push([axis, esc(c.status), c.reason === null || c.reason === undefined ? '—' : esc(c.reason)])
  }
  return rows
}

export function renderMarkdown(report, items) {
  const L = []
  const table = (head, rows) => {
    L.push('| ' + head.join(' | ') + ' |')
    L.push('|' + head.map(() => '---').join('|') + '|')
    for (const r of rows) L.push('| ' + r.join(' | ') + ' |')
    L.push('')
  }

  const s = report.summary
  const nh = s.needs_human

  L.push('# 에듀세이프 자가점검 보고서')
  L.push('')
  L.push('## 종합 판정')
  L.push('')
  L.push('```')
  L.push(`🔴 배포 전 반드시 수정  ${s.must_fix}건`)
  L.push(`🟡 권장 수정            ${s.recommended}건`)
  L.push(`⚪ 참고                 ${s.info}건`)
  L.push(`❓ 판단불가             ${nh.total}건   (커버리지 부족 ${nh.coverage} · 미지원 스택 ${nh.unsupported} · 미답변 ${nh.unanswered})`)
  L.push(`✍️ 교사 확인 항목       ${s.teacher_confirmed}건`)
  L.push('```')
  L.push('')
  // REQ-7.21 — 점수를 매기지 않는다. 0이어도 "통과"라 쓰지 않는다.
  if (s.must_fix === 0) L.push('반드시 수정 항목 없음.')
  L.push(`문서에서 발견(참고) ${s.documentation_hits}건 — 문서 파일의 hit 은 판정 근거로 쓰지 않았습니다.`)
  L.push('')

  L.push('## 검사 메타')
  L.push('')
  table(['항목', '값'], [
    ['스킬 버전', esc(report.edusafe_version)],
    ['루브릭 버전', esc(report.rubric_version)],
    ['스키마 버전', esc(report.schema_version)],
    ['검사 시각', esc(report.checked_at)],
    ['프로젝트', esc(report.project.name)],
    ['스택', esc(report.project.stack.join(', ')) || '(감지 없음)'],
    ['정식 지원 스택', yesNo(report.project.supported_stack)],
    ['git SHA', report.project.git ? esc(report.project.git.sha) : '—'],
    ['git dirty', report.project.git ? yesNo(report.project.git.dirty) : '—'],
    ['untracked 포함', report.project.git ? yesNo(report.project.git.untracked_included) : '—'],
    ['검사한 ref', report.project.git ? esc(report.project.git.refs_scanned.join(', ')) || '—' : '—'],
    ['빌드 산출물 지문', esc(report.project.build_artifact_digest) || '—'],
    ['스킬 지문(자가보고)', esc(report.self_reported_skill_digest) || '—'],
  ])

  L.push('### coverage')
  L.push('')
  table(['축', '상태', '사유'], coverageRows(report.coverage))
  const sc = report.coverage.scanner
  L.push(`검사한 파일 ${sc.files_scanned}개 · 건너뛴 파일 ${sc.files_skipped.length}개`)
  L.push('')
  if (sc.files_skipped.length > 0) {
    table(['건너뛴 파일', '사유'], sc.files_skipped.map((f) => [esc(f.path), esc(f.reason)]))
  }

  L.push('## 교육부 [서식 1] 필수기준 대조표')
  L.push('')
  table(['기준', '내용', '우리 항목', '상태'], report.moe_checklist.map((m) => [
    esc(m.criterion), esc(m.text), esc(m.mapped_items.join(', ')), esc(m.status),
  ]))
  L.push('> ' + MOE_DISCLAIMER)
  L.push('')

  L.push('## DB 도달 경로')
  L.push('')
  if (report.db_paths.length === 0) L.push('기록된 경로가 없습니다.')
  else {
    table(['테이블', '동작', '위치', '인증', '소유권', '역할', '검증', '호출제한'], report.db_paths.map((p) => [
      esc(p.table), esc(p.op), `${esc(p.file)}:${p.line}`,
      esc(p.controls.authentication), esc(p.controls.ownership), esc(p.controls.role),
      esc(p.controls.validation), esc(p.controls.rate_limit),
    ]))
    const pathEvidence = report.db_paths.filter((p) => asArray(p.evidence).length > 0)
    if (pathEvidence.length > 0) {
      L.push('경로별 근거')
      L.push('')
      for (const p of pathEvidence) {
        L.push(`- ${esc(p.table)} (${esc(p.op)}) ${esc(p.file)}:${p.line}`)
        L.push(...evidenceLines(p.evidence, '  '))
      }
    }
  }
  L.push('')

  L.push('## 목적지 인벤토리')
  L.push('')
  if (report.destinations.length === 0) L.push('기록된 목적지가 없습니다.')
  else {
    table(['서비스', '구분', '목적', '지위', '저장', '리전', '데이터', '위치'], report.destinations.map((d) => [
      esc(d.service), esc(d.kind), esc(d.purpose), esc(d.controller_role),
      yesNo(d.storage), esc(d.region), esc(d.data.join(', ')) || '—', `${esc(d.file)}:${d.line}`,
    ]))
  }
  L.push('')

  L.push('## 항목별 판정')
  L.push('')
  for (let category = 1; category <= 8; category++) {
    const group = report.items.filter((i) => i.category === category)
    if (group.length === 0) continue
    L.push(`### 카테고리 ${category}`)
    L.push('')
    for (const it of group) {
      const def = items.find((d) => d.id === it.item_id)
      L.push(`#### ${it.item_id} — ${def ? def.question : ''}`)
      L.push('')
      L.push(`- 판정: **${verdictLabel(it.verdict, it.verification_level)}**`)
      L.push(`- 중요도: ${it.base_severity}${it.effective_severity !== it.base_severity ? ` → ${it.effective_severity}` : ''}`)
      L.push(`- 출처: ${it.sources.length ? it.sources.join(', ') : '—'}`)
      if (it.applicability_reason) L.push(`- 해당없음 사유: ${it.applicability_reason}`)
      if (it.demotion_reason) L.push(`- 강등 사유: ${it.demotion_reason}`)
      L.push(`- 판정 근거 서술: ${it.reasoning}`)
      L.push('')
      L.push('하위 점검')
      L.push('')
      table(['하위 점검', '판정', 'coverage', '출처', '사유'], it.subchecks.map((sub) => [
        esc(sub.id), verdictLabel(sub.verdict, sub.verification_level), esc(sub.coverage_status),
        sub.sources.length ? esc(sub.sources.join(', ')) : '—', esc(sub.reason) || '—',
      ]))
      const subEvidence = asArray(it.subchecks).filter((sub) => asArray(sub.evidence).length > 0)
      if (subEvidence.length > 0) {
        L.push('하위 점검 근거')
        L.push('')
        for (const sub of subEvidence) {
          L.push(`- ${esc(sub.id)}`)
          L.push(...evidenceLines(sub.evidence, '  '))
        }
        L.push('')
      }
      if (asArray(it.evidence).length > 0) {
        L.push('근거')
        L.push('')
        L.push(...evidenceLines(it.evidence))
        L.push('')
      }
      L.push(`**왜 위험한가** — ${it.why_risky}`)
      L.push('')
      L.push(`**수정 방법** — ${it.fix_hint}`)
      L.push('')
      L.push(`**근거 법령** — ${it.basis}`)
      L.push('')
    }
  }

  L.push('## 확인 세션 기록')
  L.push('')
  if (report.session.length === 0) L.push('확인 세션을 진행하지 않았습니다. 위 판정은 코드와 스캐너만으로 내린 것입니다.')
  else {
    table(['항목', '종류', '질문', '답변', '제출물 지문'], report.session.map((q) => [
      esc(q.item_id), esc(q.kind), esc(q.question), esc(q.answer) || '(미답변)', esc(q.evidence_sha256) || '—',
    ]))
  }
  L.push('')

  L.push('## 적용 범위 각주')
  L.push('')
  for (const note of SCOPE_FOOTNOTES) L.push(`- ${note}`)
  L.push('')
  L.push('## 신뢰 경계')
  L.push('')
  L.push(`> ${TRUST_BOUNDARY}`)
  L.push('')

  return L.join('\n')
}
