import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { StaticAnalysisService, type AnalysisOutcome } from "../../src/analysis/service.js";
import { AttestationSigner, type SignedAttestationProof } from "../../src/certification/attestation.js";
import {
  BadgeIssueService,
  type CertificationAnalyzer,
  type CertificationSigner,
} from "../../src/certification/issue-service.js";
import { PolicyService } from "../../src/certification/policy-service.js";
import type { CertificationPayload, CriterionResultStatus } from "../../src/domain/types.js";
import {
  FixtureSourceProvider,
  InMemoryCertificationRepository,
  TEST_COMMIT,
  makeTestConfig,
} from "../helpers/test-fixtures.js";

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(target) : Promise.resolve([target]);
    }),
  );
  return nested.flat();
}

class CountingSigner implements CertificationSigner {
  public calls = 0;

  public constructor(private readonly delegate: AttestationSigner) {}

  public sign(payload: CertificationPayload): Promise<SignedAttestationProof> {
    this.calls += 1;
    return this.delegate.sign(payload);
  }
}

describe("issuance fail-closed boundaries", () => {
  it.each(["ERROR", "NOT_RUN", "NOT_APPLICABLE", "UNKNOWN"] satisfies CriterionResultStatus[])(
    "does not call the signer for %s",
    async (status) => {
      const config = await makeTestConfig();
      const repository = new InMemoryCertificationRepository();
      const provider = new FixtureSourceProvider();
      const policyService = new PolicyService(repository);
      const draft = await policyService.createDraft({
        name: "차단 정책",
        administratorId: "admin",
      });
      const active = await policyService.publish(draft.snapshot.policyId, "admin");
      const baseline = await new StaticAnalysisService(provider).analyze(
        provider.collection.repository.canonicalRepositoryUrl,
        TEST_COMMIT,
        active.snapshot,
      );
      const changed: AnalysisOutcome = {
        ...baseline,
        decision: "FAIL",
        report: {
          ...baseline.report,
          criteriaResults: baseline.report.criteriaResults.map((result) => ({ ...result, result: status })),
        },
      };
      const analyzer: CertificationAnalyzer = {
        resolveRepository: () => Promise.resolve(provider.collection.repository),
        analyze: () => Promise.resolve(changed),
      };
      const signer = new CountingSigner(new AttestationSigner(config));
      const result = await new BadgeIssueService(repository, analyzer, signer).issue(
        provider.collection.repository.canonicalRepositoryUrl,
        TEST_COMMIT,
      );
      expect(result.outcome).toBe("NOT_ISSUED");
      expect(signer.calls).toBe(0);
      expect(repository.badges.size).toBe(0);
    },
  );

  it("does not call the signer when a required result is missing", async () => {
    const config = await makeTestConfig();
    const repository = new InMemoryCertificationRepository();
    const provider = new FixtureSourceProvider();
    const policyService = new PolicyService(repository);
    const draft = await policyService.createDraft({
      name: "누락 차단 정책",
      administratorId: "admin",
    });
    const active = await policyService.publish(draft.snapshot.policyId, "admin");
    const baseline = await new StaticAnalysisService(provider).analyze(
      provider.collection.repository.canonicalRepositoryUrl,
      TEST_COMMIT,
      active.snapshot,
    );
    const analyzer: CertificationAnalyzer = {
      resolveRepository: () => Promise.resolve(provider.collection.repository),
      analyze: () =>
        Promise.resolve({
          ...baseline,
          decision: "FAIL",
          report: { ...baseline.report, criteriaResults: [] },
        }),
    };
    const signer = new CountingSigner(new AttestationSigner(config));
    expect(
      (await new BadgeIssueService(repository, analyzer, signer).issue(
        provider.collection.repository.canonicalRepositoryUrl,
        TEST_COMMIT,
      )).outcome,
    ).toBe("NOT_ISSUED");
    expect(signer.calls).toBe(0);
  });

  it("does not call the signer when exact commit collection fails", async () => {
    const config = await makeTestConfig();
    const repository = new InMemoryCertificationRepository();
    const provider = new FixtureSourceProvider();
    const policyService = new PolicyService(repository);
    const draft = await policyService.createDraft({
      name: "수집 실패 정책",
      administratorId: "admin",
    });
    await policyService.publish(draft.snapshot.policyId, "admin");
    provider.collect = () => Promise.reject(new Error("exact commit unavailable"));
    const signer = new CountingSigner(new AttestationSigner(config));
    await expect(
      new BadgeIssueService(repository, new StaticAnalysisService(provider), signer).issue(
        provider.collection.repository.canonicalRepositoryUrl,
        TEST_COMMIT,
      ),
    ).rejects.toThrow(/exact commit unavailable/);
    expect(signer.calls).toBe(0);
  });
});

describe("server-only and static-only boundaries", () => {
  it("contains no repository code execution or package-manager invocation path", async () => {
    const files = [
      ...await filesBelow(path.resolve("src/github")),
      ...await filesBelow(path.resolve("src/analysis")),
    ];
    const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
    expect(source).not.toMatch(/from\s+["'](?:node:)?child_process["']/);
    expect(source).not.toMatch(/\b(?:spawn|execFile|fork)\s*\(/);
    expect(source).not.toMatch(/\b(?:npm|pnpm|yarn|bun|pip|mvn|gradle)\s+(?:install|build|test|run)\b/);
  });

  it("does not expose server environment names or key material in public assets", async () => {
    const files = await filesBelow(path.resolve("public"));
    const publicBundle = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
    expect(publicBundle).not.toMatch(/EAS_ATTESTER_PRIVATE_KEY|ADMIN_SESSION_SECRET|GITHUB_TOKEN/);
    expect(publicBundle).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });

  it("contains no RPC configuration or transaction client dependency", async () => {
    const packageJson = await readFile(path.resolve("package.json"), "utf8");
    const sourceFiles = await filesBelow(path.resolve("src"));
    const serverSource = (await Promise.all(sourceFiles.map((file) => readFile(file, "utf8")))).join("\n");
    expect(packageJson).not.toMatch(/ethereum-attestation-service|viem|web3/);
    expect(serverSource).not.toMatch(/EAS_RPC_URL|JsonRpcProvider|BrowserProvider/);
  });
});
