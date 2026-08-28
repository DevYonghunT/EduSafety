import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  STANDALONE_URL_SCAN_DATABASE_URL,
  createServerRuntime,
} from "../../src/bootstrap.js";
import { makeTestConfig } from "../helpers/test-fixtures.js";

describe("standalone bootstrap", () => {
  it("starts without a database pool and keeps static report operation healthy", async () => {
    const config = await makeTestConfig({
      databaseUrl: STANDALONE_URL_SCAN_DATABASE_URL,
    });
    const runtime = await createServerRuntime(config);

    expect(runtime.pool).toBeUndefined();
    await request(runtime.app).get("/health").expect(200, { status: "ok" });
  });
});
