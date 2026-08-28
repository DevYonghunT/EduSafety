import type { CriterionDefinition } from "../domain/types.js";
import {
  RepositoryUnavailableError,
  type AnalysisRecordInput,
  type CertificationRepository,
  type IssuedBadgeInput,
  type PolicyRecord,
  type RevokeBadgeInput,
  type StoredBadge,
} from "./repository.js";

function unavailable<T>(): Promise<T> {
  return Promise.reject(new RepositoryUnavailableError(
    "Certification operations are unavailable in standalone mode",
  ));
}

export class UnavailableCertificationRepository implements CertificationRepository {
  public listCriteria(): Promise<readonly CriterionDefinition[]> {
    return Promise.resolve([]);
  }

  public getCriteria(_criterionIds: readonly string[]): Promise<readonly CriterionDefinition[]> {
    return Promise.resolve([]);
  }

  public nextPolicyVersion(): Promise<number> {
    return unavailable();
  }

  public listPolicies(): Promise<readonly PolicyRecord[]> {
    return Promise.resolve([]);
  }

  public getPolicy(_policyId: string): Promise<PolicyRecord | null> {
    return Promise.resolve(null);
  }

  public getActivePolicy(): Promise<PolicyRecord | null> {
    return Promise.resolve(null);
  }

  public createDraftPolicy(_record: PolicyRecord): Promise<PolicyRecord> {
    return unavailable();
  }

  public updateDraftPolicy(_record: PolicyRecord, _administratorId: string): Promise<PolicyRecord> {
    return unavailable();
  }

  public publishPolicy(
    _policyId: string,
    _administratorId: string,
    _publishedAt: string,
  ): Promise<PolicyRecord> {
    return unavailable();
  }

  public saveRejectedAnalysis(_input: AnalysisRecordInput): Promise<void> {
    return unavailable();
  }

  public saveIssuedBadge(_input: IssuedBadgeInput): Promise<{ badge: StoredBadge; created: boolean }> {
    return unavailable();
  }

  public getBadgeBySubject(
    _repositoryId: number,
    _commitSha: string,
    _policyHash: string,
    _rulesetVersion: string,
  ): Promise<StoredBadge | null> {
    return Promise.resolve(null);
  }

  public getBadge(_uid: string): Promise<StoredBadge | null> {
    return Promise.resolve(null);
  }

  public listBadges(_limit: number): Promise<readonly StoredBadge[]> {
    return Promise.resolve([]);
  }

  public revokeBadge(_input: RevokeBadgeInput): Promise<{ badge: StoredBadge; created: boolean } | null> {
    return unavailable();
  }
}
