import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadAppConfig } from "../src/config/app-config.js";

test("loadAppConfig ignores blank optional secrets in .env", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-config-test-"));
  const envPath = path.join(tempDir, ".env");
  fs.writeFileSync(
    envPath,
    [
      "ADDON_LINK_SIGNING_KEYS=",
      "ADDON_CRYPTO_SECRET=   ",
      "ADMIN_TELEMETRY_TOKEN=",
      "REDIS_URL=",
      "TORBOX_TOKEN=",
      "TIKTOK_AUTH_COOKIE=",
    ].join("\n"),
    "utf-8",
  );

  const originalEnv = {
    ADDON_LINK_SIGNING_KEYS: process.env.ADDON_LINK_SIGNING_KEYS,
    ADDON_CRYPTO_SECRET: process.env.ADDON_CRYPTO_SECRET,
    ADMIN_TELEMETRY_TOKEN: process.env.ADMIN_TELEMETRY_TOKEN,
    REDIS_URL: process.env.REDIS_URL,
    TORBOX_TOKEN: process.env.TORBOX_TOKEN,
    TIKTOK_AUTH_COOKIE: process.env.TIKTOK_AUTH_COOKIE,
  };

  delete process.env.ADDON_LINK_SIGNING_KEYS;
  delete process.env.ADDON_CRYPTO_SECRET;
  delete process.env.ADMIN_TELEMETRY_TOKEN;
  delete process.env.REDIS_URL;
  delete process.env.TORBOX_TOKEN;
  delete process.env.TIKTOK_AUTH_COOKIE;

  try {
    const config = loadAppConfig(tempDir);
    assert.equal(config.addonLinkSigningKeys, undefined);
    assert.equal(config.addonCryptoSecret, undefined);
    assert.equal(config.adminTelemetryToken, undefined);
    assert.equal(config.redisUrl, undefined);
    assert.equal(config.torboxToken, undefined);
    assert.equal(config.tiktokAuthCookie, undefined);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (typeof value === "string") {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  }
});