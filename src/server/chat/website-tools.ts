import "server-only";

import { z } from "zod";

import { gaInsightsListed } from "@/lib/website-analytics/analysis/flags";
import {
  QUERY_DIMENSIONS,
  QUERY_FILTER_MAX,
  QUERY_MAX_DIMENSIONS,
  QUERY_MAX_METRICS,
  QUERY_MAX_ROWS,
  QUERY_METRICS,
} from "@/lib/website-analytics/analysis/query-plan";
import { WEBSITE_PERIODS } from "@/lib/website-analytics/periods";

import type { ChatTool, ToolOutcome } from "./tools";
import {
  explainWebsiteChangeForChat,
  measurementHealthForChat,
  queryWebsiteAnalyticsForChat,
  websiteOverviewForChat,
} from "./website-read";

// Sohbetin dört salt okunur Google Analytics aracı (GA-F4,
// docs/website-insights.md "Sohbet"). Hepsi external: dönen veri (sayfa
// adları, kampanyalar, arama sözcükleri) dışarıdan gelir ve turu "tainted"
// yapar. Yalnız gaInsightsListed() iken sunulur (tools.ts); execute yine proje
// modunu sınar (website-read.ts). Hata metni modele hiç verilmez: Google
// yükü taşıyabilir. tools.ts'ten yalnız tip alınır (çalışma zamanı döngüsü yok).

export const WEBSITE_CHAT_TOOL_NAMES = [
  "get_website_overview",
  "query_website_analytics",
  "explain_website_change",
  "get_measurement_health",
] as const;

export const WEBSITE_CHAT_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  WEBSITE_CHAT_TOOL_NAMES,
);

const PHASES = ["ACTIVE", "ON_HOLD"] as const;

const ERROR_RESULT = {
  status: "error",
  note: "Could not read website data right now.",
} as const;

// Okuyucu hatası modele yalnız genel bir notla döner.
async function safely(
  name: string,
  read: () => Promise<Record<string, unknown>>,
): Promise<ToolOutcome> {
  try {
    return { result: await read() };
  } catch {
    console.warn(`[website-tools] ${name} failed`);
    return { result: { ...ERROR_RESULT } };
  }
}

const PERIOD_KEYS = WEBSITE_PERIODS.map((period) => period.key) as [
  (typeof WEBSITE_PERIODS)[number]["key"],
  ...(typeof WEBSITE_PERIODS)[number]["key"][],
];

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const WebsiteOverviewArgs = z.object({
  period: z.enum(PERIOD_KEYS).optional(),
});

export const WebsiteQueryArgsSchema = z.object({
  dimensions: z
    .array(z.enum(QUERY_DIMENSIONS))
    .max(QUERY_MAX_DIMENSIONS)
    .optional(),
  metrics: z.array(z.enum(QUERY_METRICS)).min(1).max(QUERY_MAX_METRICS),
  period: z.enum([...PERIOD_KEYS, "custom"]).optional(),
  from: DAY.optional(),
  to: DAY.optional(),
  limit: z.number().int().min(1).max(QUERY_MAX_ROWS).optional(),
  filter: z
    .object({
      dimension: z.enum(QUERY_DIMENSIONS),
      contains: z.string().min(1).max(QUERY_FILTER_MAX),
    })
    .optional(),
});

export const WebsiteChangeArgs = z.object({
  metric: z.enum(["keyEvents", "sessions", "revenue"]).optional(),
  period: z
    .enum(["yesterday", "last_week", "last_7d", "last_28d", "last_month"])
    .optional(),
  compare: z.enum(["previous", "last_year"]).optional(),
});

export const MeasurementHealthArgs = z.object({});

function defineTool<TArgs>(tool: ChatTool<TArgs>): ChatTool {
  return tool as unknown as ChatTool;
}

const getWebsiteOverview = defineTool({
  name: "get_website_overview",
  label: "Checking your website…",
  kind: "read",
  external: true,
  phases: PHASES,
  description:
    "Google Analytics for the client's website at a glance, from Agentelse's stored daily data: visits, engaged visits, key events (leads, sales, sign-ups), revenue, top channels and landing pages for a period with the change against the period before, data freshness, the measurement health score and open findings. Use before answering any question about the website's traffic or results.",
  schema: WebsiteOverviewArgs,
  execute: (args, ctx) =>
    safely("get_website_overview", () =>
      websiteOverviewForChat(ctx.projectId, args),
    ),
});

const queryWebsiteAnalytics = defineTool({
  name: "query_website_analytics",
  label: "Looking up website numbers…",
  kind: "read",
  external: true,
  phases: PHASES,
  description:
    "A custom Google Analytics breakdown when the overview and explain tools don't answer: up to 2 dimensions and 4 metrics from the allowed lists, a period up to 400 days back, at most 20 rows. Reads stored data first and asks Google live only when needed.",
  schema: WebsiteQueryArgsSchema,
  execute: (args, ctx) =>
    safely("query_website_analytics", () =>
      queryWebsiteAnalyticsForChat(ctx.projectId, args),
    ),
});

const explainWebsiteChange = defineTool({
  name: "explain_website_change",
  label: "Explaining the change…",
  kind: "read",
  external: true,
  phases: PHASES,
  description:
    'Explain why a website number changed (e.g. "Why did leads drop last week?"): splits the change of key events, visits or revenue into channels and landing pages (more or fewer visits vs. better or worse conversion), with significance, tracking problems and public holidays. Base your reply on the returned `answer`; every figure in it comes from stored Google Analytics data.',
  schema: WebsiteChangeArgs,
  execute: (args, ctx) =>
    safely("explain_website_change", () =>
      explainWebsiteChangeForChat(ctx.projectId, args),
    ),
});

const getMeasurementHealth = defineTool({
  name: "get_measurement_health",
  label: "Checking website tracking…",
  kind: "read",
  external: true,
  phases: PHASES,
  description:
    "Is the website's Google Analytics tracking trustworthy? Returns the measurement health score, failing or warning checks with plain fix steps, and days whose numbers are suspect.",
  schema: MeasurementHealthArgs,
  execute: (_args, ctx) =>
    safely("get_measurement_health", () =>
      measurementHealthForChat(ctx.projectId),
    ),
});

export const WEBSITE_CHAT_TOOLS: readonly ChatTool[] = [
  getWebsiteOverview,
  queryWebsiteAnalytics,
  explainWebsiteChange,
  getMeasurementHealth,
];

export function websiteChatToolsListed(): boolean {
  return gaInsightsListed();
}
