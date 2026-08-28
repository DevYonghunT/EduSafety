import request from "supertest";
import { createApp, type AppSecurityLimits } from "../../src/app.js";
import { PolicyService } from "../../src/certification/policy-service.js";
import {
  FixtureSourceProvider,
  InMemoryCertificationRepository,
  TEST_COMMIT,
  makeTestConfig,
} from "../helpers/test-fixtures.js";

const validIssueRequest = {
  repositoryUrl: "https://github.com/example/education-service",
  commitSha: TEST_COMMIT,
};

async function setup(options: {
  readonly securityLimits?: Partial<AppSecurityLimits>;
  readonly now?: () => Date;
  readonly activePolicy?: boolean;
  readonly authenticateAdmin?: (username: string, password: string) => Promise<boolean>;
}) {
  const config = await makeTestConfig();
  const repository = new InMemoryCertificationRepository();
  const sourceProvider = new FixtureSourceProvider();
  if (options.activePolicy) {
    const policyService = new PolicyService(repository, options.now);
    const draft = await policyService.createDraft({
      name: "HTTP 보안 경계 정책",
      criterionIds: ["dependency-lockfile-present"],
      administratorId: "admin",
    });
    await policyService.publish(draft.snapshot.policyId, "admin");
  }
  const app = createApp({
    config,
    repository,
    sourceProvider,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.securityLimits === undefined ? {} : { securityLimits: options.securityLimits }),
    ...(options.authenticateAdmin === undefined ? {} : { authenticateAdmin: options.authenticateAdmin }),
  });
  return { app, repository, sourceProvider };
}

describe("API origin boundaries", () => {
  it("allows only configured public badge origins without credentialed CORS", async () => {
    const { app } = await setup({ activePolicy: false });
    const preflight = await request(app)
      .options("/api/badges/issue")
      .set("Origin", "https://allowed.example")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "Content-Type")
      .expect(204)
      .expect("Access-Control-Allow-Origin", "https://allowed.example")
      .expect("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    expect(preflight.headers["access-control-allow-credentials"]).toBeUndefined();
    await request(app)
      .get(`/api/badges/0x${"00".repeat(32)}`)
      .set("Origin", "https://allowed.example")
      .expect(404)
      .expect("Access-Control-Allow-Origin", "https://allowed.example");

    await request(app)
      .options("/api/badges/issue")
      .set("Origin", "https://allowed.example")
      .set("Access-Control-Request-Method", "DELETE")
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe("CORS_PREFLIGHT_NOT_ALLOWED"));
    await request(app)
      .get(`/api/badges/0x${"00".repeat(32)}`)
      .set("Origin", "https://blocked.example")
      .expect(403);
  });

  it("never enables cross-origin access to administrator APIs", async () => {
    const { app } = await setup({ activePolicy: false });
    const denied = await request(app)
      .get("/api/admin/session")
      .set("Origin", "https://allowed.example")
      .expect(403);
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    await request(app)
      .get("/api/admin/session")
      .set("Origin", "http://localhost:3000")
      .expect(401);
  });
});

