import {
  allowedNumbersOf,
  isSupportedToken,
  numberTokens,
} from "@/lib/module-flows/analytics/number-check";
import { priorCurve, type CtrCurve } from "@/lib/seo/ctr-curve";
import type {
  CrawlFacts,
  IdMetric,
  PageStat,
  PairStat,
  QueryStat,
  RuleSnapshot,
  SeoFindingDraft,
  SeoMetric,
  SeoRuleKey,
  WeeklyPairStat,
} from "@/lib/seo/opportunity-types";
import { TA_CATALOG, type TaCode } from "@/lib/seo/technical-audit";

import { displayKeyword, displayPath, SUMMARY_MAX, TITLE_MAX } from "./copy";
import {
  clusterTopQuery,
  pagePathOf,
  pathGroupOf,
  topQueryOfPage,
} from "./helpers";

// Kural testleri için anlık görüntü fikstürü ve kurucular (P3/P4 testleri de
// kullanır). Hafta 2026-09-21 (Pazartesi); şimdiki pencere 2026-08-31..
// 2026-09-27, önceki 2026-08-03..2026-08-30; 8 haftanın hepsinde çift verisi
// var. Konum ortalama olarak verilir, positionWeighted ondan hesaplanır.

export const FIXTURE_WEEK = "2026-09-21";
export const FIXTURE_PAIR_WEEKS = [
  "2026-08-03",
  "2026-08-10",
  "2026-08-17",
  "2026-08-24",
  "2026-08-31",
  "2026-09-07",
  "2026-09-14",
  "2026-09-21",
];

export type MetricInput = {
  clicks?: number;
  impressions?: number;
  position?: number;
};

export function metric(input: MetricInput = {}): SeoMetric {
  const impressions = input.impressions ?? 0;
  return {
    clicks: input.clicks ?? 0,
    impressions,
    positionWeighted: (input.position ?? 0) * impressions,
  };
}

export function query(
  queryId: string,
  text: string,
  input: MetricInput &
    Partial<
      Pick<
        QueryStat,
        "isBrand" | "intent" | "language" | "clusterId" | "firstSeenWeek"
      >
    > = {},
): QueryStat {
  return {
    ...metric(input),
    queryId,
    text,
    isBrand: input.isBrand ?? false,
    intent: input.intent ?? null,
    language: input.language ?? null,
    clusterId: input.clusterId ?? null,
    firstSeenWeek: input.firstSeenWeek ?? "2025-01-06",
  };
}

export function page(
  pageId: string,
  path: string,
  input: MetricInput &
    Partial<Pick<PageStat, "pageGroup" | "firstSeenWeek">> = {},
): PageStat {
  return {
    ...metric(input),
    pageId,
    url: `https://example.com${path}`,
    path,
    pageGroup: input.pageGroup ?? pathGroupOf(path),
    firstSeenWeek: input.firstSeenWeek ?? "2025-01-06",
  };
}

export function pair(
  queryId: string,
  pageId: string,
  input: MetricInput = {},
): PairStat {
  return { ...metric(input), queryId, pageId };
}

export function weeklyPair(
  weekStart: string,
  queryId: string,
  pageId: string,
  input: MetricInput = {},
): WeeklyPairStat {
  return { ...pair(queryId, pageId, input), weekStart };
}

export function idMetric(id: string, input: MetricInput = {}): IdMetric {
  return { ...metric(input), id };
}

export function crawlPage(
  pageId: string | null,
  path: string,
  facts: Partial<CrawlFacts> = {},
): CrawlFacts {
  return {
    pageId,
    url: `https://example.com${path}`,
    path,
    status: 200,
    noindex: false,
    indexable: true,
    isHomepage: path === "/",
    title: null,
    h1: [],
    h2: [],
    lang: null,
    hreflang: [],
    schemaTypes: [],
    inlinks: 10,
    imagesNoAlt: 0,
    issues: [],
    depth: 1,
    ...facts,
  };
}

// Kaynağı "site" olan (önsel noktalı) eğri: SIGNIFICANT dallarını sınamak için.
export function siteCurve(kind: "non-brand" | "brand" = "non-brand"): CtrCurve {
  return {
    ...priorCurve(kind),
    source: "site",
    fittedAt: "2026-09-28",
    impressions: 50_000,
  };
}

