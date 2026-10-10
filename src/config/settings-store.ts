import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../utils/json-file.js";

export interface DebridSettings {
  debridEnabled: boolean;
  torboxToken?: string;
}

function isValidToken(token: string): boolean {
  return token.trim().length >= 8;
}

export class SettingsStore {
  private readonly filePath: string;
  private lastGood: DebridSettings | undefined;

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
      writeJsonFileAtomic(this.filePath, initial);
    }
  }

  private load(): DebridSettings | undefined {
    const result = readJsonFile(this.filePath);
    if (result.status === "missing") {
      return { debridEnabled: true };
    }
    if (result.status === "ok" && result.value && typeof result.value === "object") {
      const parsed = result.value as Partial<DebridSettings>;
      const settings: DebridSettings = {
        debridEnabled:
          typeof parsed.debridEnabled === "boolean"
            ? parsed.debridEnabled
            : true,
        torboxToken: parsed.torboxToken,
      };
      this.lastGood = settings;
      return settings;
    }
    const reason = result.status === "unreadable" ? result.error.message : "not an object";
    console.error(`Failed to read the settings store, keeping the file untouched: path=${this.filePath} error=${reason}`);
    return undefined;
  }

  public get(): DebridSettings {
    return this.load() ?? this.lastGood ?? { debridEnabled: true };
  }

  public save(next: Partial<DebridSettings>): DebridSettings {
    const current = this.load();
    if (!current) {
      throw new Error("settings_store_unreadable");
    }
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

    writeJsonFileAtomic(this.filePath, merged);
    this.lastGood = merged;
    return merged;
  }
}
