import "server-only";

import { z, type ZodType } from "zod";
import type { Tool } from "openai/resources/responses/responses";
import {
  CreativeContentFormat,
  DepartmentKey,
  UserDecisionType,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { getBrandTwin } from "@/server/brand-twin/brand-twin";
import { describeLayout, type LayoutTemplates } from "@/lib/layout-templates";
import { resolveBrandStyleContext } from "@/server/media/brand-style-context";
import { readLayoutMeta } from "@/server/media/creative-layout";
import { subscribeCreativeProgress } from "@/server/media/creative-progress";
import { getPublishTargets } from "@/server/integrations/meta-connection-status";
import { getChannelConnections } from "@/server/integrations/channel-connections";
import { parsePlanBrief, validatePlanAgainstBrief } from "@/lib/plan-brief";
import {
  ContentPlanArgsSchema,
  buildPlanCard,
  getProjectTimezone,
  supersedeOpenDrafts,
  todayInTimezone,
  validatePlanChannels,
  validatePlanDates,
} from "./content-plan";
import { startAgencySetupForProject } from "@/server/actions/agency-setup-actions";
import { recordUserDecision } from "@/server/brand-twin/brand-twin-writes";
import {
  CommandService,
  type SubmitCommandResult,
} from "@/server/commands/command-service";
import type { ParsedIntent } from "@/server/commands/intent-router";
import { limitNoticeReplyText } from "@/server/commands/limit-notice";
import type {
  CommandAttachment,
  CommandReplyStatus,
} from "@/server/repositories/command.repository";
import { CHAT_CAPABILITIES, CHAT_PLATFORMS } from "./constants";
import type { IdeaEventCardData } from "@/types/idea-event-card";
import { activeDeliverables } from "./deliverables";
import { driveJobInline } from "./inline-job";
import {
  buildPackageCard,
  ContentPackageArgsSchema,
  supersedeOpenPackages,
  validatePackageItems,
} from "./content-package";

import type { ChatStreamEvent } from "./types";

// What the chat agent may do on this project right now. ACTIVE is the normal
// case: a project no longer has to finish setup before it can work (see
// projects/activation.ts). ON_HOLD is a paused or closed project, where the
// agent can still talk and look things up but must not start anything.
export type ChatPhase = "ACTIVE" | "ON_HOLD";

// Everything a tool needs to act on behalf of the current chat turn.
export type ToolContext = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  userId: string;
  ideaId?: string;
  // The Command row created for this turn before the first token.
  commandId: string;
  message: string;
  attachments?: CommandAttachment[];
  phase: ChatPhase;
  // Pushes a stream event to the client WHILE the tool is still running
  // (e.g. a preview of an image being generated). The agent loop forwards
  // queued events as they arrive instead of waiting for execute() to return.
  emit: (event: ChatStreamEvent) => void;
};

export type ToolOutcome = {
  // JSON handed back to the model as the function_call_output.
  result: unknown;
  // Overrides the turn's reply status (default ANSWERED).
  status?: CommandReplyStatus;
  // A chat card to render (and persist on the Command) for this outcome.
  card?: IdeaEventCardData;
  // Deterministic text appended to the reply after the model's own words
  // (e.g. a form link the model must not paraphrase away).
  appendReply?: string;
  // Follow-up prompts to offer under the reply (suggest_replies).
  suggestions?: string[];
};

// work     — turns the message into agency work through CommandService.submit
//            (or starts setup); at most ONE per chat turn, so a turn maps to
//            exactly one Command and a retry can never duplicate work.
// terminal — ends the turn with a card, no more model output afterwards.
// note     — small side effect that doesn't create work (remember_preference).
// read     — looks something up (no side effect); may run any number of times.
export type ToolKind = "work" | "terminal" | "note" | "read";

export type ChatTool<TArgs = unknown> = {
  name: string;
  // Shown live in the chat while the tool runs.
  label: string;
  description: string;
  kind: ToolKind;
  // Phases in which the tool is offered. Gating here (not in prompt prose)
  // means a model that ignores instructions still can't start work on a
  // paused or closed project; CommandService's own PROJECT_INACTIVE gate
  // stays as the backstop.
  phases: readonly ChatPhase[];
  schema: ZodType<TArgs>;
  execute(args: TArgs, ctx: ToolContext): Promise<ToolOutcome>;
};

function defineTool<TArgs>(tool: ChatTool<TArgs>): ChatTool {
  return tool as unknown as ChatTool;
}

const QuestionSchema = z.object({
  question: z.string(),
  options: z
    .array(z.object({ label: z.string(), description: z.string().optional() }))
    .min(2)
    .max(4),
  multiSelect: z.boolean().optional(),
});

async function submitIntent(
  ctx: ToolContext,
  intent: ParsedIntent,
  payloadExtra?: Record<string, unknown>,
): Promise<SubmitCommandResult> {
  return CommandService.submit({
    workspaceId: ctx.workspaceId,
    source: "WEB",
    rawText: ctx.message,
    actorType: "USER",
    userId: ctx.userId,
    knownProjectId: ctx.projectId,
    ideaId: ctx.ideaId,
    attachments: ctx.attachments,
    intent,
    payloadExtra,
    existingCommandId: ctx.commandId,
  });
}

