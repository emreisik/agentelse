import type { GaAdsCrossCheckInput } from "@/lib/website-analytics/attribution/types";
import type { GaTableRow } from "@/lib/website-analytics/slices";

// GA-F4 analiz motorunun ortak tipleri (docs/google-analytics-plan.md §3.6
// "Analiz motoru", §6.2 "Analiz kuralları", §6.3 "İstatistik kapıları";
// ayrıntı docs/website-insights.md). Yalnız tip ve sabit; saf ve izomorfik.
// Gün anahtarları mülk saatindeki "YYYY-MM-DD"dir, aralıklar iki uç dahildir.

// Bulgu üreten kurallar. AN13 (Meta çapraz kontrol) ve AN14 (Google Ads) GA-F6
// ile geldi; AN16 (tatil ve mevsimsellik) bulgu değil düzeltici
// (registry.ts GA_DEFERRED_RULES).
export const GA_RULE_KEYS = [
  "AN1",
  "AN2",
  "AN3",
  "AN4",
  "AN5",
  "AN6",
  "AN7",
  "AN8",
  "AN9",
  "AN10",
  "AN11",
  "AN12",
  "AN13",
  "AN14",
  "AN15",
] as const;
export type GaRuleKey = (typeof GA_RULE_KEYS)[number];

// Reklam kuralları yalnız GA_UTM açıkken üretilir (operatör sayaçları da buna
// göre süzülür).
export const GA_ADS_RULE_KEYS = ["AN13", "AN14"] as const;

export type GaFindingKind =
  "ANOMALY" | "CHANGE" | "OPPORTUNITY" | "RISK" | "WIN";
export type GaFindingSeverity = "INFO" | "WARN" | "CRITICAL";
export type GaFindingConfidence = "SIGNIFICANT" | "DIRECTIONAL";

export const GA_FINDING_STATUSES = [
  "OPEN",
  "ACCEPTED",
  "DISMISSED",
  "DONE",
  "EVALUATED",
  "EXPIRED",
  "SUPERSEDED",
  "RESOLVED",
] as const;
export type GaFindingStatus = (typeof GA_FINDING_STATUSES)[number];

// Her kapanış closedAt ile birlikte bunlardan birini yazar (lifecycle.ts).
export type GaClosedReason =
  | "ttl"
  | "newer"
  | "shadow"
  | "measurement"
  | "revised"
  | "recovered"
  | "dismissed"
  | "evaluated";
export type GaFindingOutcome = "WORKED" | "DIDNT" | "INCONCLUSIVE";
// Gölge modda üretilen bulgu kullanıcıya hiç gösterilmez.
export type GaFindingMode = "shadow" | "live";
export type GaReviewVerdict = "USEFUL" | "NOT_USEFUL";

export type GaPeriodGrain = "DAY" | "WEEK" | "MONTH" | "WINDOW28";
// Mülk günleri, iki uç dahil.
export type GaRange = { from: string; to: string };
export type GaPeriod = {
  grain: GaPeriodGrain;
  from: string;
  to: string;
  key: string;
};

export type GaImpactMetric =
  | "keyEvents"
  | "sessions"
  | "engagedSessions"
  | "revenue"
  | "views"
  | "purchases";
// Haftalık etki tahmini ve 95% aralığı; directional = aralık sıfırı kesiyor
// ya da tahmin yön gösteriyor.
export type GaImpact = {
  metric: GaImpactMetric;
  perWeek: number;
  low: number;
  high: number;
  directional: boolean;
};

// AN15'in okuduğu ProjectGoal.metricKey değerleri (GA-F5 oluşturacak).
export const WEBSITE_GOAL_KEYS = [
  "web.sessions",
  "web.key_events",
  "web.revenue",
] as const;
export type GaWebsiteGoalKey = (typeof WEBSITE_GOAL_KEYS)[number];

