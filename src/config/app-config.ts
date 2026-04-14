import fs from "node:fs";
import path from "node:path";

export interface AppConfig {
  port: number;
  cacheRoot: string;
  searchMemoryTtlMs: number;
  searchDiskTtlMs: number;
  liveSearchMaxResults: number;
  searchMaxLimit: number;
  tiktokAuthCookie?: string;
  searchRetryMaxAttempts: number;
  searchRetryBaseDelayMs: number;
  trendingRefreshOnStartup: boolean;
  trendingRefreshIntervalMs: number;
  streamLocalTtlMs: number;
  streamCacheMaxBytes: number;
  streamResolutionTimeoutMs: number;
  debridEnabled: boolean;
  trendingSeedQueries: string[];
  trendingMaxItems: number;
  redisUrl?: string;
  torboxToken?: string;
  addonConfigEnabled: boolean;
  addonLifecycleEnabled: boolean;
  addonLinkTtlSeconds: number;
  addonLinkSigningKeys?: string;
  addonCryptoSecret?: string;
  publicLaunchMode: boolean;
  adminTelemetryToken?: string;
  publicAllowlistIps: string[];
}

function isWeakSecret(value: string): boolean {
  return value.length < 24 || value.includes("change-me");
}

function validatePublicLaunchConfig(config: AppConfig): void {
  if (!config.publicLaunchMode) {
    return;
  }

  if (!config.addonLinkSigningKeys || isWeakSecret(config.addonLinkSigningKeys)) {
    throw new Error("invalid_addon_link_signing_keys_for_public_launch");
  }

  if (!config.addonCryptoSecret || isWeakSecret(config.addonCryptoSecret)) {
    throw new Error("invalid_addon_crypto_secret_for_public_launch");
  }

  if (!config.adminTelemetryToken || isWeakSecret(config.adminTelemetryToken)) {
    throw new Error("invalid_admin_telemetry_token_for_public_launch");
  }

  if (!config.redisUrl) {
    throw new Error("redis_url_required_for_public_launch");
  }
}

function loadDotEnv(rootDir: string): void {
  const envPath = path.join(rootDir, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }
  const raw = fs.readFileSync(envPath, "utf-8");
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const idx = trimmed.indexOf("=");
    if (idx < 1) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? next : fallback;
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  if (!value) {
    return fallback;
  }
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

export function loadAppConfig(rootDir: string): AppConfig {
  loadDotEnv(rootDir);

  const defaultTrendingQueries = [
    "sabrina carpenter",
    "billie eilish",
    "chappell roan",
    "doechii",
    "benson boone",
    "lady gaga bruno mars",
  ];

  const config: AppConfig = {
    port: parseNumber(process.env.PORT, 3000),
    cacheRoot: process.env.CACHE_ROOT
      ? path.resolve(rootDir, process.env.CACHE_ROOT)
      : path.join(rootDir, "cache"),
    searchMemoryTtlMs: parseNumber(
      process.env.SEARCH_MEMORY_TTL_MS,
      30 * 60 * 1000,
    ),
    searchDiskTtlMs: parseNumber(
      process.env.SEARCH_DISK_TTL_MS,
      24 * 60 * 60 * 1000,
    ),
    liveSearchMaxResults: parseNumber(process.env.LIVE_SEARCH_MAX_RESULTS, 36),
    searchMaxLimit: parseNumber(process.env.SEARCH_MAX_LIMIT, 60),
    tiktokAuthCookie: process.env.TIKTOK_AUTH_COOKIE,
    searchRetryMaxAttempts: parseNumber(process.env.SEARCH_RETRY_MAX_ATTEMPTS, 2),
    searchRetryBaseDelayMs: parseNumber(process.env.SEARCH_RETRY_BASE_DELAY_MS, 250),
    trendingRefreshOnStartup: parseBoolean(
      process.env.TRENDING_REFRESH_ON_STARTUP,
      false,
    ),
    trendingRefreshIntervalMs: parseNumber(
      process.env.TRENDING_REFRESH_INTERVAL_MS,
      6 * 60 * 60 * 1000,
    ),
    streamLocalTtlMs: parseNumber(
      process.env.STREAM_LOCAL_TTL_MS,
      48 * 60 * 60 * 1000,
    ),
    streamCacheMaxBytes: parseNumber(
      process.env.STREAM_CACHE_MAX_BYTES,
      50 * 1024 * 1024 * 1024,
    ),
    streamResolutionTimeoutMs: parseNumber(
      process.env.STREAM_TIMEOUT_MS,
      30_000,
    ),
    debridEnabled: parseBoolean(process.env.DEBRID_ENABLED, true),
    trendingSeedQueries: parseList(
      process.env.TRENDING_SEED_QUERIES,
      defaultTrendingQueries,
    ),
    trendingMaxItems: parseNumber(process.env.TRENDING_MAX_ITEMS, 12),
    redisUrl: process.env.REDIS_URL,
    torboxToken: process.env.TORBOX_TOKEN,
    addonConfigEnabled: parseBoolean(process.env.ADDON_CONFIG_ENABLED, true),
    addonLifecycleEnabled: parseBoolean(process.env.ADDON_LIFECYCLE_ENABLED, true),
    addonLinkTtlSeconds: parseNumber(process.env.ADDON_LINK_TTL_SECONDS, 7 * 24 * 60 * 60),
    addonLinkSigningKeys: process.env.ADDON_LINK_SIGNING_KEYS,
    addonCryptoSecret: process.env.ADDON_CRYPTO_SECRET,
    publicLaunchMode: parseBoolean(process.env.PUBLIC_LAUNCH_MODE, false),
    adminTelemetryToken: process.env.ADMIN_TELEMETRY_TOKEN,
    publicAllowlistIps: parseList(process.env.PUBLIC_ALLOWLIST_IPS, []),
  };

  validatePublicLaunchConfig(config);
  return config;
}
