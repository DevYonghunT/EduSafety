import pg from "pg";

export type DatabasePool = Pick<pg.Pool, "connect" | "end" | "query">;
export type DatabaseClient = Pick<pg.PoolClient, "query" | "release">;

export function createDatabasePool(databaseUrl: string): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: false,
  });
}
