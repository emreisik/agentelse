import "server-only";

import { prisma } from "@/lib/prisma";

export type BrandEvidenceScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

export const BrandEvidenceRepository = {
  // Bridges already-existing Evidence rows to a brand-level artifact (e.g. a
  // BrandConstitution or BrandStrategyVersion) that was synthesized from
  // them. Silently no-ops on an empty list — most synthesis runs draw on
  // findings that were never URL-backed (ASSUMPTION/UNKNOWN classifications
  // carry no Evidence row) and that's expected, not an error.
  linkMany(
    scope: BrandEvidenceScope,
    relatedEntityType: string,
    relatedEntityId: string,
    evidenceIds: string[],
  ) {
    const unique = Array.from(new Set(evidenceIds));
    if (unique.length === 0) return Promise.resolve({ count: 0 });
    return prisma.brandEvidence.createMany({
      data: unique.map((evidenceId) => ({
        ...scope,
        evidenceId,
        relatedEntityType,
        relatedEntityId,
      })),
    });
  },
};
