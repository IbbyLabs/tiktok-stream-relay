import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { MemoryCache } from "../src/cache/memory-cache.js";
import { DiskCache } from "../src/cache/disk-cache.js";
import { StreamCache } from "../src/cache/stream-cache.js";
import { type NormalizedTrack, type SearchPage } from "../src/types.js";

interface SearchTrackPayload {
  id: string;
  title: string;
  artist: string;
  duration: number;
  artworkURL: string;
}

interface SearchPayload {
  tracks: SearchTrackPayload[];
  hasMore: boolean;
  nextCursor?: string;
  partial?: boolean;
}

test("eclipse addon flow supports search to playable audio response", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ibbylabs-stream-relay-e2e-"));
  const manifestPath = path.join(tempDir, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      id: "com.ibby.tiktok-stream-relay",
      name: "IbbyLabs TikTok Stream Relay",
      version: "0.1.0",
      resources: ["search", "stream"],
      types: ["track"],
    }),
    "utf-8"
  );

  const streamCache = new StreamCache(path.join(tempDir, "stream-cache"));
  const sourceUrl = "https://www.tiktok.com/@u/video/1234567890123456789";
  const cacheKey = streamCache.keyFromUrl(sourceUrl, "mp3");
  const audioPath = streamCache.createOutputPath(cacheKey, "mp3");
  fs.writeFileSync(audioPath, "audio-bytes", "utf-8");
  streamCache.set(cacheKey, audioPath, 60_000);

  const track: NormalizedTrack = {
    id: "track-1",
    title: "Song A",
    artist: "Artist A",
    duration: 120,
    artworkURL: "https://example.com/art.jpg",
    streamURL: sourceUrl,
  };

  const settingsState = { debridEnabled: false };
  const app = createApp({
    manifestPath,
    config: {
      debridEnabled: true,
      streamCacheMaxBytes: 1024 * 1024,
      liveSearchMaxResults: 36,
      searchMaxLimit: 60,
    },
    settingsStore: {
      get: () => settingsState,
      save: (next) => {
        Object.assign(settingsState, next);
        return settingsState;
      },
    },
    searchService: {
      search: async () => [track],
      searchPage: async () => ({ tracks: [track], hasMore: false } as SearchPage),
    },
    streamService: {
      resolve: async () => ({ type: "file", filePath: audioPath }),
    },
    memoryCache: new MemoryCache<SearchPage>(60_000, 10),
    diskCache: new DiskCache<SearchPage>(path.join(tempDir, "search-cache"), 60_000),
    streamCache,
  });

  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server_address_unavailable");
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;

    const searchResponse = await fetch(`${baseUrl}/search?q=song`);
    assert.equal(searchResponse.status, 200);
    const searchBody = (await searchResponse.json()) as SearchPayload;
    assert.equal(searchBody.tracks.length, 1);
    assert.equal(searchBody.tracks[0].title, track.title);
    assert.equal(searchBody.tracks[0].artist, track.artist);
    assert.equal(searchBody.hasMore, false);
    assert.equal((searchBody.tracks[0] as Record<string, unknown>).streamURL, undefined);

    const streamResponse = await fetch(`${baseUrl}/stream/${searchBody.tracks[0].id}`);
    assert.equal(streamResponse.status, 200);
    assert.equal(streamResponse.headers.get("content-type"), "application/json; charset=utf-8");
    const streamBody = (await streamResponse.json()) as { url: string; format: string };
    assert.equal(streamBody.format, "mp3");

    const mediaResponse = await fetch(streamBody.url);
    assert.equal(mediaResponse.status, 200);
    assert.equal(mediaResponse.headers.get("content-type"), "audio/mpeg");
    const audioBody = await mediaResponse.text();
    assert.equal(audioBody, "audio-bytes");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});

