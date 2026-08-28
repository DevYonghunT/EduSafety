import type { CriterionDefinition, SafetyBlockerDefinition } from "../domain/types.js";

export const RULESET_VERSION = "2026.08.1";

export const CRITERIA_CATALOG: readonly CriterionDefinition[] = Object.freeze([
  {
    criterionId: "no-hardcoded-secrets",
    criterionVersion: "1.0.0",
    name: "하드코딩된 비밀정보 없음",
    publicDescription: "지원되는 소스와 설정 파일에서 고신뢰도 비밀정보 패턴이 발견되지 않아야 합니다.",
    category: "Secrets",
    evaluatorKey: "secrets.static.v1",
    active: true,
    available: true,
    displayOrder: 10,
  },
  {
    criterionId: "no-dangerous-code-execution",
    criterionVersion: "1.0.0",
    name: "위험한 동적 코드 실행 없음",
    publicDescription: "정적 분석 범위에서 eval, 동적 함수 생성 및 명령 실행 패턴이 발견되지 않아야 합니다.",
    category: "Code execution",
    evaluatorKey: "execution.static.v1",
    active: true,
    available: true,
    displayOrder: 20,
  },
  {
    criterionId: "dependency-lockfile-present",
    criterionVersion: "1.0.0",
    name: "의존성 잠금 파일 사용",
    publicDescription: "의존성 선언이 있는 프로젝트는 지원되는 잠금 파일을 함께 커밋해야 합니다.",
    category: "Dependencies",
    evaluatorKey: "lockfile.static.v1",
    active: true,
    available: true,
    displayOrder: 30,
  },
  {
    criterionId: "no-unsafe-html-sinks",
    criterionVersion: "1.0.0",
    name: "안전하지 않은 HTML 주입 없음",
    publicDescription: "지원되는 웹 소스에서 직접적인 HTML 주입 sink가 발견되지 않아야 합니다.",
    category: "Web",
    evaluatorKey: "html-sinks.static.v1",
    active: true,
    available: true,
    displayOrder: 40,
  },
  {
    criterionId: "restricted-cors-policy",
    criterionVersion: "1.0.0",
    name: "제한된 CORS 정책",
    publicDescription: "지원되는 서버 설정에서 무제한 CORS 허용 패턴이 발견되지 않아야 합니다.",
    category: "Configuration",
    evaluatorKey: "cors.static.v1",
    active: true,
    available: true,
    displayOrder: 50,
  },
]);

export const SAFETY_BLOCKERS: readonly SafetyBlockerDefinition[] = Object.freeze([
  { blockerId: "critical_finding", version: "1.0.0", name: "Critical finding" },
  { blockerId: "secret_detected", version: "1.0.0", name: "Secret detected" },
  { blockerId: "partial_analysis", version: "1.0.0", name: "Partial analysis" },
  { blockerId: "coverage_incomplete", version: "1.0.0", name: "Coverage incomplete" },
  { blockerId: "exact_commit_unverified", version: "1.0.0", name: "Exact commit verification" },
  { blockerId: "analyzer_error", version: "1.0.0", name: "Analyzer errors" },
  { blockerId: "required_files_missing", version: "1.0.0", name: "Required files collected" },
]);

export function findCriterion(criterionId: string): CriterionDefinition | undefined {
  return CRITERIA_CATALOG.find((criterion) => criterion.criterionId === criterionId);
}
