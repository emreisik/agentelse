import "server-only";

import { SeoFlags } from "@/lib/seo/health-flags";
import { seoContentPlanActiveFor } from "@/lib/seo/content-plan/flags";
import { monthEnd } from "@/lib/seo/dates";
import { periodKeyOf } from "@/lib/seo/reports/ids";
import { buildRoadmap } from "@/lib/seo/reports/roadmap";
import { reportNotes } from "@/lib/seo/reports/snapshot";
import { SEO_REPORT_TITLE, monthLabel } from "@/lib/seo/reports/text";
import type { SeoReportSection } from "@/lib/seo/reports/types";
import { readAuditSummary } from "@/server/seo/crawl/audit-summary";

import { forecastSearchMonth } from "./forecast";
import { listSeoGoals } from "./goals";
import {
  readContentPlan,
  readOpenSearchAlerts,
  readOpportunities,
  readQuickWins,
  type ReportLinkContext,
} from "./inputs";
import type { BuiltReport, ReportSkip } from "./pulse";

export type { BuiltReport, ReportSkip } from "./pulse";

// SEO yol haritası (docs/search-reports.md "Yol haritası"): aylık raporun
// hemen ardından planlanan ay için yazılan, belirlenimci (LLM yok) kart.
// Yalnız okur. Hızlı kazanımlar yalnız W3 fırsatı yokken kullanılır; teknik
// denetim grupları yalnız SEO_HEALTH açıkken.

const OPPORTUNITY_LIMIT = 10;

export async function buildRoadmapReport(
  ctx: ReportLinkContext,
  month: string,
  now: Date,
): Promise<BuiltReport | ReportSkip> {
  const [opportunityRows, alertRows, audit] = await Promise.all([
    readOpportunities(ctx.projectId, OPPORTUNITY_LIMIT),
    readOpenSearchAlerts(ctx.projectId),
    SeoFlags.health() ? readAuditSummary(ctx.projectId) : Promise.resolve(null),
  ]);
  const opportunities = opportunityRows ?? [];
  const quickWins =
    opportunities.length === 0 ? await readQuickWins(ctx, now) : [];

  const roadmap = buildRoadmap({
    opportunities,
    alerts: alertRows ?? [],
    audit: (audit?.groups ?? []).map((group) => ({
      title: group.title,
      severity: group.severity,
      count: group.count,
    })),
    quickWins,
  });

  const [planned, goals, forecast] = await Promise.all([
    readContentPlan(ctx.projectId, month, ctx.timezone),
    listSeoGoals(ctx.projectId),
    forecastSearchMonth(ctx, month),
  ]);

  const candidates: (SeoReportSection | null)[] = [
    roadmap.actions.length > 0 || roadmap.techDebt.length > 0
      ? {
          type: "roadmap",
          actions: roadmap.actions,
          techDebt: roadmap.techDebt,
        }
      : null,
    planned.length > 0
      ? {
          type: "content",
          // SC-F7: aylık plan etkinken başlık planın bölüm adıyla aynıdır; kapalıyken eski başlık.
          title: seoContentPlanActiveFor(ctx.projectId)
            ? "This month's articles"
            : "Planned SEO articles",
          items: planned,
        }
      : null,
    goals.length > 0 ? { type: "goals", goals } : null,
    forecast ? { type: "forecast", forecast } : null,
  ];
  const sections = candidates.filter(
    (section): section is SeoReportSection => section !== null,
  );
  if (sections.length === 0) return { skipped: "no_data" };

  return {
    snapshot: {
      v: 1,
      kind: "ROADMAP",
      title: SEO_REPORT_TITLE.ROADMAP,
      periodKey: periodKeyOf("ROADMAP", month),
      period: { from: month, to: monthEnd(month), label: monthLabel(month) },
      compare: null,
      yearAgo: null,
      site: { label: ctx.siteLabel, isMock: ctx.link.isMock },
      finalThrough: ctx.finalThrough,
      brandSplit: ctx.brandSplitReady,
      anonymousShare: null,
      sections,
      notes: reportNotes({
        finalThrough: ctx.finalThrough,
        anonymousShare: null,
        brandSplit: ctx.brandSplitReady,
        truncated: false,
        lowData: false,
        isMock: ctx.link.isMock,
      }),
    },
  };
}
