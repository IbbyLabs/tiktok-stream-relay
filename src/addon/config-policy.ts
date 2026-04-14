import { AddonConfigEffective, AddonConfigInput } from "./types.js";

function isValidToken(token: string): boolean {
  return token.trim().length >= 8;
}

export function applyConfigDefaults(input: AddonConfigInput): AddonConfigEffective {
  return {
    debridEnabled: input.debridEnabled ?? true,
    torboxToken: input.torboxToken?.trim() || undefined,
  };
}

export function validateConfigSafety(config: AddonConfigEffective): void {
  if (config.torboxToken && !isValidToken(config.torboxToken)) {
    throw new Error("invalid_torbox_token");
  }

  if (config.debridEnabled && !config.torboxToken) {
    throw new Error("unsafe_config_missing_debrid_tokens");
  }
}
