// analytics.edit izninin IntegrationCredential.metadata.gaEdit kaydı. Saf
// modül: ağ ve DB yok.

export type GaEditGrant = { grantedAt: string; grantedByUserId: string | null };

export function parseGaEditGrant(metadata: unknown): GaEditGrant | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const raw = (metadata as { gaEdit?: unknown }).gaEdit;
  if (typeof raw !== "object" || raw === null) return null;
  const { grantedAt, grantedByUserId } = raw as {
    grantedAt?: unknown;
    grantedByUserId?: unknown;
  };
  if (typeof grantedAt !== "string" || Number.isNaN(Date.parse(grantedAt))) {
    return null;
  }
  return {
    grantedAt,
    grantedByUserId: typeof grantedByUserId === "string" ? grantedByUserId : null,
  };
}

export function buildGaEditGrant(
  userId: string | null,
  now: Date = new Date(),
): GaEditGrant {
  return { grantedAt: now.toISOString(), grantedByUserId: userId };
}
