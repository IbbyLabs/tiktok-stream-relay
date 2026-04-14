import express, { type Express } from "express";
import path from "node:path";
import { AddonConfigInput } from "./addon/types.js";
import { applyConfigDefaults, validateConfigSafety } from "./addon/config-policy.js";
import { DiskCache } from "./cache/disk-cache.js";
import { MemoryCache } from "./cache/memory-cache.js";
import { StreamCache } from "./cache/stream-cache.js";
import { HttpError } from "./errors/http-error.js";
import { redactSecret } from "./security/redaction.js";
import { type NormalizedTrack, type SearchPage } from "./types.js";

interface SearchServiceLike {
  search(query: string): Promise<NormalizedTrack[]>;
  searchPage(args: {
    query: string;
    limit: number;
    cursor?: number;
  }): Promise<SearchPage>;
}

interface StreamServiceLike {
  resolve(args: {
    sourceUrl: string;
    format?: "mp3" | "aac" | "flac";
    torboxToken?: string;
    signal?: AbortSignal;
  }): Promise<
    | { type: "url"; url: string; provider: "torbox" }
    | { type: "file"; filePath: string }
  >;
}

interface SettingsStoreLike {
  get(): {
    debridEnabled: boolean;
    torboxToken?: string;
  };
  save(args: {
    debridEnabled?: boolean;
    torboxToken?: string;
  }): {
    debridEnabled: boolean;
    torboxToken?: string;
  };
}

interface AppConfigLike {
  debridEnabled: boolean;
  streamCacheMaxBytes: number;
  liveSearchMaxResults: number;
  searchMaxLimit: number;
}

interface LinkIdentityLike {
  linkId: string;
  status: "active" | "superseded" | "revoked";
  activeRevisionId: number;
  revisions: Array<{ revisionId: number; createdAt: string }>;
  supersededByLinkId?: string;
}

interface AddonLinkStoreLike {
  create(configInput: AddonConfigInput, ip?: string): LinkIdentityLike;
  update(linkId: string, configInput: AddonConfigInput, ip?: string): LinkIdentityLike;
  rotate(linkId: string, ip?: string): LinkIdentityLike;
  revoke(linkId: string, ip?: string): LinkIdentityLike;
  rollback(linkId: string, revisionId: number, ip?: string): LinkIdentityLike;
  get(linkId: string): LinkIdentityLike | undefined;
  getActiveConfig(linkId: string): {
    debridEnabled: boolean;
    torboxToken?: string;
  };
  listEvents(limit?: number): Array<{
    eventId: string;
    timestamp: string;
    action: string;
    linkId?: string;
    ip?: string;
    reason?: string;
  }>;
}

interface LinkTokenServiceLike {
  issue(linkId: string): string;
  verify(token: string): { linkId: string };
}

interface PublicSafetyLike {
  middleware: (
    request: express.Request,
    response: express.Response,
    next: express.NextFunction,
  ) => void | Promise<void>;
  metrics(): { throttled: number; denied: number };
}

interface SecurityEventLogLike {
  record(action: string, reason?: string): void;
  recent(limit?: number): Array<{ action: string; timestamp: string; reason?: string }>;
  countersSnapshot(): Record<string, number>;
}

interface SearchCursorPayload {
  q: string;
  c: number;
  l: number;
}

function encodeTrackId(sourceUrl: string): string {
  return Buffer.from(sourceUrl, "utf-8").toString("base64url");
}

function decodeTrackId(trackId: string): string | null {
  try {
    const sourceUrl = Buffer.from(trackId, "base64url").toString("utf-8");
    return sourceUrl.startsWith("http://") || sourceUrl.startsWith("https://") ? sourceUrl : null;
  } catch {
    return null;
  }
}

function contentTypeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".aac" ? "audio/aac" : ext === ".flac" ? "audio/flac" : "audio/mpeg";
}

function encodeSearchCursor(query: string, cursor: number, limit: number): string {
  const payload: SearchCursorPayload = { q: query, c: cursor, l: limit };
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

function decodeSearchCursor(
  cursor: string,
  query: string,
  limit: number,
): number {
  let parsed: SearchCursorPayload;

  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as SearchCursorPayload;
  } catch {
    throw new HttpError(400, "invalid_cursor");
  }

  if (
    typeof parsed.q !== "string" ||
    typeof parsed.c !== "number" ||
    !Number.isInteger(parsed.c) ||
    parsed.c < 0 ||
    typeof parsed.l !== "number" ||
    parsed.l !== limit ||
    parsed.q !== query
  ) {
    throw new HttpError(400, "invalid_cursor");
  }

  return parsed.c;
}

function parseSearchLimit(raw: unknown, fallback: number, max: number): number {
  if (typeof raw !== "string" || raw.trim() === "") {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new HttpError(400, "invalid_limit");
  }

  return Math.min(Math.floor(parsed), max);
}

