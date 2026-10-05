import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1).optional(),

  AUTH_SECRET: z.string().min(1),
  AUTH_URL: z.string().min(1).optional(),
  NEXT_PUBLIC_APP_URL: z.string().min(1).default("http://localhost:3000"),
  // A genuinely public base URL needed so external providers like
  // Meta/Instagram can download asset images (see asset-public-link.ts
  // buildAssetPublicUrl). Kept separate because NEXT_PUBLIC_APP_URL also
  // determines the Meta OAuth redirect URI (meta-client.ts) — in local
  // development, pointing just this at a tunnel (ngrok, etc.) lets you test
  // asset downloads without having to reconnect the OAuth flow. Falls back
  // to NEXT_PUBLIC_APP_URL when empty.
  PUBLIC_ASSET_BASE_URL: z.string().optional().default(""),

  // Google Gemini — ReasoningService's optional LLM backend and the first
  // image tier in creative-image.ts (see gemini-client.ts,
  // gemini-image-client.ts). There is no Gemini execution provider: text and
  // creative capabilities always run on OpenAI. ReasoningService.run() does
  // NOT auto-reroute — if REASONING_PROVIDER stays "gemini" while this is
  // unset, it throws PROVIDER_UNAVAILABLE instead of retrying with OpenAI; set
  // REASONING_PROVIDER=openai explicitly for that path instead.
  GEMINI_API_KEY: z.string().optional().default(""),
  // NOTE: "gemini-pro-latest" resolves to the latest Pro, and Pro's free
  // tier limit is only 250 requests/day — the agency loop was burning
  // through that in hours and hitting 429s. Flash gives 10,000 requests on
  // the same quota; individual prompts that need quality can opt out via
  // ReasoningDef.model.
  GEMINI_MODEL: z.string().optional().default("gemini-3.6-flash"),
  // Model tiers: prompts select "lite"/"pro" via ReasoningDef.tier, and
  // which model that maps to lives here — so changing a model doesn't
  // require touching prompt files.
  GEMINI_LITE_MODEL: z.string().optional().default("gemini-3.1-flash-lite"),
  GEMINI_PRO_MODEL: z.string().optional().default("gemini-3.1-pro-preview"),
  // Image generation is a separate model family: the response returns
  // base64 inside `inlineData`. Since creative output goes straight to the
  // client, quality is the priority — the Pro image model ("Nano Banana
  // Pro") is the default. See gemini-image-client.ts / creative-image.ts,
  // where this is now the first tier tried, OpenAI second.
  GEMINI_IMAGE_MODEL: z.string().optional().default("gemini-3-pro-image"),

  // OpenAI — ReasoningService's fallback backend (see openai-client.ts),
  // and the fallback execution provider when Gemini is unconfigured or
  // circuit-broken by ProviderHealthService.
  OPENAI_API_KEY: z.string().optional().default(""),
  OPENAI_MODEL: z.string().optional().default("gpt-5.6-luna"),
  // Model tiers: prompts select "lite"/"pro" via ReasoningDef.tier, and
  // which model that maps to lives here — so changing a model doesn't
  // require touching prompt files.
  OPENAI_LITE_MODEL: z.string().optional().default("gpt-5.4-mini"),
  OPENAI_PRO_MODEL: z.string().optional().default("gpt-5.6-terra"),
  // Which backend ReasoningService.run uses. Default is "openai" — Gemini's
  // billing account (the GCP project behind GEMINI_API_KEY) hit a dunning
  // block (403 "Lightning dunning decision is deny"), so every Gemini call
  // was failing outright; OpenAI is the one actually configured/working
  // backend. Unknown values fall back to the same default via catch() so a
  // typo in the env degrades gracefully instead of crashing the first
  // request. Flip back to "gemini" (or set REASONING_PROVIDER=gemini in the
  // environment) once that GCP project's billing is resolved.
  REASONING_PROVIDER: z
    .enum(["gemini", "openai"])
    .optional()
    .default("openai")
    .catch("openai"),
  // Chat engine (src/server/chat/): "agent" is the streaming tool-calling
  // loop on the OpenAI Responses API; "legacy" is the one-shot JSON
  // ChatService kept until the agent path is proven. Unknown values fall
  // back to "legacy" so a typo can't silently switch engines.
  CHAT_ENGINE: z
    .enum(["agent", "legacy"])
    .optional()
    .default("legacy")
    .catch("legacy"),
  // Empty means "use OPENAI_MODEL" — the chat is no longer on the lite tier.
  CHAT_MODEL: z.string().optional().default(""),
  // Which values a model accepts differs: gpt-5.6-luna takes none/low/medium/
  // high/xhigh/max and rejects "minimal" (a 400); older gpt-5 models take
  // minimal/low/medium/high. An unsupported value for the chosen model fails
  // the turn at OpenAI, so set one the model lists.
  CHAT_REASONING_EFFORT: z
    .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
    .optional()
    .default("low")
    .catch("low"),
  // OpenAI's hosted web_search tool for the chat agent. Off by default: it
  // adds per-call search fees and lets the model reach outside the brand's
  // own data, so it is an explicit opt-in.
  CHAT_WEB_SEARCH: z
    .string()
    .optional()
    .default("false")
    .transform((value) => value === "true"),
  // Guided setup (src/server/guided-setup/, docs/guided-setup.md): the bottom
  // sheet that sets a brand up by tapping. Server-only (never NEXT_PUBLIC_:
  // those are inlined at build time and frozen) and off by default, so a deploy
  // changes nothing until the owner turns it on. Only the literal "true"
  // enables; a typo reads as off.
  GUIDED_SETUP: z
    .string()
    .optional()
    .default("false")
    .transform((value) => value === "true"),
  // The one paid step of the sheet ("Get ideas": a Quick Discovery run with web
  // search). Needs GUIDED_SETUP as well. Kept apart because the hosted-search
  // path has not run live yet and it spends a shared prepaid credit.
  // Raw string on purpose: "false" | "true" | a comma-separated list of
  // workspace ids (canary), parsed by parseDiscoveryScope. A typo reads as off.
  GUIDED_SETUP_DISCOVERY: z.string().optional().default("false"),
  // Optional "user,workspace,global" run caps per 24 h, parsed by
  // parseDiscoveryCaps. It can only lower the documented ceilings.
  GUIDED_SETUP_DISCOVERY_CAPS: z.string().optional().default(""),
  // Works (docs/works.md): the Agency Desk as titled, channel-scoped
  // conversations listed in the sidebar instead of one endless chat. Server-only
  // and off by default (old single-chat behaviour, byte for byte) until the
  // owner has applied the add_work migration. Only the literal "true" enables.
  WORKS_UI: z
    .string()
    .optional()
    .default("false")
    .transform((value) => value === "true"),
  // Modules (src/lib/modules/catalog.ts): New Chat opens into the Social Media
  // Planner, Ads Manager, Analytics or SEO Manager, each walking the same
  // steps. A Work remembers its module, so they ride on Works (isModulesEnabled
  // also needs WORKS_UI). Server-only and off by default; only the literal
  // "true" enables.
  MODULES_UI: z
    .string()
    .optional()
    .default("false")
    .transform((value) => value === "true"),
  // gpt-image-2 — see openai-image-client.ts. Separate model slot from
  // OPENAI_MODEL because it names an image model, not a chat one.
  OPENAI_IMAGE_MODEL: z.string().optional().default("gpt-image-2"),

  // fal.ai — optional additional image-generation provider (see
  // fal-image-client.ts and fal-image-models.ts). Purely opt-in: the
  // Image Studio's fal.ai model group only appears when this is set, and
  // the existing Gemini -> OpenAI fallback chain is unaffected when it isn't.
  FAL_API_KEY: z.string().optional().default(""),

  R2_ACCOUNT_ID: z.string().optional().default(""),
  R2_ACCESS_KEY_ID: z.string().optional().default(""),
  R2_SECRET_ACCESS_KEY: z.string().optional().default(""),
  R2_BUCKET_NAME: z.string().optional().default(""),
  R2_PUBLIC_URL: z.string().optional().default(""),

  SENTRY_DSN: z.string().optional().default(""),

  CRON_SECRET: z.string().optional().default(""),
  TEMPORARY_SECRET_ENCRYPTION_KEY: z.string().optional().default(""),

  // Telegram Bot API — notification channel for dead letters that require
  // human intervention (see dead-letter.repository.ts).
  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_CHAT_ID: z.string().optional().default(""),

  // Google OAuth — so the client can grant read-only access to GA4 + Search
  // Console with their own Google account (see google-client.ts). The
  // redirect URI isn't a separate env var; it's derived from
  // NEXT_PUBLIC_APP_URL.
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional().default(""),

  // Meta (Facebook) OAuth — so the client can grant Instagram publishing +
  // ad campaign management permission with their own Meta Business account
  // (see meta-client.ts). The redirect URI isn't a separate env var; like
  // Google, it's derived from NEXT_PUBLIC_APP_URL.
  META_APP_ID: z.string().optional().default(""),
  META_APP_SECRET: z.string().optional().default(""),
  // "Instagram API with Instagram Login": connects an Instagram professional
  // account directly, with no Facebook account or Page. It lives in the SAME
  // Meta app (App Dashboard > Instagram > API setup with Instagram login) but
  // has its own "Instagram app ID" and "Instagram app secret", which are NOT
  // META_APP_ID / META_APP_SECRET. Optional: without them the Instagram tile
  // only offers the Facebook Page route.
  INSTAGRAM_APP_ID: z.string().optional().default(""),
  INSTAGRAM_APP_SECRET: z.string().optional().default(""),

  // TikTok Content Posting API (together with Login Kit) — so the client
  // can grant video publishing permission with their own TikTok account
  // (see tiktok-client.ts). PKCE is required (see server/security/pkce.ts).
  // The redirect URI isn't a separate env var; like the others, it's
  // derived from NEXT_PUBLIC_APP_URL. Content published from "Unaudited"
  // clients is automatically made private/self-only by TikTok — going
  // through TikTok's app audit process is required for public visibility.
  TIKTOK_CLIENT_KEY: z.string().optional().default(""),
  TIKTOK_CLIENT_SECRET: z.string().optional().default(""),

  // LinkedIn OAuth 2.0 (3-legged) — the "Sign In with LinkedIn using OpenID
  // Connect" and "Share on LinkedIn" products must be added to the app (see
  // linkedin-client.ts). Access tokens last ~60 days; refresh tokens may
  // additionally require "Programmatic Refresh Tokens" product approval.
  LINKEDIN_CLIENT_ID: z.string().optional().default(""),
  LINKEDIN_CLIENT_SECRET: z.string().optional().default(""),

  // X (Twitter) API v2 OAuth 2.0 — PKCE is required (see
  // server/security/pkce.ts). As of February 2026, there's no free tier for
  // new developers; creating a post is billed per use (see x-client.ts).
  X_CLIENT_ID: z.string().optional().default(""),
  X_CLIENT_SECRET: z.string().optional().default(""),
});

