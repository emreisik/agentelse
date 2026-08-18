import "server-only";

import { randomUUID } from "node:crypto";

import { Prisma, type CapabilityKey, type RiskLevel } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { capabilityLabel, PLATFORM_LABEL } from "@/lib/labels";
import { AgentelseError } from "@/server/security/errors";
import { StateMachine } from "@/server/state-machine/transitions";
import { CapabilityRouter } from "@/server/execution/capability-router";
import { ExecutionPolicy } from "@/server/execution/execution-policy";
import { normalizeProviderStatus } from "@/server/execution/execution-normalizer";
import {
  OUTBOX_EVENT_TYPES,
  OutboxRepository,
} from "@/server/repositories/outbox.repository";
import { HumanInterventionRepository } from "@/server/repositories/human-intervention.repository";
import { ExecutionJobRepository } from "@/server/repositories/execution-job.repository";
import { TaskRepository } from "@/server/repositories/task.repository";
import { ApprovalRepository } from "@/server/repositories/approval.repository";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";
import { ProviderRegistry } from "@/server/execution/provider-registry";
import type { ExecutionPolicyContext } from "@/server/execution/types";

export type DispatchInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  taskId: string;
  capability: CapabilityKey;
  riskLevel: RiskLevel;
  skillId?: string;
  contextSnapshotId?: string;
  payload?: unknown;
};

