import { readFile } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { StaticAnalysisService } from "../../src/analysis/service.js";
import * as attestation from "../../src/certification/attestation.js";
import { BadgeIssueService, type CertificationSigner } from "../../src/certification/issue-service.js";
import { PolicyService } from "../../src/certification/policy-service.js";
import type { AppConfig } from "../../src/config.js";
import type { CertificationRepository } from "../../src/db/repository.js";
import type { CertificationPayload } from "../../src/domain/types.js";
import type { RepositorySourceProvider } from "../../src/github/client.js";
import {
  FixtureSourceProvider,
  InMemoryCertificationRepository,
  TEST_COMMIT,
  makeTestConfig,
} from "../helpers/test-fixtures.js";

class CountingSigner implements CertificationSigner {
  public calls = 0;

  public constructor(private readonly signer: attestation.AttestationSigner) {}

  public sign(payload: CertificationPayload): Promise<attestation.SignedAttestationProof> {
    this.calls += 1;
    return this.signer.sign(payload);
  }
}

async function activeFixture() {
  const config = await makeTestConfig();
  const repository = new InMemoryCertificationRepository();
  const sourceProvider = new FixtureSourceProvider();
  const policyService = new PolicyService(repository);
  const draft = await policyService.createDraft({
    name: "동시성 정책",
    administratorId: "admin",
  });
  await policyService.publish(draft.snapshot.policyId, "admin");
  const signer = new CountingSigner(new attestation.AttestationSigner(config));
  const service = new BadgeIssueService(repository, new StaticAnalysisService(sourceProvider), signer);
  return { config, repository, sourceProvider, policyService, signer, service };
}

describe("issuance concurrency", () => {
  it("returns one database row and one UID for 20 simultaneous requests", async () => {
    const fixture = await activeFixture();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        fixture.service.issue(fixture.sourceProvider.collection.repository.canonicalRepositoryUrl, TEST_COMMIT),
      ),
    );
    expect(results.every((result) => result.outcome === "ISSUED")).toBe(true);
    const uids = new Set(
      results.map((result) => (result.outcome === "ISSUED" ? result.badge.proof.uid : "not-issued")),
    );
    expect(uids.size).toBe(1);
    expect(fixture.repository.badges.size).toBe(1);
    expect(fixture.repository.analyses).toHaveLength(1);
    expect(fixture.sourceProvider.collectCalls).toBe(1);
    expect(fixture.signer.calls).toBe(1);
  });

  it("allows the same commit to be certified under a new policy hash", async () => {
    const fixture = await activeFixture();
    const first = await fixture.service.issue(
      fixture.sourceProvider.collection.repository.canonicalRepositoryUrl,
      TEST_COMMIT,
    );
    const replacement = await fixture.policyService.createDraft({
      name: "새 정책",
      administratorId: "admin",
    });
    await fixture.policyService.publish(replacement.snapshot.policyId, "admin");
    const second = await fixture.service.issue(
      fixture.sourceProvider.collection.repository.canonicalRepositoryUrl,
      TEST_COMMIT,
    );
    expect(first.outcome).toBe("ISSUED");
    expect(second.outcome).toBe("ISSUED");
    if (first.outcome === "ISSUED" && second.outcome === "ISSUED") {
      expect(second.badge.proof.uid).not.toBe(first.badge.proof.uid);
    }
    expect(fixture.repository.badges.size).toBe(2);
  });
});

describe("DEMO_PASS", () => {
  it("is a static page with no script, UID or real verification link", async () => {
    const html = await readFile(path.resolve("public/demo.html"), "utf8");
    expect(html).toContain("DEMO_PASS");
    expect(html).toContain("DEMO · 실제 인증 아님");
    expect(html).toContain("EAS SIGNED");
    expect(html).toContain("GASLESS");
    expect(html).not.toMatch(/<script|\/api\/badges\/|0x[0-9a-f]{64}/i);
  });

  it("performs zero database, source, signing, private-key, UID and external fetch operations", async () => {
    const failIfCalled = (operation: string) => vi.fn((..._arguments: unknown[]) => {
      throw new Error(`DEMO_PASS must not call ${operation}`);
    });
    const databaseOperations = {
      listCriteria: failIfCalled("repository.listCriteria"),
      getCriteria: failIfCalled("repository.getCriteria"),
      nextPolicyVersion: failIfCalled("repository.nextPolicyVersion"),
      listPolicies: failIfCalled("repository.listPolicies"),
      getPolicy: failIfCalled("repository.getPolicy"),
      getActivePolicy: failIfCalled("repository.getActivePolicy"),
      createDraftPolicy: failIfCalled("repository.createDraftPolicy"),
      updateDraftPolicy: failIfCalled("repository.updateDraftPolicy"),
      publishPolicy: failIfCalled("repository.publishPolicy"),
      saveRejectedAnalysis: failIfCalled("repository.saveRejectedAnalysis"),
      saveIssuedBadge: failIfCalled("repository.saveIssuedBadge"),
      getBadgeBySubject: failIfCalled("repository.getBadgeBySubject"),
      getBadge: failIfCalled("repository.getBadge"),
      listBadges: failIfCalled("repository.listBadges"),
      revokeBadge: failIfCalled("repository.revokeBadge"),
    } satisfies CertificationRepository;
    const sourceOperations = {
      resolveRepository: failIfCalled("sourceProvider.resolveRepository"),
      collect: failIfCalled("sourceProvider.collect"),
      getDefaultBranchHead: failIfCalled("sourceProvider.getDefaultBranchHead"),
    } satisfies RepositorySourceProvider;
    const signer = {
      sign: failIfCalled("signer.sign"),
    } satisfies CertificationSigner;
    const baseConfig = await makeTestConfig();
    let privateKeyReads = 0;
    const easConfig: AppConfig["eas"] = {
      chainId: baseConfig.eas.chainId,
      schemaUid: baseConfig.eas.schemaUid,
      attesterAddress: baseConfig.eas.attesterAddress,
      get attesterPrivateKey(): `0x${string}` {
        privateKeyReads += 1;
        throw new Error("DEMO_PASS must not read the attester private key");
      },
      trustedAttesterAddresses: baseConfig.eas.trustedAttesterAddresses,
    };
    const config: AppConfig = { ...baseConfig, eas: easConfig };
    const externalFetch = failIfCalled("global fetch");
    const uidCalculation = vi.spyOn(attestation, "calculateOffchainV2Uid");
    vi.stubGlobal("fetch", externalFetch);

    try {
      const app = createApp({
        config,
        repository: databaseOperations,
        sourceProvider: sourceOperations,
        signer,
      });
      const response = await request(app).get("/demo").expect(200);
      expect(response.text).toContain("DEMO · 실제 인증 아님");
      for (const operation of Object.values(databaseOperations)) {
        expect(operation).not.toHaveBeenCalled();
      }
      for (const operation of Object.values(sourceOperations)) {
        expect(operation).not.toHaveBeenCalled();
      }
      expect(signer.sign).not.toHaveBeenCalled();
      expect(privateKeyReads).toBe(0);
      expect(uidCalculation).not.toHaveBeenCalled();
      expect(externalFetch).not.toHaveBeenCalled();
    } finally {
      uidCalculation.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
