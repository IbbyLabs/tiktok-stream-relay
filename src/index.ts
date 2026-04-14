import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { DiskCache } from "./cache/disk-cache.js";
import { MemoryCache } from "./cache/memory-cache.js";
import { StreamCache } from "./cache/stream-cache.js";
import { AddonLinkStore } from "./addon/addon-link-store.js";
import { LinkTokenService } from "./addon/link-token-service.js";
import { loadAppConfig } from "./config/app-config.js";
import { loadOrCreateRuntimeSecrets } from "./config/runtime-secrets.js";
import { SettingsStore } from "./config/settings-store.js";
import { TorboxAdapter } from "./debrid/adapters/torbox-adapter.js";
import { DebridRouter } from "./debrid/debrid-router.js";
import { PublicSafety } from "./public/public-safety.js";
import { MemoryRateLimitBackend, RedisRateLimitBackend } from "./public/rate-limit-backend.js";
import { SecurityEventLog } from "./public/security-events.js";
import { IbbyLabsParserProvider } from "./search/providers/ibbylabs-parser-provider.js";
import { SearchService } from "./search/search-service.js";
import { refreshTrendingSounds } from "./search/trending-refresh.js";
import { TrendingIndex } from "./search/trending-index.js";
import { CryptoBox } from "./security/crypto-box.js";
import { FfmpegResolver } from "./stream/ffmpeg-resolver.js";
import { StreamService } from "./stream/stream-service.js";
import { type SearchPage } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const manifestPath = path.join(rootDir, "manifest.json");
const config = loadAppConfig(rootDir);
const settingsStore = new SettingsStore(rootDir, {
  debridEnabled: config.debridEnabled,
  torboxToken: config.torboxToken,
});
const port = config.port;
const cacheRoot = config.cacheRoot;
const searchCacheDir = path.join(cacheRoot, "search");
const streamCacheDir = path.join(cacheRoot, "stream");
const trendingPath = path.join(rootDir, "config", "trending-sounds.json");

fs.mkdirSync(searchCacheDir, { recursive: true });
fs.mkdirSync(streamCacheDir, { recursive: true });

const memoryCache = new MemoryCache<SearchPage>(config.searchMemoryTtlMs, 100);
const diskCache = new DiskCache<SearchPage>(searchCacheDir, config.searchDiskTtlMs);
const provider = new IbbyLabsParserProvider(config.liveSearchMaxResults, {
  authCookie: config.tiktokAuthCookie,
  retryMaxAttempts: config.searchRetryMaxAttempts,
  retryBaseDelayMs: config.searchRetryBaseDelayMs,
});
const trending = new TrendingIndex(trendingPath);
const searchService = new SearchService({
  memoryCache,
  diskCache,
  provider,
  trending,
  defaultLimit: config.liveSearchMaxResults,
});

const debridRouter = new DebridRouter([new TorboxAdapter()], 7000);
const streamCache = new StreamCache(streamCacheDir);
const ffmpegResolver = new FfmpegResolver(config.streamResolutionTimeoutMs);
const streamService = new StreamService({
  router: debridRouter,
  ffmpeg: ffmpegResolver,
  streamCache,
  localTtlMs: config.streamLocalTtlMs,
});

const runtimeSecrets = loadOrCreateRuntimeSecrets(rootDir);
const effectiveCryptoSecret = config.addonCryptoSecret ?? runtimeSecrets.addonCryptoSecret;
const effectiveSigningKeys = config.addonLinkSigningKeys ?? runtimeSecrets.addonLinkSigningKeys;

const cryptoBox = new CryptoBox(effectiveCryptoSecret);
const addonLinkStore = new AddonLinkStore(rootDir, cryptoBox);
const linkTokenService = new LinkTokenService(
  effectiveSigningKeys,
  config.addonLinkTtlSeconds,
);
const securityEventLog = new SecurityEventLog();
const memoryRateLimitBackend = new MemoryRateLimitBackend();
const rateLimitBackend = config.redisUrl
  ? new RedisRateLimitBackend(config.redisUrl, memoryRateLimitBackend, config.publicLaunchMode)
  : memoryRateLimitBackend;

if (!config.redisUrl) {
  console.warn("rate_limit_backend=memory (single-instance mode)");
}

const publicSafety = new PublicSafety({
  portalEnabled: config.addonConfigEnabled,
  lifecycleEnabled: config.addonLifecycleEnabled,
  allowlist: config.publicAllowlistIps,
  backend: rateLimitBackend,
  onEnforcement: (action, reason) => {
    securityEventLog.record(`public_${action}`, reason);
  },
});

const app = createApp({
  manifestPath,
  config,
  settingsStore,
  searchService,
  streamService,
  memoryCache,
  diskCache,
  streamCache,
  addonLinkStore,
  linkTokenService,
  publicSafety,
  securityEventLog,
  adminTelemetryToken: config.adminTelemetryToken,
});

setInterval(() => {
  const removedSearch = diskCache.cleanupExpired();
  const streamStats = streamCache.cleanup(config.streamCacheMaxBytes);
  console.log(
    `cache cleanup: search_removed=${removedSearch} stream_removed=${streamStats.removed} stream_size_bytes=${streamStats.sizeBytes}`
  );
}, 60 * 60 * 1000);

async function runTrendingRefresh(): Promise<void> {
  const tracks = await refreshTrendingSounds({
    provider: {
      search: async (query: string) => {
        const page = await provider.search({
          query,
          limit: config.liveSearchMaxResults,
        });
        return page.tracks;
      },
    },
    seedQueries: config.trendingSeedQueries,
    maxItems: config.trendingMaxItems,
    outputPath: trendingPath,
  });
  trending.reload();
  memoryCache.clear();
  diskCache.clearAll();
  console.log(`trending refresh: items=${tracks.length}`);
}

if (config.trendingRefreshOnStartup) {
  void runTrendingRefresh().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `trending refresh unavailable on startup (${message}); continuing with cached trending data`
    );
  });
}

setInterval(() => {
  void runTrendingRefresh().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`trending refresh skipped this cycle (${message})`);
  });
}, config.trendingRefreshIntervalMs);

app.listen(port, () => {
  console.log(`IbbyLabs TikTok Stream Relay listening on http://localhost:${port}`);
});