describe("administrator login admission", () => {
  const loginWindowMs = 60_000;

  it("limits attempts by client IP before another password hash is admitted", async () => {
    const fixedNow = new Date("2026-08-28T00:00:00.000Z");
    const { app } = await setup({
      activePolicy: false,
      now: () => fixedNow,
      securityLimits: {
        loginMaxAttemptsPerIp: 2,
        loginMaxAttemptsPerAccount: 100,
        loginWindowMs,
      },
    });
    for (const username of ["unknown-one", "unknown-two"]) {
      await request(app)
        .post("/api/admin/session")
        .set("X-Forwarded-For", "203.0.113.10")
        .send({ username, password: "incorrect" })
        .expect(401);
    }
    await request(app)
      .post("/api/admin/session")
      .set("X-Forwarded-For", "203.0.113.10")
      .send({ username: "unknown-three", password: "incorrect" })
      .expect(429)
      .expect("Retry-After", "60")
      .expect(({ body }) => expect(body.error.code).toBe("ADMIN_LOGIN_RATE_LIMITED"));
  });

  it("limits one account across distinct client IPs and resets deterministically", async () => {
    let currentTime = Date.parse("2026-08-28T00:00:00.000Z");
    const { app } = await setup({
      activePolicy: false,
      now: () => new Date(currentTime),
      securityLimits: {
        loginMaxAttemptsPerIp: 100,
        loginMaxAttemptsPerAccount: 2,
        loginWindowMs,
      },
    });
    for (const address of ["203.0.113.11", "203.0.113.12"]) {
      await request(app)
        .post("/api/admin/session")
        .set("X-Forwarded-For", address)
        .send({ username: "admin@example.test", password: "incorrect" })
        .expect(401);
    }
    await request(app)
      .post("/api/admin/session")
      .set("X-Forwarded-For", "203.0.113.13")
      .send({ username: "admin@example.test", password: "incorrect" })
      .expect(429)
      .expect("Retry-After", "60");

    currentTime += loginWindowMs + 1;
    await request(app)
      .post("/api/admin/session")
      .set("X-Forwarded-For", "203.0.113.13")
      .send({ username: "admin@example.test", password: "incorrect" })
      .expect(401);
  });

  it("bounds concurrent password verification across rotating IP and account keys", async () => {
    let signalStarted: (() => void) | undefined;
    let releaseAuthentication: (() => void) | undefined;
    let blockAuthentication = true;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseAuthentication = resolve;
    });
    const { app } = await setup({
      activePolicy: false,
      securityLimits: {
        loginMaxConcurrent: 1,
        loginMaxAttemptsPerIp: 100,
        loginMaxAttemptsPerAccount: 100,
      },
      authenticateAdmin: async () => {
        signalStarted?.();
        if (blockAuthentication) await blocked;
        return false;
      },
    });
    const first = request(app)
      .post("/api/admin/session")
      .set("X-Forwarded-For", "203.0.113.41")
      .send({ username: "rotating-one", password: "incorrect" })
      .then((response) => response);
    await started;
    await request(app)
      .post("/api/admin/session")
      .set("X-Forwarded-For", "203.0.113.42")
      .send({ username: "rotating-two", password: "incorrect" })
      .expect(429)
      .expect("Retry-After", "1")
      .expect(({ body }) => expect(body.error.code).toBe("ADMIN_LOGIN_RATE_LIMITED"));

    blockAuthentication = false;
    releaseAuthentication?.();
    expect((await first).status).toBe(401);
    await request(app)
      .post("/api/admin/session")
      .set("X-Forwarded-For", "203.0.113.43")
      .send({ username: "rotating-three", password: "incorrect" })
      .expect(401);
  });
});

describe("public issue admission", () => {
  it("uses the nearest untrusted forwarded address instead of a spoofable left-most value", async () => {
    const fixedNow = new Date("2026-08-28T00:00:00.000Z");
    const { app } = await setup({
      activePolicy: true,
      now: () => fixedNow,
      securityLimits: { issueMaxRequestsPerIp: 1, issueWindowMs: 60_000 },
    });
    await request(app)
      .post("/api/badges/issue")
      .set("X-Forwarded-For", "198.51.100.1, 203.0.113.20")
      .send(validIssueRequest)
      .expect(201);
    await request(app)
      .post("/api/badges/issue")
      .set("X-Forwarded-For", "198.51.100.2, 203.0.113.20")
      .send(validIssueRequest)
      .expect(429)
      .expect("Retry-After", "60")
      .expect(({ body }) => expect(body.error.code).toBe("ISSUE_RATE_LIMITED"));
    await request(app)
      .post("/api/badges/issue")
      .set("X-Forwarded-For", "198.51.100.2, 203.0.113.21")
      .send(validIssueRequest)
      .expect(200);
  });

  it("rejects excess global concurrency without creating an unbounded queue", async () => {
    const fixture = await setup({
      activePolicy: true,
      securityLimits: { issueMaxConcurrent: 1, issueMaxRequestsPerIp: 100 },
    });
    const originalCollect = fixture.sourceProvider.collect.bind(fixture.sourceProvider);
    let signalStarted: (() => void) | undefined;
    let releaseCollection: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseCollection = resolve;
    });
    fixture.sourceProvider.collect = async (...args) => {
      signalStarted?.();
      await blocked;
      return originalCollect(...args);
    };

    const first = request(fixture.app)
      .post("/api/badges/issue")
      .set("X-Forwarded-For", "203.0.113.31")
      .send(validIssueRequest)
      .then((response) => response);
    await started;
    await request(fixture.app)
      .post("/api/badges/issue")
      .set("X-Forwarded-For", "203.0.113.32")
      .send(validIssueRequest)
      .expect(429)
      .expect("Retry-After", "1")
      .expect(({ body }) => expect(body.error.code).toBe("ISSUE_CAPACITY_EXCEEDED"));

    releaseCollection?.();
    expect((await first).status).toBe(201);
    await request(fixture.app)
      .post("/api/badges/issue")
      .set("X-Forwarded-For", "203.0.113.33")
      .send(validIssueRequest)
      .expect(200);
  });
});
