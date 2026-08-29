import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createVercelExpressHandler,
  restoreVercelRequestUrl,
  VERCEL_PATH_QUERY,
  VERCEL_ROUTE_QUERY,
} from "../../src/http/vercel-adapter.js";

interface VercelRewrite {
  source: string;
  destination: string;
}

interface VercelConfig {
  framework: string;
  outputDirectory: string;
  buildCommand: string;
  rewrites: VercelRewrite[];
}

interface PackageJson {
  scripts: Record<string, string>;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

describe("Vercel Express adapter", () => {
  it("restores the original Express path while preserving the user's query", () => {
    const request = {
      url: `/api?${VERCEL_PATH_QUERY}=${encodeURIComponent("/api/badges/0x" + "a".repeat(64) + ".svg")}&${VERCEL_ROUTE_QUERY}=badges%2Fuid.svg&variant=showcase`,
    };

    expect(restoreVercelRequestUrl(request)).toBe(true);
    expect(request.url).toBe(`/api/badges/0x${"a".repeat(64)}.svg?variant=showcase`);
  });

  it("rejects missing, external, and non-server rewrite targets", () => {
    for (const url of [
      "/api",
      `/api?${VERCEL_PATH_QUERY}=https%3A%2F%2Fevil.example%2Fapi`,
      `/api?${VERCEL_PATH_QUERY}=%2Fassets%2Findex.js`,
    ]) {
      expect(restoreVercelRequestUrl({ url })).toBe(false);
    }
  });

  it("uses only standard ServerResponse methods before Express is bootstrapped", async () => {
    const getApplication = vi.fn();
    const setHeader = vi.fn();
    const end = vi.fn();
    const response = {
      statusCode: 0,
      setHeader,
      end,
    } as unknown as ServerResponse;

    await createVercelExpressHandler(getApplication)(
      { url: "/api" } as IncomingMessage,
      response,
    );

    expect(getApplication).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(404);
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "application/json; charset=utf-8");
    expect(end).toHaveBeenCalledWith(expect.stringContaining('"code":"NOT_FOUND"'));
  });

  it("does not bootstrap the server for static demo, login, or verification paths", async () => {
    const getApplication = vi.fn();
    const handler = createVercelExpressHandler(getApplication);
    const forwardedPaths = [
      "/demo",
      "/admin/login",
      `/verify/0x${"a".repeat(64)}`,
    ];

    for (const forwardedPath of forwardedPaths) {
      const response = {
        statusCode: 0,
        setHeader: vi.fn(),
        end: vi.fn(),
      } as unknown as ServerResponse;
      await handler(
        {
          url: `/api?${VERCEL_PATH_QUERY}=${encodeURIComponent(forwardedPath)}`,
        } as IncomingMessage,
        response,
      );
      expect(response.statusCode).toBe(404);
    }

    expect(getApplication).not.toHaveBeenCalled();
  });

  it("routes every dynamic production surface through the single adapter", async () => {
    const config = parseJson<VercelConfig>(
      await readFile(new URL("../../vercel.json", import.meta.url), "utf8"),
    );
    const sources = config.rewrites.map((rewrite) => rewrite.source);

    expect(config.framework).toBe("vite");
    expect(config.outputDirectory).toBe("client-dist");
    expect(config.buildCommand).toBe("npm run build:client");
    expect(sources).toEqual(expect.arrayContaining([
      "/api",
      "/api/:__edusafety_route*",
      "/health",
      "/admin/certification",
      "/admin-certification",
      "/admin-certification.html",
    ]));
    expect(sources).not.toContain("/demo");
    const rewritesBySource = new Map(
      config.rewrites.map((rewrite) => [rewrite.source, rewrite.destination]),
    );
    expect(rewritesBySource.get("/admin/login")).toBe("/admin-login");
    expect(rewritesBySource.get("/verify/:uid")).toBe("/verify");
    for (const source of ["/api", "/api/:__edusafety_route*", "/health", "/admin/certification"]) {
      expect(rewritesBySource.get(source)).toMatch(/^\/api\/server\?/);
    }
  });

  it("keeps DEMO_PASS on the static output path without invoking the server bootstrap", async () => {
    const [config, packageJson, demo] = await Promise.all([
      readFile(new URL("../../vercel.json", import.meta.url), "utf8").then(parseJson<VercelConfig>),
      readFile(new URL("../../package.json", import.meta.url), "utf8").then(parseJson<PackageJson>),
      readFile(new URL("../../public/demo.html", import.meta.url), "utf8"),
    ]);

    expect(config.rewrites.some((rewrite) => rewrite.source === "/demo")).toBe(false);
    expect(packageJson.scripts["build:client"]).toContain("copy-client-public.mjs");
    expect(demo).toContain("DEMO · 실제 인증 아님");
  });
});
