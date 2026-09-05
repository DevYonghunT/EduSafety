import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { InMemoryReviewRepository } from "../../src/db/review-repository.js";
import { FixtureSourceProvider, InMemoryCertificationRepository, makeTestConfig } from "../helpers/test-fixtures.js";

async function setup() {
  const config = await makeTestConfig();
  const reviewRepository = new InMemoryReviewRepository();
  const app = createApp({
    config,
    repository: new InMemoryCertificationRepository(),
    sourceProvider: new FixtureSourceProvider(),
    reviewRepository,
  });
  return { app, reviewRepository };
}

async function login(agent: ReturnType<typeof request.agent>) {
  await agent.post("/api/admin/session").send({ username: "admin@example.test", password: "test administrator password" }).expect(200);
  const session = await agent.get("/api/admin/session").expect(200);
  return session.body.csrfToken as string;
}

const record = {
  target: "user/app",
  commitSha: "0123456789ABCDEF0123456789abcdef01234567",
  status: "hold",
  rubricVersion: "core-1",
  protectionLevel: "L1",
  profile: "학생 대면 · 개인정보 수집",
  record: { counts: { ok: 3, fail: 0, needs_human: 5, na: 1 }, applicableItems: 9 },
};

describe("review records API (서버 심사 대장)", () => {
  it("requires an administrator session and CSRF", async () => {
    const { app } = await setup();
    await request(app).get("/api/reviews").expect(401);
    await request(app).post("/api/reviews").send(record).expect(401);
    const agent = request.agent(app);
    await login(agent);
    await agent.post("/api/reviews").send(record).expect(403);
  });

  it("stores records, links re-reviews of the same target by round, and lists newest first", async () => {
    const { app } = await setup();
    const agent = request.agent(app);
    const csrf = await login(agent);
    const first = await agent.post("/api/reviews").set("x-csrf-token", csrf).send(record).expect(201);
    expect(first.body.record).toMatchObject({ target: "user/app", round: 1, commitSha: "0123456789abcdef0123456789abcdef01234567", recordedBy: expect.any(String) });
    const second = await agent.post("/api/reviews").set("x-csrf-token", csrf).send({ ...record, status: "pass_candidate" }).expect(201);
    expect(second.body.record.round).toBe(2);
    const list = await agent.get("/api/reviews").expect(200);
    expect(list.body.records.map((r: { round: number }) => r.round)).toEqual([2, 1]);
  });

  it("rejects malformed records", async () => {
    const { app } = await setup();
    const agent = request.agent(app);
    const csrf = await login(agent);
    await agent.post("/api/reviews").set("x-csrf-token", csrf).send({ ...record, status: "passed" }).expect(400);
    await agent.post("/api/reviews").set("x-csrf-token", csrf).send({ ...record, commitSha: "abc" }).expect(400);
  });
});
