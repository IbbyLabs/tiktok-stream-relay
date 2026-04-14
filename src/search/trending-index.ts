import fs from "node:fs";
import path from "node:path";
import { NormalizedTrack } from "../types.js";

export class TrendingIndex {
  private readonly configPath: string;
  private items: NormalizedTrack[];

  public constructor(configPath: string) {
    this.configPath = path.resolve(configPath);
    this.items = [];
    this.reload();
  }

  public reload(): void {
    const fullPath = this.configPath;
    if (!fs.existsSync(fullPath)) {
      this.items = [];
      return;
    }
    try {
      const raw = fs.readFileSync(fullPath, "utf-8");
      const parsed = JSON.parse(raw) as NormalizedTrack[];
      this.items = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.items = [];
    }
  }

  public search(query: string): NormalizedTrack[] {
    const q = query.trim().toLowerCase();
    if (!q || q === "trending") {
      return this.items.slice(0, 20);
    }
    return this.items.filter((item) => {
      return (
        item.title.toLowerCase().includes(q) ||
        item.artist.toLowerCase().includes(q)
      );
    });
  }
}
