// spec·plan 문서 파서 — 문서 린터 공용.
// 이 파일이 읽는 두 문서는 배포 zip 에 들어가지 않지만 저장소에는 남는다 (spec REQ-4.4).
import { readFileSync } from 'node:fs'

export const SPEC_PATH = 'docs/superpowers/specs/2026-08-27-edusafe-skill-design.md'
export const PLAN_PATH = 'docs/superpowers/plans/2026-08-27-edusafe-skill-v0.1.md'

export const readSpec = () => readFileSync(SPEC_PATH, 'utf8')
export const readPlan = () => readFileSync(PLAN_PATH, 'utf8')

export const cells = (line) => line.split('|').slice(1, -1).map((s) => s.trim())

// 발견 4 — 셀 안에 파이프가 들어가면 열 수가 어긋난다. 그런 행을 조용히 버리면
// 문서에만 있는 id 가 파서에서 사라져 양방향 대조가 무력화된다. 즉시 실패시킨다.
export function cellsExact(line, expected, where) {
  const c = cells(line)
  if (c.length !== expected) {
    throw new Error(`${where}: 표 행의 열 수가 ${expected} 이 아니라 ${c.length} 입니다 — 셀 안의 파이프를 확인하세요\n  ${line}`)
  }
  return c
}

export function specReqs(spec) {
  const out = new Map()
  for (const line of spec.split('\n')) {
    const m = line.match(/^`\[(REQ-\d+\.\d+)\]`\s+(.*)$/)
    if (m) {
      if (out.has(m[1])) throw new Error(`spec 에 중복된 REQ: ${m[1]}`)
      out.set(m[1], m[2])
    }
  }
  return out
}

export function planTasks(plan) {
  const lines = plan.split('\n')
  const tasks = []
  let cur = null
  for (const line of lines) {
    const h = line.match(/^### Task (\d+): (.+)$/)
    if (h) {
      cur = { n: Number(h[1]), title: h[2], implements: [], quotes: new Map(), body: [] }
      tasks.push(cur)
      continue
    }
    if (!cur) continue
    const im = line.match(/^\*\*Implements:\*\*\s+(.+)$/)
    if (im) cur.implements = im[1].split('·').map((s) => s.trim()).filter(Boolean)
    const q = line.match(/^>\s+`\[(REQ-\d+\.\d+)\]`\s+(.*)$/)
    if (q) cur.quotes.set(q[1], q[2])
    cur.body.push(line)
  }
  return tasks.map((t) => ({ ...t, body: t.body.join('\n') }))
}

// spec §5.1 단계표 — `### 5.1 단계표` 다음 첫 마크다운 표.
// 5열(단계·하는 일·대기·승인·사람이 없을 때·coverage 기록).
export function specStepTable(spec) {
  const lines = spec.split('\n')
  const at = lines.findIndex((l) => l.startsWith('### 5.1 단계표'))
  if (at < 0) throw new Error('spec 에서 §5.1 단계표를 찾지 못했습니다')
  const rows = []
  let started = false
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith('|')) {
      if (started) break
      continue
    }
    const c = cells(line)
    if (c.length !== 5) continue
    if (c[0] === '단계') { started = true; continue }   // 헤더
    if (c.every((x) => /^-+$/.test(x))) continue        // 구분선
    if (!started) continue
    rows.push({ step: c[0], work: c[1], waits: c[2], headless: c[3], coverage: c[4] })
  }
  return rows
}

// spec 의 두 구간을 잘라낸다. 끝 표지가 없으면 문서가 바뀐 것이므로 즉시 실패시킨다.
function section(spec, from, to) {
  const a = spec.indexOf(from)
  const b = spec.indexOf(to)
  if (a < 0) throw new Error(`spec 에서 "${from}" 을 찾지 못했습니다`)
  if (b < 0) throw new Error(`spec 에서 "${to}" 를 찾지 못했습니다`)
  return spec.slice(a, b)
}

