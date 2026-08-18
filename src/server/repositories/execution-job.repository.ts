import "server-only";

import type {
  CapabilityKey,
  ExecutionJobStatus,
  ExecutionProviderType,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { AgentelseError } from "@/server/security/errors";
import { StateMachine } from "@/server/state-machine/transitions";

export type CreateExecutionJobInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  taskId: string;
  capability: CapabilityKey;
  providerType: ExecutionProviderType;
  providerId?: string;
  skillId?: string;
  browserProfileId?: string;
  contextSnapshotId?: string;
  correlationId: string;
  idempotencyKey: string;
  requestPayload?: unknown;
};

export const ExecutionJobRepository = {
  findByIdInProject(id: string, projectId: string) {
    return prisma.executionJob.findFirst({ where: { id, projectId } });
  },

  findByIdempotencyKey(idempotencyKey: string) {
    return prisma.executionJob.findUnique({ where: { idempotencyKey } });
  },

  create(input: CreateExecutionJobInput) {
    return prisma.executionJob.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        taskId: input.taskId,
        capability: input.capability,
        providerType: input.providerType,
        providerId: input.providerId,
        skillId: input.skillId,
        browserProfileId: input.browserProfileId,
        contextSnapshotId: input.contextSnapshotId,
        correlationId: input.correlationId,
        idempotencyKey: input.idempotencyKey,
        requestPayload: input.requestPayload as never,
        status: "QUEUED",
        phase: "ACT",
      },
    });
  },

  // Compare-and-swap claim used immediately before provider execution.
  // Even if duplicate outbox events point at the same job, PostgreSQL lets
  // only one worker change QUEUED -> RUNNING; only that worker may execute
  // the provider side effect.
  async claimQueuedForProvider(
    id: string,
    provider: { type: ExecutionProviderType; key: string },
  ): Promise<boolean> {
    const result = await prisma.executionJob.updateMany({
      where: { id, status: "QUEUED" },
      data: {
        status: "RUNNING",
        providerType: provider.type,
        providerId: provider.key,
        startedAt: new Date(),
        attemptCount: { increment: 1 },
      },
    });

    return result.count === 1;
  },

  // A PROCESSING outbox lease can only be reclaimed after it expires. If
  // its worker died between QUEUED -> RUNNING and persisting the provider
  // reference, put that incomplete dispatch back into the claimable state.
  async recoverStalledProviderDispatch(id: string): Promise<boolean> {
    const result = await prisma.executionJob.updateMany({
      where: {
        id,
        status: "RUNNING",
        providerExecutionReference: null,
      },
      data: {
        status: "QUEUED",
        providerType: "SYSTEM",
        providerId: null,
        startedAt: null,
      },
    });

    return result.count === 1;
  },

  async completeAfterVerification(
    id: string,
    projectId: string,
  ): Promise<boolean> {
    const result = await prisma.executionJob.updateMany({
      where: { id, projectId, status: "VERIFYING" },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    return result.count === 1;
  },

  async transition(
    id: string,
    projectId: string,
    to: ExecutionJobStatus,
    data?: {
      rawResult?: unknown;
      normalizedResult?: unknown;
      errorCode?: string;
      errorMessage?: string;
      retryable?: boolean;
    },
  ) {
    const job = await prisma.executionJob.findFirst({
      where: { id, projectId },
    });
    if (!job)
      throw new AgentelseError(
        "NOT_FOUND",
        `ExecutionJob ${id} not found in project ${projectId}`,
      );

    StateMachine.assertExecutionJobTransition(job.status, to);

    return prisma.executionJob.update({
      where: { id },
      data: {
        status: to,
        rawResult: data?.rawResult as never,
        normalizedResult: data?.normalizedResult as never,
        errorCode: data?.errorCode,
        errorMessage: data?.errorMessage,
        retryable: data?.retryable ?? job.retryable,
        attemptCount:
          to === "RUNNING" ? job.attemptCount + 1 : job.attemptCount,
        startedAt:
          to === "RUNNING" && !job.startedAt ? new Date() : job.startedAt,
        completedAt:
          to === "COMPLETED" || to === "FAILED" || to === "CANCELLED"
            ? new Date()
            : job.completedAt,
      },
    });
  },
};
