export interface AddonConfigInput {
  debridEnabled?: boolean;
  torboxToken?: string;
}

export interface AddonConfigEffective {
  debridEnabled: boolean;
  torboxToken?: string;
}

export type LinkStatus = "active" | "superseded" | "revoked";

export interface LinkRevision {
  revisionId: number;
  createdAt: string;
  debridEnabled: boolean;
  torboxTokenEncrypted?: string;
}

export interface LinkIdentity {
  linkId: string;
  status: LinkStatus;
  createdAt: string;
  updatedAt: string;
  activeRevisionId: number;
  revisions: LinkRevision[];
  supersededByLinkId?: string;
}

export interface AuditEvent {
  eventId: string;
  timestamp: string;
  action: string;
  linkId?: string;
  ip?: string;
  reason?: string;
}
