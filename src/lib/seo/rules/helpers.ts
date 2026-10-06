import { isFuzzyBrandQuery } from "@/lib/seo/brand-fuzzy";
import { avgPosition, priorityOf } from "@/lib/seo/impact";
import type {
  ClusterInfo,
  CrawlFacts,
  IdMetric,
  PageStat,
  PairStat,
  QueryStat,
  RuleSnapshot,
  SeoEvidencePage,
  SeoEvidenceQuery,
  SeoFindingDraft,
  SeoMetric,
} from "@/lib/seo/opportunity-types";

import { weeklyPeriodKey } from "./fingerprint";
import type { RuleResult } from "./types";

// Kuralların ortak yardımcıları: marka ayrımı, yüzdelik, anlık görüntü
// dizinleri (sayfa/sorgu/çift haritaları), taslak kurucu ve "sınırdan önce
// görülenler" ile sınırlama. Saf; dizin anlık görüntü başına bir kez kurulur.

export const RULE_VERSION = 1;

// Marka sorgusu: W1'in isBrand'i ya da bellekteki bulanık eşleşme.
export function isBrandish(
  query: Pick<QueryStat, "text" | "isBrand">,
  brandTerms: readonly string[],
): boolean {
  return query.isBrand || isFuzzyBrandQuery(query.text, brandTerms);
}

// Doğrusal aralamalı yüzdelik (p 0..100); boş dizide 0.
export function percentile(values: readonly number[], p: number): number {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const lower = sorted[low]!;
  const upper = sorted[high]!;
  return lower + (upper - lower) * (rank - low);
}

