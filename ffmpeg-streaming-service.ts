/**
 * Complete Production-Ready FFmpeg Streaming Service
 * Node.js/TypeScript - Stream FFmpeg-transcoded audio from HTTP endpoint
 *
 * This combines all the patterns from the guide into a working service.
 */

import express, { Request, Response } from "express";
import { spawn, ChildProcess } from "child_process";
import { createReadStream, createWriteStream, statSync, existsSync } from "fs";
import { pipeline } from "stream/promises";
import path from "path";

// ============================================
// TYPES & INTERFACES
// ============================================

interface TranscodeOptions {
  inputPath: string;
  bitrate: string;
  preset: "ultrafast" | "superfast" | "veryfast" | "fast" | "medium";
  format: "mp3" | "aac" | "m4a" | "flac";
  audioTrack?: number;
}

interface TranscodeSession {
  id: string;
  process?: ChildProcess;
  timeout?: NodeJS.Timeout;
  startTime: number;
  inputPath?: string;
}

enum AudioFormat {
  MP3 = "mp3",
  AAC = "aac",
  M4A = "m4a",
  FLAC = "flac",
}

type AudioCodec = "libmp3lame" | "aac" | "flac";

// ============================================
// CONFIGURATION
// ============================================

const MEDIA_DIR = process.env.MEDIA_DIR || "/tmp/media";
const TRANSCODE_TIMEOUT = 60 * 60 * 1000; // 1 hour
const TEMP_DIR = process.env.TEMP_DIR || "/tmp";

const AUDIO_CODEC_MAP: Record<AudioFormat, AudioCodec> = {
  [AudioFormat.MP3]: "libmp3lame",
  [AudioFormat.AAC]: "aac",
  [AudioFormat.M4A]: "aac",
  [AudioFormat.FLAC]: "flac",
};

const AUDIO_BITRATE_MAP: Record<AudioFormat, string> = {
  [AudioFormat.MP3]: "192k",
  [AudioFormat.AAC]: "128k",
  [AudioFormat.M4A]: "128k",
  [AudioFormat.FLAC]: "320k",
};

const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE_PATH = process.env.FFPROBE_PATH || "ffprobe";

// ============================================
// TRANSCODE SESSION MANAGER
// ============================================

class TranscodeSessionManager {
  private sessions = new Map<string, TranscodeSession>();

  start(
    inputPath: string,
    options: TranscodeOptions,
    timeoutMs: number = TRANSCODE_TIMEOUT,
  ): { sessionId: string; stream: NodeJS.ReadableStream } {
    const sessionId = `transcode_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const codecArgs = this.buildFFmpegArgs(options);
    const ffmpeg = spawn(FFMPEG_PATH, codecArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const session: TranscodeSession = {
      id: sessionId,
      process: ffmpeg,
      startTime: Date.now(),
      inputPath,
    };

    // Set timeout
    session.timeout = setTimeout(() => {
      console.warn(
        `[${sessionId}] Transcode timeout ${timeoutMs}ms, killing process`,
      );
      this.kill(sessionId, "timeout");
    }, timeoutMs);

    // Capture stderr for debugging
    let stderrOutput = "";
    ffmpeg.stderr.on("data", (data) => {
      stderrOutput += data.toString();
      // Optional: parse progress
      // const frameMatch = stderrOutput.match(/frame=\s*(\d+)/);
    });

    // Cleanup on process exit
    ffmpeg.on("close", (code) => {
      clearTimeout(session.timeout!);
      this.sessions.delete(sessionId);

      if (code !== 0) {
        console.error(
          `[${sessionId}] FFmpeg exited with code ${code}\n${stderrOutput.slice(-500)}`,
        );
      }
    });

    ffmpeg.on("error", (err) => {
      console.error(`[${sessionId}] FFmpeg spawn error:`, err);
      clearTimeout(session.timeout!);
      this.sessions.delete(sessionId);
    });

    this.sessions.set(sessionId, session);
    return { sessionId, stream: ffmpeg.stdout };
  }

  kill(sessionId: string, reason: string = "user-cancelled"): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.process) return false;

    console.log(
      `[${sessionId}] Killing transcode: ${reason} (input: ${session.inputPath})`,
    );

    // Graceful termination
    session.process.kill("SIGTERM");

    const killTimeout = setTimeout(() => {
      if (session.process && !session.process.killed) {
        console.warn(`[${sessionId}] Force killing with SIGKILL`);
        session.process.kill("SIGKILL");
      }
    }, 5000);

    session.process.once("exit", () => {
      clearTimeout(killTimeout);
      clearTimeout(session.timeout!);
    });

    return true;
  }

  getStatus(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    return {
      sessionId,
      isRunning: session.process && !session.process.killed,
      pid: session.process?.pid,
      elapsedSeconds: (Date.now() - session.startTime) / 1000,
      inputPath: session.inputPath,
    };
  }

  private buildFFmpegArgs(options: TranscodeOptions): string[] {
    const codec = AUDIO_CODEC_MAP[options.format];
    const bitrate = AUDIO_BITRATE_MAP[options.format];

    return [
      "-i",
      options.inputPath,
      "-map",
      `0:a:${options.audioTrack || 0}`,
      "-c:a",
      codec,
      "-b:a",
      bitrate,
      "-f",
      options.format === "m4a" ? "aac" : options.format,
      "pipe:1",
    ];
  }
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Get audio tracks info from media file using ffprobe
 */
async function getAudioTracks(filePath: string): Promise<
  Array<{
    index: number;
    codec: string;
    language?: string;
    channels: number;
  }>
> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn(FFPROBE_PATH, [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_streams",
      filePath,
    ]);

    let output = "";
    ffprobe.stdout.on("data", (data) => {
      output += data.toString();
    });

    ffprobe.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed with code ${code}`));
        return;
      }

      try {
        const data = JSON.parse(output);
        const audioTracks = data.streams
          .filter((s: any) => s.codec_type === "audio")
          .map((s: any, idx: number) => ({
            index: idx,
            codec: s.codec_name,
            language: s.tags?.language || "unknown",
            channels: s.channels,
          }));

        resolve(audioTracks);
      } catch (err) {
        reject(err);
      }
    });

    ffprobe.on("error", reject);
  });
}