// The only entry point domain code (CommandService, TaskPlanner, schedulers)
// should call to run a capability. Everything downstream — provider choice,
// browser profile scoping, retries — is this service's job, never the
// caller's.
export const ExecutionService = {
  // Creates the ExecutionJob + its transactional outbox event atomically
  // (spec section 49) and returns immediately with status QUEUED. The
  // provider is not called yet — ExecutionWorker.processDispatchQueue()
  // does that from the outbox, so a crash between "job created" and
  // "provider called" can never lose the job.
  async dispatch(input: DispatchInput) {
    const idempotencyKey = `${input.taskId}:${input.capability}`;

    const existing = await prisma.executionJob.findUnique({
      where: { idempotencyKey },
    });
    if (existing) return existing;

    const browserProfileId = await CapabilityRouter.resolveBrowserProfile(
      input.capability,
      input.projectId,
      input.payload,
    );

    const correlationId = randomUUID();

    try {
      return await prisma.$transaction(async (tx) => {
        const job = await tx.executionJob.create({
          data: {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            brandId: input.brandId,
            taskId: input.taskId,
            capability: input.capability,
            providerType: "SYSTEM",
            skillId: input.skillId,
            browserProfileId,
            contextSnapshotId: input.contextSnapshotId,
            correlationId,
            idempotencyKey,
            requestPayload: input.payload as never,
            status: "QUEUED",
            phase: "ACT",
          },
        });

        await OutboxRepository.enqueue(tx, {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          aggregateType: "ExecutionJob",
          aggregateId: job.id,
          eventType: OUTBOX_EVENT_TYPES.EXECUTION_DISPATCH,
          payload: { executionJobId: job.id, riskLevel: input.riskLevel },
          executionJobId: job.id,
        });

        return job;
      });
    } catch (error) {
      // Two callers raced to dispatch the same task+capability (the
      // findUnique check above is TOCTOU-vulnerable under concurrency —
      // e.g. two sibling WorkPlan tasks completing near-simultaneously and
      // both fanning out to the same downstream dispatch). The unique
      // idempotencyKey constraint catches it; the loser returns the
      // winner's job instead of failing the caller.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const winner = await prisma.executionJob.findUnique({
          where: { idempotencyKey },
        });
        if (winner) return winner;
      }
      throw error;
    }
  },

  // Called by the worker for a claimed EXECUTION_DISPATCH outbox event.
  // Routes to a provider, calls execute(), and immediately polls once —
  // enough for synchronous mocks; ExecutionWorker.pollRunningJobs() covers
  // slower/real providers on subsequent ticks.
  async startExecution(
    executionJobId: string,
    riskLevel: RiskLevel,
    options: { recoverStalledDispatch?: boolean } = {},
  ) {
    let job = await prisma.executionJob.findUniqueOrThrow({
      where: { id: executionJobId },
    });

    if (
      options.recoverStalledDispatch &&
      job.status === "RUNNING" &&
      !job.providerExecutionReference
    ) {
      await ExecutionJobRepository.recoverStalledProviderDispatch(job.id);
      job = await prisma.executionJob.findUniqueOrThrow({
        where: { id: executionJobId },
      });
    }

    if (job.status !== "QUEUED") return job;

    const context: ExecutionPolicyContext = {
      workspaceId: job.workspaceId,
      projectId: job.projectId,
      brandId: job.brandId,
      taskId: job.taskId,
      capability: job.capability,
      riskLevel,
      browserProfileId: job.browserProfileId ?? undefined,
      skillId: job.skillId ?? undefined,
    };

    const provider = await CapabilityRouter.route(job.capability, context);

    StateMachine.assertExecutionJobTransition(job.status, "RUNNING");
    const claimed = await ExecutionJobRepository.claimQueuedForProvider(
      job.id,
      provider,
    );
    if (!claimed) {
      return prisma.executionJob.findUniqueOrThrow({
        where: { id: executionJobId },
      });
    }

    const task = await prisma.task.findUnique({ where: { id: job.taskId } });
    if (task && task.status !== "RUNNING") {
      await TaskRepository.transition(job.taskId, job.projectId, "RUNNING");
      if (ExecutionPolicy.isCreative(job.capability)) {
        await IdeaChatRepository.postCreativeLoadingCard({
          workspaceId: job.workspaceId,
          projectId: job.projectId,
          taskId: job.taskId,
          title: task.title,
          departmentKey: task.departmentKey ?? undefined,
        }).catch((error) => {
          console.error(
            "[execution-service] postCreativeLoadingCard failed:",
            error,
          );
        });
      } else {
        await IdeaChatRepository.postTaskRunningCard({
          workspaceId: job.workspaceId,
          projectId: job.projectId,
          taskId: job.taskId,
          title: task.title,
          departmentKey: task.departmentKey ?? undefined,
        }).catch((error) => {
          console.error(
            "[execution-service] postTaskRunningCard failed:",
            error,
          );
        });
      }
    }

    // Providers never read Brand Brain tables directly — they only see the
    // frozen snapshot taken when this job was planned (spec section 35).
    const snapshot = job.contextSnapshotId
      ? await prisma.executionContextSnapshot.findUnique({
          where: { id: job.contextSnapshotId },
        })
      : null;

    const accepted = await provider.execute({
      executionJobId: job.id,
      correlationId: job.correlationId,
      idempotencyKey: job.idempotencyKey,
      capability: job.capability,
      context,
      payload: {
        ...((job.requestPayload as Record<string, unknown> | null) ?? {}),
        brandContext: snapshot?.payload ?? {},
      },
    });

    const referencePersisted = await prisma.executionJob.updateMany({
      where: {
        id: job.id,
        status: "RUNNING",
        providerId: provider.key,
        providerExecutionReference: null,
      },
      data: { providerExecutionReference: accepted.executionReference },
    });
    if (referencePersisted.count !== 1) {
      return prisma.executionJob.findUniqueOrThrow({
        where: { id: executionJobId },
      });
    }

    return this.pollOnce(job.id);
  },

  // Polls the provider once and applies whatever transition the result
  // implies — WAITING_HUMAN spawns a HumanInterventionRequest, COMPLETED
  // moves to VERIFYING (never straight to COMPLETED; spec section 45).
  async pollOnce(executionJobId: string) {
    const job = await prisma.executionJob.findUniqueOrThrow({
      where: { id: executionJobId },
    });
    if (
      job.status !== "RUNNING" ||
      !job.providerExecutionReference ||
      !job.providerId
    )
      return job;

    const provider = ProviderRegistry.getByKey(job.providerId);
    if (!provider) {
      throw new AgentelseError(
        "PROVIDER_UNAVAILABLE",
        `Provider ${job.providerId} is no longer registered`,
      );
    }

    const status = await provider.getStatus(job.providerExecutionReference);
    const outcome = normalizeProviderStatus(
      status,
      ExecutionPolicy.requiresVerification(job.capability),
    );

    if (outcome.jobStatus === job.status) return job;

    StateMachine.assertExecutionJobTransition(job.status, outcome.jobStatus);

    // Provider polling is safe to repeat, but applying its outcome is not:
    // duplicate workers must not create two verification/human/creative
    // side effects. The RUNNING predicate makes this transition a CAS.
    const applied = await prisma.executionJob.updateMany({
      where: { id: job.id, status: "RUNNING" },
      data: {
        status: outcome.jobStatus,
        rawResult: status.rawResult as never,
        errorCode: status.errorCode,
        errorMessage: status.errorMessage,
        retryable: status.retryable ?? false,
        completedAt:
          outcome.jobStatus === "FAILED" ? new Date() : job.completedAt,
      },
    });
    if (applied.count !== 1) {
      return prisma.executionJob.findUniqueOrThrow({
        where: { id: executionJobId },
      });
    }

    const updated = await prisma.executionJob.findUniqueOrThrow({
      where: { id: executionJobId },
    });

    if (outcome.jobStatus === "WAITING_HUMAN" && outcome.humanIntervention) {
      await HumanInterventionRepository.create({
        workspaceId: job.workspaceId,
        projectId: job.projectId,
        brandId: job.brandId,
        taskId: job.taskId,
        executionJobId: job.id,
        browserProfileId: job.browserProfileId ?? undefined,
        type: outcome.humanIntervention.type,
        inputType: outcome.humanIntervention.inputType,
        title: `Human input needed for ${capabilityLabel(job.capability)}`,
        message: status.errorMessage,
      });
    }

    if (
      outcome.jobStatus === "COMPLETED" &&
      ExecutionPolicy.isCreative(job.capability)
    ) {
      await materializeCreativeFromResult(job, status.rawResult);
    }

    if (
      outcome.jobStatus === "FAILED" &&
      ExecutionPolicy.isCreative(job.capability)
    ) {
      const failedTask = await prisma.task.findUnique({
        where: { id: job.taskId },
        select: { title: true, departmentKey: true },
      });
      await IdeaChatRepository.resolveCreativeCard({
        workspaceId: job.workspaceId,
        projectId: job.projectId,
        taskId: job.taskId,
        text: `❌ Image generation failed: ${failedTask?.title ?? "task"}`,
        card: {
          kind: "creative-failed",
          taskId: job.taskId,
          title: failedTask?.title ?? "Creative",
          message: status.errorMessage ?? undefined,
        },
        departmentKey: failedTask?.departmentKey ?? undefined,
      }).catch((error) => {
        console.error(
          "[execution-service] resolveCreativeCard(failed) failed:",
          error,
        );
      });
    }

    if (
      (outcome.jobStatus === "COMPLETED" || outcome.jobStatus === "FAILED") &&
      ExecutionPolicy.isPublish(job.capability)
    ) {
      const publishedTask = await prisma.task.findUnique({
        where: { id: job.taskId },
        select: { title: true, departmentKey: true },
      });
      const title = publishedTask?.title ?? "Publish";
      const platform = PLATFORM_LABEL[job.capability] ?? job.capability;
      const rawResult = (status.rawResult ?? {}) as Record<string, unknown>;
      const postId =
        typeof rawResult.postId === "string" ? rawResult.postId : undefined;
      await IdeaChatRepository.resolvePublishResultCard({
        workspaceId: job.workspaceId,
        projectId: job.projectId,
        taskId: job.taskId,
        text:
          outcome.jobStatus === "COMPLETED"
            ? `📤 Published on ${platform}: ${title}`
            : `❌ ${platform} publish failed: ${title}`,
        card: {
          kind: "publish-result",
          taskId: job.taskId,
          platform,
          title,
          status: outcome.jobStatus,
          postId,
          errorMessage:
            outcome.jobStatus === "FAILED"
              ? (status.errorMessage ?? undefined)
              : undefined,
        },
        departmentKey: publishedTask?.departmentKey ?? undefined,
      }).catch((error) => {
        console.error(
          "[execution-service] resolvePublishResultCard failed:",
          error,
        );
      });
    }

    if (outcome.jobStatus === "VERIFYING") {
      await prisma.executionVerification.create({
        data: {
          workspaceId: job.workspaceId,
          projectId: job.projectId,
          brandId: job.brandId,
          executionJobId: job.id,
          status: "PENDING",
          expectedState: (job.requestPayload ?? {}) as never,
          observedState: (status.rawResult ?? {}) as never,
        },
      });
    }

    // Keep the parent Task's status in lockstep with terminal/waiting job
    // outcomes. COMPLETED-without-verification is the only case handled
    // here — VERIFYING -> COMPLETED for the Task happens once
    // ExecutionWorker.resolvePendingVerifications() actually verifies it.
    const taskTargetStatus =
      outcome.jobStatus === "WAITING_HUMAN"
        ? "WAITING_HUMAN"
        : outcome.jobStatus === "FAILED"
          ? "FAILED"
          : outcome.jobStatus === "COMPLETED"
            ? "COMPLETED"
            : undefined;

    if (taskTargetStatus) {
      const task = await prisma.task.findUnique({ where: { id: job.taskId } });
      if (task && task.status !== taskTargetStatus) {
        await TaskRepository.transition(
          job.taskId,
          job.projectId,
          taskTargetStatus,
        );
      }
    }

    return updated;
  },

  async resumeAfterHumanInput(executionJobId: string, value: string) {
    const job = await prisma.executionJob.findUniqueOrThrow({
      where: { id: executionJobId },
    });
    if (!job.providerId || !job.providerExecutionReference) return job;

    const provider = ProviderRegistry.getByKey(job.providerId);
    if (!provider?.resume) return job;

    await provider.resume(job.providerExecutionReference, { value });

    StateMachine.assertExecutionJobTransition(job.status, "RUNNING");
    await prisma.executionJob.update({
      where: { id: job.id },
      data: { status: "RUNNING" },
    });

    // Mirror startExecution()'s Task sync — without this, a task resumed
    // from WAITING_HUMAN stays there and can't legally reach COMPLETED next.
    const task = await prisma.task.findUnique({ where: { id: job.taskId } });
    if (task && task.status !== "RUNNING") {
      await TaskRepository.transition(job.taskId, job.projectId, "RUNNING");
    }

    return this.pollOnce(job.id);
  },
};