export function median(values: readonly number[]): number {
  return percentile(values, 50);
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function sumMetrics(items: readonly SeoMetric[]): SeoMetric {
  let clicks = 0;
  let impressions = 0;
  let positionWeighted = 0;
  for (const item of items) {
    clicks += item.clicks;
    impressions += item.impressions;
    positionWeighted += item.positionWeighted;
  }
  return { clicks, impressions, positionWeighted };
}

export function isHomePath(path: string): boolean {
  return path === "/" || path === "";
}

// Yolun ilk bölümü: "/blog/yazi" → "/blog"; kök "/".
export function pathGroupOf(path: string): string {
  const segment = path.split("/").filter(Boolean)[0];
  return segment ? `/${segment}` : "/";
}

export function pathSegments(path: string): number {
  return path.split("?")[0]!.split("/").filter(Boolean).length;
}

type SnapshotIndex = {
  queries: Map<string, QueryStat>;
  pages: Map<string, PageStat>;
  previousQueries: Map<string, IdMetric>;
  previousPages: Map<string, IdMetric>;
  pairsByPage: Map<string, PairStat[]>;
  pairsByQuery: Map<string, PairStat[]>;
  previousPairsByPage: Map<string, PairStat[]>;
  previousPairsByQuery: Map<string, PairStat[]>;
  crawlByPage: Map<string, CrawlFacts>;
  inspectionByPage: Map<string, string | null>;
  clusters: Map<string, ClusterInfo>;
  brandish: Map<string, boolean>;
};

const INDEXES = new WeakMap<RuleSnapshot, SnapshotIndex>();

function groupBy<T>(items: readonly T[], key: (item: T) => string) {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

export function snapshotIndex(snapshot: RuleSnapshot): SnapshotIndex {
  const cached = INDEXES.get(snapshot);
  if (cached) return cached;
  const crawlByPage = new Map<string, CrawlFacts>();
  for (const facts of snapshot.crawl?.pages ?? []) {
    if (facts.pageId && !crawlByPage.has(facts.pageId)) {
      crawlByPage.set(facts.pageId, facts);
    }
  }
  const index: SnapshotIndex = {
    queries: new Map(snapshot.queries.map((q) => [q.queryId, q])),
    pages: new Map(snapshot.pages.map((p) => [p.pageId, p])),
    previousQueries: new Map(snapshot.previousQueries.map((q) => [q.id, q])),
    previousPages: new Map(snapshot.previousPages.map((p) => [p.id, p])),
    pairsByPage: groupBy(snapshot.pairs, (p) => p.pageId),
    pairsByQuery: groupBy(snapshot.pairs, (p) => p.queryId),
    previousPairsByPage: groupBy(snapshot.previousPairs, (p) => p.pageId),
    previousPairsByQuery: groupBy(snapshot.previousPairs, (p) => p.queryId),
    crawlByPage,
    inspectionByPage: new Map(
      (snapshot.inspections ?? []).map((i) => [i.pageId, i.verdict]),
    ),
    clusters: new Map(snapshot.clusters.map((c) => [c.clusterId, c])),
    brandish: new Map(
      snapshot.queries.map((q) => [
        q.queryId,
        isBrandish(q, snapshot.brandTerms),
      ]),
    ),
  };
  INDEXES.set(snapshot, index);
  return index;
}

// Sorgu markasız mı (bilinmeyen sorgu marka sayılmaz ama zaten kullanılmaz).
export function isNonBrandQuery(snapshot: RuleSnapshot, queryId: string) {
  return snapshotIndex(snapshot).brandish.get(queryId) === false;
}

export function nonBrandQueries(snapshot: RuleSnapshot): QueryStat[] {
  const index = snapshotIndex(snapshot);
  return snapshot.queries.filter(
    (q) => index.brandish.get(q.queryId) === false,
  );
}

// Sayfanın yolu: önce GSC sayfası, sonra tarama; bilinmiyorsa "".
export function pagePathOf(snapshot: RuleSnapshot, pageId: string): string {
  const index = snapshotIndex(snapshot);
  return (
    index.pages.get(pageId)?.path ?? index.crawlByPage.get(pageId)?.path ?? ""
  );
}

export function pageUrlOf(snapshot: RuleSnapshot, pageId: string) {
  const index = snapshotIndex(snapshot);
  return (
    index.pages.get(pageId)?.url ?? index.crawlByPage.get(pageId)?.url ?? null
  );
}

// Sayfanın en çok tıklama (eşitlikte gösterim) getiren sorgusu. "previous"
// önceki penceredeki çiftlere bakar; metni bilinmeyen sorgu null döner.
export function topQueryOfPage(
  snapshot: RuleSnapshot,
  pageId: string,
  which: "current" | "previous" = "current",
): QueryStat | null {
  const index = snapshotIndex(snapshot);
  const pairs =
    (which === "current"
      ? index.pairsByPage.get(pageId)
      : index.previousPairsByPage.get(pageId)) ?? [];
  const known = pairs.filter((p) => index.queries.has(p.queryId));
  const best = [...known].sort(
    (a, b) =>
      b.clicks - a.clicks ||
      b.impressions - a.impressions ||
      a.queryId.localeCompare(b.queryId),
  )[0];
  return best ? index.queries.get(best.queryId)! : null;
}

// Kümenin en çok gösterim alan sorgusu (anlık görüntüde metni olanlar).
export function clusterTopQuery(
  snapshot: RuleSnapshot,
  clusterId: string,
): QueryStat | null {
  const index = snapshotIndex(snapshot);
  const cluster = index.clusters.get(clusterId);
  if (!cluster) return null;
  let best: QueryStat | null = null;
  for (const id of cluster.queryIds) {
    const query = index.queries.get(id);
    if (!query) continue;
    if (
      !best ||
      query.impressions > best.impressions ||
      (query.impressions === best.impressions &&
        query.queryId.localeCompare(best.queryId) < 0)
    ) {
      best = query;
    }
  }
  return best;
}

export function crawlFactsFor(
  snapshot: RuleSnapshot,
  pageId: string,
): CrawlFacts | null {
  return snapshotIndex(snapshot).crawlByPage.get(pageId) ?? null;
}

// Sayfa hata veriyor, noindex ya da URL denetimi FAIL dedi.
export function hasIndexProblem(snapshot: RuleSnapshot, pageId: string) {
  const facts = crawlFactsFor(snapshot, pageId);
  if (facts && ((facts.status ?? 0) >= 400 || facts.noindex)) return true;
  return snapshotIndex(snapshot).inspectionByPage.get(pageId) === "FAIL";
}

export function isHomepage(snapshot: RuleSnapshot, pageId: string): boolean {
  const facts = crawlFactsFor(snapshot, pageId);
  if (facts?.isHomepage) return true;
  return isHomePath(pagePathOf(snapshot, pageId));
}

// Bir sorgunun gösterimce en büyük çifti.
export function bestPairOf(
  snapshot: RuleSnapshot,
  queryId: string,
): PairStat | null {
  const pairs = snapshotIndex(snapshot).pairsByQuery.get(queryId) ?? [];
  return (
    [...pairs].sort(
      (a, b) =>
        b.impressions - a.impressions || a.pageId.localeCompare(b.pageId),
    )[0] ?? null
  );
}

export function positionOf(metric: SeoMetric): number | null {
  const value = avgPosition(metric);
  return value === null ? null : round1(value);
}

export function evidenceQuery(
  query: QueryStat,
  metric: SeoMetric,
  extra: { expectedCtr?: number | null; share?: number | null } = {},
): SeoEvidenceQuery {
  return {
    queryId: query.queryId,
    text: query.text,
    clicks: metric.clicks,
    impressions: metric.impressions,
    position: positionOf(metric),
    ...(extra.expectedCtr !== undefined
      ? {
          expectedCtr:
            extra.expectedCtr === null ? null : round3(extra.expectedCtr),
        }
      : {}),
    ...(extra.share !== undefined
      ? { share: extra.share === null ? null : round3(extra.share) }
      : {}),
  };
}

export function evidencePage(
  snapshot: RuleSnapshot,
  pageId: string,
  metric: SeoMetric,
  share?: number | null,
): SeoEvidencePage {
  return {
    pageId,
    path: pagePathOf(snapshot, pageId),
    url: pageUrlOf(snapshot, pageId),
    clicks: metric.clicks,
    impressions: metric.impressions,
    position: positionOf(metric),
    ...(share !== undefined
      ? { share: share === null ? null : round3(share) }
      : {}),
  };
}

export function currentPageMetric(
  snapshot: RuleSnapshot,
  pageId: string,
): SeoMetric {
  return (
    snapshotIndex(snapshot).pages.get(pageId) ?? {
      clicks: 0,
      impressions: 0,
      positionWeighted: 0,
    }
  );
}

export type DraftInput = Pick<
  SeoFindingDraft,
  | "ruleKey"
  | "kind"
  | "subject"
  | "severity"
  | "confidence"
  | "effort"
  | "actionKind"
  | "impact"
  | "title"
  | "summary"
  | "evidence"
> &
  Partial<
    Pick<
      SeoFindingDraft,
      | "pageId"
      | "queryId"
      | "clusterId"
      | "keyword"
      | "ideaWorthy"
      | "signalWorthy"
    >
  > & {
    // Yalnız SO3: ay dönemi; verilmezse haftalık pencere.
    period?: { start: string; end: string; key: string };
  };

// Taslak: dönem anlık görüntünün haftalık penceresi (SO3 hariç), öncelik
// etki × güven ÷ emek.
export function makeDraft(
  snapshot: RuleSnapshot,
  input: DraftInput,
): SeoFindingDraft {
  const { period, ...rest } = input;
  return {
    ruleVersion: RULE_VERSION,
    periodStart: period?.start ?? snapshot.current.from,
    periodEnd: period?.end ?? snapshot.current.to,
    periodKey: period?.key ?? weeklyPeriodKey(snapshot),
    priority: priorityOf(input.impact, input.confidence, input.effort),
    pageId: null,
    queryId: null,
    clusterId: null,
    keyword: null,
    ideaWorthy: false,
    signalWorthy: false,
    ...rest,
  };
}

export type RankedDraft = { draft: SeoFindingDraft; rank: number };

// Sınırlama: sıra rank azalan, eşitlikte konu. seen sınırdan ÖNCEKİ bütün
// konulardır.
export function finishRule(
  items: readonly RankedDraft[],
  max: number,
): RuleResult {
  const sorted = [...items].sort(
    (a, b) => b.rank - a.rank || a.draft.subject.localeCompare(b.draft.subject),
  );
  const seen = [...new Set(sorted.map((item) => item.draft.subject))];
  return {
    evaluable: true,
    drafts: sorted.slice(0, max).map((item) => item.draft),
    seen,
  };
}
