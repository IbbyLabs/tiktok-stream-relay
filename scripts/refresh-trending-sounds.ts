import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppConfig } from "../src/config/app-config.js";
import { IbbyLabsParserProvider } from "../src/search/providers/ibbylabs-parser-provider.js";
import { refreshTrendingSounds } from "../src/search/trending-refresh.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const config = loadAppConfig(rootDir);
const provider = new IbbyLabsParserProvider(config.liveSearchMaxResults);
const outputPath = path.join(rootDir, "config", "trending-sounds.json");

async function main(): Promise<void> {
  const nextTracks = await refreshTrendingSounds({
    provider: {
      search: async (query: string) => {
        const page = await provider.search({
          query,
          limit: config.liveSearchMaxResults,
        });
        return page.tracks;
      },
    },
    seedQueries: config.trendingSeedQueries,
    maxItems: config.trendingMaxItems,
    outputPath,
  });
  console.log(`refreshed trending sounds: ${nextTracks.length} items -> ${outputPath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
