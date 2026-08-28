import { canonicalHash } from "../lib/canonical-json.js";
import { SAFETY_BLOCKERS } from "./catalog.js";
import type {
  CertificationPolicySnapshot,
  CriterionDefinition,
  CriterionEvaluation,
  PolicyCriterionSnapshot,
  SignedCriterion,
} from "../domain/types.js";

export function sortPolicyCriteria(
  criteria: readonly PolicyCriterionSnapshot[],
): PolicyCriterionSnapshot[] {
  return [...criteria].sort((left, right) =>
    left.criterionId.localeCompare(right.criterionId) ||
    left.criterionVersion.localeCompare(right.criterionVersion),
  );
}

export function calculatePolicyHash(
  policy: Omit<CertificationPolicySnapshot, "policyHash">,
): `0x${string}` {
  return canonicalHash({
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    rulesetVersion: policy.rulesetVersion,
    criteria: sortPolicyCriteria(policy.criteria).map((criterion) => ({
      criterionId: criterion.criterionId,
      criterionVersion: criterion.criterionVersion,
      evaluatorKey: criterion.evaluatorKey,
    })),
    safetyBlockers: [...policy.safetyBlockers]
      .sort((left, right) => left.blockerId.localeCompare(right.blockerId))
      .map((blocker) => ({ blockerId: blocker.blockerId, version: blocker.version })),
  });
}

export function createPolicySnapshot(input: {
  policyId: string;
  name: string;
  policyVersion: number;
  rulesetVersion: string;
  criteria: readonly CriterionDefinition[];
}): CertificationPolicySnapshot {
  const criteria = sortPolicyCriteria(
    input.criteria.map((criterion) => ({
      criterionId: criterion.criterionId,
      criterionVersion: criterion.criterionVersion,
      name: criterion.name,
      publicDescription: criterion.publicDescription,
      category: criterion.category,
      evaluatorKey: criterion.evaluatorKey,
      displayOrder: criterion.displayOrder,
    })),
  );
  const withoutHash = {
    policyId: input.policyId,
    name: input.name,
    policyVersion: input.policyVersion,
    rulesetVersion: input.rulesetVersion,
    criteria,
    safetyBlockers: [...SAFETY_BLOCKERS].sort((left, right) =>
      left.blockerId.localeCompare(right.blockerId),
    ),
  } as const;

  return { ...withoutHash, policyHash: calculatePolicyHash(withoutHash) };
}

export function signedCriteriaFromResults(
  results: readonly CriterionEvaluation[],
): SignedCriterion[] {
  return [...results]
    .sort((left, right) => left.criterionId.localeCompare(right.criterionId))
    .map((result) => {
      if (result.result !== "PASS") {
        throw new Error(`Cannot sign non-PASS criterion ${result.criterionId}`);
      }
      return {
        criterionId: result.criterionId,
        criterionVersion: result.criterionVersion,
        result: "PASS",
      };
    });
}

export function calculateCriteriaHash(criteria: readonly SignedCriterion[]): `0x${string}` {
  return canonicalHash(
    [...criteria]
      .sort((left, right) => left.criterionId.localeCompare(right.criterionId))
      .map(({ criterionId, criterionVersion, result }) => ({
        criterionId,
        criterionVersion,
        result,
      })),
  );
}
