# FFmpeg Streaming Service - Setup & Testing Guide

## Quick Start

### 1. Installation

```bash
# Install dependencies
npm install express
npm install @types/express @types/node --save-dev
npm install ffmpeg-static ffprobe-static
npm install typescript ts-node --save-dev

# Or use fluent-ffmpeg
npm install fluent-ffmpeg @ffmpeg-installer/ffmpeg
```

### package.json

```json
{
  "name": "ffmpeg-streaming-service",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/ffmpeg-streaming-service.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/ffmpeg-streaming-service.js",
    "dev": "ts-node src/ffmpeg-streaming-service.ts",
    "test": "node --test test/**/*.test.ts"
  },
  "dependencies": {
    "express": "^4.18.2"
  },
  "devDependencies": {
    "@types/express": "^4.17.17",
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0",
    "ts-node": "^10.9.0"
  }
}
```

### Environment Setup

```bash
# Set media directory
export MEDIA_DIR=/path/to/media
export TEMP_DIR=/tmp

# Optional: custom FFmpeg paths (if not in PATH)
export FFMPEG_PATH=/usr/local/bin/ffmpeg
export FFPROBE_PATH=/usr/local/bin/ffprobe

# Start server
npm run dev
```

---

## Usage Examples

### 1. Extract Audio from Video

```bash
# Extract as MP3 (track 0)
curl -o audio.mp3 "http://localhost:3000/audio/movie.mkv?format=mp3&track=0"

# Extract as AAC
curl -o audio.m4a "http://localhost:3000/audio/movie.mkv?format=m4a&track=1"

# Extract as FLAC (high quality)
curl -o audio.flac "http://localhost:3000/audio/movie.mkv?format=flac&track=0"
```

### 2. Stream Transcoded Video

```bash
# Stream as MP4 (high quality)
curl -o output.mp4 "http://localhost:3000/stream/movie.mkv?quality=high&format=mp4"

# Stream with seeking (5 seconds in)
curl -o output.mp4 "http://localhost:3000/stream/movie.mkv?quality=high&time=5"

# Low quality (mobile streaming)
curl -o output.mp4 "http://localhost:3000/stream/movie.mkv?quality=low&format=mp4"
```

### 3. Get Media Metadata

```bash
# Get available audio tracks
curl "http://localhost:3000/metadata/movie.mkv" | jq

# Response:
# {
#   "file": "movie.mkv",
#   "audioTracks": [
#     {
#       "index": 0,
#       "codec": "aac",
#       "language": "eng",
#       "channels": 2
#     },
#     {
#       "index": 1,
#       "codec": "aac",
#       "language": "spa",
#       "channels": 2
#     }
#   ]
# }
```

### 4. Monitor Transcode Session

```bash
# Get transcode status
curl "http://localhost:3000/transcode/status/SESSION_ID" | jq

# Response:
# {
#   "sessionId": "transcode_1234567890",
#   "isRunning": true,
#   "pid": 12345,
#   "elapsedSeconds": 42.3,
#   "inputPath": "/tmp/media/movie.mkv"
# }

# Cancel a transcode
curl -X POST "http://localhost:3000/transcode/cancel/SESSION_ID"
```

---

## TypeScript Unit Tests

Create `test/ffmpeg-streaming-service.test.ts`:

