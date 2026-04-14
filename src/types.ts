export interface NormalizedTrack {
  id: string;
  title: string;
  artist: string;
  duration: number;
  artworkURL: string;
  streamURL: string;
  playbackURL?: string;
}

export interface SearchPage {
  tracks: NormalizedTrack[];
  hasMore: boolean;
  nextCursor?: number;
  partial?: boolean;
}

export interface SearchQuery {
  query: string;
  limit: number;
  cursor?: number;
}

export interface SearchResponse {
  tracks: Array<{
    id: string;
    title: string;
    artist: string;
    duration: number;
    artworkURL: string;
    streamURL?: string;
    format?: string;
  }>;
  hasMore?: boolean;
  nextCursor?: string;
  partial?: boolean;
}
