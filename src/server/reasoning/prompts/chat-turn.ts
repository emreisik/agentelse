import { z } from "zod";

import type { ReasoningDef } from "../types";

// Sohbet yüzeyinin beyni. Kural tabanlı `parseIntent` yalnızca bir avuç
// kalıbı tanıyor ("instagram postu hazırla" gibi) ve geri kalan her şeye
// UNKNOWN dönüyordu — yani kullanıcı serbestçe yazdığında ekran sessiz
// kalıyordu. Bu prompt iki işi birden yapar: kullanıcıya Türkçe (proje
// diline göre) gerçek bir yanıt yazar VE mesajın iş talebi mi, soru mu,
// onay mı olduğuna karar verir.
//
// Sohbetten tetiklenebilecek yetenekler bilinçli olarak kısıtlı: SIGNAL_SCAN
// / MEASUREMENT_CHECK gibi motor-içi yetenekler ajansın kendi ritmine ait,
// kullanıcı komutuyla tekil olarak çalıştırılmaz.
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
  // Kullanıcıya gösterilen yanıt. Proje dilinde, 2-5 cümle.
  reply: z.string(),
  intentKind: z.enum(["TASK", "ANSWER", "APPROVAL", "UNCLEAR"]),
  capability: z.enum(CHAT_CAPABILITIES).optional(),
  platform: z.enum(CHAT_PLATFORMS).optional(),
  // Göreve yazılacak, kendi başına anlaşılır brief. Kullanıcının cümlesini
  // aynen kopyalamak yerine sohbet geçmişindeki bağlamı içine alır —
  // yürütücü ajan sohbeti görmüyor, yalnızca bu metni görüyor.
  taskBrief: z.string().optional(),
  approvalDecision: z.enum(["APPROVE", "REJECT", "REVISE"]).optional(),
});

export type ChatTurnOutput = z.infer<typeof ChatTurnOutputSchema>;

export const chatTurnDef: ReasoningDef<ChatTurnOutput> = {
  purpose: "chat.turn",
  schema: ChatTurnOutputSchema,
  // Her kullanıcı mesajında çalışır — en sık çağrılan prompt. Ucuz kademe.
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
      reply: `Mock yanıt: "${message.slice(0, 120)}" mesajını aldım.`,
      intentKind: "ANSWER" as const,
    };
  },
};
