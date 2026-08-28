// 보완 요청서 — 판단불가 항목을 원인별 3분류로 나눠 제작 교사에게 보낼 요청문을 자동 생성.
// 분류는 AI가 아니라 결정적 규칙: 게이트 미비 → 자료, 수동 항목 → 운영 증빙, 그 외 → 코드 설명.
import { finalVerdict } from './reviewSummary.js'

export const CAUSES = {
  materials: {
    title: '① 자료 미비 — 파일을 제출물에 포함해 주세요',
    ask: '아래 항목은 필요한 파일이 제출물에 없어 심사할 수 없었습니다. 해당 파일을 저장소에 포함해 다시 제출해 주세요.',
  },
  evidence: {
    title: '② 운영 증빙 필요 — 화면·문서로 확인해 주세요',
    ask: '아래 항목은 코드만으로 확인할 수 없는 운영 사항입니다. 설정 화면 캡처나 관련 문서(계획서 등)를 보내 주세요.',
  },
  clarify: {
    title: '③ 코드 근거 불충분 — 위치와 설명을 알려 주세요',
    ask: '아래 항목은 코드에서 근거를 확정하지 못했습니다. 해당 기능이 구현된 파일·위치와 동작 방식을 짧게 설명해 주세요.',
  },
}

export function classifyCause(item, judgments, gate) {
  if (!item.aiVerifiable) return 'evidence'
  const gateDbFail = gate?.checks?.some((c) => c.id === 'db-config' && !c.pass)
  if (gateDbFail && (item.category === 'access' || item.category === 'secrets')) return 'materials'
  return 'clarify'
}

export function buildSupplementRequest({ repoMeta, summary, judgments, overrides, humanInputs, gate }) {
  const pending = summary.items.filter((it) => finalVerdict(it, judgments, overrides, humanInputs) === 'needs_human')
  const buckets = { materials: [], evidence: [], clarify: [] }
  for (const it of pending) buckets[classifyCause(it, judgments, gate)].push(it)

  const target = repoMeta.commitSha
    ? `${repoMeta.owner}/${repoMeta.repo} (커밋 ${repoMeta.commitSha.slice(0, 12)})`
    : repoMeta.name || '제출물'

  const lines = [
    `[에듀 세이프] 심사 보완 요청서`,
    ``,
    `대상: ${target}`,
    `요청 항목: 총 ${pending.length}건 — 아래 내용을 보완해 주시면 심사를 이어가겠습니다.`,
  ]
  for (const [key, cause] of Object.entries(CAUSES)) {
    if (buckets[key].length === 0) continue
    lines.push('', cause.title, cause.ask)
    for (const it of buckets[key]) lines.push(`  - ${it.question} (${it.id})`)
  }
  lines.push('', '보완 후 다시 제출해 주시면 같은 기준으로 재심사합니다. 감사합니다.')
  return { text: lines.join('\n'), buckets, count: pending.length }
}
