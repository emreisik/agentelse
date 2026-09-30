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
import type { NeedsInput } from "@/server/commands/needs-input";
import { missingCapabilityInput } from "@/server/execution/capability-input";
import { MemoryService } from "@/server/memory/memory-service";
import { ensureProjectActive } from "@/server/projects/activation";
import { performCreativeRevision } from "@/server/actions/creative-actions";
import { createStrategicIdea } from "@/server/commands/strategic-request";
import { IdeaFoundry } from "@/server/agency/ideas/idea-foundry";
import {
  planWeeklyInstagramContent,
  summarizeWeeklyPlanResult,
  weeklyPlanConfigFromSchedule,
  type WeeklyPlanResult,
} from "@/server/agency/content/instagram-week-planner";

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
  // An already-created Command row for this turn (streaming chat engine) —
  // submit skips its own CommandRepository.create and works on this row.
  existingCommandId?: string;
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
  // Passed straight through to Command.topic (see schema.prisma's comment
  // on that column) — for a caller whose resulting Command row shouldn't
  // show up as its own bubble in the general chat feed (e.g. a publish
  // quick-action whose progress is instead mirrored onto an existing
  // creative-ready card, see publish-creative.ts).
  topic?: string;
  // Passed through to TaskPlanner.planForCapability — see its comment.
  contentApproved?: boolean;
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
  // The project is on hold (PAUSED or CLOSED), so it can't take new work. A
  // project that simply hasn't run setup is NOT on hold: ensureProjectActive
  // (projects/activation.ts) activates it on the spot. No
  // Task/StrategicIdea/idea-generation is created; the chat turns this into an
  // honest "the project is on hold" reply. Never returned for work the setup
  // pipeline itself starts — that goes through TaskPlanner.planForCapability
  // directly, not through this function.
  | { status: "PROJECT_INACTIVE"; commandId: string }
  // The capability was recognized, but it needs structured parameters
  // (budget, targeting, creative) that free text can't reliably carry — see
  // FORM_REQUIRED_CAPABILITIES below. No Task is created; formHref points
  // into the Ads Manager's create dialog instead.
  | { status: "FORM_REQUIRED"; commandId: string; formHref: string }
  // The capability needs an input free text did not carry (SOCIAL_ACCOUNT_SETUP
  // needs the platform to open the account on, see execution/capability-input.ts).
  // No Task or Approval exists: creating one used to be found out only after a
  // person had approved it. With approvalId set it is the other way round: the
  // task already exists and its approval was NOT consumed. Callers ask for the
  // input (needs-input.ts) instead of promising work.
  | ({ status: "NEEDS_INPUT"; commandId: string } & NeedsInput)
  // Deep Path (see strategic-request.ts) — a new Idea was created and the
  // Command was retroactively linked to its thread.
  | { status: "STRATEGIC_IDEA_CREATED"; commandId: string; ideaId: string }
  // Same maxActiveIdeas cap createStrategicIdea checks — chat-service.ts
  // turns this into the existing limit-notice "active-ideas" card.
  | { status: "IDEA_CAP_REACHED"; commandId: string }
  // A chat-triggered "plan this week" (CREATE_CONTENT_PLAN, general chat
  // only — see the branch below) ran the real batch planner synchronously
  // and it already finished by the time this returns — summary becomes the
  // direct reply text and result (which already carries items, see
  // WeeklyPlanResult) becomes the SAME visual "content-plan-summary" card
  // the cron path posts (chat-service.ts attaches it via
  // CommandRepository.attachParsedIntent, the same mechanism the
  // `question` card already uses). The per-idea creative-ready cards are
  // posted by planWeeklyInstagramContent itself as it runs; its own
  // end-of-batch summary message is skipped here (skipSummaryMessage) so
  // it doesn't duplicate this same content twice.
  | {
      status: "WEEKLY_PLAN_CREATED";
      commandId: string;
      summary: string;
      result: WeeklyPlanResult;
    }
  // Chat-triggered on-demand draw from the existing EVALUATED opportunity
  // backlog (idea generation is no longer continuous/tick-driven — see
  // idea-foundry.ts/agency-wiring.ts). Each new idea already gets its own
  // "idea" card posted to its own thread by IdeaFoundry itself
  // (idea-foundry.ts's postSystemMessage call) — count is only for the
  // general chat's own plain-text summary reply.
  | {
      status: "IDEAS_GENERATED_FROM_OPPORTUNITIES";
      commandId: string;
      count: number;
    };

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
    // The streaming chat engine records the Command before the first token
    // (so a dropped connection never loses the message) and passes its id
    // here — reuse that row instead of creating a second one for the turn.
    const command = input.existingCommandId
      ? { id: input.existingCommandId, ideaId: input.ideaId ?? null }
      : await CommandRepository.create({
          workspaceId: input.workspaceId,
          source: input.source,
          rawText: input.rawText,
          createdByUserId: input.userId,
          projectId: input.knownProjectId,
          ideaId: input.ideaId,
          attachments: input.attachments,
          topic: input.topic,
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

      // A decision about a finished creative is a signal about the client's
      // taste (kept as a tentative memory, never a rule after one decision).
      const reactToCreative = (
        outcome: "APPROVED" | "REJECTED" | "REVISION_REQUESTED",
        note?: string,
      ) =>
        approval.entityType === "Creative"
          ? MemoryService.rememberCreativeReaction({
              scope: {
                workspaceId: approval.workspaceId,
                projectId: approval.projectId,
                brandId: approval.brandId,
              },
              creativeId: approval.entityId,
              outcome,
              note,
            })
          : undefined;

      if (intent.decision === "APPROVE") {
        // A task that can never run is not approved into a failure: check first,
        // while the approval can still be rejected.
        if (approval.taskId) {
          const missing = await TaskPlanner.missingInputFor(
            approval.taskId,
            approval.projectId,
          );
          if (missing) {
            return {
              status: "NEEDS_INPUT",
              commandId: command.id,
              approvalId: approval.id,
              ...missing,
            };
          }
        }
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
        await reactToCreative("APPROVED");
      } else if (intent.decision === "REJECT") {
        await ApprovalRepository.decide(
          approval.id,
          approval.projectId,
          "REJECTED",
          input.userId,
        );
        await reactToCreative("REJECTED");
      } else {
        await ApprovalRepository.decide(
          approval.id,
          approval.projectId,
          "REVISION_REQUESTED",
          input.userId,
          intent.note,
        );
        await reactToCreative("REVISION_REQUESTED", intent.note);

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

    if (
      intent.kind !== "CAPABILITY" &&
      intent.kind !== "STRATEGIC_REQUEST" &&
      intent.kind !== "GENERATE_IDEAS_FROM_OPPORTUNITIES"
    ) {
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

    // Gate: nothing user-triggered (chat, composer shortcuts, quick actions —
    // every caller of this function, see its module comment) may start real
    // work on a project that is on hold. It used to also wait for the brand's
    // 12-stage setup to reach PROJECT_ACTIVATION; that made the client sit
    // through onboarding before the first answer, so a project that has not
    // finished (or started) setup is now simply activated here, and PAUSED /
    // CLOSED are the only ones refused. The setup pipeline itself and the
    // scheduler never call CommandService — they use
    // TaskPlanner.planForCapability directly.
    const activation = await ensureProjectActive(projectId);
    if (!activation.usable) {
      return { status: "PROJECT_INACTIVE", commandId: command.id };
    }

    await CommandRepository.attachParsedIntent(
      command.id,
      intent,
      projectId,
      brandId,
    );

    if (intent.kind === "STRATEGIC_REQUEST") {
      const result = await createStrategicIdea(
        { workspaceId: input.workspaceId, projectId, brandId },
        {
          title: intent.title,
          description: intent.description,
          departments: intent.departments,
        },
      );
      if (result.status === "CAPPED") {
        return { status: "IDEA_CAP_REACHED", commandId: command.id };
      }
      await CommandRepository.attachIdeaId(command.id, result.ideaId);
      return {
        status: "STRATEGIC_IDEA_CREATED",
        commandId: command.id,
        ideaId: result.ideaId,
      };
    }

    // On-demand draw from the existing EVALUATED opportunity backlog
    // ("give me some new ideas") — idea generation stopped being
    // continuous/tick-driven (see agency-wiring.ts), so this is now one of
    // only two ways new ideas get created (the other being a project's own
    // GENERATE_IDEAS ProjectSchedule, see scheduler-service.ts).
    if (intent.kind === "GENERATE_IDEAS_FROM_OPPORTUNITIES") {
      const count = await IdeaFoundry.generateForTopOpportunities(5, {
        projectId,
      });
      return {
        status: "IDEAS_GENERATED_FROM_OPPORTUNITIES",
        commandId: command.id,
        count,
      };
    }

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

    // Asked for here, before any Task or Approval exists. `payloadExtra` wins
    // over the intent's platform exactly as it does in the task payload.
    const missing = missingCapabilityInput(intent.capability, {
      platform: input.payloadExtra?.platform ?? intent.targetPlatform,
    });
    if (missing) {
      return { status: "NEEDS_INPUT", commandId: command.id, ...missing };
    }

    // Weekly batch content planning triggered directly from chat ("Plan
    // the week" quick action, or free text) — runs the SAME autonomous
    // planner the cron path uses (instagram-week-planner.ts), not a
    // generic text answer describing what a plan might look like.
    // !command.ideaId: general chat only — an idea's own work-plan content
    // plan (a single document for ONE idea, work-plan-builder.ts) is a
    // completely different thing and must not be hijacked by this branch.
    if (intent.capability === "CREATE_CONTENT_PLAN" && !command.ideaId) {
      const schedule = await prisma.projectSchedule.findFirst({
        where: { projectId, capability: "CREATE_CONTENT_PLAN" },
        select: { configuration: true },
      });
      const config = (schedule?.configuration ?? {}) as Record<string, unknown>;
      const { dailyImageCap, lensMix } = weeklyPlanConfigFromSchedule(config);

      const result = await planWeeklyInstagramContent(
        { workspaceId: input.workspaceId, projectId, brandId },
        dailyImageCap,
        { lensMix, skipSummaryMessage: true },
      );

      return {
        status: "WEEKLY_PLAN_CREATED",
        commandId: command.id,
        summary: summarizeWeeklyPlanResult(result),
        result,
      };
    }

    const attachmentPayloadExtra = input.attachments?.length
      ? { attachmentAssetIds: input.attachments.map((a) => a.assetId) }
      : undefined;
    // Threads a chat-detected Story/Reel/etc request (intent-router.ts's
    // rule-based detectContentFormat, or chat-turn.ts's LLM-set field)
    // through to the creative provider's getCreativePlatformFormat call —
    // same payload mechanism attachments already use below. Without this,
    // the intent carried the format but nothing ever read it back out.
    const contentFormatPayloadExtra = intent.contentFormat
      ? { contentFormat: intent.contentFormat }
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
      contentApproved: input.contentApproved,
      // Attachments are carried into the task's payload: the execution
      // provider (e.g. creative image generation) finds the user's
      // reference image here.
      payloadExtra:
        attachmentPayloadExtra ||
        contentFormatPayloadExtra ||
        input.payloadExtra
          ? {
              ...attachmentPayloadExtra,
              ...contentFormatPayloadExtra,
              ...input.payloadExtra,
            }
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
