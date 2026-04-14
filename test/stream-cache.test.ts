import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StreamCache } from "../src/cache/stream-cache.js";

test("StreamCache keys change when the cache version changes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stream-cache-version-"));
  const v1Cache = new StreamCache(path.join(tempDir, "v1"), "1.0.0");
  const v2Cache = new StreamCache(path.join(tempDir, "v2"), "1.0.1");
  const sourceUrl = "https://www.tiktok.com/@u/video/1234567890123456789";

  assert.notEqual(v1Cache.keyFromUrl(sourceUrl), v2Cache.keyFromUrl(sourceUrl));
});