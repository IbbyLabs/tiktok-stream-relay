import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { refreshTrendingSounds } from "../src/search/trending-refresh.js";
import { NormalizedTrack } from "../src/types.js";

function createTrack(id: string, title: string): NormalizedTrack {
  return {
    id,
    title,
    artist: `${title} Artist`,
    duration: 120,
    artworkURL: `https://example.com/${id}.jpg`,
    streamURL: `https://example.com/${id}`,
  };
}

test("refreshTrendingSounds continues after a failed seed query", async () => {
  const outputPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "trending-refresh-")), "trending.json");

  const tracks = await refreshTrendingSounds({
    provider: {
      search: async (query: string) => {
        if (query === "first") {
          throw new Error("upstream_status_error");
        }
        return [createTrack("track-1", "Recovered Track")];
      },
    },
    seedQueries: ["first", "second"],
    maxItems: 12,
    outputPath,
  });

  assert.equal(tracks.length, 1);
  assert.equal(tracks[0]?.id, "track-1");

  const persisted = JSON.parse(fs.readFileSync(outputPath, "utf8")) as NormalizedTrack[];
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.id, "track-1");
});

test("refreshTrendingSounds rethrows when every seed query fails", async () => {
  const outputPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "trending-refresh-")), "trending.json");

  await assert.rejects(
    refreshTrendingSounds({
      provider: {
        search: async () => {
          throw new Error("upstream_status_error");
        },
      },
      seedQueries: ["first", "second"],
      maxItems: 12,
      outputPath,
    }),
    /upstream_status_error/,
  );
});