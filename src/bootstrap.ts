import "dotenv/config";
import type { Express } from "express";
import { createApp } from "./app.js";
import { loadConfig, type AppConfig } from "./config.js";
import { createDatabasePool, type DatabasePool } from "./db/client.js";
import { PostgresCertificationRepository } from "./db/postgres-repository.js";
import { PostgresReviewRepository } from "./db/review-repository.js";
import { UnavailableCertificationRepository } from "./db/unavailable-repository.js";
import { GitHubClient } from "./github/client.js";

const REQUIRED_MIGRATION = "001_eas_offchain_v2_certification";
export const STANDALONE_URL_SCAN_DATABASE_URL = "standalone://url-scan";

export interface ServerRuntime {
  readonly app: Express;
  readonly config: AppConfig;
  readonly pool?: DatabasePool;
}

let runtimePromise: Promise<ServerRuntime> | undefined;

export async function createServerRuntime(config: AppConfig = loadConfig()): Promise<ServerRuntime> {
  const sourceProvider = new GitHubClient({
    ...(config.githubToken === undefined ? {} : { token: config.githubToken }),
  });
  if (config.databaseUrl === STANDALONE_URL_SCAN_DATABASE_URL) {
    const repository = new UnavailableCertificationRepository();
    return {
      app: createApp({ config, repository, sourceProvider }),
      config,
    };
  }
  const pool = createDatabasePool(config.databaseUrl);
  try {
    await pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [REQUIRED_MIGRATION]);
    const repository = new PostgresCertificationRepository(pool);
    const reviewRepository = new PostgresReviewRepository(pool);
    return {
      app: createApp({ config, repository, sourceProvider, reviewRepository }),
      config,
      pool,
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

export function getServerRuntime(): Promise<ServerRuntime> {
  if (runtimePromise === undefined) {
    runtimePromise = createServerRuntime().catch((error: unknown) => {
      runtimePromise = undefined;
      throw error;
    });
  }
  return runtimePromise;
}

export async function getApplication(): Promise<Express> {
  return (await getServerRuntime()).app;
}

export async function closeServerRuntime(): Promise<void> {
  const current = runtimePromise;
  runtimePromise = undefined;
  if (current === undefined) return;
  const runtime = await current;
  await runtime.pool?.end();
}
