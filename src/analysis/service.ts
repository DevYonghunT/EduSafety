import { canonicalHash } from "../lib/canonical-json.js";
import { SAFETY_BLOCKERS } from "../certification/catalog.js";
import { evaluateCriterion, scanFixedSafetyFindings } from "./evaluators.js";
import type {
  AnalysisReportSnapshot,
  CertificationPolicySnapshot,
  CriterionEvaluation,
  SafetyBlockerDefinition,
  SafetyBlockerResult,
} from "../domain/types.js";
import type { CollectedRepository, RepositorySourceProvider } from "../github/client.js";

export interface AnalysisOutcome {
  readonly decision: "PASS" | "FAIL";
  readonly reportHash: `0x${string}`;
  readonly report: AnalysisReportSnapshot;
}

function blocker(
  definition: SafetyBlockerDefinition,
  triggered: boolean,
  summary: string,
): SafetyBlockerResult {
  return { ...definition, triggered, summary };
}

function createSafetyResults(
  collected: CollectedRepository,
  criteriaResults: readonly CriterionEvaluation[],
  analyzerError: boolean,
): SafetyBlockerResult[] {
  const { secretFindings, criticalFindings: fixedCriticalFindings } = scanFixedSafetyFindings(collected.files);
  const criticalFindings = [
    ...new Map(
      [...fixedCriticalFindings, ...criteriaResults.flatMap((result) => result.findings)]
        .filter((finding) => finding.severity === "CRITICAL")
        .map((finding) => [finding.evidenceHash, finding]),
    ).values(),
  ];
  const definitions = new Map(SAFETY_BLOCKERS.map((item) => [item.blockerId, item]));
  const get = (id: SafetyBlockerDefinition["blockerId"]): SafetyBlockerDefinition => {
    const result = definitions.get(id);
    if (!result) throw new Error(`Missing safety blocker definition: ${id}`);
    return result;
  };
  return [
    blocker(
      get("critical_finding"),
      criticalFindings.length > 0,
      criticalFindings.length > 0 ? `${criticalFindings.length}개 Critical finding이 있습니다.` : "Critical finding이 없습니다.",
    ),
    blocker(
      get("secret_detected"),
      secretFindings.length > 0,
      secretFindings.length > 0 ? `${secretFindings.length}개 비밀정보 의심 finding이 있습니다.` : "비밀정보가 감지되지 않았습니다.",
    ),
    blocker(
      get("partial_analysis"),
      collected.partial,
      collected.partial ? "GitHub가 일부 tree만 반환했습니다." : "전체 대상 tree를 수집했습니다.",
    ),
    blocker(
      get("coverage_incomplete"),
      collected.coverageIncomplete,
      collected.coverageIncomplete ? "지원 파일 수집 범위가 완전하지 않습니다." : "지원 파일 수집 범위가 완전합니다.",
    ),
    blocker(
      get("exact_commit_unverified"),
      !collected.exactCommitVerified,
      collected.exactCommitVerified ? "Exact commit을 확인했습니다." : "Exact commit을 확인하지 못했습니다.",
    ),
    blocker(
      get("analyzer_error"),
      analyzerError,
      analyzerError ? "하나 이상의 필수 evaluator에서 오류가 발생했습니다." : "필수 evaluator 오류가 없습니다.",
    ),
    blocker(
      get("required_files_missing"),
      collected.failedFileCount > 0,
      collected.failedFileCount > 0
        ? `${collected.failedFileCount}개 필수 분석 대상 파일을 수집하지 못했습니다.`
        : "선정된 분석 대상 파일을 모두 수집했습니다.",
    ),
  ].sort((left, right) => left.blockerId.localeCompare(right.blockerId));
}

export class StaticAnalysisService {
  public constructor(
    private readonly sourceProvider: RepositorySourceProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public resolveRepository(repositoryUrl: string) {
    return this.sourceProvider.resolveRepository(repositoryUrl);
  }

  public async analyze(
    repositoryUrl: string,
    commitSha: string,
    pinnedPolicy: CertificationPolicySnapshot,
  ): Promise<AnalysisOutcome> {
    const collected = await this.sourceProvider.collect(repositoryUrl, commitSha);
    const criteriaResults = pinnedPolicy.criteria.map((criterion) =>
      evaluateCriterion(criterion, collected.files),
    );
    const analyzerError = criteriaResults.some((result) => result.result === "ERROR");
    const safetyBlockers = createSafetyResults(collected, criteriaResults, analyzerError);
    const fileTypes: Record<string, number> = {};
    for (const file of collected.files) {
      const type = file.extension || "no-extension";
      fileTypes[type] = (fileTypes[type] ?? 0) + 1;
    }
    const report: AnalysisReportSnapshot = {
      kind: "EduSafetyStaticAnalysisReport",
      snapshotVersion: "1",
      repository: collected.repository,
      commitSha: collected.commitSha,
      analyzedAt: this.now().toISOString(),
      policy: pinnedPolicy,
      criteriaResults: [...criteriaResults].sort((left, right) =>
        left.criterionId.localeCompare(right.criterionId),
      ),
      safetyBlockers,
      fileSummary: {
        examinedFiles: collected.files.length,
        examinedBytes: collected.files.reduce((total, file) => total + file.byteLength, 0),
        fileTypes: Object.fromEntries(Object.entries(fileTypes).sort(([left], [right]) => left.localeCompare(right))),
      },
    };
    const decision =
      report.criteriaResults.every((result) => result.result === "PASS") &&
      report.safetyBlockers.every((result) => !result.triggered)
        ? "PASS"
        : "FAIL";

    return { decision, report, reportHash: canonicalHash(report) };
  }
}
