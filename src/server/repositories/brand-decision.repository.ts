import "server-only";

import type { ActorType } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export type RecordDecisionInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  topic: string;
  decision: string;
  rationale?: string;
  decidedByType: ActorType;
  decidedByUserId?: string;
};

export const BrandDecisionRepository = {
  record(input: RecordDecisionInput) {
    return prisma.brandDecision.create({ data: input });
  },
};
