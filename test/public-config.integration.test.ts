import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddonLinkStore } from "../src/addon/addon-link-store.js";
import { LinkTokenService } from "../src/addon/link-token-service.js";
import { createApp } from "../src/app.js";
import { DiskCache } from "../src/cache/disk-cache.js";
import { MemoryCache } from "../src/cache/memory-cache.js";
import { StreamCache } from "../src/cache/stream-cache.js";
import { PublicSafety } from "../src/public/public-safety.js";
import { SecurityEventLog } from "../src/public/security-events.js";
import { CryptoBox } from "../src/security/crypto-box.js";
import { type SearchPage } from "../src/types.js";

test("public config flow supports lifecycle and stream credential injection", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "public-config-flow-"));
  const manifestPath = path.join(tempDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ name: "test" }), "utf8");

  const addonLinkStore = new AddonLinkStore(tempDir, new CryptoBox("test-secret"));
  const tokenService = new LinkTokenService("v1:test-signing-key", 3600);
  const securityEventLog = new SecurityEventLog();
  const publicSafety = new PublicSafety({
    portalEnabled: true,
    lifecycleEnabled: true,
    allowlist: [],
    onEnforcement: (action, reason) => securityEventLog.record(`public_${action}`, reason),
  });

  let lastResolveTokens: { torboxToken?: string } | undefined;

  const app = createApp({
    manifestPath,
    config: {
      debridEnabled: true,
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
      searchPage: async () => ({ tracks: [], hasMore: false } as SearchPage),
    },
    streamService: {
      resolve: async (args) => {
        lastResolveTokens = {
          torboxToken: args.torboxToken,
        };
        return { type: "url", url: "https://cdn.example/audio.mp3", provider: "torbox" as const };
      },
    },
    memoryCache: new MemoryCache<SearchPage>(60_000, 10),
    diskCache: new DiskCache<SearchPage>(path.join(tempDir, "search-cache"), 60_000),
    streamCache: new StreamCache(path.join(tempDir, "stream-cache")),
    addonLinkStore,
    linkTokenService: tokenService,
    publicSafety,
    securityEventLog,
    adminTelemetryToken: "admin-secret-token-123456789",
  });

  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server_address_unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const createResponse = await fetch(`${baseUrl}/api/config/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        debridEnabled: true,
        torboxToken: "torbox-token-1234",
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as {
      linkId: string;
      addonToken: string;
      addonUrl: string;
      status: string;
      availableRevisions: number[];
    };
    assert.equal(created.status, "active");
    assert.deepEqual(created.availableRevisions, [1]);

    const manifestResponse = await fetch(`${baseUrl}${created.addonUrl}`);
    assert.equal(manifestResponse.status, 200);
    assert.equal(manifestResponse.headers.get("access-control-allow-origin"), "*");

    const tokenPathSearchResponse = await fetch(
      `${baseUrl}/addon/${encodeURIComponent(created.addonToken)}/search?q=late`,
    );
    assert.equal(tokenPathSearchResponse.status, 200);

    const tokenPathStreamResponse = await fetch(
      `${baseUrl}/addon/${encodeURIComponent(created.addonToken)}/stream/${encodeURIComponent(Buffer.from("https://www.tiktok.com/@u/video/1234567890123456789", "utf8").toString("base64url"))}`,
    );
    assert.equal(tokenPathStreamResponse.status, 200);
    assert.equal(lastResolveTokens?.torboxToken, "torbox-token-1234");

    const updateResponse = await fetch(`${baseUrl}/api/config/${created.linkId}/update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-addon-link-token": created.addonToken,
      },
      body: JSON.stringify({
        debridEnabled: true,
        torboxToken: "torbox-token-9876",
      }),
    });
    assert.equal(updateResponse.status, 200);
    const updated = (await updateResponse.json()) as { activeRevisionId: number };
    assert.equal(updated.activeRevisionId, 2);

    const rollbackResponse = await fetch(`${baseUrl}/api/config/${created.linkId}/rollback`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-addon-link-token": created.addonToken,
      },
      body: JSON.stringify({ revisionId: 1 }),
    });
    assert.equal(rollbackResponse.status, 200);

    const streamResponse = await fetch(
      `${baseUrl}/stream/${encodeURIComponent(Buffer.from("https://www.tiktok.com/@u/video/1234567890123456789", "utf8").toString("base64url"))}?addonToken=${encodeURIComponent(created.addonToken)}`,
    );
    assert.equal(streamResponse.status, 200);
    assert.equal(streamResponse.headers.get("x-stream-provider"), "torbox");
    assert.equal(lastResolveTokens?.torboxToken, "torbox-token-1234");

    const rotateResponse = await fetch(`${baseUrl}/api/config/${created.linkId}/rotate`, {
      method: "POST",
      headers: { "x-addon-link-token": created.addonToken },
    });
    assert.equal(rotateResponse.status, 200);
    const rotated = (await rotateResponse.json()) as { linkId: string };
    assert.notEqual(rotated.linkId, created.linkId);

    const rotatedToken = (rotated as { addonToken?: string }).addonToken;
    assert.ok(rotatedToken);

    const supersededStreamResponse = await fetch(
      `${baseUrl}/stream/${encodeURIComponent(Buffer.from("https://www.tiktok.com/@u/video/1234567890123456789", "utf8").toString("base64url"))}?addonToken=${encodeURIComponent(created.addonToken)}`,
    );
    assert.equal(supersededStreamResponse.status, 401);

    const revokeResponse = await fetch(`${baseUrl}/api/config/${rotated.linkId}/revoke`, {
      method: "POST",
      headers: { "x-addon-link-token": rotatedToken },
    });
    assert.equal(revokeResponse.status, 200);

    const metricsUnauthorized = await fetch(`${baseUrl}/public/metrics`);
    assert.equal(metricsUnauthorized.status, 401);

    const metricsResponse = await fetch(`${baseUrl}/public/metrics`, {
      headers: { "x-admin-token": "admin-secret-token-123456789" },
    });
    assert.equal(metricsResponse.status, 200);
    const metrics = (await metricsResponse.json()) as {
      rateLimits: { throttled: number; denied: number };
      securityEvents: Record<string, number>;
    };
    assert.ok(metrics.securityEvents.link_issued >= 1);

    let rateLimited = false;
    for (let idx = 0; idx < 60; idx += 1) {
      const response = await fetch(`${baseUrl}/api/config/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          debridEnabled: true,
          torboxToken: "torbox-token-1234",
        }),
      });
      if (response.status === 429) {
        rateLimited = true;
        break;
      }
    }
    assert.equal(rateLimited, true);
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

test("lifecycle mutation rejects missing or mismatched addon token", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "public-config-authz-"));
  const manifestPath = path.join(tempDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ name: "test" }), "utf8");

  const addonLinkStore = new AddonLinkStore(tempDir, new CryptoBox("test-secret"));
  const tokenService = new LinkTokenService("v1:test-signing-key", 3600);

  const app = createApp({
    manifestPath,
    config: {
      debridEnabled: true,
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
      searchPage: async () => ({ tracks: [], hasMore: false } as SearchPage),
    },
    streamService: {
      resolve: async () => ({ type: "url", url: "https://cdn.example/audio.mp3", provider: "torbox" as const }),
    },
    memoryCache: new MemoryCache<SearchPage>(60_000, 10),
    diskCache: new DiskCache<SearchPage>(path.join(tempDir, "search-cache"), 60_000),
    streamCache: new StreamCache(path.join(tempDir, "stream-cache")),
    addonLinkStore,
    linkTokenService: tokenService,
  });

  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server_address_unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const createA = await fetch(`${baseUrl}/api/config/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ debridEnabled: true, torboxToken: "torbox-token-1111" }),
    });
    const createdA = (await createA.json()) as { linkId: string; addonToken: string };

    const createB = await fetch(`${baseUrl}/api/config/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ debridEnabled: true, torboxToken: "torbox-token-2222" }),
    });
    const createdB = (await createB.json()) as { linkId: string; addonToken: string };

    const missingToken = await fetch(`${baseUrl}/api/config/${createdA.linkId}/rotate`, { method: "POST" });
    assert.equal(missingToken.status, 401);

    const mismatchedToken = await fetch(`${baseUrl}/api/config/${createdA.linkId}/rotate`, {
      method: "POST",
      headers: { "x-addon-link-token": createdB.addonToken },
    });
    assert.equal(mismatchedToken.status, 403);
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

test("stream fails closed for invalid addon token", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "public-config-fail-closed-"));
  const manifestPath = path.join(tempDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ name: "test" }), "utf8");

  let resolveCalls = 0;
  const app = createApp({
    manifestPath,
    config: {
      debridEnabled: true,
      streamCacheMaxBytes: 1024,
      liveSearchMaxResults: 10,
      searchMaxLimit: 20,
    },
    settingsStore: {
      get: () => ({ debridEnabled: true, torboxToken: "fallback-token" }),
      save: () => ({ debridEnabled: true, torboxToken: "fallback-token" }),
    },
    searchService: {
      search: async () => [],
      searchPage: async () => ({ tracks: [], hasMore: false } as SearchPage),
    },
    streamService: {
      resolve: async () => {
        resolveCalls += 1;
        return { type: "url", url: "https://cdn.example/audio.mp3", provider: "torbox" as const };
      },
    },
    memoryCache: new MemoryCache<SearchPage>(60_000, 10),
    diskCache: new DiskCache<SearchPage>(path.join(tempDir, "search-cache"), 60_000),
    streamCache: new StreamCache(path.join(tempDir, "stream-cache")),
    addonLinkStore: new AddonLinkStore(tempDir, new CryptoBox("test-secret")),
    linkTokenService: new LinkTokenService("v1:test-signing-key", 3600),
  });

  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server_address_unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(
      `${baseUrl}/stream/${encodeURIComponent(Buffer.from("https://www.tiktok.com/@u/video/1234567890123456789", "utf8").toString("base64url"))}?addonToken=bad.token`,
    );
    assert.equal(response.status, 401);
    assert.equal(resolveCalls, 0);
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
