import { spawn } from "node:child_process";
import { HttpError } from "../errors/http-error.js";

export type AudioFormat = "mp3" | "aac" | "flac";

interface InputRequestOptions {
  userAgent?: string;
  headers?: Record<string, string>;
}

export class FfmpegResolver {
  private readonly timeoutMs: number;

  public constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  private argsForFormat(format: AudioFormat): string[] {
    if (format === "aac") {
      return ["-acodec", "aac", "-b:a", "192k"];
    }
    if (format === "flac") {
      return ["-acodec", "flac"];
    }
    return ["-acodec", "libmp3lame", "-ab", "192k"];
  }

  public resolveToFile(
    sourceUrl: string,
    outputPath: string,
    format: AudioFormat,
    signal?: AbortSignal,
    inputRequest?: InputRequestOptions,
    durationHintSeconds?: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const requestArgs: string[] = [];
      if (inputRequest?.userAgent) {
        requestArgs.push("-user_agent", inputRequest.userAgent);
      }
      if (inputRequest?.headers && Object.keys(inputRequest.headers).length > 0) {
        const headerValue = Object.entries(inputRequest.headers)
          .map(([name, value]) => `${name}: ${value}`)
          .join("\r\n");
        requestArgs.push("-headers", `${headerValue}\r\n`);
      }

      const ffmpeg = spawn("ffmpeg", [
        "-y",
        ...requestArgs,
        "-i",
        sourceUrl,
        "-vn",
        ...(typeof durationHintSeconds === "number" && durationHintSeconds > 0
          ? ["-t", String(durationHintSeconds)]
          : []),
        ...this.argsForFormat(format),
        outputPath,
      ]);

      const timeout = setTimeout(() => {
        ffmpeg.kill("SIGKILL");
        reject(new HttpError(503, "transcode_timeout"));
      }, this.timeoutMs);

      const abortHandler = (): void => {
        ffmpeg.kill("SIGKILL");
        reject(new HttpError(499, "client_disconnected"));
      };

      signal?.addEventListener("abort", abortHandler, { once: true });

      ffmpeg.on("error", () => {
        clearTimeout(timeout);
        reject(new HttpError(500, "transcode_spawn_failed"));
      });

      ffmpeg.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new HttpError(500, "transcode_failed"));
          return;
        }
        resolve();
      });
    });
  }
}
