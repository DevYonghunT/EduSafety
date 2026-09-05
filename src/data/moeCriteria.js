// 교육부 「학습지원 소프트웨어 선정기준」(2025.12, 개보위 협의) × 코어 루브릭 대조 — 학교용 [서식 1] 참고 자료.
// 근거: 초·중등교육법 제29조의2(2026-03 시행). 교육부 기준은 "기재·안내되어 있는가"를 묻고,
// 에듀 세이프는 한 걸음 더 "코드가 실제로 그렇게 동작하는가"를 본다. gap은 아직 루브릭이 못 채우는 부분(정직 고지).
export const MOE_CRITERIA = [
  { code: '필수 1', title: '최소처리원칙 — 최소 수집, 목적·항목·보유기간 기재',
    items: ['S-minimal', 'S-privacy-notice'], gap: '처리방침 문서의 기재 항목 완전성은 심사자 수동 확인' },
  { code: '필수 2', title: '개인정보 안전조치 의무',
    items: ['R-secrets', 'R-db-locked', 'R-impersonate', 'S-access', 'S-https', 'S-injection', 'R-server-guard', 'S-password-storage'], gap: null },
  { code: '필수 3', title: '열람·정정·삭제·처리정지 절차 안내',
    items: ['H-delete'], gap: '열람·정정·처리정지 절차 안내 항목은 v1.4 후보 — 현재 삭제만 확인' },
  { code: '필수 4', title: '만 14세 미만 아동 보호 (법정대리인 동의 절차)',
    items: ['R-under14'], gap: null },
  { code: '필수 5', title: '보호책임자·제3자 제공·위탁 정보 안내',
    items: ['S-privacy-notice', 'S-data-region', 'R-third-party', 'R-llm-input'], gap: '보호책임자(CPO) 표기·위탁 관계 명시 항목은 v1.4 후보' },
  { code: '선택 1', title: '교육목표·학생 특성 적합성',
    items: ['H-edu-fit', 'H-standards'], gap: null },
  { code: '선택 2', title: '콘텐츠 품질·안전성 (연령 적합)',
    items: ['H-edu-fit', 'S-ai-fallibility'], gap: '연령 적합성은 교육 적절성 항목으로 부분 확인' },
  { code: '선택 3', title: '사용 환경 적합성 (기기·네트워크)',
    items: ['H-usability'], gap: null },
  { code: '선택 4', title: '접근성·사용성',
    items: ['H-usability'], gap: '장애 학생 접근성(KWCAG) 관점은 v1.4 후보' },
  { code: '선택 5', title: '서비스 운영·지원 체계',
    items: ['S-privacy-notice', 'H-retention', 'S-abuse-limit'], gap: null },
]

export const MOE_STATUS_LABELS = {
  fail: '미충족', needs_human: '확인 필요', ok: '충족(코드 확인)', na: '해당없음', none: '해당 항목 없음',
}

// 기준 하나의 상태 = 대응 항목들의 최악 판정. verdictOf(id) → 'ok'|'fail'|'needs_human'|'na'|null(적용 대상 아님)
export function moeCriterionStatus(criterion, verdictOf) {
  const verdicts = criterion.items.map(verdictOf).filter(Boolean)
  if (verdicts.length === 0) return 'none'
  if (verdicts.includes('fail')) return 'fail'
  if (verdicts.includes('needs_human')) return 'needs_human'
  if (verdicts.every((v) => v === 'na')) return 'na'
  return 'ok'
}
