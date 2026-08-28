import { StaticAnalysisService } from "../../src/analysis/service.js";
import { CRITERIA_CATALOG, RULESET_VERSION } from "../../src/certification/catalog.js";
import { createPolicySnapshot } from "../../src/certification/policy.js";
import type { CriterionDefinition } from "../../src/domain/types.js";
import {
  FixtureSourceProvider,
  sourceFile,
} from "../helpers/test-fixtures.js";

function policy(criteria: readonly CriterionDefinition[]) {
  return createPolicySnapshot({
    policyId: "aaadf863-eb24-4f13-9843-a5efae5b4112",
    name: "테스트 정책",
    policyVersion: 1,
    rulesetVersion: RULESET_VERSION,
    criteria,
  });
}

describe("static analysis decision", () => {
  it("passes only when every selected criterion passes and no safety blocker is triggered", async () => {
    const provider = new FixtureSourceProvider();
    const service = new StaticAnalysisService(provider, () => new Date("2026-08-28T00:00:00.000Z"));
    const result = await service.analyze("https://github.com/example/education-service", provider.collection.commitSha, policy(CRITERIA_CATALOG));
    expect(result.decision).toBe("PASS");
    expect(result.report.criteriaResults.every((criterion) => criterion.result === "PASS")).toBe(true);
    expect(result.report.safetyBlockers.every((blocker) => !blocker.triggered)).toBe(true);
  });

  it.each([
    ["FAIL", [CRITERIA_CATALOG[3]!], [sourceFile("src/view.ts", "element.innerHTML = input;")]],
    ["NOT_APPLICABLE", [CRITERIA_CATALOG[2]!], [sourceFile("main.py", "safe = True")]],
    [
      "ERROR",
      [{ ...CRITERIA_CATALOG[0]!, criterionId: "server-mismatch", evaluatorKey: "unsupported.evaluator" }],
      [sourceFile("main.ts", "export const safe = true")],
    ],
  ])("does not issue when a selected criterion returns %s", async (expected, selected, files) => {
    const provider = new FixtureSourceProvider(files);
    const result = await new StaticAnalysisService(provider).analyze(
      provider.collection.repository.canonicalRepositoryUrl,
      provider.collection.commitSha,
      policy(selected),
    );
    expect(result.decision).toBe("FAIL");
    expect(result.report.criteriaResults[0]?.result).toBe(expected);
  });

  it("ignores an unselected ordinary failure", async () => {
    const provider = new FixtureSourceProvider([
      sourceFile("package.json", '{"name":"safe"}'),
      sourceFile("package-lock.json", "{}"),
      sourceFile("view.ts", "element.innerHTML = userInput;"),
    ]);
    const result = await new StaticAnalysisService(provider).analyze(
      provider.collection.repository.canonicalRepositoryUrl,
      provider.collection.commitSha,
      policy([CRITERIA_CATALOG[2]!]),
    );
    expect(result.decision).toBe("PASS");
    expect(result.report.criteriaResults).toHaveLength(1);
  });

  it.each([
    ["critical_finding", [sourceFile("main.ts", "eval(userInput);")], {}],
    ["secret_detected", [sourceFile("config.ts", `const apiKey = '${"a".repeat(24)}';`)], {}],
    ["partial_analysis", [], { partial: true }],
    ["coverage_incomplete", [], { coverageIncomplete: true }],
    ["exact_commit_unverified", [], { exactCommitVerified: false }],
    ["required_files_missing", [], { failedFileCount: 1 }],
  ])("always blocks on %s", async (blockerId, files, collectionChanges) => {
    const provider = new FixtureSourceProvider(files.length > 0 ? files : [sourceFile("main.ts", "const safe = true")]);
    provider.collection = { ...provider.collection, ...collectionChanges };
    const result = await new StaticAnalysisService(provider).analyze(
      provider.collection.repository.canonicalRepositoryUrl,
      provider.collection.commitSha,
      policy([CRITERIA_CATALOG[1]!]),
    );
    expect(result.decision).toBe("FAIL");
    expect(result.report.safetyBlockers.find((blocker) => blocker.blockerId === blockerId)?.triggered).toBe(true);
  });

  it("stores no matched secret or source snippet in findings", async () => {
    const secretValue = "credential_material_for_test_only";
    const provider = new FixtureSourceProvider([sourceFile("settings.ts", `const apiKey = '${secretValue}';`)]);
    const result = await new StaticAnalysisService(provider).analyze(
      provider.collection.repository.canonicalRepositoryUrl,
      provider.collection.commitSha,
      policy([CRITERIA_CATALOG[0]!]),
    );
    const serialized = JSON.stringify(result.report);
    expect(serialized).not.toContain(secretValue);
    expect(serialized).not.toContain("settings.ts");
    expect(serialized).toContain("evidenceHash");
  });

  it("fails closed with a bounded finding set when the scan limit is reached", async () => {
    const provider = new FixtureSourceProvider([
      sourceFile("generated-a.ts", "eval(userInput);\n".repeat(1_100)),
      sourceFile("generated-b.ts", "eval(userInput);\n".repeat(1_100)),
      sourceFile("generated-c.ts", "eval(userInput);\n".repeat(1_100)),
    ]);
    const result = await new StaticAnalysisService(provider).analyze(
      provider.collection.repository.canonicalRepositoryUrl,
      provider.collection.commitSha,
      policy([CRITERIA_CATALOG[1]!]),
    );
    expect(result.decision).toBe("FAIL");
    expect(result.report.criteriaResults[0]?.findings.length).toBeLessThanOrEqual(2_001);
    expect(result.report.criteriaResults[0]?.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId: "ANALYSIS_FINDING_LIMIT_REACHED" })]),
    );
    expect(
      result.report.safetyBlockers.find((blocker) => blocker.blockerId === "critical_finding")?.triggered,
    ).toBe(true);
  });
});
