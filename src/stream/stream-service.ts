import fs from "node:fs";
import axios from "axios";
import { MemoryCache } from "../cache/memory-cache.js";
import { DebridRouter } from "../debrid/debrid-router.js";
import { HttpError } from "../errors/http-error.js";
import { normalizeTikTokUrl } from "../utils/tiktok-url.js";
import { StreamCache } from "../cache/stream-cache.js";
import { AudioFormat, FfmpegResolver } from "./ffmpeg-resolver.js";

interface ResolveArgs {
  sourceUrl: string;
  format?: AudioFormat;
  torboxToken?: string;
  signal?: AbortSignal;
}

export type StreamResolution =
  | { type: "url"; url: string; provider: "torbox" }
  | { type: "file"; filePath: string };

export class StreamService {
  private readonly router: DebridRouter;
  private readonly ffmpeg: FfmpegResolver;
  private readonly streamCache: StreamCache;
  private readonly localTtlMs: number;
  private readonly urlMapCache: MemoryCache<StreamResolution>;
  private readonly pageMediaUrlCache: MemoryCache<string[]>;
  private readonly pageRequestHeadersCache: MemoryCache<Record<string, string>>;
  private readonly resolveMediaUrls: (sourceUrl: string) => Promise<string[]>;

  public constructor(args: {
    router: DebridRouter;
    ffmpeg: FfmpegResolver;
    streamCache: StreamCache;
    localTtlMs: number;
    urlMapCache?: MemoryCache<StreamResolution>;
    resolveMediaUrls?: (sourceUrl: string) => Promise<string[]>;
  }) {
    this.router = args.router;
    this.ffmpeg = args.ffmpeg;
    this.streamCache = args.streamCache;
    this.localTtlMs = args.localTtlMs;
    this.urlMapCache =
      args.urlMapCache ??
      new MemoryCache<StreamResolution>(2 * 60 * 60 * 1000, 10_000);
    this.pageMediaUrlCache = new MemoryCache<string[]>(2 * 60 * 60 * 1000, 10_000);
    this.pageRequestHeadersCache = new MemoryCache<Record<string, string>>(
      2 * 60 * 60 * 1000,
      10_000,
    );
    this.resolveMediaUrls =
      args.resolveMediaUrls ??
      ((sourceUrl: string) => this.resolveTranscodeInputUrls(sourceUrl));
  }

  private cookieHeaderFromSetCookie(value: unknown): string | undefined {
    const cookies = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? [value]
        : [];

    const serialized = cookies
      .map((entry) => entry.split(";")[0]?.trim())
      .filter((entry): entry is string => Boolean(entry))
      .join("; ");

    return serialized || undefined;
  }

  private decodeUrl(value: string): string {
    return value
      .replace(/\\u002F/g, "/")
      .replace(/\\u0026/g, "&")
      .replace(/\\\//g, "/");
  }

  private extractPlayableUrlsFromPage(html: string): string[] {
    const scripts = [
      /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">([\s\S]*?)<\/script>/,
      /<script id="SIGI_STATE" type="application\/json">([\s\S]*?)<\/script>/,
    ];

    for (const pattern of scripts) {
      const match = html.match(pattern);
      if (!match) {
        continue;
      }
      try {
        const parsed = JSON.parse(match[1]) as unknown;
        const raw = JSON.stringify(parsed);
        const audioPlayMatches = [...raw.matchAll(/"playUrl":"(https:[^"]*mime_type=audio_mpeg[^"]*)"/g)].map((entry) =>
          this.decodeUrl(entry[1]),
        );
        const playAddrMatches = [...raw.matchAll(/"playAddr":"(https:[^"]+)"/g)].map((entry) =>
          this.decodeUrl(entry[1]),
        );
        const downloadAddrMatches = [...raw.matchAll(/"downloadAddr":"(https:[^"]+)"/g)].map((entry) =>
          this.decodeUrl(entry[1]),
        );

        const ordered = [
          ...audioPlayMatches,
          ...playAddrMatches,
          ...downloadAddrMatches,
        ];

        const unique = [...new Set(ordered.filter((value) => value.startsWith("https://")))];
        if (unique.length > 0) {
          return unique;
        }
      } catch {
        continue;
      }
    }

