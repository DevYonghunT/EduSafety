import { createHash } from "node:crypto";
import type { RepositorySnapshot } from "../domain/types.js";

const EXACT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 500;
const FETCH_CONCURRENCY = 8;
const MAX_TREE_ENTRIES = 20_000;
const MAX_TREE_DEPTH = 64;
const MAX_PATH_BYTES = 1_024;

const SUPPORTED_EXTENSIONS = new Set([
  ".c",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".env",
  ".go",
  ".gradle",
  ".h",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".mjs",
  ".php",
  ".properties",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".tf",
  ".toml",
  ".ts",
  ".tsx",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
]);

const EXCLUDED_BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avi",
  ".bmp",
  ".class",
  ".dmg",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".otf",
  ".pdf",
  ".png",
  ".rar",
  ".so",
  ".tar",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".xz",
  ".zip",
]);

// These formats can contain executable code or nested files that this collector
// deliberately never extracts. Seeing one therefore makes coverage incomplete.
const COVERAGE_BLOCKING_BINARY_EXTENSIONS = new Set([
  ".7z",
  ".class",
  ".dmg",
  ".exe",
  ".gz",
  ".jar",
  ".rar",
  ".so",
  ".tar",
  ".xz",
  ".zip",
]);

const SPECIAL_FILES = new Set([
  "Dockerfile",
  "Gemfile",
  "Gemfile.lock",
  "Pipfile",
  "Pipfile.lock",
  "bun.lock",
  "bun.lockb",
  "composer.json",
  "composer.lock",
  "go.mod",
  "go.sum",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "pyproject.toml",
  "requirements.txt",
  "yarn.lock",
]);

const EXCLUDED_PATH_SEGMENTS = new Set([
  ".git",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);

export interface SourceFile {
  readonly path: string;
  readonly content: string;
  readonly byteLength: number;
  readonly extension: string;
}

export interface CollectedRepository {
  readonly repository: RepositorySnapshot;
  readonly commitSha: string;
  readonly files: readonly SourceFile[];
  readonly exactCommitVerified: boolean;
  readonly partial: boolean;
  readonly coverageIncomplete: boolean;
  readonly failedFileCount: number;
}

export interface RepositorySourceProvider {
  resolveRepository(repositoryUrl: string): Promise<RepositorySnapshot>;
  collect(repositoryUrl: string, commitSha: string): Promise<CollectedRepository>;
  getDefaultBranchHead(repository: RepositorySnapshot): Promise<string | null>;
}

export class GitHubCollectionError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "NOT_FOUND"
      | "PRIVATE_REPOSITORY"
      | "EXACT_COMMIT_MISMATCH"
      | "RATE_LIMITED"
      | "TEMPORARY_FAILURE"
      | "INVALID_RESPONSE",
    message: string,
  ) {
    super(message);
    this.name = "GitHubCollectionError";
  }
}

interface GitHubClientOptions {
  readonly token?: string;
  readonly fetchImplementation?: typeof fetch;
  readonly apiBaseUrl?: string;
}

interface GitTreeEntry {
  readonly path: string;
  readonly type: "blob" | "commit" | "tree";
  readonly sha: string;
  readonly size?: number;
  readonly mode: string;
}

function parseRepositoryUrl(repositoryUrl: string): { owner: string; name: string } {
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    throw new GitHubCollectionError("INVALID_INPUT", "유효한 GitHub 저장소 URL이 필요합니다.");
  }

  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new GitHubCollectionError("INVALID_INPUT", "공개 github.com HTTPS 저장소 URL만 지원합니다.");
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) {
    throw new GitHubCollectionError("INVALID_INPUT", "저장소 루트 URL을 입력해야 합니다.");
  }
  const owner = segments[0];
  const rawName = segments[1];
  if (owner === undefined || rawName === undefined) {
    throw new GitHubCollectionError("INVALID_INPUT", "저장소 소유자와 이름이 필요합니다.");
  }
  const name = rawName.endsWith(".git") ? rawName.slice(0, -4) : rawName;
  if (!REPOSITORY_SEGMENT_PATTERN.test(owner) || !REPOSITORY_SEGMENT_PATTERN.test(name)) {
    throw new GitHubCollectionError("INVALID_INPUT", "저장소 URL 형식이 올바르지 않습니다.");
  }
  return { owner, name };
}

function rawExtension(filePath: string): string {
  const base = filePath.split("/").at(-1) ?? filePath;
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot).toLowerCase();
}

