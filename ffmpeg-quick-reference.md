# FFmpeg Node.js Streaming - Quick Reference

## 30-Second Overview

**Real-world projects using FFmpeg for streaming:**

- Tunarr (2.2K ⭐): Live TV channels from media libraries
- PeerTube (14.6K ⭐): Federated video platform
- WebTorrent Transcode: On-the-fly transcoding for torrents

**The core pattern:**

```typescript
spawn("ffmpeg", ["args"], { stdio: ["ignore", "pipe", "pipe"] }).stdout.pipe(
  response,
);
```

---

## 1. Extract Audio

```typescript
const ffmpeg = spawn("ffmpeg", [
  "-i",
  videoPath, // Input file
  "-map",
  "0:a:0", // Extract audio track 0
  "-c:a",
  "libmp3lame", // MP3 codec
  "-b:a",
  "192k", // 192kbps
  "-f",
  "mp3",
  "pipe:1", // Output to stdout
]);

response.setHeader("Content-Type", "audio/mpeg");
ffmpeg.stdout.pipe(response);
```

---

## 2. Stream Transcoded Video

```typescript
const ffmpeg = spawn("ffmpeg", [
  "-i",
  videoPath,
  "-c:v",
  "libx264", // Video codec
  "-preset",
  "veryfast", // Speed: ultrafast → slow
  "-b:v",
  "3000k", // Bitrate
  "-c:a",
  "aac",
  "-movflags",
  "frag_keyframe+empty_moov", // HTTP streaming
  "-f",
  "mp4",
  "pipe:1",
]);

response.setHeader("Content-Type", "video/mp4");
response.setHeader("Transfer-Encoding", "chunked");
ffmpeg.stdout.pipe(response);
```

---

## 3. Seeking (Time vs Byte Range)

### Direct Stream (byte-range)

```typescript
response.setHeader("Accept-Ranges", "bytes");
response.setHeader("Content-Length", fileSize);
// Client can request: Range: bytes=1000-2000
```

### Transcoded Stream (time-range)

```typescript
// Client requests: ?time=30 (seek to 30 seconds)
const time = req.query.time || "0";
const ffmpeg = spawn("ffmpeg", [
  "-ss",
  `${time}s`, // Seek before input
  "-i",
  videoPath,
  // ... transcode args
]);
// Cannot use Accept-Ranges (ffmpeg doesn't support it)
```

---

## 4. Error Handling

```typescript
let stderr = "";

ffmpeg.stderr.on("data", (data) => {
  stderr += data.toString();
  // Parse progress: frame=\d+, fps=\d+, etc.
});

ffmpeg.on("error", (err) => {
  console.error("Spawn failed:", err);
  res.status(500).json({ error: err.message });
});

ffmpeg.on("close", (code) => {
  if (code !== 0) {
    console.error(`Exit code ${code}:\n${stderr}`);
  }
});

// Kill process on client disconnect
req.socket.on("close", () => {
  ffmpeg.kill("SIGKILL");
});
```

---

## 5. Graceful Process Termination

```typescript
function killProcess(process: ChildProcess, timeoutMs: number = 5000) {
  process.kill("SIGTERM"); // Graceful

  setTimeout(() => {
    if (!process.killed) {
      process.kill("SIGKILL"); // Force
    }
  }, timeoutMs);
}
```

---

## 6. Session Management

```typescript
class TranscodeManager {
  private sessions = new Map<string, ChildProcess>();

  start(inputPath: string): string {
    const id = `${Date.now()}`;
    const ffmpeg = spawn("ffmpeg", [...args]);

    this.sessions.set(id, ffmpeg);

    setTimeout(() => this.kill(id, "timeout"), 30 * 60 * 1000);
    ffmpeg.on("close", () => this.sessions.delete(id));

    return id;
  }

  kill(id: string, reason: string): boolean {
    const proc = this.sessions.get(id);
    if (!proc) return false;

    proc.kill("SIGTERM");
    return true;
  }

  getStatus(id: string) {
    return {
      exists: this.sessions.has(id),
      isRunning: this.sessions.get(id) && !this.sessions.get(id)!.killed,
    };
  }
}
```

---

## 7. Common FFmpeg Arguments

