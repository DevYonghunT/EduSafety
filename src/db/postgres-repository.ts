import { randomUUID } from "node:crypto";
import { Signature } from "ethers";
import type { QueryResultRow } from "pg";
import { SAFETY_BLOCKERS } from "../certification/catalog.js";
import { EAS_ATTEST_TYPES, type SignedAttestationProof } from "../certification/attestation.js";
import type {
  AnalysisReportSnapshot,
  CertificationPayload,
  CertificationPolicySnapshot,
  CriterionDefinition,
  PolicyStatus,
} from "../domain/types.js";
import type { DatabaseClient, DatabasePool } from "./client.js";
import type {
  AnalysisRecordInput,
  CertificationRepository,
  IssuedBadgeInput,
  PolicyRecord,
  RevokeBadgeInput,
  StoredBadge,
} from "./repository.js";

interface PolicyRow extends QueryResultRow {
  id: string;
  status: PolicyStatus;
  snapshot_json: CertificationPolicySnapshot;
  created_by: string;
  created_at: Date;
  published_at: Date | null;
  archived_at: Date | null;
}

interface CriterionRow extends QueryResultRow {
  criterion_id: string;
  criterion_version: string;
  name: string;
  public_description: string;
  category: string;
  evaluator_key: string;
  active: boolean;
  available: boolean;
  display_order: number;
}

interface BadgeRow extends QueryResultRow {
  analysis_id: string;
  policy_snapshot_json: CertificationPolicySnapshot;
  report_snapshot_json: AnalysisReportSnapshot;
  report_hash: `0x${string}`;
  criteria_hash: `0x${string}`;
  uid: `0x${string}`;
  attester: string;
  domain_name: "EAS Attestation";
  domain_version: "1.2.0";
  chain_id: string;
  verifying_contract: "0x4200000000000000000000000000000000000021";
  offchain_version: 2;
  primary_type: "Attest";
  schema_uid: `0x${string}`;
  recipient: "0x0000000000000000000000000000000000000000";
  ref_uid: `0x${string}`;
  attestation_time: string;
  expiration_time: string;
  revocable: true;
  encoded_data: `0x${string}`;
  salt: `0x${string}`;
  signature: `0x${string}`;
  payload_canonical: string;
  payload_json: CertificationPayload;
  typed_data_json: unknown;
  issued_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  revoked_by: string | null;
  revocation_reason: string | null;
}

function policyFromRow(row: PolicyRow): PolicyRecord {
  return {
    snapshot: row.snapshot_json,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    publishedAt: row.published_at?.toISOString() ?? null,
    archivedAt: row.archived_at?.toISOString() ?? null,
  };
}

function criterionFromRow(row: CriterionRow): CriterionDefinition {
  return {
    criterionId: row.criterion_id,
    criterionVersion: row.criterion_version,
    name: row.name,
    publicDescription: row.public_description,
    category: row.category,
    evaluatorKey: row.evaluator_key,
    active: row.active,
    available: row.available,
    displayOrder: row.display_order,
  };
}

function badgeFromRow(row: BadgeRow): StoredBadge {
  const signature = Signature.from(row.signature);
  const proof: SignedAttestationProof = {
    uid: row.uid,
    attester: row.attester,
    domain: {
      name: row.domain_name,
      version: row.domain_version,
      chainId: row.chain_id,
      verifyingContract: row.verifying_contract,
    },
    types: EAS_ATTEST_TYPES,
    primaryType: row.primary_type,
    message: {
      version: row.offchain_version,
      schema: row.schema_uid,
      recipient: row.recipient,
      time: row.attestation_time,
      expirationTime: row.expiration_time,
      revocable: row.revocable,
      refUID: row.ref_uid,
      data: row.encoded_data,
      salt: row.salt,
    },
    signature: row.signature,
    signatureParts: {
      r: signature.r as `0x${string}`,
      s: signature.s as `0x${string}`,
      v: signature.v,
    },
    canonicalPayload: row.payload_canonical,
    payload: row.payload_json,
    issuedAt: row.issued_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
  };
  return {
    analysisId: row.analysis_id,
    policySnapshot: row.policy_snapshot_json,
    report: row.report_snapshot_json,
    reportHash: row.report_hash,
    criteriaHash: row.criteria_hash,
    proof,
    typedDataSnapshot: row.typed_data_json,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    revokedBy: row.revoked_by,
    revocationReason: row.revocation_reason,
  };
}

const BADGE_SELECT = `
  SELECT
    b.*,
    a.report_snapshot_json,
    p.snapshot_json AS policy_snapshot_json,
    r.revoked_at,
    r.revoked_by,
    r.reason AS revocation_reason
  FROM certification_badges b
  JOIN certification_analyses a ON a.id = b.analysis_id
  JOIN certification_policies p ON p.id = b.policy_id
  LEFT JOIN certification_badge_revocations r ON r.uid = b.uid
`;

