import type { ReportSummary } from "@/lib/module-flows/analytics/report";
import type {
  GaAnalysisDay,
  GaWebsiteGoalKey,
} from "@/lib/website-analytics/analysis/types";
import type { GaFindingView } from "@/lib/website-analytics/analysis/view-types";
import type { MeasurementSummary } from "@/lib/website-analytics/health/view-types";
import type { GaStoredSlice } from "@/lib/website-analytics/slices";
import type { GaPeriodTotals } from "@/lib/website-analytics/totals";

// GA-F5 rapor kartı ve oluşturucu girdi tipleri (docs/website-reports.md).
// Saf ve izomorfik: yalnız tip ve sabit içerir.
// DEĞİŞMEZ: bir kart gösterdiği her sayıyı kendi içinde taşır ve gönderildikten
// sonra asla değişmez; arayüz yalnız kartı okur, ambara dönmez.

// Command.parsedIntent.card'ın türü.
export const WEBSITE_REPORT_CARD_KIND = "website-report";

// Kart çeşitleri: nabız, haftalık, aylık, gelecek ay planı, kritik uyarı.
export const WEBSITE_REPORT_VARIANTS = [
  "pulse",
  "weekly",
  "monthly",
  "plan",
  "alert",
] as const;
export type WebsiteReportVariant = (typeof WEBSITE_REPORT_VARIANTS)[number];

// Değer biçimi: percent değerleri yüzde birimidir (0–100), duration saniye,
// money kartın para biriminin ana birimi.
export type ReportValueFormat = "count" | "percent" | "duration" | "money";

// Dönem raporlarındaki KPI satırlarının anahtarları.
export const REPORT_KPI_KEYS = [
  "users",
  "sessions",
  "newUsers",
  "engagementRate",
  "engagementTime",
  "keyEvents",
  "keyEventRate",
  "revenue",
] as const;
export type ReportKpiKey = (typeof REPORT_KPI_KEYS)[number];

// Bir KPI: değer, önceki dönem ve geçen yıl karşılaştırması (değişim yüzdesi
// 1 ondalığa yuvarlanır).
export type ReportKpi = {
  key: ReportKpiKey;
  label: string;
  format: ReportValueFormat;
  value: number | null;
  previous: number | null;
  changePct: number | null;
  lastYear: number | null;
  lastYearChangePct: number | null;
};

// Genel tablo; sunucudaki WebsiteTable'a yapısal olarak atanabilir.
export type ReportTable = {
  columns: { label: string; format: ReportValueFormat }[];
  rows: { label: string; values: (number | null)[] }[];
  other: (number | null)[] | null;
  notes: string[];
};

// GA-F6 "From Agentelse" bölümü: Agentelse'in yayınladığı bağlantılardan gelen
// ziyaretler, reklamların sitedeki karşılığı ve Google Ads. Yalnızca haftalık
// raporda, GA_UTM açıkken bulunur; ROAS sütunu yoktur (ReportValueFormat'ta oran yok).
export type ReportAgentelseSection = {
  tracked: ReportTable | null;
  ads: ReportTable | null;
  googleAds: ReportTable | null;
  notes: string[];
};

// Açılış sayfası hareketi (kazanan ya da kaybeden).
export type ReportMover = {
  page: string;
  sessions: number;
  previousSessions: number;
  change: number;
  changePct: number | null;
  keyEvents: number;
  previousKeyEvents: number;
};

// GA-F4 bulgusunun karta gömülen anlık görüntüsü.
export type ReportFindingSnap = {
  id: string;
  ruleKey: string;
  list: "changed" | "opportunities";
  kind: string;
  title: string;
  detail: string;
  impact: string | null;
  confidence: "Significant" | "Directional";
  period: string;
  explanation: string | null;
  status: string;
  outcome: string | null;
  preliminary: boolean;
  href: string;
};

// GA-F3 ölçüm sağlığı özeti.
export type ReportMeasurement = {
  score: number | null;
  label: string;
  tone: "ok" | "warning" | "error" | "unknown";
  issues: number;
  critical: number;
  href: string;
};

// Hedef temposu.
export type GoalPace =
  | "achieved"
  | "on_track"
  | "at_risk"
  | "behind"
  | "early"
  | "unknown";

// Tahminin dayanağı.
export type ForecastBasis = "ok" | "short_history" | "no_baseline" | "complete";