function parseConfigInput(body: unknown): AddonConfigInput {
  const payload = (body ?? {}) as AddonConfigInput;
  return {
    debridEnabled:
      typeof payload.debridEnabled === "boolean"
        ? payload.debridEnabled
        : undefined,
    torboxToken:
      typeof payload.torboxToken === "string" ? payload.torboxToken : undefined,
  };
}

function getClientIp(request: express.Request): string {
  return request.ip || request.socket.remoteAddress || "unknown";
}

function toLinkResponse(link: LinkIdentityLike, token: string): {
  linkId: string;
  status: "active" | "superseded" | "revoked";
  activeRevisionId: number;
  availableRevisions: number[];
  supersededByLinkId?: string;
  addonUrl: string;
  addonToken: string;
} {
  return {
    linkId: link.linkId,
    status: link.status,
    activeRevisionId: link.activeRevisionId,
    availableRevisions: link.revisions.map((item) => item.revisionId),
    supersededByLinkId: link.supersededByLinkId,
    addonUrl: `/addon/${encodeURIComponent(token)}/manifest.json`,
    addonToken: token,
  };
}

function readAddonToken(request: express.Request): string | undefined {
  const paramToken = request.params.addonToken;
  if (typeof paramToken === "string") {
    return paramToken;
  }
  if (Array.isArray(paramToken) && typeof paramToken[0] === "string") {
    return paramToken[0];
  }
  if (typeof request.header("x-addon-link-token") === "string") {
    return request.header("x-addon-link-token");
  }
  if (typeof request.query.addonToken === "string") {
    return request.query.addonToken;
  }
  const cookieHeader = request.header("cookie");
  if (typeof cookieHeader === "string") {
    const entries = cookieHeader.split(";");
    for (const entry of entries) {
      const trimmed = entry.trim();
      if (!trimmed.startsWith("addonToken=")) {
        continue;
      }
      const rawValue = trimmed.slice("addonToken=".length);
      try {
        return decodeURIComponent(rawValue);
      } catch {
        return rawValue;
      }
    }
  }
  return undefined;
}

function readAdminToken(request: express.Request): string | undefined {
  if (typeof request.header("x-admin-token") === "string") {
    return request.header("x-admin-token");
  }
  return undefined;
}

function mapAddonTokenError(message: string): HttpError {
  if (message === "link_revoked" || message === "link_superseded") {
    return new HttpError(401, message);
  }
  if (
    message === "invalid_addon_link_token" ||
    message === "unsupported_addon_link_token_version" ||
    message === "invalid_addon_link_signature" ||
    message === "expired_addon_link_token"
  ) {
    return new HttpError(401, message);
  }
  if (message === "link_not_found") {
    return new HttpError(404, message);
  }
  return new HttpError(401, "invalid_addon_link_token");
}

