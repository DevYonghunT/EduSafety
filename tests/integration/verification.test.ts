import { AttestationSigner } from "../../src/certification/attestation.js";
import { BadgeIssueService } from "../../src/certification/issue-service.js";
import { PolicyService } from "../../src/certification/policy-service.js";
import { BadgeVerificationService } from "../../src/certification/verification-service.js";
import { StaticAnalysisService } from "../../src/analysis/service.js";
import type { StoredBadge } from "../../src/db/repository.js";
import {
  FixtureSourceProvider,
  InMemoryCertificationRepository,
  TEST_COMMIT,
  makeTestConfig,
} from "../helpers/test-fixtures.js";

async function issuedFixture(expirationDays = 365) {
  const baseConfig = await makeTestConfig();
  const config = { ...baseConfig, expirationDays };
  const repository = new InMemoryCertificationRepository();
  const sourceProvider = new FixtureSourceProvider();
  const nowValue = new Date("2026-08-28T00:00:00.000Z");
  const now = () => nowValue;
  const policyService = new PolicyService(repository, now);
  const draft = await policyService.createDraft({
    name: "검증 정책",
    administratorId: "admin",
  });
  await policyService.publish(draft.snapshot.policyId, "admin");
  const issueService = new BadgeIssueService(
    repository,
    new StaticAnalysisService(sourceProvider, now),
    new AttestationSigner(config, { now }),
  );
  const issued = await issueService.issue(
    sourceProvider.collection.repository.canonicalRepositoryUrl,
    TEST_COMMIT,
  );
  if (issued.outcome !== "ISSUED") throw new Error("Fixture issuance failed");
  return { config, repository, sourceProvider, nowValue, badge: issued.badge };
}

