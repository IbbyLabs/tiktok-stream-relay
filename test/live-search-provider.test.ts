import assert from "node:assert/strict";
import test from "node:test";
import {
  computeRelevanceScore,
  formatTrackTitle,
  normalizeSearchResultItem,
} from "../src/search/providers/ibbylabs-parser-provider.js";

test("normalizeSearchResultItem returns normalized track for video entries", () => {
  const normalized = normalizeSearchResultItem({
    type: 1,
    item: {
      id: "12345",
      desc: "Video caption",
      author: {
        nickname: "Video Creator",
        uniqueId: "artist-id",
      },
      video: {
        duration: 17,
        cover: "https://example.com/video-cover.jpg",
      },
      music: {
        id: "sound-1",
        title: "Sound Title",
        authorName: "Sound Artist",
        duration: 60,
        coverLarge: "https://example.com/music-cover.jpg",
        playUrl: "https://sf77-ies-music-sg.tiktokcdn.com/obj/tos-alisg-ve-2774/example-track",
      },
    },
  });

  assert.deepEqual(normalized, {
    id: "video:12345",
    title: "Video caption",
    artist: "Sound Artist",
    duration: 60,
    artworkURL: "https://example.com/music-cover.jpg",
    streamURL: "https://www.tiktok.com/@artist-id/video/12345",
    playbackURL: "https://sf77-ies-music-sg.tiktokcdn.com/obj/tos-alisg-ve-2774/example-track",
  });
});

test("normalizeSearchResultItem ignores non-video entries", () => {
  assert.equal(
    normalizeSearchResultItem({
      type: 4,
      item: {
        id: "user-card",
      },
    }),
    null,
  );
});

test("formatTrackTitle strips hashtags and mentions", () => {
  const title = formatTrackTitle(
    "@tate mcrae NEW TATE MCRAE SONG LEAKS?! #tatemcrae #fyp #viral",
    "original sound",
  );

  assert.equal(title, "mcrae NEW TATE MCRAE SONG LEAKS?!");
});

test("formatTrackTitle falls back to sound title when description is only tags", () => {
  const title = formatTrackTitle("@tate #tatemcrae #fyp", "original sound");
  assert.equal(title, "original sound");
});

test("formatTrackTitle truncates long text to readable length", () => {
  const title = formatTrackTitle(
    "This is a very long caption that keeps going with lots of detail about the song release and behind the scenes context and extra words to exceed the title length threshold",
    "original sound",
  );

  assert.ok(title);
  assert.ok(title!.endsWith("..."));
  assert.ok(title!.length <= 113);
});

test("normalizeSearchResultItem preserves distinct videos that share one sound", () => {
  const first = normalizeSearchResultItem({
    type: 1,
    item: {
      id: "111",
      desc: "first clip",
      author: {
        nickname: "one",
        uniqueId: "artist-id",
      },
      video: {
        duration: 17,
        cover: "https://example.com/1.jpg",
      },
      music: {
        id: "shared-sound",
        title: "Sound Title",
        authorName: "Sound Artist",
        duration: 60,
        coverLarge: "https://example.com/music-cover.jpg",
      },
    },
  });

  const second = normalizeSearchResultItem({
    type: 1,
    item: {
      id: "222",
      desc: "second clip",
      author: {
        nickname: "two",
        uniqueId: "artist-id",
      },
      video: {
        duration: 18,
        cover: "https://example.com/2.jpg",
      },
      music: {
        id: "shared-sound",
        title: "Sound Title",
        authorName: "Sound Artist",
        duration: 60,
        coverLarge: "https://example.com/music-cover.jpg",
      },
    },
  });

  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first!.id, second!.id);
});

test("computeRelevanceScore prefers exact query phrase matches", () => {
  const exact = computeRelevanceScore("tate mcrae leaks", "NEW TATE MCRAE SONG LEAKS", "ella");
  const partial = computeRelevanceScore("tate mcrae leaks", "new song tonight", "ella");
  assert.ok(exact > partial);
});