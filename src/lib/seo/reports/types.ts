import type { ReportSummary } from "@/lib/module-flows/analytics/report";
import type { CoverageEstimate } from "@/lib/seo/coverage";
import type { GscTotals } from "@/lib/seo/totals";

// SEO raporlarının tipleri (docs/search-reports.md). Saf ve izomorfik.
// BİRİM KURALI: SeoReportKpi'dan türeyen değerlerdeki ve SeoNarrativeFacts'teki
// *Pct alanları YÜZDE birimindedir; SearchDiagnosis.changePct ve
// SeoReportPulse.changePct ORANDIR (kesir) ve changeTextFromRatio ile yazılır.

export const SEO_REPORT_KINDS = [
  "PULSE",
  "WEEKLY",
  "MONTHLY",
  "ROADMAP",
] as const;
export type SeoReportKind = (typeof SEO_REPORT_KINDS)[number];

export function isSeoReportKind(value: unknown): value is SeoReportKind {
  return SEO_REPORT_KINDS.some((kind) => kind === value);
}

export type SeoSeverity = "INFO" | "WARN" | "CRITICAL";

// PT gün anahtarları, iki uç dahil.
export type SeoRange = { from: string; to: string };
export type SeoLabeledRange = SeoRange & { label: string };

export type SeoKpiKey =
  | "nonBrandClicks"
  | "brandClicks"
  | "clicks"
  | "impressions"
  | "ctr"
  | "position";
export type SeoKpiFormat = "count" | "percent" | "position";

// ctr yüzde biriminde 2 ondalık, konum 1 ondalık, sayımlar tam sayı.
export type SeoReportKpi = {
  key: SeoKpiKey;
  label: string;
  value: number | null;
  previous: number | null;
  yearAgo: number | null;
  format: SeoKpiFormat;
  lowerIsBetter: boolean;
};

export type SeoReportRow = {
  // Sorgu metni ya da sayfa yolu, saklandığı gibi.
  label: string;
  url: string | null;
  isBrand: boolean;
  clicks: number;
  previousClicks: number;
  impressions: number;
  previousImpressions: number;
  position: number | null;
  previousPosition: number | null;
};

export type SeoTableKey =
  | "winning_queries"
  | "losing_queries"
  | "winning_pages"
  | "losing_pages"
  | "rising_queries";
export type SeoReportTable = {
  key: SeoTableKey;
  title: string;
  aggregation: "By property" | "By page";
  // En çok 5 satır.
  rows: SeoReportRow[];
};

export type CwvRatingValue = "good" | "needs-improvement" | "poor";
export type SeoReportHealth = {
  score: number | null;
  cappedByCritical: boolean;
  critical: number;
  warn: number;
  // En çok 5, CRITICAL önce.
  issues: { title: string; severity: SeoSeverity }[];
  // 0..1
  coverage: {
    point: number;
    low: number;
    high: number;
    weekStart: string;
  } | null;
  cwv: { phone: CwvRatingValue | null; desktop: CwvRatingValue | null } | null;
};

export type SeoReportOpportunity = {
  // SeoFinding.id
  id: string;
  title: string;
  action: string;
  impactPerMonth: number | null;
  reachPerMonth: number | null;
  confidence: "Solid" | "Directional";
  effort: string;
  // Anlık görüntü zamanındaki durum.
  status: string;
  priority: number;
};

export type SeoReportActions = {
  accepted: number;
  done: number;
  evaluated: number;
  // En çok 5, değerlendirilenler önce.
  items: { title: string; status: string; outcome: string | null }[];
};

export type SeoReportUpdate = {
  name: string;
  kind: string;
  // ISO
  startedAt: string;
  endedAt: string | null;
  url: string | null;
};

export const SEO_GOAL_METRIC_KEYS = [
  "gsc.nonBrandClicks",
  "gsc.clicks",
  "gsc.top10Queries",
  "seo.indexedShare",
  "seo.cwvGoodShare",
] as const;
export type SeoGoalMetricKey = (typeof SEO_GOAL_METRIC_KEYS)[number];

