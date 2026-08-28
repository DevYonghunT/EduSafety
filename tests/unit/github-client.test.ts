import { createHash } from "node:crypto";
import { GitHubClient, GitHubCollectionError } from "../../src/github/client.js";
import { TEST_COMMIT, TEST_REPOSITORY } from "../helpers/test-fixtures.js";

function blobSha(content: string): string {
  const buffer = Buffer.from(content);
  return createHash("sha1")
    .update(Buffer.from(`blob ${buffer.byteLength}\0`))
    .update(buffer)
    .digest("hex");
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GitHub exact-commit collection", () => {
  it.each([
    "http://github.com/owner/repo",
    "https://github.evil.example/owner/repo",
    "https://github.com@evil.example/owner/repo",
    "https://user@github.com/owner/repo",
    "https://github.com:444/owner/repo",
    "https://github.com/owner/repo/tree/main",
    "https://github.com/owner/repo?ref=main",
    "https://github.com/owner/repo#readme",
    "https://github.com/owner%2Frepo/other",
    "https://github.com/owner/repo\\extra",
  ])("rejects a confusing repository URL: %s", async (repositoryUrl) => {
    const client = new GitHubClient({ fetchImplementation: vi.fn() });
    await expect(client.collect(repositoryUrl, TEST_COMMIT)).rejects.toBeInstanceOf(GitHubCollectionError);
  });

  it.each(["abc", `g${"0".repeat(39)}`, `${"0".repeat(39)}`, `${"0".repeat(41)}`, ` ${TEST_COMMIT}`])(
    "rejects a non-exact commit: %s",
    async (commit) => {
      const client = new GitHubClient({ fetchImplementation: vi.fn() });
      await expect(client.collect("https://github.com/owner/repo", commit)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    },
  );

  it("walks non-recursive trees, validates blobs and confirms repository identity", async () => {
    const source = "export const safe = true;";
    const sourceSha = blobSha(source);
    const rootTreeSha = "a".repeat(40);
    const childTreeSha = "b".repeat(40);
    const calls: string[] = [];
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/repos/owner/repo")) {
        return json({
          id: 123456,
          full_name: "Owner/CanonicalRepo",
          private: false,
          visibility: "public",
          disabled: false,
          default_branch: "main",
        });
      }
      if (pathname.endsWith(`/git/commits/${TEST_COMMIT}`)) {
        return json({ sha: TEST_COMMIT, tree: { sha: rootTreeSha } });
      }
      if (pathname.endsWith(`/git/trees/${rootTreeSha}`)) {
        return json({
          sha: rootTreeSha,
          truncated: false,
          tree: [{ path: "src", type: "tree", mode: "040000", sha: childTreeSha }],
        });
      }
      if (pathname.endsWith(`/git/trees/${childTreeSha}`)) {
        return json({
          sha: childTreeSha,
          truncated: false,
          tree: [{ path: "index.ts", type: "blob", mode: "100644", sha: sourceSha, size: Buffer.byteLength(source) }],
        });
      }
      if (pathname.endsWith(`/git/blobs/${sourceSha}`)) {
        return json({ encoding: "base64", content: Buffer.from(source).toString("base64"), size: Buffer.byteLength(source) });
      }
      return json({}, 404);
    });
    const client = new GitHubClient({ fetchImplementation });
    const collected = await client.collect("https://github.com/owner/repo", TEST_COMMIT);
    expect(collected.repository).toMatchObject({
      repositoryId: 123456,
      canonicalRepositoryUrl: "https://github.com/Owner/CanonicalRepo",
    });
    expect(collected.files).toEqual([
      expect.objectContaining({ path: "src/index.ts", content: source }),
    ]);
    expect(collected.coverageIncomplete).toBe(false);
    expect(calls.every((url) => !url.includes("recursive"))).toBe(true);
    expect(calls.every((url) => new URL(url).origin === "https://api.github.com")).toBe(true);
  });

  it("marks a truncated tree as partial and incomplete", async () => {
    const rootTreeSha = "a".repeat(40);
    let metadataCalls = 0;
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith("/repos/owner/repo")) {
        metadataCalls += 1;
        return json({
          id: 10,
          full_name: "owner/repo",
          private: false,
          visibility: "public",
          disabled: false,
          default_branch: "main",
        });
      }
      if (pathname.endsWith(`/git/commits/${TEST_COMMIT}`)) {
        return json({ sha: TEST_COMMIT, tree: { sha: rootTreeSha } });
      }
      if (pathname.endsWith(`/git/trees/${rootTreeSha}`)) {
        return json({ sha: rootTreeSha, truncated: true, tree: [] });
      }
      return json({}, 404);
    });
    const collected = await new GitHubClient({ fetchImplementation }).collect(
      "https://github.com/owner/repo",
      TEST_COMMIT,
    );
    expect(metadataCalls).toBe(2);
    expect(collected.partial).toBe(true);
    expect(collected.coverageIncomplete).toBe(true);
  });

  it("fails closed when repository identity changes during collection", async () => {
    const rootTreeSha = "a".repeat(40);
    let metadataCalls = 0;
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith("/repos/owner/repo")) {
        metadataCalls += 1;
        return json({
          id: metadataCalls === 1 ? 10 : 11,
          full_name: "owner/repo",
          private: false,
          visibility: "public",
          disabled: false,
          default_branch: "main",
        });
      }
      if (pathname.endsWith(`/git/commits/${TEST_COMMIT}`)) {
        return json({ sha: TEST_COMMIT, tree: { sha: rootTreeSha } });
      }
      if (pathname.endsWith(`/git/trees/${rootTreeSha}`)) {
        return json({ sha: rootTreeSha, truncated: false, tree: [] });
      }
      return json({}, 404);
    });
    await expect(
      new GitHubClient({ fetchImplementation }).collect("https://github.com/owner/repo", TEST_COMMIT),
    ).rejects.toMatchObject({ code: "EXACT_COMMIT_MISMATCH" });
  });

  it("marks excluded executable subtrees and archives as incomplete coverage", async () => {
    const source = "export const safe = true;";
    const sourceSha = blobSha(source);
    const rootTreeSha = "a".repeat(40);
    const excludedDirectories = ["dist", "build", "vendor", "target", ".next", "node_modules"];
    const archiveSha = "b".repeat(40);
    const requestedPaths: string[] = [];
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      requestedPaths.push(pathname);
      if (pathname.endsWith("/repos/owner/repo")) {
        return json({
          id: 123456,
          full_name: "owner/repo",
          private: false,
          visibility: "public",
          disabled: false,
          default_branch: "main",
        });
      }
      if (pathname.endsWith(`/git/commits/${TEST_COMMIT}`)) {
        return json({ sha: TEST_COMMIT, tree: { sha: rootTreeSha } });
      }
      if (pathname.endsWith(`/git/trees/${rootTreeSha}`)) {
        return json({
          sha: rootTreeSha,
          truncated: false,
          tree: [
            { path: "index.ts", type: "blob", mode: "100644", sha: sourceSha, size: Buffer.byteLength(source) },
            ...excludedDirectories.map((directory, index) => ({
              path: directory,
              type: "tree",
              mode: "040000",
              sha: (index + 1).toString(16).repeat(40),
            })),
            { path: "shipped-code.zip", type: "blob", mode: "100644", sha: archiveSha, size: 128 },
          ],
        });
      }
      if (pathname.endsWith(`/git/blobs/${sourceSha}`)) {
        return json({ encoding: "base64", content: Buffer.from(source).toString("base64"), size: Buffer.byteLength(source) });
      }
      return json({}, 404);
    });

    const collected = await new GitHubClient({ fetchImplementation }).collect(
      "https://github.com/owner/repo",
      TEST_COMMIT,
    );

    expect(collected.files).toEqual([expect.objectContaining({ path: "index.ts" })]);
    expect(collected.coverageIncomplete).toBe(true);
    expect(requestedPaths.some((pathname) => pathname.endsWith(`/git/blobs/${archiveSha}`))).toBe(false);
    for (let index = 0; index < excludedDirectories.length; index += 1) {
      expect(
        requestedPaths.some((pathname) =>
          pathname.endsWith(`/git/trees/${(index + 1).toString(16).repeat(40)}`),
        ),
      ).toBe(false);
    }
  });

  it("uses the current public repository default branch when checking HEAD", async () => {
    const currentHead = "f".repeat(40);
    const requestedPaths: string[] = [];
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      requestedPaths.push(pathname);
      if (pathname.endsWith("/repos/example/education-service")) {
        return json({
          id: TEST_REPOSITORY.repositoryId,
          private: false,
          visibility: "public",
          disabled: false,
          default_branch: "trunk",
        });
      }
      if (pathname.endsWith("/commits/trunk")) return json({ sha: currentHead });
      return json({}, 404);
    });

    const head = await new GitHubClient({ fetchImplementation }).getDefaultBranchHead({
      ...TEST_REPOSITORY,
      defaultBranch: "old-default",
    });

    expect(head).toBe(currentHead);
    expect(requestedPaths).toContain("/repos/example/education-service/commits/trunk");
    expect(requestedPaths).not.toContain("/repos/example/education-service/commits/old-default");
  });

  it.each([
    ["repository identity", { id: TEST_REPOSITORY.repositoryId + 1 }],
    ["private visibility", { private: true }],
    ["missing private flag", { private: undefined }],
    ["non-public visibility", { visibility: "private" }],
    ["disabled repository", { disabled: true }],
    ["missing disabled flag", { disabled: undefined }],
    ["missing default branch", { default_branch: "" }],
  ])("returns no current HEAD for invalid %s metadata", async (_label, override) => {
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith("/repos/example/education-service")) {
        return json({
          id: TEST_REPOSITORY.repositoryId,
          private: false,
          visibility: "public",
          disabled: false,
          default_branch: "main",
          ...override,
        });
      }
      return json({ sha: TEST_COMMIT });
    });

    await expect(
      new GitHubClient({ fetchImplementation }).getDefaultBranchHead(TEST_REPOSITORY),
    ).resolves.toBeNull();
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });
});
