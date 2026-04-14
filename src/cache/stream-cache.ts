import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

interface StreamEntry {
  key: string;
  filePath: string;
  createdAt: number;
  expiresAt: number;
}

interface StreamMetadata {
  entries: StreamEntry[];
}

export class StreamCache {
  private readonly audioDir: string;
  private readonly metadataPath: string;
  private readonly cacheVersion: string;

  public constructor(baseDir: string, cacheVersion = "dev") {
    this.audioDir = path.join(baseDir, "audio");
    this.metadataPath = path.join(baseDir, "stream-cache.json");
    this.cacheVersion = cacheVersion;
    fs.mkdirSync(this.audioDir, { recursive: true });
    if (!fs.existsSync(this.metadataPath)) {
      this.writeMetadata({ entries: [] });
    }
  }

  private readMetadata(): StreamMetadata {
    try {
      const raw = fs.readFileSync(this.metadataPath, "utf-8");
      const parsed = JSON.parse(raw) as StreamMetadata;
      if (!Array.isArray(parsed.entries)) {
        this.writeMetadata({ entries: [] });
        return { entries: [] };
      }
      return parsed;
    } catch {
      this.writeMetadata({ entries: [] });
      return { entries: [] };
    }
  }

  private writeMetadata(metadata: StreamMetadata): void {
    fs.writeFileSync(this.metadataPath, JSON.stringify(metadata), "utf-8");
  }

  public keyFromUrl(sourceUrl: string, format = "mp3"): string {
    return crypto
      .createHash("sha1")
      .update(`${this.cacheVersion}:${sourceUrl}:${format}`)
      .digest("hex");
  }

  public getValidFilePath(key: string): string | null {
    const metadata = this.readMetadata();
    const entry = metadata.entries.find((item) => item.key === key);
    if (!entry) {
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      return null;
    }
    if (!fs.existsSync(entry.filePath)) {
      this.remove(key);
      return null;
    }
    return entry.filePath;
  }

  public createOutputPath(key: string, format = "mp3"): string {
    return path.join(this.audioDir, `${key}.${format}`);
  }

  public getPublicFilePath(fileName: string): string | null {
    const normalized = path.basename(fileName);
    if (normalized !== fileName) {
      return null;
    }
    const filePath = path.join(this.audioDir, normalized);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return filePath;
  }

  public set(key: string, filePath: string, ttlMs: number): void {
    const metadata = this.readMetadata();
    const now = Date.now();
    const nextEntry: StreamEntry = {
      key,
      filePath,
      createdAt: now,
      expiresAt: now + ttlMs,
    };
    const rest = metadata.entries.filter((entry) => entry.key !== key);
    this.writeMetadata({ entries: [...rest, nextEntry] });
  }

  public remove(key: string): void {
    const metadata = this.readMetadata();
    const target = metadata.entries.find((entry) => entry.key === key);
    if (target && fs.existsSync(target.filePath)) {
      fs.unlinkSync(target.filePath);
    }
    this.writeMetadata({ entries: metadata.entries.filter((entry) => entry.key !== key) });
  }

  public cleanup(maxBytes: number): { removed: number; sizeBytes: number } {
    const metadata = this.readMetadata();
    const now = Date.now();
    let entries = metadata.entries.filter((entry) => {
      if (now > entry.expiresAt || !fs.existsSync(entry.filePath)) {
        if (fs.existsSync(entry.filePath)) {
          fs.unlinkSync(entry.filePath);
        }
        return false;
      }
      return true;
    });

    const withSize = entries
      .map((entry) => ({ entry, size: fs.statSync(entry.filePath).size }))
      .sort((a, b) => a.entry.createdAt - b.entry.createdAt);

    let totalSize = withSize.reduce((acc, item) => acc + item.size, 0);
    let removed = metadata.entries.length - entries.length;

    for (const item of withSize) {
      if (totalSize <= maxBytes) {
        break;
      }
      if (fs.existsSync(item.entry.filePath)) {
        fs.unlinkSync(item.entry.filePath);
      }
      entries = entries.filter((entry) => entry.key !== item.entry.key);
      totalSize -= item.size;
      removed += 1;
    }

    this.writeMetadata({ entries });
    return { removed, sizeBytes: totalSize };
  }

  public stats(): { entries: number; sizeBytes: number } {
    const metadata = this.readMetadata();
    const existing = metadata.entries.filter((entry) => fs.existsSync(entry.filePath));
    const sizeBytes = existing.reduce((acc, entry) => acc + fs.statSync(entry.filePath).size, 0);
    return {
      entries: existing.length,
      sizeBytes,
    };
  }
}