export type GoalPace =
  "achieved" | "on_track" | "behind" | "at_risk" | "unknown";
export type GoalSeriesPoint = { week: string; value: number };
export type GoalPaceResult = {
  pace: GoalPace;
  projected: number | null;
  low: number | null;
  high: number | null;
  slopePerWeek: number | null;
  reason: string | null;
};
export type SeoReportGoal = {
  goalId: string;
  title: string;
  metricKey: SeoGoalMetricKey;
  target: number | null;
  current: number | null;
  pace: GoalPace;
  paceLabel: string;
  measuredThrough: string | null;
  projected: number | null;
  projectedLow: number | null;
  projectedHigh: number | null;
};

// month: YYYY-MM-01; days: o ayın gün sayısı (yalnız tam aylar).
export type MonthlyPoint = { month: string; value: number; days: number };
export type SearchForecast = {
  metric: "nonBrandClicks" | "clicks";
  // YYYY-MM-01
  month: string;
  value: number;
  low: number;
  high: number;
  method: "seasonal" | "trend";
  historyMonths: number;
  // 0..1
  errorPct: number;
  newContent: { clicks: number; pages: number; share: number | null } | null;
};

export type SeoReportContentItem = {
  title: string;
  // Projenin yerel günü, YYYY-MM-DD.
  date: string;
  status: string;
};

export type SeoReportPulse = {
  day: string;
  metric: "nonBrandClicks" | "clicks";
  value: number;
  usual: number | null;
  // KESİR
  changePct: number | null;
  newCritical: number;
  openCritical: number;
  biggest: {
    dimension: "country" | "device";
    key: string;
    value: number;
    usual: number;
  } | null;
};

export type SeoRoadmapItem = {
  title: string;
  action: string;
  source: "health" | "opportunity" | "quick_win" | "audit";
  // "opportunity" kaynağında SeoFinding.id.
  findingId: string | null;
  impactPerMonth: number | null;
  effort: string | null;
  severity: SeoSeverity | null;
  count: number | null;
};

export type DiagnoseStepKey =
  | "data"
  | "indexing"
  | "technical"
  | "update"
  | "demand"
  | "ranking"
  | "ctr"
  | "cannibalization";
export type DiagnoseVerdict = "yes" | "no" | "unknown";
export type DiagnoseStep = {
  key: DiagnoseStepKey;
  question: string;
  verdict: DiagnoseVerdict;
  // En çok 4 sabit İngilizce cümle.
  evidence: string[];
  // Kanıtın yazdığı her türetilmiş sayı, yazıldığı gibi yuvarlanmış (büyüklük).
  metrics: Record<string, number>;
  // En çok 5; etiket sorgu ya da yol olabilir.
  items: { label: string; detail: string }[];
};
export type DiagnoseAsk = {
  screen: "Manual actions" | "Security issues";
  text: string;
};
export type SearchDiagnosis = {
  v: 1;
  metric: "nonBrandClicks" | "clicks";
  window: { current: SeoRange; previous: SeoRange };
  current: number;
  previous: number;
  // KESİR
  changePct: number | null;
  dropped: boolean;
  primary: DiagnoseStepKey | null;
  also: DiagnoseStepKey[];
  // Her zaman 8, DIAGNOSE_STEP_ORDER sırasıyla.
  steps: DiagnoseStep[];
  askUser: DiagnoseAsk[];
  summary: string;
};

