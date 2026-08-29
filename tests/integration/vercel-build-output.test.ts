import { constants, existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  restoreVercelRequestUrl,
  VERCEL_PATH_QUERY,
  VERCEL_ROUTE_QUERY,
} from "../../src/http/vercel-adapter.js";

const hasVercelBuildOutput = existsSync(".vercel/output/config.json");

describe.runIf(hasVercelBuildOutput)("built Vercel production adapter", () => {
  it("contains one Express function, the React client, and static zero-call pages", async () => {
    const output = path.resolve(".vercel/output");
    const functionDirectory = path.join(output, "functions/api/server.func");
    await Promise.all([
      access(path.join(functionDirectory, ".vc-config.json"), constants.R_OK),
      access(path.join(output, "static/index.html"), constants.R_OK),
      access(path.join(output, "static/demo.html"), constants.R_OK),
      access(path.join(output, "static/admin-login.html"), constants.R_OK),
      access(path.join(output, "static/verify.html"), constants.R_OK),
    ]);
    await expect(access(path.join(output, "static/admin-certification.html"), constants.F_OK)).rejects.toThrow();

    const functionConfig = JSON.parse(
      await readFile(path.join(functionDirectory, ".vc-config.json"), "utf8"),
    );
    expect(functionConfig.filePathMap["public/admin-certification.html"])
      .toBe("public/admin-certification.html");

    const index = await readFile(path.join(output, "static/index.html"), "utf8");
    expect(index).toContain("/assets/index-");
  });

  it("removes Vercel's generated wildcard parameter without dropping SVG query values", async () => {
    const config = JSON.parse(await readFile(".vercel/output/config.json", "utf8"));
    const wildcard = config.routes.find((route: { dest?: string }) => route.dest?.includes(`${VERCEL_ROUTE_QUERY}=$1`));

    expect(wildcard?.dest).toContain(`${VERCEL_PATH_QUERY}=%2Fapi%2F$1`);
    expect(wildcard?.dest).not.toContain("&path=$1");

    const uid = `0x${"a".repeat(64)}`;
    const request = {
      url: `/api?${VERCEL_PATH_QUERY}=${encodeURIComponent(`/api/badges/${uid}.svg`)}&${VERCEL_ROUTE_QUERY}=${encodeURIComponent(`badges/${uid}.svg`)}&variant=showcase`,
    };
    expect(restoreVercelRequestUrl(request)).toBe(true);
    expect(request.url).toBe(`/api/badges/${uid}.svg?variant=showcase`);
  });

  it("keeps demo, login and verification HTML off the database bootstrap path", async () => {
    const config = JSON.parse(await readFile(".vercel/output/config.json", "utf8"));
    const serializedRoutes = JSON.stringify(config.routes);

    expect(config.overrides["demo.html"].path).toBe("demo");
    expect(serializedRoutes).not.toContain("__edusafety_path=%2Fdemo");
    expect(serializedRoutes).toContain('"dest":"/admin-login"');
    expect(serializedRoutes).toContain('"dest":"/verify?uid=$1"');
  });
});
