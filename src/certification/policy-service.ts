import { randomUUID } from "node:crypto";
import { CRITERIA_CATALOG, RULESET_VERSION } from "./catalog.js";
import { createPolicySnapshot } from "./policy.js";
import type { CriterionDefinition } from "../domain/types.js";
import type { CertificationRepository, PolicyRecord } from "../db/repository.js";

export class PolicyValidationError extends Error {
  public constructor(
    public readonly code:
      | "DUPLICATE_CRITERION"
      | "EMPTY_POLICY"
      | "INACTIVE_CRITERION"
      | "POLICY_IMMUTABLE"
      | "POLICY_NOT_FOUND"
      | "UNSUPPORTED_CRITERION",
    message: string,
  ) {
    super(message);
    this.name = "PolicyValidationError";
  }
}

export class PolicyService {
  public constructor(
    private readonly repository: CertificationRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async #resolveCriteria(criterionIds: readonly string[]): Promise<readonly CriterionDefinition[]> {
    if (new Set(criterionIds).size !== criterionIds.length) {
      throw new PolicyValidationError("DUPLICATE_CRITERION", "같은 심사 항목을 중복 선택할 수 없습니다.");
    }
    if (criterionIds.length === 0) return [];
    const stored = await this.repository.getCriteria(criterionIds);
    const storedById = new Map(stored.map((criterion) => [criterion.criterionId, criterion]));
    const compiledById = new Map(CRITERIA_CATALOG.map((criterion) => [criterion.criterionId, criterion]));

    return criterionIds.map((criterionId) => {
      const dbCriterion = storedById.get(criterionId);
      const compiled = compiledById.get(criterionId);
      if (!dbCriterion || !compiled) {
        throw new PolicyValidationError(
          "UNSUPPORTED_CRITERION",
          `지원되지 않는 심사 항목입니다: ${criterionId}`,
        );
      }
      if (!dbCriterion.active || !dbCriterion.available || !compiled.active || !compiled.available) {
        throw new PolicyValidationError("INACTIVE_CRITERION", `현재 사용할 수 없는 심사 항목입니다: ${criterionId}`);
      }
      if (
        dbCriterion.criterionVersion !== compiled.criterionVersion ||
        dbCriterion.evaluatorKey !== compiled.evaluatorKey
      ) {
        throw new PolicyValidationError(
          "UNSUPPORTED_CRITERION",
          `서버 evaluator와 DB 항목 버전이 일치하지 않습니다: ${criterionId}`,
        );
      }
      return dbCriterion;
    });
  }

  public async createDraft(input: {
    name: string;
    criterionIds: readonly string[];
    administratorId: string;
  }): Promise<PolicyRecord> {
    const criteria = await this.#resolveCriteria(input.criterionIds);
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
    criterionIds: readonly string[];
    administratorId: string;
  }): Promise<PolicyRecord> {
    const existing = await this.repository.getPolicy(input.policyId);
    if (!existing) throw new PolicyValidationError("POLICY_NOT_FOUND", "정책을 찾을 수 없습니다.");
    if (existing.status !== "DRAFT") {
      throw new PolicyValidationError("POLICY_IMMUTABLE", "발행된 정책은 수정할 수 없습니다.");
    }
    const criteria = await this.#resolveCriteria(input.criterionIds);
    const snapshot = createPolicySnapshot({
      policyId: existing.snapshot.policyId,
      name: input.name,
      policyVersion: existing.snapshot.policyVersion,
      rulesetVersion: existing.snapshot.rulesetVersion,
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
    if (existing.snapshot.criteria.length === 0) {
      throw new PolicyValidationError("EMPTY_POLICY", "심사 항목을 하나 이상 선택해야 합니다.");
    }
    await this.#resolveCriteria(existing.snapshot.criteria.map((criterion) => criterion.criterionId));
    return this.repository.publishPolicy(policyId, administratorId, this.now().toISOString());
  }
}