// Turns CommandService's tagged result into (a) facts the model can phrase a
// reply from and (b) the reply status / card / fixed text the app owns. Where
// the real numbers or wording matter more than the model's guess (caps, plan
// summaries, form links) the outcome carries them explicitly.
export function outcomeFromSubmission(
  submission: SubmitCommandResult,
): ToolOutcome {
  switch (submission.status) {
    case "PLANNED":
      return {
        status: "PLANNED",
        result: {
          outcome: "task_created",
          requiresApproval: submission.requiresApproval,
          note: "The work is queued. Do not claim it is finished.",
        },
        appendReply: submission.requiresApproval
          ? "This work is critical, so it'll come to you for approval first."
          : undefined,
      };
    case "APPROVAL_HANDLED":
      return {
        status: "APPROVAL_HANDLED",
        result: { outcome: "approval_decided" },
      };
    case "FORM_REQUIRED":
      return {
        result: {
          outcome: "form_required",
          note: "This needs structured input; the client is being sent a link to a form.",
        },
        appendReply: `Open the form to finish this: ${submission.formHref}`,
      };
    case "STRATEGIC_IDEA_CREATED":
      return {
        status: "PLANNED",
        result: {
          outcome: "strategic_project_started",
          note: "A new thread is being worked on in this same chat; updates will be posted here as they come in.",
        },
      };
    case "IDEA_CAP_REACHED": {
      const card: IdeaEventCardData = {
        kind: "limit-notice",
        reason: "active-ideas",
      };
      return {
        status: "ERROR",
        card,
        result: {
          outcome: "blocked_idea_cap",
          explanation: limitNoticeReplyText({
            kind: "limit-notice",
            reason: "active-ideas",
          }),
        },
      };
    }
    case "WEEKLY_PLAN_CREATED":
      // The planner only picks from SHORTLISTED ideas. With none, the "0/0
      // created" summary card says nothing useful and would also hide the
      // model's explanation (a card replaces the reply text), so answer in
      // words and point at the way forward instead.
      if (submission.result.ideasConsidered === 0) {
        return {
          status: "ANSWERED",
          result: {
            outcome: "weekly_plan_empty",
            note: "There are no shortlisted ideas to build a weekly plan from yet, so nothing was created. Tell the client this plainly and offer to generate fresh ideas from the opportunity backlog first (or to plan around a specific brief).",
          },
        };
      }
      return {
        status: "PLANNED",
        card: { kind: "content-plan-summary", ...submission.result },
        result: { outcome: "weekly_plan_created", summary: submission.summary },
      };
    case "IDEAS_GENERATED_FROM_OPPORTUNITIES":
      return {
        status: "PLANNED",
        result: {
          outcome: "ideas_generated",
          count: submission.count,
          note:
            submission.count > 0
              ? "Each new idea already has its own thread."
              : "There was no evaluated opportunity ready to turn into an idea; new signals are still being scanned.",
        },
      };
    case "PROJECT_INACTIVE":
      return {
        result: {
          outcome: "blocked_project_on_hold",
          note: "The project is paused or closed, so no new work could be started. Say so honestly and that it must be resumed first.",
        },
      };
    case "NEEDS_PROJECT":
      return { status: "NEEDS_PROJECT", result: { outcome: "needs_project" } };
    case "UNKNOWN_INTENT":
      return { result: { outcome: "nothing_to_do" } };
  }
}

// Content planning has its own conversational flow (propose_content_plan),
// so the batch-planner capability is deliberately not offered as a task —
// the model would otherwise route "plan the week" into the shortlist-based
// planner and its empty "0/0 created" outcome.
// Likewise CREATE_SOCIAL_CREATIVE has its own tool (generate_image) that
// renders inline in the chat instead of queueing behind the worker. Ad
// creatives are excluded for the same reason: a model asked for "a post"
// picked CREATE_AD_CREATIVE and queued it instead of rendering live.
type TaskCapability = Exclude<
  (typeof CHAT_CAPABILITIES)[number],
  "CREATE_CONTENT_PLAN" | "CREATE_SOCIAL_CREATIVE" | "CREATE_AD_CREATIVE"
>;
const TASK_CAPABILITIES = CHAT_CAPABILITIES.filter(
  (capability) =>
    capability !== "CREATE_CONTENT_PLAN" &&
    capability !== "CREATE_SOCIAL_CREATIVE" &&
    capability !== "CREATE_AD_CREATIVE",
) as unknown as [TaskCapability, ...TaskCapability[]];

