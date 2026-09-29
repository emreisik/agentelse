import { z } from "zod";
import {
  CreativeContentFormat,
  DepartmentKey,
  UserDecisionType,
} from "@prisma/client";

import type { ReasoningDef } from "../types";

// The brain of the chat surface. The rule-based `parseIntent` only
// recognized a handful of patterns (like "prepare an instagram post") and
// returned UNKNOWN for everything else — meaning the screen stayed silent
// whenever the user wrote freely. This prompt does two jobs at once: it
// writes the user a genuine reply (in the project's language) AND decides
// whether the message is a work request, a question, or an approval.
//
// Capabilities that can be triggered from chat are deliberately restricted:
// engine-internal capabilities like SIGNAL_SCAN / MEASUREMENT_CHECK belong
// to the agency's own rhythm and are never run one-off via a user command.
export const CHAT_CAPABILITIES = [
  "CREATE_SOCIAL_CREATIVE",
  "CREATE_AD_CREATIVE",
  "CREATE_COPY",
  "CREATE_CAPTION",
  "CREATE_CAMPAIGN_BRIEF",
  "CREATE_CONTENT_PLAN",
  "COMPETITOR_RESEARCH",
  "MARKET_RESEARCH",
  "TREND_RESEARCH",
  "CUSTOMER_INTELLIGENCE",
  "PRODUCT_RESEARCH",
  "WEB_RESEARCH",
  "SEO_RESEARCH",
  "SEO_ANALYSIS",
  "SOCIAL_RESEARCH",
  "SOCIAL_PROFILE_AUDIT",
  "SOCIAL_ACCOUNT_SETUP",
  "INSTAGRAM_PUBLISH",
  "TIKTOK_PUBLISH",
  "LINKEDIN_PUBLISH",
  "X_PUBLISH",
  "ANALYTICS_ANALYSIS",
  "META_ADS_ANALYSIS",
  "META_CAMPAIGN_CREATE",
  "GOOGLE_ADS_ANALYSIS",
  "EMAIL_DRAFT",
  "REPORTING",
] as const;

export const CHAT_PLATFORMS = [
  "INSTAGRAM",
  "TIKTOK",
  "LINKEDIN",
  "X",
  "FACEBOOK",
  "YOUTUBE",
  "PINTEREST",
] as const;

// Mirrors brand-brain-chat.ts's BrandBrainQuestionSchema (same shape,
// separately declared since these are independent reasoning defs) — a
// short question plus 2-4 concrete, pickable options, modeled on the
// AskUserQuestion tool. Lets the model steer with clickable choices instead
// of a vague open-ended "UNCLEAR" reply whenever there's a genuine fork.
const ChatQuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});
const ChatQuestionSchema = z.object({
  question: z.string(),
  options: z.array(ChatQuestionOptionSchema).min(2).max(4),
  multiSelect: z.boolean().optional(),
});
export type ChatQuestion = z.infer<typeof ChatQuestionSchema>;

// A durable preference/rule the client just stated in plain language (spec
// example: "More premium." -> {type: CREATIVE_PREFERENCE, scope: "BRAND",
// value: "premium_editorial"}) — persisted as a UserDecision (see
// brand-twin-writes.ts's recordUserDecision) instead of being recoverable
// only by re-reading raw chat history. `value` is kept as a short string
// here (not arbitrary JSON) since that's what a model can reliably produce;
// callers store it as-is in UserDecision.value.
const ChatPreferenceSchema = z.object({
  type: z.nativeEnum(UserDecisionType),
  scope: z.string(),
  value: z.string(),
});

