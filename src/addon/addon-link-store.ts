import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CryptoBox } from "../security/crypto-box.js";
import { applyConfigDefaults, validateConfigSafety } from "./config-policy.js";
import {
  AddonConfigEffective,
  AddonConfigInput,
  AuditEvent,
  LinkIdentity,
  LinkRevision,
} from "./types.js";

interface LinkStoreData {
  links: LinkIdentity[];
  events: AuditEvent[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function nextRevisionId(link: LinkIdentity): number {
  return link.revisions.length > 0
    ? Math.max(...link.revisions.map((item) => item.revisionId)) + 1
    : 1;
}

export class AddonLinkStore {
  private readonly filePath: string;
  private readonly cryptoBox: CryptoBox;

  public constructor(rootDir: string, cryptoBox: CryptoBox) {
    this.filePath = path.join(rootDir, "config", "addon-links.json");
    this.cryptoBox = cryptoBox;

    if (!fs.existsSync(this.filePath)) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const initial: LinkStoreData = { links: [], events: [] };
      fs.writeFileSync(this.filePath, JSON.stringify(initial), "utf8");
    }
  }

  private read(): LinkStoreData {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as LinkStoreData;
      return {
        links: Array.isArray(parsed.links) ? parsed.links : [],
        events: Array.isArray(parsed.events) ? parsed.events : [],
      };
    } catch {
      return { links: [], events: [] };
    }
  }

  private write(data: LinkStoreData): void {
    fs.writeFileSync(this.filePath, JSON.stringify(data), "utf8");
  }

  private addEvent(data: LinkStoreData, event: Omit<AuditEvent, "eventId" | "timestamp">): void {
    data.events.push({
      eventId: crypto.randomUUID(),
      timestamp: nowIso(),
      ...event,
    });
    if (data.events.length > 5000) {
      data.events.splice(0, data.events.length - 5000);
    }
  }

  private buildRevision(configInput: AddonConfigInput, revisionId: number): LinkRevision {
    const effective = applyConfigDefaults(configInput);
    validateConfigSafety(effective);

    return {
      revisionId,
      createdAt: nowIso(),
      debridEnabled: effective.debridEnabled,
      torboxTokenEncrypted: effective.torboxToken
        ? this.cryptoBox.encrypt(effective.torboxToken)
        : undefined,
    };
  }

  private findRequiredLink(data: LinkStoreData, linkId: string): LinkIdentity {
    const link = data.links.find((item) => item.linkId === linkId);
    if (!link) {
      throw new Error("link_not_found");
    }
    return link;
  }

  public create(configInput: AddonConfigInput, ip?: string): LinkIdentity {
    const data = this.read();
    const linkId = crypto.randomUUID();
    const createdAt = nowIso();
    const revision = this.buildRevision(configInput, 1);
    const link: LinkIdentity = {
      linkId,
      status: "active",
      createdAt,
      updatedAt: createdAt,
      activeRevisionId: 1,
      revisions: [revision],
    };
    data.links.push(link);
    this.addEvent(data, { action: "link_issued", linkId, ip });
    this.write(data);
    return link;
  }

  public rotate(linkId: string, ip?: string): LinkIdentity {
    const data = this.read();
    const current = this.findRequiredLink(data, linkId);
    if (current.status === "revoked") {
      throw new Error("link_revoked");
    }

    current.status = "superseded";
    current.updatedAt = nowIso();

    const nextLinkId = crypto.randomUUID();
    current.supersededByLinkId = nextLinkId;
    const replacement: LinkIdentity = {
      linkId: nextLinkId,
      status: "active",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      activeRevisionId: current.activeRevisionId,
      revisions: [...current.revisions],
    };
    data.links.push(replacement);
    this.addEvent(data, { action: "link_rotated", linkId: nextLinkId, ip });
    this.write(data);
    return replacement;
  }

  public revoke(linkId: string, ip?: string): LinkIdentity {
    const data = this.read();
    const link = this.findRequiredLink(data, linkId);
    link.status = "revoked";
    link.updatedAt = nowIso();
    this.addEvent(data, { action: "link_revoked", linkId, ip });
    this.write(data);
    return link;
  }

  public update(linkId: string, configInput: AddonConfigInput, ip?: string): LinkIdentity {
    const data = this.read();
    const link = this.findRequiredLink(data, linkId);
    if (link.status === "revoked") {
      throw new Error("link_revoked");
    }

    const revisionId = nextRevisionId(link);
    const revision = this.buildRevision(configInput, revisionId);
    link.revisions.push(revision);
    link.activeRevisionId = revisionId;
    link.updatedAt = nowIso();
    this.addEvent(data, { action: "config_updated", linkId, ip });
    this.write(data);
    return link;
  }

  public rollback(linkId: string, revisionId: number, ip?: string): LinkIdentity {
    const data = this.read();
    const link = this.findRequiredLink(data, linkId);
    const revision = link.revisions.find((item) => item.revisionId === revisionId);
    if (!revision) {
      throw new Error("revision_not_found");
    }
    if (link.status === "revoked") {
      throw new Error("link_revoked");
    }

    link.activeRevisionId = revision.revisionId;
    link.updatedAt = nowIso();
    this.addEvent(data, { action: "config_rolled_back", linkId, ip });
    this.write(data);
    return link;
  }

  public get(linkId: string): LinkIdentity | undefined {
    const data = this.read();
    return data.links.find((item) => item.linkId === linkId);
  }

  public getActiveConfig(linkId: string): AddonConfigEffective {
    const link = this.get(linkId);
    if (!link) {
      throw new Error("link_not_found");
    }
    if (link.status === "superseded") {
      throw new Error("link_superseded");
    }
    if (link.status === "revoked") {
      throw new Error("link_revoked");
    }

    const revision = link.revisions.find((item) => item.revisionId === link.activeRevisionId);
    if (!revision) {
      throw new Error("revision_not_found");
    }

    return {
      debridEnabled: revision.debridEnabled,
      torboxToken: revision.torboxTokenEncrypted
        ? this.cryptoBox.decrypt(revision.torboxTokenEncrypted)
        : undefined,
    };
  }

  public listEvents(limit = 100): AuditEvent[] {
    const data = this.read();
    return data.events.slice(Math.max(0, data.events.length - limit));
  }
}
