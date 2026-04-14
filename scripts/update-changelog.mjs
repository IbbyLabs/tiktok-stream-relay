import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const prettyFormat = "%H%x1f%s%x1f%b%x1e";
const packageJsonPath = path.resolve("package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const currentVersion = `v${String(packageJson.version || "").trim()}`;
const today = new Date().toLocaleDateString("en-GB");
const releaseCommitSubjectRe = /^chore(?:\(release\))?:\s*(?:release|cut)\s+v?\d+\.\d+\.\d+\b/i;
const conventionalSubjectRe = /^([a-z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/i;

export function getVersionAnchor(version) {
  return String(version || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseGitLogOutput(output) {
  return String(output || "")
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hash = "", subject = "", body = ""] = entry.split("\x1f");
      return {
        hash: hash.trim(),
        subject: subject.trim(),
        body: body.trim(),
      };
    });
}

export function formatEntries(entries) {
  return entries
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .map((entry) => {
      if (!entry.includes("\n")) {
        return `* ${entry}`;
      }
      const lines = entry.split("\n");
      return `* ${lines[0]}\n${lines.slice(1).map((line) => `  ${line}`).join("\n")}`;
    })
    .join("\n");
}

function normalizeCommit(commit) {
  const subject = String(commit.subject || "").trim();
  const body = String(commit.body || "").trim();
  const match = subject.match(conventionalSubjectRe);
  if (!match) {
    return {
      type: "other",
      message: body ? `${subject}\n\n${body}` : subject,
    };
  }

  const [, rawType, , , title] = match;
  const type = rawType.toLowerCase();
  return {
    type,
    message: body ? `${title}\n\n${body}` : title,
  };
}

export function buildChangelogSection(version, date, commits) {
  const groups = {
    feat: [],
    fix: [],
    docs: [],
    perf: [],
    other: [],
  };

  for (const commit of commits) {
    if (releaseCommitSubjectRe.test(String(commit.subject || "").trim())) {
      continue;
    }

    const normalized = normalizeCommit(commit);
    if (normalized.type === "feat") {
      groups.feat.push(normalized.message);
    } else if (normalized.type === "fix") {
      groups.fix.push(normalized.message);
    } else if (normalized.type === "docs") {
      groups.docs.push(normalized.message);
    } else if (normalized.type === "perf") {
      groups.perf.push(normalized.message);
    } else {
      groups.other.push(normalized.message);
    }
  }

  let section = `<a id="${getVersionAnchor(version)}"></a>\n\n## [${version}] - ${date}\n\n`;
  if (groups.feat.length) {
    section += `### Added\n${formatEntries(groups.feat)}\n\n`;
  }
  if (groups.fix.length) {
    section += `### Fixed\n${formatEntries(groups.fix)}\n\n`;
  }
  if (groups.docs.length) {
    section += `### Documentation\n${formatEntries(groups.docs)}\n\n`;
  }
  if (groups.perf.length) {
    section += `### Performance\n${formatEntries(groups.perf)}\n\n`;
  }
  if (groups.other.length) {
    section += `### Other Changes\n${formatEntries(groups.other)}\n\n`;
  }
  return section;
}

export function insertChangelogSection(source, section) {
  const firstSectionIndex = source.indexOf("\n## [");
  if (firstSectionIndex === -1) {
    return `${source.trimEnd()}\n\n${section.trim()}\n`;
  }
  const head = source.slice(0, firstSectionIndex + 1).trimEnd();
  const tail = source.slice(firstSectionIndex + 1).replace(/^\n+/, "");
  return `${head}\n\n${section.trim()}\n\n${tail}`;
}

function lastTag() {
  try {
    const tag = execSync('git describe --tags --abbrev=0 --first-parent --match "v[0-9]*"', {
      encoding: "utf8",
    }).trim();
    return tag || null;
  } catch {
    return null;
  }
}

function getCommits(range) {
  const output = execSync(`git log --format=${JSON.stringify(prettyFormat)} ${range}`, {
    encoding: "utf8",
  });
  return parseGitLogOutput(output);
}

function main() {
  const changelogPath = path.resolve("CHANGELOG.md");
  const existing = fs.readFileSync(changelogPath, "utf8");

  if (existing.includes(`## [${currentVersion}]`)) {
    console.log(`Changelog already contains ${currentVersion}. skipping.`);
    return;
  }

  const prevTag = lastTag();
  const range = prevTag ? `${prevTag}..HEAD` : "HEAD";
  const commits = getCommits(range);
  if (!commits.length) {
    console.log("No new commits found for changelog generation. skipping.");
    return;
  }

  const section = buildChangelogSection(currentVersion, today, commits);
  fs.writeFileSync(changelogPath, insertChangelogSection(existing, section), "utf8");
  console.log(`Updated CHANGELOG.md with ${currentVersion}.`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main();
}