// Instagram has three formats the client must choose between (Post 3:4,
// Story/Reel 9:16, square 1:1), so a creative for Instagram — or for an
// unnamed channel, which resolves to the project's primary platform — is
// never produced with a guessed format. The question is rendered by the app
// itself as a card (not left to the model calling ask_user), so it always
// appears; the client's click comes back as a normal message and the model
// then calls generate_image again with the chosen contentFormat.
const FORMAT_QUESTION_CARD = (ctx: ToolContext): IdeaEventCardData => ({
  kind: "question",
  questions: [
    {
      question: "Which format should this be?",
      options: [
        {
          label: "Post 3:4 (1080×1440)",
          description: "Feed post, FEED_PORTRAIT",
        },
        { label: "Story 9:16 (1080×1920)", description: "Story, STORY" },
        { label: "Reel cover 9:16 (1080×1920)", description: "Reel, REEL" },
        {
          label: "Square 1:1 (1080×1080)",
          description: "Square post, FEED_SQUARE",
        },
      ],
    },
  ],
  projectId: ctx.projectId,
  ideaId: ctx.ideaId,
});

function needsInstagramFormat(args: {
  platform?: string;
  contentFormat?: unknown;
}): boolean {
  return (
    !args.contentFormat &&
    (args.platform === undefined || args.platform === "INSTAGRAM")
  );
}

const createTask = defineTool({
  name: "create_task",
  label: "Creating task…",
  kind: "work",
  phases: ["ACTIVE"],
  description:
    "Queue ONE single deliverable or research job (NEVER a post/story/ad image — that is generate_image; one research note, one piece of copy, one analysis). `taskBrief` must be self-contained: the worker cannot see this chat. Set `platform` only when a channel is named or clearly implied. Use start_strategic_project instead when the request is broad and multi-part.",
  schema: z.object({
    capability: z.enum(TASK_CAPABILITIES),
    taskBrief: z.string(),
    platform: z.enum(CHAT_PLATFORMS).optional(),
    contentFormat: z.nativeEnum(CreativeContentFormat).optional(),
  }),
  async execute(args, ctx) {
    const submission = await submitIntent(ctx, {
      kind: "CAPABILITY",
      capability: args.capability,
      targetPlatform: args.platform,
      contentFormat: args.contentFormat,
      request: args.taskBrief.trim() || ctx.message,
    });
    return outcomeFromSubmission(submission);
  },
});

