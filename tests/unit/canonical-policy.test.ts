import { CRITERIA_CATALOG, RULESET_VERSION, SAFETY_BLOCKERS } from "../../src/certification/catalog.js";
import { calculateCriteriaHash, calculatePolicyHash, createPolicySnapshot } from "../../src/certification/policy.js";
import { PolicyService } from "../../src/certification/policy-service.js";
import { canonicalHash, canonicalJson } from "../../src/lib/canonical-json.js";
import { InMemoryCertificationRepository } from "../helpers/test-fixtures.js";

describe("canonical JSON and policy snapshots", () => {
  it("serializes object keys deterministically without reordering arrays", () => {
    expect(canonicalJson({ z: 1, nested: { b: true, a: "x" }, list: [2, 1] })).toBe(
      '{"list":[2,1],"nested":{"a":"x","b":true},"z":1}',
    );
    expect(canonicalHash({ b: 2, a: 1 })).toBe(canonicalHash({ a: 1, b: 2 }));
    expect(canonicalHash({ list: [1, 2] })).not.toBe(canonicalHash({ list: [2, 1] }));
  });

  it("rejects unsupported canonical values", () => {
    expect(() => canonicalJson({ missing: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/);
  });

  it("calculates the same policy hash regardless of input criterion order", () => {
    const first = createPolicySnapshot({
      policyId: "f2bcb30a-f6d6-44a3-ad30-2fe61ce8ee58",
      name: "정책",
      policyVersion: 4,
      rulesetVersion: RULESET_VERSION,
      criteria: [CRITERIA_CATALOG[2]!, CRITERIA_CATALOG[0]!],
    });
    const second = createPolicySnapshot({
      policyId: first.policyId,
      name: first.name,
      policyVersion: first.policyVersion,
      rulesetVersion: first.rulesetVersion,
      criteria: [CRITERIA_CATALOG[0]!, CRITERIA_CATALOG[2]!],
    });
    expect(first.policyHash).toBe(second.policyHash);
    expect(first.safetyBlockers).toEqual([...SAFETY_BLOCKERS].sort((a, b) => a.blockerId.localeCompare(b.blockerId)));
    expect(
      calculatePolicyHash({
        policyId: first.policyId,
        name: first.name,
        policyVersion: first.policyVersion,
        rulesetVersion: first.rulesetVersion,
        criteria: first.criteria,
        safetyBlockers: first.safetyBlockers,
      }),
    ).toBe(first.policyHash);
  });

  it("hashes sorted PASS criterion snapshots", () => {
    const left = [
      { criterionId: "z", criterionVersion: "1", result: "PASS" as const },
      { criterionId: "a", criterionVersion: "2", result: "PASS" as const },
    ];
    expect(calculateCriteriaHash(left)).toBe(calculateCriteriaHash([...left].reverse()));
  });
});

describe("policy service", () => {
  it("creates successive immutable policy versions and writes audit entries", async () => {
    const repository = new InMemoryCertificationRepository();
    const service = new PolicyService(repository, () => new Date("2026-08-28T00:00:00.000Z"));
    const first = await service.createDraft({
      name: "첫 정책",
      criterionIds: ["no-hardcoded-secrets"],
      administratorId: "admin-1",
    });
    const active = await service.publish(first.snapshot.policyId, "admin-1");
    const replacement = await service.createDraft({
      name: "교체 정책",
      criterionIds: ["no-dangerous-code-execution"],
      administratorId: "admin-1",
    });
    await service.publish(replacement.snapshot.policyId, "admin-1");

    expect(active.snapshot.policyVersion).toBe(1);
    expect(replacement.snapshot.policyVersion).toBe(2);
    expect(replacement.snapshot.policyHash).not.toBe(active.snapshot.policyHash);
    expect((await repository.getPolicy(first.snapshot.policyId))?.status).toBe("ARCHIVED");
    expect((await repository.getActivePolicy())?.snapshot.policyId).toBe(replacement.snapshot.policyId);
    expect(repository.audits.map((entry) => entry.action)).toEqual([
      "POLICY_CREATED",
      "POLICY_PUBLISHED",
      "POLICY_CREATED",
      "POLICY_ARCHIVED",
      "POLICY_PUBLISHED",
    ]);
  });

  it("rejects unknown, duplicate and inactive criteria", async () => {
    const repository = new InMemoryCertificationRepository();
    const service = new PolicyService(repository);
    await expect(
      service.createDraft({ name: "x", criterionIds: ["missing"], administratorId: "admin" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CRITERION" });
    await expect(
      service.createDraft({
        name: "x",
        criterionIds: ["no-hardcoded-secrets", "no-hardcoded-secrets"],
        administratorId: "admin",
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_CRITERION" });
    repository.criteria[0] = { ...repository.criteria[0]!, active: false };
    await expect(
      service.createDraft({ name: "x", criterionIds: ["no-hardcoded-secrets"], administratorId: "admin" }),
    ).rejects.toMatchObject({ code: "INACTIVE_CRITERION" });
  });

  it("allows an empty draft but refuses to publish it", async () => {
    const repository = new InMemoryCertificationRepository();
    const service = new PolicyService(repository);
    const draft = await service.createDraft({ name: "빈 초안", criterionIds: [], administratorId: "admin" });
    await expect(service.publish(draft.snapshot.policyId, "admin")).rejects.toMatchObject({
      code: "EMPTY_POLICY",
    });
  });

  it("refuses to update a published policy", async () => {
    const repository = new InMemoryCertificationRepository();
    const service = new PolicyService(repository);
    const draft = await service.createDraft({
      name: "정책",
      criterionIds: ["no-hardcoded-secrets"],
      administratorId: "admin",
    });
    await service.publish(draft.snapshot.policyId, "admin");
    await expect(
      service.updateDraft({
        policyId: draft.snapshot.policyId,
        name: "변경",
        criterionIds: ["no-hardcoded-secrets"],
        administratorId: "admin",
      }),
    ).rejects.toMatchObject({ code: "POLICY_IMMUTABLE" });
  });
});
