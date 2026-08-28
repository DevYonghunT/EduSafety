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

// 판정 우선순위: 심사자 오버라이드 > AI 판정(aiVerifiable) 또는 심사자 수동 입력.
// 빈 값('판정 선택' 미완료)은 needs_human으로 수렴 — 빈칸이 합격으로 새지 않게.
export function finalVerdict(item, judgments, overrides, humanInputs) {
  if (overrides[item.id]?.verdict) return overrides[item.id].verdict
  if (item.aiVerifiable) return judgments[item.id]?.verdict || 'needs_human'
  return humanInputs[item.id]?.verdict || 'needs_human'
}

export function computeSummary(track, judgments, overrides, humanInputs) {
  const items = rubricItems.filter((it) => it.tracks.includes(track))
  // 항목이 없는 트랙(비정상 값)은 절대 합격 후보가 되면 안 된다
  if (items.length === 0) {
    return { items, requiredFails: [], needsHuman: [], categoryStates: {}, status: 'hold', actions: { mustFix: 0, shouldFix: 0, confirm: 0 } }
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
    requiredFails,
    needsHuman,
    categoryStates,
    status,
    actions: { mustFix: requiredFails.length, shouldFix, confirm: needsHuman.length },
  }
}
