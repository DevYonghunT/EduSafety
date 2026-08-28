import type { SignedAttestationProof } from "../certification/attestation.js";
import type {
  AnalysisReportSnapshot,
  CertificationPayload,
  CertificationPolicySnapshot,
  CriterionDefinition,
  PolicyStatus,
} from "../domain/types.js";

export interface PolicyRecord {
  readonly snapshot: CertificationPolicySnapshot;
  readonly status: PolicyStatus;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly publishedAt: string | null;
  readonly archivedAt: string | null;
}

export interface AnalysisRecordInput {
  readonly analysisId: string;
  readonly decision: "PASS" | "FAIL";
  readonly reportHash: `0x${string}`;
  readonly report: AnalysisReportSnapshot;
}

export interface IssuedBadgeInput extends AnalysisRecordInput {
  readonly criteriaHash: `0x${string}`;
  readonly payload: CertificationPayload;
  readonly proof: SignedAttestationProof;
}

export interface StoredBadge {
  readonly analysisId: string;
  readonly policySnapshot: CertificationPolicySnapshot;
  readonly report: AnalysisReportSnapshot;
  readonly reportHash: `0x${string}`;
  readonly criteriaHash: `0x${string}`;
  readonly proof: SignedAttestationProof;
  readonly typedDataSnapshot: unknown;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  readonly revocationReason: string | null;
}

export interface RevokeBadgeInput {
  readonly uid: string;
  readonly administratorId: string;
  readonly reason: string;
  readonly revokedAt: string;
}

export interface CertificationRepository {
  listCriteria(): Promise<readonly CriterionDefinition[]>;
  getCriteria(criterionIds: readonly string[]): Promise<readonly CriterionDefinition[]>;
  nextPolicyVersion(): Promise<number>;
  listPolicies(): Promise<readonly PolicyRecord[]>;
  getPolicy(policyId: string): Promise<PolicyRecord | null>;
  getActivePolicy(): Promise<PolicyRecord | null>;
  createDraftPolicy(record: PolicyRecord): Promise<PolicyRecord>;
  updateDraftPolicy(record: PolicyRecord, administratorId: string): Promise<PolicyRecord>;
  publishPolicy(policyId: string, administratorId: string, publishedAt: string): Promise<PolicyRecord>;
  saveRejectedAnalysis(input: AnalysisRecordInput): Promise<void>;
  saveIssuedBadge(input: IssuedBadgeInput): Promise<{ badge: StoredBadge; created: boolean }>;
  getBadgeBySubject(
    repositoryId: number,
    commitSha: string,
    policyHash: string,
    rulesetVersion: string,
  ): Promise<StoredBadge | null>;
  getBadge(uid: string): Promise<StoredBadge | null>;
  listBadges(limit: number): Promise<readonly StoredBadge[]>;
  revokeBadge(input: RevokeBadgeInput): Promise<{ badge: StoredBadge; created: boolean } | null>;
}

export class RepositoryUnavailableError extends Error {
  public constructor(message = "Certification repository is unavailable") {
    super(message);
    this.name = "RepositoryUnavailableError";
  }
}