export type DiagnoseRow = {
  id: string;
  label: string;
  current: GscTotals;
  previous: GscTotals;
};
export type DiagnosePage = DiagnoseRow & {
  status: number | null;
  noindex: boolean | null;
  indexed: boolean | null;
};
export type DiagnosePair = {
  queryId: string;
  pageId: string;
  path: string;
  current: GscTotals;
  previous: GscTotals;
};
export type DiagnoseTables = {
  grain: "WEEK" | "MONTH";
  current: SeoRange;
  previous: SeoRange;
  // Pencereyle hizalı değilse true (en son çekilen haftalar kullanıldı).
  fallback: boolean;
};
export type DiagnoseInput = {
  metric: "nonBrandClicks" | "clicks";
  // PT
  today: string;
  // Günlük pencereler (eşit uzunlukta ya da aylık raporlarda takvim ayları).
  window: { current: SeoRange; previous: SeoRange };
  // Sorgu/sayfa tablolarının aralıkları.
  tables: DiagnoseTables | null;
  // Çiftler için kullanılan Pazartesi aralıkları (yalnız haftalık tane).
  pairWeeks: { current: SeoRange; previous: SeoRange } | null;
  // Metriğin toplamları (nonBrandClicks ise markasız).
  totals: { current: GscTotals; previous: GscTotals };
  allTotals: { current: GscTotals; previous: GscTotals };
  // Aynı pencereler −364 gün, aynı metrik.
  yearAgo: { current: GscTotals; previous: GscTotals } | null;
  data: {
    linkHealth: string;
    finalThrough: string | null;
    missingDays: number;
    freshDays: number;
    backfillDone: boolean;
    alertKinds: string[];
  };
  health: {
    available: boolean;
    alerts: { kind: string; severity: SeoSeverity; title: string }[];
    coverage: {
      current: CoverageEstimate | null;
      previous: CoverageEstimate | null;
    } | null;
  };
  // Sıralama güncellemeleri VE SERVING/CRAWLING/INDEXING olayları.
  updatesAvailable: boolean;
  updates: {
    name: string;
    kind: string;
    startedAt: string;
    endedAt: string | null;
  }[];
  queries: DiagnoseRow[];
  pages: DiagnosePage[];
  pairs: DiagnosePair[];
};

export type SeoReportSection =
  | {
      type: "kpis";
      kpis: SeoReportKpi[];
      compareLabel: string;
      yearAgoLabel: string | null;
    }
  | { type: "table"; table: SeoReportTable }
  | { type: "pulse"; pulse: SeoReportPulse }
  | { type: "health"; health: SeoReportHealth }
  | { type: "opportunities"; items: SeoReportOpportunity[] }
  | { type: "actions"; actions: SeoReportActions }
  | { type: "updates"; items: SeoReportUpdate[] }
  | { type: "diagnosis"; diagnosis: SearchDiagnosis }
  | { type: "goals"; goals: SeoReportGoal[] }
  | { type: "forecast"; forecast: SearchForecast }
  | { type: "content"; title: string; items: SeoReportContentItem[] }
  | {
      type: "roadmap";
      actions: SeoRoadmapItem[];
      techDebt: SeoRoadmapItem[];
    };

export type SeoReportSnapshot = {
  v: 1;
  kind: SeoReportKind;
  title: string;
  periodKey: string;
  period: SeoLabeledRange;
  compare: SeoLabeledRange | null;
  yearAgo: SeoLabeledRange | null;
  site: { label: string; isMock: boolean };
  finalThrough: string;
  brandSplit: boolean;
  // 0..1
  anonymousShare: number | null;
  sections: SeoReportSection[];
  notes: string[];
};

export type SeoReportView = {
  id: string;
  projectId: string;
  kind: SeoReportKind;
  title: string;
  periodKey: string;
  // ISO
  createdAt: string;
  language: string;
  snapshot: SeoReportSnapshot;
  narrative: ReportSummary | null;
  narrativeNote: string | null;
  isMock: boolean;
  searchHref: string | null;
  chatHref: string | null;
  // opportunities/roadmap bölümlerindeki kimlikler için CANLI SeoFinding.status;
  // SEO_INSIGHTS=on ve izinli değilse null.
  findingStatus: Record<string, string> | null;
};

export type SeoReportListItem = {
  id: string;
  kind: SeoReportKind;
  title: string;
  periodLabel: string;
  periodKey: string;
  createdAt: string;
  isMock: boolean;
};

export type RankedDeltaLike = {
  id: string;
  label: string;
  url: string | null;
  isBrand: boolean;
  firstSeen: string;
  current: GscTotals;
  previous: GscTotals;
};
