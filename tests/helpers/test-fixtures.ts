import { Wallet, getAddress } from "ethers";
import { createPasswordScrypt } from "../../src/auth/admin-auth.js";
import { CRITERIA_CATALOG } from "../../src/certification/catalog.js";
import type { AppConfig } from "../../src/config.js";
import type {
  AnalysisRecordInput,
  CertificationRepository,
  IssuedBadgeInput,
  PolicyRecord,
  RevokeBadgeInput,
  StoredBadge,
} from "../../src/db/repository.js";
import type { CriterionDefinition, RepositorySnapshot } from "../../src/domain/types.js";
import type {
  CollectedRepository,
  RepositorySourceProvider,
  SourceFile,
} from "../../src/github/client.js";

export async function makeTestConfig(overrides: Partial<AppConfig> = {}): Promise<AppConfig> {
  const wallet = Wallet.createRandom();
  const address = getAddress(wallet.address);
  return {
    nodeEnv: "test",
    port: 3000,
    databaseUrl: "postgresql://test.invalid/edusafety",
    eas: {
      chainId: 84_532,
      schemaUid: "0xf58b8b212ef75ee8cd7e8d803c37c03e0519890502d5e99ee2412aae1456cafe",
      attesterAddress: address,
      attesterPrivateKey: wallet.privateKey as `0x${string}`,
      trustedAttesterAddresses: new Set([address]),
    },
    allowedOrigins: new Set(["https://allowed.example"]),
    publicBaseUrl: "http://localhost:3000",
    expirationDays: 365,
    admin: {
      id: "test-administrator",
      username: "admin@example.test",
      passwordScrypt: await createPasswordScrypt("test administrator password"),
      sessionSecret: Wallet.createRandom().privateKey.slice(2),
    },
    ...overrides,
  };
}

export function sourceFile(path: string, content: string): SourceFile {
  const dot = path.lastIndexOf(".");
  return {
    path,
    content,
    byteLength: Buffer.byteLength(content),
    extension: dot < 0 ? "" : path.slice(dot).toLowerCase(),
  };
}

export const TEST_REPOSITORY: RepositorySnapshot = {
  repositoryId: 123_456,
  canonicalRepositoryUrl: "https://github.com/example/education-service",
  owner: "example",
  name: "education-service",
  defaultBranch: "main",
};

export const TEST_COMMIT = "0123456789abcdef0123456789abcdef01234567";

export class FixtureSourceProvider implements RepositorySourceProvider {
  public resolveCalls = 0;
  public collectCalls = 0;
  public headCalls = 0;
  public head: string | null = TEST_COMMIT;
  public collection: CollectedRepository;

  public constructor(files: readonly SourceFile[] = [
    sourceFile("package.json", '{"name":"safe-app"}'),
    sourceFile("package-lock.json", '{"lockfileVersion":3}'),
    sourceFile("src/index.ts", "export const safe = true;"),
  ]) {
    this.collection = {
      repository: TEST_REPOSITORY,
      commitSha: TEST_COMMIT,
      files,
      exactCommitVerified: true,
      partial: false,
      coverageIncomplete: false,
      failedFileCount: 0,
    };
  }

  public resolveRepository(_repositoryUrl: string): Promise<RepositorySnapshot> {
    this.resolveCalls += 1;
    return Promise.resolve(structuredClone(this.collection.repository));
  }

  public collect(_repositoryUrl: string, _commitSha: string): Promise<CollectedRepository> {
    this.collectCalls += 1;
    return Promise.resolve(structuredClone(this.collection));
  }

  public getDefaultBranchHead(_repository: RepositorySnapshot): Promise<string | null> {
    this.headCalls += 1;
    return Promise.resolve(this.head);
  }
}

export class InMemoryCertificationRepository implements CertificationRepository {
  public criteria = structuredClone(CRITERIA_CATALOG) as CriterionDefinition[];
  public policies = new Map<string, PolicyRecord>();
  public badges = new Map<string, StoredBadge>();
  public analyses: AnalysisRecordInput[] = [];
  public audits: Array<{ action: string; actor: string; target: string }> = [];
  public nextVersion = 1;

  public listCriteria(): Promise<readonly CriterionDefinition[]> {
    return Promise.resolve(structuredClone(this.criteria));
  }

  public getCriteria(criterionIds: readonly string[]): Promise<readonly CriterionDefinition[]> {
    const selected = this.criteria.filter((criterion) => criterionIds.includes(criterion.criterionId));
    return Promise.resolve(structuredClone(selected));
  }

  public nextPolicyVersion(): Promise<number> {
    const version = this.nextVersion;
    this.nextVersion += 1;
    return Promise.resolve(version);
  }

  public listPolicies(): Promise<readonly PolicyRecord[]> {
    return Promise.resolve(
      [...this.policies.values()]
        .sort((left, right) => right.snapshot.policyVersion - left.snapshot.policyVersion)
        .map((record) => structuredClone(record)),
    );
  }

  public getPolicy(policyId: string): Promise<PolicyRecord | null> {
    const record = this.policies.get(policyId);
    return Promise.resolve(record ? structuredClone(record) : null);
  }