async function withTransaction<T>(pool: DatabasePool, operation: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertAudit(
  client: DatabaseClient,
  administratorId: string,
  action: string,
  targetType: "BADGE" | "POLICY",
  targetId: string,
  details: Record<string, boolean | number | string>,
): Promise<void> {
  await client.query(
    `INSERT INTO certification_audit_logs
      (id, administrator_id, action, target_type, target_id, details_json)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [randomUUID(), administratorId, action, targetType, targetId, JSON.stringify(details)],
  );
}

async function insertAnalysis(client: DatabaseClient, input: AnalysisRecordInput): Promise<void> {
  const { report } = input;
  await client.query(
    `INSERT INTO certification_analyses (
      id, repository_id, canonical_repository_url, commit_sha, policy_id, policy_version,
      policy_hash, ruleset_version, decision, report_hash, report_snapshot_json, analyzed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
    [
      input.analysisId,
      String(report.repository.repositoryId),
      report.repository.canonicalRepositoryUrl,
      report.commitSha,
      report.policy.policyId,
      report.policy.policyVersion,
      report.policy.policyHash,
      report.policy.rulesetVersion,
      input.decision,
      input.reportHash,
      JSON.stringify(report),
      report.analyzedAt,
    ],
  );

  for (const result of report.criteriaResults) {
    await client.query(
      `INSERT INTO certification_analysis_criteria (
        analysis_id, criterion_id, criterion_version, evaluator_key, result, summary, findings_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        input.analysisId,
        result.criterionId,
        result.criterionVersion,
        result.evaluatorKey,
        result.result,
        result.summary,
        JSON.stringify(result.findings),
      ],
    );
  }
  for (const result of report.safetyBlockers) {
    await client.query(
      `INSERT INTO certification_analysis_safety_blockers (
        analysis_id, blocker_id, blocker_version, triggered, summary
      ) VALUES ($1, $2, $3, $4, $5)`,
      [input.analysisId, result.blockerId, result.version, result.triggered, result.summary],
    );
  }
}

export class PostgresCertificationRepository implements CertificationRepository {
  public constructor(private readonly pool: DatabasePool) {}

  public async listCriteria(): Promise<readonly CriterionDefinition[]> {
    const result = await this.pool.query<CriterionRow>(
      "SELECT * FROM certification_criteria ORDER BY display_order, criterion_id, criterion_version",
    );
    return result.rows.map(criterionFromRow);
  }

  public async getCriteria(criterionIds: readonly string[]): Promise<readonly CriterionDefinition[]> {
    if (criterionIds.length === 0) return [];
    const result = await this.pool.query<CriterionRow>(
      `SELECT * FROM certification_criteria
       WHERE criterion_id = ANY($1::text[])
       ORDER BY criterion_id, criterion_version`,
      [criterionIds],
    );
    return result.rows.map(criterionFromRow);
  }

  public async nextPolicyVersion(): Promise<number> {
    const result = await this.pool.query<{ version: string }>(
      "SELECT nextval('certification_policy_version_seq')::text AS version",
    );
    const version = Number(result.rows[0]?.version);
    if (!Number.isSafeInteger(version) || version <= 0) throw new Error("Invalid policy version sequence");
    return version;
  }

  public async listPolicies(): Promise<readonly PolicyRecord[]> {
    const result = await this.pool.query<PolicyRow>(
      "SELECT * FROM certification_policies ORDER BY policy_version DESC",
    );
    return result.rows.map(policyFromRow);
  }

  public async getPolicy(policyId: string): Promise<PolicyRecord | null> {
    const result = await this.pool.query<PolicyRow>(
      "SELECT * FROM certification_policies WHERE id = $1",
      [policyId],
    );
    return result.rows[0] ? policyFromRow(result.rows[0]) : null;
  }

  public async getActivePolicy(): Promise<PolicyRecord | null> {
    const result = await this.pool.query<PolicyRow>(
      "SELECT * FROM certification_policies WHERE status = 'ACTIVE'",
    );
    return result.rows[0] ? policyFromRow(result.rows[0]) : null;
  }

  public async createDraftPolicy(record: PolicyRecord): Promise<PolicyRecord> {
    return withTransaction(this.pool, async (client) => {
      const { snapshot } = record;
      await client.query(
        `INSERT INTO certification_policies (
          id, name, policy_version, policy_hash, ruleset_version, status, snapshot_json,
          created_by, created_at, published_at, archived_at
        ) VALUES ($1, $2, $3, $4, $5, 'DRAFT', $6::jsonb, $7, $8, NULL, NULL)`,
        [
          snapshot.policyId,
          snapshot.name,
          snapshot.policyVersion,
          snapshot.policyHash,
          snapshot.rulesetVersion,
          JSON.stringify(snapshot),
          record.createdBy,
          record.createdAt,
        ],
      );
      await this.#replacePolicyChildren(client, snapshot);
      await insertAudit(
        client,
        record.createdBy,
        "POLICY_CREATED",
        "POLICY",
        snapshot.policyId,
        { policyVersion: snapshot.policyVersion },
      );
      return record;
    });
  }

  public async updateDraftPolicy(record: PolicyRecord, administratorId: string): Promise<PolicyRecord> {
    return withTransaction(this.pool, async (client) => {
      const locked = await client.query<PolicyRow>(
        "SELECT * FROM certification_policies WHERE id = $1 FOR UPDATE",
        [record.snapshot.policyId],
      );
      if (locked.rows[0]?.status !== "DRAFT") throw new Error("Published policy cannot be modified");
      await client.query(
        `UPDATE certification_policies
         SET name = $2, policy_hash = $3, snapshot_json = $4::jsonb
         WHERE id = $1`,
        [
          record.snapshot.policyId,
          record.snapshot.name,
          record.snapshot.policyHash,
          JSON.stringify(record.snapshot),
        ],
      );
      await client.query("DELETE FROM certification_policy_criteria WHERE policy_id = $1", [
        record.snapshot.policyId,
      ]);
      await client.query("DELETE FROM certification_policy_safety_controls WHERE policy_id = $1", [
        record.snapshot.policyId,
      ]);
      await this.#replacePolicyChildren(client, record.snapshot);
      await insertAudit(
        client,
        administratorId,
        "POLICY_UPDATED",
        "POLICY",
        record.snapshot.policyId,
        { criterionCount: record.snapshot.criteria.length },
      );
      return record;
    });
  }

  async #replacePolicyChildren(
    client: DatabaseClient,
    snapshot: CertificationPolicySnapshot,
  ): Promise<void> {
    for (const [index, criterion] of snapshot.criteria.entries()) {
      await client.query(
        `INSERT INTO certification_policy_criteria
          (policy_id, criterion_id, criterion_version, display_order)
         VALUES ($1, $2, $3, $4)`,
        [snapshot.policyId, criterion.criterionId, criterion.criterionVersion, index],
      );
    }
    for (const blocker of snapshot.safetyBlockers) {
      await client.query(
        `INSERT INTO certification_policy_safety_controls
          (policy_id, blocker_id, blocker_version, evaluator_key)
         VALUES ($1, $2, $3, $4)`,
        [snapshot.policyId, blocker.blockerId, blocker.version, `safety.${blocker.blockerId}.v1`],
      );
    }
  }

  public async publishPolicy(
    policyId: string,
    administratorId: string,
    publishedAt: string,
  ): Promise<PolicyRecord> {
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(42581128)");
      const target = await client.query<PolicyRow>(
        "SELECT * FROM certification_policies WHERE id = $1 FOR UPDATE",
        [policyId],
      );
      const row = target.rows[0];
      if (!row) throw new Error("Policy not found");
      if (row.status !== "DRAFT") throw new Error("Only draft policies can be published");
      const checks = await client.query<{ selected_count: string; valid_count: string }>(
        `SELECT
          count(*)::text AS selected_count,
          count(*) FILTER (WHERE c.active AND c.available)::text AS valid_count
         FROM certification_policy_criteria pc
         JOIN certification_criteria c
           ON c.criterion_id = pc.criterion_id AND c.criterion_version = pc.criterion_version
         WHERE pc.policy_id = $1`,
        [policyId],
      );
      const selectedCount = Number(checks.rows[0]?.selected_count ?? 0);
      const validCount = Number(checks.rows[0]?.valid_count ?? 0);
      if (selectedCount === 0 || selectedCount !== validCount) {
        throw new Error("Policy must contain supported, active criteria");
      }
      const safety = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM certification_policy_safety_controls WHERE policy_id = $1",
        [policyId],
      );
      if (Number(safety.rows[0]?.count ?? 0) !== SAFETY_BLOCKERS.length) {
        throw new Error("Policy safety controls are incomplete");
      }

      const active = await client.query<PolicyRow>(
        "SELECT * FROM certification_policies WHERE status = 'ACTIVE' FOR UPDATE",
      );
      if (active.rows[0]) {
        await client.query(
          "UPDATE certification_policies SET status = 'ARCHIVED', archived_at = $1 WHERE id = $2",
          [publishedAt, active.rows[0].id],
        );
        await insertAudit(
          client,
          administratorId,
          "POLICY_ARCHIVED",
          "POLICY",
          active.rows[0].id,
          { replacementPolicyId: policyId },
        );
      }
      const updated = await client.query<PolicyRow>(
        `UPDATE certification_policies
         SET status = 'ACTIVE', published_at = $2
         WHERE id = $1
         RETURNING *`,
        [policyId, publishedAt],
      );
      await insertAudit(client, administratorId, "POLICY_PUBLISHED", "POLICY", policyId, {
        policyVersion: row.snapshot_json.policyVersion,
      });
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw new Error("Policy publication failed");
      return policyFromRow(updatedRow);
    });
  }

  public async saveRejectedAnalysis(input: AnalysisRecordInput): Promise<void> {
    await withTransaction(this.pool, async (client) => insertAnalysis(client, input));
  }

  public async saveIssuedBadge(input: IssuedBadgeInput): Promise<{ badge: StoredBadge; created: boolean }> {
    try {
      await withTransaction(this.pool, async (client) => {
        await insertAnalysis(client, input);
        const { report, proof } = input;
        await client.query(
          `INSERT INTO certification_badges (
            uid, analysis_id, repository_id, canonical_repository_url, commit_sha,
            policy_id, policy_version, policy_hash, ruleset_version, criteria_hash, report_hash,
            signature, attester, salt, schema_uid, domain_name, domain_version, chain_id,
            verifying_contract, offchain_version, primary_type, recipient, ref_uid,
            attestation_time, expiration_time, revocable, encoded_data, payload_canonical,
            payload_json, typed_data_json, issued_at, expires_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
            $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29::jsonb,
            $30::jsonb, $31, $32
          )`,
          [
            proof.uid,
            input.analysisId,
            String(report.repository.repositoryId),
            report.repository.canonicalRepositoryUrl,
            report.commitSha,
            report.policy.policyId,
            report.policy.policyVersion,
            report.policy.policyHash,
            report.policy.rulesetVersion,
            input.criteriaHash,
            input.reportHash,
            proof.signature,
            proof.attester,
            proof.message.salt,
            proof.message.schema,
            proof.domain.name,
            proof.domain.version,
            proof.domain.chainId,
            proof.domain.verifyingContract,
            proof.message.version,
            proof.primaryType,
            proof.message.recipient,
            proof.message.refUID,
            proof.message.time,
            proof.message.expirationTime,
            proof.message.revocable,
            proof.message.data,
            proof.canonicalPayload,
            JSON.stringify(input.payload),
            JSON.stringify({
              domain: proof.domain,
              types: proof.types,
              primaryType: proof.primaryType,
              message: proof.message,
            }),
            proof.issuedAt,
            proof.expiresAt,
          ],
        );
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "23505") throw error;
      const existing = await this.getBadgeBySubject(
        input.report.repository.repositoryId,
        input.report.commitSha,
        input.report.policy.policyHash,
        input.report.policy.rulesetVersion,
      );
      if (!existing) throw error;
      return { badge: existing, created: false };
    }
    const stored = await this.getBadge(input.proof.uid);
    if (!stored) throw new Error("Issued badge could not be loaded");
    return { badge: stored, created: true };
  }

  public async getBadgeBySubject(
    repositoryId: number,
    commitSha: string,
    policyHash: string,
    rulesetVersion: string,
  ): Promise<StoredBadge | null> {
    const result = await this.pool.query<BadgeRow>(
      `${BADGE_SELECT}
       WHERE b.repository_id = $1 AND b.commit_sha = $2 AND b.policy_hash = $3 AND b.ruleset_version = $4`,
      [String(repositoryId), commitSha, policyHash, rulesetVersion],
    );
    return result.rows[0] ? badgeFromRow(result.rows[0]) : null;
  }

  public async getBadge(uid: string): Promise<StoredBadge | null> {
    const result = await this.pool.query<BadgeRow>(`${BADGE_SELECT} WHERE b.uid = $1`, [uid]);
    return result.rows[0] ? badgeFromRow(result.rows[0]) : null;
  }

  public async listBadges(limit: number): Promise<readonly StoredBadge[]> {
    const result = await this.pool.query<BadgeRow>(
      `${BADGE_SELECT} ORDER BY b.issued_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(badgeFromRow);
  }

  public async revokeBadge(input: RevokeBadgeInput): Promise<{ badge: StoredBadge; created: boolean } | null> {
    const existing = await this.getBadge(input.uid);
    if (!existing) return null;
    const created = await withTransaction(this.pool, async (client) => {
      const inserted = await client.query(
        `INSERT INTO certification_badge_revocations (uid, revoked_at, revoked_by, reason)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (uid) DO NOTHING
         RETURNING uid`,
        [input.uid, input.revokedAt, input.administratorId, input.reason],
      );
      if (inserted.rowCount === 1) {
        await insertAudit(client, input.administratorId, "BADGE_REVOKED", "BADGE", input.uid, {
          reasonRecorded: true,
        });
        return true;
      }
      return false;
    });
    const badge = await this.getBadge(input.uid);
    if (!badge) throw new Error("Revoked badge could not be loaded");
    return { badge, created };
  }
}
