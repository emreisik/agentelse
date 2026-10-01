import "server-only";

import { randomUUID } from "node:crypto";

import {
  Prisma,
  type CapabilityKey,
  type CreativeContentFormat,
  type RiskLevel,
  type SocialPlatform,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { remainingVariantSlots } from "@/lib/works/variants";
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
import {
  claimPlanCreative,
  planCreativeIdOf,
  releasePlanCreative,
} from "@/server/execution/plan-creative-link";
import { isWorksEnabled } from "@/server/works/flag";
import { ProviderRegistry } from "@/server/execution/provider-registry";
import {
  mergeCardAlternatives,
  type CardPicture,
} from "@/server/execution/variant-card";
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
        // A publish job whose creativeId matches a creative-ready card
        // already in the chat mirrors its progress onto THAT card instead
        // of spawning its own "Task started" row — see
        // markCreativePublishState's own comment. Falls through to the
        // normal running card for every other capability, and for a
        // publish with no matching card (e.g. a scheduled/cron publish
        // with nothing currently in the chat window).
        const publishCreativeId = ExecutionPolicy.isPublish(job.capability)
          ? ((job.requestPayload as Record<string, unknown> | null)
              ?.creativeId as string | undefined)
          : undefined;
        const mirroredOntoCard = publishCreativeId
          ? await IdeaChatRepository.markCreativePublishState({
              taskId: job.taskId,
              creativeId: publishCreativeId,
              publishState: "publishing",
            }).catch(() => false)
          : false;
        if (!mirroredOntoCard) {
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

    if (outcome.jobStatus === job.status) {
      // Nothing transitioned, but reaching the provider at all proves the
      // job is still alive — bump `updatedAt` (via a no-op `status` write;
      // the `@updatedAt` field advances on any update regardless of which
      // fields changed) so SelfHealingService.resetStuckJobs' 30-minute
      // "no progress" timeout doesn't force-fail a capability that
      // genuinely just hasn't finished yet (e.g. Meta's video processing,
      // an OpenClaw browser session) — without this, a job that only ever
      // reports RUNNING/RUNNING never gets a DB write until it actually
      // transitions, so its `updatedAt` stays frozen at dispatch time.
      // Best-effort: a missed heartbeat write is no worse than today's
      // behavior, so failures here are swallowed rather than surfaced.
      await prisma.executionJob
        .updateMany({
          where: { id: job.id, status: job.status },
          data: { status: job.status },
        })
        .catch(() => undefined);
      return job;
    }

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
      const publishCreativeId = (
        job.requestPayload as Record<string, unknown> | null
      )?.creativeId as string | undefined;
      const mirroredOntoCard = publishCreativeId
        ? await IdeaChatRepository.markCreativePublishState({
            taskId: job.taskId,
            creativeId: publishCreativeId,
            publishState:
              outcome.jobStatus === "COMPLETED" ? "published" : "failed",
            publishError:
              outcome.jobStatus === "FAILED"
                ? (status.errorMessage ?? undefined)
                : undefined,
            publishedAt:
              outcome.jobStatus === "COMPLETED" ? new Date() : undefined,
          }).catch(() => false)
        : false;

      if (!mirroredOntoCard) {
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
      // A task the user cancelled mid-flight (cancelTaskAction,
      // agency-work-actions.ts) reaches CANCELLED — a terminal status with
      // no legal exit (TASK_TRANSITIONS) — while its provider call keeps
      // running in the background (no provider actually supports aborting
      // one). Without this guard, the result eventually landing here would
      // call TaskRepository.transition into COMPLETED/FAILED and throw an
      // illegal-transition error (caught by pollRunningJobs, but noisy and
      // wrong — the cancellation should just win silently). Any terminal
      // status here, not only CANCELLED, is excluded for the same reason:
      // never try to move a task that's already done somewhere else.
      if (
        task &&
        !["COMPLETED", "FAILED", "CANCELLED"].includes(task.status) &&
        task.status !== taskTargetStatus
      ) {
        await TaskRepository.transition(
          job.taskId,
          job.projectId,
          taskTargetStatus,
          taskTargetStatus === "FAILED"
            ? { failureReason: status.errorMessage ?? undefined }
            : undefined,
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
function generatedImageFrom(value: unknown):
  | {
      storageKey: string;
      filename: string;
      mimeType: string;
      size: number;
      width?: number;
      height?: number;
    }
  | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { storageKey, filename, mimeType, size, width, height } =
    value as Record<string, unknown>;
  if (
    typeof storageKey !== "string" ||
    typeof filename !== "string" ||
    typeof mimeType !== "string" ||
    typeof size !== "number"
  ) {
    return undefined;
  }
  return {
    storageKey,
    filename,
    mimeType,
    size,
    width: typeof width === "number" ? width : undefined,
    height: typeof height === "number" ? height : undefined,
  };
}

type JobForCreative = {
  id: string;
  workspaceId: string;
  projectId: string;
  brandId: string;
  taskId: string;
  capability: CapabilityKey;
  providerId: string | null;
};

type VariantImage = NonNullable<ReturnType<typeof generatedImageFrom>>;

const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Written only by the variants route ("Make 3 more" on an IN_REVIEW piece).
function isVariantsOnly(payload: unknown): boolean {
  return (
    isPlainRecord(payload) &&
    (payload as { variantsOnly?: unknown }).variantsOnly === true
  );
}

// The provider's extra renders: malformed entries are skipped, never stored.
function alternativeImagesFrom(
  value: unknown,
): { image: VariantImage; label?: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { image: VariantImage; label?: string }[] = [];
  for (const raw of value) {
    if (!isPlainRecord(raw)) continue;
    const image = generatedImageFrom(raw.image);
    if (!image) continue;
    out.push({
      image,
      label: typeof raw.label === "string" ? raw.label : undefined,
    });
  }
  return out;
}

type StoredAlternative = {
  assetId: string;
  // 1-based visual number: the piece's own picture is visual 1.
  index: number;
  label?: string;
  width?: number;
  height?: number;
  // The same pixel size under the names the shared reader
  // (parseAlternatives) and the card use.
  assetWidth?: number;
  assetHeight?: number;
};

function storedAlternative(
  asset: { id: string; width: number | null; height: number | null },
  index: number,
  label: string | undefined,
): StoredAlternative {
  return {
    assetId: asset.id,
    index,
    ...(label ? { label } : {}),
    ...(asset.width ? { width: asset.width, assetWidth: asset.width } : {}),
    ...(asset.height
      ? { height: asset.height, assetHeight: asset.height }
      : {}),
  };
}

function cardAlternatives(entries: readonly StoredAlternative[]) {
  return entries.map((e) => ({
    assetId: e.assetId,
    ...(e.label ? { label: e.label } : {}),
    ...(e.assetWidth ? { assetWidth: e.assetWidth } : {}),
    ...(e.assetHeight ? { assetHeight: e.assetHeight } : {}),
  }));
}

// "Make 3 more": the new pictures join the alternatives of the piece that is
// already in review. It never claims the slot and never creates a Creative or
// an Approval (that would be a stray second piece). The cap and the duplicate
// check run INSIDE the write so a replayed job can neither exceed the cap nor
// append the same pictures twice. Returns the full alternatives list now
// stored and how many were added, or null when there was no piece to attach to.
async function appendVariantsToCreative(
  job: JobForCreative,
  creativeId: string,
  images: readonly { image: VariantImage; label?: string }[],
): Promise<{ all: StoredAlternative[]; addedCount: number } | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const creative = await tx.creative.findFirst({
            where: {
              id: creativeId,
              projectId: job.projectId,
              status: "IN_REVIEW",
            },
            select: { id: true },
          });
          if (!creative) return null;
          const v1 = await tx.creativeVersion.findUnique({
            where: { creativeId_version: { creativeId, version: 1 } },
            select: { id: true, generationMetadata: true },
          });
          if (!v1) return null;

          const meta = isPlainRecord(v1.generationMetadata)
            ? v1.generationMetadata
            : {};
          const existing: StoredAlternative[] = Array.isArray(meta.alternatives)
            ? (meta.alternatives.filter(isPlainRecord) as StoredAlternative[])
            : [];
          const existingIds = existing
            .map((e) => e.assetId)
            .filter((id): id is string => typeof id === "string");
          const known = existingIds.length
            ? await tx.asset.findMany({
                where: { id: { in: existingIds } },
                select: { storageKey: true },
              })
            : [];
          const knownKeys = new Set(known.map((a) => a.storageKey));

          const fresh = images
            .filter(({ image }) => !knownKeys.has(image.storageKey))
            .slice(0, remainingVariantSlots(existing.length));
          const added: StoredAlternative[] = [];
          for (const { image, label } of fresh) {
            const asset = await tx.asset.create({
              data: {
                workspaceId: job.workspaceId,
                projectId: job.projectId,
                brandId: job.brandId,
                type: "CREATIVE",
                source: "AI_GENERATED",
                filename: image.filename,
                mimeType: image.mimeType,
                storageKey: image.storageKey,
                size: image.size,
                width: image.width,
                height: image.height,
              },
            });
            added.push(
              storedAlternative(
                asset,
                existing.length + added.length + 2,
                label,
              ),
            );
          }
          const all = [...existing, ...added];
          if (added.length > 0) {
            await tx.creativeVersion.update({
              where: { id: v1.id },
              data: {
                generationMetadata: { ...meta, alternatives: all } as never,
              },
            });
          }
          return { all, addedCount: added.length };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      // A concurrent append of the same piece: re-read and decide again.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034" &&
        attempt < 2
      ) {
        continue;
      }
      throw error;
    }
  }
}

