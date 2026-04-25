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
    <meta name="color-scheme" content="dark" />
    <title>IbbyLabs TikTok Stream Relay</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link rel="preload" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&family=Figtree:wght@400;500;600&display=swap" as="style" />
    <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&family=Figtree:wght@400;500;600&display=swap" rel="stylesheet" />
    <style>
      :root {
        --bg: oklch(9% 0.012 240);
        --surface: oklch(15% 0.016 240);
        --surface-raised: oklch(19% 0.02 240);
        --border: oklch(26% 0.018 240);
        --border-subtle: oklch(20% 0.015 240);
        --border-focus: oklch(60% 0.14 235);
        --text: oklch(93% 0.006 240);
        --muted: oklch(57% 0.018 240);
        --label: oklch(70% 0.015 240);
        --accent: oklch(53% 0.12 235);
        --accent-hover: oklch(58% 0.12 235);
        --good: oklch(72% 0.15 145);
        --font-display: "Bricolage Grotesque", "Arial Black", sans-serif;
        --font-ui: "Figtree", "Helvetica Neue", sans-serif;
        --space-xs: 4px;
        --space-sm: 8px;
        --space-md: 16px;
        --space-lg: 24px;
        --space-xl: 40px;
        --space-2xl: 64px;
        --radius-sm: 6px;
        --radius-md: 10px;
      }
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        min-height: 100dvh;
        background: var(--bg);
        color: var(--text);
        font-family: var(--font-ui);
        font-size: 0.9375rem;
        line-height: 1.5;
        padding: var(--space-xl) var(--space-md) var(--space-2xl);
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      .shell {
        width: 100%;
        max-width: 520px;
        display: flex;
        flex-direction: column;
        gap: var(--space-xl);
      }
      .page-header {
        display: flex;
        align-items: center;
        gap: var(--space-md);
        padding-bottom: var(--space-lg);
        border-bottom: 1px solid var(--border-subtle);
      }
      .brand-icon {
        width: 34px;
        height: 34px;
        border-radius: var(--radius-sm);
        object-fit: contain;
        flex-shrink: 0;
        background: var(--surface);
      }
      .brand-name {
        font-family: var(--font-display);
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--text);
        letter-spacing: -0.01em;
      }
      .brand-sub {
        font-size: 0.8125rem;
        color: var(--muted);
        margin-top: 2px;
      }
      .setup-panel {
        display: flex;
        flex-direction: column;
        gap: var(--space-lg);
      }
      .setup-header h1 {
        font-family: var(--font-display);
        font-size: 1.5rem;
        font-weight: 700;
        letter-spacing: -0.025em;
        color: var(--text);
        line-height: 1.2;
        margin-bottom: var(--space-sm);
      }
      .setup-header p {
        font-size: 0.875rem;
        color: var(--muted);
        line-height: 1.65;
        max-width: 56ch;
      }
      .section-divider {
        height: 1px;
        background: var(--border-subtle);
      }
      .config-form,
      .manifest-section {
        display: flex;
        flex-direction: column;
        gap: var(--space-md);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: var(--space-xs);
      }
      .field-label {
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--label);
        letter-spacing: 0.05em;
        text-transform: uppercase;
        transition: color 0.15s ease;
      }
      .field:focus-within .field-label {
        color: var(--border-focus);
      }
      input {
        width: 100%;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        color: var(--text);
        font-family: var(--font-ui);
        font-size: 0.9375rem;
        padding: 10px var(--space-md);
        min-height: 44px;
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
        appearance: none;
      }
      input::placeholder {
        color: oklch(58% 0.014 240);
      }
      input:focus {
        outline: none;
        border-color: var(--border-focus);
        box-shadow: 0 0 0 3px oklch(53% 0.12 235 / 0.22);
      }
      input[readonly] {
        color: var(--muted);
        cursor: default;
      }
      .input-row {
        position: relative;
        display: flex;
        align-items: center;
      }
      .input-row input {
        padding-right: 44px;
      }
      .btn-reveal {
        position: absolute;
        right: 0;
        top: 50%;
        transform: translateY(-50%);
        width: 44px;
        height: 44px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: none;
        border: none;
        cursor: pointer;
        color: var(--muted);
        border-radius: 0 var(--radius-md) var(--radius-md) 0;
        transition: color 0.15s ease;
        padding: 0;
      }
      .btn-reveal:hover {
        color: var(--label);
      }
      .btn-reveal:focus-visible {
        outline: 2px solid var(--border-focus);
        outline-offset: -2px;
        border-radius: var(--radius-md);
      }
      .btn-reveal svg {
        width: 16px;
        height: 16px;
        pointer-events: none;
      }
      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 10px var(--space-md);
        border-radius: var(--radius-md);
        font-family: var(--font-ui);
        font-size: 0.875rem;
        font-weight: 600;
        cursor: pointer;
        border: 1px solid var(--border);
        background: var(--surface-raised);
        color: var(--text);
        transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, opacity 0.15s ease, transform 0.1s ease;
        white-space: nowrap;
        min-height: 44px;
      }
      .btn:hover:not(:disabled) {
        background: oklch(21% 0.02 240);
        border-color: oklch(34% 0.022 240);
      }
      .btn:focus-visible {
        outline: 2px solid var(--border-focus);
        outline-offset: 2px;
      }
      .btn:active:not(:disabled) {
        transform: translateY(1px);
        opacity: 0.85;
      }
      .btn:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }
      [hidden] { display: none !important; }
      .btn-primary {
        background: var(--accent);
        border-color: var(--accent);
        color: var(--bg);
      }
      .btn-primary:hover:not(:disabled) {
        background: var(--accent-hover);
        border-color: var(--accent-hover);
      }
      .btn-ghost {
        background: transparent;
        border-color: transparent;
        color: var(--muted);
      }
      .btn-ghost:hover:not(:disabled) {
        background: var(--surface);
        border-color: var(--border-subtle);
        color: var(--label);
      }
      .btn-ghost.is-confirming {
        color: var(--text);
        border-color: var(--border);
        background: var(--surface);
      }
      .form-actions,
      .manifest-actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-sm);
      }
      .status {
        font-size: 0.8125rem;
        color: var(--muted);
        min-height: 1.25rem;
      }
      .good {
        color: var(--good);
      }
      .page-footer {
        padding-top: var(--space-lg);
        border-top: 1px solid var(--border-subtle);
      }
      .support-links {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-xs) var(--space-md);
      }
      .support-label {
        font-size: 0.6875rem;
        font-weight: 600;
        color: oklch(55% 0.014 240);
        text-transform: uppercase;
        letter-spacing: 0.07em;
      }
      .support-link {
        font-size: 0.8125rem;
        color: var(--muted);
        text-decoration: none;
        transition: color 0.15s ease;
      }
      .support-link:hover {
        color: var(--text);
      }
      .support-link:focus-visible {
        outline: 2px solid var(--border-focus);
        outline-offset: 2px;
        border-radius: 2px;
      }
      .support-sep {
        color: oklch(38% 0.014 240);
        user-select: none;
        font-size: 0.75rem;
      }
      @media (max-width: 540px) {
        body {
          padding: var(--space-lg) var(--space-md) var(--space-xl);
        }
        .setup-header h1 {
          font-size: 1.3rem;
        }
        .form-actions,
        .manifest-actions {
          flex-direction: column;
        }
        .btn {
          width: 100%;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
          transition-duration: 0.01ms !important;
          animation-duration: 0.01ms !important;
          animation-iteration-count: 1 !important;
        }
      }
      @keyframes slide-up {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes manifest-flash {
        0% { border-color: var(--border); }
        45% { border-color: var(--border-focus); }
        100% { border-color: var(--border); }
      }
      @media (prefers-reduced-motion: no-preference) {
        .page-header {
          animation: slide-up 0.4s cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        .setup-panel {
          animation: slide-up 0.4s cubic-bezier(0.16, 1, 0.3, 1) 80ms both;
        }
        .page-footer {
          animation: slide-up 0.4s cubic-bezier(0.16, 1, 0.3, 1) 160ms both;
        }
        #statusText {
          transition: opacity 0.15s ease;
        }
        .manifest-section.is-filled #manifestUrl {
          animation: manifest-flash 0.7s ease both;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <header class="page-header">
        <img class="brand-icon" src="https://ibbylabs.dev/favicon.svg" alt="IbbyLabs" fetchpriority="low" width="34" height="34" />
        <div>
          <p class="brand-name">TikTok Stream Relay</p>
          <p class="brand-sub">by IbbyLabs &middot; for Eclipse</p>
        </div>
      </header>

      <section class="setup-panel">
        <div class="setup-header">
          <h1>Get your Manifest URL</h1>
          <p>Enter your Torbox API Key, generate a link, and copy the Manifest URL into Eclipse.</p>
        </div>

        <div class="section-divider" aria-hidden="true"></div>

        <form id="config-form" class="config-form">
          <div class="field">
            <label for="torboxToken" class="field-label">Torbox API Key</label>
            <div class="input-row">
              <input id="torboxToken" type="password" placeholder="" autocomplete="current-password" autocorrect="off" autocapitalize="none" spellcheck="false" />
              <button class="btn-reveal" id="revealToken" type="button" aria-label="Show API key" aria-pressed="false">
                <svg id="iconShow" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
                <svg id="iconHide" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:none"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
              </button>
            </div>
          </div>
          <div class="form-actions">
            <button class="btn btn-primary" type="submit">Generate Link</button>
            <button class="btn btn-ghost" id="clearSavedKey" type="button" hidden>Clear Saved Key</button>
          </div>
        </form>

        <div class="section-divider" aria-hidden="true"></div>

        <div class="manifest-section">
          <label class="field">
            <span class="field-label">Manifest URL</span>
            <input id="manifestUrl" placeholder="Your Manifest URL will appear here" readonly />
          </label>
          <div class="manifest-actions">
            <button class="btn" id="copyManifest" type="button" disabled>Copy Manifest URL</button>
            <button class="btn" id="openManifest" type="button" disabled>Open Manifest</button>
          </div>
          <p class="status" id="statusText" role="status">Enter your Torbox API Key above to get started.</p>
        </div>
      </section>

      <footer class="page-footer">
        <nav class="support-links" aria-label="Resources">
          <span class="support-label">Links</span>
          <a class="support-link" href="https://eclipsemusic.app" target="_blank" rel="noopener noreferrer">Eclipse</a>
          <span class="support-sep" aria-hidden="true">&middot;</span>
          <a class="support-link" href="https://discord.gg/yKM74spK3Q" target="_blank" rel="noopener noreferrer">Discord</a>
          <span class="support-sep" aria-hidden="true">&middot;</span>
          <a class="support-link" href="https://github.com/IbbyLabs/tiktok-stream-relay" target="_blank" rel="noopener noreferrer">GitHub</a>
          <span class="support-sep" aria-hidden="true">&middot;</span>
          <a class="support-link" href="https://kofi.ibbylabs.dev" target="_blank" rel="noopener noreferrer">Support me</a>
          <span class="support-sep" aria-hidden="true">&middot;</span>
          <a class="support-link" href="https://uptime.ibbylabs.dev" target="_blank" rel="noopener noreferrer">Uptime</a>
        </nav>
      </footer>
    </main>
    <script>
      const form = document.getElementById("config-form");
      const byId = (id) => document.getElementById(id);
      const statusText = byId("statusText");
      const copyManifest = byId("copyManifest");
      const openManifest = byId("openManifest");
      const manifestUrl = byId("manifestUrl");
      const torboxTokenInput = byId("torboxToken");
      const revealToken = byId("revealToken");
      const iconShow = byId("iconShow");
      const iconHide = byId("iconHide");
      const clearSavedKey = byId("clearSavedKey");
      const torboxStorageKey = "tiktokEclipseTorboxToken";

      const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      let statusTimer = null;
      const setStatus = (message, isGood = false, linkText = null, linkHref = null) => {
        const render = () => {
          statusText.textContent = message;
          statusText.classList.toggle("good", isGood);
          if (linkText && linkHref) {
            const a = document.createElement("a");
            a.href = linkHref;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.textContent = linkText;
            a.style.cssText = "color:inherit;text-decoration:underline;text-underline-offset:2px;margin-left:4px;";
            statusText.appendChild(a);
          }
        };
        if (prefersReducedMotion) {
          render();
          return;
        }
        clearTimeout(statusTimer);
        statusText.style.opacity = "0";
        statusTimer = setTimeout(() => {
          render();
          statusText.style.opacity = "1";
        }, 150);
      };

      const setManifestState = (url) => {
        manifestUrl.value = url;
        const hasUrl = url.length > 0;
        copyManifest.disabled = !hasUrl;
        openManifest.disabled = !hasUrl;
        const section = manifestUrl.closest(".manifest-section");
        if (section) {
          section.classList.remove("is-filled");
          if (hasUrl) {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                section.classList.add("is-filled");
              });
            });
          }
        }
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
          clearSavedKey.hidden = false;
          setStatus("Saved key loaded.", true);
        } catch {
          setStatus("Could not read saved key in this browser.");
        }
      };

      setManifestState("");
      restoreTokenFromStorage();

      revealToken.addEventListener("click", () => {
        const isShowing = torboxTokenInput.type === "text";
        torboxTokenInput.type = isShowing ? "password" : "text";
        revealToken.setAttribute("aria-pressed", String(!isShowing));
        revealToken.setAttribute("aria-label", isShowing ? "Show API key" : "Hide API key");
        iconShow.style.display = isShowing ? "" : "none";
        iconHide.style.display = isShowing ? "none" : "";
      });

      torboxTokenInput.addEventListener("input", () => {
        const trimmed = torboxTokenInput.value.trim();
        saveTokenToStorage(trimmed);
        clearSavedKey.hidden = !trimmed;
      });

      clearSavedKey.addEventListener("click", () => {
        if (clearSavedKey.dataset.confirm !== "1") {
          clearSavedKey.dataset.confirm = "1";
          clearSavedKey.textContent = "Confirm Clear";
          clearSavedKey.classList.add("is-confirming");
          setTimeout(() => {
            if (clearSavedKey.dataset.confirm === "1") {
              clearSavedKey.dataset.confirm = "0";
              clearSavedKey.textContent = "Clear Saved Key";
              clearSavedKey.classList.remove("is-confirming");
            }
          }, 3000);
          return;
        }
        clearSavedKey.dataset.confirm = "0";
        clearSavedKey.textContent = "Clear Saved Key";
        clearSavedKey.classList.remove("is-confirming");
        clearSavedKey.hidden = true;
        saveTokenToStorage("");
        torboxTokenInput.value = "";
        setStatus("Key cleared.");
        setManifestState("");
      });

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const token = torboxTokenInput.value.trim();
        if (!token) {
          setStatus("Enter your API Key to continue.");
          setManifestState("");
          return;
        }

        saveTokenToStorage(token);

        const submitBtn = form.querySelector('[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.textContent = "Generating...";
        setStatus("Generating your link...");

        try {
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
              ? ["That key wasn't accepted.", false, "Open Torbox", "https://app.torbox.app/settings/api"]
              : errorCode === "unsafe_config_missing_debrid_tokens"
                ? ["Enter your API Key to continue.", false, null, null]
                : ["Could not generate a link. Try again.", false, null, null];
            setStatus(friendly[0], friendly[1], friendly[2], friendly[3]);
            setManifestState("");
            return;
          }

          const addonUrl = data && typeof data.addonUrl === "string" ? data.addonUrl : "";
          const absoluteManifest = addonUrl.startsWith("http")
            ? addonUrl
            : window.location.origin + addonUrl;
          setManifestState(absoluteManifest);
          setStatus("Done. Copy the Manifest URL into Eclipse.", true);
        } finally {
          submitBtn.disabled = false;
          submitBtn.textContent = "Generate Link";
        }
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
          setStatus("Copied. Paste the URL into Eclipse.", true);
        } catch {
          manifestUrl.focus();
          manifestUrl.select();
          setStatus("Copy failed. Select the URL and use Ctrl+C / Cmd+C.");
        }
      });

      manifestUrl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && manifestUrl.value) {
          copyManifest.click();
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