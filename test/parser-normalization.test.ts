import test from "node:test";
import assert from "node:assert/strict";
import { normalizeParsedItem } from "../src/search/providers/ibbylabs-parser-provider.js";

test("normalizeParsedItem returns normalized track for valid input", () => {
  const normalized = normalizeParsedItem({
    id: "123",
    title: "Song",
    artist: "Artist",
    duration: 120,
    artworkURL: "https://example.com/art.jpg",
    streamURL: "https://www.tiktok.com/@x/video/1",
  });

  assert.deepEqual(normalized, {
    id: "123",
    title: "Song",
    artist: "Artist",
    duration: 120,
    artworkURL: "https://example.com/art.jpg",
    streamURL: "https://www.tiktok.com/@x/video/1",
    playbackURL: undefined,
  });
});

test("normalizeParsedItem filters invalid parsed item", () => {
  const normalized = normalizeParsedItem({
    id: "123",
    title: "Song",
    artist: "Artist",
    duration: 120,
    artworkURL: "https://example.com/art.jpg",
  });

  assert.equal(normalized, null);
});
