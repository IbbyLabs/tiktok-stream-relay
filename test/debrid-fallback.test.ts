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

test("stream service routes debrid using resolved media urls before local fallback", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "stream-debrid-candidate-test-"),
  );
  const streamCache = new StreamCache(tempDir);
  const seenUrls: string[] = [];

  const adapter: DebridAdapter = {
    provider: "torbox",
    route: async ({ sourceUrl }) => {
      seenUrls.push(sourceUrl);
      return {
        provider: "torbox",
        url: "https://cdn.example/audio-from-debrid.mp3",
      };
    },
  };

  const router = new DebridRouter([adapter], 500);
  let transcodeCalls = 0;
  const service = new StreamService({
    router,
    ffmpeg: {
      resolveToFile: async () => {
        transcodeCalls += 1;
      },
    },
    streamCache,
    localTtlMs: 60_000,
    resolveMediaUrls: async () => ["https://cdn.example/direct-audio.m4a"],
  });

  const resolved = await service.resolve({
    sourceUrl: "https://www.tiktok.com/@u/video/1234567890123456789",
    torboxToken: "tok1",
  });

  assert.equal(resolved.type, "url");
  assert.deepEqual(seenUrls, ["https://cdn.example/direct-audio.m4a"]);
  assert.equal(transcodeCalls, 0);
});

test("stream service does not reuse expired debrid url cache entries", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "stream-debrid-expiry-test-"),
  );
  const streamCache = new StreamCache(tempDir);
  let calls = 0;

  const adapter: DebridAdapter = {
    provider: "torbox",
    route: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          provider: "torbox",
          url: "https://cdn.example/expired.mp3",
          expiresAt: Date.now() - 1000,
        };
      }
      return {
        provider: "torbox",
        url: "https://cdn.example/fresh.mp3",
      };
    },
  };

  const router = new DebridRouter([adapter], 500);
  const service = new StreamService({
    router,
    ffmpeg: {
      resolveToFile: async () => {
        throw new Error("should not transcode");
      },
    },
    streamCache,
    localTtlMs: 60_000,
    resolveMediaUrls: async () => ["https://cdn.example/direct-audio.m4a"],
  });

  const first = await service.resolve({
    sourceUrl: "https://www.tiktok.com/@u/video/1234567890123456789",
    torboxToken: "tok1",
  });
  assert.equal(first.type, "url");

  const second = await service.resolve({
    sourceUrl: "https://www.tiktok.com/@u/video/1234567890123456789",
    torboxToken: "tok1",
  });
  assert.equal(second.type, "url");
  if (second.type === "url") {
    assert.equal(second.url, "https://cdn.example/fresh.mp3");
  }
  assert.equal(calls, 2);
});