export type GaAnomalyMetric =
  "sessions" | "engagedSessions" | "keyEvents" | "revenue" | "keyEventRate";
export type GaDecompositionMetric = "keyEvents" | "sessions" | "revenue";

// Ayrıştırmanın bir bileşeni: total = volume (oturum değişimi × önceki oran)
// + rate (sonraki oturum × oran değişimi).
export type GaDecompositionComponent = {
  key: string;
  label: string;
  sessionsBefore: number;
  sessionsAfter: number;
  valueBefore: number;
  valueAfter: number;
  rateBefore: number | null;
  rateAfter: number | null;
  volume: number;
  rate: number;
  total: number;
  share: number | null;
};

// Değişmez: Σ components.total + (other?.total ?? 0) + residual === delta.
export type GaDecomposition = {
  metric: GaDecompositionMetric;
  dimension: "channel" | "landingPage";
  before: number;
  after: number;
  delta: number;
  perDay: boolean;
  components: GaDecompositionComponent[];
  other: { count: number; volume: number; rate: number; total: number } | null;
  residual: number;
};

export type GaAnomalyReading = {
  metric: GaAnomalyMetric;
  value: number;
  median: number;
  scale: number;
  z: number;
  direction: "up" | "down";
  baselineDays: string[];
};

// Kanıttaki oranlar KESİRDİR (0..1; key event / oturum 1'i aşabilir, çünkü
// bir oturumda birden çok key event olur). Para mülk para biriminin ana
// birimidir (float, mikro değil).
export type An1Evidence = {
  v: 1;
  rule: "AN1";
  mode: "day" | "week";
  // Gün; hafta modunda haftanın Pazartesi'si.
  target: string;
  readings: GaAnomalyReading[];
  primary: GaAnomalyMetric;
  excludedDays: string[];
  breakdown: GaDecomposition | null;
  seasonalChecked: boolean;
  preliminary: boolean;
};
export type An2Evidence = {
  v: 1;
  rule: "AN2";
  comparison: "wow" | "mom" | "yoy";
  metric: GaDecompositionMetric;
  metricReason: "requested" | "low_key_events";
  current: GaRange & { days: number; total: number };
  previous: GaRange & { days: number; total: number };
  change: number;
  changePct: number | null;
  z: number | null;
  p: number | null;
  channels: GaDecomposition;
  pages: GaDecomposition | null;
  holidays: string[];
  suspectDays: string[];
  seasonal: { lastYearChangePct: number } | null;
  preliminary: boolean;
};
export type An3Evidence = {
  v: 1;
  rule: "AN3";
  variant: "cro" | "promote";
  window: GaRange;
  page: string;
  sessions: number;
  keyEvents: number;
  rate: number;
  restSessions: number;
  restKeyEvents: number;
  restRate: number;
  ratio: number;
  threshold: number;
  p: number | null;
  bhAccepted: boolean;
  excludedDays: string[];
  holidays: string[];
};
export type An4Evidence = {
  v: 1;
  rule: "AN4";
  window: GaRange;
  channel: string;
  measure: "engagement" | "keyEventRate";
  direction: "below" | "above";
  sessions: number;
  hits: number;
  rate: number;
  restSessions: number;
  restHits: number;
  restRate: number;
  ratio: number;
  p: number | null;
  bhAccepted: boolean;
  excludedDays: string[];
  holidays: string[];
};
export type An5Evidence = {
  v: 1;
  rule: "AN5";
  window: GaRange;
  mobile: { sessions: number; keyEvents: number; rate: number };
  desktop: { sessions: number; keyEvents: number; rate: number };
  ratio: number;
  p: number | null;
  excludedDays: string[];
  holidays: string[];
};
// AN6 oturum ölçer (günlük activeUsers kullanıcı-gündür, haftaya toplanamaz).
export type An6Evidence = {
  v: 1;
  rule: "AN6";
  weeks: { monday: string; returning: number; total: number; share: number }[];
  earlyShare: number;
  lateShare: number;
  dropPoints: number;
  p: number | null;
};
export type An7Evidence = {
  v: 1;
  rule: "AN7";
  current: GaRange & { sessions: number; keyEvents: number };
  previous: GaRange & { sessions: number; keyEvents: number };
  assistants: { name: string; sessions: number; previousSessions: number }[];
  changePct: number | null;
  p: number | null;
  firstSeen: boolean;
  siteSessions: number;
  holidays: string[];
};
export type An8Evidence = {
  v: 1;
  rule: "AN8";
  weeks: string[];
  terms: { term: string; searches: number }[];
  totalSearches: number;
  siteSessions: number;
};
export type An9Evidence = {
  v: 1;
  rule: "AN9";
  week: GaRange;
  pages: { path: string; title: string; views: number }[];
  views: number;
};
export type An10Evidence = {
  v: 1;
  rule: "AN10";
  window: GaRange;
  month: string;
  pages: {
    path: string;
    sessions: number;
    engagementRate: number;
    avgEngagementSec: number;
    keyEvents: number;
  }[];
  siteEngagementRate: number;
  siteAvgEngagementSec: number;
  holidays: string[];
};
export type An11Evidence = {
  v: 1;
  rule: "AN11";
  week: GaRange;
  baselineWeeks: string[];
  step: {
    from: string;
    to: string;
    current: { entered: number; completed: number; rate: number };
    baseline: { entered: number; completed: number; rate: number };
    p: number;
    dropPct: number;
  };
  // Sepet değeri değişimi yalnız kayıt; henüz değerlendirilmez (AN11-AOV).
  aov: { current: number | null; baseline: number | null };
};
export type An12Evidence = {
  v: 1;
  rule: "AN12";
  window: GaRange;
  campaign: string;
  source: string;
  medium: string;
  agentelse: boolean;
  direction: "below" | "above";
  sessions: number;
  keyEvents: number;
  rate: number;
  restSessions: number;
  restKeyEvents: number;
  restRate: number;
  ratio: number;
  p: number | null;
  bhAccepted: boolean;
  excludedDays: string[];
  holidays: string[];
};
// AN13: Meta'nın AD düzeyi sayıları ile GA4'ün aynı reklamlar için gördüğü
// oturum/key event karşılaştırması. Oranlar kesirdir (0..1); para Meta hesabının
// ana birimidir.
export type An13Evidence = {
  v: 1;
  rule: "AN13";
  window: GaRange;
  campaignExternalId: string;
  // Agentelse'in kendi kampanya adı, en çok 80 karakter.
  label: string;
  metaCurrency: string | null;
  meta: {
    ads: number;
    spend: number | null;
    linkClicks: number;
    landingPageViews: number;
    results: number | null;
    resultActionType: string | null;
    activeDays: number;
  };
  ga: {
    sessions: number;
    engagedSessions: number;
    keyEvents: number;
    revenue: number;
  };
  checks: ("clicks" | "results")[];
  clickLoss: number | null;
  // Oturum/tıklama oranının Wilson üst sınırı.
  clickRateHigh: number | null;
  resultsGap: number | null;
  resultsP: number | null;
  costPerResult: number | null;
  costPerKeyEvent: number | null;
  excludedDays: string[];
  holidays: string[];
};
// AN14: Google Ads kampanyasının key event başına maliyeti iki 28 günlük
// pencerede; kampanya adı maskelenmiştir (en çok 80 karakter), para mülk
// para biriminde.
export type An14Evidence = {
  v: 1;
  rule: "AN14";
  window: GaRange;
  previousWindow: GaRange;
  campaign: string;
  direction: "worse" | "better";
  current: An14Side;
  previous: An14Side;
  changePct: number;
  p: number;
  bhAccepted: boolean;
  excludedDays: string[];
  holidays: string[];
};
export type An14Side = {
  cost: number;
  clicks: number;
  sessions: number;
  keyEvents: number;
  revenue: number;
  costPerKeyEvent: number;
  roas: number | null;
};
export type An15Evidence = {
  v: 1;
  rule: "AN15";
  goalId: string;
  goalTitle: string;
  metricKey: GaWebsiteGoalKey;
  month: string;
  target: number;
  monthToDate: number;
  forecast: number;
  paceRatio: number;
  dayOfMonth: number;
  daysInMonth: number;
  through: string;
};
export type GaFindingEvidence =
  | An1Evidence
  | An2Evidence
  | An3Evidence
  | An4Evidence
  | An5Evidence
  | An6Evidence
  | An7Evidence
  | An8Evidence
  | An9Evidence
  | An10Evidence
  | An11Evidence
  | An12Evidence
  | An13Evidence
  | An14Evidence
  | An15Evidence;

