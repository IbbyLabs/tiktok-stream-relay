# Node.js/TypeScript FFmpeg Streaming Patterns: Production Guide

## Real-World Production Projects

### High-Quality Reference Implementations

#### 1. **Tunarr** (2.2K GitHub stars)

- **URL**: https://github.com/chrisbenincasa/tunarr
- **What it does**: Creates custom live TV channels from Plex/Jellyfin/Emby media with FFmpeg transcoding
- **Key patterns**:
  - Hardware-accelerated transcoding (NVENC, VAAPI, QuickSync, VideoToolbox)
  - Multiple transcode profiles per channel
  - Stream to browser, Plex, Jellyfin, IPTV clients (Tivimate, UHF)
  - TypeScript monorepo with turborepo
  - Real streaming to HTTP clients

#### 2. **PeerTube** (14.6K GitHub stars)

- **URL**: https://github.com/Chocobozzz/PeerTube
- **What it does**: Decentralized, federated video streaming platform
- **Key patterns**:
  - Live video streaming with FFmpeg
  - ActivityPub federation
  - P2P delivery via WebRTC
  - TypeScript backend (90.2% of codebase)
  - Large-scale production deployment

#### 3. **WebTorrent Transcode**

- **URL**: https://github.com/leeroybrun/webtorrent-transcode
- **What it does**: On-the-fly FFmpeg transcoding for torrented media
- **Key patterns**:
  - Direct stream piping: `torrent_stream → ffmpeg → HTTP client`
  - Time-range seeking (not byte-range) when transcoding
  - Video.js integration with custom plugins
  - Fluent-ffmpeg wrapper usage
  - Metadata queries via ffprobe

#### 4. **Prismcast** (Chrome-based streaming)

- **URL**: https://github.com/hjdhjd/prismcast
- **What it does**: Chrome-based streaming server for Channels DVR and Plex
- **Key patterns**: TypeScript utilities for FFmpeg spawning and stream management

---

## Core Technical Patterns

### 1. **Live Transcoding on the Fly**

#### Pattern: Stream-to-Stream Piping

The most common pattern for transcoding input streams to output formats:

```typescript
import { spawn } from "child_process";
import { createReadStream } from "fs";

interface TranscodeOptions {
  inputPath: string;
  outputFormat: string;
  bitrate: string;
  preset: "ultrafast" | "superfast" | "veryfast" | "fast" | "medium";
  crf?: number; // Quality (0-51, lower=better)
}

function transcodeStream(options: TranscodeOptions): NodeJS.ReadableStream {
  const inputStream = createReadStream(options.inputPath);

  const ffmpegArgs = [
    "-i",
    "pipe:0", // Read from stdin
    "-c:v",
    "libx264", // Video codec
    "-preset",
    options.preset, // Encoding speed/quality tradeoff
    "-b:v",
    options.bitrate, // Target bitrate
    ...(options.crf ? ["-crf", options.crf.toString()] : []),
    "-c:a",
    "aac", // Audio codec
    "-b:a",
    "128k", // Audio bitrate
    "-f",
    options.outputFormat, // Output format (mp4, mkv, etc)
    "pipe:1", // Write to stdout
  ];

  const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  inputStream.pipe(ffmpeg.stdin);

  return ffmpeg.stdout;
}
```

#### Error Handling Pattern

```typescript
function transcodeStreamWithErrorHandling(
  options: TranscodeOptions,
  onProgress?: (stats: ErrorStats) => void,
): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    const inputStream = createReadStream(options.inputPath);

    inputStream.on("error", (err) => {
      reject(new Error(`Input stream error: ${err.message}`));
    });

    const ffmpeg = spawn("ffmpeg", [...ffmpegArgs], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderrOutput = "";

    ffmpeg.stderr.on("data", (data) => {
      stderrOutput += data.toString();

      // Parse progress from stderr
      // FFmpeg writes progress info to stderr, not stdout
      const match = stderrOutput.match(/frame=\s*(\d+)/);
      if (match && onProgress) {
        onProgress({ framesProcessed: parseInt(match[1]) });
      }
    });

    ffmpeg.on("error", (err) => {
      inputStream.destroy();
      reject(new Error(`FFmpeg spawn error: ${err.message}`));
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`FFmpeg exited with code ${code}:\n${stderrOutput}`));
      }
    });

    inputStream.pipe(ffmpeg.stdin);
    resolve(ffmpeg.stdout);
  });
}
```

