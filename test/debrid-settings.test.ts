import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SettingsStore } from "../src/config/settings-store.js";

test("settings store accepts valid debrid tokens", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-valid-token-"),
  );
  fs.mkdirSync(path.join(tempDir, "config"), { recursive: true });
  const store = new SettingsStore(tempDir);

  const saved = store.save({
    torboxToken: "valid-token-1234",
    debridEnabled: true,
  });

  assert.equal(saved.debridEnabled, true);
  assert.equal(saved.torboxToken, "valid-token-1234");
});

test("settings store rejects invalid debrid token", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "settings-invalid-token-"),
  );
  fs.mkdirSync(path.join(tempDir, "config"), { recursive: true });
  const store = new SettingsStore(tempDir);

  assert.throws(() => {
    store.save({ torboxToken: "short" });
  }, /invalid_torbox_token/);
});