// 표 첫 열이 백틱으로 감싼 id 인 행만 골라 id 를 돌려준다.
function idColumn(text, cols) {
  return text
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .map(cells)
    .filter((c) => c.length === cols && c[0].startsWith('`'))
    .map((c) => c[0].replace(/`/g, ''))
}

// spec §9 패턴 규칙 표(7열)와 §9.1 프로젝트 규칙 표(6열)를 모두 읽어 규칙 id 48개를 돌려준다.
export function specRuleIds(spec) {
  return [
    ...idColumn(section(spec, '## 9. 스캔 규칙 카탈로그', '### 9.1 프로젝트 규칙'), 7),
    ...idColumn(section(spec, '### 9.1 프로젝트 규칙', '### 9.2 규칙 실행 규범'), 6),
  ]
}

// spec §6 항목 블록 파서 — 항목 정본(REQ-0.4)과 items.json 을 양방향 대조하기 위한 것.
// 항목 블록은 `#### <id> — <question>` 으로 시작하고, 2열 속성표와 4열 하위 점검표를 갖는다.
export function specItems(spec) {
  const lines = spec.split('\n')
  const out = new Map()
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^#### (\S+) — (.+)$/)
    if (!h) continue
    const it = { id: h[1], question: h[2], attrs: {}, subchecks: [] }
    let j = i + 1
    for (; j < lines.length && !/^###/.test(lines[j]); j++) {
      if (lines[j].startsWith('|')) {
        const c = cells(lines[j])
        if (c.length === 2 && c[0] !== '속성' && !/^-+$/.test(c[0])) it.attrs[c[0]] = c[1]
        if (c[0].startsWith('`')) {
          const s = cellsExact(lines[j], 4, `spec §6 ${it.id} 하위 점검표`)
          it.subchecks.push({
            id: s[0].replace(/`/g, ''),
            text: s[1],
            required_coverage: s[2].split(', '),
            stacks: s[3] === 'all' ? 'all' : s[3].split(', '),
          })
        }
      }
      const w = lines[j].match(/^\*\*왜 위험한가\*\* — (.+)$/)
      if (w) it.why_risky = w[1]
      const f = lines[j].match(/^\*\*수정 방법\*\* — (.+)$/)
      if (f) it.fix_hint = f[1]
    }
    out.set(it.id, it)
    i = j - 1
  }
  return out
}

// spec §9 패턴 규칙 표(7열)와 §9.1 프로젝트 규칙 표(6열) 파서 —
// 규칙 카탈로그 정본(REQ-0.4)과 scan-rules.mjs 를 양방향 대조하기 위한 것.
export function specRules(spec) {
  const out = new Map()
  const rowsOf = (text, cols, where) =>
    text.split('\n')
      .filter((l) => l.startsWith('|') && cells(l)[0].startsWith('`'))
      .map((l) => cellsExact(l, cols, where))
  const strip = (s) => s.replace(/`/g, '')

  for (const c of rowsOf(section(spec, '## 9. 스캔 규칙 카탈로그', '### 9.1 프로젝트 규칙'), 7, 'spec §9 패턴 규칙표')) {
    out.set(strip(c[0]), {
      id: strip(c[0]), item: c[1], subcheck: strip(c[2]), severity: c[3], stacks: c[4],
      flags: c[5] === '—' ? [] : c[5].split(', '), title: c[6], kind: 'pattern',
    })
  }
  for (const c of rowsOf(section(spec, '### 9.1 프로젝트 규칙', '### 9.2 규칙 실행 규범'), 6, 'spec §9.1 프로젝트 규칙표')) {
    out.set(strip(c[0]), {
      id: strip(c[0]), item: c[1], subcheck: strip(c[2]), severity: c[3], stacks: c[4],
      flags: [], title: c[5], kind: 'project',
    })
  }
  return out
}

// ── spec §8.3 보고서 필드 계약 ────────────────────────────────────────────
// 표의 원본 6열(경로·타입·필수·제약·검증·렌더)을 읽고, 파생 3필드
// (allowed·keys·element_required)를 아래 규칙으로 계산한다.
// report.contract.json 도 같은 규칙으로 만들어지므로, 대조(⑥)가 실제로 검증하는 것은
// 손으로 옮긴 원본 6열이다.

const BACKSLASH = String.fromCharCode(92)
const BACKTICK = String.fromCharCode(96)

// 백틱·굵게·마크다운 이스케이프 백슬래시를 벗긴다
export const unmark = (s) =>
  s.split(BACKTICK).join('').split('**').join('').split(BACKSLASH).join('').trim()

// 제약 칸이 순수한 백틱 열거(`a`·`b`·`c`)일 때만 허용값으로 읽는다.
// `sha256:…` 처럼 말줄임표가 든 것은 형식 예시이지 열거가 아니다.
export function allowedFrom(rawCell) {
  const cell = rawCell.trim()
  if (cell === '' || cell === '—') return null
  if (cell.includes('…')) return null
  const tokens = cell.split('·').map((t) => t.trim())
  const quoted = (t) => t.length > 2 && t.startsWith(BACKTICK) && t.endsWith(BACKTICK) && !t.slice(1, -1).includes(BACKTICK)
  if (!tokens.every(quoted)) return null
  return tokens.map((t) => t.slice(1, -1)).map((v) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v))
}

// 객체 행의 키 목록. 끝에 붙은 괄호 주석은 떼어 낸다.
export function keysFrom(constraint) {
  return constraint.replace(/ \(.*\)$/, '').split('·').map((k) => k.trim()).filter(Boolean)
}

export function specContract(spec) {
  const from = spec.indexOf('#### 8.3.1 최상위')
  const to = spec.indexOf('#### 8.3.5')
  if (from < 0 || to < 0) throw new Error('spec §8.3 구간을 찾지 못했습니다')

  const rows = spec.slice(from, to).split('\n')
    .filter((l) => l.startsWith('|'))
    .map((l) => ({ raw: l, c: cells(l) }))
    .filter(({ c }) => c.length === 7 && c[0] !== '필드 경로' && !/^-+$/.test(c[0]))
    .map(({ raw, c }) => {
      if (cells(raw).length !== 7) throw new Error('계약표 행의 열 수가 7이 아닙니다: ' + raw)
      const type = unmark(c[1])
      // 객체 행과 array<object> 행의 제약 칸은 키 목록이지 값 열거가 아니다.
      const isKeyList = type.startsWith('object') || type.startsWith('array<object>')
      return {
        path: unmark(c[0]),
        type,
        required: c[2] === '예',
        spec_constraint: unmark(c[3]),
        allowed: isKeyList ? null : allowedFrom(c[3]),
        validated_by: unmark(c[5]).split(' + ').map((s) => s.trim()).filter(Boolean),
        rendered_in: [unmark(c[6])].filter(Boolean),
      }
    })

  // keys / element_required — keys 를 먼저 채운 뒤 배열 행이 그것을 참조한다 (REQ-8.29)
  for (const f of rows) f.keys = f.type.startsWith('object') ? keysFrom(f.spec_constraint) : null
  const byPath = new Map(rows.map((f) => [f.path, f]))
  for (const f of rows) {
    f.element_required = null
    if (!f.type.startsWith('array<object>')) continue
    if (f.spec_constraint.includes('§8.3.5')) continue // evidence 는 판별 규칙으로 닫는다
    const m = f.spec_constraint.match(/원소는 (.+?) 행/)
    if (!m) throw new Error(f.path + ': array<object> 행에 "원소는 … 행" 이 없습니다')
    const el = byPath.get(m[1].trim())
    if (!el) throw new Error(f.path + ': 원소 행을 찾지 못했습니다 — ' + m[1])
    f.element_required = el.keys
  }

  // §8.3.5 evidence 판별 표
  const eFrom = spec.indexOf('#### 8.3.5')
  const eTo = spec.indexOf('### 8.4 HTML')
  const evidence_types = {}
  for (const line of spec.slice(eFrom, eTo).split('\n')) {
    if (!line.startsWith('|')) continue
    const c = cells(line)
    if (c.length !== 3 || c[0] === '`type`' || /^-+$/.test(c[0])) continue
    evidence_types[unmark(c[0])] = c[1].split('·').map((t) => unmark(t)).filter(Boolean)
  }

  return { fields: rows, evidence_types }
}

// spec §6 의 카테고리 소제목 — items.json 의 categories 와 대조한다
export function specCategories(spec) {
  const out = []
  for (const line of spec.split('\n')) {
    const m = line.match(/^### 6\.\d+ 카테고리 (\d+)\. (.+)$/)
    if (m) out.push({ number: Number(m[1]), title: m[2].trim() })
  }
  return out
}

// ── spec §8.6 교육부 [서식 1] 필수기준 ─────────────────────────────────────
// 첫 열은 "1-1 개인정보가 최소한으로 수집되는가" 처럼 기준 번호와 문안이 붙어 있다.
// 둘째 열은 매핑 칸으로, `S-privacy-notice ⑨ + H-delete` 처럼 원문자와 + 가 섞인다.
export function specMoe(spec) {
  const from = spec.indexOf('### 8.6 교육부')
  const to = spec.indexOf('## 9. 스캔 규칙')
  if (from < 0 || to < 0) throw new Error('spec §8.6 구간을 찾지 못했습니다')
  const out = []
  for (const line of spec.slice(from, to).split('\n')) {
    if (!line.startsWith('|')) continue
    const c = cells(line)
    if (c.length !== 2 || c[0] === '교육부 필수기준' || /^-+$/.test(c[0])) continue
    const m = c[0].match(/^(\d-\d)\s+(.+)$/)
    if (!m) throw new Error('§8.6 기준 번호를 읽지 못했습니다: ' + c[0])
    out.push({
      criterion: m[1],
      text: m[2].trim(),
      note: c[1].trim(),
      mapped_items: mappedItemsFrom(c[1]),
    })
  }
  return out
}

// 매핑 칸에서 항목 id 만 뽑는다. 원문자(①②…)는 하위 항목 표시라 id 가 아니다.
export function mappedItemsFrom(cell) {
  return cell.split('+')
    .map((part) => part.trim().replace(/[①-⑳]/g, '').trim())
    .filter(Boolean)
}

// REQ-8.23 이 요구하는 고정 문구를 spec 에서 그대로 뽑는다
export function specMoeDisclaimer(spec) {
  const line = spec.split('\n').find((l) => l.startsWith('`[REQ-8.23]`'))
  if (!line) throw new Error('spec 에서 REQ-8.23 을 찾지 못했습니다')
  const m = line.match(/\*\*"(.+)"\*\*/)
  if (!m) throw new Error('REQ-8.23 의 고정 문구를 읽지 못했습니다')
  return m[1]
}

// ── spec §7.5 확인 세션 ────────────────────────────────────────────────────
// 5열(항목·kind·질문·답변 형식·갱신 대상 하위 점검).
// 고유 키는 item_id 하나가 아니라 (item_id, kind) 조합이다 — S-auth-hardening 이 두 행을 갖는다.
// 갱신 대상 칸 읽기. "(항목 전체)" 와 개별 하위 점검이 섞인 행을 조용히 all 로 수렴시키면,
// 문서가 잘못 바뀌어도 파서와 session.json 이 같은 값으로 만나 대조가 무력해진다.
function updatesFrom(cell, where) {
  const trimmed = cell.trim()
  if (trimmed === '(항목 전체)') return 'all'
  if (trimmed.includes('(항목 전체)')) {
    throw new Error(`§7.5 ${where}: 갱신 대상에 "(항목 전체)" 와 다른 값이 섞였습니다 — ${trimmed}`)
  }
  return trimmed.split('·').map((s) => s.trim().replace(/`/g, '')).filter(Boolean)
}

export function specSession(spec) {
  const from = spec.indexOf('### 7.5 확인 세션 정책')
  const to = spec.indexOf('### 7.6 effective_severity')
  if (from < 0 || to < 0) throw new Error('spec §7.5 구간을 찾지 못했습니다')
  const out = []
  for (const line of spec.slice(from, to).split('\n')) {
    if (!line.startsWith('|')) continue
    const c = cells(line)
    if (c.length !== 5 || c[0] === '항목' || /^-+$/.test(c[0])) continue
    out.push({
      item_id: c[0],
      kind: c[1],
      question: c[2],
      answer_type: c[3],
      updates: updatesFrom(c[4], `${c[0]}/${c[1]}`),
    })
  }
  return out
}
