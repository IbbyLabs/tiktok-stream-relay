import fs from "node:fs";
import { NormalizedTrack } from "../types.js";

interface RefreshProvider {
  search(query: string): Promise<NormalizedTrack[]>;
}

export async function refreshTrendingSounds(args: {
  provider: RefreshProvider;
  seedQueries: string[];
  maxItems: number;
  outputPath: string;
}): Promise<NormalizedTrack[]> {
  const tracks = new Map<string, NormalizedTrack>();
  let lastError: unknown = null;

  for (const query of args.seedQueries) {
    let results: NormalizedTrack[];
    try {
      results = await args.provider.search(query);
    } catch (error) {
      lastError = error;
      continue;
    }
    for (const track of results) {
      tracks.set(track.id, track);
      if (tracks.size >= args.maxItems) {
        break;
      }
    }
    if (tracks.size >= args.maxItems) {
      break;
    }
  }

  if (tracks.size === 0 && lastError) {
    throw lastError;
  }

  const nextTracks = [...tracks.values()].slice(0, args.maxItems);
  fs.writeFileSync(
    args.outputPath,
    `${JSON.stringify(nextTracks, null, 2)}\n`,
    "utf-8",
  );
  return nextTracks;
}