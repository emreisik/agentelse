import { KPI_LABEL } from "./text";
import { seoReportCommandId } from "./ids";
import {
  DIAGNOSE_STEP_QUESTION,
  SEO_REPORT_TITLE,
  TABLE_TITLE,
  periodLabel,
} from "./text";
import { reportNotes } from "./snapshot";
import type {
  DiagnoseStep,
  DiagnoseStepKey,
  SearchDiagnosis,
  SeoKpiKey,
  SeoReportKind,
  SeoReportKpi,
  SeoReportRow,
  SeoReportSection,
  SeoReportSnapshot,
  SeoReportView,
  SeoTableKey,
} from "./types";

// Birim testleri için örnek rapor anlık görüntüsü ve görünümü. Her çeşit için
// o çeşitte geçerli her bölüm türü bulunur. Üretim koduna girmez.

const STEP_ORDER: readonly DiagnoseStepKey[] = [
  "data",
  "indexing",
  "technical",
  "update",
  "demand",
  "ranking",
  "ctr",
  "cannibalization",
];

function kpi(
  key: SeoKpiKey,
  value: number,
  previous: number,
  yearAgo: number,
): SeoReportKpi {
  const format =
    key === "ctr" ? "percent" : key === "position" ? "position" : "count";
  return {
    key,
    label: KPI_LABEL[key],
    value,
    previous,
    yearAgo,
    format,
    lowerIsBetter: key === "position",
  };
}

function row(
  label: string,
  clicks: number,
  previousClicks: number,
  options: { url?: string | null; isBrand?: boolean } = {},
): SeoReportRow {
  return {
    label,
    url: options.url ?? null,
    isBrand: options.isBrand ?? false,
    clicks,
    previousClicks,
    impressions: clicks * 20,
    previousImpressions: previousClicks * 20,
    position: 6.4,
    previousPosition: 5.9,
  };
}

function table(key: SeoTableKey, rows: SeoReportRow[]): SeoReportSection {
  return {
    type: "table",
    table: {
      key,
      title: TABLE_TITLE[key],
      aggregation: key.endsWith("pages") ? "By page" : "By property",
      rows,
    },
  };
}

function diagnosis(): SearchDiagnosis {
  const steps: DiagnoseStep[] = STEP_ORDER.map((key) => ({
    key,
    question: DIAGNOSE_STEP_QUESTION[key],
    verdict: key === "ranking" ? "yes" : key === "ctr" ? "unknown" : "no",
    evidence:
      key === "ranking"
        ? ["Average position worsened from 6.2 to 8.1."]
        : ["Nothing unusual found."],
    metrics:
      key === "ranking"
        ? ({ previousPosition: 6.2, position: 8.1 } as Record<string, number>)
        : ({} as Record<string, number>),
    items:
      key === "ranking"
        ? [{ label: "blue running shoes", detail: "Position 4.2 to 9.8" }]
        : [],
  }));
  return {
    v: 1,
    metric: "nonBrandClicks",
    window: {
      current: { from: "2026-09-28", to: "2026-10-04" },
      previous: { from: "2026-09-21", to: "2026-09-27" },
    },
    current: 840,
    previous: 1200,
    changePct: -0.3,
    dropped: true,
    primary: "ranking",
    also: ["ctr"],
    steps,
    askUser: [
      {
        screen: "Manual actions",
        text: "Open Manual actions in Search Console and confirm there is no penalty.",
      },
      {
        screen: "Security issues",
        text: "Open Security issues in Search Console and confirm there is nothing listed.",
      },
    ],
    summary: "Non-brand clicks fell, most likely because of lower positions.",
  };
}

function healthSection(): SeoReportSection {
  return {
    type: "health",
    health: {
      score: 82,
      cappedByCritical: false,
      critical: 0,
      warn: 2,
      issues: [
        { title: "Sitemap has not been read for 9 days", severity: "WARN" },
        { title: "3 pages are crawled but not indexed", severity: "WARN" },
      ],
      coverage: { point: 0.91, low: 0.88, high: 0.94, weekStart: "2026-09-28" },
      cwv: { phone: "good", desktop: "needs-improvement" },
    },
  };
}