---

### 2. **Proxy Service Architecture**

#### Blueprint: Media Proxy with Conditional Transcoding

```typescript
import express from "express";
import { pipeline } from "stream/promises";
import { createWriteStream, createReadStream, statSync } from "fs";

interface MediaProxyConfig {
  sourceDir: string;
  maxBitrate: string;
  acceptedFormats: string[];
}

const app = express();
const config: MediaProxyConfig = {
  sourceDir: "/media",
  maxBitrate: "5000k",
  acceptedFormats: ["mp4", "mkv"],
};

// Transcoding decision logic
function shouldTranscode(mediaPath: string, acceptHeader: string): boolean {
  const fileExt = mediaPath.split(".").pop()?.toLowerCase() || "";

  // If client doesn't support format, transcode
  if (!config.acceptedFormats.includes(fileExt)) {
    return true;
  }

  // If format is MKV with complex audio, transcode
  if (fileExt === "mkv") {
    return true; // Always transcode MKV (may have multiple audio tracks)
  }

  return false;
}

app.get("/media/:filename", async (req, res) => {
  const filename = req.params.filename;
  const mediaPath = `${config.sourceDir}/${filename}`;

  try {
    const stats = statSync(mediaPath);
    const needsTranscode = shouldTranscode(mediaPath, req.headers.accept || "");

    if (!needsTranscode) {
      // Direct stream: set byte-range headers for seeking
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Length", stats.size);
      res.setHeader("Accept-Ranges", "bytes");

      return pipeline(createReadStream(mediaPath), res);
    }

    // Transcode: time-range seeking instead of byte-range
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Transfer-Encoding", "chunked");
    // Cannot use Content-Length with transcoding (unknown size)
    // Cannot use Accept-Ranges with transcoding

    // Parse ?time=SS query param for seeking
    const seekTime = req.query.time ? `${req.query.time}s` : "0";

    const ffmpegArgs = [
      "-ss",
      seekTime, // Seek to time
      "-i",
      mediaPath,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-b:v",
      config.maxBitrate,
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-f",
      "mp4",
      "pipe:1",
    ];

    const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    ffmpeg.stderr.on("data", (data) => {
      console.log(`[FFmpeg] ${data.toString()}`);
    });

    ffmpeg.on("error", (err) => {
      res.status(500).json({ error: `FFmpeg error: ${err.message}` });
    });

    return pipeline(ffmpeg.stdout, res);
  } catch (err) {
    if (err instanceof Error && err.message.includes("ENOENT")) {
      res.status(404).json({ error: "Media not found" });
    } else {
      res.status(500).json({ error: `Server error: ${err}` });
    }
  }
});

app.listen(3000, () => console.log("Proxy listening on port 3000"));
```

**Key Decision Point**: WebTorrent-transcode uses time-range seeking with this approach:

- When transcoding, disable HTTP `Accept-Ranges: bytes`
- Implement `?time=SS` query parameter
- Use `-ss` (seek) before input for fast seeking
- Custom Video.js plugin converts byte-ranges to time-ranges

---

### 3. **Audio Extraction from Video**

#### Pattern: Extract specific audio track to MP3