export const ChatTurnOutputSchema = z.object({
  // The reply shown to the user. In the project's language, 2-5 sentences.
  reply: z.string(),
  intentKind: z.enum(["TASK", "ANSWER", "APPROVAL", "UNCLEAR"]),
  // .catch(undefined) on these optional fields: a value outside the schema
  // (wrong case, a synonym, a value the model half-remembers from a
  // different prompt) used to crash the ENTIRE chat turn — including the
  // `reply` text the user was about to see — on this codebase's single
  // most frequently called, most user-visible reasoning call. Degrading to
  // "field not provided" is exactly the already-safe path chat-service.ts
  // takes when the model omits the field outright (see its intentKind-
  // gated guards), so this only removes a crash, not a real capability.
  capability: z.enum(CHAT_CAPABILITIES).optional().catch(undefined),
  platform: z.enum(CHAT_PLATFORMS).optional().catch(undefined),
  // Which content-format slot (Story/Reel/Feed square/etc) a
  // CREATE_SOCIAL_CREATIVE request is for — set ONLY when the client
  // names a distinct format ("a story", "a reel"); omit to use the
  // platform's own default (a plain "post"/"content"). Previously nothing
  // in the chat pipeline captured this at all, so asking for a Story
  // silently produced a square Feed image every time — see
  // chat-service.ts's toParsedIntent and the creative providers'
  // getCreativePlatformFormat call.
  contentFormat: z
    .nativeEnum(CreativeContentFormat)
    .optional()
    .catch(undefined),
  // A self-contained brief to write onto the task. Instead of copying the
  // user's sentence verbatim, it folds in the context from the chat
  // history — the executing agent doesn't see the chat, only this text.
  taskBrief: z.string().optional(),
  // Fast Path (default) vs Deep Path (spec) — set ONLY on a TASK whose
  // scope is genuinely broad/multi-part (a full campaign, entering a new
  // market, a multi-week plan), not a single deliverable. true routes to
  // createStrategicIdea (strategic-request.ts) instead of a single task —
  // see chat-service.ts's toParsedIntent.
  strategic: z.boolean().optional(),
  // Required when strategic=true — a short (<=80 char) name for the new
  // thread, since taskBrief itself becomes the Idea's longer description.
  title: z.string().optional(),
  // Optional when strategic=true — which of the agency's departments this
  // genuinely spans. More than one triggers a real multi-department
  // WorkPlan in the existing autonomous pipeline instead of a single task
  // (see strategic-request.ts's module comment). Omit rather than guess.
  departments: z.array(z.nativeEnum(DepartmentKey)).optional().catch(undefined),
  // Sibling of `strategic`, mutually exclusive with it: the client wants
  // fresh ideas pulled from the agency's EXISTING, already-evaluated
  // opportunity backlog ("give me some new ideas", "fırsatlardan fikir
  // üret") rather than a brand-new research/strategy thread. Idea
  // generation is on-demand-only now (no more continuous background
  // generation — see idea-foundry.ts/agency-wiring.ts), so this is the
  // chat-triggered way to draw from that backlog. See
  // command-service.ts's GENERATE_IDEAS_FROM_OPPORTUNITIES handling.
  generateIdeasFromOpportunities: z.boolean().optional().catch(undefined),
  approvalDecision: z
    .enum(["APPROVE", "REJECT", "REVISE"])
    .optional()
    .catch(undefined),
  // Usually absent. Present only on a genuine fork worth pickable options
  // (see ChatQuestionSchema) — independent of intentKind, so a TASK or
  // UNCLEAR turn can both carry one.
  questions: z.array(ChatQuestionSchema).max(2).optional().catch(undefined),
  // Usually absent. Present only when the client's message itself states a
  // durable preference/rule (not a one-off request) worth remembering.
  preference: ChatPreferenceSchema.optional().catch(undefined),
  // Set ONLY while context.setupPhase is "NOT_STARTED" (see chat-service.ts)
  // — the conversational replacement for the old setup form
  // (agency-setup-actions.ts's startAgencySetupAction). Fill in whichever of
  // brandName/domain/description/autoApprove the client has given so far
  // (across turns — carry forward what earlier turns already established,
  // don't lose it). Set `ready: true` only once brandName is known AND the
  // client has clearly agreed to start — chat-service.ts then starts the
  // real 12-stage setup pipeline from these fields.
  setupIntake: z
    .object({
      brandName: z.string().optional(),
      domain: z.string().optional(),
      description: z.string().optional(),
      autoApprove: z.boolean().optional(),
      ready: z.boolean().optional(),
    })
    .optional()
    .catch(undefined),
});