test("search pagination returns next cursor and follow-up page", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ibbylabs-stream-relay-pagination-"));
  const manifestPath = path.join(tempDir, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      id: "com.ibby.tiktok-stream-relay",
      name: "IbbyLabs TikTok Stream Relay",
      version: "0.1.0",
      resources: ["search", "stream"],
      types: ["track"],
    }),
    "utf-8"
  );

  const app = createApp({
    manifestPath,
    config: {
      debridEnabled: true,
      streamCacheMaxBytes: 1024 * 1024,
      liveSearchMaxResults: 2,
      searchMaxLimit: 10,
    },
    settingsStore: {
      get: () => ({ debridEnabled: false }),
      save: () => ({ debridEnabled: false }),
    },
    searchService: {
      search: async () => [],
      searchPage: async (args) => {
        if (!args.cursor) {
          return {
            tracks: [
              {
                id: "video:1",
                title: "first",
                artist: "a",
                duration: 10,
                artworkURL: "https://example.com/1.jpg",
                streamURL: "https://www.tiktok.com/@u/video/1",
              },
            ],
            hasMore: true,
            nextCursor: 77,
          };
        }

        assert.equal(args.cursor, 77);
        return {
          tracks: [
            {
              id: "video:2",
              title: "second",
              artist: "b",
              duration: 10,
              artworkURL: "https://example.com/2.jpg",
              streamURL: "https://www.tiktok.com/@u/video/2",
            },
          ],
          hasMore: false,
        };
      },
    },
    streamService: {
      resolve: async () => ({ type: "url", url: "https://example.com", provider: "torbox" }),
    },
    memoryCache: new MemoryCache<SearchPage>(60_000, 10),
    diskCache: new DiskCache<SearchPage>(path.join(tempDir, "search-cache"), 60_000),
    streamCache: new StreamCache(path.join(tempDir, "stream-cache")),
  });

  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server_address_unavailable");
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;
    const page1Response = await fetch(`${baseUrl}/search?q=tate%20mcrae%20leaks&limit=2`);
    assert.equal(page1Response.status, 200);
    const page1Body = (await page1Response.json()) as SearchPayload;
    assert.equal(page1Body.tracks.length, 1);
    assert.equal(page1Body.hasMore, true);
    assert.ok(page1Body.nextCursor);

    const page2Response = await fetch(
      `${baseUrl}/search?q=tate%20mcrae%20leaks&limit=2&cursor=${encodeURIComponent(page1Body.nextCursor as string)}`,
    );
    assert.equal(page2Response.status, 200);
    const page2Body = (await page2Response.json()) as SearchPayload;
    assert.equal(page2Body.tracks.length, 1);
    assert.equal(page2Body.tracks[0].title, "second");
    assert.equal(page2Body.hasMore, false);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});

test("search pagination rejects invalid cursor", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ibbylabs-stream-relay-cursor-"));
  const manifestPath = path.join(tempDir, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      id: "com.ibby.tiktok-stream-relay",
      name: "IbbyLabs TikTok Stream Relay",
      version: "0.1.0",
      resources: ["search", "stream"],
      types: ["track"],
    }),
    "utf-8"
  );

  const app = createApp({
    manifestPath,
    config: {
      debridEnabled: true,
      streamCacheMaxBytes: 1024 * 1024,
      liveSearchMaxResults: 2,
      searchMaxLimit: 10,
    },
    settingsStore: {
      get: () => ({ debridEnabled: false }),
      save: () => ({ debridEnabled: false }),
    },
    searchService: {
      search: async () => [],
      searchPage: async () => ({ tracks: [], hasMore: false }),
    },
    streamService: {
      resolve: async () => ({ type: "url", url: "https://example.com", provider: "torbox" }),
    },
    memoryCache: new MemoryCache<SearchPage>(60_000, 10),
    diskCache: new DiskCache<SearchPage>(path.join(tempDir, "search-cache"), 60_000),
    streamCache: new StreamCache(path.join(tempDir, "stream-cache")),
  });

  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server_address_unavailable");
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${baseUrl}/search?q=tate%20mcrae%20leaks&limit=2&cursor=not-a-cursor`);
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, "invalid_cursor");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});