const generateImage = defineTool({
  name: "generate_image",
  label: "Generating image…",
  kind: "work",
  phases: ["ACTIVE"],
  description:
    "Create ONE social-media visual (post, story, reel cover) with its caption RIGHT NOW, rendered live in the chat. The DESIGN is not yours to invent: it must come from (a) the brand's own visual identity — call get_visual_identity first if you have not read it this conversation — and (b) what the client told you. If the brief leaves the design genuinely open (what the post should say, the look/mood, whether text goes on the image, the format), do NOT generate yet: ask with ask_user first (one round, max 2 questions, options built from THIS brand's identity, e.g. its photography style / mood tags / an option that means \"the brand's usual look\"). Skip questions the client already answered or that the brand identity settles. When you do generate: `imagePrompt` = the scene only — subject, setting, composition, light — described concretely in a way that follows the brand's palette, photography style, mood and always-include/always-avoid rules; NO text, NO logo in it (the brand logo and colour bar are composited automatically, pixel-accurate, in the position the brand configured). `headline` (+ optional `highlight`, the words to set in the accent colour) ONLY when the client wants text on the image: short, in the brand's language, correctly spelled with diacritics; otherwise omit it and the image stays textless. `layoutId` = the id of one of the brand's saved post layouts (listed by get_visual_identity; a layout fixes where the logo, the colour bar / band and the headline go). Pass it when the client picked a layout or when one clearly fits (e.g. a layout with a headline when the client wants text); omit it otherwise and the brand's default layout for the chosen format is used. Never invent an id. `caption` = short social caption and `copy` = longer supporting copy, brand voice, obeying every negative rule / approved claim. Set `platform` only when a channel is named or clearly implied. `contentFormat` is REQUIRED for Instagram (or when no channel is named) and must be the client's own choice, never a default: ALWAYS ask which format first unless they already named it — Post 3:4 (1080x1440) = FEED_PORTRAIT, Story 9:16 (1080x1920) = STORY, Reel cover 9:16 = REEL, Square 1:1 = FEED_SQUARE. `quality`: \"draft\" (default, fast) for anything shown in the conversation; \"final\" only when the client explicitly asks for publish-ready / highest quality. The finished image appears as a card for the client to review — do not describe it in detail afterwards.",
  schema: z.object({
    imagePrompt: z.string().min(1),
    headline: z.string().optional(),
    highlight: z.string().optional(),
    caption: z.string(),
    copy: z.string(),
    platform: z.enum(CHAT_PLATFORMS).optional(),
    contentFormat: z.nativeEnum(CreativeContentFormat).optional(),
    layoutId: z.string().max(40).optional(),
    quality: z.enum(["draft", "final"]).optional(),
  }),
  async execute(args, ctx) {
    if (needsInstagramFormat(args)) {
      return {
        status: "ANSWERED",
        card: FORMAT_QUESTION_CARD(ctx),
        result: {
          outcome: "format_question_shown",
          note: "Nothing was generated. The client sees a card asking which format they want (Post 3:4 = FEED_PORTRAIT, Story = STORY, Reel = REEL, Square = FEED_SQUARE). Say in one short sentence that you need the format first; when they answer, call generate_image again with that contentFormat and the same design.",
        },
      };
    }
    const submission = await submitIntent(
      ctx,
      {
        kind: "CAPABILITY",
        capability: "CREATE_SOCIAL_CREATIVE",
        targetPlatform: args.platform,
        contentFormat: args.contentFormat,
        request: args.caption.trim() || args.imagePrompt,
      },
      {
        // Consumed by OpenAiCreativeProvider: skips its own text LLM call.
        preset: {
          caption: args.caption,
          copy: args.copy,
          imagePrompt: args.imagePrompt,
          // Only when the client chose text on the image.
          overlay: args.headline?.trim()
            ? {
                headline: args.headline.trim(),
                highlight: args.highlight?.trim() || undefined,
              }
            : undefined,
          // Resolved (and validated against the brand's saved layouts) by
          // the provider; an unknown id falls back to the brand default.
          layoutId: args.layoutId?.trim() || undefined,
        },
        quality: args.quality === "final" ? "high" : "medium",
      },
    );

    // Anything but a freshly dispatched job (setup gate, approval hold,
    // errors...) is reported exactly like every other work tool.
    if (submission.status !== "PLANNED" || !submission.dispatched) {
      return outcomeFromSubmission(submission);
    }

    const job = await prisma.executionJob.findFirst({
      where: { taskId: submission.taskId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    const task = await prisma.task.findUnique({
      where: { id: submission.taskId },
      select: { riskLevel: true },
    });
    if (!job || !task) return outcomeFromSubmission(submission);

    // Subscribe BEFORE starting so no early preview is missed, then run the
    // job here and now instead of waiting up to a worker tick. Safe against
    // the worker also picking it up: driveJobInline takes the job's dispatch
    // event first, so exactly one side runs the provider.
    const unsubscribe = subscribeCreativeProgress(job.id, (event) =>
      ctx.emit({
        type: "image.partial",
        index: event.index,
        dataUrl: event.dataUrl,
      }),
    );
    try {
      const settled = await driveJobInline(job.id, task.riskLevel);
      if (settled.status === "FAILED") {
        return {
          status: "ERROR",
          result: {
            outcome: "image_failed",
            error: settled.errorMessage ?? "unknown error",
            note: "Tell the client honestly that the image could not be generated and offer to try again.",
          },
        };
      }
      if (settled.status === "QUEUED" || settled.status === "RUNNING") {
        return {
          status: "PLANNED",
          result: {
            outcome: "image_still_rendering",
            note: "The image is still rendering in the background; its card will appear in the chat when it is done. Say so briefly.",
          },
        };
      }
      const layout = await layoutUsedBy(job.id);
      const requestedId = args.layoutId?.trim();
      const layoutNote = !layout
        ? ""
        : requestedId && requestedId !== layout.id
          ? ` The requested layout does not exist for this brand, so its "${layout.name}" layout was used instead — say so in a few words.`
          : ` It was laid out with the brand's "${layout.name}" layout — mention that in a few words.`;
      return {
        status: "PLANNED",
        result: {
          outcome: "image_ready",
          layout,
          note:
            "The finished image is already visible to the client as a card in the chat, awaiting their review. Reply in one short sentence (do not describe the image in detail) and offer to adjust it." +
            layoutNote,
        },
      };
    } finally {
      unsubscribe();
    }
  },
});

// The layout the provider actually applied, read back from the finished job
// (it resolves the client's pick, else the brand's default for the format), so
// a reply never names a layout that was not used. Best effort: the image is
// already made, so a failed read must not turn the outcome into an error.
async function layoutUsedBy(
  jobId: string,
): Promise<{ id: string; name: string } | null> {
  try {
    const job = await prisma.executionJob.findUnique({
      where: { id: jobId },
      select: { rawResult: true },
    });
    return readLayoutMeta(job?.rawResult);
  } catch {
    return null;
  }
}

const startStrategicProject = defineTool({
  name: "start_strategic_project",
  label: "Starting project…",
  kind: "work",
  phases: ["ACTIVE"],
  description:
    "Start a broad, multi-part piece of work that needs research AND planning AND several outputs (entering a new market, a full campaign, a multi-week content plan, a product launch). NOT for a single deliverable — use create_task for that. `title` is a short name (max 80 chars), `brief` the self-contained description. Set `departments` only when the request clearly spans more than one function.",
  schema: z.object({
    title: z.string(),
    brief: z.string(),
    departments: z
      .array(z.nativeEnum(DepartmentKey))
      .optional()
      .catch(undefined),
  }),
  async execute(args, ctx) {
    const submission = await submitIntent(ctx, {
      kind: "STRATEGIC_REQUEST",
      title: args.title.trim().slice(0, 80),
      description: args.brief.trim() || ctx.message,
      departments: args.departments,
    });
    return outcomeFromSubmission(submission);
  },
});

const generateIdeas = defineTool({
  name: "generate_ideas_from_opportunities",
  label: "Generating ideas…",
  kind: "work",
  phases: ["ACTIVE"],
  description:
    'Draw fresh ideas from the agency\'s EXISTING, already-evaluated opportunity backlog. Use when the client asks for new ideas in general ("give me some new ideas", "what should we create next"). NOT for a specific single deliverable (create_task) and NOT for broad new research (start_strategic_project).',
  schema: z.object({}),
  async execute(_args, ctx) {
    const submission = await submitIntent(ctx, {
      kind: "GENERATE_IDEAS_FROM_OPPORTUNITIES",
    });
    return outcomeFromSubmission(submission);
  },
});

const decideApproval = defineTool({
  name: "decide_approval",
  label: "Recording decision…",
  kind: "work",
  phases: ["ACTIVE"],
  description:
    "Record the client's decision on the item currently waiting for their approval: APPROVE, REJECT, or REVISE (they want changes). Only when the client is clearly answering a pending approval.",
  schema: z.object({ decision: z.enum(["APPROVE", "REJECT", "REVISE"]) }),
  async execute(args, ctx) {
    const submission = await submitIntent(ctx, {
      kind: "APPROVAL_DECISION",
      decision: args.decision,
      note: args.decision === "REVISE" ? ctx.message : undefined,
    });
    return outcomeFromSubmission(submission);
  },
});

const askUser = defineTool({
  name: "ask_user",
  label: "Preparing options…",
  kind: "terminal",
  phases: ["ACTIVE", "ON_HOLD"],
  description:
    "Show the client 1-2 questions with 2-4 concrete, clickable options each. Use ONLY on a genuine fork where the answer changes what you would do (which audience, which direction, brand focus during setup). Never for something you could reasonably infer. Ends your turn: write any lead-in sentence BEFORE calling it.",
  schema: z.object({ questions: z.array(QuestionSchema).min(1).max(2) }),
  async execute(args, ctx) {
    return {
      status: "ANSWERED",
      card: {
        kind: "question",
        questions: args.questions,
        projectId: ctx.projectId,
        ideaId: ctx.ideaId,
      },
      result: { outcome: "options_shown" },
    };
  },
});

const rememberPreference = defineTool({
  name: "remember_preference",
  label: "Saving preference…",
  kind: "note",
  phases: ["ACTIVE", "ON_HOLD"],
  description:
    'Remember a DURABLE preference or rule the client just stated ("more premium", "focus on Germany now", "never use neon colors") — not a one-off request. `value` is a short string capturing the decision (e.g. "premium_editorial"); `scope` is usually "BRAND" unless clearly limited to one campaign/market.',
  schema: z.object({
    type: z.nativeEnum(UserDecisionType),
    scope: z.string(),
    value: z.string(),
  }),
  async execute(args, ctx) {
    await recordUserDecision({
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      brandId: ctx.brandId,
      type: args.type,
      scope: args.scope,
      value: args.value,
      rawMessage: ctx.message,
      sourceCommandId: ctx.commandId,
      createdByUserId: ctx.userId,
    });
    return { result: { outcome: "saved" } };
  },
});

const startBrandSetup = defineTool({
  name: "start_brand_setup",
  label: "Starting setup…",
  kind: "work",
  // Not offered for now: setup is no longer a prerequisite for working, and
  // this starts the FULL 12-stage pipeline (dozens of LLM calls). It comes back
  // as an opt-in "Deep Brand Enrichment" tool once that pipeline has a mode
  // that skips the stages only the old orchestrator needed.
  phases: [],
  description:
    "Start the brand's real onboarding pipeline (discovery, brand constitution, goals, first work plan). Call ONLY once brandName is known AND the client has clearly agreed to go ahead. Carry forward what earlier turns established (domain, focus description, whether to proceed automatically).",
  schema: z.object({
    brandName: z.string(),
    domain: z.string().optional(),
    description: z.string().optional(),
    autoApprove: z.boolean().optional(),
  }),
  async execute(args, ctx) {
    const brandName = args.brandName.trim();
    if (!brandName) {
      return { result: { outcome: "missing_brand_name" } };
    }
    const started = await startAgencySetupForProject({
      projectId: ctx.projectId,
      workspaceId: ctx.workspaceId,
      brandId: ctx.brandId,
      userId: ctx.userId,
      brandName,
      domain: args.domain?.trim() || undefined,
      description: args.description?.trim() || undefined,
      autoApprove: args.autoApprove,
    });
    if (!started.ok) {
      return {
        status: "ERROR",
        result: {
          outcome: "setup_failed",
          note: "Tell the client to try again in a moment.",
        },
      };
    }
    return {
      // ANSWERED, not PLANNED: no Task exists, and PLANNED would show a
      // misleading "Task created" badge (see STATUS_NOTE in project-chat.tsx).
      status: "ANSWERED",
      result: {
        outcome: "setup_started",
        note: "Setup just STARTED in the background; NOTHING is done yet. Acknowledge briefly that you are starting. Never say setup is complete and never offer to create work in this reply.",
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Read tools: on-demand lookups so the model can check live state instead of
// guessing from the (possibly stale) context snapshot. All scoped by the
// turn's own projectId — the model can never name another project.
// ---------------------------------------------------------------------------

const EmptyArgs = z.object({});

const getPendingApprovals = defineTool({
  name: "get_pending_approvals",
  label: "Checking approvals…",
  kind: "read",
  phases: ["ACTIVE"],
  description:
    'List the items currently waiting for the client\'s approval (newest first). Use before answering questions like "what is waiting on me?" or when deciding whether a message answers a pending approval.',
  schema: EmptyArgs,
  async execute(_args, ctx) {
    const approvals = await prisma.approval.findMany({
      where: { projectId: ctx.projectId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { type: true, entityType: true, createdAt: true },
    });
    return {
      result: {
        count: approvals.length,
        approvals: approvals.map((a) => ({
          type: a.type,
          entityType: a.entityType,
          waitingSince: a.createdAt.toISOString(),
        })),
      },
    };
  },
});

const getRecentTasks = defineTool({
  name: "get_recent_tasks",
  label: "Checking recent work…",
  kind: "read",
  phases: ["ACTIVE"],
  description:
    'List the agency\'s most recent tasks with their status (newest first). Use to answer "what are you working on / what did you finish?" from facts.',
  schema: EmptyArgs,
  async execute(_args, ctx) {
    const tasks = await prisma.task.findMany({
      where: { projectId: ctx.projectId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { title: true, capability: true, status: true, createdAt: true },
    });
    return {
      result: {
        tasks: tasks.map((t) => ({
          title: t.title,
          capability: t.capability,
          status: t.status,
          createdAt: t.createdAt.toISOString(),
        })),
      },
    };
  },
});

const getIdeaStatus = defineTool({
  name: "get_idea_status",
  label: "Checking ideas…",
  kind: "read",
  phases: ["ACTIVE"],
  description:
    "List the ideas/initiatives currently in flight (not archived or rejected) with their pipeline status.",
  schema: EmptyArgs,
  async execute(_args, ctx) {
    const ideas = await prisma.idea.findMany({
      where: {
        projectId: ctx.projectId,
        status: { notIn: ["ARCHIVED", "REJECTED"] },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { title: true, status: true, createdAt: true },
    });
    return {
      result: {
        ideas: ideas.map((i) => ({
          title: i.title,
          status: i.status,
          createdAt: i.createdAt.toISOString(),
        })),
      },
    };
  },
});

const getBrandProfile = defineTool({
  name: "get_brand_profile",
  label: "Reading brand profile…",
  kind: "read",
  phases: ["ACTIVE", "ON_HOLD"],
  description:
    "Fetch the brand's full current profile (identity, positioning, audience, voice, negative rules, current focus, past preferences, what creative has worked). Use when you need brand details beyond the summary in your context.",
  schema: EmptyArgs,
  async execute(_args, ctx) {
    const twin = await getBrandTwin(ctx.projectId);
    return { result: twin ?? { error: "No brand profile yet." } };
  },
});

const getConnectedPlatforms = defineTool({
  name: "get_connected_platforms",
  label: "Checking connected channels…",
  kind: "read",
  phases: ["ACTIVE"],
  description:
    "List the social channels actually connected for this brand (with account labels). Use before planning content so you only plan for channels that can publish, or to ask which to focus on.",
  schema: EmptyArgs,
  async execute(_args, ctx) {
    const targets = await getPublishTargets(ctx.projectId);
    return {
      result: {
        connected: targets.map((t) => ({
          platform: t.platform,
          account: "accountLabel" in t ? t.accountLabel : undefined,
        })),
        note:
          targets.length === 0
            ? "No channel is connected yet; a plan can still be drafted, but it cannot be published automatically."
            : undefined,
      },
    };
  },
});

const startPlanBrief = defineTool({
  name: "start_plan_brief",
  label: "Opening the planning wizard…",
  kind: "terminal",
  phases: ["ACTIVE"],
  description:
    'Open the planning wizard: a short step-by-step card where the client picks the goal, the channels (Instagram, TikTok, LinkedIn, X, Blog/SEO, Ads), the formats, and the rhythm (posts per week, duration, start date). Use it when the client wants content planned ("plan the week", "content calendar", "what should we post") and has NOT already told you the goal, the channels and how many posts. It replaces ad-hoc questions about planning. Ends your turn: write ONE short lead-in sentence BEFORE calling it. When the client\'s reply arrives it contains a `[Plan brief]` line — then call propose_content_plan.',
  schema: EmptyArgs,
  async execute(_args, ctx) {
    const timezone = await getProjectTimezone(ctx.projectId);
    const [connections, twin] = await Promise.all([
      getChannelConnections(ctx.projectId).catch(() => ({})),
      getBrandTwin(ctx.projectId).catch(() => null),
    ]);
    return {
      status: "ANSWERED",
      card: {
        kind: "plan-brief",
        projectId: ctx.projectId,
        ideaId: ctx.ideaId,
        today: todayInTimezone(timezone),
        connections,
        theme: twin?.currentFocus?.title,
      },
      result: { outcome: "wizard_shown" },
    };
  },
});

const proposeContentPlan = defineTool({
  name: "propose_content_plan",
  label: "Drafting content plan…",
  kind: "note",
  phases: ["ACTIVE"],
  description:
    "Draft a day-by-day content plan for the client to review as a card (nothing is stored until they press Save). This is THE way to plan content. Normally the client's message contains a `[Plan brief]` line from the planning wizard (goal, channels with formats, perWeek, weeks, start): follow it EXACTLY — only those channels and formats, at most perWeek x weeks items, dates from `start`, and cover every chosen channel. If there is no brief and the client has not said what they want, call start_plan_brief instead. Put the WHOLE plan in one call: `title`, `goal` (awareness | leads | sales | engagement | traffic), and per item a real calendar date (YYYY-MM-DD, from today onward — today's date is in your context), optional time (HH:MM, default 10:00), `channel` (instagram | tiktok | linkedin | x | seo | ads), `formatKey` (one of that channel's formats: instagram.post, instagram.carousel, instagram.reel, instagram.story, tiktok.video, linkedin.post, x.post, x.thread, seo.article, ads.campaign), a concrete `topic` and a `captionIdea` written in the brand voice (for seo.article the working headline + target keyword; for ads.campaign the offer and audience). Spread the channels sensibly across the days. Call it in the SAME reply — never announce that you will draft it later. To change a plan the client already saw, call this again with the full updated plan — the old card is replaced.",
  schema: ContentPlanArgsSchema,
  async execute(args, ctx) {
    const timezone = await getProjectTimezone(ctx.projectId);
    const today = todayInTimezone(timezone);
    const brief = parsePlanBrief(ctx.message);
    const problem =
      validatePlanDates(args.items, today) ??
      validatePlanChannels(args.items) ??
      (brief ? validatePlanAgainstBrief(args.items, brief) : null);
    if (problem) {
      return {
        result: {
          error: problem,
          note: "Fix the plan and call propose_content_plan again with the full plan.",
        },
      };
    }
    await supersedeOpenDrafts(ctx.projectId, ctx.commandId);
    const connections = await getChannelConnections(ctx.projectId).catch(
      () => undefined,
    );
    return {
      status: "ANSWERED",
      card: buildPlanCard(
        { ...args, goal: args.goal ?? brief?.goal },
        timezone,
        connections,
      ),
      result: {
        outcome: "plan_shown",
        note: "The client sees the plan as a compact calendar card with a Save button, and which channels are connected. In one or two sentences say what the plan emphasizes and that they can ask for changes or save it; do not repeat every item.",
      },
    };
  },
});

const proposeContentPackage = defineTool({
  name: "propose_content_package",
  label: "Preparing a content package…",
  kind: "note",
  phases: ["ACTIVE"],
  description:
    "Answer a request that names a TOPIC or GOAL but no specific deliverable (e.g. \"Kommo CRM for health tourism\") with a package of 2-5 concrete deliverables drawn from the agency's ACTIVE departments (listed in your context), shown as a card the client ticks and starts with one click. Each item: `id` (short, unique), `deliverable` (a key from your context), `title` (the concrete piece, in the brand's language), `angle` (ONE sentence on the specific angle/hook for this brand and topic — never generic), and for `instagram_post` a `contentFormat` (propose FEED_PORTRAIT = Post 3:4 unless they asked for another; the client can change it on the card). Mix departments (e.g. an Instagram post + an SEO article + a Reel idea) so the client sees the full range. Do NOT ask what they want first — propose, they untick what they do not want. Never use it when the client already asked for one specific deliverable (use generate_image / create_task) or for a dated calendar (propose_content_plan).",
  schema: ContentPackageArgsSchema,
  async execute(args, ctx) {
    const problem = validatePackageItems(args.items);
    if (problem) {
      return {
        result: {
          error: problem,
          note: "Fix the package and call propose_content_package again.",
          available: activeDeliverables().map((d) => d.key),
        },
      };
    }
    await supersedeOpenPackages(ctx.projectId, ctx.commandId);
    return {
      status: "ANSWERED",
      card: buildPackageCard(args),
      result: {
        outcome: "package_shown",
        note: "The client sees the package as a card with tick boxes and a start button. In one or two sentences say what the package covers and that they can untick anything or ask for changes; do not repeat every item.",
      },
    };
  },
});

// The brand's saved post layouts as the chat model sees them: enough to choose
// between them (what each is for, whether it carries a headline) without the
// raw geometry, which it could only misquote. `formats` uses the app's aspect
// classes: portrait = Post 3:4, square = 1:1, landscape = wide, vertical =
// Story / Reel 9:16; "any" = suits every format.
export function layoutsForChat(saved: LayoutTemplates | null | undefined) {
  if (!saved) return null;
  return {
    defaultId: saved.defaultId,
    items: saved.items.map((layout) => ({
      id: layout.id,
      name: layout.name,
      description: layout.description || undefined,
      formats: layout.formats.length ? layout.formats : "any",
      headline: layout.headline.enabled,
      summary: describeLayout(layout),
    })),
    note: "Pass a layout's id as generate_image's `layoutId`. Without one, the layout made for the chosen format (else the default) is used. A layout with headline=false has no place for text; pick one with headline=true when the client wants text on the image.",
  };
}

const getVisualIdentity = defineTool({
  name: "get_visual_identity",
  label: "Reading brand identity…",
  kind: "read",
  phases: ["ACTIVE"],
  description:
    "Read the brand's visual identity as configured in the app: primary / secondary / accent colours, photography style, mood tags, composition notes, background tone, always-include / always-avoid rules, whether a logo and a style-reference image exist, and where the logo and colour bar are placed, and the brand's saved post layouts (each with an id you can pass to generate_image as `layoutId`). Call before designing anything visual, and use it to build the options of your design questions.",
  schema: EmptyArgs,
  async execute(_args, ctx) {
    const style = await resolveBrandStyleContext(ctx.brandId);
    const identity = style.visualIdentity;
    const swatches = (
      list: { name?: string | null; hex: string }[] | undefined,
    ) => (list ?? []).map((c) => (c.name ? `${c.name} ${c.hex}` : c.hex));
    return {
      result: {
        configured: Boolean(identity),
        hasLogo: Boolean(style.logoAssetId || style.darkLogoAssetId),
        primaryColors: swatches(identity?.primaryColors),
        secondaryColors: swatches(identity?.secondaryColors),
        accentColors: swatches(identity?.accentColors),
        photographyStyle: identity?.photographyStyle ?? null,
        styleRefinement: identity?.styleRefinement ?? null,
        moodTags: identity?.moodTags ?? [],
        compositionNotes: identity?.compositionNotes ?? null,
        backgroundTone: identity?.backgroundTone ?? null,
        alwaysInclude: identity?.alwaysInclude ?? [],
        alwaysAvoid: identity?.alwaysAvoid ?? [],
        hasStyleReferenceImage: Boolean(identity?.referenceImageAssetId),
        template: identity?.template
          ? {
              enabled: identity.template.enabled,
              logoPosition: identity.template.logoPosition,
              accentBar: identity.template.accentBarEnabled
                ? identity.template.accentBarPosition
                : null,
            }
          : null,
        layouts: layoutsForChat(identity?.layoutTemplates),
        note: identity
          ? undefined
          : "No structured visual identity is configured yet; the brand profile's visual notes and legacy colours still apply. Ask the client about the look instead of assuming one.",
      },
    };
  },
});

const suggestReplies = defineTool({
  name: "suggest_replies",
  label: "Preparing suggestions…",
  kind: "note",
  phases: ["ACTIVE"],
  description:
    'Offer 2-3 short clickable follow-up messages the client would plausibly send next (max ~6 words each, written as the CLIENT speaking, e.g. "Plan the week"). Use RARELY, only when there are obvious next steps after your answer — never after asking a question, and never together with ask_user.',
  schema: z.object({ suggestions: z.array(z.string()).min(1).max(3) }),
  async execute(args) {
    return {
      result: { outcome: "shown" },
      suggestions: args.suggestions
        .map((text) => text.trim())
        .filter(Boolean)
        .slice(0, 3),
    };
  },
});

const ALL_TOOLS: readonly ChatTool[] = [
  createTask,
  generateImage,
  startStrategicProject,
  generateIdeas,
  decideApproval,
  askUser,
  rememberPreference,
  startBrandSetup,
  getPendingApprovals,
  getRecentTasks,
  getIdeaStatus,
  getBrandProfile,
  getVisualIdentity,
  getConnectedPlatforms,
  startPlanBrief,
  proposeContentPlan,
  proposeContentPackage,
  suggestReplies,
];

export function toolsForPhase(phase: ChatPhase): ChatTool[] {
  return ALL_TOOLS.filter((tool) => tool.phases.includes(phase));
}

// OpenAI function-tool definition. strict:false for the same reason as the
// reasoning client: strict mode demands every property be `required` and
// rejects shapes z.toJSONSchema produces; the zod parse in the agent loop is
// the actual enforcement point.
export function toOpenAITools(tools: readonly ChatTool[]): Tool[] {
  return tools.map((tool) => {
    const parameters = z.toJSONSchema(tool.schema) as Record<string, unknown>;
    delete parameters.$schema;
    return {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters,
      strict: false,
    };
  });
}
