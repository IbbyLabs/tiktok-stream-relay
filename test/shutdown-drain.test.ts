import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { DiskCache } from "../src/cache/disk-cache.js";
import { MemoryCache } from "../src/cache/memory-cache.js";
import { StreamCache } from "../src/cache/stream-cache.js";
import { createShutdownDrain } from "../src/shutdown-drain.js";
import { type SearchPage } from "../src/types.js";

test("ready flips to 503 once draining begins while health stays 200", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shutdown-drain-"));
  const manifestPath = path.join(tempDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ name: "test" }), "utf8");

  let closed: (() => void) | undefined;
  const serverClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const drain = createShutdownDrain({
    drainSeconds: 0.2,
    onClosed: () => closed?.(),
  });

  const app = createApp({
    manifestPath,
    config: {
      debridEnabled: false,
      streamCacheMaxBytes: 1024,
      liveSearchMaxResults: 10,
      searchMaxLimit: 20,
    },
    settingsStore: {
      get: () => ({ debridEnabled: false }),
      save: () => ({ debridEnabled: false }),
    },
    searchService: {
      search: async () => [],
      searchPage: async () => ({ tracks: [], hasMore: false }) as SearchPage,
    },
    streamService: {
      resolve: async () => ({
        type: "url",
        url: "https://cdn.example/a.mp3",
        provider: "torbox" as const,
      }),
    },
    memoryCache: new MemoryCache<SearchPage>(60_000, 10),
    diskCache: new DiskCache<SearchPage>(
      path.join(tempDir, "search-cache"),
      60_000,
    ),
    streamCache: new StreamCache(path.join(tempDir, "stream-cache")),
    isDraining: drain.isDraining,
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) =>
    server.once("listening", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server_address_unavailable");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const before = await fetch(`${baseUrl}/ready`, {
      headers: { connection: "close" },
    });
    assert.equal(before.status, 200);
    assert.deepEqual(await before.json(), { status: "ready" });

    drain.begin(server);

    const during = await fetch(`${baseUrl}/ready`, {
      headers: { connection: "close" },
    });
    assert.equal(during.status, 503);
    assert.deepEqual(await during.json(), { status: "draining" });

    const health = await fetch(`${baseUrl}/health`, {
      headers: { connection: "close" },
    });
    assert.equal(health.status, 200);

    await serverClosed;
    assert.equal(server.listening, false);
  } finally {
    if (server.listening) {
      server.close();
    }
  }
});