function normalizedExtension(filePath: string): string {
  const extension = rawExtension(filePath);
  return extension === "" || /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : "other";
}

function isSupportedPath(filePath: string): boolean {
  const segments = filePath.split("/");
  if (segments.some((segment) => EXCLUDED_PATH_SEGMENTS.has(segment))) {
    return false;
  }
  const basename = segments.at(-1) ?? filePath;
  const extension = rawExtension(filePath);
  return (
    SPECIAL_FILES.has(basename) ||
    SUPPORTED_EXTENSIONS.has(extension) ||
    !EXCLUDED_BINARY_EXTENSIONS.has(extension)
  );
}

function isSafeTreeName(name: string): boolean {
  const hasControlCharacter = [...name].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  return (
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !hasControlCharacter
  );
}

function gitBlobSha(buffer: Buffer): string {
  return createHash("sha1")
    .update(Buffer.from(`blob ${buffer.byteLength}\0`, "utf8"))
    .update(buffer)
    .digest("hex");
}

function isText(buffer: Buffer): boolean {
  return !buffer.subarray(0, 8_192).includes(0);
}

export class GitHubClient implements RepositorySourceProvider {
  readonly #fetch: typeof fetch;
  readonly #token: string | undefined;
  readonly #apiBaseUrl: string;

  public constructor(options: GitHubClientOptions = {}) {
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#token = options.token;
    this.#apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
  }

