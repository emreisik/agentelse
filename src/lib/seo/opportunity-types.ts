import type { CtrCurve } from "./ctr-curve";

// SEO fırsat motorunun ortak tipleri ve sabitleri (docs/google-search-console-plan.md
// SC-F4). Kurallar (SO1–SO16), motor, çıktılar ve arayüz aynı sözleşmeyi
// paylaşır. Saf ve izomorfik.

export const SEO_RULE_KEYS = [
  "SO1_STRIKING_DISTANCE",
  "SO2_CTR_GAP",
  "SO3_CONTENT_DECAY",
  "SO4_CANNIBALIZATION",
  "SO5_CONTENT_GAP",
  "SO6_RISING_QUERY",
  "SO7_LOST",
  "SO8_INTERNAL_LINKS",
  "SO9_PAGE_GROUP_TREND",
  "SO10_BRAND_DEMAND",
  "SO11_LOCAL_INTENT",
  "SO12_RICH_RESULTS",
  "SO13_INTERNATIONAL",
  "SO14_MEDIA_SEARCH",
  "SO15_NEW_CONTENT",
  "SO16_TECH_IMPACT",
] as const;
export type SeoRuleKey = (typeof SEO_RULE_KEYS)[number];

const RULE_KEY_SET: ReadonlySet<string> = new Set(SEO_RULE_KEYS);

export function isSeoRuleKey(value: unknown): value is SeoRuleKey {
  return typeof value === "string" && RULE_KEY_SET.has(value);
}

export type SeoFindingKind = "OPPORTUNITY" | "RISK" | "CHANGE" | "WIN";
export type SeoSeverity = "INFO" | "WARN" | "CRITICAL";
export type SeoConfidence = "SIGNIFICANT" | "DIRECTIONAL";
export type SeoEffort = "S" | "M" | "L" | "VARIES";
export type SeoActionKind =
  | "TITLE_META"
  | "CONTENT_REFRESH"
  | "NEW_CONTENT"
  | "INTERNAL_LINKS"
  | "CONSOLIDATE"
  | "TECH_FIX"
  | "SCHEMA"
  | "LOCALIZE"
  | "INVESTIGATE";

// EVALUATED/outcome SC-F6'ya ayrılmıştır.
export const SEO_FINDING_STATUSES = [
  "OPEN",
  "ACCEPTED",
  "DISMISSED",
  "DONE",
  "EVALUATED",
  "EXPIRED",
  "SUPERSEDED",
  "RESOLVED",
] as const;
export type SeoFindingStatus = (typeof SEO_FINDING_STATUSES)[number];

export const SEO_DISMISS_REASONS = [
  "not_relevant",
  "already_done",
  "wrong_data",
  "not_now",
] as const;
export type SeoDismissReason = (typeof SEO_DISMISS_REASONS)[number];

export type SeoShadowVerdict = "USEFUL" | "NOT_USEFUL";

export const SEARCH_OPPORTUNITY_SIGNAL_SOURCE = "search-console-opportunities";

// Etki: aylık tıklama (aralıklı) ya da yalnız erişim (aylık gösterim).
export type SeoImpact =
  | { kind: "clicks"; perMonth: number; low: number; high: number }
  | { kind: "reach"; impressionsPerMonth: number };

export type DecayCause =
  "INDEX" | "CANNIBALIZATION" | "RANKING" | "DEMAND" | "CTR" | "MIXED";

export type SeoEvidenceQuery = {
  queryId: string;
  text: string;
  clicks: number;
  impressions: number;
  position: number | null;
  expectedCtr?: number | null;
  share?: number | null;
};

export type SeoEvidencePage = {
  pageId: string | null;
  path: string;
  url: string | null;
  clicks: number;
  impressions: number;
  position: number | null;
  share?: number | null;
};

// Kanıt. metrics kuralı: adı "Ctr" ya da "Share" ile biten anahtarlar 0..1
// arası kesirdir (yüzde değil); açıklama sayı denetimi bunlara yüzde
// biçimlerini de ekler. Diğer anahtarlar ham sayıdır (tıklama, gösterim,
// konum, gün). queries ve pages en çok 10, links en çok 3 öğe; notes sabit
// İngilizce cümlelerdir ve rakam içermez.
export type SeoEvidence = {
  window: { from: string; to: string };
  compare?: { from: string; to: string } | null;
  metrics: Record<string, number>;
  queries?: SeoEvidenceQuery[];
  pages?: SeoEvidencePage[];
  links?: { fromPath: string; toPath: string; anchor: string }[];
  cause?: DecayCause | null;
  issueCodes?: string[];
  country?: string | null;
  notes?: string[];
};

