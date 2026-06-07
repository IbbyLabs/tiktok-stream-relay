export interface AddonConfigInput {
  debridEnabled?: boolean;
  torboxToken?: string;
}

export interface AddonConfigEffective {
  debridEnabled: boolean;
  torboxToken?: string;
}

export type LinkStatus = "active" | "revoked";

export interface LinkRevision {
  revisionId: number;
  createdAt: string;
  debridEnabled: boolean;
  torboxTokenEncrypted?: string;
  torboxTokenFingerprint?: string;
}

export interface LinkIdentity {
  linkId: string;
  status: LinkStatus;
  createdAt: string;
  updatedAt: string;
  activeRevisionId: number;
  revisions: LinkRevision[];
}

export interface AuditEvent {
  eventId: string;
  timestamp: string;
  action: string;
  linkId?: string;
  ip?: string;
  reason?: string;
}
