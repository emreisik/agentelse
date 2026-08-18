import { z } from "zod";

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

export const ChatTurnOutputSchema = z.object({
  // The reply shown to the user. In the project's language, 2-5 sentences.
  reply: z.string(),
  intentKind: z.enum(["TASK", "ANSWER", "APPROVAL", "UNCLEAR"]),
  capability: z.enum(CHAT_CAPABILITIES).optional(),
  platform: z.enum(CHAT_PLATFORMS).optional(),
  // A self-contained brief to write onto the task. Instead of copying the
  // user's sentence verbatim, it folds in the context from the chat
  // history — the executing agent doesn't see the chat, only this text.
  taskBrief: z.string().optional(),
  approvalDecision: z.enum(["APPROVE", "REJECT", "REVISE"]).optional(),
});

export type ChatTurnOutput = z.infer<typeof ChatTurnOutputSchema>;

export const chatTurnDef: ReasoningDef<ChatTurnOutput> = {
  purpose: "chat.turn",
  schema: ChatTurnOutputSchema,
  // Runs on every user message — the most frequently called prompt. Cheap tier.
  tier: "lite" as const,
  maxTokens: 2048,

  buildPrompt(context) {
    return {
      system: [
        "You are the account director of an autonomous AI marketing agency, talking to the client in a chat window.",
        "You have two jobs on every message: (1) write a genuine, useful reply, (2) decide what the message is.",
        "",
        "intentKind:",
        "- TASK: the client wants work produced or research done. Set `capability` to the single best match and `taskBrief` to a self-contained brief that a worker who cannot see this chat could execute. Set `platform` only when a specific channel is named or clearly implied.",
        "- ANSWER: the client is asking a question, giving context, or making small talk. Answer it from the context you were given. Never invent numbers, competitors or facts that are not in the context — say what you do not know.",
        "- APPROVAL: the client is approving, rejecting or asking to revise something that is waiting for their decision. Set `approvalDecision`.",
        "- UNCLEAR: you genuinely cannot tell what is wanted. Then `reply` must ask ONE specific clarifying question.",
        "",
        "Reply style: 2-5 sentences, concrete, no bullet lists unless the client asked for a list, no corporate filler, no emoji.",
        "For TASK: say what you will do and what the client will get, and mention if it will come back for approval. Do not claim it is already finished.",
        "If files are attached, look at them and refer to what you actually see — and use them in the taskBrief.",
        "Never expose internal identifiers, enum names or system wording to the client.",
      ].join("\n"),

      user: [
        `Brand / project: ${JSON.stringify(context.project ?? {})}`,
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
