import { NormalizedTrack } from "../types.js";

interface AlbumIdPayload {
  artist: string;
  title: string;
}

interface ArtistIdPayload {
  artist: string;
}

interface PlaylistIdPayload {
  query: string;
}

interface AlbumGroup {
  id: string;
  title: string;
  artist: string;
  artworkURL: string;
  tracks: NormalizedTrack[];
}

interface ArtistGroup {
  id: string;
  name: string;
  artworkURL: string;
  tracks: NormalizedTrack[];
}

export interface CatalogAlbumSummary {
  id: string;
  title: string;
  artist: string;
  artworkURL: string;
  trackCount: number;
}

export interface CatalogArtistSummary {
  id: string;
  name: string;
  artworkURL: string;
}

export interface CatalogPlaylistSummary {
  id: string;
  title: string;
  creator: string;
  artworkURL?: string;
  trackCount: number;
}

export interface HybridCatalogSearchResult {
  albums: CatalogAlbumSummary[];
  artists: CatalogArtistSummary[];
  playlists: CatalogPlaylistSummary[];
}

function normalizeValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function encodePayload<T>(prefix: string, payload: T): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
  return `${prefix}${encoded}`;
}

function decodePayload<T>(prefix: string, id: string): T | null {
  if (!id.startsWith(prefix)) {
    return null;
  }

  const encoded = id.slice(prefix.length);
  if (!encoded) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8")) as T;
    return decoded;
  } catch {
    return null;
  }
}

function createAlbumId(artist: string, title: string): string {
  return encodePayload<AlbumIdPayload>("alb_", {
    artist: normalizeValue(artist),
    title: normalizeValue(title),
  });
}

function createArtistId(artist: string): string {
  return encodePayload<ArtistIdPayload>("art_", {
    artist: normalizeValue(artist),
  });
}

function createPlaylistId(query: string): string {
  return encodePayload<PlaylistIdPayload>("pl_", {
    query: normalizeValue(query),
  });
}

function buildAlbumGroups(tracks: NormalizedTrack[]): AlbumGroup[] {
  const grouped = new Map<string, AlbumGroup>();

  for (const track of tracks) {
    const title = track.title.trim();
    const artist = track.artist.trim();
    if (!title || !artist) {
      continue;
    }

    const normalizedTitle = normalizeValue(title);
    const normalizedArtist = normalizeValue(artist);
    const key = `${normalizedArtist}::${normalizedTitle}`;
    const existing = grouped.get(key);

    if (!existing) {
      grouped.set(key, {
        id: createAlbumId(artist, title),
        title,
        artist,
        artworkURL: track.artworkURL,
        tracks: [track],
      });
      continue;
    }

    existing.tracks.push(track);
    if (!existing.artworkURL && track.artworkURL) {
      existing.artworkURL = track.artworkURL;
    }
  }

  return [...grouped.values()].sort((left, right) => {
    if (right.tracks.length !== left.tracks.length) {
      return right.tracks.length - left.tracks.length;
    }
    return left.title.localeCompare(right.title);
  });
}

function buildArtistGroups(tracks: NormalizedTrack[]): ArtistGroup[] {
  const grouped = new Map<string, ArtistGroup>();

  for (const track of tracks) {
    const artist = track.artist.trim();
    if (!artist) {
      continue;
    }

    const key = normalizeValue(artist);
    const existing = grouped.get(key);

    if (!existing) {
      grouped.set(key, {
        id: createArtistId(artist),
        name: artist,
        artworkURL: track.artworkURL,
        tracks: [track],
      });
      continue;
    }

    existing.tracks.push(track);
    if (!existing.artworkURL && track.artworkURL) {
      existing.artworkURL = track.artworkURL;
    }
  }

  return [...grouped.values()].sort((left, right) => {
    if (right.tracks.length !== left.tracks.length) {
      return right.tracks.length - left.tracks.length;
    }
    return left.name.localeCompare(right.name);
  });
}

export function buildHybridCatalogSearchResult(
  query: string,
  tracks: NormalizedTrack[],
): HybridCatalogSearchResult {
  const albums = buildAlbumGroups(tracks).slice(0, 24).map((item) => ({
    id: item.id,
    title: item.title,
    artist: item.artist,
    artworkURL: item.artworkURL,
    trackCount: item.tracks.length,
  }));

  const artists = buildArtistGroups(tracks).slice(0, 24).map((item) => ({
    id: item.id,
    name: item.name,
    artworkURL: item.artworkURL,
  }));

  const normalizedQuery = normalizeValue(query);
  const playlists: CatalogPlaylistSummary[] = tracks.length
    ? [
        {
          id: createPlaylistId(normalizedQuery),
          title: normalizedQuery === "trending" ? "TikTok Trending" : `TikTok Mix: ${query.trim()}`,
          creator: "IbbyLabs",
          artworkURL: tracks[0]?.artworkURL,
          trackCount: tracks.length,
        },
      ]
    : [];

  return {
    albums,
    artists,
    playlists,
  };
}

export function decodeAlbumIdToQuery(id: string): string | null {
  const payload = decodePayload<AlbumIdPayload>("alb_", id);
  if (!payload?.artist || !payload?.title) {
    return null;
  }
  return `${payload.artist} ${payload.title}`.trim();
}

export function decodeArtistIdToQuery(id: string): string | null {
  const payload = decodePayload<ArtistIdPayload>("art_", id);
  if (!payload?.artist) {
    return null;
  }
  return payload.artist;
}

export function decodePlaylistIdToQuery(id: string): string | null {
  const payload = decodePayload<PlaylistIdPayload>("pl_", id);
  if (!payload?.query) {
    return null;
  }
  return payload.query;
}

export function findAlbumGroupById(
  id: string,
  tracks: NormalizedTrack[],
): AlbumGroup | null {
  const groups = buildAlbumGroups(tracks);
  const match = groups.find((item) => item.id === id);
  return match ?? null;
}

export function findArtistGroupById(
  id: string,
  tracks: NormalizedTrack[],
): ArtistGroup | null {
  const groups = buildArtistGroups(tracks);
  const match = groups.find((item) => item.id === id);
  return match ?? null;
}
