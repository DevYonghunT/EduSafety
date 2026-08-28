import request from "supertest";
import { createApp } from "../../src/app.js";
import { CRITERIA_CATALOG, RULESET_VERSION } from "../../src/certification/catalog.js";
import { createPolicySnapshot } from "../../src/certification/policy.js";
import { PolicyService } from "../../src/certification/policy-service.js";
import {
  FixtureSourceProvider,
  InMemoryCertificationRepository,
  makeTestConfig,
} from "../helpers/test-fixtures.js";

async function setup() {
  const config = await makeTestConfig();
  const repository = new InMemoryCertificationRepository();
  const sourceProvider = new FixtureSourceProvider();
  const app = createApp({ config, repository, sourceProvider });
  return { config, repository, sourceProvider, app };
}

async function login(agent: ReturnType<typeof request.agent>) {
  const response = await agent.post("/api/admin/session").send({
    username: "admin@example.test",
    password: "test administrator password",
  });
  expect(response.status).toBe(200);
  const session = await agent.get("/api/admin/session");
  expect(session.status).toBe(200);
  return session.body.csrfToken as string;
}

describe("administrator authentication and policy API", () => {
  it("protects the administrator page and every certification API", async () => {
    const { app } = await setup();
    await request(app).get("/admin/certification").expect(303).expect("Location", "/admin/login");
    await request(app).get("/admin-certification.html").expect(303).expect("Location", "/admin/login");
    await request(app).get("/api/admin/certification/criteria").expect(401);
    await request(app).get("/api/admin/certification/policies").expect(401);
    await request(app).get("/api/admin/certification/badges").expect(401);
  });

  it("rejects invalid credentials and a mutation without CSRF", async () => {
    const { app } = await setup();
    const agent = request.agent(app);
    await agent
      .post("/api/admin/session")
      .send({ username: "admin@example.test", password: "incorrect" })
      .expect(401);
    await login(agent);
    await agent
      .post("/api/admin/certification/policies")
      .send({ name: "정책" })
      .expect(403);
  });

  it("lists compiled criteria and locked safety blockers", async () => {
    const { app } = await setup();
    const agent = request.agent(app);
    await login(agent);
    const response = await agent.get("/api/admin/certification/criteria").expect(200);
    expect(response.body.criteria[0]).toEqual(
      expect.objectContaining({
        criterionId: expect.any(String),
        evaluatorKey: expect.any(String),
        requiredByRuleset: true,
      }),
    );
    expect(response.body.criteria).toHaveLength(CRITERIA_CATALOG.length);
    expect(response.body.criteria.every((criterion: { requiredByRuleset: boolean }) => criterion.requiredByRuleset)).toBe(true);
    expect(response.body.safetyBlockers).toHaveLength(7);
    expect(response.body.safetyBlockers.every((blocker: { locked: boolean }) => blocker.locked)).toBe(true);
  });

  it("creates, edits and publishes a non-empty policy with audit history", async () => {
    const { app, repository } = await setup();
    const agent = request.agent(app);
    const csrf = await login(agent);
    const created = await agent
      .post("/api/admin/certification/policies")
      .set("x-csrf-token", csrf)
      .send({ name: "초안" })
      .expect(201);
    expect(created.body.policy.snapshot.criteria).toHaveLength(CRITERIA_CATALOG.length);
    expect(created.body.policy.snapshot.criteria.map((criterion: { criterionId: string }) => criterion.criterionId).sort()).toEqual(
      CRITERIA_CATALOG.map((criterion) => criterion.criterionId).sort(),
    );
    const policyId = created.body.policy.snapshot.policyId as string;
    const updated = await agent
      .put(`/api/admin/certification/policies/${policyId}`)
      .set("x-csrf-token", csrf)
      .send({ name: "발행 기준" })
      .expect(200);
    expect(updated.body.policy.snapshot.criteria).toHaveLength(CRITERIA_CATALOG.length);
    const published = await agent
      .post(`/api/admin/certification/policies/${policyId}/publish`)
      .set("x-csrf-token", csrf)
      .send({})
      .expect(200);
    expect(published.body.policy.status).toBe("ACTIVE");
    expect(repository.audits.map((entry) => entry.action)).toEqual([
      "POLICY_CREATED",
      "POLICY_UPDATED",
      "POLICY_PUBLISHED",
    ]);
    await agent
      .put(`/api/admin/certification/policies/${policyId}`)
      .set("x-csrf-token", csrf)
      .send({ name: "수정 시도" })
      .expect(409);
  });

  it("rejects client-selected criteria and fails closed when a required DB criterion is unavailable", async () => {
    const { app, repository } = await setup();
    const agent = request.agent(app);
    const csrf = await login(agent);
    await agent
      .post("/api/admin/certification/policies")
      .set("x-csrf-token", csrf)
      .send({ name: "부분 선택 시도", criterionIds: ["no-hardcoded-secrets"] })
      .expect(400);
    await agent
      .post("/api/admin/certification/policies")
      .set("x-csrf-token", csrf)
      .send({ name: "필드 주입 시도", criteria: [], selectedCriteria: [], safetyBlockers: [] })
      .expect(400);
    repository.criteria[0] = { ...repository.criteria[0]!, active: false };
    await agent
      .post("/api/admin/certification/policies")
      .set("x-csrf-token", csrf)
      .send({ name: "비활성 필수 항목" })
      .expect(422)
      .expect(({ body }) => expect(body.error.code).toBe("REQUIRED_CRITERIA_UNAVAILABLE"));
  });

  it("archives the previous active policy when a new version is published", async () => {
    const { app, repository } = await setup();
    const agent = request.agent(app);
    const csrf = await login(agent);
    const ids: string[] = [];
    for (const name of ["v1", "v2"]) {
      const created = await agent
        .post("/api/admin/certification/policies")
        .set("x-csrf-token", csrf)
        .send({ name });
      ids.push(created.body.policy.snapshot.policyId as string);
      await agent
        .post(`/api/admin/certification/policies/${ids.at(-1)}/publish`)
        .set("x-csrf-token", csrf)
        .send({});
    }
    expect([...repository.policies.values()].filter((policy) => policy.status === "ACTIVE")).toHaveLength(1);
    expect((await repository.getPolicy(ids[0]!))?.status).toBe("ARCHIVED");
    expect((await repository.getPolicy(ids[1]!))?.status).toBe("ACTIVE");
  });

  it("rejects every cross-origin administrator API caller", async () => {
    const { app } = await setup();
    await request(app).get("/api/admin/session").set("Origin", "https://blocked.example").expect(403);
    await request(app)
      .get("/api/admin/session")
      .set("Origin", "https://allowed.example")
      .expect(403)
      .expect(({ headers }) => expect(headers["access-control-allow-origin"]).toBeUndefined());
    await request(app).get("/api/admin/session").set("Origin", "http://localhost:3000").expect(401);
  });
});