```typescript
function extractAudioTrack(
  inputPath: string,
  trackIndex: number = 0,
  outputFormat: "mp3" | "aac" | "opus" = "mp3",
): NodeJS.ReadableStream {
  const codecMap = {
    mp3: "libmp3lame",
    aac: "aac",
    opus: "libopus",
  };

  const bitrates = {
    mp3: "192k",
    aac: "128k",
    opus: "128k",
  };

  const ffmpegArgs = [
    "-i",
    inputPath,
    "-map",
    `0:a:${trackIndex}`, // Select audio track
    "-c:a",
    codecMap[outputFormat], // Audio codec
    "-b:a",
    bitrates[outputFormat], // Bitrate
    "-f",
    outputFormat === "mp3" ? "mp3" : outputFormat,
    "pipe:1",
  ];

  const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  return ffmpeg.stdout;
}

// Usage in Express
app.get("/extract-audio/:videoFile", (req, res) => {
  const videoPath = `/media/${req.params.videoFile}`;
  const trackIndex = parseInt(req.query.track as string) || 0;
  const format = (req.query.format as "mp3" | "aac" | "opus") || "mp3";

  res.setHeader("Content-Type", `audio/${format}`);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="audio.${format}"`,
  );

  const audioStream = extractAudioTrack(videoPath, trackIndex, format);

  audioStream.on("error", (err) => {
    console.error("Audio extraction error:", err);
    res.status(500).json({ error: "Extraction failed" });
  });

  pipeline(audioStream, res).catch((err) => {
    console.error("Pipeline error:", err);
  });
});
```

---

### 4. **Stream Performance Patterns**

#### Memory vs Disk Strategy

```typescript
interface StreamPerformanceConfig {
  strategy: "memory-buffer" | "disk-buffer" | "streaming";
  maxBufferSize: number; // bytes
  tempDir: string;
  enableMetrics: boolean;
}

class StreamPerformanceManager {
  private config: StreamPerformanceConfig;
  private metrics = {
    bytesTranscoded: 0,
    peakMemory: 0,
    transcodeTime: 0,
    startTime: Date.now(),
  };

  constructor(config: StreamPerformanceConfig) {
    this.config = config;
  }

  async transcodeWithStrategy(
    inputPath: string,
    outputPath: string,
  ): Promise<void> {
    switch (this.config.strategy) {
      case "memory-buffer":
        return this.transcodeThroughMemory(inputPath, outputPath);
      case "disk-buffer":
        return this.transcodeThroughDisk(inputPath, outputPath);
      case "streaming":
        return this.transcodeDirectStream(inputPath, outputPath);
    }
  }

