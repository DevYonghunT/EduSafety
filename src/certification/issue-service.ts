import { randomUUID } from "node:crypto";
import { canonicalHash } from "../lib/canonical-json.js";
import { calculateCriteriaHash, signedCriteriaFromResults } from "./policy.js";
import {
  assertRequiredPolicySnapshot,
  PolicyValidationError,
  resolveRequiredCriteria,
} from "./policy-service.js";
import type { AnalysisOutcome } from "../analysis/service.js";
import type { SignedAttestationProof } from "./attestation.js";
import type { CertificationPayload, CertificationPolicySnapshot, RepositorySnapshot } from "../domain/types.js";
import type { CertificationRepository, StoredBadge } from "../db/repository.js";

export class NoActivePolicyError extends Error {
  public constructor() {
    super("활성 인증 정책이 없습니다.");
    this.name = "NoActivePolicyError";
  }
}

export class ActivePolicyIncompatibleError extends Error {
  public constructor() {
    super("활성 인증 정책이 현재 서버의 고정 필수 심사 항목과 일치하지 않습니다.");
    this.name = "ActivePolicyIncompatibleError";
  }
}

export type IssueResult =
  | {
      readonly outcome: "ISSUED";
      readonly existing: boolean;
      readonly badge: StoredBadge;
    }
  | {
      readonly outcome: "NOT_ISSUED";
      readonly reportHash: `0x${string}`;
      readonly analysisId: string;
      readonly report: AnalysisOutcome["report"];
    };

export interface CertificationSigner {
  sign(payload: CertificationPayload): Promise<SignedAttestationProof>;
}

export interface CertificationAnalyzer {
  resolveRepository(repositoryUrl: string): Promise<RepositorySnapshot>;
  analyze(
    repositoryUrl: string,
    commitSha: string,
    pinnedPolicy: CertificationPolicySnapshot,
  ): Promise<AnalysisOutcome>;
}

function normalizedRepositoryRequestKey(repositoryUrl: string): string {
  try {
    const parsed = new URL(repositoryUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const owner = segments[0]?.toLowerCase() ?? "";
    const repository = (segments[1] ?? "").replace(/\.git$/i, "").toLowerCase();
    return `${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}/${owner}/${repository}`;
  } catch {
    return repositoryUrl;
  }
}

export class BadgeIssueService {
  readonly #inFlight = new Map<string, Promise<IssueResult>>();

  public constructor(
    private readonly repository: CertificationRepository,
    private readonly analysisService: CertificationAnalyzer,
    private readonly signer: CertificationSigner,
  ) {}

  public async issue(repositoryUrl: string, commitSha: string): Promise<IssueResult> {
    const active = await this.repository.getActivePolicy();
    if (!active) throw new NoActivePolicyError();
    try {
      const requiredCriteria = await resolveRequiredCriteria(this.repository);
      assertRequiredPolicySnapshot(active.snapshot, requiredCriteria);
    } catch (error) {
      if (error instanceof PolicyValidationError) throw new ActivePolicyIncompatibleError();
      throw error;
    }
    const pinnedPolicy = active.snapshot;
    const key = `${normalizedRepositoryRequestKey(repositoryUrl)}\0${commitSha.toLowerCase()}\0${pinnedPolicy.policyHash}`;
    const existingPromise = this.#inFlight.get(key);
    if (existingPromise) return existingPromise;

    const promise = this.#issueWithPinnedPolicy(repositoryUrl, commitSha, pinnedPolicy).finally(() => {
      this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, promise);
    return promise;
  }

  async #issueWithPinnedPolicy(
    repositoryUrl: string,
    commitSha: string,
    pinnedPolicy: CertificationPolicySnapshot,
  ): Promise<IssueResult> {
    const repositorySnapshot = await this.analysisService.resolveRepository(repositoryUrl);
    const existing = await this.repository.getBadgeBySubject(
      repositorySnapshot.repositoryId,
      commitSha.toLowerCase(),
      pinnedPolicy.policyHash,
      pinnedPolicy.rulesetVersion,
    );
    if (existing) return { outcome: "ISSUED", existing: true, badge: existing };

    const analysis = await this.analysisService.analyze(repositoryUrl, commitSha, pinnedPolicy);
    const analysisId = randomUUID();
    if (analysis.decision !== "PASS") {
      await this.repository.saveRejectedAnalysis({
        analysisId,
        decision: "FAIL",
        reportHash: analysis.reportHash,
        report: analysis.report,
      });
      return {
        outcome: "NOT_ISSUED",
        reportHash: analysis.reportHash,
        analysisId,
        report: analysis.report,
      };
    }

    if (
      analysis.report.criteriaResults.length !== pinnedPolicy.criteria.length ||
      !analysis.report.criteriaResults.every((result) => result.result === "PASS") ||
      analysis.report.safetyBlockers.some((blocker) => blocker.triggered) ||
      canonicalHash(analysis.report) !== analysis.reportHash
    ) {
      throw new Error("Analysis result failed the pre-signing integrity gate");
    }
    const criteria = signedCriteriaFromResults(analysis.report.criteriaResults);
    const criteriaHash = calculateCriteriaHash(criteria);
    const payload: CertificationPayload = {
      kind: "EduSafetyCertification",
      payloadVersion: "1",
      subjectKey: `github:${analysis.report.repository.repositoryId}:${analysis.report.commitSha}`,
      repositoryId: analysis.report.repository.repositoryId,
      canonicalRepositoryUrl: analysis.report.repository.canonicalRepositoryUrl,
      commitSha: analysis.report.commitSha,
      reportHash: analysis.reportHash,
      decision: "PASS",
      certificationPolicyId: pinnedPolicy.policyId,
      policyHash: pinnedPolicy.policyHash,
      policyVersion: pinnedPolicy.policyVersion,
      criteriaHash,
      criteria,
      rulesetVersion: pinnedPolicy.rulesetVersion,
    };
    const proof = await this.signer.sign(payload);
    const saved = await this.repository.saveIssuedBadge({
      analysisId,
      decision: "PASS",
      reportHash: analysis.reportHash,
      report: analysis.report,
      criteriaHash,
      payload,
      proof,
    });
    return { outcome: "ISSUED", existing: !saved.created, badge: saved.badge };
  }
}
