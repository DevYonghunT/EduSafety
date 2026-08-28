// 보고서 렌더러 — edusafe-report.json 을 계약으로 검증하고 MD·HTML 로 렌더한다.
// 외부 의존성 0 (Node 내장 모듈만).
//
//   node edusafe/scripts/render.mjs <stagingDir>
//
// AI 는 edusafe-report.json 만 작성하고, 사람이 읽는 형식은 전부 여기서 나온다 (spec REQ-4.3).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { rules as scanRules } from '../rules/scan-rules.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES = join(HERE, '..', 'rules')

export const loadContract = () => JSON.parse(readFileSync(join(RULES, 'report.contract.json'), 'utf8'))
export const loadItems = () => JSON.parse(readFileSync(join(RULES, 'items.json'), 'utf8')).items
export const loadCategories = () => JSON.parse(readFileSync(join(RULES, 'items.json'), 'utf8')).categories || []
export const loadMoeChecklist = () => JSON.parse(readFileSync(join(RULES, 'moe-checklist.json'), 'utf8'))
export const loadSessionCanon = () => JSON.parse(readFileSync(join(RULES, 'session.json'), 'utf8')).sessions
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
  // 지문 자리에 아무 문자열이나 들어가면 "대조 자료"가 아니라 장식이 된다(리뷰에서 실측)
  if (c === 'sha256:…') {
    if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
      out.push(`${where}: sha256:<64자리 16진수> 형식이어야 합니다 (받은 값 ${JSON.stringify(value)})`)
    }
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

    // §8.6 정본과 대조한다 — 기준 9개 전수, 문안과 매핑이 정본 그대로여야 한다.
    // 이게 없으면 한 줄짜리 임의 표를 넣어도 통과한다(리뷰에서 실측).
    const canon = loadMoeChecklist().criteria
    const missingCriteria = canon.filter((c) => !criteria.includes(c.criterion)).map((c) => c.criterion)
    if (missingCriteria.length) errors.push(`moe_checklist 에 빠진 기준: ${missingCriteria.join(', ')}`)
    for (const row of report.moe_checklist) {
      if (!row || typeof row !== 'object') continue
      const def = canon.find((c) => c.criterion === row.criterion)
      if (!def) { errors.push(`moe_checklist: §8.6 에 없는 기준 ${row.criterion}`); continue }
      if (row.text !== def.text) errors.push(`moe_checklist[${row.criterion}].text: §8.6 문안과 다릅니다`)
      if (JSON.stringify(row.mapped_items) !== JSON.stringify(def.mapped_items)) {
        errors.push(`moe_checklist[${row.criterion}].mapped_items: §8.6 매핑과 다릅니다`)
      }
    }
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

  // 확인 세션 질문은 §7.5 정본 그대로여야 한다 (REQ-7.24 — 질문 문구를 지어내지 않는다).
  // 교사가 보는 질문과 문서의 질문이 갈리면 답변이 어떤 하위 점검을 갱신하는지도 흔들린다.
  if (Array.isArray(report.session)) {
    const canon = loadSessionCanon()
    for (const q of report.session) {
      if (!q || typeof q !== 'object') continue
      const def = canon.find((s) => s.item_id === q.item_id && s.kind === q.kind)
      if (!def) { errors.push(`session: §7.5 에 없는 조합 ${q.item_id}/${q.kind}`); continue }
      if (q.question !== def.question) errors.push(`session[${q.item_id}/${q.kind}].question: §7.5 질문과 다릅니다`)
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

  const categories = loadCategories()
  L.push('## 항목별 판정')
  L.push('')
  for (let category = 1; category <= 8; category++) {
    const group = report.items.filter((i) => i.category === category)
    if (group.length === 0) continue
    const meta = categories.find((c) => c.number === category)
    L.push(`### 카테고리 ${category}${meta ? '. ' + meta.title : ''}`)
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

// ── HTML 렌더 (REQ-8.16 ~ REQ-8.19) ──────────────────────────────────────
// 단일 파일·오프라인·JS 없음. 모든 동적 값은 컨텍스트별로 이스케이프한다.
// 보고서 JSON 을 HTML 에 내장하지 않는다 — 페이지 안에 소비자가 없고 노출면만 는다(REQ-8.19).

export const escapeHtml = (v) => String(v === null || v === undefined ? '' : v)
  .split('&').join('&amp;')
  .split('<').join('&lt;')
  .split('>').join('&gt;')
  .split('"').join('&quot;')
  .split("'").join('&#39;')

// 속성값은 항상 큰따옴표로 감싸고 같은 규칙으로 이스케이프한다
export const escapeAttr = (v) => escapeHtml(v)

// URL 은 스킴을 허용목록으로 막는다. javascript: 같은 스킴은 통째로 버린다.
export function escapeUrl(v) {
  const s = String(v === null || v === undefined ? '' : v).trim()
  return /^(?:https?:\/\/|mailto:|#|\/|\.\/|\.\.\/)/i.test(s) ? escapeAttr(s) : '#'
}

const VERDICT_BADGE = {
  fail: ['b-fail', '미충족'],
  na: ['b-na', '해당없음'],
  needs_human: ['b-human', '판단불가'],
}

function badge(verdict, level) {
  if (verdict === 'pass') {
    return level === 'attested'
      ? '<span class="badge b-attested">교사 확인: 충족</span>'
      : '<span class="badge b-pass">충족</span>'
  }
  const [cls, label] = VERDICT_BADGE[verdict] || ['b-na', escapeHtml(verdict)]
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`
}

const htmlTable = (head, rows, emptyText = '기록이 없습니다.') => {
  if (rows.length === 0) return `<p class="empty">${escapeHtml(emptyText)}</p>`
  const th = head.map((h) => `<th>${escapeHtml(h)}</th>`).join('')
  const tr = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')
  return `<div class="scroll"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`
}

// REQ-7.13 — 같은 근거가 여러 항목에 인용되면 항목마다 전부 펼치지 않고 접는다.
function findingKey(e) {
  if (!e || typeof e !== 'object') return null
  return e.type === 'quote'
    ? ['q', e.file, e.line, e.quote].join(' ')
    : ['n', asArray(e.rules).join(','), e.files_scanned].join(' ')
}

function findingIndex(reportItems) {
  const map = new Map()
  for (const it of reportItems) {
    for (const e of asArray(it.evidence)) {
      const k = findingKey(e)
      if (k === null) continue
      if (!map.has(k)) map.set(k, [])
      if (!map.get(k).includes(it.item_id)) map.get(k).push(it.item_id)
    }
  }
  return map
}

function evidenceHtml(list, index = null, ownerId = null) {
  const out = []
  for (const e of asArray(list)) {
    if (!e || typeof e !== 'object') continue
    const key = findingKey(e)
    const shared = index && key !== null ? index.get(key) || [] : []
    if (shared.length > 1 && shared[0] !== ownerId) {
      const others = shared.filter((id) => id !== ownerId)
      out.push(`<p class="folded">같은 근거가 다른 항목에서도 인용됨 — ${escapeHtml(others.join(', '))}</p>`)
      continue
    }
    if (e.type === 'quote') {
      out.push(
        `<div class="ev"><div class="where">${escapeHtml(e.file)}:${escapeHtml(e.line)} · ${escapeHtml(e.source)}</div>` +
        `<code>${escapeHtml(e.quote)}</code></div>`,
      )
    } else {
      out.push(
        `<div class="ev"><div class="where">부재 증명 · ${escapeHtml(e.source)}</div>` +
        `규칙 <code>${escapeHtml(asArray(e.rules).join(', '))}</code> 로 파일 ${escapeHtml(e.files_scanned)}개를 검사해 해당 사항이 없음을 확인했습니다.</div>`,
      )
    }
    if (shared.length > 1) {
      const others = shared.filter((id) => id !== ownerId)
      out.push(`<p class="folded">이 근거는 ${escapeHtml(others.join(', '))} 에서도 인용됩니다.</p>`)
    }
  }
  return out.join('')
}

// 미충족 항목이 많으면 아코디언을 다 펼쳐 두는 것보다, 먼저 볼 것을 목록으로 주는 편이 낫다.
// 링크를 누르면 해당 항목으로 이동하고, 접혀 있어도 `details:target` CSS 로 펼쳐진다(JS 없음).
function todoHtml(report, items) {
  const fails = report.items.filter((i) => i.verdict === 'fail')
  if (fails.length === 0) return ''
  const order = { high: 0, medium: 1, low: 2 }
  const mark = { high: 'd-red', medium: 'd-amber', low: 'd-grey' }
  const sorted = [...fails].sort((a, b) => (order[a.effective_severity] ?? 9) - (order[b.effective_severity] ?? 9))
  const li = sorted.map((it) => {
    const def = items.find((d) => d.id === it.item_id)
    return `<li><span class="dot ${mark[it.effective_severity] || 'd-grey'}"></span>` +
      `<a href="#item-${escapeAttr(it.item_id)}">${escapeHtml(def ? def.question : it.item_id)}</a>` +
      `<span class="id">${escapeHtml(it.item_id)}</span></li>`
  }).join('')
  return `<h3>먼저 볼 것 — 미충족 ${escapeHtml(fails.length)}건</h3>` +
    '<p class="explain">제목을 누르면 그 항목의 근거와 수정 방법으로 이동합니다.</p>' +
    `<ul class="todo">${li}</ul>`
}

function summaryHtml(report, items) {
  const s = report.summary
  const nh = s.needs_human
  const row = (dot, label, n, note) =>
    `<div class="verdict"><span class="dot ${dot}"></span><span class="label">${escapeHtml(label)}</span>` +
    `<span class="n">${escapeHtml(n)}건</span>${note ? `<span class="note">${escapeHtml(note)}</span>` : ''}</div>`
  const foot = []
  // REQ-7.21 — 점수를 매기지 않는다. 0이어도 "통과"라 쓰지 않는다.
  if (s.must_fix === 0) foot.push('반드시 수정 항목 없음.')
  // REQ-7.16 — 문서에서 발견한 hit 은 판정 근거로 쓰지 않되 건수를 남긴다.
  foot.push(`문서에서 발견(참고) ${escapeHtml(s.documentation_hits)}건 — 문서 파일의 hit 은 판정 근거로 쓰지 않았습니다.`)
  return '<div class="card">' +
    row('d-red', '배포 전 반드시 수정', s.must_fix) +
    row('d-amber', '권장 수정', s.recommended) +
    row('d-grey', '참고', s.info) +
    row('d-open', '판단불가', nh.total,
      `커버리지 부족 ${nh.coverage} · 미지원 스택 ${nh.unsupported} · 미답변 ${nh.unanswered}`) +
    row('d-blue', '교사 확인 항목', s.teacher_confirmed, '트랙 2 재검증 대상') +
    `<div class="card-foot">${foot.map((f) => escapeHtml(f)).join('<br>')}</div></div>` +
    todoHtml(report, items)
}

// 교사가 처음 보는 표에는 무엇을 보는 표인지 한 줄로 설명을 단다.
export const SECTION_EXPLAIN = {
  meta: '이 보고서를 어떤 조건에서 만들었는지 적어 둔 것입니다. 나중에 같은 코드를 다시 검사할 때 대조하는 데 씁니다.',
  coverage: '이번 점검이 <b>어디까지 볼 수 있었는지</b>입니다. 여섯 가지 방법(파일 스캔·git 기록·빌드 결과·코드 읽기·교사 제출 자료·교사 답변) 중 무엇이 실행됐고 무엇이 생략됐는지 보여줍니다. 생략된 것이 있으면 그만큼 위의 <b>판단불가</b>가 늘어납니다.',
  db_paths: '앱이 데이터베이스를 <b>읽고 쓰는 지점</b>들입니다. 각 지점에 다섯 가지 잠금장치가 걸려 있는지 봅니다 — <b>인증</b>(로그인했는지 확인) · <b>소유권</b>(내 데이터가 맞는지 확인) · <b>역할</b>(교사·학생 구분) · <b>검증</b>(값의 크기·형식 확인) · <b>호출제한</b>(너무 자주 부르지 못하게 막기). "no" 가 많을수록 아무나 손댈 수 있다는 뜻입니다.',
  destinations: '학생 데이터가 <b>앱 밖으로 나가는 곳</b>입니다. <b>수탁자</b>는 앱이 돌아가려면 꼭 필요한 저장·호스팅 서비스(Firebase·Supabase 등)이고, <b>독립 제3자</b>는 그 밖의 외부 서비스(분석·광고·외부 AI 등)입니다. 수탁자로 보내는 것 자체는 문제가 아니지만 처리방침에 밝혀야 하고, 독립 제3자에 학생 식별정보를 보내는 것은 별도 근거가 필요합니다.',
  session: '코드만으로는 알 수 없는 것을 교사에게 직접 물어 확인한 기록입니다.',
}

const explain = (key) => `<p class="explain">${SECTION_EXPLAIN[key]}</p>`

// 항목/값 두 열짜리 정의 표. 첫 열은 머리글 칸(th)이라 htmlTable 을 쓰지 않는다.
const defTable = (rows) =>
  '<div class="scroll"><table class="meta"><tbody>' +
  rows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${v}</td></tr>`).join('') +
  '</tbody></table></div>'

function metaHtml(report) {
  const g = report.project.git
  const meta = defTable([
    ['스킬 버전', escapeHtml(report.edusafe_version)],
    ['루브릭 버전', escapeHtml(report.rubric_version)],
    ['검사 시각', escapeHtml(report.checked_at)],
    ['프로젝트', escapeHtml(report.project.name)],
    ['감지된 스택', escapeHtml(report.project.stack.join(', ')) || '(감지 없음)'],
    ['정식 지원 스택', report.project.supported_stack ? '예' : '아니오'],
    ['git SHA', g ? `<code>${escapeHtml(g.sha)}</code>` : '—'],
    ['git 작업 중 변경(dirty)', g ? (g.dirty ? '예' : '아니오') : '—'],
    ['추적되지 않은 파일 포함', g ? (g.untracked_included ? '예' : '아니오') : '—'],
    ['검사한 ref', g ? escapeHtml(g.refs_scanned.join(', ')) || '—' : '—'],
    ['빌드 산출물 지문', report.project.build_artifact_digest ? `<code>${escapeHtml(report.project.build_artifact_digest)}</code>` : '—'],
    ['스킬 지문(자가보고)', report.self_reported_skill_digest ? `<code>${escapeHtml(report.self_reported_skill_digest)}</code>` : '—'],
  ])

  return '<h3>검사 조건</h3>' + explain('meta') + meta
}

// coverage 축의 기술 이름은 트랙 2 재검증에 쓰이므로 남기되, 교사가 읽을 이름을 앞에 둔다.
export const COVERAGE_LABEL = {
  runtime: '실행 환경',
  scanner: '파일 스캔',
  history: 'git 기록',
  build: '빌드 결과',
  code: '코드 읽기',
  evidence: '교사 제출 자료',
  teacher: '교사 답변',
}

function coverageHtml(report) {
  const cov = report.coverage
  const axisCell = (axis) => `${escapeHtml(COVERAGE_LABEL[axis])} <span class="sev">${escapeHtml(axis)}</span>`
  const covRows = [[axisCell('runtime'), escapeHtml(cov.runtime), '—']]
  for (const axis of ['scanner', 'history', 'build', 'code', 'evidence', 'teacher']) {
    const c = cov[axis] || {}
    covRows.push([axisCell(axis), escapeHtml(c.status), c.reason ? escapeHtml(c.reason) : '—'])
  }
  const sc = cov.scanner
  const skipped = htmlTable(['건너뛴 파일', '사유'],
    sc.files_skipped.map((f) => [`<code>${escapeHtml(f.path)}</code>`, escapeHtml(f.reason)]),
    '건너뛴 파일이 없습니다.')

  return '<h3>점검 범위</h3>' + explain('coverage') +
    htmlTable(['보는 방법', '상태', '생략 사유'], covRows) +
    `<p class="sub">검사한 파일 ${escapeHtml(sc.files_scanned)}개 · 건너뛴 파일 ${escapeHtml(sc.files_skipped.length)}개</p>` +
    skipped
}

function moeHtml(report) {
  const rows = report.moe_checklist.map((m) => [
    `<code>${escapeHtml(m.criterion)}</code>`,
    escapeHtml(m.text),
    escapeHtml(m.mapped_items.join(', ')),
    escapeHtml(m.status),
  ])
  return '<h3>학교 서식 — 교육부 [서식 1] 필수기준 대조표</h3>' +
    '<p class="explain">학교운영위원회 심의 준비에 참고하는 자료입니다. 아래 아홉 가지가 교육부가 정한 필수기준이고, 각 줄이 우리 점검 항목 중 무엇과 맞물리는지 보여줍니다.</p>' +
    htmlTable(['기준', '내용', '우리 항목', '상태'], rows) +
    `<div class="notice">${escapeHtml(MOE_DISCLAIMER)}</div>`
}

function dbPathsHtml(report) {
  const rows = report.db_paths.map((p) => [
    escapeHtml(p.table), escapeHtml(p.op),
    `<code>${escapeHtml(p.file)}:${escapeHtml(p.line)}</code>`,
    escapeHtml(p.controls.authentication), escapeHtml(p.controls.ownership), escapeHtml(p.controls.role),
    escapeHtml(p.controls.validation), escapeHtml(p.controls.rate_limit),
  ])
  const table = '<h3>데이터 접근 — DB 도달 경로</h3>' + explain('db_paths') + htmlTable(['테이블', '동작', '위치', '인증', '소유권', '역할', '검증', '호출제한'], rows,
    '기록된 DB 도달 경로가 없습니다.')
  const withEvidence = report.db_paths.filter((p) => asArray(p.evidence).length > 0)
  if (withEvidence.length === 0) return table
  const blocks = withEvidence.map((p) =>
    `<div class="kv"><b>${escapeHtml(p.table)} (${escapeHtml(p.op)})</b>` +
    `<code>${escapeHtml(p.file)}:${escapeHtml(p.line)}</code></div>` + evidenceHtml(p.evidence)).join('')
  return table + '<h3>경로별 근거</h3>' + blocks
}

function destinationsHtml(report) {
  const rows = report.destinations.map((d) => [
    escapeHtml(d.service), escapeHtml(d.kind), escapeHtml(d.purpose), escapeHtml(d.controller_role),
    d.storage ? '예' : '아니오', escapeHtml(d.region),
    escapeHtml(d.data.join(', ')) || '—',
    `<code>${escapeHtml(d.file)}:${escapeHtml(d.line)}</code>`,
  ])
  return '<h3>외부 전송 — 목적지 인벤토리</h3>' + explain('destinations') + htmlTable(['서비스', '구분', '목적', '지위', '저장', '리전', '데이터', '위치'], rows,
    '기록된 목적지가 없습니다.')
}

function categoriesHtml(report, items) {
  const index = findingIndex(report.items)
  const categories = loadCategories()
  const out = []
  for (let category = 1; category <= 8; category++) {
    const group = report.items.filter((i) => i.category === category)
    if (group.length === 0) continue
    const meta = categories.find((c) => c.number === category)
    out.push(`<h3>카테고리 ${category}${meta ? '. ' + escapeHtml(meta.title) : ''}</h3>`)
    for (const it of group) {
      const def = items.find((d) => d.id === it.item_id)
      const sev = it.effective_severity !== it.base_severity
        ? `${it.base_severity} → ${it.effective_severity}`
        : it.base_severity
      // 미충족을 전부 펼치면 보고서가 지나치게 길어진다. 가장 급한 것(🔴)만 펼쳐 두고
      // 나머지는 위의 "먼저 볼 것" 목록에서 눌러 펼친다.
      const open = it.verdict === 'fail' && it.effective_severity === 'high' ? ' open' : ''
      const subRows = asArray(it.subchecks).map((s) => [
        `<code>${escapeHtml(s.id)}</code>`,
        badge(s.verdict, s.verification_level),
        escapeHtml(s.coverage_status),
        escapeHtml(asArray(s.sources).join(', ')) || '—',
        escapeHtml(s.reason) || '—',
      ])
      const subEvidence = asArray(it.subchecks).filter((s) => asArray(s.evidence).length > 0)
      const subEvidenceHtml = subEvidence.length === 0 ? '' :
        '<h3>하위 점검 근거</h3>' + subEvidence.map((s) =>
          `<div class="kv"><b>${escapeHtml(s.id)}</b></div>` + evidenceHtml(s.evidence)).join('')
      out.push(
        `<details id="item-${escapeAttr(it.item_id)}"${open}><summary>${badge(it.verdict, it.verification_level)}` +
        `<span class="q">${escapeHtml(def ? def.question : it.item_id)}</span>` +
        `<span class="id">${escapeHtml(it.item_id)}<span class="sev">중요도 ${escapeHtml(sev)}</span></span></summary>` +
        '<div class="body">' +
        `<div class="kv"><b>출처</b>${escapeHtml(asArray(it.sources).join(', ')) || '—'}</div>` +
        (it.applicability_reason ? `<div class="kv"><b>해당없음 사유</b>${escapeHtml(it.applicability_reason)}</div>` : '') +
        (it.demotion_reason ? `<div class="kv"><b>강등 사유</b>${escapeHtml(it.demotion_reason)}</div>` : '') +
        `<div class="kv"><b>판정 근거 서술</b>${escapeHtml(it.reasoning)}</div>` +
        htmlTable(['하위 점검', '판정', 'coverage', '출처', '사유'], subRows, '하위 점검이 정의되지 않은 항목입니다.') +
        subEvidenceHtml +
        (asArray(it.evidence).length > 0 ? '<h3>근거</h3>' + evidenceHtml(it.evidence, index, it.item_id) : '') +
        `<div class="why"><b>왜 위험한가</b><br>${escapeHtml(it.why_risky)}</div>` +
        `<div class="fix"><b>수정 방법</b><br>${escapeHtml(it.fix_hint)}</div>` +
        `<p class="basis"><b>근거 법령</b> ${escapeHtml(it.basis)}</p>` +
        '</div></details>',
      )
    }
  }
  return out.join('')
}

function sessionHtml(report) {
  const rows = report.session.map((q) => [
    escapeHtml(q.item_id), escapeHtml(q.kind), escapeHtml(q.question),
    q.answer ? escapeHtml(q.answer) : '<span class="empty">(미답변)</span>',
    q.evidence_sha256 ? `<code>${escapeHtml(q.evidence_sha256)}</code>` : '—',
  ])
  return explain('session') + htmlTable(['항목', '종류', '질문', '답변', '제출물 지문'], rows,
    '확인 세션을 진행하지 않았습니다. 위 판정은 코드와 스캐너만으로 내린 것입니다.')
}

function footnotesHtml() {
  return '<ul class="footnotes">' +
    SCOPE_FOOTNOTES.map((n) => `<li>${escapeHtml(n.split('**').join(''))}</li>`).join('') +
    '</ul>' +
    `<div class="notice">${escapeHtml(TRUST_BOUNDARY)}</div>`
}

export function renderHtml(report, items, template) {
  const sections = {
    SUMMARY: summaryHtml(report, items),
    META: metaHtml(report),
    COVERAGE: coverageHtml(report),
    MOE: moeHtml(report),
    DB_PATHS: dbPathsHtml(report),
    DESTINATIONS: destinationsHtml(report),
    CATEGORIES: categoriesHtml(report, items),
    SESSION: sessionHtml(report),
    FOOTNOTES: footnotesHtml(),
  }
  let html = template
  for (const [key, value] of Object.entries(sections)) {
    const token = '{{' + key + '}}'
    if (!html.includes(token)) throw new Error(`템플릿에 자리표시자가 없습니다: ${token}`)
    html = html.split(token).join(value) // replace 의 $& 치환을 피한다
  }
  const leftover = html.match(/\{\{[A-Z_]+\}\}/)
  if (leftover) throw new Error(`치환되지 않은 자리표시자가 남았습니다: ${leftover[0]}`)
  return html
}

// ── staging 세트 교체 (REQ-8.4 ~ REQ-8.9) ────────────────────────────────
// 정본 JSON·scan.json 은 이미 최상위에 있으므로 "기존 4개를 옮기고 HTML·MD 만 교체"하면
// 새 정본이 history 로 밀려나 사라진다. 그래서 staging 에서 4개를 전부 완성한 뒤
// 세트 단위로 교체한다.

export const REPORT_FILES = ['edusafe-report.json', 'scan.json', 'edusafe-report.html', 'edusafe-report.md']
const HISTORY_LIMIT = 5

const pad = (n, w = 2) => String(n).padStart(w, '0')

export function historyStamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-` +
    randomBytes(2).toString('hex')
}

// 오래된 .staging-* 정리 — 0단계에서 부른다 (REQ-5.6 · REQ-8.7)
export function cleanStaging(reportDir) {
  if (!existsSync(reportDir)) return []
  const removed = []
  for (const name of readdirSync(reportDir)) {
    if (!name.startsWith('.staging-')) continue
    rmSync(join(reportDir, name), { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

// history 스탬프 형식. 이 패턴에 맞는 디렉터리만 정리 대상이다 —
// 교사가 history/ 아래에 따로 만들어 둔 폴더까지 지우면 그건 파일 손실이다(리뷰에서 실측).
const STAMP_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{4}$/

function trimHistory(historyDir) {
  if (!existsSync(historyDir)) return
  const dirs = readdirSync(historyDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && STAMP_PATTERN.test(e.name))
    .map((e) => e.name)
    .sort()
  while (dirs.length > HISTORY_LIMIT) {
    rmSync(join(historyDir, dirs.shift()), { recursive: true, force: true })
  }
}

// options.rename 은 테스트가 "이동 중 실패"를 주입하기 위한 자리다(계획서 Task 5 Step 5).
// 되돌리기 경로는 실제로 실패시켜 보지 않으면 검증할 방법이 없다.
export function swapStaging(reportDir, stagingDir, { now = new Date(), rename = renameSync } = {}) {
  // 1. staging 에 4파일이 전부 있고 크기가 0이 아닌지 확인 (REQ-8.5)
  for (const name of REPORT_FILES) {
    const p = join(stagingDir, name)
    if (!existsSync(p)) throw new Error(`staging 에 ${name} 이 없습니다`)
    if (statSync(p).size === 0) throw new Error(`staging 의 ${name} 이 비어 있습니다`)
  }

  const historyDir = join(reportDir, 'history')
  const archiveDir = join(historyDir, historyStamp(now))
  const archived = []
  const placed = []
  let archiveCreated = false

  try {
    // 2. 기존 최상위 4파일을 history 로 옮긴다 (history/ 와 .staging-* 은 대상이 아니다)
    for (const name of REPORT_FILES) {
      const from = join(reportDir, name)
      if (!existsSync(from)) continue
      if (!archiveCreated) { mkdirSync(archiveDir, { recursive: true }); archiveCreated = true }
      const to = join(archiveDir, name)
      rename(from, to)
      archived.push([from, to])
    }

    // 3. staging 의 4파일을 최상위로 옮긴다
    for (const name of REPORT_FILES) {
      const from = join(stagingDir, name)
      const to = join(reportDir, name)
      rename(from, to)
      placed.push([from, to])
    }
  } catch (err) {
    // REQ-8.7 — 실패하면 최상위를 손대지 않은 상태로 되돌리고 staging 을 남긴다.
    // 되돌리기 실패를 삼키면 최상위가 새 파일과 옛 파일이 섞인 채로 남는데 아무도 모른다.
    // 실패한 것을 모아 오류에 담아 교사가 무엇을 손으로 되돌려야 하는지 알 수 있게 한다.
    const undone = []
    const undo = (to, from) => {
      try { rename(to, from) } catch (e) { undone.push(`${to} → ${from} (${e.message})`) }
    }
    for (const [from, to] of placed.reverse()) undo(to, from)
    for (const [from, to] of archived.reverse()) undo(to, from)
    // REQ-8.9 — 만들어 둔 history 디렉터리가 비었으면 함께 지운다
    if (archiveCreated && existsSync(archiveDir) && readdirSync(archiveDir).length === 0) {
      rmSync(archiveDir, { recursive: true, force: true })
    }
    if (undone.length > 0) {
      throw new Error(
        '교체에 실패했고 되돌리기도 일부 실패했습니다. 최상위가 섞인 상태일 수 있습니다.' +
        `\n  원인: ${err.message}` +
        `\n  되돌리지 못한 것:\n    ${undone.join('\n    ')}` +
        (archiveCreated && existsSync(archiveDir) ? `\n  직전 결과 보관 위치: ${archiveDir}` : ''),
      )
    }
    throw err
  }

  // 4. staging 폴더 삭제
  rmSync(stagingDir, { recursive: true, force: true })
  // 5. history 가 5개를 넘으면 오래된 것부터 삭제 (REQ-8.8)
  trimHistory(historyDir)
  return { archived: archiveCreated ? archiveDir : null }
}

// ── 스킬 지문 (REQ-11.1 · REQ-13.2) ──────────────────────────────────────
// 신뢰 증거가 아니라 우발적 수정 탐지용이다. 변조된 render.mjs 는 공식 값을 그대로 찍을 수 있다.
const DIGEST_TARGETS = ['SKILL.md', 'rules', 'scripts', 'templates']

export function skillDigest(skillDir) {
  const files = []
  const walk = (abs, rel) => {
    let entries
    try { entries = readdirSync(abs, { withFileTypes: true }) } catch { return }
    for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.isSymbolicLink()) continue // symlink 제외
      const childAbs = join(abs, e.name)
      const childRel = `${rel}/${e.name}`
      if (e.isDirectory()) walk(childAbs, childRel)
      else if (e.isFile()) files.push({ rel: childRel, abs: childAbs })
    }
  }
  for (const target of DIGEST_TARGETS) {
    const abs = join(skillDir, target)
    if (!existsSync(abs)) continue
    const st = statSync(abs)
    if (st.isDirectory()) walk(abs, target)
    else files.push({ rel: target, abs })
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)) // 경로 오름차순

  const outer = createHash('sha256')
  for (const f of files) {
    const normalized = readFileSync(f.abs, 'utf8').split('\r\n').join('\n') // 줄바꿈 LF
    outer.update(f.rel + '\n' + createHash('sha256').update(normalized).digest('hex') + '\n')
  }
  return 'sha256:' + outer.digest('hex')
}

export function manifestFiles(skillDir) {
  const files = []
  const walk = (abs, rel) => {
    let entries
    try { entries = readdirSync(abs, { withFileTypes: true }) } catch { return }
    for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.isSymbolicLink()) continue
      const childAbs = join(abs, e.name)
      const childRel = `${rel}/${e.name}`
      if (e.isDirectory()) walk(childAbs, childRel)
      else if (e.isFile()) files.push({ path: childRel, abs: childAbs })
    }
  }
  for (const target of DIGEST_TARGETS) {
    const abs = join(skillDir, target)
    if (!existsSync(abs)) continue
    if (statSync(abs).isDirectory()) walk(abs, target)
    else files.push({ path: target, abs })
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

// ── CLI ──────────────────────────────────────────────────────────────────
function main(argv) {
  const stagingArg = argv[0]
  if (!stagingArg) {
    console.error('사용법: node render.mjs <stagingDir>')
    process.exit(2)
  }
  const staging = resolve(stagingArg)
  const reportPath = join(staging, 'edusafe-report.json')
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))

  // 스킬 지문은 AI 가 적을 수 있는 값이 아니라 지금 도는 스킬 폴더의 해시다(spec §11).
  // 여기서 계산해 채워 넣고 그 상태로 검증·렌더한다 — 보고서에 남는 값과 실제가 같아야
  // 트랙 2 가 대조할 수 있다.
  report.self_reported_skill_digest = skillDigest(join(HERE, '..'))
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')

  const scanPath = join(staging, 'scan.json')
  const scan = existsSync(scanPath) ? JSON.parse(readFileSync(scanPath, 'utf8')) : null
  const items = loadItems()
  const contract = loadContract()

  const errors = validateReport(report, items, contract, scan)
  if (errors.length > 0) {
    console.error(`보고서가 계약을 통과하지 못했습니다 (${errors.length}건). 최상위를 손대지 않고 staging 을 남깁니다.`)
    for (const e of errors.slice(0, 40)) console.error('  - ' + e)
    if (errors.length > 40) console.error(`  … 외 ${errors.length - 40}건`)
    process.exit(1)
  }

  const template = readFileSync(join(HERE, '..', 'templates', 'report.html'), 'utf8')
  writeFileSync(join(staging, 'edusafe-report.html'), renderHtml(report, items, template))
  writeFileSync(join(staging, 'edusafe-report.md'), renderMarkdown(report, items))

  const reportDir = dirname(staging)
  swapStaging(reportDir, staging)
  const s = report.summary
  console.log(`🔴 ${s.must_fix} · 🟡 ${s.recommended} · ⚪ ${s.info} · ❓ ${s.needs_human.total} · ✍️ ${s.teacher_confirmed}`)
  console.log('보고서: ' + join(reportDir, 'edusafe-report.html'))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
