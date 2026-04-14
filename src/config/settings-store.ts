import fs from "node:fs";
import path from "node:path";

export interface DebridSettings {
  debridEnabled: boolean;
  torboxToken?: string;
}

function isValidToken(token: string): boolean {
  return token.trim().length >= 8;
}

export class SettingsStore {
  private readonly filePath: string;

  public constructor(
    rootDir: string,
    defaults?: {
      debridEnabled?: boolean;
      torboxToken?: string;
    },
  ) {
    this.filePath = path.join(rootDir, "config", "settings.json");
    if (!fs.existsSync(this.filePath)) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const initial: DebridSettings = {
        debridEnabled: defaults?.debridEnabled ?? true,
        torboxToken: defaults?.torboxToken,
      };
      fs.writeFileSync(this.filePath, JSON.stringify(initial), "utf-8");
    }
  }

  public get(): DebridSettings {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as DebridSettings;
      return {
        debridEnabled:
          typeof parsed.debridEnabled === "boolean"
            ? parsed.debridEnabled
            : true,
        torboxToken: parsed.torboxToken,
      };
    } catch {
      return { debridEnabled: true };
    }
  }

  public save(next: Partial<DebridSettings>): DebridSettings {
    const current = this.get();
    const merged: DebridSettings = {
      debridEnabled:
        typeof next.debridEnabled === "boolean"
          ? next.debridEnabled
          : current.debridEnabled,
      torboxToken: next.torboxToken ?? current.torboxToken,
    };

    if (merged.torboxToken && !isValidToken(merged.torboxToken)) {
      throw new Error("invalid_torbox_token");
    }

    fs.writeFileSync(this.filePath, JSON.stringify(merged), "utf-8");
    return merged;
  }
}
