import crypto from "node:crypto";

interface LinkTokenPayload {
  linkId: string;
  exp: number;
  v: string;
}

interface SigningKey {
  version: string;
  key: string;
}

function parseSigningKeys(raw: string): SigningKey[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [version, key] = item.split(":");
      if (!version || !key) {
        throw new Error("invalid_addon_link_signing_keys");
      }
      return { version: version.trim(), key: key.trim() };
    });
}

function sign(input: string, key: string): string {
  return crypto.createHmac("sha256", key).update(input).digest("base64url");
}

export class LinkTokenService {
  private readonly keys: SigningKey[];
  private readonly ttlSeconds: number;

  public constructor(signingKeys: string, ttlSeconds: number) {
    this.keys = parseSigningKeys(signingKeys);
    this.ttlSeconds = Math.max(60, ttlSeconds);
  }

  public issue(linkId: string): string {
    const active = this.keys[0];
    const payload: LinkTokenPayload = {
      linkId,
      v: active.version,
      exp: Math.floor(Date.now() / 1000) + this.ttlSeconds,
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = sign(encoded, active.key);
    return `${encoded}.${signature}`;
  }

  public verify(token: string): LinkTokenPayload {
    const [encoded, signature] = token.split(".");
    if (!encoded || !signature) {
      throw new Error("invalid_addon_link_token");
    }

    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as LinkTokenPayload;
    if (!payload.linkId || !payload.v || typeof payload.exp !== "number") {
      throw new Error("invalid_addon_link_token");
    }

    const key = this.keys.find((item) => item.version === payload.v);
    if (!key) {
      throw new Error("unsupported_addon_link_token_version");
    }

    const expected = sign(encoded, key.key);
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      throw new Error("invalid_addon_link_signature");
    }

    if (payload.exp < Math.floor(Date.now() / 1000)) {
      throw new Error("expired_addon_link_token");
    }

    return payload;
  }
}
