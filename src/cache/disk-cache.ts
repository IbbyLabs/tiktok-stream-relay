import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

interface DiskEntry<T> {
  value: T;
  createdAt: number;
  expiresAt: number;
}

export class DiskCache<T> {
  private readonly ttlMs: number;
  private readonly baseDir: string;

  public constructor(baseDir: string, ttlMs: number) {
    this.baseDir = baseDir;
    this.ttlMs = ttlMs;
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  private filePathForKey(key: string): string {
    const hash = crypto.createHash("sha1").update(key).digest("hex");
    return path.join(this.baseDir, `${hash}.json`);
  }

  public get(key: string): T | null {
    const filePath = this.filePathForKey(key);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as DiskEntry<T>;
      if (typeof parsed.expiresAt !== "number") {
        fs.unlinkSync(filePath);
        return null;
      }
      if (Date.now() > parsed.expiresAt) {
        return null;
      }
      return parsed.value;
    } catch {
      fs.unlinkSync(filePath);
      return null;
    }
  }

  public getStale(key: string): T | null {
    const filePath = this.filePathForKey(key);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as DiskEntry<T>;
      return parsed.value;
    } catch {
      fs.unlinkSync(filePath);
      return null;
    }
  }

  public set(key: string, value: T): void {
    const filePath = this.filePathForKey(key);
    const now = Date.now();
    const payload: DiskEntry<T> = {
      value,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    fs.writeFileSync(filePath, JSON.stringify(payload), "utf-8");
  }

  public delete(key: string): void {
    const filePath = this.filePathForKey(key);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  public cleanupExpired(): number {
    const files = fs.readdirSync(this.baseDir).filter((name) => name.endsWith(".json"));
    let removed = 0;
    for (const file of files) {
      const fullPath = path.join(this.baseDir, file);
      try {
        const raw = fs.readFileSync(fullPath, "utf-8");
        const parsed = JSON.parse(raw) as DiskEntry<T>;
        if (Date.now() > parsed.expiresAt) {
          fs.unlinkSync(fullPath);
          removed += 1;
        }
      } catch {
        fs.unlinkSync(fullPath);
        removed += 1;
      }
    }
    return removed;
  }

  public clearAll(): number {
    const files = fs.readdirSync(this.baseDir).filter((name) => name.endsWith(".json"));
    for (const file of files) {
      fs.unlinkSync(path.join(this.baseDir, file));
    }
    return files.length;
  }

  public stats(): { entries: number; sizeBytes: number } {
    const files = fs.readdirSync(this.baseDir).filter((name) => name.endsWith(".json"));
    const sizeBytes = files.reduce((acc, file) => acc + fs.statSync(path.join(this.baseDir, file)).size, 0);
    return { entries: files.length, sizeBytes };
  }
}