export type ChatTurnOutput = z.infer<typeof ChatTurnOutputSchema>;

export const chatTurnDef: ReasoningDef<ChatTurnOutput> = {
  purpose: "chat.turn",
  schema: ChatTurnOutputSchema,
  // Runs on every user message — the most frequently called prompt. Cheap tier.
  tier: "lite" as const,
  maxTokens: 2048,

  buildPrompt(context) {
    const setupPhase = context.setupPhase;
    const setupBlock =
      setupPhase === "NOT_STARTED"
        ? [
            "",
            "SETUP: this brand has not been set up yet — no capability/task/strategic/idea work can run until it has. Your job right now is to collect what the setup pipeline needs, through natural conversation (not a form, don't dump every question at once):",
            "  - brandName (required) — the project may already have a working name (see Brand / project below); just confirm it or ask if they want to change it.",
            "  - domain (a website, if they have one) — optional.",
            "  - description — what they want the agency to focus on. Ask this as a `questions` entry (multiSelect: true) with concrete options like Growth/Sales, Brand Awareness, Social Media Management, SEO / Organic Traffic, Paid Ads — plus whatever else fits the brand — rather than an open-ended question; once they pick, fold their picks into a short `description` string. Skip the question only if they already stated their focus in plain text.",
            '  - autoApprove — ask this as a single-select `questions` entry too (e.g. "Proceed automatically" vs "Wait for my approval at each stage") instead of asking in prose.',
            "  Never set intentKind to TASK with strategic/generateIdeasFromOpportunities, or a capability — there is no brand profile yet to do that work against. If the client asks for deliverable work anyway, explain warmly that you need to get to know the brand first, and steer back to the missing setup field(s).",
            "  Fill `setupIntake` with whatever fields are known so far (carry forward earlier turns' answers, don't ask again for something already given). Set `setupIntake.ready: true` ONLY once brandName is known and the client has clearly said to go ahead — that starts the real setup pipeline in the background (it takes real time: discovery, then the brand constitution, goals, the first work plan). It has NOT finished the moment you set ready — never say setup is done or offer to create work in the same reply; a short acknowledgement that you're starting it is enough (your `reply` on this turn is not shown to the client verbatim, so keep it brief either way).",
          ].join("\n")
        : setupPhase === "IN_PROGRESS"
          ? [
              "",
              `SETUP: this brand's setup is running in the background right now${
                context.setupWaiting
                  ? ` (currently: ${String(context.setupWaiting)})`
                  : ""
              }. No new capability/task/strategic/idea work can be started until it finishes. If the client asks for deliverable work, explain that setup is still in progress and that request will be possible once it's done — don't set intentKind to TASK with a capability/strategic/generateIdeasFromOpportunities. You can still answer questions about progress or brand details from the context you have.`,
            ].join("\n")
          : "";
    return {
      system: [
        "You are the account director of an autonomous AI marketing agency, talking to the client in a chat window.",
        "You have two jobs on every message: (1) write a genuine, useful reply, (2) decide what the message is.",
        setupBlock,
        "",
        "intentKind:",
        '- TASK: the client wants work produced or research done. Set `capability` to the single best match and `taskBrief` to a self-contained brief that a worker who cannot see this chat could execute. Set `platform` only when a specific channel is named or clearly implied. For CREATE_SOCIAL_CREATIVE, set `contentFormat` ONLY when the client names a distinct format (e.g. "a story", "a reel", "hikaye", "a square post") — but for Instagram (or an unnamed channel) a plain "post"/"content" request does NOT name a format: ask which one with `questions` (Post 3:4 1080x1440, Story/Reel 9:16 1080x1920, Square 1:1) instead of guessing.',
        "  - Most TASKs are a single deliverable (one post, one research note, one piece of copy) — leave `strategic` unset for these, exactly like today.",
        '  - Set `strategic: true` ONLY when the request is genuinely broad and multi-part — entering a new market, a full campaign, a multi-week content plan, something that obviously needs research AND planning AND multiple outputs, not one thing. Examples: "enter the German market", "build our October campaign", "plan a product launch". When true, also set `title` (a short name for it, <=80 chars) and, if the request clearly spans more than one function, `departments` (e.g. research + creative + paid media). When unsure, leave `strategic` unset — the single-task path is the safe default.',
        '  - Set `generateIdeasFromOpportunities: true` ONLY when the client is asking for fresh ideas drawn from the agency\'s own existing research/backlog ("give me some new ideas", "what should we create next", "fırsatlardan fikir üret") — NOT a request for a specific single deliverable (that\'s a normal TASK) and NOT broad enough to need new research of its own (that\'s `strategic`). Never set this together with `strategic` or `capability`.',
        "- ANSWER: the client is asking a question, giving context, or making small talk. Answer it from the context you were given. Never invent numbers, competitors or facts that are not in the context — say what you do not know.",
        "- APPROVAL: the client is approving, rejecting or asking to revise something that is waiting for their decision. Set `approvalDecision`.",
        "- UNCLEAR: you genuinely cannot tell what is wanted. Prefer `questions` (below) over a vague open-ended `reply` whenever there's a concrete, nameable fork; fall back to asking ONE specific question in `reply` only when even the shape of the fork isn't clear.",
        "",
        "questions (usually omit this field entirely): set it ONLY on a genuine fork — a handful of concrete, nameable directions where the client's answer changes what you'd do (e.g. which audience to prioritize, which creative direction to take). Each question needs 2-4 short, concrete options. NEVER use it for something you could reasonably infer or default yourself — most turns have no questions at all.",
        'preference (usually omit this field entirely): set it ONLY when the client\'s message itself states a durable preference, rule or decision worth remembering for future work (e.g. "more premium", "focus on Germany now", "never use neon colors") — not for a one-off request. `value` is a short string capturing the decision (e.g. "premium_editorial"), `scope` is usually "BRAND" unless the client is clearly scoping it to one campaign/market.',
        "",
        "Reply style: 2-5 sentences, concrete, no bullet lists unless the client asked for a list, no corporate filler, no emoji.",
        "For TASK: say what you will do and what the client will get, and mention if it will come back for approval. Do not claim it is already finished.",
        "If files are attached, look at them and refer to what you actually see — and use them in the taskBrief.",
        "Never expose internal identifiers, enum names or system wording to the client.",
      ].join("\n"),

      user: [
        `Brand / project: ${JSON.stringify(context.project ?? {})}`,
        // BrandTwin — the brand's full working understanding (identity,
        // positioning, audience, markets, products, voice, visual
        // direction, approved claims, negative rules, current focus, past
        // stated preferences, what creative has/hasn't worked). See
        // src/server/brand-twin/brand-twin.ts.
        `Brand profile: ${JSON.stringify(context.brand ?? {})}`,
        `Current agency state: ${JSON.stringify(context.state ?? {})}`,
        `Items awaiting the client's decision: ${JSON.stringify(context.pending ?? [])}`,
        `Attached files in this message: ${JSON.stringify(context.attachments ?? [])}`,
        "",
        "Conversation so far (oldest first):",
        String(context.history ?? "(empty)"),
        "",
        `New client message: ${String(context.message ?? "")}`,
      ].join("\n"),
    };
  },

  buildMock(context) {
    const message = String(context.message ?? "");
    return {
      reply: `Mock reply: received the message "${message.slice(0, 120)}".`,
      intentKind: "ANSWER" as const,
    };
  },
};