describe("active policy requirement", () => {
  it("rejects issuance when no active policy exists", async () => {
    const { app } = await setup();
    await request(app)
      .post("/api/badges/issue")
      .send({ repositoryUrl: "https://github.com/example/education-service", commitSha: "0123456789abcdef0123456789abcdef01234567" })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("NO_ACTIVE_POLICY"));
  });

  it("pins the active snapshot before source collection", async () => {
    const config = await makeTestConfig();
    const repository = new InMemoryCertificationRepository();
    const service = new PolicyService(repository);
    const first = await service.createDraft({
      name: "고정 정책",
      administratorId: "admin",
    });
    await service.publish(first.snapshot.policyId, "admin");
    const replacement = await service.createDraft({
      name: "새 정책",
      administratorId: "admin",
    });
    const sourceProvider = new FixtureSourceProvider();
    const originalCollect = sourceProvider.collect.bind(sourceProvider);
    sourceProvider.collect = async (...args) => {
      await service.publish(replacement.snapshot.policyId, "admin");
      return originalCollect(...args);
    };
    const app = createApp({ config, repository, sourceProvider });
    const response = await request(app)
      .post("/api/badges/issue")
      .send({ repositoryUrl: "https://github.com/example/education-service", commitSha: "0123456789abcdef0123456789abcdef01234567" })
      .expect(201);
    expect(response.body.badge.policy.policyId).toBe(first.snapshot.policyId);
    expect((await repository.getActivePolicy())?.snapshot.policyId).toBe(replacement.snapshot.policyId);
  });

  it("rejects a legacy subset active policy before repository resolution or analysis", async () => {
    const config = await makeTestConfig();
    const repository = new InMemoryCertificationRepository();
    const sourceProvider = new FixtureSourceProvider();
    const snapshot = createPolicySnapshot({
      policyId: "1b037a31-6492-4653-a5bd-d17582ff40e4",
      name: "레거시 부분 정책",
      policyVersion: 1,
      rulesetVersion: RULESET_VERSION,
      criteria: [CRITERIA_CATALOG[0]!],
    });
    await repository.createDraftPolicy({
      snapshot,
      status: "DRAFT",
      createdBy: "legacy-admin",
      createdAt: "2026-08-28T00:00:00.000Z",
      publishedAt: null,
      archivedAt: null,
    });
    await repository.publishPolicy(snapshot.policyId, "legacy-admin", "2026-08-28T00:00:00.000Z");
    const app = createApp({ config, repository, sourceProvider });

    await request(app)
      .post("/api/badges/issue")
      .send({
        repositoryUrl: "https://github.com/example/education-service",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
      })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("ACTIVE_POLICY_INCOMPATIBLE"));
    expect(sourceProvider.resolveCalls).toBe(0);
    expect(sourceProvider.collectCalls).toBe(0);
  });
});

describe("administrator revocation", () => {
  it("records a single revocation and audit entry through the protected API", async () => {
    const { app, repository } = await setup();
    const policyService = new PolicyService(repository);
    const draft = await policyService.createDraft({
      name: "취소 테스트 정책",
      administratorId: "test-administrator",
    });
    await policyService.publish(draft.snapshot.policyId, "test-administrator");
    const issued = await request(app)
      .post("/api/badges/issue")
      .send({
        repositoryUrl: "https://github.com/example/education-service",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
      })
      .expect(201);
    const agent = request.agent(app);
    const csrf = await login(agent);
    const uid = issued.body.badge.uid as string;
    const first = await agent
      .post(`/api/admin/certification/badges/${uid}/revoke`)
      .set("x-csrf-token", csrf)
      .send({ reason: "SECURITY_REVIEW" })
      .expect(200);
    expect(first.body.badge.status).toBe("REVOKED");
    expect(first.body.alreadyRevoked).toBe(false);
    const second = await agent
      .post(`/api/admin/certification/badges/${uid}/revoke`)
      .set("x-csrf-token", csrf)
      .send({ reason: "SECURITY_REVIEW" })
      .expect(200);
    expect(second.body.alreadyRevoked).toBe(true);
    expect(repository.audits.filter((entry) => entry.action === "BADGE_REVOKED")).toHaveLength(1);
  });

  it("rejects a free-form revocation reason", async () => {
    const { app } = await setup();
    const agent = request.agent(app);
    const csrf = await login(agent);
    await agent
      .post(`/api/admin/certification/badges/0x${"00".repeat(32)}/revoke`)
      .set("x-csrf-token", csrf)
      .send({ reason: "arbitrary text" })
      .expect(400);
  });
});