    return [];
  }

  private async resolveTranscodeInputUrls(sourceUrl: string): Promise<string[]> {
    const cached = this.pageMediaUrlCache.get(sourceUrl);
    if (cached && cached.length > 0) {
      return cached;
    }

    const response = await axios.get<string>(sourceUrl, {
      timeout: 10_000,
      responseType: "text",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
      },
    });

    const playable = this.extractPlayableUrlsFromPage(response.data);
    if (playable.length === 0) {
      throw new HttpError(500, "stream_extraction_failed");
    }

    const cookieHeader = this.cookieHeaderFromSetCookie(response.headers["set-cookie"]);
    if (cookieHeader) {
      this.pageRequestHeadersCache.set(sourceUrl, { Cookie: cookieHeader });
    }

    this.pageMediaUrlCache.set(sourceUrl, playable);
    return playable;
  }

  public async resolve(args: ResolveArgs): Promise<StreamResolution> {
    let sourceUrl: string;
    const format = args.format ?? "mp3";
    if (!["mp3", "aac", "flac"].includes(format)) {
      throw new HttpError(400, "unsupported_audio_format");
    }

    try {
      sourceUrl = normalizeTikTokUrl(args.sourceUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid_url";
      throw new HttpError(
        400,
        message === "Unsupported host" ? "unsupported_url" : "invalid_url",
      );
    }

    const mapKey = `${sourceUrl}:${format}`;
    const mapped = this.urlMapCache.get(mapKey);
    if (mapped) {
      if (mapped.type === "file") {
        if (fs.existsSync(mapped.filePath)) {
          return mapped;
        }
        this.urlMapCache.delete(mapKey);
      } else {
        return mapped;
      }
    }

    const routed = await this.router.tryRoute(sourceUrl, {
      torbox: args.torboxToken,
    });
    if (routed) {
      const output: StreamResolution = {
        type: "url",
        url: routed.url,
        provider: routed.provider,
      };
      this.urlMapCache.set(mapKey, output);
      return output;
    }

    const key = this.streamCache.keyFromUrl(sourceUrl, format);
    const cachedPath = this.streamCache.getValidFilePath(key);
    if (cachedPath && fs.existsSync(cachedPath)) {
      const output: StreamResolution = { type: "file", filePath: cachedPath };
      this.urlMapCache.set(mapKey, output);
      return output;
    }

    const outputPath = this.streamCache.createOutputPath(key, format);
    const transcodeInputUrls = await this.resolveMediaUrls(sourceUrl);
    const cachedRequestHeaders = this.pageRequestHeadersCache.get(sourceUrl) ?? {};
    const startedAt = Date.now();
    let transcodeError: unknown = null;
    for (const transcodeInputUrl of transcodeInputUrls) {
      try {
            await this.ffmpeg.resolveToFile(
              transcodeInputUrl,
              outputPath,
              format,
              args.signal,
              {
                userAgent:
                  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
                headers: {
                  ...cachedRequestHeaders,
                  Referer: "https://www.tiktok.com/",
                  Origin: "https://www.tiktok.com",
                },
              },
            );
        transcodeError = null;
        break;
      } catch (error) {
        transcodeError = error;
        if (!(error instanceof HttpError) || error.message !== "transcode_failed") {
          throw error;
        }
      }
    }

    if (transcodeError) {
      throw transcodeError;
    }

    console.log(
      `transcode completed: format=${format} duration_ms=${Date.now() - startedAt}`,
    );
    this.streamCache.set(key, outputPath, this.localTtlMs);
    const output: StreamResolution = { type: "file", filePath: outputPath };
    this.urlMapCache.set(mapKey, output);
    return output;
  }
}
