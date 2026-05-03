export interface DebridRouteRequest {
  sourceUrl: string;
  token: string;
}

export interface DebridRouteResult {
  provider: "torbox";
  url: string;
  expiresAt?: number;
}

export interface DebridAdapter {
  provider: "torbox";
  route(request: DebridRouteRequest): Promise<DebridRouteResult>;
}
