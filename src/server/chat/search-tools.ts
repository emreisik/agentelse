import "server-only";

import { z } from "zod";

import { SeoFlags, seoWorkAllowedFor } from "@/lib/seo/health-flags";
import {
  SeoInsightFlags,
  seoInsightsAllowedFor,
} from "@/lib/seo/insight-flags";
import type { SeoActionKind } from "@/lib/seo/opportunity-types";
import {
  inspectUrlForChat,
  querySearchPerformance,
  readOpportunitiesForChat,
  readPageSeo,
  readSearchOverviewForChat,
  SEARCH_DATA_NOTE,
  SEARCH_ROWS_MAX,
} from "@/server/seo/chat-readers";

import type { ChatTool, ToolContext, ToolOutcome } from "./tools";

// Sohbetin beş salt okunur Search Console aracı (SC-F4,
// docs/search-opportunities.md "Sohbet araçları"). Hepsi external: dönen
// sorgular, yollar ve sayfa metinleri dışarıdan gelir ve turu "tainted" yapar.
// Liste yalnız SEO_INSIGHTS=on, GSC_SYNC ve proje izin listesindeyken dolar
// (yalnız ortam okunur; kapalıyken modelin araç listesi bugünküyle aynıdır).
// inspect_url ayrıca SEO_HEALTH ister ve hassastır (kirli turda reddedilir).
// Her execute kapıları yeniden sınar ve projeyi yalnız ctx'ten alır; hata
// modele genel bir notla döner. tools.ts'ten yalnız tip alınır.

export { SEARCH_DATA_NOTE };

export const SEARCH_TOOL_NAMES = [
  "get_search_overview",
  "query_search_performance",
  "get_page_seo",
  "inspect_url",
  "get_seo_opportunities",
] as const;

const PHASES = ["ACTIVE", "ON_HOLD"] as const;

const OFF_RESULT = {
  status: "error",
  note: "Search Console insights are not turned on for this project.",
} as const;
const ERROR_RESULT = {
  status: "error",
  note: "Could not read Search Console data right now.",
} as const;

const ACTION_KINDS = [
  "TITLE_META",
  "CONTENT_REFRESH",
  "NEW_CONTENT",
  "INTERNAL_LINKS",
  "CONSOLIDATE",
  "TECH_FIX",
  "SCHEMA",
  "LOCALIZE",
  "INVESTIGATE",
] as const satisfies readonly SeoActionKind[];

function insightsOn(projectId: string): boolean {
  return SeoInsightFlags.userFacing() && seoInsightsAllowedFor(projectId);
}

// Kapı + okuyucu; okuyucu hatası modele yalnız genel notla döner.
async function guarded(
  name: string,
  ctx: ToolContext,
  read: (projectId: string) => Promise<Record<string, unknown>>,
  extraGate?: (projectId: string) => boolean,
): Promise<ToolOutcome> {
  const projectId = ctx.projectId;
  if (!projectId || !insightsOn(projectId))
    return { result: { ...OFF_RESULT } };
  if (extraGate && !extraGate(projectId)) return { result: { ...OFF_RESULT } };
  try {
    return { result: await read(projectId) };
  } catch {
    console.warn(`[search-tools] ${name} failed`);
    return { result: { ...ERROR_RESULT } };
  }
}

export const SearchOverviewArgs = z.object({});

export const SearchPerformanceArgsSchema = z.object({
  dimension: z.enum(["query", "page", "date", "country", "device"]),
  period: z.enum(["7d", "28d", "3m", "12m", "16m", "all"]).optional(),
  brand: z.enum(["all", "brand", "non-brand"]).optional(),
  contains: z.string().min(1).max(100).optional(),
  orderBy: z.enum(["clicks", "impressions"]).optional(),
  limit: z.number().int().min(1).max(SEARCH_ROWS_MAX).optional(),
});

export const PageUrlArgs = z.object({ url: z.string().min(1).max(2048) });

export const SeoOpportunitiesArgs = z.object({
  limit: z.number().int().min(1).max(10).optional(),
  actionKind: z.enum(ACTION_KINDS).optional(),
});

function defineTool<TArgs>(tool: ChatTool<TArgs>): ChatTool {
  return tool as unknown as ChatTool;
}

