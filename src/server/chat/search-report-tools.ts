import "server-only";

import { z } from "zod";

import { gscToday, monthStart } from "@/lib/seo/dates";
import { limitGoogleStrings } from "@/lib/seo/llm-budget";
import { seoNarrativeFacts, diagnosisFacts } from "@/lib/seo/reports/facts";
import {
  SeoReportFlags,
  seoReportsActiveFor,
  seoReportsAllowedFor,
} from "@/lib/seo/reports/flags";
import type {
  SeoReportKind,
  SeoReportSnapshot,
  SeoRoadmapItem,
} from "@/lib/seo/reports/types";
import { maskGoogleText } from "@/server/integrations/google/pii";
import { runSearchDiagnosis } from "@/server/seo/reports/diagnose";
import { forecastSearchMonth } from "@/server/seo/reports/forecast";
import { listSeoGoals } from "@/server/seo/reports/goals";
import { reportContextFor } from "@/server/seo/reports/inputs";
import { latestSeoReport } from "@/server/seo/reports/store";

import { SEARCH_DATA_NOTE } from "./search-tools";
import type { ChatTool, ToolContext, ToolOutcome } from "./tools";

// Sohbetin üç salt okunur SEO rapor aracı (SC-F5, docs/search-reports.md
// "Sohbet araçları"): düşüş teşhisi, son rapor, SEO hedefleri. Liste yalnız
// SEO_REPORTS (+ GSC_SYNC) ve proje izin listesindeyken dolar (yalnız ortam
// okunur; kapalıyken modelin araç listesi bugünküyle aynıdır). Her sonuç en
// çok 20 farklı Google dizgisi taşır. Hata modele yalnız genel notla döner
// (hata metni Google verisi taşıyabilir). tools.ts'ten yalnız tip alınır
// (çalışma zamanı döngüsü yok); defineTool dışa aktarılmadığı için aynı
// dönüştürme yerel asTool ile yapılır.

export const SEARCH_REPORT_TOOL_NAMES = [
  "diagnose_search_drop",
  "get_seo_report",
  "get_seo_goals",
] as const;

const ACTIVE_ONLY = ["ACTIVE"] as const;
const PHASES = ["ACTIVE", "ON_HOLD"] as const;

const OFF_RESULT = {
  status: "off",
  note: "Search reports are not turned on for this project.",
} as const;
const ERROR_RESULT = {
  status: "error",
  note: "Search data could not be read right now.",
} as const;

function asTool<T>(tool: ChatTool<T>): ChatTool {
  return tool as unknown as ChatTool;
}

// Kapı + okuyucu; okuyucu hatası modele yalnız genel notla döner.
async function guarded(
  name: string,
  ctx: ToolContext,
  read: (projectId: string) => Promise<Record<string, unknown>>,
): Promise<ToolOutcome> {
  const projectId = ctx.projectId;
  if (!projectId || !seoReportsActiveFor(projectId)) {
    return { result: { ...OFF_RESULT } };
  }
  try {
    return { result: await read(projectId) };
  } catch (error) {
    console.warn(
      `[search-report-tools] ${name} failed:`,
      error instanceof Error ? error.name : "error",
    );
    return { result: { ...ERROR_RESULT } };
  }
}

const KIND_OF = {
  weekly: "WEEKLY",
  monthly: "MONTHLY",
  roadmap: "ROADMAP",
  pulse: "PULSE",
} as const satisfies Record<string, SeoReportKind>;

export const DiagnoseArgs = z.object({
  period: z.enum(["7d", "28d"]).optional(),
});
export const SeoReportArgs = z.object({
  kind: z.enum(["weekly", "monthly", "roadmap", "pulse"]).optional(),
});
export const SeoGoalsArgs = z.object({});

// Yol haritası maddeleri: başlık Google dizgisi taşıyabilir (fırsat başlığı,
// sorgu); maskelenir ve toplamda en çok 20 farklı dizgiyle sınırlanır.
function roadmapDetail(snapshot: SeoReportSnapshot): Record<string, unknown> {
  const entries: { list: "actions" | "techDebt"; item: SeoRoadmapItem }[] = [];
  for (const section of snapshot.sections) {
    if (section.type !== "roadmap") continue;
    for (const item of section.actions) entries.push({ list: "actions", item });
    for (const item of section.techDebt) {
      entries.push({ list: "techDebt", item });
    }
  }
  const kept = limitGoogleStrings(entries, (entry) => [
    maskGoogleText(entry.item.title),
  ]).items;
  const shape = (list: "actions" | "techDebt") =>
    kept
      .filter((entry) => entry.list === list)
      .map(({ item }) => ({
        title: maskGoogleText(item.title),
        action: item.action,
        source: item.source,
        clicksPerMonth: item.impactPerMonth,
        effort: item.effort,
        severity: item.severity,
        count: item.count,
      }));
  return { actions: shape("actions"), techDebt: shape("techDebt") };
}

