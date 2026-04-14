import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [, , rawTag, outputPath] = process.argv;

if (!rawTag) {
  console.error("Usage: node scripts/generate-github-release-notes.mjs <tag> [outputPath]");
  process.exit(1);
}

const tag = String(rawTag).startsWith("v") ? String(rawTag).trim() : `v${String(rawTag).trim()}`;
const root = process.cwd();
const changelogPath = path.join(root, "CHANGELOG.md");
const packageJsonPath = path.join(root, "package.json");

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getVersionAnchor(version) {
  return String(version || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getRepositoryWebUrl() {
  if (fs.existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const repositoryUrl = String(packageJson.repository?.url || "").trim();
    if (repositoryUrl) {
      return repositoryUrl
        .replace(/^git\+/, "")
        .replace(/\.git$/i, "")
        .replace(/^git@github\.com:/i, "https://github.com/");
    }
  }

  try {
    const remoteUrl = execSync("git remote get-url origin", { encoding: "utf8" }).trim();
    return remoteUrl
      .replace(/\.git$/i, "")
      .replace(/^git@github\.com:/i, "https://github.com/");
  } catch {
    return "";
  }
}

function hasTag(versionTag) {
  try {
    execSync(`git rev-parse --verify --quiet refs/tags/${versionTag}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getPreviousReleaseTag(versionTag) {
  try {
    const tags = execSync('git tag --list "v[0-9]*" --sort=version:refname', { encoding: "utf8" })
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const currentIndex = tags.indexOf(versionTag);
    if (currentIndex <= 0) {
      return null;
    }
    return tags[currentIndex - 1];
  } catch {
    return null;
  }
}

function getSectionForTag(content, versionTag) {
  const marker = `## [${versionTag}]`;
  const start = content.indexOf(marker);
  if (start === -1) {
    return null;
  }

  const next = content.indexOf("\n## [", start + marker.length);
  const section = next === -1 ? content.slice(start) : content.slice(start, next);
  return section.trim();
}

if (!fs.existsSync(changelogPath)) {
  console.error("CHANGELOG.md not found.");
  process.exit(1);
}

const changelog = fs.readFileSync(changelogPath, "utf8");
const section = getSectionForTag(changelog, tag);
const repository = getRepositoryWebUrl();
const changelogRef = hasTag(tag) ? tag : process.env.GITHUB_REF_NAME || "main";
const anchor = getVersionAnchor(tag);
const changelogUrl = repository
  ? `${repository}/blob/${changelogRef}/CHANGELOG.md#${escapeRegExp(anchor).replace(/\\/g, "")}`
  : "";
const previousTag = getPreviousReleaseTag(tag);
const compareUrl = repository && previousTag ? `${repository}/compare/${previousTag}...${tag}` : "";

const lines = [];
lines.push("> [!TIP]");
if (changelogUrl && compareUrl) {
  lines.push(`> **Changelog:** read the [matching entry](${changelogUrl}) or browse the [full compare](${compareUrl}).`);
} else if (changelogUrl) {
  lines.push(`> **Changelog:** read the [matching entry](${changelogUrl}).`);
} else {
  lines.push("> **Changelog:** read the matching CHANGELOG entry in this repository.");
}
lines.push("");
if (section) {
  lines.push(section);
} else {
  lines.push(`## ${tag}`);
  lines.push("");
  lines.push("### Changed");
  lines.push("- release notes section not found in CHANGELOG.md yet");
}
lines.push("");

const output = `${lines.join("\n")}\n`;

if (outputPath) {
  fs.writeFileSync(path.resolve(root, outputPath), output, "utf8");
} else {
  process.stdout.write(output);
}