```typescript
import assert from "assert";
import { spawn } from "child_process";
import { createWriteStream } from "fs";

// Mock FFmpeg process
class MockFFmpegProcess {
  private children: any[] = [];

  spawn(command: string, args: string[], options: any) {
    console.log(`[Mock] Spawning: ${command} ${args.join(" ")}`);

    // Return mock process
    const mockProcess = {
      stdout: new (require("stream").Readable)(),
      stderr: new (require("stream").Readable)(),
      pid: Math.floor(Math.random() * 10000),
      killed: false,
      kill: (signal: string) => {
        console.log(`[Mock] Killed with signal: ${signal}`);
        mockProcess.killed = true;
      },
      on: (event: string, callback: Function) => {
        if (event === "close") {
          // Simulate process close after 100ms
          setTimeout(() => callback(0), 100);
        }
      },
    };

    this.children.push(mockProcess);
    return mockProcess;
  }

  cleanup() {
    this.children.forEach((p) => {
      if (!p.killed) p.kill("SIGKILL");
    });
  }
}

// Test Suite
describe("FFmpeg Streaming Service", () => {
  test("should throw error on invalid media path (directory traversal)", () => {
    const validateMediaPath = (userPath: string): string => {
      const path = require("path");
      const MEDIA_DIR = "/tmp/media";

      const normalized = path.normalize(userPath);
      const fullPath = path.join(MEDIA_DIR, normalized);

      if (!fullPath.startsWith(MEDIA_DIR)) {
        throw new Error("Invalid path: directory traversal detected");
      }

      return fullPath;
    };

    assert.throws(
      () => validateMediaPath("../../../etc/passwd"),
      /directory traversal/,
    );

    assert.throws(
      () => validateMediaPath("../../secret.txt"),
      /directory traversal/,
    );

    // Valid path should not throw
    assert.doesNotThrow(() => validateMediaPath("subfolder/video.mp4"));
  });

  test("should build correct FFmpeg arguments for audio extraction", () => {
    interface TranscodeOptions {
      inputPath: string;
      bitrate: string;
      preset: string;
      format: string;
      audioTrack?: number;
    }

    const buildFFmpegArgs = (options: TranscodeOptions): string[] => {
      const codecMap: Record<string, string> = {
        mp3: "libmp3lame",
        aac: "aac",
        flac: "flac",
      };

      return [
        "-i",
        options.inputPath,
        "-map",
        `0:a:${options.audioTrack || 0}`,
        "-c:a",
        codecMap[options.format],
        "-b:a",
        options.bitrate,
        "-f",
        options.format,
        "pipe:1",
      ];
    };

    const args = buildFFmpegArgs({
      inputPath: "/tmp/media/movie.mkv",
      bitrate: "192k",
      preset: "veryfast",
      format: "mp3",
      audioTrack: 0,
    });

    assert.strictEqual(args[0], "-i");
    assert.strictEqual(args[1], "/tmp/media/movie.mkv");
    assert(args.includes("libmp3lame"));
    assert(args.includes("192k"));
    assert(args.includes("pipe:1"));
  });

  test("should handle FFmpeg process errors gracefully", async () => {
    // Simulate FFmpeg failure
    let capturedError = false;

    try {
      const ffmpeg = spawn("ffmpeg-nonexistent", ["-h"]);
      ffmpeg.on("error", (err) => {
        capturedError = true;
        console.log("Expected error captured:", err.message);
      });

      // Wait for error event
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (err) {
      // spawn() may throw or emit 'error' depending on Node version
      capturedError = true;
    }

    assert.strictEqual(capturedError, true);
  });

  test("should parse audio tracks from ffprobe output", () => {
    const mockProbeOutput = {
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
        },
        {
          codec_type: "audio",
          codec_name: "aac",
          channels: 2,
          tags: { language: "eng" },
        },
        {
          codec_type: "audio",
          codec_name: "aac",
          channels: 2,
          tags: { language: "spa" },
        },
      ],
    };

    const audioTracks = mockProbeOutput.streams
      .filter((s: any) => s.codec_type === "audio")
      .map((s: any, idx: number) => ({
        index: idx,
        codec: s.codec_name,
        language: s.tags?.language || "unknown",
        channels: s.channels,
      }));

    assert.strictEqual(audioTracks.length, 2);
    assert.strictEqual(audioTracks[0].language, "eng");
    assert.strictEqual(audioTracks[1].language, "spa");
  });

  test("should handle transcode session timeout", async () => {
    let timedOut = false;

    const startTranscode = (timeoutMs: number) => {
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          timedOut = true;
          reject(new Error("Transcode timeout"));
        }, timeoutMs);

        // Simulate long-running process
        setTimeout(() => {
          clearTimeout(timeout);
          resolve();
        }, timeoutMs * 2);
      });
    };

    try {
      await startTranscode(100);
    } catch (err) {
      // Expected - process takes longer than timeout
    }

    assert.strictEqual(timedOut, true);
  });

  test("should gracefully terminate FFmpeg process", async () => {
    const mockProcess = new MockFFmpegProcess();

    const testProcess = mockProcess.spawn("ffmpeg", [], {});
    assert.strictEqual(testProcess.killed, false);

    testProcess.kill("SIGTERM");
    assert.strictEqual(testProcess.killed, true);

    mockProcess.cleanup();
  });

  test("should validate audio format selection", () => {
    const AudioFormat = {
      MP3: "mp3",
      AAC: "aac",
      M4A: "m4a",
      FLAC: "flac",
    };

    const isValidFormat = (format: string): boolean => {
      return Object.values(AudioFormat).includes(format);
    };

    assert.strictEqual(isValidFormat("mp3"), true);
    assert.strictEqual(isValidFormat("aac"), true);
    assert.strictEqual(isValidFormat("wav"), false);
    assert.strictEqual(isValidFormat("mov"), false);
  });
});
```