// Bir kuralın bir dönem için önerdiği bulgu; persist.ts bunu GaFinding
// satırına çevirir (ya da bastırır).
export type GaFindingCandidate = {
  ruleKey: GaRuleKey;
  kind: GaFindingKind;
  subject: string;
  period: GaPeriod;
  severity: GaFindingSeverity;
  confidence: GaFindingConfidence;
  evidence: GaFindingEvidence;
  impact: GaImpact | null;
  impactShare: number;
};

// AN1'in günlük sonucu: "revised" süpürmesi yalnız not_anomalous günleri
// kapatır; skipped (şüpheli, tatil, eksik) ölçüm kuralına ya da TTL'ye kalır.
export type GaAn1DayOutcome = {
  day: string;
  outcome: "anomalous" | "not_anomalous" | "skipped";
};
export type GaDailyRulesResult = {
  candidates: GaFindingCandidate[];
  an1Days: GaAn1DayOutcome[];
  an15Evaluated: { goalId: string; month: string }[];
};

// Değerlendirme kanıtı (plan §6.3): önce/sonra pencereleri ve sitenin geri
// kalanı kontrol olarak.
export type GaOutcomeEvidence = {
  v: 1;
  before: GaRange & { sessions: number; hits: number; rate: number | null };
  after: GaRange & { sessions: number; hits: number; rate: number | null };
  siteBefore: { rate: number | null } | null;
  siteAfter: { rate: number | null } | null;
  p: number | null;
  upliftPct: number | null;
  siteUpliftPct: number | null;
  reason:
    "worked" | "no_change" | "worse" | "too_little_data" | "tracking_issue";
};

