import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1).optional(),

  AUTH_SECRET: z.string().min(1),
  AUTH_URL: z.string().min(1).optional(),
  NEXT_PUBLIC_APP_URL: z.string().min(1).default("http://localhost:3000"),
  // Meta/Instagram gibi dış sağlayıcıların asset görsellerini indirebilmesi
  // için gereken, gerçekten herkese açık taban URL (bkz. asset-public-link.ts
  // buildAssetPublicUrl). Ayrı tutuluyor çünkü NEXT_PUBLIC_APP_URL aynı
  // zamanda Meta OAuth redirect URI'sini de belirliyor (meta-client.ts) —
  // lokal geliştirmede yalnızca bunu bir tünele (ngrok vb.) çevirmek,
  // OAuth bağlantısını yeniden kurmayı gerektirmeden asset indirmeyi test
  // etmeyi sağlıyor. Boşsa NEXT_PUBLIC_APP_URL'e düşer.
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
  // Hub Connect'in izole OpenClaw ajanı — kurulumda `openclaw agents add
  // hubconnect` ile oluşturuldu; tüm yürütme trafiği varsayılan olarak ona
  // gider (profil bazında externalProfileId ile geçersiz kılınabilir).
  OPENCLAW_DEFAULT_AGENT_ID: z.string().optional().default("hubconnect"),
  OPENCLAW_TIMEOUT_SECONDS: z.coerce.number().optional().default(120),
  // `openclaw infer image generate --model <this>` — a direct provider CLI
  // call, independent of any agent/workspace. Confirmed against a live
  // gateway: the "openai" image provider is the one actually configured.
  OPENCLAW_IMAGE_MODEL: z.string().optional().default("openai/gpt-image-2"),

  // Google Gemini — ReasoningService'in birincil LLM arka ucu. Anahtar
  // varsa tüm zeka çağrıları Gemini'ye gider; model alias'ı en güncel
  // kararlı Pro'yu izler.
  GEMINI_API_KEY: z.string().optional().default(""),
  // DİKKAT: "gemini-pro-latest" en güncel Pro'ya çözümlenir ve Pro'nun
  // ücretsiz katman limiti günde yalnızca 250 istek — ajans döngüsü bunu
  // saatler içinde tüketip 429 alıyordu. Flash aynı kotada 10.000 istek
  // veriyor; kalite gerektiren tekil prompt'lar ReasoningDef.model ile
  // istisna tanımlayabilir.
  GEMINI_MODEL: z.string().optional().default("gemini-3.6-flash"),
  // Model kademeleri: prompt'lar ReasoningDef.tier ile "lite"/"pro" seçer,
  // hangi modele karşılık geldiği burada — böylece model değiştirmek için
  // prompt dosyalarına dokunmak gerekmez.
  GEMINI_LITE_MODEL: z.string().optional().default("gemini-3.1-flash-lite"),
  GEMINI_PRO_MODEL: z.string().optional().default("gemini-3.1-pro-preview"),
  // Görsel üretimi ayrı bir model ailesi: yanıtı `inlineData` içinde base64
  // döner. Kreatif çıktı doğrudan müşteriye gittiği için kalite önceliği:
  // Pro görsel modeli varsayılan. Hız/maliyet önceliği isteyen kurulum
  // gemini-3.1-flash-image'a çevirebilir.
  GEMINI_IMAGE_MODEL: z.string().optional().default("gemini-3-pro-image"),

  R2_ACCOUNT_ID: z.string().optional().default(""),
  R2_ACCESS_KEY_ID: z.string().optional().default(""),
  R2_SECRET_ACCESS_KEY: z.string().optional().default(""),
  R2_BUCKET_NAME: z.string().optional().default(""),
  R2_PUBLIC_URL: z.string().optional().default(""),

  SENTRY_DSN: z.string().optional().default(""),

  CRON_SECRET: z.string().optional().default(""),
  TEMPORARY_SECRET_ENCRYPTION_KEY: z.string().optional().default(""),

  // Telegram Bot API — insan müdahalesi gerektiren dead letter'lar için
  // bildirim kanalı (bkz. dead-letter.repository.ts).
  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_CHAT_ID: z.string().optional().default(""),

  // Google OAuth — müşterinin kendi Google hesabıyla GA4 + Search Console'a
  // salt-okunur erişim vermesi için (bkz. google-client.ts). Redirect URI
  // ayrı bir env var değil, NEXT_PUBLIC_APP_URL'den türetiliyor.
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional().default(""),

  // Meta (Facebook) OAuth — müşterinin kendi Meta Business hesabıyla
  // Instagram yayını + reklam kampanyası yönetimi izni vermesi için (bkz.
  // meta-client.ts). Redirect URI ayrı bir env var değil, Google'daki gibi
  // NEXT_PUBLIC_APP_URL'den türetiliyor.
  META_APP_ID: z.string().optional().default(""),
  META_APP_SECRET: z.string().optional().default(""),
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
  key: "OPENCLAW" | "GEMINI" | "R2" | "SENTRY" | "TELEGRAM" | "GOOGLE" | "META",
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
  }
}