function overviewTool(): ChatTool {
  return defineTool({
    name: "get_search_overview",
    label: "Checking Google search…",
    kind: "read",
    external: true,
    phases: PHASES,
    description:
      "Google Search Console for the client's website at a glance, from Agentelse's stored data: clicks, impressions, CTR and average position for the last 28 days against the 28 days before (non-brand clicks first when brand terms are set), the last final day, the share of clicks from hidden searches, the top 5 non-brand searches and top 5 pages, open search opportunities and the search health score. Use before answering any question about how the site does in Google search.",
    schema: SearchOverviewArgs,
    execute: (_args, ctx) =>
      guarded("get_search_overview", ctx, (projectId) =>
        readSearchOverviewForChat(projectId),
      ),
  });
}

function performanceTool(): ChatTool {
  return defineTool({
    name: "query_search_performance",
    label: "Looking up search numbers…",
    kind: "read",
    external: true,
    phases: PHASES,
    description:
      "A Search Console breakdown from stored data when the overview doesn't answer: by search query, page, date, country or device, for the last 7 or 28 days, 3, 12 or 16 months or all stored history; optionally brand or non-brand searches only, a text the query or page path must contain, ordered by clicks or impressions, at most 20 rows. Returns clicks, impressions, CTR (percent) and average position.",
    schema: SearchPerformanceArgsSchema,
    execute: (args, ctx) =>
      guarded("query_search_performance", ctx, (projectId) =>
        querySearchPerformance(projectId, {
          ...args,
          period: args.period ?? "28d",
        }),
      ),
  });
}

function pageTool(): ChatTool {
  return defineTool({
    name: "get_page_seo",
    label: "Checking this page in Google…",
    kind: "read",
    external: true,
    phases: PHASES,
    description:
      "Everything stored about one page of the client's site in Google search: clicks, impressions, CTR and position for the last 4 weeks against the 4 weeks before, its top 10 searches, open SEO opportunities for it, and, when available, its Google index status, Core Web Vitals and what the site audit found on the page (title, description, heading, indexability). Pass the page's full address or its path.",
    schema: PageUrlArgs,
    execute: (args, ctx) =>
      guarded("get_page_seo", ctx, (projectId) =>
        readPageSeo(projectId, args.url),
      ),
  });
}

function inspectTool(): ChatTool {
  return defineTool({
    name: "inspect_url",
    label: "Asking Google about this page…",
    kind: "read",
    external: true,
    sensitive: true,
    phases: PHASES,
    description:
      "Is a page of the client's site in Google's index? Returns the stored Google URL Inspection result when it is less than a day old; otherwise queues a new inspection (it uses the site's daily inspection budget) and says when the result will appear. Only for addresses inside the connected Search Console property.",
    schema: PageUrlArgs,
    execute: (args, ctx) =>
      guarded(
        "inspect_url",
        ctx,
        (projectId) => inspectUrlForChat(projectId, args.url),
        (projectId) => SeoFlags.health() && seoWorkAllowedFor(projectId),
      ),
  });
}

function opportunitiesTool(): ChatTool {
  return defineTool({
    name: "get_seo_opportunities",
    label: "Finding search opportunities…",
    kind: "read",
    external: true,
    phases: PHASES,
    description:
      'The site\'s open SEO opportunities from Search Console data, highest priority first: answers "Which pages should I improve first?". Each has a title, a summary, an explanation when available, the expected extra clicks or reach per month, confidence, effort, the kind of action (title and meta, content refresh, new content, internal links, consolidate, technical fix, schema, localize, investigate), the page path or search keyword and its status. Optionally only one kind of action, at most 10.',
    schema: SeoOpportunitiesArgs,
    execute: (args, ctx) =>
      guarded("get_seo_opportunities", ctx, (projectId) =>
        readOpportunitiesForChat(projectId, args),
      ),
  });
}

// Yalnız ortam okunur (veritabanı yok); her çağrıda yeni dizi.
export function searchChatTools(projectId: string | null): ChatTool[] {
  if (!projectId || !insightsOn(projectId)) return [];
  return [
    overviewTool(),
    performanceTool(),
    pageTool(),
    ...(SeoFlags.health() ? [inspectTool()] : []),
    opportunitiesTool(),
  ];
}
