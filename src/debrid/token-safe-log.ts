export function maskToken(token: string): string {
  if (!token) {
    return "<empty>";
  }
  if (token.length <= 8) {
    return "<redacted>";
  }
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}