// Tahmin edilen metrikler.
export type ForecastMetric = "sessions" | "keyEvents" | "revenue";

// Ay sonu tahmini görünümü (okuyucu üretir, karta anlık görüntü olarak girer).
export type MonthForecastView = {
  metric: ForecastMetric;
  month: string;
  through: string;
  dayOfMonth: number;
  daysInMonth: number;
  monthToDate: number;
  forecast: number | null;
  low: number | null;
  high: number | null;
  basis: ForecastBasis;
};

// Hedef ilerlemesi; tempo, hedefin ŞİMDİKİ değeriyle okuma anında hesaplanır.
export type GoalProgressView = {
  goalId: string;
  title: string;
  status: string;
  metricKey: GaWebsiteGoalKey;
  target: number | null;
  month: string;
  through: string;
  dayOfMonth: number;
  daysInMonth: number;
  monthToDate: number;
  expectedToDate: number | null;
  forecast: number | null;
  forecastLow: number | null;
  forecastHigh: number | null;
  forecastBasis: ForecastBasis;
  pace: GoalPace;
  paceRatio: number | null;
  updatedAt: string;
};

// Kartta gösterilen hedef anlık görüntüsü.
export type ReportGoalSnap = {
  goalId: string;
  title: string;
  metricKey: GaWebsiteGoalKey;
  format: "count" | "money";
  target: number | null;
  monthToDate: number;
  forecast: number | null;
  low: number | null;
  high: number | null;
  pace: GoalPace;
  paceLabel: string;
  month: string;
  final: boolean;
};

// Kartta gösterilen ay sonu tahmini anlık görüntüsü.
export type ReportForecastSnap = {
  metric: ForecastMetric;
  label: string;
  format: "count" | "money";
  month: string;
  monthToDate: number;
  forecast: number | null;
  low: number | null;
  high: number | null;
  basis: ForecastBasis;
  note: string | null;
};

// Nabız KPI'ı: değer ve olağan değer (aynı hafta günü, son 8 hafta).
export type PulseKpi = {
  key: "sessions" | "keyEvents" | "engagementRate" | "revenue";
  label: string;
  format: ReportValueFormat;
  value: number;
  usual: number | null;
  changePct: number | null;
  unusual: boolean;
};

// Nabızda öne çıkan kanal değişimi.
export type PulseChange = {
  channel: string;
  sessions: number;
  usual: number;
  change: number;
};

// Nabzın neden gönderildiği.
export type PulseReason = "alert" | "unusual" | "anomaly";

// Nabızda listelenen açık GA4 uyarısı.
export type PulseAlert = {
  title: string;
  severity: "WARN" | "CRITICAL";
  href: string;
  isNew: boolean;
};

// Nabız kartının gövdesi.
export type PulseBody = {
  variant: "pulse";
  day: string;
  kpis: PulseKpi[];
  changes: PulseChange[];
  alerts: PulseAlert[];
  anomalies: ReportFindingSnap[];
  holiday: boolean;
  suspect: boolean;
  reasons: PulseReason[];
};

// Haftalık ve aylık raporların ortak bölümleri.
export type PeriodReportSections = {
  kpis: ReportKpi[];
  channels: ReportTable;
  winners: ReportMover[];
  losers: ReportMover[];
  keyEvents: ReportTable;
  aiAssistants: ReportTable | null;
  siteSearch: ReportTable | null;
  measurement: ReportMeasurement | null;
  insights: "on" | "pending" | "off";
  whatChanged: ReportFindingSnap[];
  opportunities: ReportFindingSnap[];
  goals: ReportGoalSnap[];
  nextSteps: string[];
  nextStepsSource: "ai" | "findings" | "none";
  notes: string[];
};

// Haftalık rapor gövdesi.
export type WeeklyBody = PeriodReportSections & {
  variant: "weekly";
  from: string;
  to: string;
  previous: { from: string; to: string };
  lastYear: { from: string; to: string } | null;
  forecasts: ReportForecastSnap[];
  // GA-F6: bölüm boşsa alan hiç yazılmaz, böylece bayrak kapalıyken kart değişmez.
  agentelse?: ReportAgentelseSection;
};