```
Speed Presets (video encoding)
  -preset ultrafast    # Fastest, lowest quality (streaming)
  -preset veryfast     # Fast, good quality (RECOMMENDED)
  -preset fast         # Balanced
  -preset medium       # High quality
  -preset slow         # Very high quality

Audio Codecs & Bitrates
  -c:a libmp3lame -b:a 192k     # MP3
  -c:a aac -b:a 128k            # AAC/M4A
  -c:a flac -b:a 320k           # FLAC (lossless)
  -c:a libopus -b:a 128k        # Opus (streaming)

Video Codecs
  -c:v libx264        # H.264 (most compatible)
  -c:v libx265        # H.265 (newer, better compression)
  -c:v h264_nvenc     # GPU (NVIDIA)
  -c:v h264_vaapi     # GPU (Intel/AMD on Linux)
  -c:v h264_qsv       # GPU (Intel QuickSync)
  -c:v h264_videotoolbox  # GPU (macOS)

HTTP Streaming
  -movflags frag_keyframe+empty_moov  # Fragment MP4
  -keyint_min 24                      # Min keyframe interval
  -g 48                               # Keyframe every 48 frames

Pipes
  pipe:0              # stdin
  pipe:1              # stdout (use this)
  pipe:2              # stderr (don't use as output)
```

---

## 8. NPM Packages

```bash
# Core
npm install ffmpeg-static ffprobe-static

# Wrapper (optional)
npm install fluent-ffmpeg

# Server
npm install express

# Development
npm install @types/node @types/express typescript ts-node
```

---

## 9. Performance Tips

| Optimization          | When               | Impact                        |
| --------------------- | ------------------ | ----------------------------- |
| Lower bitrate         | Streaming, mobile  | 50% smaller, lower quality    |
| Faster preset         | Live streaming     | 2-5x faster, less compression |
| Keyframe interval     | Seeking support    | Enables seeking, larger file  |
| Hardware acceleration | High CPU usage     | 5-10x faster on GPU           |
| Direct stream         | File already works | No transcode overhead         |
| Memory buffer         | Files < 100MB      | Lower latency                 |
| Disk buffer           | Files > 500MB      | Uses disk instead of RAM      |

---

## 10. Troubleshooting

### FFmpeg Hangs on Startup

```typescript
// ❌ WRONG - FFmpeg waits for stdin input
spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });

// ✅ CORRECT - Close stdin
spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
```

### Process Doesn't Exit

```typescript
// ✅ ALWAYS listen to close event
ffmpeg.on("close", (code) => {
  console.log("Process exited:", code);
  // cleanup
});

// ✅ Kill on socket close (disconnection)
req.socket.on("close", () => ffmpeg.kill());
```

### No Audio in Output

```typescript
// 1. Check available tracks
ffprobe -show_streams input.mkv

// 2. Map correct track
-map 0:a:0          # First audio
-map 0:a:1          # Second audio

// 3. Verify codec
-c:a libmp3lame     # Ensure codec installed
-b:a 192k           # Set reasonable bitrate
```

### Large Output File

```typescript
// Lower bitrate
-b:v 2000k          # Instead of 5000k
-b:a 96k            # Instead of 128k

// Faster preset = more compression
-preset veryfast    # Better compression than ultrafast
```

### Out of Memory

```typescript
// Stream directly to response (no buffering)
ffmpeg.stdout.pipe(response);

// Or use disk buffering (> 500MB)
ffmpeg.stdout.pipe(fs.createWriteStream(tempPath));

// Monitor resources
ps aux | grep ffmpeg
```

---

## 11. Production Checklist

- [ ] stdio: ['ignore', 'pipe', 'pipe']
- [ ] Validate file paths (no directory traversal)
- [ ] Check file exists before spawning
- [ ] Handle stderr for errors
- [ ] Set process timeout with SIGTERM → SIGKILL
- [ ] Listen to socket 'close' for cleanup
- [ ] Use appropriate preset (veryfast for streaming)
- [ ] Set keyframes for seeking (-g for video)
- [ ] Log PID and session ID
- [ ] Monitor memory/CPU
- [ ] Clean up temp files on error
- [ ] Return specific HTTP status codes
- [ ] Test with actual corrupted media files

---

## 12. Code Template

```typescript
import { spawn } from "child_process";
import { pipeline } from "stream/promises";

app.get("/stream/:file", async (req, res) => {
  try {
    const file = validatePath(req.params.file);
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-i",
        file,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-c:a",
        "aac",
        "-f",
        "mp4",
        "-movflags",
        "frag_keyframe+empty_moov",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Transfer-Encoding", "chunked");

    let stderr = "";
    ffmpeg.stderr.on("data", (d) => (stderr += d));

    ffmpeg.on("error", (err) => {
      res.status(500).json({ error: err.message });
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) console.error(stderr);
    });

    req.socket.on("close", () => ffmpeg.kill("SIGKILL"));

    await pipeline(ffmpeg.stdout, res);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
```

---

## Resources

- **Tunarr**: https://github.com/chrisbenincasa/tunarr
- **PeerTube**: https://github.com/Chocobozzz/PeerTube
- **FFmpeg Docs**: https://ffmpeg.org/
- **Node.js Streams**: https://nodejs.org/api/stream.html
- **HTTP Streaming**: https://www.w3.org/TR/media-frags/
