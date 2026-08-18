import "server-only";

import type { AgencyTriggerType } from "@prisma/client";

import { AgencyTriggerRepository } from "@/server/repositories/agency-trigger.repository";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";

export type EnqueueInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  type: AgencyTriggerType;
  payload?: Record<string, unknown>;
  dedupeKey?: string;
  scheduledFor?: Date;
};

// Thin wrapper over the trigger queue. Processing/dispatch lives in
// ContinuousAgencyEngine — this only enqueues (dedup handled by the unique
// [projectId, dedupeKey] constraint).
export const TriggerService = {
  async enqueue(input: EnqueueInput): Promise<{ enqueued: boolean }> {
    const result = await AgencyTriggerRepository.enqueue(input);
    if (result.enqueued) {
      await AuditLogRepository.record({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        actorType: "SYSTEM",
        action: `trigger.enqueued.${input.type}`,
        entityType: "AgencyTrigger",
        entityId: input.dedupeKey ?? input.type,
        metadata: { type: input.type },
      });
    }
    return result;
  },
};
