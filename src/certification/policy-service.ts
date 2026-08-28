import { randomUUID } from "node:crypto";
import { CRITERIA_CATALOG, RULESET_VERSION } from "./catalog.js";
import { createPolicySnapshot } from "./policy.js";
import { canonicalJson } from "../lib/canonical-json.js";
import type { CertificationPolicySnapshot, CriterionDefinition } from "../domain/types.js";
import type { CertificationRepository, PolicyRecord } from "../db/repository.js";

export const REQUIRED_CRITERIA_CATALOG = Object.freeze(
  CRITERIA_CATALOG.filter((criterion) => criterion.active && criterion.available),
);

export class PolicyValidationError extends Error {
  public constructor(
    public readonly code:
      | "POLICY_CRITERIA_MISMATCH"
      | "POLICY_IMMUTABLE"
      | "POLICY_NOT_FOUND"
      | "REQUIRED_CRITERIA_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "PolicyValidationError";
  }
}

export async function resolveRequiredCriteria(
  repository: CertificationRepository,
): Promise<readonly CriterionDefinition[]> {
  if (REQUIRED_CRITERIA_CATALOG.length === 0) {
    throw new PolicyValidationError(
      "REQUIRED_CRITERIA_UNAVAILABLE",
      "서버 ruleset에 필수 심사 항목이 없습니다.",
    );
  }

  const stored = await repository.getCriteria(
    REQUIRED_CRITERIA_CATALOG.map((criterion) => criterion.criterionId),
  );
  return REQUIRED_CRITERIA_CATALOG.map((compiled) => {
    const dbCriterion = stored.find(
      (criterion) =>
        criterion.criterionId === compiled.criterionId &&
        criterion.criterionVersion === compiled.criterionVersion,
    );
    if (!dbCriterion) {
      throw new PolicyValidationError(
        "REQUIRED_CRITERIA_UNAVAILABLE",
        `필수 심사 항목이 DB에 등록되지 않았습니다: ${compiled.criterionId}@${compiled.criterionVersion}`,
      );
    }
    if (!dbCriterion.active || !dbCriterion.available) {
      throw new PolicyValidationError(
        "REQUIRED_CRITERIA_UNAVAILABLE",
        `필수 심사 항목을 현재 사용할 수 없습니다: ${compiled.criterionId}`,
      );
    }
    if (dbCriterion.evaluatorKey !== compiled.evaluatorKey) {
      throw new PolicyValidationError(
        "REQUIRED_CRITERIA_UNAVAILABLE",
        `서버 evaluator와 DB 항목 버전이 일치하지 않습니다: ${compiled.criterionId}`,
      );
    }
    return dbCriterion;
  });
}

export function assertRequiredPolicySnapshot(
  snapshot: CertificationPolicySnapshot,
  requiredCriteria: readonly CriterionDefinition[],
): void {
  const expected = createPolicySnapshot({
    policyId: snapshot.policyId,
    name: snapshot.name,
    policyVersion: snapshot.policyVersion,
    rulesetVersion: RULESET_VERSION,
    criteria: requiredCriteria,
  });
  if (canonicalJson(snapshot) !== canonicalJson(expected)) {
    throw new PolicyValidationError(
      "POLICY_CRITERIA_MISMATCH",
      "정책 snapshot이 현재 서버의 고정 필수 심사 항목과 일치하지 않습니다.",
    );
  }
}

export class PolicyService {
  public constructor(
    private readonly repository: CertificationRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async createDraft(input: {
    name: string;
    administratorId: string;
  }): Promise<PolicyRecord> {
    const criteria = await resolveRequiredCriteria(this.repository);
    const policyVersion = await this.repository.nextPolicyVersion();
    const snapshot = createPolicySnapshot({
      policyId: randomUUID(),
      name: input.name,
      policyVersion,
      rulesetVersion: RULESET_VERSION,
      criteria,
    });
    const record: PolicyRecord = {
      snapshot,
      status: "DRAFT",
      createdBy: input.administratorId,
      createdAt: this.now().toISOString(),
      publishedAt: null,
      archivedAt: null,
    };
    return this.repository.createDraftPolicy(record);
  }

  public async updateDraft(input: {
    policyId: string;
    name: string;
    administratorId: string;
  }): Promise<PolicyRecord> {
    const existing = await this.repository.getPolicy(input.policyId);
    if (!existing) throw new PolicyValidationError("POLICY_NOT_FOUND", "정책을 찾을 수 없습니다.");
    if (existing.status !== "DRAFT") {
      throw new PolicyValidationError("POLICY_IMMUTABLE", "발행된 정책은 수정할 수 없습니다.");
    }
    const criteria = await resolveRequiredCriteria(this.repository);
    const snapshot = createPolicySnapshot({
      policyId: existing.snapshot.policyId,
      name: input.name,
      policyVersion: existing.snapshot.policyVersion,
      rulesetVersion: RULESET_VERSION,
      criteria,
    });
    return this.repository.updateDraftPolicy(
      { ...existing, snapshot },
      input.administratorId,
    );
  }

  public async publish(policyId: string, administratorId: string): Promise<PolicyRecord> {
    const existing = await this.repository.getPolicy(policyId);
    if (!existing) throw new PolicyValidationError("POLICY_NOT_FOUND", "정책을 찾을 수 없습니다.");
    if (existing.status !== "DRAFT") {
      throw new PolicyValidationError("POLICY_IMMUTABLE", "초안 정책만 발행할 수 있습니다.");
    }
    const criteria = await resolveRequiredCriteria(this.repository);
    assertRequiredPolicySnapshot(existing.snapshot, criteria);
    return this.repository.publishPolicy(policyId, administratorId, this.now().toISOString());
  }
}
