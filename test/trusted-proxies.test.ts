import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { resolveTrustedProxies } from "../src/trusted-proxies.js";

async function clientIp(forwardedFor: string, raw?: string): Promise<string> {
  const app = express();
  app.set("trust proxy", resolveTrustedProxies(raw ?? ""));
  app.get("/ip", (request, response) => {
    response.json({ ip: request.ip });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/ip`, {
      headers: { "x-forwarded-for": forwardedFor },
    });
    return ((await response.json()) as { ip: string }).ip;
  } finally {
    server.close();
  }
}

test("req.ip skips the Cloudflare edge hop and returns the viewer", async () => {
  assert.equal(await clientIp("203.0.113.9, 172.71.26.99"), "203.0.113.9");
});

test("a forged leading X-Forwarded-For entry does not win", async () => {
  assert.equal(
    await clientIp("1.2.3.4, 203.0.113.9, 172.71.26.99"),
    "203.0.113.9",
  );
});

test("TRUSTED_PROXIES overrides the defaults", () => {
  assert.deepEqual(resolveTrustedProxies(" 10.0.0.0/8, loopback "), [
    "10.0.0.0/8",
    "loopback",
  ]);
});
