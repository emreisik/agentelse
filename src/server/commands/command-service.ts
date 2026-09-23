import "server-only";

import type {
  ActorType,
  CapabilityKey,
  CommandSource,
  DepartmentKey,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { AgentelseError } from "@/server/security/errors";
import {
  CommandRepository,
  type CommandAttachment,
} from "@/server/repositories/command.repository";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { ApprovalRepository } from "@/server/repositories/approval.repository";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";
import { TaskRepository } from "@/server/repositories/task.repository";
import {
  parseIntent,
  type ParsedIntent,
} from "@/server/commands/intent-router";
import { resolveProjectFromText } from "@/server/commands/project-resolver";
import { TaskPlanner } from "@/server/commands/task-planner";
import { performCreativeRevision } from "@/server/actions/creative-actions";

export type SubmitCommandInput = {
  workspaceId: string;
  source: CommandSource;
  rawText: string;
  actorType: ActorType;
  userId?: string;
  // When the caller (e.g. a project page) already knows the project — skips
  // ProjectResolver so a fuzzy text match can't misroute a follow-up message
  // to the wrong brand.
  knownProjectId?: string;
  // Set when a message is sent from an idea's own chat thread — the
  // Command gets tagged with this idea (see Command.ideaId).
  ideaId?: string;
  // Files coming from the chat surface. Saved on the command itself and
  // carried into the resulting task's payload as asset ids.
  attachments?: CommandAttachment[];
  // When provided, the rule-based parseIntent is skipped. The chat surface
  // resolves intent with the LLM; the rule-based parser returns UNKNOWN for
  // most free text and the message used to be silently dropped.
  intent?: ParsedIntent;
  // For callers that ALREADY know the intent precisely, like the composer's
  // integration quick-actions (e.g. "share on Instagram" from the "+" menu)
  // — passed through as-is to TaskPlanner.planForCapability (e.g.
  // { imageUrl, caption } for INSTAGRAM_PUBLISH). Merged with the
  // attachmentAssetIds derived from attachments (this field wins on conflict).
  payloadExtra?: Record<string, unknown>;
  // If given, the task is directly tagged with this department — the
  // department name/icon shown on chat cards comes from this field (see
  // idea-event-card.tsx).
  departmentKey?: DepartmentKey;
};

export type SubmitCommandResult =
  | {
      status: "PLANNED";
      commandId: string;
      taskId: string;
      dispatched: boolean;
      requiresApproval: boolean;
    }
  | {
      status: "NEEDS_PROJECT";
      commandId: string;
      candidates?: { projectId: string; name: string }[];
    }
  | { status: "APPROVAL_HANDLED"; commandId: string; approvalId: string }
  | { status: "UNKNOWN_INTENT"; commandId: string }
  // The capability was recognized, but it needs structured parameters
  // (budget, targeting, creative) that free text can't reliably carry — see
  // FORM_REQUIRED_CAPABILITIES below. No Task is created; formHref points
  // into the Ads Manager's create dialog instead.
  | { status: "FORM_REQUIRED"; commandId: string; formHref: string };

// Capabilities where a chat TASK intent must NOT go straight to
// TaskPlanner.planForCapability — the parameters they need (ad budget,
// targeting, a creative image) can't be reliably extracted from free text
// the way a taskBrief can for e.g. CREATE_COPY. META_ADSET_CREATE and
// META_AD_CREATE are deliberately absent from CHAT_CAPABILITIES entirely
// (see chat-turn.ts) rather than listed here — chat can't know which
// existing campaign/ad set they'd attach to, so those are only ever started
// from the Ads Manager page itself, next to the parent row.
const FORM_REQUIRED_CAPABILITIES: ReadonlySet<CapabilityKey> =
  new Set<CapabilityKey>(["META_CAMPAIGN_CREATE"]);

// `brief` becomes the New Campaign dialog's Name field default — carrying
// over what the client already typed (via intent.request, the LLM's
// taskBrief) instead of making them retype it into the form that opens
// right after. It's a starting point, not a parsed field: budget/objective
// still have to be entered explicitly, since free text can't be trusted to
// map onto those reliably.
function adsFormHref(projectId: string, brief: string): string {
  const params = new URLSearchParams({ create: "campaign", brief });
  return `/projects/${projectId}/ads?${params.toString()}`;
}

// Single entry point for turning natural-language input into work,
// regardless of where it came from (spec section 72 — Web, API, System,
// Schedule all flow through here so business logic is never duplicated per
// channel).
export const CommandService = {
  async submit(input: SubmitCommandInput): Promise<SubmitCommandResult> {
    const command = await CommandRepository.create({
      workspaceId: input.workspaceId,
      source: input.source,
      rawText: input.rawText,
      createdByUserId: input.userId,
      projectId: input.knownProjectId,
      ideaId: input.ideaId,
      attachments: input.attachments,
    });

    const intent = input.intent ?? parseIntent(input.rawText);

    await AuditLogRepository.record({
      workspaceId: input.workspaceId,
      projectId: input.knownProjectId,
      actorType: input.actorType,
      actorId: input.userId,
      action: "command.received",
      entityType: "Command",
      entityId: command.id,
      metadata: { source: input.source, intentKind: intent.kind },
    });

    if (intent.kind === "APPROVAL_DECISION") {
      const approval = await findLatestPendingApproval(
        input.workspaceId,
        input.knownProjectId,
        input.ideaId,
      );
      if (!approval) {
        return { status: "UNKNOWN_INTENT", commandId: command.id };
      }

      if (!input.userId) {
        throw new AgentelseError(
          "PERMISSION_DENIED",
          "Approval decisions require an authenticated user",
        );
      }

      if (intent.decision === "APPROVE") {
        await ApprovalRepository.decide(
          approval.id,
          approval.projectId,
          "APPROVED",
          input.userId,
        );
        if (approval.taskId) {
          await TaskPlanner.dispatchApprovedTask(
            approval.taskId,
            approval.projectId,
          );
        }
      } else if (intent.decision === "REJECT") {
        await ApprovalRepository.decide(
          approval.id,
          approval.projectId,
          "REJECTED",
          input.userId,
        );
      } else {
        await ApprovalRepository.decide(
          approval.id,
          approval.projectId,
          "REVISION_REQUESTED",
          input.userId,
          intent.note,
        );

        // Previously REVISION_REQUESTED was recorded and then never
        // consumed by anything (REVISION_REQUESTED's only legal transition
        // is -> CANCELLED, transitions.ts) — typing "revize et" in chat did
        // nothing. This is the fix: actually act on it, using whatever
        // "redo" primitive fits the approval's entity.
        if (approval.entityType === "Creative") {
          // Direct regeneration (same engine as reviseCreativeAction /
          // creative-card.tsx's Revise button) — far faster than
          // re-dispatching a whole Task through the queue, and this is
          // exactly the capability class (image generation) the user
          // complained is too slow to iterate on today.
          await performCreativeRevision({
            creativeId: approval.entityId,
            instruction: intent.note?.trim() || "",
            mode: "edit",
            userId: input.userId,
          }).catch((error) => {
            console.error("[command-service] revise (creative) failed:", error);
          });
        } else if (approval.taskId) {
          // No direct "redo" primitive exists for non-creative capabilities
          // (copy/brief/etc.) — cancel the superseded attempt and create a
          // fresh task with the feedback folded into the request, same
          // "cancel + recreate with the same context" shape
          // WorkHandoffEngine.attemptTaskCreation already uses for its own
          // retry path.
          const task = await prisma.task.findUnique({
            where: { id: approval.taskId },
            select: {
              status: true,
              workspaceId: true,
              projectId: true,
              brandId: true,
              capability: true,
              departmentKey: true,
              workPlanId: true,
              goalIds: true,
              description: true,
            },
          });
          if (
            task &&
            !["COMPLETED", "CANCELLED", "FAILED"].includes(task.status)
          ) {
            try {
              await TaskRepository.transition(
                approval.taskId,
                approval.projectId,
                "CANCELLED",
                { failureReason: "Superseded by revision request" },
              );
              await TaskPlanner.planForCapability({
                workspaceId: task.workspaceId,
                projectId: task.projectId,
                brandId: task.brandId,
                capability: task.capability,
                departmentKey: task.departmentKey ?? undefined,
                workPlanId: task.workPlanId ?? undefined,
                goalIds: task.goalIds,
                request: `${task.description ?? ""}\n\nRevision requested: ${
                  intent.note?.trim() || "please redo this"
                }`,
                createdByType: "USER",
                createdByUserId: input.userId,
              });
            } catch (error) {
              console.error("[command-service] revise (task) failed:", error);
            }
          }
        }
      }

      return {
        status: "APPROVAL_HANDLED",
        commandId: command.id,
        approvalId: approval.id,
      };
    }

    if (intent.kind !== "CAPABILITY") {
      return { status: "UNKNOWN_INTENT", commandId: command.id };
    }

    let projectId = input.knownProjectId;
    let brandId: string | undefined;

    if (!projectId) {
      const resolution = await resolveProjectFromText(
        input.workspaceId,
        input.rawText,
      );
      if (resolution.status !== "RESOLVED") {
        if (resolution.status === "AMBIGUOUS") {
          return {
            status: "NEEDS_PROJECT",
            commandId: command.id,
            candidates: resolution.candidates,
          };
        }
        return { status: "NEEDS_PROJECT", commandId: command.id };
      }
      projectId = resolution.projectId;
      brandId = resolution.brandId;
    } else {
      const brand = await prisma.brand.findFirst({
        where: { projectId, isDefault: true },
      });
      if (!brand)
        throw new AgentelseError(
          "NOT_FOUND",
          `Project ${projectId} has no default brand`,
        );
      brandId = brand.id;
    }

    await CommandRepository.attachParsedIntent(
      command.id,
      intent,
      projectId,
      brandId,
    );

    if (FORM_REQUIRED_CAPABILITIES.has(intent.capability)) {
      const formHref = adsFormHref(projectId, intent.request);
      if (command.ideaId) {
        await IdeaChatRepository.postAdsFormPromptCard({
          workspaceId: input.workspaceId,
          projectId,
          ideaId: command.ideaId,
          title: intent.request,
          formHref,
          departmentKey: input.departmentKey,
        }).catch((error) => {
          console.error(
            "[command-service] postAdsFormPromptCard failed:",
            error,
          );
        });
      }
      return { status: "FORM_REQUIRED", commandId: command.id, formHref };
    }

    const attachmentPayloadExtra = input.attachments?.length
      ? { attachmentAssetIds: input.attachments.map((a) => a.assetId) }
      : undefined;

    const plan = await TaskPlanner.planForCapability({
      workspaceId: input.workspaceId,
      projectId,
      brandId,
      commandId: command.id,
      capability: intent.capability,
      targetPlatform: intent.targetPlatform,
      request: intent.request,
      createdByType: input.actorType,
      createdByUserId: input.userId,
      departmentKey: input.departmentKey,
      // Attachments are carried into the task's payload: the execution
      // provider (e.g. creative image generation) finds the user's
      // reference image here.
      payloadExtra:
        attachmentPayloadExtra || input.payloadExtra
          ? { ...attachmentPayloadExtra, ...input.payloadExtra }
          : undefined,
    });

    return {
      status: "PLANNED",
      commandId: command.id,
      taskId: plan.task.id,
      dispatched: plan.dispatched,
      requiresApproval: !plan.dispatched && !("deferred" in plan),
    };
  },
};

// When the command comes from a specific idea's chat thread (input.ideaId),
// "I approve" must resolve to THAT idea's pending approval — not just the
// most recently created one in the project. Two ideas in the same project
// can easily have overlapping pending approvals (e.g. two work-plan nodes
// clearing their dependencies around the same time), and picking the wrong
// one means approving/rejecting work the user never looked at.
async function findLatestPendingApproval(
  workspaceId: string,
  projectId?: string,
  ideaId?: string,
) {
  const pending = await prisma.approval.findMany({
    where: {
      workspaceId,
      status: "PENDING",
      ...(projectId ? { projectId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  if (ideaId) {
    for (const approval of pending) {
      if (!approval.taskId) continue;
      const resolvedIdeaId = await IdeaChatRepository.resolveIdeaIdForTask(
        approval.taskId,
      );
      if (resolvedIdeaId === ideaId) return approval;
    }
    // No pending approval tied to THIS idea — fall through to the
    // project-wide "most recent" behavior below, since not every approval
    // flow is idea-scoped (e.g. commands sent outside an idea thread).
  }

  return pending[0] ?? null;
}
