import fs from "node:fs";
import path from "node:path";

const [, , rawVersion] = process.argv;

export function normalizeVersion(version) {
  const trimmed = String(version || "").trim();
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

export function syncManifestVersion(source, version) {
  const parsed = JSON.parse(source);
  parsed.version = normalizeVersion(version);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function syncReadmeReleaseExamples(source, version) {
  const tag = `v${normalizeVersion(version)}`;
  return source.replace(
    /(docker pull ghcr\.io\/ibbylabs\/tiktok-stream-relay:)v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/g,
    `$1${tag}`,
  );
}

function writeIfChanged(filePath, nextContent) {
  const current = fs.readFileSync(filePath, "utf8");
  if (current === nextContent) {
    return false;
  }
  fs.writeFileSync(filePath, nextContent, "utf8");
  return true;
}

function main() {
  const version = normalizeVersion(rawVersion);
  if (!version) {
    console.error("Usage: node scripts/sync-release-version.mjs <version>");
    process.exit(1);
  }

  const root = process.cwd();
  const manifestPath = path.join(root, "manifest.json");
  const readmePath = path.join(root, "README.md");

  const manifestUpdated = writeIfChanged(
    manifestPath,
    syncManifestVersion(fs.readFileSync(manifestPath, "utf8"), version),
  );
  const readmeUpdated = writeIfChanged(
    readmePath,
    syncReadmeReleaseExamples(fs.readFileSync(readmePath, "utf8"), version),
  );

  console.log(
    `Synced release surfaces for ${version}. manifest=${manifestUpdated ? "updated" : "unchanged"} readme=${readmeUpdated ? "updated" : "unchanged"}`,
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main();
}