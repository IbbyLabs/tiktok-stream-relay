import { spawnSync } from "node:child_process";
import fs from "node:fs";

const level = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
const allowedLevels = new Set(["patch", "minor", "major"]);

if (!allowedLevels.has(level)) {
  console.error("Usage: npm run release -- <patch|minor|major>");
  process.exit(1);
}

function run(command, args, { stdio = "inherit" } = {}) {
  const result = spawnSync(command, args, { stdio, encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result;
}

function ensureCleanWorkingTree() {
  const status = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (status.error) {
    throw status.error;
  }
  if (status.status !== 0) {
    process.exit(status.status ?? 1);
  }
  if (String(status.stdout || "").trim()) {
    console.error("Release aborted: working tree is not clean. Commit or stash changes first.");
    process.exit(1);
  }
}

function readVersion() {
  return String(JSON.parse(fs.readFileSync("package.json", "utf8")).version || "").trim();
}

ensureCleanWorkingTree();

console.log("Running release validation gate...");
run("npm", ["run", "lint"]);
run("npm", ["test"]);
run("npm", ["run", "build"]);

if (dryRun) {
  console.log(`Dry run: would bump ${level}, sync manifest and README, update CHANGELOG.md, commit release, tag, and push the tag.`);
  process.exit(0);
}

run("npm", ["version", level, "--no-git-tag-version"]);

const version = readVersion();
run("node", ["scripts/sync-release-version.mjs", version]);
run("node", ["scripts/update-changelog.mjs"]);

run("git", ["add", "package.json", "package-lock.json", "manifest.json", "README.md", "CHANGELOG.md"]);
run("git", ["commit", "-m", `chore(release): v${version}`]);
run("git", ["tag", `v${version}`]);
run("git", ["push", "origin", "HEAD", `refs/tags/v${version}`]);