  async #requestJson<T>(path: string): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#apiBaseUrl}${path}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "EduSafety-static-review",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(this.#token === undefined ? {} : { Authorization: `Bearer ${this.#token}` }),
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new GitHubCollectionError(
        "TEMPORARY_FAILURE",
        error instanceof Error ? `GitHub 요청 실패: ${error.message}` : "GitHub 요청 실패",
      );
    }

    if (response.status === 404) {
      throw new GitHubCollectionError("NOT_FOUND", "저장소 또는 commit을 찾을 수 없습니다.");
    }
    if (response.status === 403 || response.status === 429) {
      throw new GitHubCollectionError("RATE_LIMITED", "GitHub 요청 한도 때문에 현재 확인할 수 없습니다.");
    }
    if (!response.ok) {
      throw new GitHubCollectionError(
        response.status >= 500 ? "TEMPORARY_FAILURE" : "INVALID_RESPONSE",
        `GitHub가 예상하지 못한 상태 ${response.status}를 반환했습니다.`,
      );
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new GitHubCollectionError("INVALID_RESPONSE", "GitHub 응답을 해석할 수 없습니다.");
    }
  }

  public async resolveRepository(repositoryUrl: string): Promise<RepositorySnapshot> {
    const { owner, name } = parseRepositoryUrl(repositoryUrl);
    const metadata = await this.#requestJson<{
      id: number;
      full_name: string;
      private: boolean;
      visibility: string;
      disabled: boolean;
      default_branch: string;
    }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
    if (metadata.private || metadata.visibility !== "public" || metadata.disabled) {
      throw new GitHubCollectionError("PRIVATE_REPOSITORY", "공개 저장소만 분석할 수 있습니다.");
    }
    if (!Number.isSafeInteger(metadata.id) || metadata.id <= 0) {
      throw new GitHubCollectionError("INVALID_RESPONSE", "GitHub repository ID가 올바르지 않습니다.");
    }
    const fullName = metadata.full_name.split("/");
    if (
      fullName.length !== 2 ||
      fullName.some((part) => !part || !REPOSITORY_SEGMENT_PATTERN.test(part)) ||
      typeof metadata.default_branch !== "string" ||
      metadata.default_branch.length === 0
    ) {
      throw new GitHubCollectionError("INVALID_RESPONSE", "GitHub canonical 저장소 정보가 올바르지 않습니다.");
    }
    const canonicalOwner = fullName[0];
    const canonicalName = fullName[1];
    if (canonicalOwner === undefined || canonicalName === undefined) {
      throw new GitHubCollectionError("INVALID_RESPONSE", "GitHub canonical 저장소 이름이 누락됐습니다.");
    }
    return {
      repositoryId: metadata.id,
      canonicalRepositoryUrl: `https://github.com/${canonicalOwner}/${canonicalName}`,
      owner: canonicalOwner,
      name: canonicalName,
      defaultBranch: metadata.default_branch,
    };
  }

  public async collect(repositoryUrl: string, commitShaInput: string): Promise<CollectedRepository> {
    const commitSha = commitShaInput.toLowerCase();
    if (!EXACT_COMMIT_PATTERN.test(commitSha)) {
      throw new GitHubCollectionError("INVALID_INPUT", "commitSha는 정확한 40자리 SHA여야 합니다.");
    }
    const { owner, name } = parseRepositoryUrl(repositoryUrl);
    const repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const metadata = await this.#requestJson<{
      id: number;
      full_name: string;
      private: boolean;
      visibility: string;
      disabled: boolean;
      default_branch: string;
    }>(repositoryPath);

    if (metadata.private || metadata.visibility !== "public" || metadata.disabled) {
      throw new GitHubCollectionError("PRIVATE_REPOSITORY", "공개 저장소만 분석할 수 있습니다.");
    }
    if (!Number.isSafeInteger(metadata.id) || metadata.id <= 0) {
      throw new GitHubCollectionError("INVALID_RESPONSE", "GitHub repository ID가 올바르지 않습니다.");
    }
    const fullName = metadata.full_name.split("/");
    if (fullName.length !== 2 || fullName.some((part) => !part || !REPOSITORY_SEGMENT_PATTERN.test(part))) {
      throw new GitHubCollectionError("INVALID_RESPONSE", "GitHub canonical 저장소 이름이 올바르지 않습니다.");
    }
    const canonicalOwner = fullName[0];
    const canonicalName = fullName[1];
    if (canonicalOwner === undefined || canonicalName === undefined) {
      throw new GitHubCollectionError("INVALID_RESPONSE", "GitHub canonical 저장소 이름이 누락됐습니다.");
    }

    const commit = await this.#requestJson<{ sha: string; tree: { sha: string } }>(
      `${repositoryPath}/git/commits/${commitSha}`,
    );
    if (commit.sha.toLowerCase() !== commitSha || !EXACT_COMMIT_PATTERN.test(commit.tree.sha)) {
      throw new GitHubCollectionError("EXACT_COMMIT_MISMATCH", "요청한 exact commit을 확인하지 못했습니다.");
    }

    const eligible: GitTreeEntry[] = [];
    const seenPaths = new Set<string>();
    const queue: Array<{ sha: string; prefix: string; depth: number }> = [
      { sha: commit.tree.sha, prefix: "", depth: 0 },
    ];
    let enumeratedEntries = 0;
    let partial = false;
    let coverageIncomplete = false;

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      if (current.depth > MAX_TREE_DEPTH || enumeratedEntries >= MAX_TREE_ENTRIES) {
        coverageIncomplete = true;
        partial = true;
        break;
      }
      const tree = await this.#requestJson<{ sha: string; truncated: boolean; tree: GitTreeEntry[] }>(
        `${repositoryPath}/git/trees/${current.sha}`,
      );
      if (
        tree.sha.toLowerCase() !== current.sha.toLowerCase() ||
        !Array.isArray(tree.tree) ||
        tree.truncated
      ) {
        coverageIncomplete = true;
        partial = true;
        break;
      }

      for (const entry of tree.tree) {
        enumeratedEntries += 1;
        if (
          enumeratedEntries > MAX_TREE_ENTRIES ||
          !isSafeTreeName(entry.path) ||
          !EXACT_COMMIT_PATTERN.test(entry.sha.toLowerCase())
        ) {
          coverageIncomplete = true;
          continue;
        }
        const fullPath = current.prefix === "" ? entry.path : `${current.prefix}/${entry.path}`;
        if (Buffer.byteLength(fullPath, "utf8") > MAX_PATH_BYTES || seenPaths.has(fullPath)) {
          coverageIncomplete = true;
          continue;
        }
        seenPaths.add(fullPath);

        if (entry.type === "tree" && entry.mode === "040000") {
          if (fullPath.split("/").some((segment) => EXCLUDED_PATH_SEGMENTS.has(segment))) {
            // Skipping an entire committed tree must never be treated as full
            // coverage: generated/dependency trees can still contain shipped code.
            coverageIncomplete = true;
          } else {
            queue.push({ sha: entry.sha, prefix: fullPath, depth: current.depth + 1 });
          }
        } else if (entry.type === "blob" && ["100644", "100755", "120000"].includes(entry.mode)) {
          if (isSupportedPath(fullPath)) {
            eligible.push({ ...entry, path: fullPath });
          } else if (COVERAGE_BLOCKING_BINARY_EXTENSIONS.has(rawExtension(fullPath))) {
            coverageIncomplete = true;
          }
          if (entry.mode === "120000") coverageIncomplete = true;
        } else if (entry.type === "commit" || entry.mode === "160000") {
          coverageIncomplete = true;
        } else {
          coverageIncomplete = true;
        }
      }
    }

    eligible.sort((left, right) => left.path.localeCompare(right.path));
    const withinFileLimit = eligible.slice(0, MAX_FILES);
    coverageIncomplete ||= eligible.length > MAX_FILES;
    let failedFileCount = 0;
    let totalBytes = 0;
    const files: SourceFile[] = [];

    for (let start = 0; start < withinFileLimit.length; start += FETCH_CONCURRENCY) {
      const batch = withinFileLimit.slice(start, start + FETCH_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (entry): Promise<SourceFile | null> => {
          if (entry.size === undefined || entry.size > MAX_FILE_BYTES) {
            return null;
          }
          try {
            const blob = await this.#requestJson<{ encoding: string; content: string; size: number }>(
              `${repositoryPath}/git/blobs/${entry.sha}`,
            );
            if (blob.encoding !== "base64" || blob.size < 0 || blob.size > MAX_FILE_BYTES) {
              return null;
            }
            const buffer = Buffer.from(blob.content.replace(/\s/g, ""), "base64");
            if (
              buffer.byteLength !== blob.size ||
              gitBlobSha(buffer) !== entry.sha.toLowerCase() ||
              !isText(buffer) ||
              buffer.toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1")
            ) {
              return null;
            }
            let content: string;
            try {
              content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
            } catch {
              return null;
            }
            return {
              path: entry.path,
              content,
              byteLength: buffer.byteLength,
              extension: normalizedExtension(entry.path),
            };
          } catch {
            return null;
          }
        }),
      );

      for (const result of results) {
        if (result === null || totalBytes + result.byteLength > MAX_TOTAL_BYTES) {
          coverageIncomplete = true;
          failedFileCount += 1;
          continue;
        }
        totalBytes += result.byteLength;
        files.push(result);
      }
    }

    const confirmationMetadata = await this.#requestJson<{
      id: number;
      full_name: string;
      private: boolean;
      visibility: string;
      disabled: boolean;
    }>(repositoryPath);
    const confirmationCommit = await this.#requestJson<{ sha: string; tree: { sha: string } }>(
      `${repositoryPath}/git/commits/${commitSha}`,
    );
    if (
      confirmationMetadata.id !== metadata.id ||
      confirmationMetadata.full_name !== metadata.full_name ||
      confirmationMetadata.private ||
      confirmationMetadata.visibility !== "public" ||
      confirmationMetadata.disabled ||
      confirmationCommit.sha.toLowerCase() !== commitSha ||
      confirmationCommit.tree.sha.toLowerCase() !== commit.tree.sha.toLowerCase()
    ) {
      throw new GitHubCollectionError(
        "EXACT_COMMIT_MISMATCH",
        "수집 도중 저장소 또는 exact commit 상태가 변경됐습니다.",
      );
    }

    return {
      repository: {
        repositoryId: metadata.id,
        canonicalRepositoryUrl: `https://github.com/${canonicalOwner}/${canonicalName}`,
        owner: canonicalOwner,
        name: canonicalName,
        defaultBranch: metadata.default_branch,
      },
      commitSha,
      files,
      exactCommitVerified: true,
      partial,
      coverageIncomplete,
      failedFileCount,
    };
  }

  public async getDefaultBranchHead(repository: RepositorySnapshot): Promise<string | null> {
    const repositoryPath = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
    try {
      const metadata = await this.#requestJson<{
        id: number;
        private: boolean;
        visibility: string;
        disabled: boolean;
        default_branch: string;
      }>(repositoryPath);
      if (
        !Number.isSafeInteger(metadata.id) ||
        metadata.id <= 0 ||
        metadata.id !== repository.repositoryId ||
        metadata.private !== false ||
        metadata.visibility !== "public" ||
        metadata.disabled !== false ||
        typeof metadata.default_branch !== "string" ||
        metadata.default_branch.length === 0
      ) {
        return null;
      }
      const commit = await this.#requestJson<{ sha: string }>(
        `${repositoryPath}/commits/${encodeURIComponent(metadata.default_branch)}`,
      );
      if (typeof commit.sha !== "string") return null;
      const commitSha = commit.sha.toLowerCase();
      return EXACT_COMMIT_PATTERN.test(commitSha) ? commitSha : null;
    } catch {
      return null;
    }
  }
}
