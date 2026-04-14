import assert from "node:assert/strict";
import test from "node:test";
import { LinkTokenService } from "../src/addon/link-token-service.js";

test("LinkTokenService accepts a single raw signing key as v1", () => {
  const service = new LinkTokenService("test-signing-key", 3600);
  const token = service.issue("link-123");
  const payload = service.verify(token);

  assert.equal(payload.linkId, "link-123");
  assert.equal(payload.v, "v1");
});