describe("stored proof verification", () => {
  it("accepts an intact proof", async () => {
    const fixture = await issuedFixture();
    const result = await new BadgeVerificationService(
      fixture.repository,
      fixture.sourceProvider,
      fixture.config,
      () => fixture.nowValue,
    ).verify(fixture.badge);
    expect(result.status).toBe("VALID");
    expect(result.integrityValid).toBe(true);
  });

  const changes: Array<[string, (badge: StoredBadge) => void]> = [
    ["payload kind", (badge) => { (badge.proof.payload as { kind: string }).kind = "changed"; }],
    ["payload version", (badge) => { (badge.proof.payload as { payloadVersion: string }).payloadVersion = "2"; }],
    ["payload subject", (badge) => { (badge.proof.payload as { subjectKey: string }).subjectKey = "changed"; }],
    ["repository ID", (badge) => { (badge.proof.payload as { repositoryId: number }).repositoryId += 1; }],
    ["repository URL", (badge) => { (badge.proof.payload as { canonicalRepositoryUrl: string }).canonicalRepositoryUrl = "https://github.com/changed/repo"; }],
    ["commit", (badge) => { (badge.proof.payload as { commitSha: string }).commitSha = "f".repeat(40); }],
    ["payload report hash", (badge) => { (badge.proof.payload as { reportHash: string }).reportHash = `0x${"ab".repeat(32)}`; }],
    ["decision", (badge) => { (badge.proof.payload as { decision: string }).decision = "FAIL"; }],
    ["policy ID", (badge) => { (badge.proof.payload as { certificationPolicyId: string }).certificationPolicyId = "changed"; }],
    ["policy hash", (badge) => { (badge.proof.payload as { policyHash: string }).policyHash = `0x${"aa".repeat(32)}`; }],
    ["policy version", (badge) => { (badge.proof.payload as { policyVersion: number }).policyVersion += 1; }],
    ["criteria hash", (badge) => { (badge.proof.payload as { criteriaHash: string }).criteriaHash = `0x${"bb".repeat(32)}`; }],
    ["criterion ID", (badge) => { (badge.proof.payload.criteria[0] as { criterionId: string }).criterionId = "changed"; }],
    ["criterion version", (badge) => { (badge.proof.payload.criteria[0] as { criterionVersion: string }).criterionVersion = "9"; }],
    ["criterion result", (badge) => { (badge.proof.payload.criteria[0] as { result: string }).result = "FAIL"; }],
    ["ruleset", (badge) => { (badge.proof.payload as { rulesetVersion: string }).rulesetVersion = "changed"; }],
    ["stored report hash", (badge) => { (badge as { reportHash: string }).reportHash = `0x${"cc".repeat(32)}`; }],
    ["stored criteria hash", (badge) => { (badge as { criteriaHash: string }).criteriaHash = `0x${"dd".repeat(32)}`; }],
    ["policy snapshot", (badge) => { (badge.report.policy as { policyVersion: number }).policyVersion += 1; }],
    ["policy table snapshot", (badge) => { (badge.policySnapshot as { policyVersion: number }).policyVersion += 1; }],
    ["criterion snapshot", (badge) => { (badge.report.criteriaResults[0] as { result: string }).result = "FAIL"; }],
    ["domain", (badge) => { (badge.proof.domain as { chainId: string }).chainId = "1"; }],
    ["domain name", (badge) => { (badge.proof.domain as { name: string }).name = "Changed"; }],
    ["domain version", (badge) => { (badge.proof.domain as { version: string }).version = "1.1.0"; }],
    ["verifying contract", (badge) => { (badge.proof.domain as { verifyingContract: string }).verifyingContract = "0x0000000000000000000000000000000000000001"; }],
    ["primary type", (badge) => { (badge.proof as { primaryType: string }).primaryType = "Changed"; }],
    ["types", (badge) => { (badge.proof as { types: unknown }).types = { Attest: [] }; }],
    ["schema", (badge) => { (badge.proof.message as { schema: string }).schema = `0x${"ee".repeat(32)}`; }],
    ["recipient", (badge) => { (badge.proof.message as { recipient: string }).recipient = "0x0000000000000000000000000000000000000001"; }],
    ["offchain version", (badge) => { (badge.proof.message as { version: number }).version = 1; }],
    ["message time", (badge) => { (badge.proof.message as { time: string }).time = "1"; }],
    ["message expiration time", (badge) => { (badge.proof.message as { expirationTime: string }).expirationTime = "1"; }],
    ["message revocable", (badge) => { (badge.proof.message as { revocable: boolean }).revocable = false; }],
    ["reference UID", (badge) => { (badge.proof.message as { refUID: string }).refUID = `0x${"ef".repeat(32)}`; }],
    ["message data", (badge) => { (badge.proof.message as { data: string }).data = "0x00"; }],
    ["salt", (badge) => { (badge.proof.message as { salt: string }).salt = `0x${"01".repeat(31)}`; }],
    ["extra message key", (badge) => { (badge.proof.message as unknown as Record<string, unknown>).unexpected = true; }],
    ["UID", (badge) => { (badge.proof as { uid: string }).uid = `0x${"12".repeat(32)}`; }],
    ["signature", (badge) => { (badge.proof as { signature: string }).signature = `${badge.proof.signature.slice(0, -2)}00`; }],
    ["attester", (badge) => { (badge.proof as { attester: string }).attester = "0x0000000000000000000000000000000000000001"; }],
    ["typed data snapshot", (badge) => { (badge as { typedDataSnapshot: unknown }).typedDataSnapshot = { changed: true }; }],
  ];

  it.each(changes)("returns INVALID when %s is changed", async (_name, mutate) => {
    const fixture = await issuedFixture();
    const badge = structuredClone(fixture.badge);
    mutate(badge);
    const result = await new BadgeVerificationService(
      fixture.repository,
      fixture.sourceProvider,
      fixture.config,
      () => fixture.nowValue,
    ).verify(badge);
    expect(result.status).toBe("INVALID");
  });

  it("applies REVOKED before expiration and HEAD state", async () => {
    const fixture = await issuedFixture();
    const revokedAt = "2026-08-29T00:00:00.000Z";
    const revoked = await fixture.repository.revokeBadge({
      uid: fixture.badge.proof.uid,
      administratorId: "admin",
      reason: "POLICY_REPLACED",
      revokedAt,
    });
    fixture.sourceProvider.head = null;
    const result = await new BadgeVerificationService(
      fixture.repository,
      fixture.sourceProvider,
      fixture.config,
      () => new Date("2030-01-01T00:00:00.000Z"),
    ).verify(revoked!.badge);
    expect(result.status).toBe("REVOKED");
    expect(fixture.repository.audits.at(-1)?.action).toBe("BADGE_REVOKED");
  });

  it("applies INVALID before a stored revocation", async () => {
    const fixture = await issuedFixture();
    const revoked = await fixture.repository.revokeBadge({
      uid: fixture.badge.proof.uid,
      administratorId: "admin",
      reason: "POLICY_REPLACED",
      revokedAt: "2026-08-29T00:00:00.000Z",
    });
    const tampered = structuredClone(revoked!.badge);
    (tampered.proof as { uid: string }).uid = `0x${"99".repeat(32)}`;
    const result = await new BadgeVerificationService(
      fixture.repository,
      fixture.sourceProvider,
      fixture.config,
      () => fixture.nowValue,
    ).verify(tampered);
    expect(result.status).toBe("INVALID");
  });

  it("rejects an otherwise valid signer that is absent from the trust list", async () => {
    const fixture = await issuedFixture();
    const untrustedConfig = {
      eas: { ...fixture.config.eas, trustedAttesterAddresses: new Set<string>() },
    };
    const result = await new BadgeVerificationService(
      fixture.repository,
      fixture.sourceProvider,
      untrustedConfig,
      () => fixture.nowValue,
    ).verify(fixture.badge);
    expect(result.status).toBe("INVALID");
  });

  it("returns EXPIRED, STALE and UNVERIFIED distinctly", async () => {
    const expiredFixture = await issuedFixture(1);
    const expired = await new BadgeVerificationService(
      expiredFixture.repository,
      expiredFixture.sourceProvider,
      expiredFixture.config,
      () => new Date("2026-08-30T00:00:00.000Z"),
    ).verify(expiredFixture.badge);
    expect(expired.status).toBe("EXPIRED");

    const staleFixture = await issuedFixture();
    staleFixture.sourceProvider.head = "f".repeat(40);
    const stale = await new BadgeVerificationService(
      staleFixture.repository,
      staleFixture.sourceProvider,
      staleFixture.config,
      () => staleFixture.nowValue,
    ).verify(staleFixture.badge);
    expect(stale.status).toBe("STALE");
    expect(stale.integrityValid).toBe(true);

    staleFixture.sourceProvider.head = null;
    const unverified = await new BadgeVerificationService(
      staleFixture.repository,
      staleFixture.sourceProvider,
      staleFixture.config,
      () => staleFixture.nowValue,
    ).verify(staleFixture.badge);
    expect(unverified.status).toBe("UNVERIFIED");
  });

  it("verifies an old badge after its policy is archived", async () => {
    const fixture = await issuedFixture();
    const service = new PolicyService(fixture.repository);
    const replacement = await service.createDraft({
      name: "새 정책",
      administratorId: "admin",
    });
    await service.publish(replacement.snapshot.policyId, "admin");
    const result = await new BadgeVerificationService(
      fixture.repository,
      fixture.sourceProvider,
      fixture.config,
      () => fixture.nowValue,
    ).verify(fixture.badge);
    expect(result.status).toBe("VALID");
  });

  it("does not verify a UID absent from the database", async () => {
    const fixture = await issuedFixture();
    const service = new BadgeVerificationService(
      fixture.repository,
      fixture.sourceProvider,
      fixture.config,
      () => fixture.nowValue,
    );
    expect(await service.getAndVerify(`0x${"00".repeat(32)}`)).toBeNull();
  });
});