// Aylık rapor gövdesi (siteSearch aylıkta daima null).
export type MonthlyBody = PeriodReportSections & {
  variant: "monthly";
  month: string;
  from: string;
  to: string;
  previous: { from: string; to: string };
  lastYear: { from: string; to: string } | null;
  topPages: ReportTable;
  paidTraffic: ReportTable | null;
  outcomes: {
    worked: number;
    didnt: number;
    inconclusive: number;
    items: ReportFindingSnap[];
  } | null;
};

// Gelecek ay planında önerilen bir hedef.
export type PlanTargetProposal = {
  metricKey: GaWebsiteGoalKey;
  label: string;
  format: "count" | "money";
  baseline: number;
  baselineMonths: number;
  seasonalPct: number | null;
  realistic: number;
  low: number;
  high: number;
  suggested: number;
  currentGoal: { goalId: string; target: number | null } | null;
};

// Plan kartı gövdesi (month = hedef ay).
export type PlanBody = {
  variant: "plan";
  month: string;
  proposals: PlanTargetProposal[];
  proposalNote: string | null;
  topFindings: ReportFindingSnap[];
  bestPages: {
    page: string;
    sessions: number;
    keyEvents: number;
    keyEventRate: number;
  }[];
  channelQuality: ReportTable | null;
  forecasts: ReportForecastSnap[];
};

// Kritik ölçüm uyarısı kartı gövdesi.
export type AlertBody = {
  variant: "alert";
  alertId: string;
  kind: string;
  severity: "CRITICAL";
  title: string;
  href: string;
  reconnect: boolean;
  openedAt: string;
};

export type WebsiteReportBody =
  | PulseBody
  | WeeklyBody
  | MonthlyBody
  | PlanBody
  | AlertBody;

// Command.parsedIntent.card: gönderilmiş, değişmez rapor kartı.
// Değişmez: body.variant === variant.
export type WebsiteReportCardData = {
  kind: "website-report";
  v: 1;
  variant: WebsiteReportVariant;
  title: string;
  projectId: string;
  linkId: string;
  propertyName: string | null;
  periodLabel: string;
  timeZone: string;
  currency: string | null;
  builtAt: string;
  dataThrough: string | null;
  preliminary: boolean;
  isMock: boolean;
  body: WebsiteReportBody;
  narrative: ReportSummary | null;
  narrativeNote: string | null;
};

// Liste üst sınırları; okuyucu ve oluşturucular aynı sayıları kullanır.
export const REPORT_CAPS = {
  channels: 8,
  movers: 5,
  keyEvents: 8,
  aiAssistants: 5,
  siteSearch: 5,
  topPages: 10,
  // Ücretli trafik: en çok 7 kanal satırı + paidTraffic kampanya satırı; okuyucu
  // ikisini birden taşır (kampanya satırları sondadır, kırpılmamalı).
  paidTraffic: 5,
  paidChannels: 7,
  paidTrafficRows: 12,
  whatChanged: 5,
  opportunities: 3,
  outcomes: 5,
  goals: 6,
  nextSteps: 3,
  bestPages: 3,
  alerts: 5,
  pulseChanges: 2,
  anomalies: 2,
  proposals: 3,
  // GA-F6: "From Agentelse" tablosu ve reklam/Google Ads tabloları.
  agentelse: 8,
  agentelseAds: 5,
} as const;

// Bir rapor adımının sonucu.
export type ReportStepResult =
  | "posted"
  | "exists"
  | "quiet"
  | "empty"
  | "closed"
  | "gone"
  | "deferred";

// Anlatı durumu; ok | dropped | budget | error = ReasoningService.run çağrıldı.
export type NarrativeStatus =
  | "ok"
  | "dropped"
  | "mock"
  | "demo"
  | "budget"
  | "error"
  | "skipped"
  | "none";

// Anlatı kipi: allow LLM'i çağırır, defer (veri yüklemeden) ertelenir, skip
// LLM'siz yazar.
export type NarrativeMode = "allow" | "defer" | "skip";

// Yazıcının dönüşü: sonuç ve anlatı durumu (çalıştırıcı LLM çağrısını sayar).
export type ReportWriteResult = {
  result: ReportStepResult;
  narrative: NarrativeStatus | null;
};

// Rapora giren mülk bilgisi; timeZone mülk saat dilimidir.
export type ReportLinkInfo = {
  projectId: string;
  linkId: string;
  propertyName: string | null;
  timeZone: string;
  currency: string | null;
  isMock: boolean;
  dataThrough: string;
  // GA-F8: ek mülkün GA4 kimliği (bağlantılar ?property= taşır); ana mülk için
  // null/yok.
  propertyId?: string | null;
};

