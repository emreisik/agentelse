import "server-only";

import { ReasoningService } from "@/server/reasoning/reasoning-service";
import {
  chatTurnDef,
  type ChatTurnOutput,
} from "@/server/reasoning/prompts/chat-turn";
import { CommandService } from "@/server/commands/command-service";
import {
  CommandRepository,
  type CommandAttachment,
  type CommandReplyStatus,
} from "@/server/repositories/command.repository";
import type { ParsedIntent } from "@/server/commands/intent-router";
import {
  limitNoticeFromError,
  limitNoticeReplyText,
} from "@/server/commands/limit-notice";
import type { IdeaEventCardData } from "@/types/idea-event-card";
import { recordUserDecision } from "@/server/brand-twin/brand-twin-writes";
import { startAgencySetupForProject } from "@/server/actions/agency-setup-actions";
import { buildContext } from "@/server/chat/context";

export type ChatTurnInput = {
  workspaceId: string;
  projectId: string;
  userId: string;
  message: string;
  attachments?: CommandAttachment[];
  // Bodies sent to the reasoning backend as inline attachments; same order
  // as attachments.
  // Carried separately because the base64 body isn't written to the
  // Command row (it would bloat the JSON) — it's only shown to the model.
  attachmentBodies?: { mimeType: string; data: string }[];
  // Set when a message is sent from an idea's own chat thread — the
  // Command gets tagged with this idea AND the history context
  // (buildContext) is scoped to this idea's thread instead of project-wide.
  ideaId?: string;
};

export type ChatTurnResult = {
  commandId: string;
  reply: string;
  status: CommandReplyStatus;
  // Set when the reply is a structured chat card (today: the limit-notice
  // card explaining why no reply could be generated). The client renders
  // this instead of the plain reply text, without waiting for the next
  // server refresh.
  card?: IdeaEventCardData;
};

