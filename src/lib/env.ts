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

  // OpenClaw integrates as a CLI subprocess, not an HTTP API — its real
  // interface is `openclaw agent --json` (see openclaw-client.ts). Path to
  // the `openclaw` binary; empty means "not configured".
  OPENCLAW_CLI_PATH: z.string().optional().default(""),
  // Optional: a Node binary compatible with OpenClaw's engine requirement,
  // when the environment's default `node` is older (this machine's default
  // is v21.7.1; OpenClaw requires >=22.22/24.15/25.9). When set, we spawn
  // `<OPENCLAW_NODE_PATH> <OPENCLAW_CLI_PATH> ...` instead of the CLI path
  // directly.
  OPENCLAW_NODE_PATH: z.string().optional().default(""),
  // Hub Connect's isolated OpenClaw agent — created during setup with
  // `openclaw agents add hubconnect`; all execution traffic goes to it by
  // default (can be overridden per profile via externalProfileId).
  OPENCLAW_DEFAULT_AGENT_ID: z.string().optional().default("hubconnect"),
  OPENCLAW_TIMEOUT_SECONDS: z.coerce.number().optional().default(120),
  // `openclaw infer image generate --model <this>` — a direct provider CLI
  // call, independent of any agent/workspace. Confirmed against a live
  // gateway: the "openai" image provider is the one actually configured.
  OPENCLAW_IMAGE_MODEL: z.string().optional().default("openai/gpt-image-2"),

  // Google Gemini — ReasoningService's primary LLM backend. If a key is
  // set, all reasoning calls go to Gemini; the model alias tracks the
  // latest stable Pro.
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
  // client, quality is the priority — the Pro image model is the default.
  // A setup that prioritizes speed/cost can switch to
  // gemini-3.1-flash-image.
  GEMINI_IMAGE_MODEL: z.string().optional().default("gemini-3-pro-image"),

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
    | "OPENCLAW"
    | "GEMINI"
    | "R2"
    | "SENTRY"
    | "TELEGRAM"
    | "GOOGLE"
    | "META"
    | "TIKTOK"
    | "LINKEDIN"
    | "X",
): boolean {
  const env = getEnv();
  switch (key) {
    case "OPENCLAW":
      return Boolean(env.OPENCLAW_CLI_PATH);
    case "GEMINI":
      return Boolean(env.GEMINI_API_KEY);
    case "R2":
      return Boolean(
        env.R2_ACCOUNT_ID &&
        env.R2_ACCESS_KEY_ID &&
        env.R2_SECRET_ACCESS_KEY &&
        env.R2_BUCKET_NAME,
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
    case "TIKTOK":
      return Boolean(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET);
    case "LINKEDIN":
      return Boolean(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET);
    case "X":
      return Boolean(env.X_CLIENT_ID && env.X_CLIENT_SECRET);
  }
}