// GaDailyTotal'ın analiz için okunan hâli; revenue ana birimdedir.
export type GaAnalysisDay = {
  day: string;
  sessions: number;
  engagedSessions: number;
  keyEvents: number;
  revenue: number;
  transactions: number;
  isFinal: boolean;
};

export type GaWindowReport =
  | "channel"
  | "landing"
  | "sourceMedium"
  | "campaign"
  | "device"
  | "country"
  | "pages"
  | "events"
  | "newReturning";

export type GaWindowTotals = {
  sessions: number;
  engagedSessions: number;
  keyEvents: number;
  revenue: number;
  transactions: number;
  engagementSec: number;
  screenPageViews: number;
};

// Bir aralığın ambar tabloları (window.ts üretir). Hariç tutulan günler
// (şüpheli) toplamlara ve dilimlere girmez.
export type GaWindowTables = {
  from: string;
  to: string;
  // Aralığın uzunluğu (iki uç dahil).
  days: number;
  // GaDailyTotal satırı olan ve hariç tutulmayan günler.
  usedDays: number;
  excludedDays: string[];
  missingDays: number;
  totals: GaWindowTotals;
  // [sessionDefaultChannelGroup] × [sessions, engagedSessions, keyEvents, totalRevenue]
  channel: GaTableRow[];
  // [landingPage] × [sessions, engagedSessions, keyEvents, totalRevenue, userEngagementDuration]
  landing: GaTableRow[];
  // Kırpılan satırların toplamı, landing ile aynı metrik sırası.
  landingOther: number[] | null;
  // [sessionSource, sessionMedium] × [sessions, engagedSessions, keyEvents]
  sourceMedium: GaTableRow[];
  // [sessionCampaignName, sessionSource, sessionMedium] × [sessions, engagedSessions, keyEvents, totalRevenue]
  campaign: GaTableRow[];
  // [deviceCategory] × [sessions, engagedSessions, keyEvents]
  device: GaTableRow[];
  // [country] × [sessions]
  country: GaTableRow[];
  // [pagePath, pageTitle] × [screenPageViews, userEngagementDuration]
  pages: GaTableRow[];
  // [eventName, isKeyEvent] × [eventCount, keyEvents]
  events: GaTableRow[];
  // [newVsReturning] × [activeUsers, sessions, keyEvents]
  newReturning: GaTableRow[];
  quality: { thresholded: boolean; otherRow: boolean; truncated: boolean };
  // İstenen her rapor için kapsanan temiz gün sayısı (DAY dilimi = 1, WEEK
  // dilimi = 7; hariç güne değen WEEK dilimleri atılır).
  coverage: Partial<Record<GaWindowReport, number>>;
};

