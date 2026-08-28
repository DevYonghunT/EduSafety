// 검증을 통과하는 최소 보고서. 계약 거부 테스트와 MD/HTML 렌더 테스트가 함께 쓴다.
import { readFileSync } from 'node:fs'

const items = JSON.parse(readFileSync('edusafe/rules/items.json', 'utf8')).items
const version = JSON.parse(readFileSync('edusafe/rules/version.json', 'utf8'))
const moeCanon = JSON.parse(readFileSync('edusafe/rules/moe-checklist.json', 'utf8')).criteria
const sessionCanon = JSON.parse(readFileSync('edusafe/rules/session.json', 'utf8')).sessions
export const QUOTE = { type: 'quote', source: 'code', file: 'src/app.js', line: 1, quote: 'const a = 1' }
export const NEGATIVE = { type: 'negative_scan', source: 'scanner', rules: ['rrn-data'], files_scanned: 5 }

// items.json 의 하위 점검을 전부 채운, 검증을 통과하는 최소 보고서.
// 모든 항목·하위 점검은 verdict "na" · verification_level "none" 이다(REQ-7.25).
export function validReport() {
  const reportItems = items.map((def, idx) => ({
    item_id: def.id,
    category: def.category,
    base_severity: def.base_severity,
    effective_severity: def.base_severity,
    verdict: 'na',
    verification_level: 'none',
    sources: [],
    applicability_reason: def.applicability.na_when,
    demotion_reason: null,
    evidence: idx === 0 ? [QUOTE] : [],
    subchecks: def.subchecks.map((s, j) => ({
      id: s.id,
      verdict: 'na',
      coverage_status: 'met',
      sources: [],
      verification_level: 'none',
      reason: null,
      evidence: idx === 0 && j === 0 ? [NEGATIVE] : [],
    })),
    reasoning: '픽스처 판정 없음',
    why_risky: def.why_risky,
    fix_hint: def.fix_hint,
    basis: def.basis,
  }))

  return {
    schema_version: '1',
    edusafe_version: version.edusafe_version,
    rubric_version: version.rubric_version,
    self_reported_skill_digest: 'sha256:0000',
    checked_at: '2026-08-28T12:00:00+09:00',
    project: {
      name: 'vulnerable-app',
      stack: ['html'],
      supported_stack: true,
      git: { sha: 'abc1234', dirty: false, untracked_included: false, refs_scanned: ['refs/heads/main'] },
      build_artifact_digest: null,
    },
    coverage: {
      runtime: 'normal',
      scanner: {
        status: 'ran', reason: null, files_scanned: 5,
        files_skipped: [{ path: 'a.xlsx', reason: 'unsupported-extension' }],
        extensions: ['.js'], excluded_dirs: ['node_modules'],
      },
      history: { status: 'skipped', reason: 'no-git', commits_scanned: 0, refs_scanned: [] },
      build: { status: 'skipped', reason: 'non-interactive', command: null, started_at: null, error: null },
      code: { status: 'ran', reason: null },
      evidence: { status: 'skipped', reason: 'not-requested' },
      teacher: { status: 'skipped', reason: 'session-skipped' },
    },
    profile: {
      data_inventory: [{ field: 'name', kind: 'identifier', where: 'students' }],
      actors: ['student'],
      entry: '닉네임 입장',
      controller: 'teacher_personal',
      student_facing: true,
      trusted_outcomes: [],
    },
    db_paths: [{
      table: 'students', op: 'read', file: 'src/app.js', line: 20,
      controls: { authentication: 'no', ownership: 'no', role: 'no', validation: 'no', rate_limit: 'no' },
      evidence: [QUOTE],
    }],
    destinations: [{
      service: 'Supabase', kind: 'processor', purpose: '데이터 저장', controller_role: 'processor',
      storage: true, region: 'unknown', data: ['name'], file: 'src/app.js', line: 20,
    }],
    summary: {
      must_fix: 0, recommended: 0, info: 0,
      needs_human: { total: 0, coverage: 0, unsupported: 0, unanswered: 0 },
      teacher_confirmed: 0, documentation_hits: 0,
    },
    // §8.6 기준 9개 전수. 모든 항목이 na 이므로 상태는 전부 해당없음이다.
    moe_checklist: moeCanon.map((c) => ({
      criterion: c.criterion, text: c.text, mapped_items: [...c.mapped_items], status: '해당없음',
    })),
    items: reportItems,
    session: [{
      item_id: 'H-2fa', kind: 'teacher',
      question: sessionCanon.find((s) => s.item_id === 'H-2fa' && s.kind === 'teacher').question,
      answer: null, evidence_sha256: null,
    }],  }
}