// The provider result arrives schema-less as `unknown` — verify all four
// fields are of the expected type before writing the Asset.
function generatedImageFrom(
  value: unknown,
):
  | { storageKey: string; filename: string; mimeType: string; size: number }
  | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { storageKey, filename, mimeType, size } = value as Record<
    string,
    unknown
  >;
  if (
    typeof storageKey !== "string" ||
    typeof filename !== "string" ||
    typeof mimeType !== "string" ||
    typeof size !== "number"
  ) {
    return undefined;
  }
  return { storageKey, filename, mimeType, size };
}

// Turns a completed CREATE_SOCIAL_CREATIVE/CREATE_AD_CREATIVE job's result
// into a real Creative + first CreativeVersion, in IN_REVIEW status ready
// for the approval workflow (spec section 29: CREATE -> REVIEW -> APPROVE).
async function materializeCreativeFromResult(
  job: {
    id: string;
    workspaceId: string;
    projectId: string;
    brandId: string;
    taskId: string;
    capability: CapabilityKey;
    providerId: string | null;
  },
  rawResult: unknown,
) {
  const result = (rawResult ?? {}) as Record<string, unknown>;

  // If a real image exists (GeminiCreativeProvider -> openclaw infer image
  // generate), it's saved; otherwise falls back to the legacy fake placeholder.
  const generatedImage = generatedImageFrom(result.image);
  const asset = generatedImage
    ? await prisma.asset.create({
        data: {
          workspaceId: job.workspaceId,
          projectId: job.projectId,
          brandId: job.brandId,
          type: "CREATIVE",
          filename: generatedImage.filename,
          mimeType: generatedImage.mimeType,
          storageKey: generatedImage.storageKey,
          size: generatedImage.size,
        },
      })
    : typeof result.placeholderImageUrl === "string"
      ? await prisma.asset.create({
          data: {
            workspaceId: job.workspaceId,
            projectId: job.projectId,
            brandId: job.brandId,
            type: "CREATIVE",
            filename: "mock-creative.png",
            mimeType: "image/png",
            storageKey: result.placeholderImageUrl,
            size: 0,
          },
        })
      : undefined;

  const creative = await prisma.creative.create({
    data: {
      workspaceId: job.workspaceId,
      projectId: job.projectId,
      brandId: job.brandId,
      type:
        job.capability === "CREATE_AD_CREATIVE" ? "AD_CREATIVE" : "SOCIAL_POST",
      status: "IN_REVIEW",
      createdByTaskId: job.taskId,
    },
  });

  const version = await prisma.creativeVersion.create({
    data: {
      creativeId: creative.id,
      version: 1,
      assetId: asset?.id,
      caption: typeof result.caption === "string" ? result.caption : undefined,
      copy: typeof result.copy === "string" ? result.copy : undefined,
      generationProvider: job.providerId ?? "unknown",
      generationMetadata: result as never,
    },
  });

  await prisma.creative.update({
    where: { id: creative.id },
    data: { currentVersionId: version.id },
  });

  // A Creative reaching IN_REVIEW is exactly what the Approval Center's
  // "Creative approvals" section is for (spec sections 28/66) — without
  // this, generated creatives were invisible outside the project page.
  // Routed through ApprovalRepository.create (not a direct prisma call) so
  // this also gets the same Telegram notification every other approval does.
  const approval = await ApprovalRepository.create({
    workspaceId: job.workspaceId,
    projectId: job.projectId,
    brandId: job.brandId,
    taskId: job.taskId,
    entityType: "Creative",
    entityId: creative.id,
    type: "CREATIVE_APPROVAL",
    requestedByType: "AI",
  });

  // If the creative is linked to an idea (a work-plan chain, or a command
  // that came directly from that idea's chat — see resolveIdeaIdForTask),
  // the generated image lands in that idea's chat thread — the "loading"
  // card opened in startExecution is here updated with the result (same
  // row, so no lingering "loading" ghost remains). Best-effort: if it can't
  // be found/written, creative generation itself is unaffected.
  try {
    const task = await prisma.task.findUnique({
      where: { id: job.taskId },
      select: { title: true, departmentKey: true },
    });
    const title = task?.title ?? "Creative";
    await IdeaChatRepository.resolveCreativeCard({
      workspaceId: job.workspaceId,
      projectId: job.projectId,
      taskId: job.taskId,
      text: `🎨 Creative ready: ${title} — awaiting approval.`,
      card: {
        kind: "creative-ready",
        taskId: job.taskId,
        title,
        creativeId: creative.id,
        assetId: asset?.id,
        mimeType: asset?.mimeType,
        caption:
          typeof result.caption === "string" ? result.caption : undefined,
        copy: typeof result.copy === "string" ? result.copy : undefined,
        status: "IN_REVIEW",
        approvalId: approval.id,
      },
      attachments: asset
        ? [
            {
              assetId: asset.id,
              filename: asset.filename,
              mimeType: asset.mimeType,
              size: asset.size,
            },
          ]
        : undefined,
      departmentKey: task?.departmentKey ?? undefined,
    });
  } catch (error) {
    console.error("[execution-service] resolveCreativeCard failed:", error);
  }
}
