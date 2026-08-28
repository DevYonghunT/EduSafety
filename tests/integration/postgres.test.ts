import { createDatabasePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { PostgresCertificationRepository } from "../../src/db/postgres-repository.js";
import { PolicyService } from "../../src/certification/policy-service.js";
import { BadgeIssueService } from "../../src/certification/issue-service.js";
import { StaticAnalysisService } from "../../src/analysis/service.js";
import { AttestationSigner } from "../../src/certification/attestation.js";
import { BadgeVerificationService } from "../../src/certification/verification-service.js";
import type { AppConfig } from "../../src/config.js";
import {
  FixtureSourceProvider,
  TEST_COMMIT,
  makeTestConfig,
} from "../helpers/test-fixtures.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = testDatabaseUrl ? describe : describe.skip;

describePostgres("PostgreSQL migration and concurrency", () => {
  const databaseUrl = testDatabaseUrl!;
  const pool = createDatabasePool(databaseUrl);
  const repository = new PostgresCertificationRepository(pool);
  let config!: AppConfig;

  beforeAll(async () => {
    await runMigrations(databaseUrl);
    config = await makeTestConfig({ databaseUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates the required partial and issuance unique indexes", async () => {
    const result = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('certification_policies_one_active_idx', 'certification_badges_issuance_uq')
       ORDER BY indexname`,
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows.find((row) => row.indexname === "certification_policies_one_active_idx")?.indexdef).toContain(
      "WHERE (status = 'ACTIVE'::text)",
    );
    expect(result.rows.find((row) => row.indexname === "certification_badges_issuance_uq")?.indexdef).toContain(
      "repository_id, commit_sha, policy_hash, ruleset_version",
    );
  });

  it("keeps one row and UID across 20 independent concurrent issuance services", async () => {
    const sourceProvider = new FixtureSourceProvider();
    const policyService = new PolicyService(repository, () => new Date("2026-08-28T00:00:00.000Z"));
    const draft = await policyService.createDraft({
      name: "PostgreSQL 정책",
      criterionIds: ["dependency-lockfile-present"],
      administratorId: "database-admin",
    });
    await policyService.publish(draft.snapshot.policyId, "database-admin");

    const services = Array.from(
      { length: 20 },
      () =>
        new BadgeIssueService(
          repository,
          new StaticAnalysisService(sourceProvider, () => new Date("2026-08-28T00:00:00.000Z")),
          new AttestationSigner(config, { now: () => new Date("2026-08-28T00:00:00.000Z") }),
        ),
    );
    const results = await Promise.all(
      services.map((service) =>
        service.issue(sourceProvider.collection.repository.canonicalRepositoryUrl, TEST_COMMIT),
      ),
    );
    const uids = new Set(
      results.map((result) => (result.outcome === "ISSUED" ? result.badge.proof.uid : "not-issued")),
    );
    expect(uids.size).toBe(1);
    const counts = await pool.query<{ analyses: string; badges: string }>(
      `SELECT
        (SELECT count(*)::text FROM certification_analyses) AS analyses,
        (SELECT count(*)::text FROM certification_badges) AS badges`,
    );
    expect(counts.rows[0]).toEqual({ analyses: "1", badges: "1" });

    const first = results[0];
    if (!first || first.outcome !== "ISSUED") throw new Error("Expected issued certification");
    const verifier = new BadgeVerificationService(repository, sourceProvider, config, () => new Date("2026-08-28T00:00:00.000Z"));
    expect((await verifier.verify(first.badge)).status).toBe("VALID");

    const revoked = await Promise.all(
      Array.from({ length: 20 }, () =>
        repository.revokeBadge({
          uid: first.badge.proof.uid,
          administratorId: "database-admin",
          reason: "SECURITY_REVIEW",
          revokedAt: "2026-08-29T00:00:00.000Z",
        }),
      ),
    );
    expect(revoked.filter((result) => result?.created)).toHaveLength(1);
    const revocationCounts = await pool.query<{ revocations: string; audits: string }>(
      `SELECT
        (SELECT count(*)::text FROM certification_badge_revocations) AS revocations,
        (SELECT count(*)::text FROM certification_audit_logs WHERE action = 'BADGE_REVOKED') AS audits`,
    );
    expect(revocationCounts.rows[0]).toEqual({ revocations: "1", audits: "1" });
  });

  it("allows the same commit under a replacement policy while preserving the old proof", async () => {
    const sourceProvider = new FixtureSourceProvider();
    const policyService = new PolicyService(repository, () => new Date("2026-08-30T00:00:00.000Z"));
    const oldBadge = (await repository.listBadges(1))[0];
    if (!oldBadge) throw new Error("Expected prior badge");
    const replacement = await policyService.createDraft({
      name: "PostgreSQL 교체 정책",
      criterionIds: ["no-hardcoded-secrets"],
      administratorId: "database-admin",
    });
    await policyService.publish(replacement.snapshot.policyId, "database-admin");
    const issued = await new BadgeIssueService(
      repository,
      new StaticAnalysisService(sourceProvider, () => new Date("2026-08-30T00:00:00.000Z")),
      new AttestationSigner(config, { now: () => new Date("2026-08-30T00:00:00.000Z") }),
    ).issue(sourceProvider.collection.repository.canonicalRepositoryUrl, TEST_COMMIT);
    expect(issued.outcome).toBe("ISSUED");
    expect((await repository.listBadges(10))).toHaveLength(2);
    const oldVerification = await new BadgeVerificationService(
      repository,
      sourceProvider,
      config,
      () => new Date("2026-08-30T00:00:00.000Z"),
    ).verify(oldBadge);
    expect(oldVerification.integrityValid).toBe(true);
    expect(oldVerification.status).toBe("REVOKED");
  });

  it("rejects direct changes to published policies and proof history", async () => {
    await expect(
      pool.query("UPDATE certification_policies SET name = 'changed' WHERE status = 'ACTIVE'"),
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query("UPDATE certification_badges SET attester = '0x0000000000000000000000000000000000000001'"),
    ).rejects.toThrow(/immutable/);
    await expect(pool.query("DELETE FROM certification_audit_logs")).rejects.toThrow(/immutable/);
  });
});