// Variants-only job: patches the creative-ready card of the piece and turns
// this task's own "generating" card into a plain note (no second card).
async function patchCardAfterVariantsOnly(
  job: JobForCreative,
  creativeId: string,
  {
    all: alternatives,
    addedCount,
  }: { all: StoredAlternative[]; addedCount: number },
) {
  const existing = await prisma.command.findFirst({
    where: {
      projectId: job.projectId,
      source: "SYSTEM",
      AND: [
        { parsedIntent: { path: ["card", "creativeId"], equals: creativeId } },
        { parsedIntent: { path: ["card", "kind"], equals: "creative-ready" } },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, parsedIntent: true },
  });
  const parsed = existing?.parsedIntent as {
    card?: { kind?: string; [key: string]: unknown };
    departmentKey?: unknown;
  } | null;
  if (existing && parsed?.card?.kind === "creative-ready") {
    await prisma.command.update({
      where: { id: existing.id },
      data: {
        parsedIntent: {
          card: {
            ...parsed.card,
            // Merged with the card's own list: after a "Use this one" the
            // stored v1 list repeats the current picture and lacks the one it
            // displaced, so it cannot be copied over the card as is.
            alternatives: mergeCardAlternatives(
              parsed.card as {
                assetId?: string;
                alternatives?: CardPicture[];
              },
              cardAlternatives(alternatives),
            ),
          },
          departmentKey: parsed.departmentKey,
        } as never,
      },
    });
  }
  await prisma.command.updateMany({
    where: {
      projectId: job.projectId,
      source: "SYSTEM",
      parsedIntent: { path: ["card", "taskId"], equals: job.taskId },
    },
    data: {
      replyText:
        addedCount > 0
          ? `🎨 ${addedCount} more ${addedCount === 1 ? "option" : "options"} added to the piece in review.`
          : "🎨 No new options could be added to the piece in review.",
      parsedIntent: {} as never,
    },
  });
}

async function warnIfWorkSlotUnclaimed(job: JobForCreative) {
  const task = await prisma.task.findUnique({
    where: { id: job.taskId },
    select: { payload: true },
  });
  if (!planCreativeIdOf(task?.payload)) return;
  const workId = await IdeaChatRepository.resolveWorkIdForTask(job.taskId);
  if (!workId) return;
  console.warn(
    `[execution-service] plan slot of task ${job.taskId} could not be claimed; a separate Creative was made (work ${workId})`,
  );
}

// Turns a completed CREATE_SOCIAL_CREATIVE/CREATE_AD_CREATIVE job's result
// into a real Creative + first CreativeVersion, in IN_REVIEW status ready
// for the approval workflow (spec section 29: CREATE -> REVIEW -> APPROVE).
async function materializeCreativeFromResult(
  job: JobForCreative,
  rawResult: unknown,
) {
  const result = (rawResult ?? {}) as Record<string, unknown>;
  const isVariantResult = Array.isArray(result.alternatives);

  // "Make 3 more" (variantsOnly) attaches to the piece already in review: it
  // must never reach the claim / Creative / Approval path below. The Task is
  // read only for a variants result (or with Works on, whose route is the only
  // writer of the key), so every other job keeps today's exact queries.
  if (isVariantResult || isWorksEnabled()) {
    const task = await prisma.task.findUnique({
      where: { id: job.taskId },
      select: { payload: true },
    });
    if (isVariantsOnly(task?.payload)) {
      const creativeId = planCreativeIdOf(task?.payload);
      const mainImage = generatedImageFrom(result.image);
      const images = [
        ...(mainImage ? [{ image: mainImage, label: undefined }] : []),
        ...alternativeImagesFrom(result.alternatives),
      ];
      const appended = creativeId
        ? await appendVariantsToCreative(job, creativeId, images)
        : null;
      if (!creativeId || !appended) {
        console.warn(
          `[execution-service] variantsOnly job ${job.id} has no piece in review to attach to; its pictures are dropped`,
        );
        return;
      }
      try {
        await patchCardAfterVariantsOnly(job, creativeId, appended);
      } catch (error) {
        console.error(
          "[execution-service] variantsOnly card patch failed:",
          error,
        );
      }
      return;
    }
  }

  // If a real image exists (OpenAiCreativeProvider -> openclaw infer image
  // generate), it's saved; otherwise falls back to the legacy fake placeholder.
  const generatedImage = generatedImageFrom(result.image);
  const platform =
    typeof result.platform === "string"
      ? (result.platform as SocialPlatform)
      : undefined;
  const contentFormat =
    typeof result.contentFormat === "string"
      ? (result.contentFormat as CreativeContentFormat)
      : undefined;
  const asset = generatedImage
    ? await prisma.asset.create({
        data: {
          workspaceId: job.workspaceId,
          projectId: job.projectId,
          brandId: job.brandId,
          type: "CREATIVE",
          source: "AI_GENERATED",
          filename: generatedImage.filename,
          mimeType: generatedImage.mimeType,
          storageKey: generatedImage.storageKey,
          size: generatedImage.size,
          width: generatedImage.width,
          height: generatedImage.height,
        },
      })
    : typeof result.placeholderImageUrl === "string"
      ? await prisma.asset.create({
          data: {
            workspaceId: job.workspaceId,
            projectId: job.projectId,
            brandId: job.brandId,
            type: "CREATIVE",
            source: "AI_GENERATED",
            filename: "mock-creative.png",
            mimeType: "image/png",
            storageKey: result.placeholderImageUrl,
            size: 0,
          },
        })
      : undefined;

  // The extra pictures of a variants job: one Asset each, same fields as the
  // main one. Absent for every other job (no `alternatives` key).
  const alternatives: StoredAlternative[] = [];
  if (isVariantResult) {
    for (const { image, label } of alternativeImagesFrom(result.alternatives)) {
      const altAsset = await prisma.asset.create({
        data: {
          workspaceId: job.workspaceId,
          projectId: job.projectId,
          brandId: job.brandId,
          type: "CREATIVE",
          source: "AI_GENERATED",
          filename: image.filename,
          mimeType: image.mimeType,
          storageKey: image.storageKey,
          size: image.size,
          width: image.width,
          height: image.height,
        },
      });
      alternatives.push(
        storedAlternative(altAsset, alternatives.length + 2, label),
      );
    }
  }

  // A job made for a content-plan slot (Task.payload.planCreativeId) fills
  // that slot's empty DRAFT Creative instead of creating a second one, so the
  // calendar entry keeps its channel, plan and planned time.
  const planSlot = await claimPlanCreative({
    taskId: job.taskId,
    projectId: job.projectId,
  });
  // Safety net (owner gap 04): a slot job that lost its claim still gets the
  // fallback Creative below (today's behaviour), but a piece of a Work should
  // have filled its slot, so say so.
  if (!planSlot && isWorksEnabled()) {
    await warnIfWorkSlotUnclaimed(job).catch(() => undefined);
  }
  const creative = planSlot
    ? { id: planSlot.id }
    : await prisma.creative.create({
        data: {
          workspaceId: job.workspaceId,
          projectId: job.projectId,
          brandId: job.brandId,
          type:
            job.capability === "CREATE_AD_CREATIVE"
              ? "AD_CREATIVE"
              : "SOCIAL_POST",
          status: "IN_REVIEW",
          createdByTaskId: job.taskId,
          // Only set when the task's payload actually carried a targetPlatform
          // (see task-planner.ts) — most idea->WorkPlan-generated tasks don't
          // yet, so this is often null here; regenerating later then falls back
          // to the generic 1:1 format instead of the original platform's.
          platform,
        },
      });

  let version: { id: string; version: number };
  try {
    version = await prisma.creativeVersion.create({
      data: {
        creativeId: creative.id,
        version: 1,
        assetId: asset?.id,
        caption:
          typeof result.caption === "string" ? result.caption : undefined,
        copy: typeof result.copy === "string" ? result.copy : undefined,
        contentFormat,
        generationProvider: job.providerId ?? "unknown",
        // A variants result stores the normalised alternatives (asset ids),
        // never the raw render objects.
        generationMetadata: (isVariantResult
          ? { ...result, alternatives }
          : result) as never,
      },
    });

    await prisma.creative.update({
      where: { id: creative.id },
      data: {
        currentVersionId: version.id,
        // A slot already knows its platform from its channel; only fill it in
        // when the job found out one the slot lacks.
        ...(planSlot && !planSlot.platform && platform ? { platform } : {}),
      },
    });
  } catch (error) {
    // The slot was taken but could not be filled: give it back, so it reads
    // as a failed slot again and not as "in review" with nothing in it.
    if (planSlot) await releasePlanCreative(planSlot.id).catch(() => undefined);
    throw error;
  }

  // A Creative reaching IN_REVIEW is exactly what the Agency Desk's
  // decisions cards in the Agency Desk chat are for (spec sections 28/66) — without
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
    const [task, brand] = await Promise.all([
      prisma.task.findUnique({
        where: { id: job.taskId },
        select: { title: true, departmentKey: true },
      }),
      // Creative has no brand relation (just a brandId column) — this is
      // the one extra lookup needed to show the brand's name on the card.
      prisma.brand.findUnique({
        where: { id: job.brandId },
        select: { name: true },
      }),
    ]);
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
        assetWidth: asset?.width ?? undefined,
        assetHeight: asset?.height ?? undefined,
        // A plan slot knows its platform even when the job's result did not
        // say (the card sizes and labels the piece by it).
        platform: platform ?? planSlot?.platform ?? undefined,
        contentFormat,
        approvalId: approval.id,
        versionNumber: version.version,
        brandName: brand?.name,
        ...(alternatives.length
          ? { alternatives: cardAlternatives(alternatives) }
          : {}),
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
