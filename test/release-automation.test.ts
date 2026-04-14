import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChangelogSection,
  getVersionAnchor,
  insertChangelogSection,
} from "../scripts/update-changelog.mjs";
import {
  syncManifestVersion,
  syncReadmeReleaseExamples,
} from "../scripts/sync-release-version.mjs";

test("syncManifestVersion updates the addon version", () => {
  const source = JSON.stringify({ id: "com.example.addon", version: "0.1.0" }, null, 2);
  const updated = JSON.parse(syncManifestVersion(source, "1.2.3"));

  assert.equal(updated.version, "1.2.3");
  assert.equal(updated.id, "com.example.addon");
});

test("syncReadmeReleaseExamples updates GHCR tag examples", () => {
  const source = "docker pull ghcr.io/ibbylabs/tiktok-stream-relay:v0.1.0\n";
  const updated = syncReadmeReleaseExamples(source, "1.2.3");

  assert.equal(updated, "docker pull ghcr.io/ibbylabs/tiktok-stream-relay:v1.2.3\n");
});

test("buildChangelogSection groups conventional commits", () => {
  const section = buildChangelogSection("v1.2.3", "14/04/2026", [
    { hash: "1", subject: "feat(ui): add hero actions", body: "Ship official external links." },
    { hash: "2", subject: "fix(release): sync addon version", body: "Keep manifest version aligned." },
    { hash: "3", subject: "docs(readme): refresh release flow", body: "Document the automated steps." },
  ]);

  assert.match(section, /<a id="v1-2-3"><\/a>/);
  assert.match(section, /### Added/);
  assert.match(section, /### Fixed/);
  assert.match(section, /### Documentation/);
  assert.match(section, /add hero actions/);
  assert.match(section, /sync addon version/);
  assert.match(section, /refresh release flow/);
});

test("insertChangelogSection prepends a newer entry above existing sections", () => {
  const existing = [
    "# Changelog",
    "",
    '<a id="v0-1-0"></a>',
    "",
    "## [v0.1.0] - 14/04/2026",
    "",
    "### Added",
    "* initial release",
    "",
  ].join("\n");
  const next = insertChangelogSection(existing, '<a id="v0-2-0"></a>\n\n## [v0.2.0] - 15/04/2026\n\n### Fixed\n* ship release automation\n');

  assert.ok(next.indexOf("## [v0.2.0]") < next.indexOf("## [v0.1.0]"));
  assert.equal(getVersionAnchor("v0.2.0"), "v0-2-0");
});