  // **MEMORY**: Best for small files (<100MB), low latency
  // Good for: Real-time streaming, small clips
  // Risk: High memory usage, GC pauses
  private async transcodeThroughMemory(
    inputPath: string,
    outputPath: string,
  ): Promise<void> {
    const chunks: Buffer[] = [];

    const ffmpeg = spawn("ffmpeg", [
      "-i",
      inputPath,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-f",
      "mp4",
      "pipe:1",
    ]);

    return new Promise((resolve, reject) => {
      ffmpeg.stdout.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        this.metrics.bytesTranscoded += chunk.length;

        // Monitor peak memory
        const used = process.memoryUsage().heapUsed;
        this.metrics.peakMemory = Math.max(this.metrics.peakMemory, used);
      });

      ffmpeg.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Transcode failed: ${code}`));
        } else {
          const buffer = Buffer.concat(chunks);
          fs.writeFileSync(outputPath, buffer);
          this.logMetrics();
          resolve();
        }
      });

      ffmpeg.on("error", reject);
    });
  }

  // **DISK**: Best for large files (>500MB), production
  // Good for: Persistent transcoding, cost-effective
  // Risk: Disk I/O latency, cleanup issues
  private async transcodeThroughDisk(
    inputPath: string,
    outputPath: string,
  ): Promise<void> {
    const tempPath = `${this.config.tempDir}/trans_${Date.now()}.mp4`;

    const ffmpeg = spawn("ffmpeg", [
      "-i",
      inputPath,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      tempPath,
    ]);

    return new Promise((resolve, reject) => {
      ffmpeg.on("close", (code) => {
        if (code !== 0) {
          fs.rmSync(tempPath, { force: true });
          reject(new Error(`Transcode failed: ${code}`));
        } else {
          fs.renameSync(tempPath, outputPath);
          this.logMetrics();
          resolve();
        }
      });

      ffmpeg.on("error", (err) => {
        fs.rmSync(tempPath, { force: true });
        reject(err);
      });
    });
  }

  // **STREAMING**: Best for HTTP clients, real-time
  // Good for: On-the-fly HTTP streaming, low latency
  // Risk: Cannot seek in transcoded output, unknown duration
  private async transcodeDirectStream(
    inputPath: string,
    outputPath: string,
  ): Promise<void> {
    const writeStream = createWriteStream(outputPath);

    const ffmpeg = spawn("ffmpeg", [
      "-i",
      inputPath,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-f",
      "mp4",
      "pipe:1",
    ]);

    return pipeline(ffmpeg.stdout, writeStream);
  }

  private logMetrics(): void {
    if (this.config.enableMetrics) {
      const duration = (Date.now() - this.metrics.startTime) / 1000;
      console.log({
        bytesTranscoded: this.metrics.bytesTranscoded,
        peakMemory: `${(this.metrics.peakMemory / 1024 / 1024).toFixed(2)} MB`,
        duration: `${duration.toFixed(2)}s`,
        throughput: `${(this.metrics.bytesTranscoded / duration / 1024 / 1024).toFixed(2)} MB/s`,
      });
    }
  }
}
```

#### Buffering Strategies for Large Files

```typescript
// Adaptive buffering based on connection speed
class AdaptiveBuffering {
  private buffers = new Map<string, Buffer[]>();
  private maxChunkSize = 1024 * 256; // 256KB chunks

  streamWithAdaptiveBuffering(
    ffmpegStream: NodeJS.ReadableStream,
    clientResponse: express.Response,
    estimatedBandwidth: number, // bits/sec
  ): void {
    let backpressureActive = false;
    const sessionId = `session_${Date.now()}`;
    this.buffers.set(sessionId, []);

    ffmpegStream.on("data", (chunk: Buffer) => {
      const buffer = this.buffers.get(sessionId)!;
      buffer.push(chunk);

      // Adaptive buffering: hold more data if bandwidth is low
      const recommendedBuffer = (estimatedBandwidth * 2) / 8; // 2 sec buffer
      const currentSize = buffer.reduce((sum, b) => sum + b.length, 0);

      if (currentSize > recommendedBuffer && !backpressureActive) {
        ffmpegStream.pause();
        backpressureActive = true;
      }

      while (buffer.length > 0 && currentSize > 0) {
        const chunk = buffer.shift()!;
        if (!clientResponse.write(chunk)) {
          ffmpegStream.pause();
          backpressureActive = true;
          break;
        }
      }
    });

    clientResponse.on("drain", () => {
      if (backpressureActive) {
        backpressureActive = false;
        ffmpegStream.resume();
      }
    });

    ffmpegStream.on("end", () => {
      clientResponse.end();
      this.buffers.delete(sessionId);
    });
  }
}
```

---

### 5. **Timeout & Cancellation Handling**

#### Pattern: Graceful Process Termination

```typescript
interface TranscodeSession {
  id: string;
  process?: ChildProcess;
  timeout?: NodeJS.Timeout;
  startTime: number;
}

class TranscodeManager {
  private sessions = new Map<string, TranscodeSession>();
  private defaultTimeout = 30 * 60 * 1000; // 30 minutes

  startTranscode(
    inputPath: string,
    timeoutMs: number = this.defaultTimeout,
  ): string {
    const sessionId = `transcode_${Date.now()}`;
    const session: TranscodeSession = {
      id: sessionId,
      startTime: Date.now(),
    };

    const ffmpeg = spawn("ffmpeg", [
      "-i",
      inputPath,
      "-c:v",
      "libx264",
      "-f",
      "mp4",
      "pipe:1",
    ]);

    session.process = ffmpeg;

    // Set timeout for the transcode process
    session.timeout = setTimeout(() => {
      console.warn(`Transcode ${sessionId} timed out after ${timeoutMs}ms`);
      this.cancelTranscode(sessionId, "timeout");
    }, timeoutMs);

    ffmpeg.on("close", (code) => {
      clearTimeout(session.timeout!);
      this.sessions.delete(sessionId);
    });

    this.sessions.set(sessionId, session);
    return sessionId;
  }

  cancelTranscode(sessionId: string, reason: string = "user-cancelled"): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.process) return;

    console.log(`Cancelling transcode ${sessionId}: ${reason}`);

    // Graceful termination sequence
    // 1. First try SIGTERM (graceful)
    session.process.kill("SIGTERM");

    // 2. If process doesn't exit in 5 seconds, force SIGKILL
    const killTimeout = setTimeout(() => {
      if (!session.process!.killed) {
        console.warn(`Force killing process ${session.process!.pid}`);
        session.process!.kill("SIGKILL");
      }
    }, 5000);

    session.process.on("exit", () => {
      clearTimeout(killTimeout);
      clearTimeout(session.timeout!);
      this.sessions.delete(sessionId);
    });
  }

  getStatus(sessionId: string): TranscodeStatus | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    return {
      id: sessionId,
      isRunning: session.process && !session.process.killed,
      elapsedTime: Date.now() - session.startTime,
      pid: session.process?.pid,
    };
  }
}

interface TranscodeStatus {
  id: string;
  isRunning: boolean;
  elapsedTime: number;
  pid?: number;
}
```

---

### 6. **HTTP Server Streaming Output**

#### Pattern: Express + FFmpeg Direct to HTTP

```typescript
import express from "express";
import { spawn } from "child_process";
import { pipeline } from "stream/promises";

const app = express();

app.get("/stream/:videoId", async (req, res) => {
  const videoId = req.params.videoId;
  const quality = req.query.quality || "high";
  const format = req.query.format || "mp4";

  // Optional: Range request support (for direct streams only)
  const rangeHeader = req.headers.range;

  try {
    // Set response headers
    res.setHeader("Content-Type", `video/${format}`);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${videoId}.${format}"`,
    );

