const SUPPORTED_HOSTS = new Set([
  "tiktok.com",
  "www.tiktok.com",
  "m.tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
]);

export function isTikTokHost(host: string): boolean {
  return SUPPORTED_HOSTS.has(host.toLowerCase());
}

export function normalizeTikTokUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error("Malformed URL");
  }

  if (!isTikTokHost(parsed.host)) {
    throw new Error("Unsupported host");
  }

  parsed.hash = "";
  return parsed.toString();
}

export function isLikelyTikTokUrlQuery(query: string): boolean {
  if (!query) {
    return false;
  }
  try {
    const parsed = new URL(query.trim());
    return isTikTokHost(parsed.host);
  } catch {
    return false;
  }
}
