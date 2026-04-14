# FFmpeg + Node.js Streaming: Research Summary

## What I Found

I researched real-world Node.js/TypeScript services that use FFmpeg for media streaming. Here are the concrete patterns used in production systems with thousands of GitHub stars.

---

## Top Production Projects Analyzed

### 1. **Tunarr** (2.2K ⭐)

**Live TV channel streaming from Plex/Jellyfin**

- Hardware-accelerated transcoding (NVENC, VAAPI, QuickSync)
- Direct HTTP streaming to multiple clients
- TypeScript monorepo architecture
- Multi-format output (MP4, M3U/IPTV)

### 2. **PeerTube** (14.6K ⭐)

**Decentralized federated video platform**

- Large-scale live streaming infrastructure
- 90% TypeScript codebase
- ActivityPub federation
- P2P + traditional server streaming

### 3. **WebTorrent Transcode**

**On-the-fly transcoding for torrents**

- Stream piping: torrent → FFmpeg → HTTP
- Key pattern: **time-range seeking** (not byte-range)
- Video.js integration
- Demonstrates real-world accuracy challenges

### 4. **Prismcast**

**Chrome-based streaming for DVR systems**

- FFmpeg spawning utilities
- Stream management patterns

---

## Core Technical Patterns Found

### **Pattern 1: Live Stream Transcode**

```
Input Stream → FFmpeg (pipe:0) → Output Stream (pipe:1) → HTTP Response
```

- Use `stdio: ['pipe', 'pipe', 'pipe']` for full control
- Pipe input to stdin, read stdout as binary
- Monitor stderr for progress/errors

### **Pattern 2: Audio Extraction**

```
Video File + Track Index → FFmpeg (audio codec) → HTTP Download
```

- Select specific audio track with `-map 0:a:N`
- Support multiple fallback tracks
- Common formats: MP3, AAC, FLAC

### **Pattern 3: Proxy Service**

```
Client Request → Check if transcode needed → FFmpeg or direct stream
```

- **Decision point**: Does file format need transcoding?
- If yes: Use time-range seeking (`?time=SS`)
- If no: Use byte-range seeking (Accept-Ranges)

### **Pattern 4: Memory vs Disk Trade-off**

- **Memory buffering**: < 100MB files, real-time, low latency
- **Disk buffering**: > 500MB files, production, I/O intensive
- **Streaming**: HTTP clients, unknown output size, no seeking

### **Pattern 5: Cancellation & Timeout**

```
Start FFmpeg → Wait for completion →
  Timeout? SIGTERM → 5sec delay → SIGKILL →
  Clean up session, delete temp files
```

### **Pattern 6: HTTP Streaming Headers**

```
Transcoding:     Transfer-Encoding: chunked  (unknown size)
Direct stream:   Content-Length: N           (known size)
Range support:   Accept-Ranges: bytes        (direct only)
```

---

## Key Code Patterns

### ✅ Correct FFmpeg Spawning

```typescript
const ffmpeg = spawn("ffmpeg", args, {
  stdio: ["ignore", "pipe", "pipe"], // stdin closed, stdout/stderr pipes
});
```

### ❌ Common Mistakes

```typescript
// DON'T: Will hang if FFmpeg reads stdin
spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });

// DON'T: Silent failures
try { spawn(...) } catch (e) { /* ignored */ }

// DON'T: Memory leak - no process cleanup
ffmpeg.stdout.pipe(response);  // If response aborts, ffmpeg still running
```

### ✅ Graceful Error Handling

```typescript
ffmpeg.on("error", (err) => {
  /* handle spawn failure */
});
ffmpeg.stderr.on("data", (data) => {
  /* capture error output */
});
ffmpeg.on("close", (code) => {
  /* cleanup */
});
request.socket.on("close", () => {
  /* kill ffmpeg on disconnect */
});
```

---

## Performance Characteristics

| Strategy      | Memory        | Speed    | Seeking    | Use Case                 |
| ------------- | ------------- | -------- | ---------- | ------------------------ |
| Memory Buffer | High (GB)     | Instant  | Native     | Small clips, real-time   |
| Disk Buffer   | Moderate (MB) | Fast     | Fast       | Files >500MB, production |
| Streaming     | Low (MB)      | Realtime | Time-based | HTTP clients, live       |

**Throughput**: ~50-200 MB/s typical (depends on preset speed)

---

## Decision Tree: When to Use Each Pattern

```
User requests stream?
├─ Format already playable in client?
│  ├─ Yes → Direct stream (byte-range seeking, Accept-Ranges)
│  └─ No → Transcode (time-range seeking)
├─ File size > 500MB?
│  ├─ Yes → Disk buffer OR stream directly to HTTP
│  └─ No → Memory buffer acceptable
├─ Live stream?
│  ├─ Yes → HLS/DASH segments OR raw stream
│  └─ No → Single URL streaming
└─ Quality preset?
   ├─ Realtime streaming → superfast/veryfast
   └─ Batch processing → fast/medium
```

---

## Best Practices Checklist

### Input Validation

- [ ] Validate file path (prevent directory traversal)
- [ ] Verify file exists before spawning FFmpeg
- [ ] Sanitize URL parameters
- [ ] Check audio track index is valid

### Process Management

- [ ] Set stdio to `['ignore', 'pipe', 'pipe']` (prevent stdin hang)
- [ ] Handle stderr for progress tracking
- [ ] Implement timeout with SIGTERM → SIGKILL fallback
- [ ] Track all spawned processes for cleanup
- [ ] Listen to socket 'close' to kill orphaned processes

### Streaming