export function snapshotFixture(
  overrides: Partial<RuleSnapshot> = {},
): RuleSnapshot {
  return {
    linkId: "link-1",
    projectId: "project-1",
    propertyType: "DOMAIN",
    week: FIXTURE_WEEK,
    current: { from: "2026-08-31", to: "2026-09-27" },
    previous: { from: "2026-08-03", to: "2026-08-30" },
    previousComplete: true,
    pairWeeks: [...FIXTURE_PAIR_WEEKS],
    historyWeeks: 30,
    historyMonths: 16,
    backfillDone: true,
    brandSplitReady: true,
    brandTerms: ["acme"],
    projectLanguage: "en",
    projectCountry: null,
    totals: {
      clicks: 2_000,
      impressions: 50_000,
      nonBrandClicks: 1_500,
      nonBrandImpressions: 45_000,
    },
    queries: [],
    previousQueries: [],
    pages: [],
    previousPages: [],
    yearAgoPages: null,
    pairs: [],
    previousPairs: [],
    weeklyPairs: [],
    monthlyPages: null,
    months: [],
    brandWeeks: [],
    searchTypes: { image: 0, video: 0 },
    countries: [],
    inspections: null,
    crawl: null,
    clusters: [],
    curves: { nonBrand: priorCurve("non-brand"), brand: priorCurve("brand") },
    ...overrides,
  };
}

// --- Kural başına tetikleyen örnek anlık görüntüler ---

const MONTHS_6 = [
  "2026-03-01",
  "2026-04-01",
  "2026-05-01",
  "2026-06-01",
  "2026-07-01",
  "2026-08-01",
];

const eightWeeks = (values: readonly (number | null)[]) =>
  FIXTURE_PAIR_WEEKS.map((weekStart, i) => ({
    weekStart,
    brandImpressions: values[i] ?? null,
    impressions: 5_000,
  }));

