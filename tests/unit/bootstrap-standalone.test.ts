import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  STANDALONE_URL_SCAN_DATABASE_URL,
  createServerRuntime,
} from "../../src/bootstrap.js";
import {
  ANTHROPIC_MODELS,
  DEFAULT_ANTHROPIC_MODEL,
} from "../../src/security-scan/anthropic-summary.js";
import { makeTestConfig } from "../helpers/test-fixtures.js";

describe("standalone bootstrap", () => {
  it("keeps static report operation and admin URL-scan capability available", async () => {
    const config = await makeTestConfig({
      databaseUrl: STANDALONE_URL_SCAN_DATABASE_URL,
      securityScan: {
        allowedOrigins: new Set(),
        dynamicTargetsEnabled: true,
        timeoutMs: 1_000,
      },
    });
    const runtime = await createServerRuntime(config);

    expect(runtime.pool).toBeUndefined();
    await request(runtime.app).get("/health").expect(200, { status: "ok" });
    await request(runtime.app).get("/api/security-scan/config").expect(200, {
      enabled: true,
      dynamicTargetInput: true,
      aiEnabled: true,
      aiProvider: "anthropic",
      aiCredentialMode: "request",
      defaultAiModel: DEFAULT_ANTHROPIC_MODEL,
      aiModels: ANTHROPIC_MODELS,
      mode: "passive",
    });

    const agent = request.agent(runtime.app);
    await agent.post("/api/admin/session").send({
      username: "admin@example.test",
      password: "test administrator password",
    }).expect(200);
    await agent.get("/api/admin/security-scan/config").expect(200, {
      enabled: true,
      dynamicTargetInput: true,
      aiEnabled: true,
      aiProvider: "anthropic",
      aiCredentialMode: "request",
      defaultAiModel: DEFAULT_ANTHROPIC_MODEL,
      aiModels: ANTHROPIC_MODELS,
      mode: "passive",
    });
    await agent.get("/api/admin/certification/policies").expect(200, { policies: [] });
  });
});
