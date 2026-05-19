import { DiskCache } from "../cache/disk-cache.js";
import { MemoryCache } from "../cache/memory-cache.js";
import { NormalizedTrack, SearchPage, SearchQuery } from "../types.js";
import { TrendingIndex } from "./trending-index.js";

interface SearchProvider {
  search(args: SearchQuery): Promise<SearchPage>;
}

export class SearchService {
  private readonly memoryCache: MemoryCache<SearchPage>;
  private readonly diskCache: DiskCache<SearchPage>;
  private readonly provider: SearchProvider;
  private readonly trending: TrendingIndex;
  private readonly defaultLimit: number;

  public constructor(args: {
    memoryCache: MemoryCache<SearchPage>;
    diskCache: DiskCache<SearchPage>;
    provider: SearchProvider;
    trending: TrendingIndex;
    defaultLimit: number;
  }) {
    this.memoryCache = args.memoryCache;
    this.diskCache = args.diskCache;
    this.provider = args.provider;
    this.trending = args.trending;
    this.defaultLimit = args.defaultLimit;
  }

  public async search(query: string): Promise<NormalizedTrack[]> {
    const page = await this.searchPage({ query, limit: this.defaultLimit });
    return page.tracks;
  }

  public async searchPage(args: SearchQuery): Promise<SearchPage> {
    const query = args.query;
    const cacheKey = query.trim().toLowerCase();
    const trendingOnly = cacheKey === "trending";
    const firstPage = !args.cursor;
    const cacheEligible = firstPage && args.limit === this.defaultLimit;

    if (trendingOnly) {
      const trending = this.trending.search(cacheKey).slice(0, args.limit);
      if (trending.length === 0) {
        console.warn(`search trending empty: query=${cacheKey}`);
      }
      if (cacheEligible && trending.length > 0) {
        const page: SearchPage = { tracks: trending, hasMore: false };
        this.memoryCache.set(cacheKey, page);
        this.diskCache.set(cacheKey, page);
      }
      return { tracks: trending, hasMore: false };
    }

    if (cacheEligible) {
      const memoryHit = this.memoryCache.get(cacheKey);
      if (memoryHit) {
        console.log(`cache hit (memory): ${cacheKey} -> ${memoryHit.tracks.length}`);
        return memoryHit;
      }

      const diskHit = this.diskCache.get(cacheKey);
      if (diskHit) {
        console.log(`cache hit (disk): ${cacheKey} -> ${diskHit.tracks.length}`);
        this.memoryCache.set(cacheKey, diskHit);
        return diskHit;
      }
    }

    try {
      const parsed = await this.provider.search({
        query: cacheKey,
        limit: args.limit,
        cursor: args.cursor,
      });
      if (cacheEligible && parsed.tracks.length > 0) {
        this.memoryCache.set(cacheKey, parsed);
        this.diskCache.set(cacheKey, parsed);
      }
      if (parsed.tracks.length > 0) {
        return parsed;
      }

      const trending = this.trending.search(cacheKey).slice(0, args.limit);
      console.warn(
        `search provider empty: query=${cacheKey} providerTracks=0 trendingTracks=${trending.length}`,
      );
      return { tracks: trending, hasMore: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      console.warn(`search provider failed: query=${cacheKey} class=${message}`);
      if (cacheEligible) {
        const stale = this.diskCache.getStale(cacheKey);
        if (stale) {
          console.warn(
            `search stale fallback: query=${cacheKey} tracks=${stale.tracks.length}`,
          );
          return stale;
        }
      }

      const fallback = this.trending.search(cacheKey).slice(0, args.limit);
      console.warn(
        `search trending fallback: query=${cacheKey} tracks=${fallback.length}`,
      );
      return { tracks: fallback, hasMore: false };
    }
  }
}
