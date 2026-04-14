import axios from "axios";
import { createHash } from "node:crypto";
import xbogus from "xbogus";
import { NormalizedTrack, SearchPage, SearchQuery } from "../../types.js";
import {
  isLikelyTikTokUrlQuery,
  normalizeTikTokUrl,
} from "../../utils/tiktok-url.js";

interface SearchProvider {
  search(args: SearchQuery): Promise<SearchPage>;
}

interface CandidateItem {
  id?: string;
  title?: string;
  artist?: string;
  duration?: number;
  artworkURL?: string;
  streamURL?: string;
  playbackURL?: string;
}

interface SearchApiAuthor {
  nickname?: string;
  uniqueId?: string;
  unique_id?: string;
}

interface SearchApiVideoCoverObject {
  url_list?: string[];
}

interface SearchApiVideo {
  duration?: number;
  cover?: string | SearchApiVideoCoverObject;
}

interface SearchApiMusic {
  id?: string;
  title?: string;
  playUrl?: string;
  coverThumb?: string;
  coverMedium?: string;
  coverLarge?: string;
  authorName?: string;
  duration?: number;
}

interface SearchApiItem {
  id?: string;
  desc?: string;
  author?: SearchApiAuthor;
  video?: SearchApiVideo;
  music?: SearchApiMusic;
}

interface SearchApiEntry {
  type?: number;
  item?: SearchApiItem;
}

interface SearchApiResponse {
  data?: SearchApiEntry[];
  has_more?: boolean | number;
  hasMore?: boolean;
  cursor?: number | string;
  search_cursor?: number | string;
  statusCode?: number;
  status_code?: number;
  message?: string;
}

interface IbbyLabsParserOptions {
  authCookie?: string;
  retryMaxAttempts?: number;
  retryBaseDelayMs?: number;
}

interface RankedTrack {
  track: NormalizedTrack;
  score: number;
  tieBreak: string;
}

const SEARCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const TITLE_MAX_LENGTH = 110;
const REQUEST_TIMEOUT_MS = 10_000;

class AuthSessionError extends Error {
  public constructor(message = "auth_session_failed") {
    super(message);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function tokenize(value: string): string[] {
  const normalized = value.toLowerCase().replace(/[^a-z0-9\s]+/g, " ");
  return normalized.split(/\s+/).map((token) => token.trim()).filter(Boolean);
}

export function computeRelevanceScore(query: string, title: string, artist: string): number {
  const q = query.toLowerCase().trim();
  if (!q) {
    return 0;
  }

  const titleLower = title.toLowerCase();
  const artistLower = artist.toLowerCase();
  const titleTokens = new Set(tokenize(title));
  const artistTokens = new Set(tokenize(artist));
  const queryTokens = tokenize(query);

  let score = 0;
  if (titleLower.includes(q)) {
    score += 120;
  }
  if (artistLower.includes(q)) {
    score += 70;
  }

  for (const token of queryTokens) {
    if (titleTokens.has(token)) {
      score += 12;
    }
    if (artistTokens.has(token)) {
      score += 8;
    }
  }

  if (titleLower !== "original sound") {
    score += 4;
  }

  return score;
}

function normalizeWhitespace(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function truncateTitle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const slice = value.slice(0, maxLength + 1).trim();
  const lastSpace = slice.lastIndexOf(" ");
  const truncated =
    lastSpace >= Math.floor(maxLength * 0.6)
      ? slice.slice(0, lastSpace)
      : slice.slice(0, maxLength);

  return `${truncated.trim()}...`;
}

export function formatTrackTitle(
  description: string | undefined,
  soundTitle: string | undefined,
): string | undefined {
  const cleanedDescription = normalizeWhitespace(description)
    .replace(/(^|\s)(?:#[^\s#@]+|@[^\s#@]+)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const candidate = cleanedDescription || normalizeWhitespace(soundTitle);
  if (!candidate) {
    return undefined;
  }

  return truncateTitle(candidate, TITLE_MAX_LENGTH);
}

function buildTrackIdentity(
  item: SearchApiItem,
  music: SearchApiMusic,
  uniqueId: string,
  streamURL: string,
): string {
  if (item.id) {
    return `video:${item.id}`;
  }

  const fallbackSeed = [music.id ?? "", uniqueId, streamURL].join("|");
  return `fallback:${createHash("sha1").update(fallbackSeed).digest("hex")}`;
}

export function normalizeParsedItem(
  item: CandidateItem,
): NormalizedTrack | null {
  if (
    !item.id ||
    !item.title ||
    !item.artist ||
    !item.artworkURL ||
    !item.streamURL ||
    typeof item.duration !== "number"
  ) {
    return null;
  }

  return {
    id: item.id,
    title: item.title,
    artist: item.artist,
    duration: item.duration,
    artworkURL: item.artworkURL,
    streamURL: item.streamURL,
    playbackURL: item.playbackURL,
  };
}

function extractEmbeddedJson(html: string): unknown {
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
      return JSON.parse(match[1]);
    } catch {
      continue;
    }
  }
  return null;
}

function parseTrackFromHtml(
  html: string,
  sourceUrl: string,
): NormalizedTrack | null {
  const embedded = extractEmbeddedJson(html);
  if (!embedded || typeof embedded !== "object") {
    return null;
  }

  const raw = JSON.stringify(embedded);
  const titleMatch = raw.match(/"desc":"([^"]+)"/);
  const authorMatch = raw.match(/"nickname":"([^"]+)"/);
  const coverMatch = raw.match(/"cover":"(https:[^"]+)"/);
  const durationMatch = raw.match(/"duration":(\d+)/);
  const idMatch = raw.match(/"id":"(\d{8,})"/);

  return normalizeParsedItem({
    id: idMatch?.[1],
    title: titleMatch?.[1],
    artist: authorMatch?.[1] ?? "TikTok",
    artworkURL: coverMatch?.[1],
    duration: durationMatch ? Number(durationMatch[1]) : 0,
    streamURL: sourceUrl,
  });
}

