import "server-only";

import { z } from "zod";

import { seoContentPlanActiveFor } from "@/lib/seo/content-plan/flags";
import {
  CONTENT_PLAN_DATA_NOTE,
  readContentPlanForChat,
  regeneratePlanForChat,
} from "@/server/seo/content-plan/chat-readers";

import type { ChatTool, ToolContext, ToolOutcome } from "./tools";

// Sohbetin iki aylık SEO içerik planı aracı (SC-F7, docs/search-content-plan.md
// "Arayüz"). get_seo_content_plan salt okunurdur ve external'dır (sorgular ve
// yollar dışarıdan gelir, turu "tainted" yapar); regenerate_seo_content_plan
// plan satırını değiştirir: kind "note", sensitive ve decisive, yani kirli
// turda reddedilir ve mesajın İLK eylemi olmak zorundadır. Bu yüzden "planı
// göster, sonra s2'yi değiştir" tek mesajda hep ikinci adımda reddedilir.
// Liste yalnız ortamdan dolar (SEO_CONTENT_PLAN + üç bağımlı bayrak + proje
// izin listesi; kapalıyken modelin araç listesi bugünküyle aynıdır). Her
// execute kapıyı yeniden sınar, projeyi yalnız ctx'ten alır; hata modele genel
// bir notla döner. tools.ts'ten yalnız tip alınır (çalışma zamanı döngüsü yok).

export { CONTENT_PLAN_DATA_NOTE };

export const SEO_CONTENT_TOOL_NAMES = [
  "get_seo_content_plan",
  "regenerate_seo_content_plan",
] as const;

const PHASES = ["ACTIVE", "ON_HOLD"] as const;

const OFF_RESULT = {
  status: "error",
  note: "The monthly SEO content plan is not turned on for this project.",
} as const;
const ERROR_RESULT = {
  status: "error",
  note: "Could not read the SEO content plan right now.",
} as const;
const NO_USER_RESULT = {
  status: "error",
  note: "The plan can only be refreshed on behalf of a signed-in user.",
} as const;

export const SeoContentPlanArgs = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
});

export const RegenerateSeoContentPlanArgs = z.object({
  slotId: z.string().min(1).max(12).optional(),
});

function defineTool<TArgs>(tool: ChatTool<TArgs>): ChatTool {
  return tool as unknown as ChatTool;
}

// Kapı + okuyucu; okuyucu hatası modele yalnız genel notla döner.
async function guarded(
  name: string,
  ctx: ToolContext,
  run: (projectId: string) => Promise<unknown>,
): Promise<ToolOutcome> {
  const projectId = ctx.projectId;
  if (!projectId || !seoContentPlanActiveFor(projectId)) {
    return { result: { ...OFF_RESULT } };
  }
  try {
    return { result: await run(projectId) };
  } catch {
    console.warn(`[search-content-tools] ${name} failed`);
    return { result: { ...ERROR_RESULT } };
  }
}

function readTool(): ChatTool {
  return defineTool({
    name: "get_seo_content_plan",
    label: "Checking this month's SEO articles…",
    kind: "read",
    external: true,
    phases: PHASES,
    description:
      'The monthly SEO article plan for the client\'s website: which new articles are planned this month (or the month given as YYYY-MM), each with its title, search keyword, planned day, state, why it was picked (share of non-brand searches and the gap it fills), and, for the first few, the pages to link from and to. Also the monthly limit and how many articles the month already holds, plus how the plan is made. Use it to answer "what SEO articles are planned?" or "why this topic?". Planning itself runs automatically; to replace articles use regenerate_seo_content_plan.',
    schema: SeoContentPlanArgs,
    execute: (args, ctx) =>
      guarded("get_seo_content_plan", ctx, (projectId) =>
        readContentPlanForChat(projectId, args.month),
      ),
  });
}

function regenerateTool(): ChatTool {
  return defineTool({
    name: "regenerate_seo_content_plan",
    label: "Refreshing the SEO article plan…",
    kind: "note",
    sensitive: true,
    decisive: true,
    phases: PHASES,
    description:
      "Replace the planned SEO articles of this month with a fresh pick from the newest search data (or only one article when slotId is given, for example s2). It must be the FIRST action of a new message: it is refused after any other tool has run in the same message, including get_seo_content_plan, so never combine it with showing the plan. It replaces only articles that are not started or written yet, at most 3 refreshes per plan, and it cannot raise the monthly limit (that is set on the Search page). Only call it when the user clearly asked to refresh or replace planned articles.",
    schema: RegenerateSeoContentPlanArgs,
    execute: async (args, ctx) => {
      if (!ctx.userId) return { result: { ...NO_USER_RESULT } };
      const userId = ctx.userId;
      return guarded("regenerate_seo_content_plan", ctx, (projectId) =>
        regeneratePlanForChat(projectId, userId, args.slotId),
      );
    },
  });
}

// Yalnız ortam okunur (veritabanı yok); her çağrıda yeni dizi.
export function seoContentPlanChatTools(projectId: string | null): ChatTool[] {
  if (!projectId || !seoContentPlanActiveFor(projectId)) return [];
  return [readTool(), regenerateTool()];
}