export function createApp(args: {
  manifestPath: string;
  config: AppConfigLike;
  settingsStore: SettingsStoreLike;
  searchService: SearchServiceLike;
  streamService: StreamServiceLike;
  memoryCache: MemoryCache<SearchPage>;
  diskCache: DiskCache<SearchPage>;
  streamCache: StreamCache;
  addonLinkStore?: AddonLinkStoreLike;
  linkTokenService?: LinkTokenServiceLike;
  publicSafety?: PublicSafetyLike;
  securityEventLog?: SecurityEventLogLike;
  adminTelemetryToken?: string;
}): Express {
  const app = express();
  const hasAddonServices = Boolean(args.addonLinkStore && args.linkTokenService);

  app.use((request, response, next) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    response.setHeader(
      "access-control-allow-headers",
      "content-type,x-addon-link-token,x-admin-token",
    );
    if (request.method === "OPTIONS") {
      response.sendStatus(204);
      return;
    }
    next();
  });

  app.use(express.json());

  if (args.publicSafety) {
    app.use(args.publicSafety.middleware);
  }

  function requireLifecycleAuth(request: express.Request, linkId: string): void {
    if (!args.linkTokenService) {
      throw new HttpError(503, "lifecycle_auth_unavailable");
    }

    const token = readAddonToken(request);
    if (!token) {
      throw new HttpError(401, "addon_token_required");
    }

    let verified: { linkId: string };
    try {
      verified = args.linkTokenService.verify(token);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid_addon_link_token";
      throw mapAddonTokenError(message);
    }

    if (verified.linkId !== linkId) {
      throw new HttpError(403, "addon_token_mismatch");
    }
  }

  function requireTelemetryAccess(request: express.Request): void {
    if (!args.adminTelemetryToken) {
      throw new HttpError(503, "telemetry_access_unconfigured");
    }
    if (readAdminToken(request) !== args.adminTelemetryToken) {
      throw new HttpError(401, "admin_token_required");
    }
  }

  app.get("/", (request, response) => {
    const accepts = request.header("accept") ?? "";
    if (accepts.includes("text/html")) {
      response.redirect(302, "/configure");
      return;
    }

    response.json({
      name: "IbbyLabs TikTok Stream Relay",
      health: "/health",
      manifest: "/manifest.json",
    });
  });

  app.get("/health", (_request, response) => {
    response.json({
      status: "ok",
      service: "tiktok-stream-relay",
    });
  });

  const sendManifest = (response: express.Response): void => {
    response.sendFile(args.manifestPath);
  };

  const verifyAddonTokenForManifest = (
    response: express.Response,
    addonToken: string,
  ): boolean => {
    if (!args.linkTokenService) {
      response.status(503).json({ error: "addon_token_verification_unavailable" });
      return false;
    }
    try {
      args.linkTokenService.verify(addonToken);
      response.setHeader(
        "set-cookie",
        `addonToken=${encodeURIComponent(addonToken)}; Path=/; HttpOnly; SameSite=Lax`,
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid_addon_link_token";
      const mapped = mapAddonTokenError(message);
      response.status(mapped.statusCode).json({ error: mapped.message });
      return false;
    }
  };

  app.get("/manifest.json", (request, response) => {
    if (typeof request.query.addonToken === "string") {
      const verified = verifyAddonTokenForManifest(response, request.query.addonToken);
      if (!verified) {
        return;
      }
    }
    sendManifest(response);
  });

  app.get("/addon/:addonToken/manifest.json", (request, response) => {
    const addonToken = readAddonToken(request);
    if (!addonToken) {
      response.status(401).json({ error: "addon_token_required" });
      return;
    }
    const verified = verifyAddonTokenForManifest(response, addonToken);
    if (!verified) {
      return;
    }
    sendManifest(response);
  });

  app.get("/configure", (_request, response) => {
    if (!hasAddonServices) {
      response.status(404).json({ error: "config_portal_unavailable" });
      return;
    }

    response.setHeader("content-type", "text/html; charset=utf-8");
    response.status(200).send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>IbbyLabs TikTok Stream Relay</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;700&display=swap" rel="stylesheet" />
    <style>
      :root {
        --bg: #06050f;
        --card: #110f24;
        --line: #2a2550;
        --text: #ece9ff;
        --muted: #b3a9d6;
        --accent: #af74ff;
        --accent-dark: #21183f;
        --good: #45d483;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        color: var(--text);
        font-family: "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at 24% -10%, #2c2257 0, transparent 38%),
          radial-gradient(circle at 100% 5%, #1f193f 0, transparent 30%),
          linear-gradient(180deg, #06050f 0%, #0b0819 100%);
        padding: 1.25rem 0.9rem 2rem;
      }
      .shell {
        width: min(640px, 100%);
        margin: 0 auto;
      }
      .card {
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 1rem;
        background: linear-gradient(180deg, #151133 0%, #100d24 100%);
        box-shadow: 0 20px 42px rgba(0, 0, 0, 0.45);
      }
      .hero {
        border: 1px solid #382e6a;
        border-radius: 12px;
        padding: 0.85rem;
        background: linear-gradient(180deg, #18133a 0%, #120f2a 100%);
        margin-bottom: 0.8rem;
      }
      .brand-head {
        display: flex;
        align-items: center;
        gap: 0.55rem;
        margin-bottom: 0.55rem;
      }
      .brand-mark {
        width: 32px;
        height: 32px;
        border-radius: 8px;
        border: 1px solid #4a3a87;
        box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
        object-fit: contain;
        background: #140f30;
        padding: 2px;
      }
      .brand-name {
        margin: 0;
        font-size: 0.79rem;
        font-weight: 700;
        color: #daccff;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }
      .eyebrow {
        display: inline-block;
        margin: 0;
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #d0c2ff;
      }
      h1 {
        margin: 0;
        font-size: 1.45rem;
        font-weight: 700;
      }
      .lead {
        margin: 0.35rem 0 1rem;
        color: var(--muted);
        font-size: 0.92rem;
      }
      .quick-links {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
      }
      .quick-link {
        --quick-top: #334564;
        --quick-bottom: #17233c;
        --quick-border: #90a3cf;
        --quick-text: #f7f9ff;
        --quick-shadow: rgba(14, 21, 42, 0.44);
        --quick-icon-bg: rgba(255, 255, 255, 0.14);
        --quick-icon-border: rgba(255, 255, 255, 0.12);
        --quick-hover-border: #d2ddff;
        --quick-hover-shadow: rgba(35, 51, 98, 0.34);
        --quick-outline: #d2ddff;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.35rem;
        position: relative;
        overflow: hidden;
        border: 1px solid var(--quick-border);
        border-radius: 999px;
        background: linear-gradient(180deg, var(--quick-top) 0%, var(--quick-bottom) 100%);
        color: var(--quick-text);
        padding: 0.5rem 0.82rem;
        font-size: 0.8rem;
        font-weight: 700;
        letter-spacing: 0.03em;
        text-decoration: none;
        box-shadow: 0 14px 30px var(--quick-shadow), inset 0 1px 0 rgba(255, 255, 255, 0.1);
        transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease, background .18s ease;
      }
      .quick-link::before {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(135deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0));
        pointer-events: none;
      }
      .quick-link span {
        position: relative;
        z-index: 1;
      }
      .quick-link-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.32rem;
        height: 1.32rem;
        padding: 0.14rem;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.24);
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16);
        flex: 0 0 auto;
        overflow: hidden;
      }
      .quick-link-icon svg {
        width: 100%;
        height: 100%;
        display: block;
        fill: currentColor;
      }
      .quick-link-icon img {
        width: 100%;
        height: 100%;
        display: block;
        object-fit: contain;
      }
      .quick-link-eclipse .quick-link-icon img {
        transform: scale(1.14);
      }
      .quick-link-repo {
        --quick-top: #3a4b68;
        --quick-bottom: #182236;
        --quick-border: #99abd0;
        --quick-shadow: rgba(18, 29, 55, 0.46);
        --quick-hover-border: #e1e8ff;
        --quick-hover-shadow: rgba(41, 59, 106, 0.34);
        --quick-outline: #d5defd;
      }
      .quick-link-eclipse {
        --quick-top: #dce7ff;
        --quick-bottom: #94b6ff;
        --quick-border: #f2f6ff;
        --quick-text: #102445;
        --quick-shadow: rgba(78, 121, 224, 0.3);
        --quick-hover-border: #ffffff;
        --quick-hover-shadow: rgba(92, 132, 230, 0.4);
        --quick-outline: #d7e5ff;
      }
      .quick-link-discord {
        --quick-top: #cfd3ff;
        --quick-bottom: #7f8cff;
        --quick-border: #eef0ff;
        --quick-text: #1f2455;
        --quick-shadow: rgba(88, 102, 242, 0.32);
        --quick-hover-border: #ffffff;
        --quick-hover-shadow: rgba(88, 102, 242, 0.42);
        --quick-outline: #d8ddff;
      }
      .quick-link-support {
        --quick-top: #bcfff4;
        --quick-bottom: #5dc9ff;
        --quick-border: #e2fffb;
        --quick-text: #07293f;
        --quick-shadow: rgba(41, 169, 213, 0.38);
        --quick-hover-border: #ffffff;
        --quick-hover-shadow: rgba(52, 174, 236, 0.46);
        --quick-outline: #bffff7;
      }
      .quick-link-uptime {
        --quick-top: #b8ffd7;
        --quick-bottom: #42c39a;
        --quick-border: #ddffea;
        --quick-text: #07281c;
        --quick-shadow: rgba(39, 159, 112, 0.34);
        --quick-hover-border: #f3fff8;
        --quick-hover-shadow: rgba(45, 177, 132, 0.42);
        --quick-outline: #cbffe1;
      }
      .quick-link:hover {
        border-color: var(--quick-hover-border);
        box-shadow: 0 18px 34px var(--quick-hover-shadow), inset 0 1px 0 rgba(255, 255, 255, 0.14);
        transform: translateY(-2px) scale(1.01);
      }
      .quick-link:focus-visible {
        outline: 2px solid var(--quick-outline);
        outline-offset: 2px;
      }
      .brand-line {
        margin: 0;
        font-size: 0.78rem;
        color: #a99ed0;
      }
      .grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 0.8rem;
      }
      .stack {
        display: grid;
        gap: 0.65rem;
      }
      .pane {
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 0.85rem;
        background: rgba(255, 255, 255, 0.015);
      }
      label {
        display: grid;
        gap: 0.3rem;
        font-size: 0.88rem;
        font-weight: 500;
        color: #d5ccf3;
      }
      input {
        width: 100%;
        border: 1px solid #3a3267;
        border-radius: 9px;
        background: #0d0a1f;
        color: var(--text);
        padding: 0.58rem 0.68rem;
        font-size: 0.9rem;
      }
      input:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 2px rgba(175, 116, 255, 0.22);
      }
      .check {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        font-weight: 600;
      }
      .check input {
        width: auto;
        margin: 0;
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        gap: 0.45rem;
      }
      button {
        border: 1px solid #3a3266;
        border-radius: 10px;
        background: #181333;
        color: #e5ddff;
        padding: 0.5rem 0.84rem;
        font-weight: 700;
        cursor: pointer;
        transition: background .18s ease, border-color .18s ease;
      }
      button:hover {
        border-color: #5b4f9b;
        background: #21184b;
      }
      .primary {
        background: var(--accent);
        color: #1a1333;
        border-color: var(--accent);
      }
      .small {
        margin: 0;
        font-size: 0.83rem;
        color: var(--muted);
      }
      .manifest-row {
        display: grid;
        gap: 0.45rem;
      }
      .manifest-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.45rem;
      }
      .status {
        margin: 0;
        min-height: 1.1rem;
        font-size: 0.83rem;
        color: var(--muted);
      }
      .good {
        color: var(--good);
      }
      button:disabled {
        cursor: not-allowed;
        opacity: 0.45;
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="card">
        <section class="hero">
          <div class="brand-head">
            <img class="brand-mark" src="https://ibbylabs.dev/favicon.svg" alt="IbbyLabs" />
            <p class="brand-name">IbbyLabs TikTok Stream Relay</p>
          </div>
          <p class="eyebrow">TikTok Stream Relay for Eclipse</p>
          <h1>Find TikTok Audio in Eclipse</h1>
          <p class="lead">Generate your Manifest URL to enable TikTok audio discovery and playback inside Eclipse.</p>
          <div class="quick-links">
            <a class="quick-link quick-link-eclipse" href="https://eclipsemusic.app" target="_blank" rel="noopener noreferrer"><span class="quick-link-icon" aria-hidden="true"><img src="https://eclipsemusic.app/configure/icon" alt="" /></span><span>Visit Eclipse</span></a>
            <a class="quick-link quick-link-discord" href="https://discord.gg/yKM74spK3Q" target="_blank" rel="noopener noreferrer"><span class="quick-link-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M20.317 4.369A19.791 19.791 0 0 0 15.885 3c-.191.328-.403.77-.553 1.116a18.27 18.27 0 0 0-6.664 0A12.64 12.64 0 0 0 8.114 3a19.736 19.736 0 0 0-4.432 1.369C.883 8.58.127 12.686.505 16.735a19.9 19.9 0 0 0 5.993 3.03 14.24 14.24 0 0 0 1.284-2.11 12.925 12.925 0 0 1-2.021-.973c.17-.124.336-.255.496-.389a14.097 14.097 0 0 0 11.486 0c.161.134.327.265.497.389-.645.379-1.323.704-2.022.973.37.75.8 1.456 1.284 2.11a19.873 19.873 0 0 0 5.993-3.03c.444-4.696-.759-8.765-3.178-12.366ZM9.813 14.248c-1.181 0-2.149-1.085-2.149-2.419s.95-2.418 2.149-2.418c1.2 0 2.168 1.093 2.149 2.418 0 1.334-.95 2.419-2.149 2.419Zm4.374 0c-1.181 0-2.149-1.085-2.149-2.419s.95-2.418 2.149-2.418c1.2 0 2.168 1.093 2.149 2.418 0 1.334-.949 2.419-2.149 2.419Z"/></svg></span><span>Eclipse Discord</span></a>
            <a class="quick-link quick-link-repo" href="https://github.com/IbbyLabs/tiktok-stream-relay" target="_blank" rel="noopener noreferrer"><span class="quick-link-icon" aria-hidden="true"><img src="https://github.githubassets.com/favicons/favicon.svg" alt="" /></span><span>View Repo</span></a>
            <a class="quick-link quick-link-support" href="https://kofi.ibbylabs.dev" target="_blank" rel="noopener noreferrer"><span class="quick-link-icon" aria-hidden="true"><img src="https://storage.ko-fi.com/cdn/logomarkLogo.png" alt="" /></span><span>Support Me</span></a>
            <a class="quick-link quick-link-uptime" href="https://uptime.ibbylabs.dev" target="_blank" rel="noopener noreferrer"><span class="quick-link-icon" aria-hidden="true"><img src="https://uptime.ibbylabs.dev/favicon.png" alt="" /></span><span>Uptime Tracker</span></a>
          </div>
        </section>

        <div class="grid">
          <section class="pane stack">
            <form id="config-form" class="stack">
              <label>Torbox API Key
                <input id="torboxToken" placeholder="Paste your Torbox API Key" />
              </label>
              <div class="row">
                <button class="primary" type="submit">Generate Link</button>
                <button id="clearSavedKey" type="button">Clear Saved Key</button>
              </div>
            </form>

            <div class="manifest-row">
              <label>Manifest URL
                <input id="manifestUrl" placeholder="Generate Link to fill this field" readonly />
              </label>
              <div class="manifest-actions">
                <button id="copyManifest" type="button" disabled>Copy Manifest URL</button>
                <button id="openManifest" type="button" disabled>Open Manifest</button>
              </div>
              <p class="status" id="statusText">Waiting for your Torbox API Key.</p>
              <p class="small">Paste Torbox API Key, click Generate Link, then copy Manifest URL into Eclipse.</p>
            </div>
          </section>
        </div>
      </section>
    </main>
    <script>
      const form = document.getElementById("config-form");
      const byId = (id) => document.getElementById(id);
      const statusText = byId("statusText");
      const copyManifest = byId("copyManifest");
      const openManifest = byId("openManifest");
      const manifestUrl = byId("manifestUrl");
      const torboxTokenInput = byId("torboxToken");
      const clearSavedKey = byId("clearSavedKey");
      const torboxStorageKey = "tiktokEclipseTorboxToken";

      const setStatus = (message, isGood = false) => {
        statusText.textContent = message;
        if (isGood) {
          statusText.classList.add("good");
          return;
        }
        statusText.classList.remove("good");
      };

      const setManifestState = (url) => {
        manifestUrl.value = url;
        const hasUrl = url.length > 0;
        copyManifest.disabled = !hasUrl;
        openManifest.disabled = !hasUrl;
      };

      const saveTokenToStorage = (token) => {
        try {
          if (!token) {
            localStorage.removeItem(torboxStorageKey);
            return;
          }
          localStorage.setItem(torboxStorageKey, token);
        } catch {
          setStatus("Could not save key in this browser.");
        }
      };

      const restoreTokenFromStorage = () => {
        try {
          const saved = localStorage.getItem(torboxStorageKey);
          if (!saved) {
            return;
          }
          torboxTokenInput.value = saved;
          setStatus("Saved Torbox API Key loaded.", true);
        } catch {
          setStatus("Could not read saved key in this browser.");
        }
      };

      setManifestState("");
      restoreTokenFromStorage();

      torboxTokenInput.addEventListener("input", () => {
        saveTokenToStorage(torboxTokenInput.value.trim());
      });

      clearSavedKey.addEventListener("click", () => {
        saveTokenToStorage("");
        torboxTokenInput.value = "";
        setStatus("Saved Torbox API Key cleared.");
        setManifestState("");
      });

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const token = torboxTokenInput.value.trim();
        if (!token) {
          setStatus("Torbox API Key is required.");
          setManifestState("");
          return;
        }

        saveTokenToStorage(token);

        setStatus("Generating link...");
        const res = await fetch("/api/config/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            debridEnabled: true,
            torboxToken: token,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          const errorCode = data && data.error ? String(data.error) : "";
          const friendly = errorCode === "invalid_torbox_token"
            ? "Torbox API Key looks invalid."
            : errorCode === "unsafe_config_missing_debrid_tokens"
              ? "Torbox API Key is required."
              : "Could not generate link.";
          setStatus(friendly);
          setManifestState("");
          return;
        }

        const addonUrl = data && typeof data.addonUrl === "string" ? data.addonUrl : "";
        const absoluteManifest = addonUrl.startsWith("http")
          ? addonUrl
          : window.location.origin + addonUrl;
        setManifestState(absoluteManifest);
        setStatus("Link ready. Copy your Manifest URL into Eclipse.", true);
      });

      copyManifest.addEventListener("click", async () => {
        if (!manifestUrl.value) {
          return;
        }
        try {
          if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(manifestUrl.value);
          } else {
            const textArea = document.createElement("textarea");
            textArea.value = manifestUrl.value;
            textArea.setAttribute("readonly", "");
            textArea.style.position = "absolute";
            textArea.style.left = "-9999px";
            document.body.appendChild(textArea);
            textArea.select();
            const copied = document.execCommand("copy");
            document.body.removeChild(textArea);
            if (!copied) {
              throw new Error("copy_failed");
            }
          }
          setStatus("Manifest URL copied. Paste it in Eclipse.", true);
        } catch {
          manifestUrl.focus();
          manifestUrl.select();
          setStatus("Copy failed. URL selected. Press Cmd+C to copy.");
        }
      });

      openManifest.addEventListener("click", () => {
        if (!manifestUrl.value) {
          return;
        }
        window.open(manifestUrl.value, "_blank", "noopener,noreferrer");
      });
    </script>
  </body>
