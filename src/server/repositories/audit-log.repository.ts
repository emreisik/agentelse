import "server-only";

import type { ActorType } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export type AuditLogInput = {
  workspaceId: string;
  projectId?: string;
  brandId?: string;
  actorType: ActorType;
  actorId?: string;
  action: string;
  entityType: string;
  entityId: string;
  // Never pass OTP/MFA/password values or other secret material here — this
  // metadata is stored indefinitely and rendered in the Audit UI verbatim.
  metadata?: Record<string, unknown>;
};

export const AuditLogRepository = {
  record(input: AuditLogInput) {
    return prisma.auditLog.create({
      data: { ...input, metadata: input.metadata as never },
    });
  },

  listForProject(projectId: string, limit = 100) {
    return prisma.auditLog.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  },
};