    // Chunked encoding for live transcoding
    res.setHeader("Transfer-Encoding", "chunked");

    // Get video path (from DB, file system, etc)
    const videoPath = await getVideoPath(videoId);

    // Quality presets
    const qualityPresets = {
      low: { bitrate: "500k", preset: "superfast" },
      medium: { bitrate: "2000k", preset: "veryfast" },
      high: { bitrate: "5000k", preset: "fast" },
    };

    const preset =
      qualityPresets[quality as keyof typeof qualityPresets] ||
      qualityPresets.high;

    const ffmpegArgs = [
      "-i",
      videoPath,
      "-c:v",
      "libx264",
      "-preset",
      preset.preset,
      "-b:v",
      preset.bitrate,
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-f",
      format,
      "-movflags",
      "frag_keyframe+empty_moov", // Enables streaming
      "pipe:1",
    ];

    const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Log FFmpeg errors
    let errorOutput = "";
    ffmpeg.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });

    // Handle client disconnect gracefully
    req.socket.on("close", () => {
      console.log("Client disconnected, killing FFmpeg process");
      ffmpeg.kill("SIGKILL");
    });

    // Handle FFmpeg errors
    ffmpeg.on("error", (err) => {
      console.error("FFmpeg error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Streaming error" });
      }
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        console.error(`FFmpeg exited with code ${code}`);
      }
    });

    // Pipe FFmpeg output to HTTP response
    await pipeline(ffmpeg.stdout, res);
  } catch (err) {
    console.error("Stream error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to start stream" });
    }
  }
});

