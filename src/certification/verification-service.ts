import type { AppConfig } from "../config.js";
import { canonicalHash, canonicalJson } from "../lib/canonical-json.js";
import type { RepositorySourceProvider } from "../github/client.js";
import type { CertificationRepository, StoredBadge } from "../db/repository.js";
import type { CertificationPayload, VerificationStatus } from "../domain/types.js";
import { verifyAttestationSignature } from "./attestation.js";
import { calculateCriteriaHash, calculatePolicyHash, signedCriteriaFromResults } from "./policy.js";

export interface VerificationResult {
  readonly status: VerificationStatus;
  readonly integrityValid: boolean;
  readonly currentHead: string | null;
  readonly headMatches: boolean | null;
  readonly badge: StoredBadge;
  readonly reason: string;
}

function rebuildPayload(badge: StoredBadge): CertificationPayload {
  const { report } = badge;
  const criteria = signedCriteriaFromResults(report.criteriaResults);
  return {
    kind: "EduSafetyCertification",
    payloadVersion: "1",
    subjectKey: `github:${report.repository.repositoryId}:${report.commitSha}`,
    repositoryId: report.repository.repositoryId,
    canonicalRepositoryUrl: report.repository.canonicalRepositoryUrl,
    commitSha: report.commitSha,
    reportHash: badge.reportHash,
    decision: "PASS",
    certificationPolicyId: report.policy.policyId,
    policyHash: report.policy.policyHash,
    policyVersion: report.policy.policyVersion,
    criteriaHash: badge.criteriaHash,
    criteria,
    rulesetVersion: report.policy.rulesetVersion,
  };
}

export class BadgeVerificationService {
  public constructor(
    private readonly repository: CertificationRepository,
    private readonly sourceProvider: RepositorySourceProvider,
    private readonly config: Pick<AppConfig, "eas">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async getAndVerify(uid: string): Promise<VerificationResult | null> {
    const badge = await this.repository.getBadge(uid);
    if (!badge) return null;
    return this.verify(badge);
  }

  public async verify(badge: StoredBadge): Promise<VerificationResult> {
    const invalid = (reason: string): VerificationResult => ({
      status: "INVALID",
      integrityValid: false,
      currentHead: null,
      headMatches: null,
      badge,
      reason,
    });
    try {
      if (
        canonicalHash(badge.report) !== badge.reportHash ||
        canonicalJson(badge.policySnapshot) !== canonicalJson(badge.report.policy) ||
        calculatePolicyHash({
          policyId: badge.policySnapshot.policyId,
          name: badge.policySnapshot.name,
          policyVersion: badge.policySnapshot.policyVersion,
          rulesetVersion: badge.policySnapshot.rulesetVersion,
          criteria: badge.policySnapshot.criteria,
          safetyBlockers: badge.policySnapshot.safetyBlockers,
        }) !== badge.policySnapshot.policyHash ||
        badge.report.criteriaResults.length !== badge.report.policy.criteria.length ||
        badge.report.criteriaResults.some((result) => result.result !== "PASS") ||
        badge.report.safetyBlockers.some((blocker) => blocker.triggered)
      ) {
        return invalid("검사 또는 정책 snapshot이 일치하지 않습니다.");
      }
      const signedCriteria = signedCriteriaFromResults(badge.report.criteriaResults);
      if (calculateCriteriaHash(signedCriteria) !== badge.criteriaHash) {
        return invalid("심사 항목 hash가 일치하지 않습니다.");
      }
      const rebuiltPayload = rebuildPayload(badge);
      const rebuiltCanonicalPayload = canonicalJson(rebuiltPayload);
      if (
        canonicalJson(badge.proof.payload) !== rebuiltCanonicalPayload ||
        badge.proof.canonicalPayload !== rebuiltCanonicalPayload ||
        badge.proof.payload.policyHash !== badge.report.policy.policyHash ||
        badge.proof.payload.reportHash !== badge.reportHash ||
        badge.proof.payload.criteriaHash !== badge.criteriaHash
      ) {
        return invalid("서명 statement와 DB snapshot이 일치하지 않습니다.");
      }
      const expectedTypedDataSnapshot = {
        domain: badge.proof.domain,
        types: badge.proof.types,
        primaryType: badge.proof.primaryType,
        message: badge.proof.message,
      };
      if (canonicalJson(badge.typedDataSnapshot) !== canonicalJson(expectedTypedDataSnapshot)) {
        return invalid("저장된 typed data snapshot이 일치하지 않습니다.");
      }
      const signature = verifyAttestationSignature(badge.proof, this.config, rebuiltCanonicalPayload);
      if (!signature.valid) return invalid(signature.reason);

      const issuedAtSeconds = Math.floor(new Date(badge.proof.issuedAt).getTime() / 1000);
      const expirationSeconds = BigInt(badge.proof.message.expirationTime);
      if (
        !Number.isFinite(issuedAtSeconds) ||
        String(issuedAtSeconds) !== badge.proof.message.time ||
        (expirationSeconds === 0n
          ? badge.proof.expiresAt !== null
          : badge.proof.expiresAt !== new Date(Number(expirationSeconds) * 1000).toISOString())
      ) {
        return invalid("발급 또는 만료 snapshot이 일치하지 않습니다.");
      }
    } catch {
      return invalid("인증 proof를 재구성할 수 없습니다.");
    }

    if (badge.revokedAt !== null) {
      return {
        status: "REVOKED",
        integrityValid: true,
        currentHead: null,
        headMatches: null,
        badge,
        reason: "운영 DB에서 취소된 인증입니다.",
      };
    }
    if (badge.proof.expiresAt !== null && this.now().getTime() >= new Date(badge.proof.expiresAt).getTime()) {
      return {
        status: "EXPIRED",
        integrityValid: true,
        currentHead: null,
        headMatches: null,
        badge,
        reason: "인증 유효기간이 지났습니다.",
      };
    }
    const currentHead = await this.sourceProvider.getDefaultBranchHead(badge.report.repository);
    if (currentHead === null) {
      return {
        status: "UNVERIFIED",
        integrityValid: true,
        currentHead: null,
        headMatches: null,
        badge,
        reason: "현재 저장소 HEAD를 일시적으로 확인할 수 없습니다.",
      };
    }
    if (currentHead !== badge.report.commitSha) {
      return {
        status: "STALE",
        integrityValid: true,
        currentHead,
        headMatches: false,
        badge,
        reason: "현재 저장소 HEAD가 인증받은 exact commit과 다릅니다.",
      };
    }
    return {
      status: "VALID",
      integrityValid: true,
      currentHead,
      headMatches: true,
      badge,
      reason: "서명과 저장된 검사 snapshot이 모두 일치합니다.",
    };
  }
}