function pulseDetail(snapshot: SeoReportSnapshot): Record<string, unknown> {
  for (const section of snapshot.sections) {
    if (section.type !== "pulse") continue;
    const { pulse } = section;
    return {
      day: pulse.day,
      metric: pulse.metric,
      value: pulse.value,
      usual: pulse.usual,
      changePct:
        pulse.changePct === null
          ? null
          : Math.round(pulse.changePct * 1000) / 10,
      newCritical: pulse.newCritical,
      openCritical: pulse.openCritical,
      biggest: pulse.biggest,
    };
  }
  return {};
}

function diagnoseTool(): ChatTool {
  return asTool({
    name: "diagnose_search_drop",
    label: "Checking why search traffic changed",
    kind: "read",
    external: true,
    phases: ACTIVE_ONLY,
    description:
      "Why did the site's Google search clicks change? Runs a fixed 8-step check on the stored Search Console data (data or connection, index coverage, technical blocks, Google updates, demand, positions, click-through rate, another page taking over) for the last 7 or 28 final days against the period before, and returns the likeliest cause with the evidence for each step. When clicks dropped, the result lists screens only the site owner can check (Manual actions and Security issues in Search Console): always pass those on to the user.",
    schema: DiagnoseArgs,
    execute: (args, ctx) =>
      guarded("diagnose_search_drop", ctx, async (projectId) => {
        const outcome = await runSearchDiagnosis(projectId, {
          days: args.period === "7d" ? 7 : 28,
        });
        if (!outcome.ok) {
          return { status: outcome.reason, note: SEARCH_DATA_NOTE };
        }
        return {
          status: "ok",
          diagnosis: diagnosisFacts(outcome.diagnosis),
          note: SEARCH_DATA_NOTE,
        };
      }),
  });
}

function reportTool(): ChatTool {
  return asTool({
    name: "get_seo_report",
    label: "Opening the latest SEO report",
    kind: "read",
    external: true,
    phases: PHASES,
    description:
      "The newest stored SEO report for the site: weekly (default), monthly, roadmap or pulse. Returns the report's numbers (clicks, impressions, CTR, position against the previous period and last year, biggest gainers and losers, search health, opportunities, diagnosis, goals, forecast), the AI summary when there is one and a link to the report. Numbers are final Search Console days only.",
    schema: SeoReportArgs,
    execute: (args, ctx) =>
      guarded("get_seo_report", ctx, async (projectId) => {
        const kind = KIND_OF[args.kind ?? "weekly"];
        const view = await latestSeoReport(projectId, kind);
        if (!view) return { status: "none" };
        const narrativeKind = kind === "WEEKLY" || kind === "MONTHLY";
        return {
          status: "ok",
          title: view.title,
          period: view.snapshot.period.label,
          facts: narrativeKind ? seoNarrativeFacts(view.snapshot).facts : null,
          detail:
            kind === "ROADMAP"
              ? roadmapDetail(view.snapshot)
              : kind === "PULSE"
                ? pulseDetail(view.snapshot)
                : null,
          summary: view.narrative,
          href: view.searchHref,
          note: SEARCH_DATA_NOTE,
        };
      }),
  });
}

function goalsTool(): ChatTool {
  return asTool({
    name: "get_seo_goals",
    label: "Checking search goals",
    kind: "read",
    external: false,
    phases: PHASES,
    description:
      "The project's search goals (non-brand clicks a month, clicks a month, non-brand searches in Google's top 10, share of pages indexed, share of pages with good Core Web Vitals) with the target, the current value, the pace (reached, on track, behind, at risk, not enough data) and the 13-week projection, plus a forecast of this month's search clicks with its range. Goals are set on the Search page, not here.",
    schema: SeoGoalsArgs,
    execute: (_args, ctx) =>
      guarded("get_seo_goals", ctx, async (projectId) => {
        const goals = await listSeoGoals(projectId);
        const link = await reportContextFor(projectId);
        const forecast = link
          ? await forecastSearchMonth(link, monthStart(gscToday(new Date())))
          : null;
        return {
          goals: goals.map((goal) => ({
            title: goal.title,
            metric: goal.metricKey,
            target: goal.target,
            current: goal.current,
            pace: goal.paceLabel,
            measuredThrough: goal.measuredThrough,
            projected: goal.projected,
            projectedLow: goal.projectedLow,
            projectedHigh: goal.projectedHigh,
          })),
          forecast,
        };
      }),
  });
}

// Yalnız ortam okunur (veritabanı yok); her çağrıda yeni dizi.
export function searchReportChatTools(projectId: string | null): ChatTool[] {
  if (!SeoReportFlags.on() || !projectId || !seoReportsAllowedFor(projectId)) {
    return [];
  }
  return [diagnoseTool(), reportTool(), goalsTool()];
}