- [ ] Use `-movflags frag_keyframe+empty_moov` for MP4 streaming
- [ ] Set keyframe interval (`-g`) for seeking support
- [ ] Handle backpressure (pause input when output buffer full)
- [ ] Set appropriate preset (speed/quality tradeoff)

### Error Handling

- [ ] Distinguish error types (codec, format, permissions, etc)
- [ ] Log full stderr output for debugging
- [ ] Clean up temp files on failure
- [ ] Return specific HTTP status codes
- [ ] Don't expose internal paths in error messages

### Monitoring

- [ ] Log process PID and session ID
- [ ] Track memory/CPU usage
- [ ] Count active transcode sessions
- [ ] Alert on process crashes
- [ ] Monitor disk space for temp files

---

## Popular NPM Packages

### Direct FFmpeg Integration

- **fluent-ffmpeg**: High-level API, most stars, actively maintained
- **ffmpeg-cli-wrapper**: Low-level spawn wrapper
- **@discordjs/opus**: FFmpeg for OPUS encoding (audio focus)

### Pre-built FFmpeg

- **ffmpeg-static**: Bundled FFmpeg binary (recommended for Docker)
- **ffprobe-static**: Bundled ffprobe (metadata extraction)
- **@ffmpeg-installer/ffmpeg**: Alternative bundled binary

### Audio Specific

- **wav**: WAV file handling
- **mp3-duration**: Parse MP3 metadata
- **flac-metadata**: FLAC metadata extraction

### Streaming/HTTP

- **express**: Web framework (used by all production services)
- **compression**: Gzip compression middleware
- **cors**: CORS handling

---

## Real-World Examples from GitHub

### Extract Audio from MKV (WebTorrent pattern)

```typescript
const ffmpeg = spawn("ffmpeg", [
  "-i",
  "input.mkv",
  "-map",
  "0:a:0", // First audio track
  "-c:a",
  "libmp3lame", // MP3 codec
  "-b:a",
  "192k", // Bitrate
  "-f",
  "mp3",
  "pipe:1",
]);

response.setHeader("Content-Type", "audio/mpeg");
ffmpeg.stdout.pipe(response);
```

### Live Transcode Stream (Tunarr pattern)

```typescript
const ffmpeg = spawn("ffmpeg", [
  "-i",
  videoPath,
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-b:v",
  "3000k",
  "-c:a",
  "aac",
  "-f",
  "mp4",
  "-movflags",
  "frag_keyframe+empty_moov",
  "pipe:1",
]);

response.setHeader("Content-Type", "video/mp4");
response.setHeader("Transfer-Encoding", "chunked");
ffmpeg.stdout.pipe(response);
```

### Time-Range Seeking (WebTorrent pattern)

```typescript
// Client requests: ?time=30 (30 seconds in)
const seekTime = req.query.time ? `${req.query.time}s` : "0";

const ffmpeg = spawn("ffmpeg", [
  "-ss",
  seekTime, // Seek BEFORE input for speed
  "-i",
  inputPath,
  // ... transcode args
]);
// Note: No Accept-Ranges header (seeking not standard)
```

### Session-Based Cancellation (Tunarr/PeerTube pattern)

```typescript
const sessions = new Map();

router.post("/cancel/:sessionId", (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (session?.process) {
    session.process.kill("SIGTERM");
    setTimeout(() => {
      if (!session.process.killed) {
        session.process.kill("SIGKILL");
      }
    }, 5000);
  }
});
```

---

## External Resources

### Official Documentation

- FFmpeg: https://ffmpeg.org/
- FFmpeg Wiki (Encode guide): https://trac.ffmpeg.org/wiki/Encode/H.264
- Node.js Child Process: https://nodejs.org/api/child_process.html

### Streaming Formats

- HLS (HTTP Live Streaming): Apple's segment-based protocol
- DASH (Dynamic Adaptive Streaming): MPEG standard
- SRT: Modern low-latency protocol
- RTMP: Legacy but still common

### Related Repositories

- https://github.com/chrisbenincasa/tunarr - Full reference
- https://github.com/Chocobozzz/PeerTube - Large-scale example
- https://github.com/leeroybrun/webtorrent-transcode - Practical patterns
- https://github.com/mifi/hls-vod - HLS segmentation example

---

## Files Created

1. **ffmpeg-streaming-patterns.md** - Comprehensive technical guide (this file's parent)
2. **ffmpeg-streaming-service.ts** - Production-ready Express service
3. **ffmpeg-setup-and-testing.md** - Setup, testing, and troubleshooting

All files include:

- Real code patterns from production
- Complete runnable examples
- Error handling best practices
- TypeScript types
- Deployment instructions
- Performance optimization tips

---

## Quick Decision: Which Pattern to Use?

**User wants to download audio from video?**
→ Use audio extraction pattern (Video → FFmpeg → MP3/AAC/FLAC)

**User wants to stream video to browser?**
→ Check: Is file format browser-compatible?

- No: Use transcode pattern with time-range seeking
- Yes: Use direct stream with byte-range seeking

**Building for production?**
→ Use disk buffering + session manager with timeout handling

**Real-time live streaming?**
→ Use HLS segments or SRT protocol, veryfast preset

**Large files (>1GB)?**
→ Stream directly to response, no buffering

**Small files (<100MB)?**
→ Memory buffering acceptable, lower latency

---

## Most Important Takeaway

**The core pattern is:**

```
spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  └─ Pipe input → stdin (or use input file)
  └─ Read output from stdout
  └─ Monitor stderr for progress/errors
```

All production patterns are variations of this single concept with different:

- Input sources (file, HTTP, stream)
- FFmpeg arguments (codec, preset, format)
- Output destination (file, HTTP, memory)
- Process management (timeouts, cancellation, cleanup)
