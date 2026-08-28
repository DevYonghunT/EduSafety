import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import {
  ANTHROPIC_MODELS,
  DEFAULT_ANTHROPIC_MODEL,
  type AnthropicModelId,
} from "../../src/security-scan/anthropic-summary.js";
import type {
  SecurityScanResult,
  SecurityScanRunner,
  SecurityScanSummarizer,
} from "../../src/security-scan/service.js";
import {
  FixtureSourceProvider,
  InMemoryCertificationRepository,
  makeTestConfig,
} from "../helpers/test-fixtures.js";

const targetOrigin = "https://school.example";
const scanResult: SecurityScanResult = {
  targetUrl: `${targetOrigin}/`,
  targetOrigin,
  checkedAt: "2026-08-28T01:02:03.000Z",
  httpStatus: 200,
  tls: { protocol: "TLSv1.3", certificateValidTo: "Dec 31 23:59:59 2030 GMT" },
  summary: "기본 보안 구성 점검을 통과했습니다.",
  counts: { passed: 1, high: 0, medium: 0, low: 0, info: 0 },
  findings: [
    {
      id: "tls-version",
      title: "TLS 프로토콜",
      severity: "high",
      status: "pass",
      evidence: "TLSv1.3",
      remediation: "TLS 1.2 이상을 유지하세요.",
    },
  ],
  ai: {
    used: false,
    status: "not_requested",
    overview: "확인한 저영향 항목에서 누락을 찾지 못했습니다.",
    riskLevel: "minimal",
    priorityActions: [],
  },
  sourceSummary: {
    contentType: "text/html",
    analyzed: true,
    bytesInspected: 128,
    truncated: false,
    scriptCount: 0,
    formCount: 0,
  },
  limitations: ["정적 저영향 검사만 수행합니다."],
};

function securityScanConfigResponse(enabled: boolean) {
  return {
    enabled,
    dynamicTargetInput: enabled,
    aiEnabled: enabled,
    aiProvider: "anthropic",
    aiCredentialMode: "request",
    defaultAiModel: DEFAULT_ANTHROPIC_MODEL,
    aiModels: ANTHROPIC_MODELS,
    mode: "passive",
  };
}

async function setup(options: {
  maxRequests?: number;
  enabled?: boolean;
  dynamicTargetsEnabled?: boolean;
  allowedOrigins?: ReadonlySet<string>;
  summarizer?: SecurityScanSummarizer;
  summarizerFactoryError?: Error;
} = {}) {
  const enabled = options.enabled ?? true;
  const dynamicTargetsEnabled = options.dynamicTargetsEnabled ?? true;
  const config = await makeTestConfig({
    ...(enabled
      ? {
          securityScan: {
            allowedOrigins: options.allowedOrigins ?? new Set(),
            dynamicTargetsEnabled,
            timeoutMs: 5_000,
          },
        }
      : {}),
  });
  const scan = vi.fn(async (
    _targetUrl: string,
    _safetyIdentifier: string,
    _summarize?: SecurityScanSummarizer,
  ) => scanResult);
  const createSecurityScanSummarizer = vi.fn((credentials: {
    readonly apiKey: string;
    readonly model: AnthropicModelId;
  }): SecurityScanSummarizer => {
    if (options.summarizerFactoryError) throw options.summarizerFactoryError;
    return options.summarizer ?? (async () => ({
      overview: `Anthropic ${credentials.model} 요약`,
      priorityActions: [],
    }));
  });
  const securityScanner: SecurityScanRunner = { scan };
  const app = createApp({
    config,
    repository: new InMemoryCertificationRepository(),
    sourceProvider: new FixtureSourceProvider(),
    ...(enabled ? { securityScanner } : {}),
    createSecurityScanSummarizer,
    securityLimits: {
      securityScanMaxRequestsPerIp: options.maxRequests ?? 3,
      securityScanWindowMs: 60_000,
    },
  });
  return { app, scan, createSecurityScanSummarizer };
}

