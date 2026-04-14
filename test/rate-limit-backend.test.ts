import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRateLimitBackend, RedisRateLimitBackend } from "../src/public/rate-limit-backend.js";

test("RedisRateLimitBackend falls back quickly when redis connect hangs", async () => {
  const fallback = new MemoryRateLimitBackend();
  const client = {
    isOpen: false,
    on: () => client,
    connect: () => new Promise<void>(() => {}),
  } as RedisRateLimitBackend extends { client: infer T } ? T : never;

  const backend = new RedisRateLimitBackend(
    "redis://127.0.0.1:6379",
    fallback,
    false,
    client,
    25,
  );

  const startedAt = Date.now();
  const counter = await backend.increment("health:127.0.0.1", 60_000);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(counter.count, 1);
  assert.ok(elapsedMs < 250);
});