  public getActivePolicy(): Promise<PolicyRecord | null> {
    const record = [...this.policies.values()].find((policy) => policy.status === "ACTIVE");
    return Promise.resolve(record ? structuredClone(record) : null);
  }

  public createDraftPolicy(record: PolicyRecord): Promise<PolicyRecord> {
    this.policies.set(record.snapshot.policyId, structuredClone(record));
    this.audits.push({ action: "POLICY_CREATED", actor: record.createdBy, target: record.snapshot.policyId });
    return Promise.resolve(structuredClone(record));
  }

  public updateDraftPolicy(record: PolicyRecord, administratorId: string): Promise<PolicyRecord> {
    const existing = this.policies.get(record.snapshot.policyId);
    if (!existing || existing.status !== "DRAFT") return Promise.reject(new Error("Published policy cannot be modified"));
    this.policies.set(record.snapshot.policyId, structuredClone(record));
    this.audits.push({ action: "POLICY_UPDATED", actor: administratorId, target: record.snapshot.policyId });
    return Promise.resolve(structuredClone(record));
  }

  public publishPolicy(policyId: string, administratorId: string, publishedAt: string): Promise<PolicyRecord> {
    const target = this.policies.get(policyId);
    if (!target || target.status !== "DRAFT") return Promise.reject(new Error("Only a draft can be published"));
    if (target.snapshot.criteria.length === 0) return Promise.reject(new Error("Empty policy"));
    for (const [id, policy] of this.policies) {
      if (policy.status === "ACTIVE") {
        this.policies.set(id, { ...policy, status: "ARCHIVED", archivedAt: publishedAt });
        this.audits.push({ action: "POLICY_ARCHIVED", actor: administratorId, target: id });
      }
    }
    const published: PolicyRecord = { ...target, status: "ACTIVE", publishedAt };
    this.policies.set(policyId, structuredClone(published));
    this.audits.push({ action: "POLICY_PUBLISHED", actor: administratorId, target: policyId });
    return Promise.resolve(structuredClone(published));
  }

  public saveRejectedAnalysis(input: AnalysisRecordInput): Promise<void> {
    this.analyses.push(structuredClone(input));
    return Promise.resolve();
  }

  public saveIssuedBadge(input: IssuedBadgeInput): Promise<{ badge: StoredBadge; created: boolean }> {
    const key = `${input.report.repository.repositoryId}:${input.report.commitSha}:${input.report.policy.policyHash}:${input.report.policy.rulesetVersion}`;
    const existing = [...this.badges.values()].find((badge) => {
      const candidateKey = `${badge.report.repository.repositoryId}:${badge.report.commitSha}:${badge.report.policy.policyHash}:${badge.report.policy.rulesetVersion}`;
      return candidateKey === key;
    });
    if (existing) return Promise.resolve({ badge: structuredClone(existing), created: false });
    const stored: StoredBadge = {
      analysisId: input.analysisId,
      policySnapshot: structuredClone(input.report.policy),
      report: structuredClone(input.report),
      reportHash: input.reportHash,
      criteriaHash: input.criteriaHash,
      proof: structuredClone(input.proof),
      typedDataSnapshot: structuredClone({
        domain: input.proof.domain,
        types: input.proof.types,
        primaryType: input.proof.primaryType,
        message: input.proof.message,
      }),
      revokedAt: null,
      revokedBy: null,
      revocationReason: null,
    };
    this.analyses.push(structuredClone(input));
    this.badges.set(input.proof.uid, stored);
    return Promise.resolve({ badge: structuredClone(stored), created: true });
  }

  public getBadgeBySubject(
    repositoryId: number,
    commitSha: string,
    policyHash: string,
    rulesetVersion: string,
  ): Promise<StoredBadge | null> {
    const badge = [...this.badges.values()].find(
      (candidate) =>
        candidate.report.repository.repositoryId === repositoryId &&
        candidate.report.commitSha === commitSha &&
        candidate.report.policy.policyHash === policyHash &&
        candidate.report.policy.rulesetVersion === rulesetVersion,
    );
    return Promise.resolve(badge ? structuredClone(badge) : null);
  }

  public getBadge(uid: string): Promise<StoredBadge | null> {
    const badge = this.badges.get(uid);
    return Promise.resolve(badge ? structuredClone(badge) : null);
  }

  public listBadges(limit: number): Promise<readonly StoredBadge[]> {
    return Promise.resolve([...this.badges.values()].slice(0, limit).map((badge) => structuredClone(badge)));
  }

  public revokeBadge(input: RevokeBadgeInput): Promise<{ badge: StoredBadge; created: boolean } | null> {
    const existing = this.badges.get(input.uid);
    if (!existing) return Promise.resolve(null);
    if (existing.revokedAt !== null) return Promise.resolve({ badge: structuredClone(existing), created: false });
    const revoked: StoredBadge = {
      ...existing,
      revokedAt: input.revokedAt,
      revokedBy: input.administratorId,
      revocationReason: input.reason,
    };
    this.badges.set(input.uid, revoked);
    this.audits.push({ action: "BADGE_REVOKED", actor: input.administratorId, target: input.uid });
    return Promise.resolve({ badge: structuredClone(revoked), created: true });
  }
}
