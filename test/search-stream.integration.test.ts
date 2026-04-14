import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryCache } from "../src/cache/memory-cache.js";
import { DiskCache } from "../src/cache/disk-cache.js";
import { SearchService } from "../src/search/search-service.js";
import { TrendingIndex } from "../src/search/trending-index.js";
import { DebridRouter } from "../src/debrid/debrid-router.js";
import { StreamCache } from "../src/cache/stream-cache.js";
import { StreamService } from "../src/stream/stream-service.js";
import { SearchPage } from "../src/types.js";

test("search and stream success path", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "integration-test-success-"),
  );
  const trendingFile = path.join(tempDir, "trending.json");
  fs.writeFileSync(
    trendingFile,
    JSON.stringify([
      {
        id: "a",
        title: "Song A",
        artist: "Artist A",
        duration: 100,
        artworkURL: "https://example.com/a.jpg",
        streamURL: "https://www.tiktok.com/@u/video/1234567890123456789",
      },
    ]),
    "utf-8",
  );

  const searchService = new SearchService({
    memoryCache: new MemoryCache(60_000),
    diskCache: new DiskCache(path.join(tempDir, "search-cache"), 60_000),
    provider: {
      search: async () => ({ tracks: [], hasMore: false } as SearchPage),
    },
    trending: new TrendingIndex(trendingFile),
    defaultLimit: 36,
  });

  const tracks = await searchService.search("song");
  assert.equal(tracks.length, 1);

  const router = new DebridRouter(
    [
      {
        provider: "torbox",
        route: async () => ({
          provider: "torbox",
          url: "https://cdn.example/stream.mp3",
        }),
      },
    ],
    500,
  );
  const streamService = new StreamService({
    router,
    ffmpeg: {
      resolveToFile: async () => {
        throw new Error("should not transcode");
      },
    },
    streamCache: new StreamCache(path.join(tempDir, "stream-cache")),
    localTtlMs: 60_000,
    resolveMediaUrls: async (sourceUrl: string) => [sourceUrl],
  });

  const resolved = await streamService.resolve({
    sourceUrl: tracks[0].streamURL,
    torboxToken: "token",
  });
  assert.equal(resolved.type, "url");
});

test("degraded path returns empty search and local stream file", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "integration-test-degraded-"),
  );
  const searchService = new SearchService({
    memoryCache: new MemoryCache(60_000),
    diskCache: new DiskCache(path.join(tempDir, "search-cache"), 60_000),
    provider: {
      search: async () => {
        throw new Error("provider failure");
      },
    },
    trending: new TrendingIndex(path.join(tempDir, "missing.json")),
    defaultLimit: 36,
  });

  const tracks = await searchService.search("anything");
  assert.equal(tracks.length, 0);

  const streamService = new StreamService({
    router: new DebridRouter([], 500),
    ffmpeg: {
      resolveToFile: async (_sourceUrl: string, outputPath: string) => {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, "ok", "utf-8");
      },
    },
    streamCache: new StreamCache(path.join(tempDir, "stream-cache")),
    localTtlMs: 60_000,
    resolveMediaUrls: async (sourceUrl: string) => [sourceUrl],
  });

  const resolved = await streamService.resolve({
    sourceUrl: "https://www.tiktok.com/@u/video/1234567890123456789",
  });
  assert.equal(resolved.type, "file");
});
