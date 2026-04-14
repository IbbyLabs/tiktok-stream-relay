import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DebridRouter } from "../src/debrid/debrid-router.js";
import { DebridAdapter } from "../src/debrid/types.js";
import { StreamCache } from "../src/cache/stream-cache.js";
import { StreamService } from "../src/stream/stream-service.js";

test("debrid router falls through to second provider", async () => {
  const failAdapter: DebridAdapter = {
    provider: "torbox",
    route: async () => {
      throw new Error("fail");
    },
  };
  const successAdapter: DebridAdapter = {
    provider: "torbox",
    route: async () => ({
      provider: "torbox",
      url: "https://cdn.example/audio.mp3",
    }),
  };

  const router = new DebridRouter([failAdapter, successAdapter], 500);
  const routed = await router.tryRoute(
    "https://www.tiktok.com/@u/video/1234567890123456789",
    {
      torbox: "tok1",
    },
  );

  assert.deepEqual(routed, {
    provider: "torbox",
    url: "https://cdn.example/audio.mp3",
  });
});

test("stream service falls back to local when debrid unavailable", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "stream-fallback-test-"),
  );
  const streamCache = new StreamCache(tempDir);
  const router = new DebridRouter([], 500);

  const outputFile = path.join(tempDir, "audio", "x.mp3");
  let transcodeCalls = 0;
  const ffmpeg = {
    resolveToFile: async (_sourceUrl: string, outputPath: string) => {
      transcodeCalls += 1;
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputFile, "fake-audio", "utf-8");
      if (outputPath !== outputFile) {
        fs.copyFileSync(outputFile, outputPath);
      }
    },
  };

  const service = new StreamService({
    router,
    ffmpeg,
    streamCache,
    localTtlMs: 60_000,
    resolveMediaUrls: async (sourceUrl: string) => [sourceUrl],
  });

  const resolved = await service.resolve({
    sourceUrl: "https://www.tiktok.com/@u/video/1234567890123456789",
  });

  assert.equal(resolved.type, "file");
  if (resolved.type === "file") {
    assert.equal(fs.existsSync(resolved.filePath), true);
  }

  const resolvedCached = await service.resolve({
    sourceUrl: "https://www.tiktok.com/@u/video/1234567890123456789",
  });

  assert.equal(resolvedCached.type, "file");
  assert.equal(transcodeCalls, 1);
});
