import assert from "node:assert/strict";
import test from "node:test";
import {
  extractClipDurationHintFromPageHtml,
  extractPlayableUrlsFromPageHtml,
} from "../src/stream/stream-service.js";

test("extractPlayableUrlsFromPageHtml prefers clip media URLs before soundtrack URLs", () => {
  const embedded = JSON.stringify({
    __DEFAULT_SCOPE__: {
      webapp: {
        itemInfo: {
          itemStruct: {
            playUrl: "https://cdn.example/sound.mp3?mime_type=audio_mpeg\\u0026duration=109",
            playAddr: "https://cdn.example/clip.mp4\\u0026duration=60",
            downloadAddr: "https://cdn.example/clip-download.mp4",
          },
        },
      },
    },
  });
  const html = `
    <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${embedded}</script>
  `;

  assert.deepEqual(extractPlayableUrlsFromPageHtml(html), [
    "https://cdn.example/clip.mp4&duration=60",
    "https://cdn.example/clip-download.mp4",
    "https://cdn.example/sound.mp3?mime_type=audio_mpeg&duration=109",
  ]);
});

test("extractClipDurationHintFromPageHtml prefers the clip duration over soundtrack duration", () => {
  const html = `
    <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
      itemStruct: {
        duration: 109,
        playAddr: "https://cdn.example/clip.mp4?mime_type=video_mp4",
        downloadAddr: "https://cdn.example/clip-download.mp4?mime_type=video_mp4",
        video: {
          duration: 60,
        },
        music: {
          duration: 109,
          playUrl: "https://cdn.example/sound.mp3?mime_type=audio_mpeg",
        },
      },
    })}</script>
  `;

  assert.equal(extractClipDurationHintFromPageHtml(html), 60);
});