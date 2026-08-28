import { cp, copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = path.join(projectRoot, "public");
const outputDirectory = path.join(projectRoot, "client-dist");
const excluded = new Set([".DS_Store", "admin-certification.html", "index.html"]);

await mkdir(outputDirectory, { recursive: true });
for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
  if (excluded.has(entry.name)) continue;
  await cp(
    path.join(sourceDirectory, entry.name),
    path.join(outputDirectory, entry.name),
    { recursive: entry.isDirectory(), force: true },
  );
}

// The former standalone landing remains available without replacing the React review app at `/`.
await copyFile(path.join(sourceDirectory, "index.html"), path.join(outputDirectory, "issue.html"));