</html>`);
  });

  app.post("/api/config/preview", (request, response) => {
    try {
      const effective = applyConfigDefaults(parseConfigInput(request.body));
      validateConfigSafety(effective);
      response.status(200).json({
        effective: {
          debridEnabled: effective.debridEnabled,
          torboxToken: redactSecret(effective.torboxToken),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid_config";
      response.status(400).json({ error: message });
    }
  });

  app.post("/api/config/create", (request, response) => {
    if (!args.addonLinkStore || !args.linkTokenService) {
      response.status(404).json({ error: "config_portal_unavailable" });
      return;
    }

    try {
      const link = args.addonLinkStore.create(parseConfigInput(request.body), getClientIp(request));
      const token = args.linkTokenService.issue(link.linkId);
      args.securityEventLog?.record("link_issued");
      response.status(201).json(toLinkResponse(link, token));
    } catch (error) {
      const message = error instanceof Error ? error.message : "config_create_failed";
      response.status(400).json({ error: message });
    }
  });

  app.post("/api/config/:linkId/update", (request, response) => {
    if (!args.addonLinkStore || !args.linkTokenService) {
      response.status(404).json({ error: "config_portal_unavailable" });
      return;
    }

    try {
      requireLifecycleAuth(request, request.params.linkId);
      const link = args.addonLinkStore.update(
        request.params.linkId,
        parseConfigInput(request.body),
        getClientIp(request),
      );
      const token = args.linkTokenService.issue(link.linkId);
      args.securityEventLog?.record("config_updated");
      response.status(200).json(toLinkResponse(link, token));
    } catch (error) {
      if (error instanceof HttpError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : "config_update_failed";
      response.status(400).json({ error: message });
    }
  });

  app.post("/api/config/:linkId/rotate", (request, response) => {
    if (!args.addonLinkStore || !args.linkTokenService) {
      response.status(404).json({ error: "config_portal_unavailable" });
      return;
    }

    try {
      requireLifecycleAuth(request, request.params.linkId);
      const link = args.addonLinkStore.rotate(request.params.linkId, getClientIp(request));
      const token = args.linkTokenService.issue(link.linkId);
      args.securityEventLog?.record("link_rotated");
      response.status(200).json(toLinkResponse(link, token));
    } catch (error) {
      if (error instanceof HttpError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : "link_rotate_failed";
      response.status(400).json({ error: message });
    }
  });

  app.post("/api/config/:linkId/revoke", (request, response) => {
    if (!args.addonLinkStore || !args.linkTokenService) {
      response.status(404).json({ error: "config_portal_unavailable" });
      return;
    }

    try {
      requireLifecycleAuth(request, request.params.linkId);
      const link = args.addonLinkStore.revoke(request.params.linkId, getClientIp(request));
      args.securityEventLog?.record("link_revoked");
      response.status(200).json({
        linkId: link.linkId,
        status: link.status,
      });
    } catch (error) {
      if (error instanceof HttpError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : "link_revoke_failed";
      response.status(400).json({ error: message });
    }
  });

  app.post("/api/config/:linkId/rollback", (request, response) => {
    if (!args.addonLinkStore || !args.linkTokenService) {
      response.status(404).json({ error: "config_portal_unavailable" });
      return;
    }

    try {
      requireLifecycleAuth(request, request.params.linkId);
      const revisionId = Number((request.body as { revisionId?: number })?.revisionId);
      if (!Number.isInteger(revisionId) || revisionId <= 0) {
        throw new Error("invalid_revision_id");
      }
      const link = args.addonLinkStore.rollback(
        request.params.linkId,
        revisionId,
        getClientIp(request),
      );
      const token = args.linkTokenService.issue(link.linkId);
      args.securityEventLog?.record("config_rolled_back");
      response.status(200).json(toLinkResponse(link, token));
    } catch (error) {
      if (error instanceof HttpError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : "config_rollback_failed";
      response.status(400).json({ error: message });
    }
  });

  app.get("/media/:fileName", (request, response) => {
    const filePath = args.streamCache.getPublicFilePath(request.params.fileName);
    if (!filePath) {
      response.status(404).json({ error: "file_not_found" });
      return;
    }
    response.setHeader("content-type", contentTypeForFile(filePath));
    response.sendFile(filePath);
  });

  const handleSearchRequest = async (
    request: express.Request,
    response: express.Response,
  ): Promise<void> => {
    try {
      const q = typeof request.query.q === "string" ? request.query.q : "";
      const normalizedQuery = q.trim().toLowerCase();
      if (!normalizedQuery) {
        response.status(200).json({ tracks: [], hasMore: false });
        return;
      }

      const limit = parseSearchLimit(
        request.query.limit,
        args.config.liveSearchMaxResults,
        args.config.searchMaxLimit,
      );
      const cursorParam = typeof request.query.cursor === "string" ? request.query.cursor : undefined;
      const cursor = cursorParam
        ? decodeSearchCursor(cursorParam, normalizedQuery, limit)
        : undefined;

      const refresh = request.query.refresh === "1" || request.query.refresh === "true";
      if (refresh) {
        args.memoryCache.delete(normalizedQuery);
        args.diskCache.delete(normalizedQuery);
      }

      const page = await args.searchService.searchPage({
        query: normalizedQuery,
        limit,
        cursor,
      });

      response.status(200).json({
        tracks: page.tracks.map((track) => ({
          id: encodeTrackId(track.streamURL),
          title: track.title,
          artist: track.artist,
          duration: track.duration,
          artworkURL: track.artworkURL,
          format: "mp3",
        })),
        hasMore: page.hasMore,
        nextCursor:
          page.hasMore && typeof page.nextCursor === "number"
            ? encodeSearchCursor(normalizedQuery, page.nextCursor, limit)
            : undefined,
        partial: page.partial ?? false,
      });
    } catch (error) {
      if (error instanceof HttpError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }

      response.status(500).json({ error: "search_failed" });
    }
  };

  app.get("/search", (request, response) => {
    void handleSearchRequest(request, response);
  });

  app.get("/addon/:addonToken/search", (request, response) => {
    void handleSearchRequest(request, response);
  });

  const handleStreamRequest = async (
    request: express.Request,
    response: express.Response,
  ): Promise<void> => {
    const routeTrackId =
      typeof request.params.id === "string"
        ? request.params.id
        : Array.isArray(request.params.id)
          ? request.params.id[0]
          : "";
    const sourceUrl =
      typeof request.query.url === "string" ? request.query.url : decodeTrackId(routeTrackId) ?? "";
    const format = typeof request.query.format === "string" ? request.query.format : "mp3";
    const savedSettings = args.settingsStore.get();
    const addonToken = readAddonToken(request);
    const headerTorboxToken =
      typeof request.header("x-torbox-token") === "string" ? request.header("x-torbox-token") : undefined;
    const abortController = new AbortController();

    request.on("close", () => {
      abortController.abort();
    });

    try {
      let tokenFromLink:
        | { debridEnabled: boolean; torboxToken?: string }
        | undefined;
      if (addonToken && args.addonLinkStore && args.linkTokenService) {
        try {
          const verified = args.linkTokenService.verify(addonToken);
          tokenFromLink = args.addonLinkStore.getActiveConfig(verified.linkId);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid_addon_link_token";
          throw mapAddonTokenError(message);
        }
      } else if (addonToken) {
        throw new HttpError(503, "addon_token_verification_unavailable");
      }

      const torboxToken = headerTorboxToken ?? tokenFromLink?.torboxToken ?? savedSettings.torboxToken;
      const debridEnabled =
        (tokenFromLink?.debridEnabled ?? savedSettings.debridEnabled) && args.config.debridEnabled;

      if (!sourceUrl) {
        throw new HttpError(400, "missing_source_url");
      }

      const resolved = await args.streamService.resolve({
        sourceUrl,
        format: "mp3",
        torboxToken: debridEnabled ? torboxToken : undefined,
        signal: abortController.signal,
      });

      if (resolved.type === "url") {
        response.setHeader("x-stream-provider", resolved.provider);
        args.securityEventLog?.record("stream_provider_routed", resolved.provider);
        response.status(200).json({
          url: resolved.url,
          format,
          provider: resolved.provider,
        });
        return;
      }

      const fileName = path.basename(resolved.filePath);
      const host = request.get("host");
      if (!host) {
        throw new HttpError(500, "missing_host_header");
      }
      response.status(200).json({
        url: `${request.protocol}://${host}/media/${encodeURIComponent(fileName)}`,
        format,
      });
      args.securityEventLog?.record("stream_local_fallback");
    } catch (error) {
      if (error instanceof HttpError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      response.status(500).json({ error: "stream_resolution_failed" });
    }
  };

  app.get("/stream/:id", (request, response) => {
    void handleStreamRequest(request, response);
  });

  app.get("/addon/:addonToken/stream/:id", (request, response) => {
    void handleStreamRequest(request, response);
  });

  app.get("/cache/stats", (_request, response) => {
    const searchDiskStats = args.diskCache.stats();
    const streamStats = args.streamCache.stats();
    const memoryEntries = args.memoryCache.size();
    const memorySizeBytes = args.memoryCache.approximateSizeBytes();

    response.status(200).json({
      memory_entries: memoryEntries,
      memory_size_mb: Number((memorySizeBytes / (1024 * 1024)).toFixed(2)),
      disk_entries: searchDiskStats.entries,
      disk_size_mb: Number((searchDiskStats.sizeBytes / (1024 * 1024)).toFixed(2)),
      stream_entries: streamStats.entries,
      stream_size_mb: Number((streamStats.sizeBytes / (1024 * 1024)).toFixed(2)),
    });
  });

  app.get("/public/metrics", (_request, response) => {
    try {
      requireTelemetryAccess(_request);
      response.status(200).json({
        rateLimits: args.publicSafety?.metrics() ?? { throttled: 0, denied: 0 },
        securityEvents: args.securityEventLog?.countersSnapshot() ?? {},
      });
    } catch (error) {
      if (error instanceof HttpError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      response.status(500).json({ error: "telemetry_access_failed" });
    }
  });

  app.get("/public/events", (request, response) => {
    try {
      requireTelemetryAccess(request);
      const limitRaw = Number(request.query.limit ?? 50);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 500) : 50;

      response.status(200).json({
        addonAudit: args.addonLinkStore?.listEvents(limit) ?? [],
        securityEvents: args.securityEventLog?.recent(limit) ?? [],
      });
    } catch (error) {
      if (error instanceof HttpError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      response.status(500).json({ error: "telemetry_access_failed" });
    }
  });

  app.get("/settings", (_request, response) => {
    const settings = args.settingsStore.get();
    response.status(200).json({
      debridEnabled: settings.debridEnabled,
      hasTorboxToken: Boolean(settings.torboxToken),
    });
  });

  app.post("/settings", (request, response) => {
    try {
      const body = request.body as {
        debridEnabled?: boolean;
        torboxToken?: string;
      };
      const previous = args.settingsStore.get();
      const next = args.settingsStore.save({
        debridEnabled: body.debridEnabled,
        torboxToken: body.torboxToken,
      });

      const tokenChanged = previous.torboxToken !== next.torboxToken;
      if (tokenChanged) {
        args.diskCache.clearAll();
        args.memoryCache.clear();
      }

      response.status(200).json({
        debridEnabled: next.debridEnabled,
        hasTorboxToken: Boolean(next.torboxToken),
        searchCacheCleared: tokenChanged,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid_settings";
      response.status(400).json({ error: message });
    }
  });

  return app;
}