import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

interface RuntimeSecrets {
  addonCryptoSecret: string;
  addonLinkSigningKeys: string;
}

function generateSecrets(): RuntimeSecrets {
  return {
    addonCryptoSecret: crypto.randomBytes(32).toString("hex"),
    addonLinkSigningKeys: `v1:${crypto.randomBytes(32).toString("hex")}`,
  };
}

export function loadOrCreateRuntimeSecrets(rootDir: string): RuntimeSecrets {
  const filePath = path.join(rootDir, "config", "runtime-secrets.json");

  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const created = generateSecrets();
    fs.writeFileSync(filePath, JSON.stringify(created), "utf8");
    return created;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<RuntimeSecrets>;

  if (
    typeof parsed.addonCryptoSecret !== "string" ||
    parsed.addonCryptoSecret.length < 24 ||
    typeof parsed.addonLinkSigningKeys !== "string" ||
    !parsed.addonLinkSigningKeys.startsWith("v1:")
  ) {
    throw new Error("invalid_runtime_secrets_file");
  }

  return {
    addonCryptoSecret: parsed.addonCryptoSecret,
    addonLinkSigningKeys: parsed.addonLinkSigningKeys,
  };
}
