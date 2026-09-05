import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import type { DatabasePool } from "./client.js";

export type ReviewStatus = "pass_candidate" | "hold" | "fail_candidate";

export interface ReviewRecordInput {
  readonly target: string;
  readonly commitSha: string | null;
  readonly fingerprint: string | null;
  readonly status: ReviewStatus;
  readonly rubricVersion: string;
  readonly protectionLevel: string;
  readonly profile: string;
  readonly record: Record<string, unknown>;
  readonly recordedBy: string;
}

export interface StoredReviewRecord extends ReviewRecordInput {
  readonly id: string;
  readonly round: number;
  readonly createdAt: string;
}

export interface ReviewRepository {
  save(input: ReviewRecordInput): Promise<StoredReviewRecord>;
  list(limit: number): Promise<readonly StoredReviewRecord[]>;
}

export class ReviewStoreUnavailableError extends Error {
  public constructor(message = "Review record store is unavailable") {
    super(message);
    this.name = "ReviewStoreUnavailableError";
  }
}

export class InMemoryReviewRepository implements ReviewRepository {
  private readonly records: StoredReviewRecord[] = [];

  public save(input: ReviewRecordInput): Promise<StoredReviewRecord> {
    const round = this.records.filter((record) => record.target === input.target).length + 1;
    const stored: StoredReviewRecord = {
      ...input,
      id: randomUUID(),
      round,
      createdAt: new Date().toISOString(),
    };
    this.records.push(stored);
    return Promise.resolve(stored);
  }

  public list(limit: number): Promise<readonly StoredReviewRecord[]> {
    return Promise.resolve([...this.records].reverse().slice(0, limit));
  }
}

interface ReviewRow extends QueryResultRow {
  id: string;
  target: string;
  commit_sha: string | null;
  fingerprint: string | null;
  round: number;
  status: ReviewStatus;
  rubric_version: string;
  protection_level: string;
  profile: string;
  record_json: Record<string, unknown>;
  recorded_by: string;
  created_at: Date;
}

const UNDEFINED_TABLE = "42P01";

function toStored(row: ReviewRow): StoredReviewRecord {
  return {
    id: row.id,
    target: row.target,
    commitSha: row.commit_sha,
    fingerprint: row.fingerprint,
    round: row.round,
    status: row.status,
    rubricVersion: row.rubric_version,
    protectionLevel: row.protection_level,
    profile: row.profile,
    record: row.record_json,
    recordedBy: row.recorded_by,
    createdAt: row.created_at.toISOString(),
  };
}

function translateError(error: unknown): never {
  if (typeof error === "object" && error !== null && (error as { code?: string }).code === UNDEFINED_TABLE) {
    throw new ReviewStoreUnavailableError("review_records table is missing — run `npm run db:migrate`");
  }
  throw error;
}

export class PostgresReviewRepository implements ReviewRepository {
  public constructor(private readonly pool: DatabasePool) {}

  public async save(input: ReviewRecordInput): Promise<StoredReviewRecord> {
    try {
      const result = await this.pool.query<ReviewRow>(
        `INSERT INTO review_records
           (target, commit_sha, fingerprint, round, status, rubric_version, protection_level, profile, record_json, recorded_by)
         VALUES ($1, $2, $3, (SELECT count(*) + 1 FROM review_records WHERE target = $1), $4, $5, $6, $7, $8::jsonb, $9)
         RETURNING *`,
        [
          input.target,
          input.commitSha,
          input.fingerprint,
          input.status,
          input.rubricVersion,
          input.protectionLevel,
          input.profile,
          JSON.stringify(input.record),
          input.recordedBy,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("review record insert returned no row");
      return toStored(row);
    } catch (error) {
      return translateError(error);
    }
  }

  public async list(limit: number): Promise<readonly StoredReviewRecord[]> {
    try {
      const result = await this.pool.query<ReviewRow>(
        "SELECT * FROM review_records ORDER BY created_at DESC LIMIT $1",
        [limit],
      );
      return result.rows.map(toStored);
    } catch (error) {
      return translateError(error);
    }
  }
}