function goalsSection(): SeoReportSection {
  return {
    type: "goals",
    goals: [
      {
        goalId: "goal_1",
        title: "Reach 1,200 non-brand search clicks a month",
        metricKey: "gsc.nonBrandClicks",
        target: 1200,
        current: 840,
        pace: "at_risk",
        paceLabel: "At risk",
        measuredThrough: "2026-10-05",
        projected: 910,
        projectedLow: 780,
        projectedHigh: 1040,
      },
    ],
  };
}

function forecastSection(): SeoReportSection {
  return {
    type: "forecast",
    forecast: {
      metric: "nonBrandClicks",
      month: "2026-10-01",
      value: 3600,
      low: 3060,
      high: 4140,
      method: "trend",
      historyMonths: 9,
      errorPct: 0.15,
      newContent: { clicks: 120, pages: 4, share: 0.03 },
    },
  };
}

function contentSection(): SeoReportSection {
  return {
    type: "content",
    title: "Planned SEO articles",
    items: [
      {
        title: "How to choose trail shoes",
        date: "2026-10-12",
        status: "APPROVED",
      },
    ],
  };
}

function opportunitiesSection(): SeoReportSection {
  return {
    type: "opportunities",
    items: [
      {
        id: "finding_1",
        title: "Improve the title of the trail shoes page",
        action: "Rewrite title",
        impactPerMonth: 45,
        reachPerMonth: null,
        confidence: "Solid",
        effort: "Low",
        status: "OPEN",
        priority: 80,
      },
      {
        id: "finding_2",
        title: "Add a section for blue running shoes",
        action: "Add content",
        impactPerMonth: null,
        reachPerMonth: 900,
        confidence: "Directional",
        effort: "Medium",
        status: "OPEN",
        priority: 60,
      },
    ],
  };
}

function sections(kind: SeoReportKind): SeoReportSection[] {
  const kpis: SeoReportSection = {
    type: "kpis",
    kpis: [
      kpi("nonBrandClicks", 840, 1200, 700),
      kpi("brandClicks", 410, 400, 380),
      kpi("clicks", 1250, 1600, 1080),
      kpi("impressions", 52000, 61000, 40000),
      kpi("ctr", 2.4, 2.62, 2.7),
      kpi("position", 8.1, 6.2, 9.4),
    ],
    compareLabel: "Previous period",
    yearAgoLabel: "Last year",
  };
  const tables: SeoReportSection[] = [
    table("winning_queries", [
      row("trail shoes", 120, 80),
      row("waterproof running jacket", 60, 30),
    ]),
    table("losing_queries", [
      row("blue running shoes", 40, 130),
      row("best running socks", 20, 60),
    ]),
    table("winning_pages", [
      row("/trail-shoes", 150, 90, { url: "https://example.com/trail-shoes" }),
    ]),
    table("losing_pages", [
      row("/blog/running-socks", 30, 95, {
        url: "https://example.com/blog/running-socks",
      }),
    ]),
    table("rising_queries", [row("carbon plate shoes", 12, 0)]),
  ];
  const actions: SeoReportSection = {
    type: "actions",
    actions: {
      accepted: 2,
      done: 1,
      evaluated: 1,
      items: [
        {
          title: "Rewrite title of the trail shoes page",
          status: "EVALUATED",
          outcome: "Clicks rose after the change.",
        },
      ],
    },
  };
  const updates: SeoReportSection = {
    type: "updates",
    items: [
      {
        name: "September core update",
        kind: "CORE",
        startedAt: "2026-09-24T00:00:00.000Z",
        endedAt: null,
        url: "https://status.search.google.com/summary",
      },
    ],
  };
  const diagnosisSection: SeoReportSection = {
    type: "diagnosis",
    diagnosis: diagnosis(),
  };
  switch (kind) {
    case "PULSE":
      return [
        {
          type: "pulse",
          pulse: {
            day: "2026-10-05",
            metric: "nonBrandClicks",
            value: 120,
            usual: 80,
            changePct: 0.5,
            newCritical: 0,
            openCritical: 0,
            biggest: { dimension: "country", key: "TR", value: 70, usual: 40 },
          },
        },
        healthSection(),
      ];
    case "WEEKLY":
      return [
        kpis,
        diagnosisSection,
        ...tables,
        healthSection(),
        opportunitiesSection(),
        actions,
        updates,
      ];
    case "MONTHLY":
      return [
        kpis,
        diagnosisSection,
        ...tables,
        healthSection(),
        opportunitiesSection(),
        actions,
        updates,
        goalsSection(),
        forecastSection(),
        contentSection(),
      ];
    case "ROADMAP":
      return [
        {
          type: "roadmap",
          actions: [
            {
              title: "Improve the title of the trail shoes page",
              action: "Rewrite title",
              source: "opportunity",
              findingId: "finding_1",
              impactPerMonth: 45,
              effort: "Low",
              severity: null,
              count: null,
            },
            {
              title: "Fix the robots.txt block on /shop",
              action: "Fix first",
              source: "health",
              findingId: null,
              impactPerMonth: null,
              effort: null,
              severity: "CRITICAL",
              count: null,
            },
          ],
          techDebt: [
            {
              title: "Pages without a title",
              action: "Fix titles",
              source: "audit",
              findingId: null,
              impactPerMonth: null,
              effort: null,
              severity: "WARN",
              count: 7,
            },
          ],
        },
        contentSection(),
        goalsSection(),
        forecastSection(),
      ];
  }
}

