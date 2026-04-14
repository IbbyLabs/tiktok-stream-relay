import { Request, Response, NextFunction } from "express";
import { MemoryRateLimitBackend, RateLimitBackend } from "./rate-limit-backend.js";

interface LimitBucket {
  windowMs: number;
  max: number;
}

export interface PublicSafetyConfig {
  portalEnabled: boolean;
  lifecycleEnabled: boolean;
  allowlist: string[];
  onEnforcement?: (action: "denied" | "throttled", reason: string) => void;
  backend?: RateLimitBackend;
}

function routeClass(pathname: string): "portal" | "lifecycle" | "stream" | "other" {
  if (pathname.startsWith("/configure") || pathname.startsWith("/api/config/preview")) {
    return "portal";
  }
  if (pathname.startsWith("/api/config/")) {
    return "lifecycle";
  }
  if (pathname.startsWith("/stream/")) {
    return "stream";
  }
  return "other";
}

const LIMITS: Record<string, LimitBucket> = {
  portal: { windowMs: 60_000, max: 30 },
  lifecycle: { windowMs: 60_000, max: 20 },
  stream: { windowMs: 60_000, max: 90 },
  other: { windowMs: 60_000, max: 120 },
};

export class PublicSafety {
  private readonly config: PublicSafetyConfig;
  private readonly backend: RateLimitBackend;
  private readonly metricsState = {
    throttled: 0,
    denied: 0,
  };

  public constructor(config: PublicSafetyConfig) {
    this.config = config;
    this.backend = config.backend ?? new MemoryRateLimitBackend();
  }

  public middleware = async (
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    const ip = request.ip || "unknown";
    if (this.config.allowlist.includes(ip)) {
      next();
      return;
    }

    const cls = routeClass(request.path);

    if (!this.config.portalEnabled && (cls === "portal" || cls === "lifecycle")) {
      this.metricsState.denied += 1;
      this.config.onEnforcement?.("denied", "public_portal_disabled");
      response.status(503).json({ error: "public_portal_disabled" });
      return;
    }

    if (!this.config.lifecycleEnabled && cls === "lifecycle") {
      this.metricsState.denied += 1;
      this.config.onEnforcement?.("denied", "lifecycle_disabled");
      response.status(503).json({ error: "lifecycle_disabled" });
      return;
    }

    try {
      const bucket = LIMITS[cls];
      const key = `${cls}:${ip}`;
      const counter = await this.backend.increment(key, bucket.windowMs);
      const penalty = Math.min(await this.backend.getPenalty(ip), 10);
      const effectiveMax = Math.max(3, bucket.max - penalty);

      if (counter.count > effectiveMax) {
        await this.backend.incrementPenalty(ip);
        this.metricsState.throttled += 1;
        this.config.onEnforcement?.("throttled", cls);
        response.setHeader(
          "retry-after",
          String(Math.ceil((counter.resetAt - Date.now()) / 1000)),
        );
        response
          .status(429)
          .json({ error: "rate_limited", policyTier: penalty > 3 ? "strict" : "default" });
        return;
      }

      next();
    } catch {
      this.metricsState.throttled += 1;
      this.config.onEnforcement?.("throttled", "limiter_backend_unavailable");
      response.status(503).json({ error: "rate_limiter_unavailable" });
    }
  };

  public metrics(): { throttled: number; denied: number } {
    return { ...this.metricsState };
  }
}
