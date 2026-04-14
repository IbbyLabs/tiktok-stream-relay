import { DebridAdapter, DebridRouteResult } from "./types.js";

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
        console.log(
          `debrid route failed: provider=${adapter.provider} class=${message}`,
        );
      }
    }

    return null;
  }
}