function periods(
  kind: SeoReportKind,
): Pick<
  SeoReportSnapshot,
  "periodKey" | "period" | "compare" | "yearAgo" | "finalThrough"
> {
  const labeled = (from: string, to: string) => ({
    from,
    to,
    label: periodLabel(from, to),
  });
  switch (kind) {
    case "PULSE":
      return {
        periodKey: "D:2026-10-05",
        period: labeled("2026-10-05", "2026-10-05"),
        compare: null,
        yearAgo: null,
        finalThrough: "2026-10-05",
      };
    case "WEEKLY":
      return {
        periodKey: "W:2026-09-28",
        period: labeled("2026-09-28", "2026-10-04"),
        compare: labeled("2026-09-21", "2026-09-27"),
        yearAgo: labeled("2025-09-29", "2025-10-05"),
        finalThrough: "2026-10-05",
      };
    case "MONTHLY":
      return {
        periodKey: "M:2026-09",
        period: labeled("2026-09-01", "2026-09-30"),
        compare: labeled("2026-08-01", "2026-08-31"),
        yearAgo: labeled("2025-09-01", "2025-09-30"),
        finalThrough: "2026-10-05",
      };
    case "ROADMAP":
      return {
        periodKey: "M:2026-10",
        period: labeled("2026-10-01", "2026-10-31"),
        compare: null,
        yearAgo: null,
        finalThrough: "2026-10-05",
      };
  }
}

export function sampleSnapshot(
  kind: SeoReportKind,
  overrides: Partial<SeoReportSnapshot> = {},
): SeoReportSnapshot {
  const base = periods(kind);
  return {
    v: 1,
    kind,
    title: SEO_REPORT_TITLE[kind],
    ...base,
    site: { label: "example.com", isMock: false },
    brandSplit: true,
    anonymousShare: 0.12,
    sections: sections(kind),
    notes: reportNotes({
      finalThrough: base.finalThrough,
      anonymousShare: 0.12,
      brandSplit: true,
      truncated: false,
      lowData: false,
      isMock: false,
    }),
    ...overrides,
  };
}

export function sampleView(
  kind: SeoReportKind,
  overrides: Partial<SeoReportView> = {},
): SeoReportView {
  const snapshot = overrides.snapshot ?? sampleSnapshot(kind);
  const narrative =
    kind === "WEEKLY" || kind === "MONTHLY"
      ? {
          headline: "Non-brand clicks fell while positions slipped.",
          highlights: ["Trail shoes gained clicks."],
          watchouts: ["Blue running shoes lost ground."],
          nextSteps: ["Rewrite the title of the trail shoes page."],
        }
      : null;
  return {
    id: "report_1",
    projectId: "project_1",
    kind,
    title: snapshot.title,
    periodKey: snapshot.periodKey,
    createdAt: "2026-10-07T07:00:00.000Z",
    language: "en",
    snapshot,
    narrative,
    narrativeNote: null,
    isMock: snapshot.site.isMock,
    searchHref: "/projects/project_1/arama",
    chatHref: "/projects/project_1?work=wkseo_project_1",
    findingStatus: { finding_1: "OPEN", finding_2: "OPEN" },
    ...overrides,
  };
}

// Komut kimliği örneği (testlerde sabit bir bağ kimliğiyle).
export function sampleCommandId(kind: SeoReportKind): string {
  return seoReportCommandId(kind, "link_1", sampleSnapshot(kind).periodKey);
}
