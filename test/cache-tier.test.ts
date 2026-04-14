import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryCache } from "../src/cache/memory-cache.js";
import { DiskCache } from "../src/cache/disk-cache.js";

test("memory cache expires by TTL", async () => {
  const cache = new MemoryCache<number>(20);
  cache.set("a", 1);
  assert.equal(cache.get("a"), 1);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(cache.get("a"), null);
});

test("disk cache removes corrupt entries", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "disk-cache-test-"));
  const cache = new DiskCache<number>(tempDir, 60_000);
  cache.set("ok", 1);

  const fileName = fs
    .readdirSync(tempDir)
    .find((name) => name.endsWith(".json"));
  assert.ok(fileName);
  fs.writeFileSync(
    path.join(tempDir, fileName as string),
    "{not-json",
    "utf-8",
  );

  assert.equal(cache.get("ok"), null);
  assert.equal(fs.existsSync(path.join(tempDir, fileName as string)), false);
});