// Her kural için onu en az bir kez tetikleyen anlık görüntü (kopya ve
// anahtar kelime değişmezleri bunlarla sınanır).
export const RULE_SCENARIOS: Readonly<Record<SeoRuleKey, () => RuleSnapshot>> =
  {
    SO1_STRIKING_DISTANCE: () =>
      snapshotFixture({
        queries: [
          query("q1", "best running shoes", {
            impressions: 1000,
            clicks: 5,
            position: 8,
          }),
        ],
        pages: [
          page("p1", "/running-shoes-guide", {
            impressions: 1000,
            clicks: 5,
            position: 8,
          }),
        ],
        pairs: [
          pair("q1", "p1", { impressions: 1000, clicks: 5, position: 8 }),
        ],
      }),
    SO2_CTR_GAP: () =>
      snapshotFixture({
        queries: [
          query("q2", "project software pricing", {
            impressions: 600,
            clicks: 10,
            position: 3,
          }),
        ],
        pages: [
          page("p2", "/pricing-plans", {
            impressions: 600,
            clicks: 10,
            position: 3,
          }),
        ],
        pairs: [
          pair("q2", "p2", { impressions: 600, clicks: 10, position: 3 }),
        ],
      }),
    SO3_CONTENT_DECAY: () =>
      snapshotFixture({
        queries: [
          query("q3", "garden hose reviews", {
            impressions: 400,
            clicks: 20,
            position: 8,
          }),
        ],
        pages: [
          page("p3", "/old-article", {
            impressions: 400,
            clicks: 20,
            position: 8,
          }),
        ],
        pairs: [
          pair("q3", "p3", { impressions: 400, clicks: 20, position: 8 }),
        ],
        months: MONTHS_6,
        monthlyPages: MONTHS_6.map((month, i) => ({
          pageId: "p3",
          month,
          ...metric(
            i < 3
              ? { clicks: 100, impressions: 2000, position: 5 }
              : { clicks: 60, impressions: 2000, position: 8 },
          ),
        })),
      }),
    SO4_CANNIBALIZATION: () =>
      snapshotFixture({
        queries: [
          query("q4", "kitchen remodel ideas", {
            impressions: 1000,
            clicks: 10,
            position: 5,
          }),
        ],
        pages: [
          page("p4a", "/kitchen-remodel", {
            impressions: 500,
            clicks: 5,
            position: 5,
          }),
          page("p4b", "/remodel-ideas", {
            impressions: 300,
            clicks: 5,
            position: 5,
          }),
        ],
        pairs: [
          pair("q4", "p4a", { impressions: 500, clicks: 5, position: 5 }),
          pair("q4", "p4b", { impressions: 300, clicks: 5, position: 5 }),
        ],
      }),
    SO5_CONTENT_GAP: () =>
      snapshotFixture({
        queries: [
          query("q5", "blue widget repair", {
            impressions: 300,
            clicks: 0,
            position: 30,
          }),
        ],
      }),
    SO6_RISING_QUERY: () =>
      snapshotFixture({
        queries: [
          query("q6", "new gadget launch", {
            impressions: 120,
            clicks: 2,
            position: 14,
            firstSeenWeek: "2026-09-07",
          }),
        ],
      }),
    SO7_LOST: () =>
      snapshotFixture({
        queries: [
          query("q7", "legacy widget manual", {
            impressions: 50,
            clicks: 0,
            position: 30,
          }),
        ],
        pages: [
          page("p7", "/discontinued", {
            impressions: 50,
            clicks: 0,
            position: 30,
          }),
        ],
        previousPages: [
          idMetric("p7", { clicks: 40, impressions: 800, position: 4 }),
        ],
        previousQueries: [
          idMetric("q7", { clicks: 40, impressions: 800, position: 4 }),
        ],
        previousPairs: [
          pair("q7", "p7", { clicks: 40, impressions: 800, position: 4 }),
        ],
      }),
    SO8_INTERNAL_LINKS: () =>
      snapshotFixture({
        queries: [
          query("q8", "roof repair cost", {
            impressions: 300,
            clicks: 6,
            position: 9,
          }),
        ],
        pages: [
          page("p8", "/services/roof-repair", {
            impressions: 300,
            clicks: 6,
            position: 9,
          }),
          page("p9", "/services/gutter-cleaning", {
            impressions: 900,
            clicks: 50,
            position: 3,
          }),
        ],
        pairs: [pair("q8", "p8", { impressions: 300, clicks: 6, position: 9 })],
        crawl: {
          complete: true,
          pages: [
            crawlPage("p8", "/services/roof-repair", { inlinks: 1 }),
            crawlPage("p9", "/services/gutter-cleaning"),
          ],
          links: [],
        },
      }),
    SO9_PAGE_GROUP_TREND: () => {
      const ids = ["b1", "b2", "b3", "b4", "b5"];
      return snapshotFixture({
        pages: ids.map((id) =>
          page(id, `/blog/${id}-post`, {
            impressions: 400,
            clicks: 20,
            position: 6,
          }),
        ),
        previousPages: ids.map((id) =>
          idMetric(id, { impressions: 500, clicks: 40, position: 5 }),
        ),
      });
    },
    SO10_BRAND_DEMAND: () =>
      snapshotFixture({
        brandWeeks: eightWeeks([200, 200, 200, 200, 100, 100, 100, 100]),
      }),
    SO11_LOCAL_INTENT: () =>
      snapshotFixture({
        queries: [
          query("q11", "dentist izmir", {
            impressions: 80,
            clicks: 1,
            position: 15,
          }),
        ],
        pages: [
          page("p11", "/dental-implants", {
            impressions: 80,
            clicks: 1,
            position: 15,
          }),
        ],
        pairs: [
          pair("q11", "p11", { impressions: 80, clicks: 1, position: 15 }),
        ],
      }),
    SO12_RICH_RESULTS: () =>
      snapshotFixture({
        pages: [
          page("h", "/", { impressions: 2000, clicks: 100, position: 2 }),
        ],
        crawl: { complete: true, pages: [crawlPage("h", "/")], links: [] },
      }),
    SO13_INTERNATIONAL: () =>
      snapshotFixture({
        countries: [{ country: "deu", clicks: 12, impressions: 900 }],
      }),
    SO14_MEDIA_SEARCH: () =>
      snapshotFixture({
        searchTypes: { image: 0, video: 300 },
        crawl: { complete: true, pages: [crawlPage("h", "/")], links: [] },
      }),
    SO15_NEW_CONTENT: () =>
      snapshotFixture({
        pages: [
          page("n1", "/new-one", {
            impressions: 100,
            firstSeenWeek: "2026-07-06",
          }),
          page("n2", "/new-two", {
            impressions: 100,
            firstSeenWeek: "2026-07-13",
          }),
          page("n3", "/new-three", {
            impressions: 100,
            firstSeenWeek: "2026-07-20",
          }),
          page("n4", "/new-four", {
            impressions: 10,
            firstSeenWeek: "2026-07-27",
          }),
        ],
      }),
    SO16_TECH_IMPACT: () =>
      snapshotFixture({
        pages: [
          page("t1", "/about-us", { impressions: 80, clicks: 3, position: 6 }),
          page("t2", "/contact", { impressions: 70, clicks: 2, position: 7 }),
        ],
        crawl: {
          complete: true,
          pages: [
            crawlPage("t1", "/about-us", {
              issues: [{ code: "TA6", severity: "WARN" }],
            }),
            crawlPage("t2", "/contact", {
              issues: [{ code: "TA6", severity: "WARN" }],
            }),
          ],
          links: [],
        },
      }),
  };