async function login(agent: ReturnType<typeof request.agent>): Promise<string> {
  await agent.post("/api/admin/session").send({
    username: "admin@example.test",
    password: "test administrator password",
  }).expect(200);
  const session = await agent.get("/api/admin/session").expect(200);
  return session.body.csrfToken as string;
}

describe("security scan API", () => {
  it("exposes public scan capabilities without authentication and blocks cross-origin reads", async () => {
    const { app } = await setup();
    await request(app)
      .get("/api/security-scan/config")
      .expect(200)
      .expect("Cache-Control", "no-store")
      .expect(securityScanConfigResponse(true));
    await request(app)
      .get("/api/security-scan/config")
      .set("origin", "https://attacker.example")
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe("ORIGIN_NOT_ALLOWED"));
  });

  it("runs a public scan without a session or CSRF token but still requires explicit authorization", async () => {
    const { app, scan } = await setup();
    const targetUrl = "https://SCHOOL.example:443/review/../audit";
    await request(app)
      .post("/api/security-scan")
      .send({ targetUrl, authorizationConfirmed: false })
      .expect(400);
    expect(scan).not.toHaveBeenCalled();

    await request(app)
      .post("/api/security-scan")
      .set("origin", "http://localhost:3000")
      .send({ targetUrl, authorizationConfirmed: true })
      .expect(200)
      .expect("Cache-Control", "no-store")
      .expect(({ body }) => expect(body.scan).toEqual(scanResult));
    expect(scan).toHaveBeenCalledWith(
      "https://school.example/audit",
      expect.stringMatching(/^scan_[A-Za-z0-9_-]+$/),
    );
  });

  it("accepts a trimmed request key, defaults its model, and never exposes the secret", async () => {
    const { app, scan, createSecurityScanSummarizer } = await setup();
    const secret = "sk-ant-request-only-secret";
    const response = await request(app)
      .post("/api/security-scan")
      .send({
        targetUrl: targetOrigin,
        authorizationConfirmed: true,
        anthropicApiKey: `  ${secret}  `,
      })
      .expect(200);

    expect(createSecurityScanSummarizer).toHaveBeenCalledWith({
      apiKey: secret,
      model: DEFAULT_ANTHROPIC_MODEL,
    });
    expect(scan).toHaveBeenCalledWith(
      `${targetOrigin}/`,
      expect.stringMatching(/^scan_[A-Za-z0-9_-]+$/),
    );
    expect(JSON.stringify(response.body)).not.toContain(secret);
    expect(response.body.scan.ai.status).toBe("used");
    expect(JSON.stringify(scan.mock.calls)).not.toContain(secret);

    const config = await request(app).get("/api/security-scan/config").expect(200);
    expect(JSON.stringify(config.body)).not.toContain(secret);
    expect(config.body).not.toHaveProperty("anthropicApiKey");
  });

  it("allows only the fixed Anthropic model list and rejects a model without a key", async () => {
    const { app, scan, createSecurityScanSummarizer } = await setup();
    await request(app)
      .post("/api/security-scan")
      .send({
        targetUrl: targetOrigin,
        authorizationConfirmed: true,
        anthropicModel: "claude-opus-5",
      })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID"));
    await request(app)
      .post("/api/security-scan")
      .send({
        targetUrl: targetOrigin,
        authorizationConfirmed: true,
        anthropicApiKey: "test-key",
        anthropicModel: "claude-unknown",
      })
      .expect(400);
    await request(app)
      .post("/api/security-scan")
      .send({
        targetUrl: targetOrigin,
        authorizationConfirmed: true,
        anthropicApiKey: "x".repeat(513),
      })
      .expect(400);
    expect(scan).not.toHaveBeenCalled();
    expect(createSecurityScanSummarizer).not.toHaveBeenCalled();
  });

  it.each([
    "claude-sonnet-5",
    "claude-haiku-4-5-20251001",
    "claude-opus-5",
  ] as const)("passes the allowed Anthropic model to the per-request factory: %s", async (model) => {
    const { app, createSecurityScanSummarizer } = await setup();
    await request(app)
      .post("/api/security-scan")
      .send({
        targetUrl: targetOrigin,
        authorizationConfirmed: true,
        anthropicApiKey: "test-key",
        anthropicModel: model,
      })
      .expect(200);
    expect(createSecurityScanSummarizer).toHaveBeenCalledWith({ apiKey: "test-key", model });
  });

  it("releases deterministic scan capacity before a bounded Anthropic summary", async () => {
    let markSummaryStarted: (() => void) | undefined;
    let finishSummary: (() => void) | undefined;
    let summarySignal: AbortSignal | undefined;
    const summaryStarted = new Promise<void>((resolve) => {
      markSummaryStarted = resolve;
    });
    const summaryBlocked = new Promise<void>((resolve) => {
      finishSummary = resolve;
    });
    const summarizer: SecurityScanSummarizer = async (_input, signal) => {
      summarySignal = signal;
      markSummaryStarted?.();
      await summaryBlocked;
      return { overview: "Anthropic 요약", priorityActions: [] };
    };
    const { app, scan, createSecurityScanSummarizer } = await setup({
      maxRequests: 4,
      summarizer,
    });

    const firstResponse = request(app)
      .post("/api/security-scan")
      .send({
        targetUrl: targetOrigin,
        authorizationConfirmed: true,
        anthropicApiKey: "first-key",
      });
    const firstPending = firstResponse.then((response) => response);
    await summaryStarted;

    const deterministicOnly = await request(app)
      .post("/api/security-scan")
      .send({ targetUrl: targetOrigin, authorizationConfirmed: true })
      .expect(200);
    expect(deterministicOnly.body.scan.ai.used).toBe(false);
    expect(deterministicOnly.body.scan.ai.status).toBe("not_requested");

    const aiCapacityFallback = await request(app)
      .post("/api/security-scan")
      .send({
        targetUrl: targetOrigin,
        authorizationConfirmed: true,
        anthropicApiKey: "second-key",
      })
      .expect(200);
    expect(aiCapacityFallback.body.scan.ai.used).toBe(false);
    expect(aiCapacityFallback.body.scan.ai.status).toBe("busy");
    expect(scan).toHaveBeenCalledTimes(3);
    expect(createSecurityScanSummarizer).toHaveBeenCalledTimes(1);
    expect(summarySignal).toBeInstanceOf(AbortSignal);

    finishSummary?.();
    const completedAi = (await firstPending).body.scan.ai;
    expect(completedAi.used).toBe(true);
    expect(completedAi.status).toBe("used");
  });

  it.each([
    ["Anthropic request failure", { summarizer: async () => { throw new Error("Anthropic failed"); } }],
    ["Anthropic client setup failure", { summarizerFactoryError: new Error("client setup failed") }],
  ] as const)("reports failed while preserving the deterministic result after %s", async (_label, options) => {
    const { app } = await setup(options);
    const response = await request(app)
      .post("/api/security-scan")
      .send({
        targetUrl: targetOrigin,
        authorizationConfirmed: true,
        anthropicApiKey: "test-key",
      })
      .expect(200);

    expect(response.body.scan.ai).toMatchObject({
      used: false,
      status: "failed",
      overview: scanResult.ai.overview,
    });
    expect(response.body.scan.findings).toEqual(scanResult.findings);
  });

  it("aborts an in-flight Anthropic summary when the client connection closes", async () => {
    let markSummaryStarted: (() => void) | undefined;
    let markSummaryAborted: (() => void) | undefined;
    const summaryStarted = new Promise<void>((resolve) => {
      markSummaryStarted = resolve;
    });
    const summaryAborted = new Promise<void>((resolve) => {
      markSummaryAborted = resolve;
    });
    const summarizer: SecurityScanSummarizer = async (_input, signal) => new Promise((_resolve, reject) => {
      markSummaryStarted?.();
      const abort = (): void => {
        markSummaryAborted?.();
        reject(new Error("client disconnected"));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
    const { app } = await setup({ summarizer });
    const runningRequest = request(app)
      .post("/api/security-scan")
      .send({
        targetUrl: targetOrigin,
        authorizationConfirmed: true,
        anthropicApiKey: "test-key",
      });
    runningRequest.end(() => undefined);

    await summaryStarted;
    runningRequest.abort();

    await summaryAborted;
  });

  it("rate limits public scans by client IP without putting the IP in the safety identifier", async () => {
    const { app, scan } = await setup({ maxRequests: 1 });
    const body = { targetUrl: targetOrigin, authorizationConfirmed: true };
    await request(app)
      .post("/api/security-scan")
      .set("x-forwarded-for", "198.51.100.10")
      .send(body)
      .expect(200);
    const firstSafetyIdentifier = scan.mock.calls[0]?.[1];
    expect(firstSafetyIdentifier).toMatch(/^scan_[A-Za-z0-9_-]+$/);
    expect(firstSafetyIdentifier).not.toContain("198.51.100.10");

    await request(app)
      .post("/api/security-scan")
      .set("x-forwarded-for", "198.51.100.10")
      .send(body)
      .expect(429)
      .expect("Retry-After", "60");
    await request(app)
      .post("/api/security-scan")
      .set("x-forwarded-for", "198.51.100.11")
      .send(body)
      .expect(200);
    expect(scan.mock.calls[1]?.[1]).not.toBe(firstSafetyIdentifier);
  });

  it("rejects a cross-origin public scan before calling the scanner", async () => {
    const { app, scan } = await setup();
    await request(app)
      .post("/api/security-scan")
      .set("origin", "https://attacker.example")
      .send({ targetUrl: targetOrigin, authorizationConfirmed: true })
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe("ORIGIN_NOT_ALLOWED"));
    expect(scan).not.toHaveBeenCalled();
  });

  it("exposes only non-sensitive capability flags to an authenticated administrator", async () => {
    const { app } = await setup();
    await request(app)
      .get("/api/admin/security-scan/config")
      .set("Origin", "https://blocked.example")
      .expect(403);
    await request(app).get("/api/admin/security-scan/config").expect(401);
    await request(app)
      .post("/api/admin/security-scan")
      .send({ targetUrl: targetOrigin, authorizationConfirmed: true })
      .expect(401);
    const agent = request.agent(app);
    await login(agent);
    const response = await agent
      .get("/api/admin/security-scan/config")
      .expect(200)
      .expect("Cache-Control", "no-store");

    expect(response.body).toEqual(securityScanConfigResponse(true));
  });

  it("requires CSRF and literal authorization confirmation before scanning a normalized path", async () => {
    const { app, scan } = await setup();
    const agent = request.agent(app);
    const csrf = await login(agent);
    const targetUrl = "https://SCHOOL.example:443/review/../audit";
    await agent
      .post("/api/admin/security-scan")
      .send({ targetUrl, authorizationConfirmed: true })
      .expect(403);
    await agent
      .post("/api/admin/security-scan")
      .set("x-csrf-token", csrf)
      .send({ targetUrl, authorizationConfirmed: false })
      .expect(400);
    expect(scan).not.toHaveBeenCalled();
    const response = await agent
      .post("/api/admin/security-scan")
      .set("x-csrf-token", csrf)
      .send({ targetUrl, authorizationConfirmed: true })
      .expect(200)
      .expect("Cache-Control", "no-store");
    expect(response.body.scan).toEqual(scanResult);
    expect(scan).toHaveBeenCalledWith(
      "https://school.example/audit",
      expect.stringMatching(/^scan_[A-Za-z0-9_-]+$/),
    );

    await agent
      .post("/api/admin/security-scan")
      .set("x-csrf-token", csrf)
      .send({ targetUrl, authorizationConfirmed: true, arbitraryUrl: "https://other.example" })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID"));
  });

  it("keeps the origin allowlist as the default fixed-target boundary", async () => {
    const { app, scan } = await setup({
      dynamicTargetsEnabled: false,
      allowedOrigins: new Set([targetOrigin]),
    });
    const agent = request.agent(app);
    const csrf = await login(agent);
    await agent
      .get("/api/admin/security-scan/config")
      .expect(200)
      .expect(({ body }) => expect(body.dynamicTargetInput).toBe(true));
    await agent
      .post("/api/admin/security-scan")
      .set("x-csrf-token", csrf)
      .send({ targetUrl: "https://other.example/path", authorizationConfirmed: true })
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe("SECURITY_SCAN_TARGET_NOT_ALLOWED"));
    expect(scan).not.toHaveBeenCalled();
  });

  it.each([
    "http://school.example/path",
    "https:school.example/path",
    "https://user:secret@school.example/path",
    "https://school.example/path?token=secret",
    "https://school.example/path?",
    "https://school.example/path#section",
    "https://school.example/path#",
    "https://127.0.0.1/path",
    "https://[::1]/path",
  ])("rejects an unsafe target URL before calling the scanner: %s", async (targetUrl) => {
    const { app, scan } = await setup();
    const agent = request.agent(app);
    const csrf = await login(agent);
    await agent
      .post("/api/admin/security-scan")
      .set("x-csrf-token", csrf)
      .send({ targetUrl, authorizationConfirmed: true })
      .expect(422)
      .expect(({ body }) => expect(body.error.code).toBe("SECURITY_SCAN_TARGET_BLOCKED"));
    expect(scan).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin browser request before calling the scanner", async () => {
    const { app, scan } = await setup();
    const agent = request.agent(app);
    const csrf = await login(agent);
    await agent
      .post("/api/admin/security-scan")
      .set("origin", "https://attacker.example")
      .set("x-csrf-token", csrf)
      .send({ targetUrl: targetOrigin, authorizationConfirmed: true })
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe("ORIGIN_NOT_ALLOWED"));
    expect(scan).not.toHaveBeenCalled();
  });

  it("returns a bounded rate-limit response", async () => {
    const { app } = await setup({ maxRequests: 1 });
    const agent = request.agent(app);
    const csrf = await login(agent);
    const body = { targetUrl: targetOrigin, authorizationConfirmed: true };
    await agent.post("/api/admin/security-scan").set("x-csrf-token", csrf).send(body).expect(200);
    await agent
      .post("/api/admin/security-scan")
      .set("x-csrf-token", csrf)
      .send(body)
      .expect(429)
      .expect("Retry-After", "60")
      .expect(({ body }) => expect(body.error.code).toBe("SECURITY_SCAN_RATE_LIMITED"));
  });

  it("is disabled when the operator has not approved a target", async () => {
    const { app } = await setup({ enabled: false });
    await request(app).get("/api/security-scan/config").expect(200, securityScanConfigResponse(false));
    await request(app)
      .post("/api/security-scan")
      .send({ targetUrl: targetOrigin, authorizationConfirmed: true })
      .expect(503)
      .expect(({ body }) => expect(body.error.code).toBe("SECURITY_SCAN_DISABLED"));
    const agent = request.agent(app);
    const csrf = await login(agent);
    const config = await agent.get("/api/admin/security-scan/config").expect(200);
    expect(config.body).toEqual(securityScanConfigResponse(false));
    await agent
      .post("/api/admin/security-scan")
      .set("x-csrf-token", csrf)
      .send({ targetUrl: targetOrigin, authorizationConfirmed: true })
      .expect(503)
      .expect(({ body }) => expect(body.error.code).toBe("SECURITY_SCAN_DISABLED"));
  });
});