Run tests:

```bash
npm test
```

---

## Performance Testing

### Load Testing with Artillery

```bash
npm install -D artillery

# Create artillery.yml
```

```yaml
config:
  target: "http://localhost:3000"
  phases:
    - duration: 60
      arrivalRate: 10
      name: "Ramp up"
    - duration: 120
      arrivalRate: 25
      name: "Sustained load"
    - duration: 60
      arrivalRate: 0
      name: "Ramp down"

scenarios:
  - name: "Extract Audio"
    flows:
      - get:
          url: "/audio/test.mkv?format=mp3&track=0"

  - name: "Stream Video"
    flows:
      - get:
          url: "/stream/test.mkv?quality=high"

  - name: "Get Metadata"
    flows:
      - get:
          url: "/metadata/test.mkv"
```

Run test:

```bash
artillery run artillery.yml
```

---

## Memory & CPU Profiling

### Check Process Resources

```bash
# Monitor while transcoding
watch -n 1 'ps aux | grep ffmpeg'

# Use Node.js built-in profiler
node --prof dist/ffmpeg-streaming-service.js

# Generate profile report
node --prof-process isolate-*.log > profile.txt
```

### Typical Resource Usage

- **Small file (< 100MB)**: 50-150 MB RAM, 20-40% CPU
- **Large file (1-5GB)**: 200-400 MB RAM, 60-100% CPU
- **Streaming**: Variable, depends on preset speed (veryfast = higher CPU)

---

## Docker Deployment

```dockerfile
FROM node:18-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --only=production

COPY dist ./dist

ENV MEDIA_DIR=/media
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/ffmpeg-streaming-service.js"]
```

Build and run:

```bash
docker build -t ffmpeg-streaming .

docker run -p 3000:3000 \
  -v /path/to/media:/media \
  ffmpeg-streaming
```

---

## Troubleshooting

### FFmpeg Hangs When Reading stdin

**Problem**: Server hangs when spawning FFmpeg

**Solution**:

```typescript
// ✅ CORRECT: Close stdin to prevent ffmpeg waiting for input
const ffmpeg = spawn("ffmpeg", args, {
  stdio: ["ignore", "pipe", "pipe"], // stdin: ignore
});

// ❌ WRONG: Don't do this - ffmpeg waits for stdin
const ffmpeg = spawn("ffmpeg", args, {
  stdio: ["pipe", "pipe", "pipe"],
});
```

### Out of Memory

**Problem**: Service crashes with high memory usage on large files

**Solutions**:

1. Use disk buffering instead of memory
2. Lower bitrate/preset to process faster
3. Process on separate worker process
4. Implement streaming directly to response (no buffering)

### Lost Audio in Output

**Problem**: Extracted audio is silent or missing

**Solutions**:

```typescript
// Check available audio tracks first
const tracks = await getAudioTracks(filePath);
console.log(tracks); // See what's available

// Ensure correct track index
const args = [
  "-i",
  inputPath,
  "-map",
  `0:a:${trackIndex}`, // Specify exact track
  // ...
];

// Fallback to first audio if index invalid
const trackToUse = trackIndex < tracks.length ? trackIndex : 0;
```

### CORS Issues

**Problem**: Browser blocked request

**Solution**:

```typescript
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept",
  );
  next();
});
```

---

## Production Checklist

- [ ] Test with actual video files (various codecs, bitrates)
- [ ] Implement request rate limiting
- [ ] Add comprehensive logging with timestamps
- [ ] Set resource limits (memory, CPU)
- [ ] Monitor FFmpeg process count
- [ ] Clean up temp files on server restart
- [ ] Implement metrics collection
- [ ] Set up error alerts
- [ ] Use reverse proxy (nginx) to handle streaming
- [ ] Enable gzip compression for metadata responses

---

## References

- FFmpeg Documentation: https://ffmpeg.org/documentation.html
- Node.js Child Process: https://nodejs.org/api/child_process.html
- Stream Backpressure: https://nodejs.org/en/docs/guides/backpressuring-in-streams/
- Express Best Practices: https://expressjs.com/en/advanced/best-practice-performance.html
