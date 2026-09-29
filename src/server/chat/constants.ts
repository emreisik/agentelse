import { z } from "zod";

// Pure chat constants and shapes shared by the streaming agent engine
// (tools.ts, content-plan.ts), the legacy single-shot chat prompt
// (reasoning/prompts/chat-turn.ts) and the client card types
// (types/idea-event-card.ts). Deliberately free of server-only imports so a
// type-only import from a client module stays erased at build time, and so the
// agent engine does not have to reach into the legacy prompt for them.

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

// A short question plus 2-4 concrete, pickable options, modeled on the
// AskUserQuestion tool. Lets the model steer with clickable choices instead
// of a vague open-ended "UNCLEAR" reply whenever there's a genuine fork.
const ChatQuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});
export const ChatQuestionSchema = z.object({
  question: z.string(),
  options: z.array(ChatQuestionOptionSchema).min(2).max(4),
  multiSelect: z.boolean().optional(),
});
export type ChatQuestion = z.infer<typeof ChatQuestionSchema>;
