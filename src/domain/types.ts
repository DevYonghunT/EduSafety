export const CRITERION_RESULT_STATUSES = [
  "PASS",
  "FAIL",
  "ERROR",
  "NOT_RUN",
  "NOT_APPLICABLE",
  "UNKNOWN",
] as const;

export type CriterionResultStatus = (typeof CRITERION_RESULT_STATUSES)[number];
export type FindingSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface SafeFinding {
  readonly ruleId: string;
  readonly severity: FindingSeverity;
  readonly description: string;
  readonly fileType: string;
  readonly count: number;
  readonly location: string;
  readonly evidenceHash: `0x${string}`;
}

export interface CriterionDefinition {
  readonly criterionId: string;
  readonly criterionVersion: string;
  readonly name: string;
  readonly publicDescription: string;
  readonly category: string;
  readonly evaluatorKey: string;
  readonly active: boolean;
  readonly available: boolean;
  readonly displayOrder: number;
}

export interface PolicyCriterionSnapshot {
  readonly criterionId: string;
  readonly criterionVersion: string;
  readonly evaluatorKey: string;
  readonly name: string;
  readonly publicDescription: string;
  readonly category: string;
  readonly displayOrder: number;
}

export interface SafetyBlockerDefinition {
  readonly blockerId:
    | "critical_finding"
    | "secret_detected"
    | "partial_analysis"
    | "coverage_incomplete"
    | "exact_commit_unverified"
    | "analyzer_error"
    | "required_files_missing";
  readonly version: string;
  readonly name: string;
}

export interface CertificationPolicySnapshot {
  readonly policyId: string;
  readonly name: string;
  readonly policyVersion: number;
  readonly policyHash: `0x${string}`;
  readonly rulesetVersion: string;
  readonly criteria: readonly PolicyCriterionSnapshot[];
  readonly safetyBlockers: readonly SafetyBlockerDefinition[];
}

export interface CriterionEvaluation {
  readonly criterionId: string;
  readonly criterionVersion: string;
  readonly evaluatorKey: string;
  readonly result: CriterionResultStatus;
  readonly summary: string;
  readonly findings: readonly SafeFinding[];
}

export interface SafetyBlockerResult extends SafetyBlockerDefinition {
  readonly triggered: boolean;
  readonly summary: string;
}

export interface RepositorySnapshot {
  readonly repositoryId: number;
  readonly canonicalRepositoryUrl: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
}

export interface AnalysisReportSnapshot {
  readonly kind: "EduSafetyStaticAnalysisReport";
  readonly snapshotVersion: "1";
  readonly repository: RepositorySnapshot;
  readonly commitSha: string;
  readonly analyzedAt: string;
  readonly policy: CertificationPolicySnapshot;
  readonly criteriaResults: readonly CriterionEvaluation[];
  readonly safetyBlockers: readonly SafetyBlockerResult[];
  readonly fileSummary: {
    readonly examinedFiles: number;
    readonly examinedBytes: number;
    readonly fileTypes: Readonly<Record<string, number>>;
  };
}

export interface SignedCriterion {
  readonly criterionId: string;
  readonly criterionVersion: string;
  readonly result: "PASS";
}

export interface CertificationPayload {
  readonly kind: "EduSafetyCertification";
  readonly payloadVersion: "1";
  readonly subjectKey: string;
  readonly repositoryId: number;
  readonly canonicalRepositoryUrl: string;
  readonly commitSha: string;
  readonly reportHash: `0x${string}`;
  readonly decision: "PASS";
  readonly certificationPolicyId: string;
  readonly policyHash: `0x${string}`;
  readonly policyVersion: number;
  readonly criteriaHash: `0x${string}`;
  readonly criteria: readonly SignedCriterion[];
  readonly rulesetVersion: string;
}

export type PolicyStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";
export type VerificationStatus =
  | "INVALID"
  | "REVOKED"
  | "EXPIRED"
  | "UNVERIFIED"
  | "STALE"
  | "VALID";
