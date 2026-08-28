import { Wallet, getAddress } from "ethers";
import {
  AttestationSigner,
  calculateOffchainV2Uid,
  encodeCanonicalStatement,
  verifyAttestationSignature,
  type SerializedEasMessage,
  type SignedAttestationProof,
} from "../../src/certification/attestation.js";
import { ZERO_ADDRESS, ZERO_BYTES32, loadConfig } from "../../src/config.js";
import { canonicalJson } from "../../src/lib/canonical-json.js";
import type { CertificationPayload } from "../../src/domain/types.js";
import { makeTestConfig } from "../helpers/test-fixtures.js";

function samplePayload(): CertificationPayload {
  return {
    kind: "EduSafetyCertification",
    payloadVersion: "1",
    subjectKey: "github:123:0123456789abcdef0123456789abcdef01234567",
    repositoryId: 123,
    canonicalRepositoryUrl: "https://github.com/example/repository",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    reportHash: `0x${"11".repeat(32)}`,
    decision: "PASS",
    certificationPolicyId: "9d2c6fb8-a53e-4f2c-87f2-f21d2887a73f",
    policyHash: `0x${"22".repeat(32)}`,
    policyVersion: 1,
    criteriaHash: `0x${"33".repeat(32)}`,
    criteria: [{ criterionId: "safe", criterionVersion: "1.0.0", result: "PASS" }],
    rulesetVersion: "2026.08.1",
  };
}

describe("EAS Offchain v2 attestation", () => {
  it("matches the official v2 UID packing rule for a fixed project vector", () => {
    const payload = {
      canonicalRepositoryUrl: "https://github.com/example/edu-safety",
      certificationPolicyId: "policy-1",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      criteria: [{ criterionId: "no-secret", criterionVersion: "1.0.0", result: "PASS" }],
      criteriaHash: `0x${"11".repeat(32)}`,
      decision: "PASS",
      kind: "EAS_OFFCHAIN_V2_GASLESS_CERTIFICATION_BADGE",
      payloadVersion: 1,
      policyHash: `0x${"22".repeat(32)}`,
      policyVersion: 1,
      reportHash: `0x${"33".repeat(32)}`,
      repositoryId: 123456789,
      rulesetVersion: "1.0.0",
      subjectKey: "github:123456789:0123456789abcdef0123456789abcdef01234567",
    };
    const message: SerializedEasMessage = {
      version: 2,
      schema: "0xf58b8b212ef75ee8cd7e8d803c37c03e0519890502d5e99ee2412aae1456cafe",
      recipient: ZERO_ADDRESS,
      time: "1724803200",
      expirationTime: "0",
      revocable: true,
      refUID: ZERO_BYTES32,
      data: encodeCanonicalStatement(canonicalJson(payload)),
      salt: `0x${"00".repeat(31)}01`,
    };
    expect(calculateOffchainV2Uid(message)).toBe(
      "0xf7a3027dee9428fb776f37d473a725d6dcb19957085dbee121ab583cf4c501ef",
    );
  });

  it("signs and verifies locally without a provider", async () => {
    const config = await makeTestConfig();
    const signer = new AttestationSigner(config, {
      now: () => new Date("2026-08-28T00:00:00.000Z"),
      randomSalt: () => Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    });
    const proof = await signer.sign(samplePayload());
    expect(proof.attester).toBe(config.eas.attesterAddress);
    expect(proof.message.data).toBe(encodeCanonicalStatement(proof.canonicalPayload));
    expect(verifyAttestationSignature(proof, config, proof.canonicalPayload)).toEqual({
      valid: true,
      recoveredAttester: config.eas.attesterAddress,
    });
  });

  it.each([
    ["domain", (proof: Awaited<ReturnType<AttestationSigner["sign"]>>) => ({ ...proof, domain: { ...proof.domain, version: "1.1.0" } })],
    ["schema", (proof: Awaited<ReturnType<AttestationSigner["sign"]>>) => ({ ...proof, message: { ...proof.message, schema: `0x${"44".repeat(32)}` as `0x${string}` } })],
    ["UID", (proof: Awaited<ReturnType<AttestationSigner["sign"]>>) => ({ ...proof, uid: `0x${"55".repeat(32)}` as `0x${string}` })],
    ["signature", (proof: Awaited<ReturnType<AttestationSigner["sign"]>>) => ({ ...proof, signature: `${proof.signature.slice(0, -2)}00` as `0x${string}` })],
    ["attester", (proof: Awaited<ReturnType<AttestationSigner["sign"]>>) => ({ ...proof, attester: Wallet.createRandom().address })],
  ])("rejects a changed %s", async (_label, mutate) => {
    const config = await makeTestConfig();
    const signer = new AttestationSigner(config);
    const proof = await signer.sign(samplePayload());
    expect(
      verifyAttestationSignature(
        mutate(proof) as unknown as SignedAttestationProof,
        config,
        proof.canonicalPayload,
      ).valid,
    ).toBe(false);
  });

  it("fails startup configuration when the key and attester differ", () => {
    const wallet = Wallet.createRandom();
    const other = Wallet.createRandom();
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://test.invalid/db",
        EAS_CHAIN_ID: "84532",
        EAS_SCHEMA_UID: "0xf58b8b212ef75ee8cd7e8d803c37c03e0519890502d5e99ee2412aae1456cafe",
        EAS_ATTESTER_ADDRESS: getAddress(other.address),
        EAS_ATTESTER_PRIVATE_KEY: wallet.privateKey,
        EAS_TRUSTED_ATTESTER_ADDRESSES: getAddress(other.address),
        BADGE_ALLOWED_ORIGINS: "https://allowed.example",
        ADMIN_ID: "test-admin",
        ADMIN_USERNAME: "admin@example.test",
        ADMIN_PASSWORD_SCRYPT: "scrypt$c2FsdA$Zml4ZWRoYXNo",
        ADMIN_SESSION_SECRET: "x".repeat(43),
      }),
    ).toThrow(/does not match/);
  });
});