// Range request support (for direct streams, not transcoded)
app.get("/stream-direct/:videoId", async (req, res) => {
  const videoPath = await getVideoPath(req.params.videoId);
  const stat = fs.statSync(videoPath);
  const rangeHeader = req.headers.range;

  if (!rangeHeader) {
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Accept-Ranges", "bytes");
    return fs.createReadStream(videoPath).pipe(res);
  }

  // Parse range
  const parts = rangeHeader.replace(/bytes=/, "").split("-");
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;

  res.status(206); // Partial Content
  res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  res.setHeader("Content-Length", end - start + 1);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");

  fs.createReadStream(videoPath, { start, end }).pipe(res);
});

async function getVideoPath(videoId: string): Promise<string> {
  // Implement based on your storage (DB, file system, etc)
  return `/media/${videoId}.mp4`;
}

app.listen(3000, () => console.log("Stream server on port 3000"));
```

---

## Error Handling Best Practices

### Comprehensive Error Type Handling

```typescript
enum FFmpegErrorType {
  SPAWN_FAILED = "spawn_failed",
  INVALID_INPUT = "invalid_input",
  CODEC_NOT_AVAILABLE = "codec_not_available",
  TIMEOUT = "timeout",
  CLIENT_DISCONNECT = "client_disconnect",
  UNKNOWN = "unknown",
}

class FFmpegError extends Error {
  constructor(
    public type: FFmpegErrorType,
    message: string,
    public stderr?: string,
    public exitCode?: number,
  ) {
    super(message);
    this.name = "FFmpegError";
  }
}

function parseFFmpegError(stderr: string, code: number): FFmpegErrorType {
  if (stderr.includes("Unknown encoder"))
    return FFmpegErrorType.CODEC_NOT_AVAILABLE;
  if (stderr.includes("No such file or directory"))
    return FFmpegErrorType.INVALID_INPUT;
  if (stderr.includes("Invalid")) return FFmpegErrorType.INVALID_INPUT;
  return FFmpegErrorType.UNKNOWN;
}

// Usage
ffmpeg.on("close", (code) => {
  if (code !== 0) {
    const errorType = parseFFmpegError(stderrOutput, code);
    throw new FFmpegError(
      errorType,
      `FFmpeg exited with code ${code}`,
      stderrOutput,
      code,
    );
  }
});
```

---

## Popular NPM Packages

### 1. **fluent-ffmpeg** (Most popular)

- **npm**: `npm install fluent-ffmpeg @ffmpeg-installer/ffmpeg`
- **Pros**: High-level API, easy stream piping, event-based
- **Cons**: Wrapper overhead, less control, active maintenance

```typescript
import ffmpeg from "fluent-ffmpeg";
import { Install } from "@ffmpeg-installer/ffmpeg";

ffmpeg.setFfmpegPath(Install.path);

ffmpeg("input.mp4")
  .outputOptions("-c:a aac", "-b:a 128k")
  .output("output.mp4")
  .on("progress", (progress) => console.log(`${progress.percent}%`))
  .on("end", () => console.log("Done"))
  .run();
```

### 2. **ffmpeg-static** / **ffprobe-static**

- **npm**: `npm install ffmpeg-static ffprobe-static`
- **Purpose**: Pre-built FFmpeg binaries bundled with package
- **Best for**: Docker, reproducible builds, no system FFmpeg required

```typescript
import ffmpeg from "ffmpeg-static";
import ffprobe from "ffprobe-static";