/**
 * Validate file path to prevent directory traversal
 */
function validateMediaPath(userPath: string): string {
  const normalized = path.normalize(userPath);
  const fullPath = path.join(MEDIA_DIR, normalized);

  // Ensure path is within MEDIA_DIR
  if (!fullPath.startsWith(MEDIA_DIR)) {
    throw new Error("Invalid path: directory traversal detected");
  }

  // Ensure file exists
  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${userPath}`);
  }

  return fullPath;
}

// ============================================
// EXPRESS SERVER
// ============================================

const app = express();
const transcodeManager = new TranscodeSessionManager();

// Middleware
app.use(express.json());

// ============ HEALTH CHECK ============
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ============ EXTRACT AUDIO ENDPOINT ============
/**
 * GET /audio/:mediaFile
 *
 * Query params:
 * - format: mp3|aac|m4a|flac (default: mp3)
 * - track: audio track index (default: 0)
 * - bitrate: custom bitrate (default: format-specific)
 *
 * Example:
 * GET /audio/movie.mkv?format=m4a&track=0
 */
app.get("/audio/:mediaFile", async (req: Request, res: Response) => {
  const sessionId = `session_${Date.now()}`;

  try {
    // Validate input
    const mediaPath = validateMediaPath(req.params.mediaFile);
    const format = (req.query.format || AudioFormat.MP3) as AudioFormat;
    const trackIndex = parseInt(req.query.track as string) || 0;

    if (!Object.values(AudioFormat).includes(format)) {
      return res.status(400).json({
        error: "Invalid format",
        valid: Object.values(AudioFormat),
      });
    }

    // Build options
    const options: TranscodeOptions = {
      inputPath: mediaPath,
      format,
      audioTrack: trackIndex,
      bitrate: AUDIO_BITRATE_MAP[format],
      preset: "veryfast",
    };

    // Start transcode
    const { sessionId: transcodeId, stream } = transcodeManager.start(
      mediaPath,
      options,
    );

    console.log(
      `[${sessionId}] Starting audio extraction: ${req.params.mediaFile} → ${format}`,
    );

    // Set response headers
    const contentType = {
      [AudioFormat.MP3]: "audio/mpeg",
      [AudioFormat.AAC]: "audio/aac",
      [AudioFormat.M4A]: "audio/mp4",
      [AudioFormat.FLAC]: "audio/flac",
    };

    res.setHeader("Content-Type", contentType[format]);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audio.${format}"`,
    );
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("X-Transcode-Session", transcodeId);

    // Handle client disconnect (important for cleanup)
    req.socket.on("close", () => {
      if (req.socket.destroyed) {
        console.log(`[${sessionId}] Client disconnected, cleaning up`);
        transcodeManager.kill(transcodeId, "client_disconnect");
      }
    });

    // Stream directly to response
    stream.on("error", (err) => {
      console.error(`[${sessionId}] Stream error:`, err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Streaming failed" });
      }
    });

    await pipeline(stream, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${sessionId}] Error:`, message);

    if (!res.headersSent) {
      res
        .status(
          message.includes("not found")
            ? 404
            : message.includes("traversal")
              ? 400
              : 500,
        )
        .json({ error: message });
    }
  }
});

// ============ STREAM VIDEO WITH TRANSCODE ============
/**
 * GET /stream/:mediaFile
 *
 * Query params:
 * - time: seek to time in seconds (for transcoded streams)
 * - quality: low|medium|high (default: high)
 * - format: mp4|mkv (default: mp4)
 *
 * Example:
 * GET /stream/movie.mkv?quality=high&format=mp4
 */
app.get("/stream/:mediaFile", async (req: Request, res: Response) => {
  try {
    const mediaPath = validateMediaPath(req.params.mediaFile);
    const quality = req.query.quality || "high";
    const format = req.query.format || "mp4";
    const seekTime = req.query.time ? `${req.query.time}s` : "0";

    const qualityPresets = {
      low: { bitrate: "1000k", preset: "superfast" as const },
      medium: { bitrate: "3000k", preset: "veryfast" as const },
      high: { bitrate: "6000k", preset: "fast" as const },
    };

    const preset =
      qualityPresets[quality as keyof typeof qualityPresets] ||
      qualityPresets.high;

    const ffmpegArgs = [
      "-ss",
      seekTime,
      "-i",
      mediaPath,
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
      "frag_keyframe+empty_moov",
      "pipe:1",
    ];

    const ffmpeg = spawn(FFMPEG_PATH, ffmpegArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    res.setHeader("Content-Type", `video/${format}`);
    res.setHeader("Transfer-Encoding", "chunked");

    // Handle errors
    let stderr = "";
    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpeg.on("error", (err) => {
      console.error("FFmpeg error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Stream failed" });
      }
    });

    // Cleanup on client disconnect
    req.socket.on("close", () => {
      if (!ffmpeg.killed) {
        ffmpeg.kill("SIGKILL");
      }
    });

    await pipeline(ffmpeg.stdout, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Stream error:", message);

    if (!res.headersSent) {
      res.status(500).json({ error: message });
    }
  }
});

// ============ GET AUDIO TRACKS ============
/**
 * GET /metadata/:mediaFile
 */
app.get("/metadata/:mediaFile", async (req: Request, res: Response) => {
  try {
    const mediaPath = validateMediaPath(req.params.mediaFile);
    const tracks = await getAudioTracks(mediaPath);

    res.json({
      file: req.params.mediaFile,
      audioTracks: tracks,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Metadata error:", message);
    res.status(500).json({ error: message });
  }
});

// ============ TRANSCODE STATUS ============
/**
 * GET /transcode/status/:sessionId
 */
app.get("/transcode/status/:sessionId", (req: Request, res: Response) => {
  const status = transcodeManager.getStatus(req.params.sessionId);

  if (!status) {
    return res.status(404).json({ error: "Session not found" });
  }

  res.json(status);
});

// ============ CANCEL TRANSCODE ============
/**
 * POST /transcode/cancel/:sessionId
 */
app.post("/transcode/cancel/:sessionId", (req: Request, res: Response) => {
  const killed = transcodeManager.kill(req.params.sessionId, "api_request");

  if (!killed) {
    return res.status(404).json({ error: "Session not found" });
  }

  res.json({ message: "Transcode cancelled" });
});

// ============ ERROR HANDLER ============
app.use((err: Error, req: Request, res: Response) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: "Internal server error",
    message: err.message,
  });
});

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`\n🎬 FFmpeg Streaming Service`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET  /health`);
  console.log(`  GET  /audio/:mediaFile?format=mp3&track=0`);
  console.log(`  GET  /stream/:mediaFile?quality=high&format=mp4`);
  console.log(`  GET  /metadata/:mediaFile`);
  console.log(`  GET  /transcode/status/:sessionId`);
  console.log(`  POST /transcode/cancel/:sessionId`);
  console.log(`\nConfiguration:`);
  console.log(`  MEDIA_DIR=${MEDIA_DIR}`);
  console.log(`  FFMPEG_PATH=${FFMPEG_PATH}`);
  console.log(`  TRANSCODE_TIMEOUT=${TRANSCODE_TIMEOUT}ms\n`);
});

export { TranscodeSessionManager, TranscodeOptions };
