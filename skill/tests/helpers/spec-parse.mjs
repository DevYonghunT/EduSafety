// spec·plan 문서 파서 — 문서 린터 공용.
// 이 파일이 읽는 두 문서는 배포 zip 에 들어가지 않지만 저장소에는 남는다 (spec REQ-4.4).
import { readFileSync } from 'node:fs'

export const SPEC_PATH = 'docs/superpowers/specs/2026-08-27-edusafe-skill-design.md'
export const PLAN_PATH = 'docs/superpowers/plans/2026-08-27-edusafe-skill-v0.1.md'

export const readSpec = () => readFileSync(SPEC_PATH, 'utf8')
export const readPlan = () => readFileSync(PLAN_PATH, 'utf8')

export const cells = (line) => line.split('|').slice(1, -1).map((s) => s.trim())

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