// Bir dönem penceresinin ambardan okunmuş verisi.
export type ReportWindowData = {
  from: string;
  to: string;
  days: number;
  coveredDays: number;
  preliminary: boolean;
  totals: GaPeriodTotals;
  channel: GaStoredSlice[];
  landing: GaStoredSlice[];
  events: GaStoredSlice[];
  sourceMedium: GaStoredSlice[];
  campaign: GaStoredSlice[];
  landingMissingDays: number;
};

// GA-F4 bulgularının rapora girdisi.
export type ReportFindingsInput = {
  insights: "on" | "pending" | "off";
  changed: GaFindingView[];
  opportunities: GaFindingView[];
  evaluated: GaFindingView[];
  outcomeCounts: { worked: number; didnt: number; inconclusive: number } | null;
};

// Haftalık ve aylık oluşturucuların ortak girdisi.
export type PeriodReportInput = {
  link: ReportLinkInfo;
  builtAt: string;
  websitePage: boolean;
  current: ReportWindowData;
  previous: ReportWindowData;
  lastYear: { from: string; to: string; totals: GaPeriodTotals } | null;
  users: { current: number | null; previous: number | null };
  siteSearch: GaStoredSlice[] | null;
  measurement: MeasurementSummary | null;
  findings: ReportFindingsInput;
  goals: GoalProgressView[];
  // Haftalık: completeThrough'un ayı; aylık: rapor ayı.
  goalsMonth: string;
};

export type WeeklyReportInput = PeriodReportInput & {
  forecasts: MonthForecastView[];
  agentelse?: ReportAgentelseSection | null;
};

// goals = finalGoalProgress(...) ile rapor ayı için hesaplanır.
export type MonthlyReportInput = PeriodReportInput & { month: string };

// Plan için tamamlanmış bir ayın toplamları.
export type PlanMonthTotals = {
  month: string;
  days: number;
  daysInMonth: number;
  sessions: number;
  keyEvents: number;
  revenue: number;
};

// Plan oluşturucunun girdisi; month = hedef ay, months en eskiden yeniye ≤ 16.
export type PlanReportInput = {
  link: ReportLinkInfo;
  builtAt: string;
  websitePage: boolean;
  month: string;
  months: PlanMonthTotals[];
  goals: {
    id: string;
    metricKey: GaWebsiteGoalKey;
    targetValue: number | null;
  }[];
  // Canlı AÇIK fırsatlar, öncelik azalan, ≤3.
  findings: GaFindingView[];
  window28: ReportWindowData;
  forecasts: MonthForecastView[];
  historyDays: number;
};

// Nabız değerlendirmesinin girdisi.
export type PulseInput = {
  link: ReportLinkInfo;
  builtAt: string;
  websitePage: boolean;
  day: string;
  // Artan, [day-63, day].
  days: GaAnalysisDay[];
  suspect: ReadonlySet<string>;
  holidays: ReadonlySet<string>;
  // `day` ve önceki 8 haftanın aynı hafta günü.
  channelDays: { day: string; slice: GaStoredSlice }[];
  // Açık GA4 WARN/CRITICAL uyarıları, ≤5.
  alerts: {
    id: string;
    kind: string;
    title: string;
    severity: "WARN" | "CRITICAL";
    firstSeenAt: string;
    isNew: boolean;
  }[];
  anomalies: GaFindingView[];
};

// Hedef tempo çipinin görünümü.
export type GoalPaceChipView = {
  goalId: string;
  metricKey: GaWebsiteGoalKey;
  pace: GoalPace;
  label: string;
  tone: "good" | "warn" | "bad" | "neutral";
  month: string;
  monthLabel: string;
  through: string;
  monthToDate: number;
  target: number | null;
  forecast: number | null;
  low: number | null;
  high: number | null;
  basis: ForecastBasis;
  format: "count" | "money";
  currency: string | null;
};

// Website sayfasındaki arşiv öğesi.
export type WebsiteReportArchiveItem = {
  commandId: string;
  variant: "weekly" | "monthly" | "plan";
  title: string;
  periodLabel: string;
  builtAt: string;
  chatHref: string;
  card: WebsiteReportCardData;
};
