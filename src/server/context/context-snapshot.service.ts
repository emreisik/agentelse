import "server-only";

import { createHash } from "node:crypto";

import type { CapabilityKey } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { buildExecutionContext } from "@/server/context/context-builder";

function stableHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

// Creates an immutable snapshot of the Brand Brain slice a single execution
// will see. Agents read this row, never the live Brand Brain tables — so a
// mid-execution Brand Brain edit can never change behavior an execution is
// already mid-flight on (spec section 35).
export const ContextSnapshotService = {
  async create(input: {
    workspaceId: string;
    projectId: string;
    brandId: string;
    capability: CapabilityKey;
  }) {
    const payload = await buildExecutionContext(
      input.brandId,
      input.capability,
    );

    const [strategyVersion, negativeBriefCount] = await Promise.all([
      prisma.brandStrategyVersion.findFirst({
        where: { brandId: input.brandId },
        orderBy: { version: "desc" },
        select: { version: true },
      }),
      prisma.negativeBriefRule.count({
        where: { brandId: input.brandId, active: true },
      }),
    ]);

    return prisma.executionContextSnapshot.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        strategyVersion: strategyVersion?.version,
        negativeBriefVersion: negativeBriefCount,
        payload: payload as never,
        hash: stableHash(payload),
      },
    });
  },
};