export type SeoFindingDraft = {
  ruleKey: SeoRuleKey;
  ruleVersion: number;
  kind: SeoFindingKind;
  subject: string;
  periodStart: string;
  periodEnd: string;
  periodKey: string;
  severity: SeoSeverity;
  confidence: SeoConfidence;
  effort: SeoEffort;
  actionKind: SeoActionKind;
  impact: SeoImpact | null;
  priority: number;
  title: string;
  summary: string;
  evidence: SeoEvidence;
  pageId: string | null;
  queryId: string | null;
  clusterId: string | null;
  keyword: string | null;
  ideaWorthy: boolean;
  signalWorthy: boolean;
};

// Konum pozisyon × gösterim olarak taşınır (ortalama = pw / gösterim).
export type SeoMetric = {
  clicks: number;
  impressions: number;
  positionWeighted: number;
};

export type QueryStat = SeoMetric & {
  queryId: string;
  text: string;
  isBrand: boolean;
  intent: string | null;
  language: string | null;
  clusterId: string | null;
  firstSeenWeek: string;
};

export type PageStat = SeoMetric & {
  pageId: string;
  url: string;
  path: string;
  pageGroup: string | null;
  firstSeenWeek: string;
};

export type PairStat = SeoMetric & { queryId: string; pageId: string };
export type WeeklyPairStat = PairStat & { weekStart: string };
export type IdMetric = SeoMetric & { id: string };

export type CrawlFacts = {
  pageId: string | null;
  url: string;
  path: string;
  status: number | null;
  noindex: boolean;
  indexable: boolean | null;
  isHomepage: boolean;
  title: string | null;
  h1: string[];
  h2: string[];
  lang: string | null;
  hreflang: string[];
  schemaTypes: string[];
  inlinks: number;
  imagesNoAlt: number;
  issues: { code: string; severity: SeoSeverity }[];
  depth: number | null;
};

// Bağlantılardaki pageId'ler GscPage kimlikleridir (eşleşmeyen null).
export type CrawlSnapshot = {
  complete: boolean;
  pages: CrawlFacts[];
  links: {
    fromPageId: string | null;
    fromPath: string;
    toPageId: string | null;
    toPath: string;
  }[];
};

export type ClusterInfo = {
  clusterId: string;
  name: string;
  queryIds: string[];
  pillarPageId: string | null;
};

// Kuralların gördüğü tek anlık görüntü. Çapa: W1'in bitirdiği hafta
// (GscSiteLink.lastWeeklyWeek, Pazartesi). previousComplete false iken
// previousQueries/previousPages/previousPairs boştur.
export type RuleSnapshot = {
  linkId: string;
  projectId: string;
  propertyType: string | null;
  // Pazartesi = GscSiteLink.lastWeeklyWeek.
  week: string;
  // { addWeeks(week,-3), addDays(week,6) } Pazartesi..Pazar.
  current: { from: string; to: string };
  // { addWeeks(week,-7), addDays(week,-22) }.
  previous: { from: string; to: string };
  // Önceki 4 haftanın hepsinde query+page+query_page WEEK çekimi var.
  previousComplete: boolean;
  // 8 hafta (önceki+şimdiki) içinde query_page çekimi olan Pazartesiler;
  // weeklyPairs yalnız bunları kapsar.
  pairWeeks: string[];
  // `week`te biten kesintisiz WEEK 'query' çekimleri.
  historyWeeks: number;
  historyMonths: number;
  backfillDone: boolean;
  brandSplitReady: boolean;
  brandTerms: string[];
  projectLanguage: string | null;
  projectCountry: string | null;
  // Web, `current`ın kesinleşmiş günleri.
  totals: {
    clicks: number;
    impressions: number;
    nonBrandClicks: number | null;
    nonBrandImpressions: number | null;
  };
  // QueryStat.impressions = Q (GscWeeklyQuery'den; çiftlerin toplamı değil).
  queries: QueryStat[];
  previousQueries: IdMetric[];
  pages: PageStat[];
  previousPages: IdMetric[];
  yearAgoPages: IdMetric[] | null;
  pairs: PairStat[];
  previousPairs: PairStat[];
  weeklyPairs: WeeklyPairStat[];
  monthlyPages: (SeoMetric & { pageId: string; month: string })[] | null;
  months: string[];
  brandWeeks: {
    weekStart: string;
    brandImpressions: number | null;
    impressions: number;
  }[];
  searchTypes: { image: number; video: number };
  countries: { country: string; clicks: number; impressions: number }[];
  inspections:
    | { pageId: string; verdict: string | null; coverageState: string | null }[]
    | null;
  crawl: CrawlSnapshot | null;
  clusters: ClusterInfo[];
  curves: { nonBrand: CtrCurve; brand: CtrCurve };
};
