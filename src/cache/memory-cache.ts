interface MemoryEntry<T> {
  value: T;
  expiresAt: number;
}

export class MemoryCache<T> {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly map = new Map<string, MemoryEntry<T>>();

  public constructor(ttlMs: number, maxEntries = 100) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  public get(key: string): T | null {
    const entry = this.map.get(key);
    if (!entry) {
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return null;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  public set(key: string, value: T): void {
    if (this.map.size >= this.maxEntries && !this.map.has(key)) {
      const firstKey = this.map.keys().next().value;
      if (firstKey) {
        this.map.delete(firstKey);
      }
    }
    this.map.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  public delete(key: string): void {
    this.map.delete(key);
  }

  public clear(): void {
    this.map.clear();
  }

  public size(): number {
    return this.map.size;
  }

  public approximateSizeBytes(): number {
    let bytes = 0;
    for (const [key, entry] of this.map.entries()) {
      bytes += Buffer.byteLength(key, "utf-8");
      bytes += Buffer.byteLength(JSON.stringify(entry.value), "utf-8");
      bytes += 16;
    }
    return bytes;
  }
}