export function normalizeSearchResultItem(
  entry: SearchApiEntry,
): NormalizedTrack | null {
  const item = entry.item;
  const author = item?.author;
  const uniqueId = item?.author?.uniqueId ?? item?.author?.unique_id;
  const music = item?.music;
  const artworkURL = music?.coverLarge ?? music?.coverMedium ?? music?.coverThumb;
  const fallbackArtworkURL =
    typeof item?.video?.cover === "string"
      ? item.video.cover
      : item?.video?.cover?.url_list?.[0];

  if (entry.type !== 1 || !item || !author || !uniqueId || !music?.id) {
    return null;
  }

  const title = formatTrackTitle(item.desc, music.title);
  const streamURL = `https://www.tiktok.com/@${uniqueId}/video/${item.id}`;
  const identity = buildTrackIdentity(item, music, uniqueId, streamURL);

  return normalizeParsedItem({
    id: identity,
    title,
    artist: music.authorName ?? author.nickname,
    duration: music.duration ?? item.video?.duration,
    artworkURL: artworkURL ?? fallbackArtworkURL,
    streamURL,
    playbackURL: music.playUrl,
  });
}

export class IbbyLabsParserProvider implements SearchProvider {
  private readonly maxResults: number;
  private readonly authCookie?: string;
  private readonly retryMaxAttempts: number;
  private readonly retryBaseDelayMs: number;

  public constructor(maxResults = 36, options: IbbyLabsParserOptions = {}) {
    this.maxResults = maxResults;
    this.authCookie = options.authCookie?.trim() || undefined;
    this.retryMaxAttempts = options.retryMaxAttempts ?? 2;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
  }

  private async getSearchSessionCookies(query: string): Promise<string> {
    const response = await axios.get<string>(
      `https://www.tiktok.com/search?q=${encodeURIComponent(query)}`,
      {
        timeout: 7000,
        responseType: "text",
        headers: {
          "user-agent": SEARCH_USER_AGENT,
        },
      },
    );

    const cookies = response.headers["set-cookie"];
    if (!Array.isArray(cookies)) {
      return "";
    }

    return cookies.map((value) => value.split(";")[0]).join("; ");
  }

  private buildSearchUrl(query: string, cursor: number, count: number): string {
    const params = new URLSearchParams({
      aid: "1988",
      app_language: "en",
      app_name: "tiktok_web",
      browser_language: "en-GB",
      browser_name: "Mozilla",
      browser_online: "true",
      browser_platform: "MacIntel",
      browser_version: SEARCH_USER_AGENT,
      channel: "tiktok_web",
      cookie_enabled: "true",
      count: String(count),
      cursor: String(cursor),
      device_platform: "web_pc",
      from_page: "search",
      history_len: "1",
      is_fullscreen: "false",
      is_page_visible: "true",
      keyword: query,
      offset: String(cursor),
      os: "mac",
      region: "GB",
      screen_height: "1080",
      screen_width: "1920",
      tz_name: "Europe/London",
      user_is_login: "false",
      webcast_language: "en-GB",
    });
    const baseUrl = `https://www.tiktok.com/api/search/general/full/?${params.toString()}`;
    return `${baseUrl}&X-Bogus=${encodeURIComponent(
      xbogus(baseUrl, SEARCH_USER_AGENT),
    )}`;
  }

  private async fetchTrack(url: string): Promise<NormalizedTrack | null> {
    const response = await axios.get<string>(url, {
      timeout: 7000,
      responseType: "text",
      headers: {
        "user-agent": SEARCH_USER_AGENT,
      },
    });

    return parseTrackFromHtml(response.data, url);
  }

  private classifyAuthFailure(error: unknown): boolean {
    if (!axios.isAxiosError(error)) {
      return false;
    }
    const status = error.response?.status;
    if (status === 401) {
      return true;
    }
    if (status === 403) {
      const body = JSON.stringify(error.response?.data ?? {}).toLowerCase();
      return body.includes("login") || body.includes("auth") || body.includes("verify");
    }
    return false;
  }