export type GaGoalInput = {
  id: string;
  title: string;
  metricKey: GaWebsiteGoalKey;
  target: number;
};

export type GaDailyAnalysisInput = {
  linkId: string;
  today: string;
  // [completeThrough-2 .. completeThrough], artan.
  targets: string[];
  country: string | null;
  // Artan, [completeThrough-400, completeThrough]; eksik günler yoktur.
  days: GaAnalysisDay[];
  suspect: ReadonlySet<string>;
  holidays: ReadonlySet<string>;
  // [completeThrough-58, completeThrough] içinde dilimi olan her gün;
  // satırlar [sessionDefaultChannelGroup] × [sessions, keyEvents, totalRevenue].
  channelDays: { day: string; rows: GaTableRow[] }[];
  goals: GaGoalInput[];
  // GA-F3 özetinde kritik sorun var (critical > 0).
  measurementDegraded: boolean;
};

export type GaWeeklyAnalysisInput = {
  linkId: string;
  today: string;
  week: { monday: string; sunday: string };
  country: string | null;
  // Artan, [sunday-400, sunday].
  days: GaAnalysisDay[];
  suspect: ReadonlySet<string>;
  holidays: ReadonlySet<string>;
  // Ham (hariç tutma yok); raporlar: channel, landing, pages, events (+totals).
  current: GaWindowTables;
  previous: GaWindowTables;
  lastYear: GaWindowTables | null;
  // [sunday-27, sunday] ve önceki 28 gün; şüpheli günler hariç; raporlar:
  // channel, landing, sourceMedium, campaign, device (+totals).
  window28: GaWindowTables;
  window28Previous: GaWindowTables;
  // Hafta ile biten 8 ISO hafta, eskiden yeniye; şüpheli günler hariç;
  // raporlar: events, newReturning (+totals).
  weeks: GaWindowTables[];
  // Ham; raporlar: channel, landing (+totals).
  month: {
    month: string;
    current: GaWindowTables;
    previous: GaWindowTables;
  } | null;
  // monday ≤ week.monday olan en yeni ≤4 WEEK dilimi; satırlar
  // [searchTerm] × [eventCount]. GA_WEEKLY kapalıyken null.
  siteSearch: { monday: string; rows: GaTableRow[] }[] | null;
  currency: string | null;
  measurementDegraded: boolean;
  // GA-F6: AN13/AN14 girdisi. GA_UTM kapalıyken (ya da veri yokken) anahtar
  // hiç yoktur.
  ads?: GaAdsCrossCheckInput | null;
};
