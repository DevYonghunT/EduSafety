import request from "supertest";
import { createApp } from "../../src/app.js";
import { PolicyService } from "../../src/certification/policy-service.js";
import {
  FixtureSourceProvider,
  InMemoryCertificationRepository,
  TEST_COMMIT,
  makeTestConfig,
  sourceFile,
} from "../helpers/test-fixtures.js";

async function setupActive() {
  const config = await makeTestConfig();
  const repository = new InMemoryCertificationRepository();
  const sourceProvider = new FixtureSourceProvider();
  const policyService = new PolicyService(repository);
  const draft = await policyService.createDraft({
    name: "발급 정책",
    administratorId: "admin",
  });
  await policyService.publish(draft.snapshot.policyId, "admin");
  return { config, repository, sourceProvider, app: createApp({ config, repository, sourceProvider }) };
}

const validRequest = {
  repositoryUrl: "https://github.com/example/education-service",
  commitSha: TEST_COMMIT,
};

describe("badge issue API", () => {
  it("issues once and returns a complete public proof", async () => {
    const { app, repository } = await setupActive();
    const response = await request(app).post("/api/badges/issue").send(validRequest).expect(201);
    expect(response.body.outcome).toBe("ISSUED");
    expect(response.body.badge).toEqual(
      expect.objectContaining({
        status: "VALID",
        commitSha: TEST_COMMIT,
        proof: expect.objectContaining({
          domain: expect.any(Object),
          types: expect.any(Object),
          primaryType: "Attest",
          signature: expect.stringMatching(/^0x/),
          uid: expect.stringMatching(/^0x[0-9a-f]{64}$/),
          canonicalPayload: expect.any(String),
        }),
      }),
    );
    expect(repository.badges).toHaveLength(1);
    expect(repository.analyses).toHaveLength(1);
    expect(JSON.stringify(response.body)).not.toContain("attesterPrivateKey");
  });

  it.each([
    "score",
    "level",
    "badgeLevel",
    "decision",
    "criteria",
    "selectedCriteria",
    "criteriaResults",
    "reportHash",
    "criteriaHash",
    "policyHash",
    "policyVersion",
    "rulesetVersion",
    "signature",
    "UID",
    "uid",
    "attester",
    "repositoryId",
    "canonicalRepositoryUrl",
    "unexpected",
  ])("rejects the entire request when %s is injected", async (field) => {
    const { app, sourceProvider } = await setupActive();
    await request(app)
      .post("/api/badges/issue")
      .send({ ...validRequest, [field]: "client-controlled" })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID"));
    expect(sourceProvider.collectCalls).toBe(0);
  });

  it("rejects an oversized request before analysis", async () => {
    const { app, sourceProvider } = await setupActive();
    const response = await request(app)
      .post("/api/badges/issue")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ ...validRequest, padding: "x".repeat(20_000) }))
      .expect(413);
    expect(response.body.error.code).toBe("REQUEST_TOO_LARGE");
    expect(sourceProvider.collectCalls).toBe(0);
  });

  it("returns no UID or signature when a required item fails", async () => {
    const setup = await setupActive();
    setup.sourceProvider.collection = {
      ...setup.sourceProvider.collection,
      files: [sourceFile("package.json", '{"name":"missing-lock"}')],
    };
    const response = await request(setup.app).post("/api/badges/issue").send(validRequest).expect(200);
    expect(response.body.outcome).toBe("NOT_ISSUED");
    expect(
      response.body.criteria.find(
        (criterion: { criterionId: string }) => criterion.criterionId === "dependency-lockfile-present",
      )?.result,
    ).toBe("FAIL");
    expect(JSON.stringify(response.body)).not.toMatch(/"(?:uid|signature)"/i);
    expect(setup.repository.badges).toHaveLength(0);
  });

  it("never signs when an always-on safety check blocks issuance", async () => {
    const setup = await setupActive();
    setup.sourceProvider.collection = {
      ...setup.sourceProvider.collection,
      files: [
        sourceFile("package.json", '{"name":"safe"}'),
        sourceFile("package-lock.json", "{}"),
        sourceFile("runner.ts", "eval(untrustedInput);"),
      ],
    };
    const response = await request(setup.app).post("/api/badges/issue").send(validRequest).expect(200);
    expect(response.body.outcome).toBe("NOT_ISSUED");
    expect(response.body.safetyBlockers).toContainEqual(
      expect.objectContaining({ blockerId: "critical_finding", triggered: true }),
    );
    expect(setup.repository.badges).toHaveLength(0);
  });

  it("returns the same stored certification for a duplicate request", async () => {
    const { app, repository, sourceProvider } = await setupActive();
    const first = await request(app).post("/api/badges/issue").send(validRequest).expect(201);
    const collectedAfterFirstIssue = sourceProvider.collectCalls;
    const second = await request(app).post("/api/badges/issue").send(validRequest).expect(200);
    expect(second.body.existing).toBe(true);
    expect(second.body.badge.uid).toBe(first.body.badge.uid);
    expect(repository.badges).toHaveLength(1);
    expect(repository.analyses).toHaveLength(1);
    expect(sourceProvider.collectCalls).toBe(collectedAfterFirstIssue);
  });

  it("serves verification JSON and showcase SVG without explorer or transaction fields", async () => {
    const { app } = await setupActive();
    const issued = await request(app).post("/api/badges/issue").send(validRequest).expect(201);
    const uid = issued.body.badge.uid as string;
    const verified = await request(app).get(`/api/badges/${uid}`).expect(200);
    expect(verified.body.badge.status).toBe("VALID");
    expect(JSON.stringify(verified.body)).not.toMatch(/explorer|transactionHash/i);
    const svg = await request(app).get(`/api/badges/${uid}.svg?variant=showcase`).expect(200);
    expect(svg.headers["content-type"]).toMatch(/image\/svg\+xml/);
    const svgText = Buffer.isBuffer(svg.body) ? svg.body.toString("utf8") : String(svg.text);
    expect(svgText).toContain("EAS SIGNED · GASLESS");
    expect(svgText).toContain(TEST_COMMIT.slice(0, 7));
  });

  it("does not treat an unknown UID as valid", async () => {
    const { app } = await setupActive();
    await request(app).get(`/api/badges/0x${"00".repeat(32)}`).expect(404);
  });

  it("distinguishes a database outage from an absent UID", async () => {
    const setup = await setupActive();
    setup.repository.getBadge = () => Promise.reject(new Error("database unavailable"));
    const response = await request(setup.app).get(`/api/badges/0x${"00".repeat(32)}`).expect(503);
    expect(response.body.status).toBe("UNVERIFIED");
    expect(response.body.error.code).toBe("VERIFICATION_DATA_UNAVAILABLE");
  });
});