// --- Değişmez denetimi ---

// Konunun birincil yolu: sayfa kimliğinin yolu ya da bölüm konularının bölümü.
function primaryPathOf(snapshot: RuleSnapshot, draft: SeoFindingDraft) {
  if (draft.pageId) return pagePathOf(snapshot, draft.pageId);
  const group = /^group(?:-schema)?:([^:]+)/.exec(draft.subject);
  if (group) return group[1]!;
  if (draft.subject.startsWith("page:")) {
    return pagePathOf(snapshot, draft.subject.slice("page:".length));
  }
  return "";
}

export function expectedKeyword(
  snapshot: RuleSnapshot,
  draft: Pick<SeoFindingDraft, "ruleKey" | "subject">,
): string | null {
  const [kind, ...rest] = draft.subject.split(":");
  const id = rest.join(":");
  if (kind === "query") {
    return snapshot.queries.find((q) => q.queryId === id)?.text ?? null;
  }
  if (kind === "cluster") return clusterTopQuery(snapshot, id)?.text ?? null;
  if (kind === "page") {
    const which = draft.ruleKey === "SO7_LOST" ? "previous" : "current";
    return topQueryOfPage(snapshot, id, which)?.text ?? null;
  }
  return null;
}

// Bir taslağın kopya, anahtar kelime ve sayı değişmezlerini denetler; ihlal
// listesini döndürür (boş = geçerli).
export function draftInvariantErrors(
  snapshot: RuleSnapshot,
  draft: SeoFindingDraft,
): string[] {
  const errors: string[] = [];
  const where = `${draft.ruleKey} ${draft.subject}`;
  if (draft.keyword !== expectedKeyword(snapshot, draft)) {
    errors.push(`${where}: keyword ${String(draft.keyword)}`);
  }
  if (Array.from(draft.title).length > TITLE_MAX)
    errors.push(`${where}: title too long`);
  if (Array.from(draft.summary).length > SUMMARY_MAX) {
    errors.push(`${where}: summary too long`);
  }
  const allowedNumbers = allowedNumbersOf(draft.evidence.metrics);
  const primary = primaryPathOf(snapshot, draft);
  const fixed: string[] = [];
  if (draft.keyword) fixed.push(displayKeyword(draft.keyword), draft.keyword);
  if (primary) fixed.push(displayPath(primary), primary);
  if (draft.ruleKey === "SO16_TECH_IMPACT") {
    const code = draft.subject.slice("ta:".length);
    if (code in TA_CATALOG) fixed.push(TA_CATALOG[code as TaCode].title);
  }
  for (const [label, text] of [
    ["title", draft.title],
    ["summary", draft.summary],
  ] as const) {
    if (/https?:|www\./i.test(text))
      errors.push(`${where}: ${label} has a URL`);
    let rest = text;
    for (const value of fixed
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)) {
      rest = rest.split(value).join(" ");
    }
    for (const token of numberTokens(rest)) {
      if (!isSupportedToken(token, allowedNumbers)) {
        errors.push(`${where}: ${label} number ${token} not in metrics`);
      }
    }
    for (const q of snapshot.queries) {
      if (q.text !== draft.keyword && rest.includes(q.text)) {
        errors.push(`${where}: ${label} names another query`);
      }
    }
    for (const p of snapshot.pages) {
      if (p.path.length > 1 && p.path !== primary && rest.includes(p.path)) {
        errors.push(`${where}: ${label} names another path`);
      }
    }
  }
  for (const note of draft.evidence.notes ?? []) {
    if (/\d/.test(note)) errors.push(`${where}: note has a digit`);
  }
  return errors;
}