// Parsed lazily and cached — a missing optional integration must never crash
// boot. Only DATABASE_URL/AUTH_SECRET are hard requirements.
let cached: z.infer<typeof envSchema> | undefined;

export function getEnv() {
  if (!cached) {
    cached = envSchema.parse(process.env);
  }
  return cached;
}

export function isIntegrationConfigured(
  key:
    | "GEMINI"
    | "OPENAI"
    | "FAL"
    | "R2"
    | "SENTRY"
    | "TELEGRAM"
    | "GOOGLE"
    | "META"
    | "INSTAGRAM_LOGIN"
    | "TIKTOK"
    | "LINKEDIN"
    | "X",
): boolean {
  const env = getEnv();
  switch (key) {
    case "GEMINI":
      return Boolean(env.GEMINI_API_KEY);
    case "OPENAI":
      return Boolean(env.OPENAI_API_KEY);
    case "FAL":
      return Boolean(env.FAL_API_KEY);
    case "R2":
      return Boolean(
        env.R2_ACCOUNT_ID &&
        env.R2_ACCESS_KEY_ID &&
        env.R2_SECRET_ACCESS_KEY &&
        env.R2_BUCKET_NAME &&
        env.R2_PUBLIC_URL,
      );
    case "SENTRY":
      return Boolean(env.SENTRY_DSN);
    case "TELEGRAM":
      return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
    case "GOOGLE":
      return Boolean(
        env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET,
      );
    case "META":
      return Boolean(env.META_APP_ID && env.META_APP_SECRET);
    case "INSTAGRAM_LOGIN":
      return Boolean(env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET);
    case "TIKTOK":
      return Boolean(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET);
    case "LINKEDIN":
      return Boolean(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET);
    case "X":
      return Boolean(env.X_CLIENT_ID && env.X_CLIENT_SECRET);
  }
}