const ffmpegPath = ffmpeg; // Auto-resolved binary path
const ffprobePath = ffprobe.path;
```

### 3. **@balsamic/ffmpeg** (Lightweight)

- Minimal wrapper around child_process
- Direct stream control, lower overhead

### 4. **youtubedl-core** (With local FFmpeg)

- For downloading + transcoding combined workflows

---

## Streaming Optimization Techniques

### 1. **Keyframe Interval**

```typescript
// Keyframe every 2 seconds (important for seeking/live)
const ffmpegArgs = [
  "-i",
  inputPath,
  "-c:v",
  "libx264",
  "-g",
  "48", // keyint = 48 frames at 24fps = 2sec
  "-keyint_min",
  "24", // minimum keyframe interval
  "output.mp4",
];
```

### 2. **Preset Selection vs Quality**

```
ultrafast  → Lowest quality, fastest (streaming, live)
superfast  → Low quality, very fast
veryfast   → Good quality, fast (recommended for streaming)
fast       → Better quality, slower
medium     → High quality, slow (file encoding)
slow       → Very high quality, very slow
```

### 3. **Segmented Output (HLS)**

```typescript
// For better adaptive streaming
const ffmpegArgs = [
  "-i",
  inputPath,
  "-c:v",
  "libx264",
  "-c:a",
  "aac",
  "-f",
  "hls",
  "-hls_time",
  "10", // 10-second segments
  "-hls_list_size",
  "3", // Keep last 3 segments in memory
  "-hls_flags",
  "delete_segments",
  "output.m3u8",
];
```

### 4. **Hardware Acceleration**

```typescript
// NVIDIA NVENC
const nvencArgs = ["-c:v", "h264_nvenc", "-preset", "fast"];

// VAAPI (Linux)
const vaapiArgs = ["-c:v", "h264_vaapi"];

// QuickSync (Intel)
const qsvArgs = ["-c:v", "h264_qsv"];

// VideoToolbox (macOS)
const toolboxArgs = ["-c:v", "h264_videotoolbox"];
```

---

## Production Best Practices

### Checklist

- ✅ **Always handle stderr** for progress tracking and errors
- ✅ **Use stdio: ['ignore', 'pipe', 'pipe']** to prevent child process from inheriting stdin (causes hangs)
- ✅ **Implement graceful shutdown** with timeout + SIGKILL fallback
- ✅ **Monitor memory/CPU** for long-running processes
- ✅ **Set suitable presets** ('veryfast' for streaming, 'medium' for files)
- ✅ **Use `-movflags frag_keyframe+empty_moov`** for HTTP streaming MP4
- ✅ **Parse progress from stderr**, not stdout (stdout is binary data)
- ✅ **Implement session/request tracking** to manage cancellations
- ✅ **Validate input paths** to prevent command injection
- ✅ **Set timeouts** for external process calls
- ✅ **Handle client disconnect** (socket 'close' event) to cleanup FFmpeg processes
- ✅ **Test with actual media files** (different codecs, corrupted files)
- ✅ **Use AbortController** for cancellation in modern Node.js

---

## References & Resources

### Key GitHub Projects

1. **Tunarr**: Full-featured TV channel streaming - https://github.com/chrisbenincasa/tunarr
2. **PeerTube**: Large-scale federated video - https://github.com/Chocobozzz/PeerTube
3. **WebTorrent Transcode**: On-the-fly torrent transcoding - https://github.com/leeroybrun/webtorrent-transcode
4. **Prismcast**: Chrome-based streaming - https://github.com/hjdhjd/prismcast

### General FFmpeg Resources

- FFmpeg Official: https://ffmpeg.org/
- FFmpeg Wiki (Encoding Guide): https://trac.ffmpeg.org/wiki/Encode/H.264
- fluent-ffmpeg Docs: https://github.com/fluent-ffmpeg/node-fluent-ffmpeg

### Streaming Protocols

- HLS (HTTP Live Streaming): Good for adaptive bitrate
- DASH (Dynamic Adaptive Streaming): Standardized MPEG format
- RTMP: Legacy but still used
- SRT: Modern, low-latency protocol
