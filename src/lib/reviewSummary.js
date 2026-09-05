// 판정 집계 — 단일 점수 없음 (design-plan 결정: 점수 폐지).
// 산출: 종합판정 3값 + 카테고리별 상태(카테고리 내 최악 판정) + 행동 중심 요약.
import { rubricItems } from '../data/rubric.js'

export const STATUS_LABELS = {
  pass_candidate: '합격 후보',
  hold: '보류 — 확인 필요',
  fail_candidate: '불합격 후보',
}

export const CATEGORY_STATE_LABELS = {
  fail_required: '필수 미충족',
  fail: '미충족',
  needs_human: '확인 필요',
  ok: '충족',
}

// 최악 판정 우선순위: 필수 미충족 > 미충족 > 확인 필요 > 충족
const STATE_RANK = { ok: 0, needs_human: 1, fail: 2, fail_required: 3 }

// 필수 항목의 '해당없음'은 사유가 있어야 인정된다 — 사유 없는 해당없음은 합격과 구별되지 않아
// 필수 항목 전부를 해당없음으로 돌려 합격 후보(인증마크 요청 가능)를 만드는 길이 열린다.
export function naJustification(item, overrides, humanInputs) {
  return String(overrides[item.id]?.reason || humanInputs[item.id]?.reason || '').trim()
}

export function naNeedsReason(item, verdict, overrides, humanInputs) {
  return verdict === 'na' && item.type === 'required' && naJustification(item, overrides, humanInputs) === ''
}

// 판정 우선순위: 심사자 오버라이드 > AI 판정(aiVerifiable) 또는 심사자 수동 입력.
// 빈 값('판정 선택' 미완료)은 needs_human으로 수렴 — 빈칸이 합격으로 새지 않게.
export function finalVerdict(item, judgments, overrides, humanInputs) {
  let v
  if (overrides[item.id]?.verdict) v = overrides[item.id].verdict
  else if (item.aiVerifiable) v = judgments[item.id]?.verdict || 'needs_human'
  else v = humanInputs[item.id]?.verdict || 'needs_human'
  return naNeedsReason(item, v, overrides, humanInputs) ? 'needs_human' : v
}

// hackathon-2: 트랙 대신 기능 플래그가 적용 항목을 정한다. 조건이 꺼진 항목은 자동
// '해당없음'(inapplicable)으로 분리하되, 심사자 오버라이드가 있으면 다시 심사에 포함된다.
export function computeSummary(features, judgments, overrides, humanInputs) {
  const feats = features || {}
  const items = []
  const inapplicable = []
  for (const it of rubricItems) {
    if (!it.when || feats[it.when] || overrides[it.id]?.verdict) items.push(it)
    else inapplicable.push(it)
  }

  const requiredFails = []
  const needsHuman = []
  let shouldFix = 0
  const categoryStates = {}

  for (const it of items) {
    const v = finalVerdict(it, judgments, overrides, humanInputs)
    let state = 'ok'
    if (v === 'needs_human') {
      needsHuman.push(it)
      state = 'needs_human'
    } else if (v === 'fail') {
      if (it.type === 'required') {
        requiredFails.push(it)
        state = 'fail_required'
      } else {
        shouldFix++
        state = 'fail'
      }
    }
    const cur = categoryStates[it.category] ?? 'ok'
    if (STATE_RANK[state] >= STATE_RANK[cur]) categoryStates[it.category] = state
    else if (!(it.category in categoryStates)) categoryStates[it.category] = cur
  }

  let status
  if (requiredFails.length > 0) status = 'fail_candidate'
  else if (needsHuman.length > 0) status = 'hold'
  else status = 'pass_candidate'

  return {
    items,
    inapplicable,
    requiredFails,
    needsHuman,
    categoryStates,
    status,
    actions: { mustFix: requiredFails.length, shouldFix, confirm: needsHuman.length },
  }
}
