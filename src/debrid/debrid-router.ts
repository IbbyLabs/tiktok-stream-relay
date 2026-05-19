import { DebridAdapter, DebridRouteResult } from "./types.js";

function classifyDebridError(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes("timeout")) {
    return "timeout";
  }
  if (normalized.includes("http_401") || normalized.includes("http_403")) {
    return "auth";
  }
  if (
    normalized.includes("http_429") ||
    normalized.includes("rate") ||
    normalized.includes("throttle")
  ) {
    return "throttle";
  }
  if (normalized.includes("invalid") || normalized.includes("missing")) {
    return "invalid_response";
  }
  return "unknown";
}

export class DebridRouter {
  private readonly adapters: DebridAdapter[];
  private readonly timeoutMs: number;

  public constructor(adapters: DebridAdapter[], timeoutMs = 7000) {
    this.adapters = adapters;
    this.timeoutMs = timeoutMs;
  }

  public async tryRoute(
    sourceUrl: string,
    tokenMap: Partial<Record<"torbox", string>>,
  ): Promise<DebridRouteResult | null> {
    for (const adapter of this.adapters) {
      const token = tokenMap[adapter.provider];
      if (!token) {
        continue;
      }

      try {
        const result = await Promise.race([
          adapter.route({ sourceUrl, token }),
          new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error("debrid_timeout")),
              this.timeoutMs,
            );
          }),
        ]);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown";
        const reason = classifyDebridError(message);
        console.log(
          `debrid route failed: provider=${adapter.provider} reason=${reason} class=${message}`,
        );
      }
    }

    return null;
  }
}