// Server side of the chat screen: on every user message, gathers the brand
// context, has the LLM produce an intent + reply, hands off to
// CommandService if it's a work request, and saves the reply to the
// Command row — so on page reload the conversation history comes back
// from the database exactly as it was.
export const ChatService = {
  async turn(input: ChatTurnInput): Promise<ChatTurnResult> {
    const context = await buildContext(input.projectId, input.ideaId);

    let turn: ChatTurnOutput;
    try {
      const result = await ReasoningService.run(chatTurnDef, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: context.brandId,
        attachments: input.attachmentBodies,
        context: {
          project: context.project,
          brand: context.brand,
          state: context.state,
          pending: context.pending,
          history: context.history,
          attachments: (input.attachments ?? []).map((attachment) => ({
            filename: attachment.filename,
            mimeType: attachment.mimeType,
          })),
          message: input.message,
          setupPhase: context.setupPhase,
          setupWaiting: context.setupWaiting,
        },
      });
      turn = result.output;
    } catch (error) {
      // A recognized block (daily cap/budget hit, provider key missing,
      // provider rate-limited/timed out): don't queue fallback work — it
      // would hit the same wall in the worker — record the message with a
      // limit-notice card instead. The card explains the cause and (for
      // caps) links into the autonomy settings panel (idea-event-card.tsx).
      const notice = limitNoticeFromError(error);
      if (notice) {
        const command = await CommandRepository.create({
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          brandId: context.brandId,
          ideaId: input.ideaId,
          source: "WEB",
          rawText: input.message,
          parsedIntent: { card: notice },
          createdByUserId: input.userId,
          attachments: input.attachments,
        });
        const reply = limitNoticeReplyText(notice);
        await CommandRepository.recordReply(command.id, reply, "ERROR");
        return { commandId: command.id, reply, status: "ERROR", card: notice };
      }

      // Even if the LLM fails, the message must not be lost: the command is
      // still recorded, the rule-based parser kicks in (legacy behavior),
      // and an honest error message is written as the reply. Since the
      // real cause (invalid key, model not found, quota, etc.) is never
      // shown to the user, it would be lost entirely if not logged here.
      console.error(
        "[chat-service] Reasoning failed, falling back to rule-based intent:",
        error instanceof Error ? error.message : error,
      );
      const fallback = await CommandService.submit({
        workspaceId: input.workspaceId,
        source: "WEB",
        rawText: input.message,
        actorType: "USER",
        userId: input.userId,
        knownProjectId: input.projectId,
        ideaId: input.ideaId,
        attachments: input.attachments,
      });
      const reply =
        fallback.status === "PLANNED"
          ? "Got your request as a task. (The AI reply couldn't be generated right now, but the work was still queued.)"
          : `I can't generate a reply right now: ${error instanceof Error ? error.message : "unknown error"}. Please try again.`;
      const status: CommandReplyStatus =
        fallback.status === "PLANNED" ? "PLANNED" : "ERROR";
      await CommandRepository.recordReply(fallback.commandId, reply, status);
      return { commandId: fallback.commandId, reply, status };
    }

    // Conversational setup intake (see chat-turn.ts's NOT_STARTED block):
    // once the LLM has brandName and the client agreed to proceed, start the
    // real 12-stage pipeline right here instead of routing this turn through
    // CommandService — collecting brand info isn't a capability/task, it's
    // what unlocks them. Recorded as a plain Command (no intent to attach).
    if (
      context.setupPhase === "NOT_STARTED" &&
      turn.setupIntake?.ready &&
      turn.setupIntake.brandName?.trim()
    ) {
      const command = await CommandRepository.create({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: context.brandId,
        ideaId: input.ideaId,
        source: "WEB",
        rawText: input.message,
        createdByUserId: input.userId,
        attachments: input.attachments,
      });
      const result = await startAgencySetupForProject({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        brandId: context.brandId,
        userId: input.userId,
        brandName: turn.setupIntake.brandName.trim(),
        domain: turn.setupIntake.domain?.trim() || undefined,
        description: turn.setupIntake.description?.trim() || undefined,
        autoApprove: turn.setupIntake.autoApprove,
      });
      // Always the canned text below, never turn.reply verbatim: this is a
      // state transition (setup just STARTED, nothing is done yet) and the
      // model has been observed claiming setup was already complete and
      // offering to create work right away — both wrong at this point and
      // exactly what the gate above exists to prevent. status "ANSWERED"
      // (not "PLANNED") since no Task was created — see STATUS_NOTE in
      // project-chat.tsx, which would otherwise show a misleading
      // "Task created" badge on this message.
      const reply = result.ok
        ? "Got it — starting setup now. I'll work through discovery, the brand constitution, goals and the first work plan in the background, and let you know here as it progresses."
        : "Got it, but I couldn't start setup just now — please try again in a moment.";
      const status: CommandReplyStatus = result.ok ? "ANSWERED" : "ERROR";
      await CommandRepository.recordReply(command.id, reply, status);
      return { commandId: command.id, reply, status };
    }

    // Convert the LLM's decision into the intent CommandService understands.
    // For TASK, taskBrief is used (chat context embedded); otherwise the raw message.
    const intent = toParsedIntent(turn, input.message);

    const submission = await CommandService.submit({
      workspaceId: input.workspaceId,
      source: "WEB",
      rawText: input.message,
      actorType: "USER",
      userId: input.userId,
      knownProjectId: input.projectId,
      ideaId: input.ideaId,
      attachments: input.attachments,
      intent,
    });

    let reply = turn.reply.trim() || "Got it.";
    let status: CommandReplyStatus;

    switch (submission.status) {
      case "PLANNED":
        status = "PLANNED";
        if (submission.requiresApproval) {
          reply +=
            "\n\nThis work is critical, so it'll come to you for approval first.";
        }
        break;
      case "APPROVAL_HANDLED":
        status = "APPROVAL_HANDLED";
        break;
      case "FORM_REQUIRED":
        // No Task/Approval was created — the ads-form-prompt card (posted
        // by CommandService when ideaId is known) carries the actual CTA;
        // this reply is just the plain-text fallback for project-wide chat
        // (no ideaId) where the card can't be posted.
        status = "ANSWERED";
        reply += `\n\nOpen the form to finish this: ${submission.formHref}`;
        break;
      case "NEEDS_PROJECT":
        // In practice this never happens since knownProjectId is always provided.
        status = "NEEDS_PROJECT";
        break;
      case "STRATEGIC_IDEA_CREATED":
        // Deep Path (strategic-request.ts) — single-chat consolidation:
        // this no longer opens a separate thread, the idea's own pipeline
        // events (council, work-plan, creative results) now land right
        // here as they happen.
        status = "PLANNED";
        reply +=
          "\n\nI'll keep working through this right here — I'll post updates as they come in.";
        break;
      case "IDEA_CAP_REACHED":
        status = "ERROR";
        reply = limitNoticeReplyText({
          kind: "limit-notice",
          reason: "active-ideas",
        });
        break;
      case "WEEKLY_PLAN_CREATED":
        // The batch already ran synchronously by the time this returns —
        // the real numbers are more useful than whatever the LLM guessed
        // the outcome would be, so this replaces reply entirely (same
        // pattern as IDEA_CAP_REACHED above).
        status = "PLANNED";
        reply = submission.summary;
        break;
      case "IDEAS_GENERATED_FROM_OPPORTUNITIES":
        // Same reasoning as WEEKLY_PLAN_CREATED above: the real count is
        // more useful than whatever the LLM's reply guessed. Each new idea
        // already gets its own "idea" card posted to its own thread by
        // IdeaFoundry itself, so this is only the general chat's summary.
        status = "PLANNED";
        reply =
          submission.count > 0
            ? `💡 Generated ${submission.count} new idea${submission.count === 1 ? "" : "s"} from the opportunity backlog — each has its own thread now.`
            : "There's no evaluated opportunity ready to turn into an idea right now. New signals are still being scanned in the background — try again once a few more come in.";
        break;
      case "SETUP_REQUIRED":
        // Backstop for when the LLM didn't follow chat-turn.ts's NOT_STARTED/
        // IN_PROGRESS instructions and set a TASK/STRATEGIC/generate-ideas
        // intent anyway — CommandService already refused to create any
        // work, this just makes sure the client sees an honest reply
        // instead of one promising work that was never queued.
        status = "ANSWERED";
        reply =
          "The brand's setup is still in progress, so I can't start new work yet — once it's done I'll be able to take this on.";
        break;
      default:
        status = turn.intentKind === "UNCLEAR" ? "UNCLEAR" : "ANSWERED";
        break;
    }

    await CommandRepository.recordReply(submission.commandId, reply, status);

    // Best-effort, never blocks the reply the client is waiting for: the
    // client's message itself stated a durable preference/rule (spec:
    // "More premium." -> CREATIVE_PREFERENCE) — record it once as a
    // UserDecision so future turns (via BrandTwin.creativePreferences
    // above) and other surfaces (the Brand Workspace right panel) see it,
    // instead of it only ever being recoverable by re-reading raw history.
    if (turn.preference) {
      await recordUserDecision({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: context.brandId,
        type: turn.preference.type,
        scope: turn.preference.scope,
        value: turn.preference.value,
        rawMessage: input.message,
        sourceCommandId: submission.commandId,
        createdByUserId: input.userId,
      }).catch((error) => {
        console.error("[chat-service] failed to record user decision:", error);
      });
    }

    // A genuine fork worth pickable options (chat-turn.ts's `questions`) —
    // attach it as a card on this same Command so it renders instead of
    // (alongside) the plain reply text, and survives reload. Deliberately
    // NOT routed through CommandService.submit's own attachParsedIntent
    // (that call only fires for CAPABILITY intents, see its early
    // UNKNOWN_INTENT return) — this is a second, additive write scoped to
    // just the `card` key.
    let card: IdeaEventCardData | undefined;
    if (turn.questions && turn.questions.length > 0) {
      card = {
        kind: "question",
        questions: turn.questions,
        projectId: input.projectId,
        ideaId: input.ideaId,
      };
    } else if (submission.status === "IDEA_CAP_REACHED") {
      // Same card the reasoning-failure catch block above uses for every
      // other daily-cap hit — reused here so an idea-cap hit from the Deep
      // Path gets the identical, already-designed "here's why, here's how
      // to fix it" treatment instead of plain text.
      card = { kind: "limit-notice", reason: "active-ideas" };
    } else if (submission.status === "WEEKLY_PLAN_CREATED") {
      // Same visual card the cron-triggered path posts (see
      // instagram-week-planner.ts) — the chat-triggered "Plan this week"
      // gets the identical mini-grid instead of only the plain-text
      // summary already set as `reply` above.
      card = { kind: "content-plan-summary", ...submission.result };
    }
    if (card) {
      await CommandRepository.attachParsedIntent(
        submission.commandId,
        { card },
        input.projectId,
        context.brandId,
      ).catch((error) => {
        console.error("[chat-service] failed to attach card:", error);
      });
    }

    return { commandId: submission.commandId, reply, status, card };
  },
};

