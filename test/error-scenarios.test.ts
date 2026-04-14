import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DebridRouter } from "../src/debrid/debrid-router.js";
import { StreamCache } from "../src/cache/stream-cache.js";
import { StreamService } from "../src/stream/stream-service.js";
import { HttpError } from "../src/errors/http-error.js";

test("stream resolution rejects invalid URL with 400", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "invalid-url-test-"));
  const service = new StreamService({
    router: new DebridRouter([], 200),
    ffmpeg: {
      resolveToFile: async () => {
        throw new Error("should not reach ffmpeg");
      },
    },
    streamCache: new StreamCache(tempDir),
    localTtlMs: 60_000,
    resolveMediaUrls: async (sourceUrl: string) => [sourceUrl],
  });

  await assert.rejects(
    () => service.resolve({ sourceUrl: "https://example.com/not-tiktok" }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
});

test("stream resolution propagates timeout failure from ffmpeg fallback", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "timeout-test-"));
  const service = new StreamService({
    router: new DebridRouter([], 200),
    ffmpeg: {
      resolveToFile: async () => {
        throw new HttpError(503, "transcode_timeout");
      },
    },
    streamCache: new StreamCache(tempDir),
    localTtlMs: 60_000,
    resolveMediaUrls: async (sourceUrl: string) => [sourceUrl],
  });

  await assert.rejects(
    () =>
      service.resolve({
        sourceUrl: "https://www.tiktok.com/@u/video/1234567890123456789",
      }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.message, "transcode_timeout");
      return true;
    },
  );
});

test("stream resolution retries alternate media URLs after transcode failure", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "retry-media-url-test-"));
  const attempted: string[] = [];
  const service = new StreamService({
    router: new DebridRouter([], 200),
    ffmpeg: {
      resolveToFile: async (sourceUrl: string, outputPath: string) => {
        attempted.push(sourceUrl);
        if (sourceUrl.includes("bad-source")) {
          throw new HttpError(500, "transcode_failed");
        }

        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, "ok", "utf-8");
      },
    },
    streamCache: new StreamCache(tempDir),
    localTtlMs: 60_000,
    resolveMediaUrls: async () => [
      "https://cdn.example/bad-source.mp4",
      "https://cdn.example/good-source.mp4",
    ],
  });

  const resolved = await service.resolve({
    sourceUrl: "https://www.tiktok.com/@u/video/1234567890123456789",
  });

  assert.equal(resolved.type, "file");
  assert.equal(attempted.length, 2);
  assert.equal(attempted[0], "https://cdn.example/bad-source.mp4");
  assert.equal(attempted[1], "https://cdn.example/good-source.mp4");
});
