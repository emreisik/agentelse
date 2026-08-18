import "server-only";

import { HumanInterventionRepository } from "@/server/repositories/human-intervention.repository";
import { TemporarySecretRepository } from "@/server/repositories/temporary-secret.repository";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { ExecutionService } from "@/server/execution/execution-service";
import { AgentelseError } from "@/server/security/errors";

// The end-to-end OTP/MFA/confirmation resolution flow (spec sections 25-27):
// a value from the web Human Action Center is stored encrypted
// with a short TTL, consumed exactly once, handed to the provider, and then
// discarded — it is never written to Task/ExecutionJob/AuditLog.
export const HumanInterventionService = {
  async resolveWithValue(
    requestId: string,
    projectId: string,
    resolvedByUserId: string,
    value: string,
  ) {
    const request = await HumanInterventionRepository.findByIdInProject(
      requestId,
      projectId,
    );
    if (!request) {
      throw new AgentelseError(
        "NOT_FOUND",
        `HumanInterventionRequest ${requestId} not found`,
      );
    }

    await TemporarySecretRepository.store({
      workspaceId: request.workspaceId,
      humanInterventionRequestId: request.id,
      value,
    });

    const resolved = await HumanInterventionRepository.resolve(
      requestId,
      projectId,
      resolvedByUserId,
    );

    const secret = await TemporarySecretRepository.consume(request.id);

    if (request.executionJobId && secret) {
      await ExecutionService.resumeAfterHumanInput(
        request.executionJobId,
        secret,
      );
    }

    // metadata intentionally excludes the resolved value itself.
    await AuditLogRepository.record({
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      brandId: request.brandId,
      actorType: "USER",
      actorId: resolvedByUserId,
      action: "human_action.resolved",
      entityType: "HumanInterventionRequest",
      entityId: request.id,
      metadata: { type: request.type },
    });

    return resolved;
  },

  async cancel(requestId: string, projectId: string) {
    return HumanInterventionRepository.transition(
      requestId,
      projectId,
      "CANCELLED",
    );
  },
};
