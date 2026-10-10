import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AddonLinkStore } from "../src/addon/addon-link-store.js";
import { StreamCache } from "../src/cache/stream-cache.js";
import { SettingsStore } from "../src/config/settings-store.js";
import { CryptoBox } from "../src/security/crypto-box.js";

function tempRoot(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  return dir;
}

function silenceConsoleError(t: test.TestContext): void {
  t.mock.method(console, "error", () => undefined);
}

function leftoverTempFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.includes(".tmp-"));
}

test("concurrent link writes all persist", async () => {
  const root = tempRoot("link-concurrent-");
  const store = new AddonLinkStore(root, new CryptoBox("test-secret"));

  const created = await Promise.all(
    Array.from({ length: 25 }, () =>
      Promise.resolve().then(() => store.create({ debridEnabled: false })),
    ),
  );

  const reopened = new AddonLinkStore(root, new CryptoBox("test-secret"));
  for (const link of created) {
    assert.equal(reopened.get(link.linkId)?.linkId, link.linkId);
  }
  assert.equal(reopened.listEvents(1000).length, 25);
  assert.deepEqual(leftoverTempFiles(path.join(root, "config")), []);
});

test("a corrupt link file is not overwritten by the next write", (t) => {
  silenceConsoleError(t);
  const root = tempRoot("link-corrupt-");
  const filePath = path.join(root, "config", "addon-links.json");
  const corrupt = '{"links":[{"linkId":"keep-me"';
  fs.writeFileSync(filePath, corrupt, "utf8");
  const store = new AddonLinkStore(root, new CryptoBox("test-secret"));

  assert.throws(() => store.create({ debridEnabled: false }), /link_store_unreadable/);
  assert.equal(fs.readFileSync(filePath, "utf8"), corrupt);
});

test("a link store keeps its last good copy when the file goes corrupt", (t) => {
  silenceConsoleError(t);
  const root = tempRoot("link-last-good-");
  const filePath = path.join(root, "config", "addon-links.json");
  const store = new AddonLinkStore(root, new CryptoBox("test-secret"));
  const link = store.create({ debridEnabled: false });

  fs.writeFileSync(filePath, "{", "utf8");

  assert.equal(store.get(link.linkId)?.linkId, link.linkId);
  assert.throws(() => store.revoke(link.linkId), /link_store_unreadable/);
  assert.equal(fs.readFileSync(filePath, "utf8"), "{");
});

test("a missing link file is an empty start", () => {
  const root = tempRoot("link-missing-");
  const store = new AddonLinkStore(root, new CryptoBox("test-secret"));
  fs.rmSync(path.join(root, "config", "addon-links.json"));

  const link = store.create({ debridEnabled: false });
  assert.equal(store.get(link.linkId)?.linkId, link.linkId);
});

test("a write that dies part way leaves the previous link file intact", (t) => {
  const root = tempRoot("link-torn-");
  const filePath = path.join(root, "config", "addon-links.json");
  const store = new AddonLinkStore(root, new CryptoBox("test-secret"));
  const link = store.create({ debridEnabled: false });
  const before = fs.readFileSync(filePath, "utf8");

  const realWrite = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (target: fs.PathOrFileDescriptor, data: string) => {
    realWrite(target, data.slice(0, Math.floor(data.length / 2)));
    throw new Error("simulated crash");
  });
  assert.throws(() => store.create({ debridEnabled: false }), /simulated crash/);
  t.mock.restoreAll();

  assert.equal(fs.readFileSync(filePath, "utf8"), before);
  assert.equal(new AddonLinkStore(root, new CryptoBox("test-secret")).get(link.linkId)?.linkId, link.linkId);
  assert.deepEqual(leftoverTempFiles(path.join(root, "config")), []);
});

test("concurrent settings saves all persist", async () => {
  const root = tempRoot("settings-concurrent-");
  const store = new SettingsStore(root);

  await Promise.all([
    Promise.resolve().then(() => store.save({ torboxToken: "token-aaaa-1234" })),
    Promise.resolve().then(() => store.save({ debridEnabled: false })),
  ]);

  const reopened = new SettingsStore(root).get();
  assert.equal(reopened.torboxToken, "token-aaaa-1234");
  assert.equal(reopened.debridEnabled, false);
  assert.deepEqual(leftoverTempFiles(path.join(root, "config")), []);
});

test("a corrupt settings file is not overwritten by the next save", (t) => {
  silenceConsoleError(t);
  const root = tempRoot("settings-corrupt-");
  const filePath = path.join(root, "config", "settings.json");
  const corrupt = '{"debridEnabled":false,"torboxToken":"tok';
  fs.writeFileSync(filePath, corrupt, "utf-8");
  const store = new SettingsStore(root);

  assert.throws(() => store.save({ debridEnabled: true }), /settings_store_unreadable/);
  assert.equal(fs.readFileSync(filePath, "utf-8"), corrupt);
});

test("stream cache metadata writes leave no temp files and persist", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stream-cache-atomic-"));
  const cache = new StreamCache(dir);
  const audio = cache.createOutputPath("k1");
  fs.writeFileSync(audio, "x");
  cache.set("k1", audio, 60_000);

  assert.equal(new StreamCache(dir).getValidFilePath("k1"), audio);
  assert.deepEqual(leftoverTempFiles(dir), []);
});