  private classifyThrottle(error: unknown): boolean {
    if (!axios.isAxiosError(error)) {
      return false;
    }

    const status = error.response?.status;
    if (status === 429 || status === 503 || status === 504) {
      return true;
    }
    if (status === 403) {
      const body = JSON.stringify(error.response?.data ?? {}).toLowerCase();
      return body.includes("captcha") || body.includes("throttle") || body.includes("rate");
    }

    return false;
  }

  private parseCursor(value: number | string | undefined): number | null {
    if (typeof value === "number") {
      return Number.isFinite(value) && value >= 0 ? value : null;
    }
    if (typeof value === "string") {
      const next = Number(value);
      return Number.isFinite(next) && next >= 0 ? next : null;
    }
    return null;
  }

  private async fetchPageWithRetry(
    query: string,
    cursor: number,
    count: number,
    cookieHeader: string,
  ): Promise<SearchApiResponse> {
    const url = this.buildSearchUrl(query, cursor, count);
    let attempt = 0;

    while (true) {
      try {
        const response = await axios.get<SearchApiResponse>(url, {
          timeout: REQUEST_TIMEOUT_MS,
          headers: {
            cookie: cookieHeader,
            "user-agent": SEARCH_USER_AGENT,
          },
        });

        const statusCode = response.data.statusCode ?? response.data.status_code;
        if (statusCode && statusCode !== 0) {
          throw new Error("upstream_status_error");
        }
        return response.data;
      } catch (error) {
        if (this.classifyAuthFailure(error)) {
          throw new AuthSessionError();
        }

        if (!this.classifyThrottle(error) || attempt >= this.retryMaxAttempts) {
          throw error;
        }

        const baseDelay = this.retryBaseDelayMs * 2 ** attempt;
        const jitter = Math.floor(Math.random() * this.retryBaseDelayMs);
        await wait(baseDelay + jitter);
        attempt += 1;
      }
    }
  }

  private async runSearch(
    query: string,
    limit: number,
    cursor: number,
    withAuth: boolean,
  ): Promise<SearchPage> {
    const rawCookies = await this.getSearchSessionCookies(query);
    const cookieHeader = withAuth && this.authCookie
      ? [rawCookies, this.authCookie].filter(Boolean).join("; ")
      : rawCookies;

    const ranked = new Map<string, RankedTrack>();
    let currentCursor = cursor;
    let nextCursor: number | undefined;
    let hasMore = false;
    let partial = false;
    const pageSize = Math.min(Math.max(limit * 2, 20), 50);
    const maxPages = Math.max(Math.ceil(limit / pageSize) + 2, 3);

    for (let page = 0; page < maxPages && ranked.size < limit; page += 1) {
      let data: SearchApiResponse;
      try {
        data = await this.fetchPageWithRetry(query, currentCursor, pageSize, cookieHeader);
      } catch (error) {
        if (this.classifyThrottle(error) && ranked.size > 0) {
          partial = true;
          hasMore = false;
          break;
        }
        throw error;
      }

      for (const entry of data.data ?? []) {
        const track = normalizeSearchResultItem(entry);
        if (!track) {
          continue;
        }

        const score = computeRelevanceScore(query, track.title, track.artist);
        const tieBreak = `${track.streamURL}:${track.id}`;
        const existing = ranked.get(track.id);

        if (!existing || score > existing.score || (score === existing.score && tieBreak < existing.tieBreak)) {
          ranked.set(track.id, { track, score, tieBreak });
        }
      }

      const upstreamHasMore =
        data.has_more === true ||
        data.has_more === 1 ||
        data.hasMore === true;
      const parsedNextCursor = this.parseCursor(data.cursor ?? data.search_cursor);
      hasMore = upstreamHasMore;

      if (!upstreamHasMore || parsedNextCursor === null || parsedNextCursor <= currentCursor) {
        nextCursor = undefined;
        break;
      }

      nextCursor = parsedNextCursor;
      currentCursor = parsedNextCursor;
    }

    const tracks = [...ranked.values()]
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return left.tieBreak.localeCompare(right.tieBreak);
      })
      .slice(0, limit)
      .map((item) => item.track);

    return {
      tracks,
      hasMore: hasMore && typeof nextCursor === "number",
      nextCursor,
      partial,
    };
  }

  public async search(args: SearchQuery): Promise<SearchPage> {
    const query = args.query.trim().toLowerCase();
    const limit = Math.max(1, args.limit || this.maxResults);
    const cursor = args.cursor ?? 0;

    if (isLikelyTikTokUrlQuery(query)) {
      const url = normalizeTikTokUrl(query);
      const parsed = await this.fetchTrack(url);
      return {
        tracks: parsed ? [parsed] : [],
        hasMore: false,
      };
    }

    try {
      return await this.runSearch(query, limit, cursor, true);
    } catch (error) {
      if (this.authCookie && error instanceof AuthSessionError) {
        return this.runSearch(query, limit, cursor, false);
      }
      throw error;
    }
  }
}
