import { createClient, type RedisClientType } from "redis";

export interface RateCounter {
  count: number;
  resetAt: number;
}

export interface RateLimitBackend {
  increment(key: string, windowMs: number): Promise<RateCounter>;
  getPenalty(ip: string): Promise<number>;
  incrementPenalty(ip: string): Promise<number>;
  name(): string;
}

interface CounterState {
  count: number;
  resetAt: number;
}

export class MemoryRateLimitBackend implements RateLimitBackend {
  private readonly counters = new Map<string, CounterState>();
  private readonly penalties = new Map<string, number>();

  public async increment(key: string, windowMs: number): Promise<RateCounter> {
    const now = Date.now();
    const current = this.counters.get(key);
    if (!current || current.resetAt <= now) {
      const next = { count: 1, resetAt: now + windowMs };
      this.counters.set(key, next);
      return next;
    }

    current.count += 1;
    return { count: current.count, resetAt: current.resetAt };
  }

  public async getPenalty(ip: string): Promise<number> {
    return this.penalties.get(ip) ?? 0;
  }

  public async incrementPenalty(ip: string): Promise<number> {
    const next = (this.penalties.get(ip) ?? 0) + 1;
    this.penalties.set(ip, next);
    return next;
  }

  public name(): string {
    return "memory";
  }
}

export class RedisRateLimitBackend implements RateLimitBackend {
  private readonly client: RedisClientType;
  private readonly fallback: MemoryRateLimitBackend;
  private readonly strict: boolean;
  private readonly connectTimeoutMs: number;
  private connectPromise: Promise<unknown> | null = null;
  private retryAfter = 0;

  public constructor(
    url: string,
    fallback?: MemoryRateLimitBackend,
    strict = false,
    client?: RedisClientType,
    connectTimeoutMs = 1000,
  ) {
    this.client = client ?? createClient({ url });
    this.fallback = fallback ?? new MemoryRateLimitBackend();
    this.strict = strict;
    this.connectTimeoutMs = connectTimeoutMs;
    this.client.on("error", () => {
      return;
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.isOpen) {
      return;
    }
    if (Date.now() < this.retryAfter) {
      throw new Error("redis_rate_backend_unavailable");
    }
    if (!this.connectPromise) {
      this.connectPromise = this.client.connect().catch((error) => {
        this.connectPromise = null;
        this.retryAfter = Date.now() + this.connectTimeoutMs;
        throw error;
      });
    }

    try {
      await Promise.race([
        this.connectPromise,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("redis_rate_backend_unavailable")), this.connectTimeoutMs);
        }),
      ]);
    } catch (error) {
      this.connectPromise = null;
      this.retryAfter = Date.now() + this.connectTimeoutMs;
      throw error;
    }
  }

  public async increment(key: string, windowMs: number): Promise<RateCounter> {
    try {
      await this.ensureConnected();
      const counterKey = `rate:${key}`;
      const count = await this.client.incr(counterKey);
      if (count === 1) {
        await this.client.pExpire(counterKey, windowMs);
      }
      const ttl = await this.client.pTTL(counterKey);
      const ttlMs = ttl > 0 ? ttl : windowMs;
      return { count, resetAt: Date.now() + ttlMs };
    } catch {
      if (this.strict) {
        throw new Error("redis_rate_backend_unavailable");
      }
      return this.fallback.increment(key, windowMs);
    }
  }

  public async getPenalty(ip: string): Promise<number> {
    try {
      await this.ensureConnected();
      const raw = await this.client.get(`penalty:${ip}`);
      const parsed = Number(raw ?? "0");
      return Number.isFinite(parsed) ? parsed : 0;
    } catch {
      if (this.strict) {
        throw new Error("redis_rate_backend_unavailable");
      }
      return this.fallback.getPenalty(ip);
    }
  }

  public async incrementPenalty(ip: string): Promise<number> {
    try {
      await this.ensureConnected();
      const key = `penalty:${ip}`;
      const count = await this.client.incr(key);
      if (count === 1) {
        await this.client.expire(key, 24 * 60 * 60);
      }
      return count;
    } catch {
      if (this.strict) {
        throw new Error("redis_rate_backend_unavailable");
      }
      return this.fallback.incrementPenalty(ip);
    }
  }

  public name(): string {
    return "redis";
  }
}
