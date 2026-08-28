import { readFile } from "node:fs/promises";
import { parse } from "dotenv";
import request from "supertest";
import { createApp } from "../../src/app.js";
import {
  FixtureSourceProvider,
  InMemoryCertificationRepository,
  TEST_COMMIT,
  makeTestConfig,
} from "../helpers/test-fixtures.js";

const VITE_ORIGIN = "http://localhost:5174";

describe("Vite review UI and certification server origin", () => {
  it("keeps the checked-in local example aligned with the browser-visible Vite origin", async () => {
    const contents = await readFile(new URL("../../.env.example", import.meta.url), "utf8");
    const environment = parse(contents);

    expect(environment.BADGE_PUBLIC_BASE_URL).toBe(VITE_ORIGIN);
    expect(environment.BADGE_ALLOWED_ORIGINS?.split(",").map((origin) => origin.trim())).toContain(VITE_ORIGIN);
  });

  it("accepts a proxied badge request whose Origin is the configured Vite application origin", async () => {
    const config = await makeTestConfig({
      publicBaseUrl: VITE_ORIGIN,
      allowedOrigins: new Set([VITE_ORIGIN]),
    });
    const app = createApp({
      config,
      repository: new InMemoryCertificationRepository(),
      sourceProvider: new FixtureSourceProvider(),
    });

    await request(app)
      .post("/api/badges/issue")
      .set("Origin", VITE_ORIGIN)
      .send({
        repositoryUrl: "https://github.com/example/education-service",
        commitSha: TEST_COMMIT,
      })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("NO_ACTIVE_POLICY"));
  });
});