function toParsedIntent(turn: ChatTurnOutput, message: string): ParsedIntent {
  // Checked before STRATEGIC_REQUEST below: a request for fresh ideas drawn
  // from the existing opportunity backlog must never be mistaken for a
  // brand-new research/strategy thread, even if the LLM sets both flags by
  // mistake (they're documented as mutually exclusive in chat-turn.ts).
  if (turn.intentKind === "TASK" && turn.generateIdeasFromOpportunities) {
    return { kind: "GENERATE_IDEAS_FROM_OPPORTUNITIES" };
  }
  // Deep Path — checked before the single-capability TASK branch below, so
  // a strategic request never also gets routed as a Fast Path task. Falls
  // through to that branch (not this one) if `title` is missing, since
  // createStrategicIdea requires both title and description.
  if (turn.intentKind === "TASK" && turn.strategic && turn.title) {
    return {
      kind: "STRATEGIC_REQUEST",
      title: turn.title.trim().slice(0, 80),
      description: turn.taskBrief?.trim() || message,
      departments: turn.departments,
    };
  }
  if (turn.intentKind === "TASK" && turn.capability) {
    return {
      kind: "CAPABILITY",
      capability: turn.capability,
      targetPlatform: turn.platform,
      contentFormat: turn.contentFormat,
      request: turn.taskBrief?.trim() || message,
    };
  }
  if (turn.intentKind === "APPROVAL" && turn.approvalDecision) {
    return {
      kind: "APPROVAL_DECISION",
      decision: turn.approvalDecision,
      note: turn.approvalDecision === "REVISE" ? message : undefined,
    };
  }
  // ANSWER and UNCLEAR don't open a task — CommandService records the
  // command and returns UNKNOWN_INTENT; the reply already came from the LLM.
  return { kind: "UNKNOWN" };
}
