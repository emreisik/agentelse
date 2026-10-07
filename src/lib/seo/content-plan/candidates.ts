import { isFuzzyBrandQuery } from "@/lib/seo/brand-fuzzy";
import { isLocalQuery, ruleIntent } from "@/lib/seo/intent";
import type {
  CrawlFacts,
  RuleSnapshot,
} from "@/lib/seo/opportunity-types";
import { meaningfulTokens } from "@/lib/seo/tokens";
import { foldForMatch } from "@/lib/text-fold";
import { maskGoogleText } from "@/server/integrations/google/pii";

import {
  EXISTING_COVERAGE,
  keywordKey,
  REUSE_JACCARD,
  tokenJaccard,
} from "./doorway";
import { addDaysToDayKey } from "./schedule";
import type {
  ContentPlanInput,
  PlanCandidate,
  PlanCluster,
  PlanConfidence,
  PlanExtras,
  PlanFiltered,
  PlanFindingRef,
  PlanIntent,
  PlanPage,
  PlanPair,
  PlanQuery,
  PlanQueryIntent,
  PlanRejectReason,
} from "./types";

// Plan adaylarının hesabı (SC-F7): W3'ün anlık görüntüsünden, saf bir girdiyle,
// "yeni makale yazılabilecek konular". Eşikler SO5 (içerik boşluğu) ile aynıdır.
// Adaylar saklanmaz; her çağrı taze anlık görüntüden yeniden hesaplanır.
//
// Pillar modeli: W3'ün pillarPageId'si kümenin üyelerinden en çok gösterim alan
// sayfadır ve neredeyse hiç null olmaz; bu yüzden "ana sayfası yok" kararı
// pillarIsWeak'e dayanır (konum, başlık/H1 kapsaması), null'a değil.

export const CANDIDATE_MIN_IMPRESSIONS = 100;
export const LOW_DATA_WEB_IMPRESSIONS = 1000;
export const SUBTOPIC_JACCARD = 0.6;
export const GAP_POSITION = 20;
export const TOP_POSITION = 10;
export const PILLAR_WEAK_POSITION = 20;
export const PILLAR_MIN_COVERAGE = 0.5;
export const GAP_WEIGHT = { NO_PILLAR: 1.3, NO_PAGE: 1.0 } as const;
export const INTENT_WEIGHT: Record<PlanIntent, number> = {
  informational: 1.0,
  commercial: 1.2,
  transactional: 1.2,
};
export const RISING_BONUS = 1.25;
export const CONFIDENCE_FACTOR = {
  SIGNIFICANT: 1,
  DIRECTIONAL: 0.85,
  NONE: 0.8,
} as const;
export const DEPRIORITIZE_FACTOR = 0.5;
export { REUSE_JACCARD };

const SUPPORTING_QUERIES = 3;
const NEW_QUERY_WINDOW_DAYS = 27;

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const QUERY_INTENTS: readonly string[] = [
  "informational",
  "commercial",
  "transactional",
  "navigational",
];

function intentOrNull(value: string | null): PlanQueryIntent | null {
  return value !== null && QUERY_INTENTS.includes(value)
    ? (value as PlanQueryIntent)
    : null;
}

// --- RuleSnapshot -> ContentPlanInput (RuleSnapshot'ı bilen TEK yer) ---

function mergePages(snapshot: RuleSnapshot): PlanPage[] {
  const facts = snapshot.crawl?.pages ?? [];
  const byId = new Map<string, CrawlFacts>();
  const byPath = new Map<string, CrawlFacts>();
  for (const item of facts) {
    if (item.pageId && !byId.has(item.pageId)) byId.set(item.pageId, item);
    if (!byPath.has(item.path)) byPath.set(item.path, item);
  }
  const used = new Set<CrawlFacts>();
  const pages: PlanPage[] = [];
  for (const page of snapshot.pages) {
    const crawl = byId.get(page.pageId) ?? byPath.get(page.path) ?? null;
    if (crawl) used.add(crawl);
    pages.push({
      pageId: page.pageId,
      url: page.url,
      path: page.path,
      title: crawl?.title ?? null,
      h1: crawl && crawl.h1.length > 0 ? crawl.h1.join(" ") : null,
      h2: crawl?.h2 ?? [],
      clicks: page.clicks,
      impressions: page.impressions,
      inlinks: crawl ? crawl.inlinks : null,
      indexable: crawl ? crawl.indexable : null,
      noindex: crawl?.noindex ?? false,
      status: crawl?.status ?? null,
      isHomepage: crawl ? crawl.isHomepage : page.path === "/" || page.path === "",
    });
  }
  // Yalnız taramada görülen sayfalar (Search Console'da gösterimi yok).
  for (const crawl of facts) {
    if (used.has(crawl)) continue;
    pages.push({
      pageId: crawl.pageId,
      url: crawl.url,
      path: crawl.path,
      title: crawl.title,
      h1: crawl.h1.length > 0 ? crawl.h1.join(" ") : null,
      h2: crawl.h2,
      clicks: 0,
      impressions: 0,
      inlinks: crawl.inlinks,
      indexable: crawl.indexable,
      noindex: crawl.noindex,
      status: crawl.status,
      isHomepage: crawl.isHomepage,
    });
  }
  return pages;
}

export function planInputFromSnapshot(
  snapshot: RuleSnapshot,
  extras: PlanExtras,
): ContentPlanInput {
  const previous = new Map(
    snapshot.previousQueries.map((item) => [item.id, item.impressions]),
  );
  const queries: PlanQuery[] = snapshot.queries.map((query) => ({
    queryId: query.queryId,
    text: query.text,
    impressions: query.impressions,
    clicks: query.clicks,
    position:
      query.impressions > 0 ? query.positionWeighted / query.impressions : null,
    intent: intentOrNull(query.intent),
    isBrand: query.isBrand,
    clusterId: query.clusterId,
    firstSeenWeek: query.firstSeenWeek,
    previousImpressions: snapshot.previousComplete
      ? (previous.get(query.queryId) ?? 0)
      : null,
  }));
  const byQuery = new Map(queries.map((query) => [query.queryId, query]));
  const clusters: PlanCluster[] = snapshot.clusters.map((cluster) => {
    let impressions = 0;
    let clicks = 0;
    for (const id of cluster.queryIds) {
      const query = byQuery.get(id);
      if (!query) continue;
      impressions += query.impressions;
      clicks += query.clicks;
    }
    return {
      id: cluster.clusterId,
      name: cluster.name,
      pillarPageId: cluster.pillarPageId,
      queryIds: [...cluster.queryIds],
      impressions,
      clicks,
    };
  });
  const links: { fromPageId: string; toPageId: string }[] = [];
  for (const link of snapshot.crawl?.links ?? []) {
    if (link.fromPageId && link.toPageId) {
      links.push({ fromPageId: link.fromPageId, toPageId: link.toPageId });
    }
  }
  return {
    week: snapshot.week,
    month: extras.month,
    webImpressions28d: snapshot.totals.impressions,
    nonBrandImpressions:
      snapshot.totals.nonBrandImpressions ?? snapshot.totals.impressions,
    brandTerms: [...snapshot.brandTerms],
    queries,
    pairs: snapshot.pairs.map(
      (pair): PlanPair => ({
        queryId: pair.queryId,
        pageId: pair.pageId,
        impressions: pair.impressions,
        clicks: pair.clicks,
        position:
          pair.impressions > 0 ? pair.positionWeighted / pair.impressions : null,
      }),
    ),
    pages: mergePages(snapshot),
    clusters,
    hasCrawl: snapshot.crawl !== null,
    crawlComplete: snapshot.crawl?.complete ?? false,
    links,
    findings: extras.findings,
    existingTitles: extras.existingTitles,
    existingKeywords: extras.existingKeywords,
    poolIdeas: extras.poolIdeas,
    rejectedKeys: extras.rejectedKeys,
    deprioritizedKeys: extras.deprioritizedKeys,
  };
}

// --- Bağlam: girdinin dizinleri (girdi başına bir kez) ---

type Verdict =
  | { ok: true; intent: PlanIntent }
  // reason null: sessizce elenir (sayılmaz)
  | { ok: false; reason: PlanRejectReason | null };

type Context = {
  input: ContentPlanInput;
  queryById: Map<string, PlanQuery>;
  pairsByQuery: Map<string, PlanPair[]>;
  pagesById: Map<string, PlanPage>;
  clusterOf: Map<string, string>;
  clusterMembers: Map<string, string[]>;
  verdicts: Map<string, Verdict>;
};

const CONTEXTS = new WeakMap<ContentPlanInput, Context>();

function bestPairOf(pairs: readonly PlanPair[] | undefined): PlanPair | null {
  let best: PlanPair | null = null;
  for (const pair of pairs ?? []) {
    if (
      best === null ||
      pair.impressions > best.impressions ||
      (pair.impressions === best.impressions && compareText(pair.pageId, best.pageId) < 0)
    ) {
      best = pair;
    }
  }
  return best;
}

function contextOf(input: ContentPlanInput): Context {
  const cached = CONTEXTS.get(input);
  if (cached) return cached;
  const queryById = new Map(input.queries.map((query) => [query.queryId, query]));
  const pairsByQuery = new Map<string, PlanPair[]>();
  for (const pair of input.pairs) {
    const list = pairsByQuery.get(pair.queryId);
    if (list) list.push(pair);
    else pairsByQuery.set(pair.queryId, [pair]);
  }
  const pagesById = new Map<string, PlanPage>();
  for (const page of input.pages) {
    if (page.pageId && !pagesById.has(page.pageId)) pagesById.set(page.pageId, page);
  }
  const clusterIds = new Set(input.clusters.map((cluster) => cluster.id));
  const clusterOf = new Map<string, string>();
  for (const cluster of input.clusters) {
    for (const id of cluster.queryIds) {
      if (!clusterOf.has(id)) clusterOf.set(id, cluster.id);
    }
  }
  for (const query of input.queries) {
    if (!clusterOf.has(query.queryId) && query.clusterId && clusterIds.has(query.clusterId)) {
      clusterOf.set(query.queryId, query.clusterId);
    }
  }
  const clusterMembers = new Map<string, string[]>();
  for (const [queryId, clusterId] of clusterOf) {
    const list = clusterMembers.get(clusterId);
    if (list) list.push(queryId);
    else clusterMembers.set(clusterId, [queryId]);
  }
  const context: Context = {
    input,
    queryById,
    pairsByQuery,
    pagesById,
    clusterOf,
    clusterMembers,
    verdicts: new Map(),
  };
  const dismissedQueries = new Set<string>();
  const dismissedClusters = new Set<string>();
  for (const finding of input.findings) {
    if (finding.status !== "DISMISSED") continue;
    if (finding.queryId) dismissedQueries.add(finding.queryId);
    else if (finding.clusterId) dismissedClusters.add(finding.clusterId);
  }
  const rejected = new Set(input.rejectedKeys);
  for (const query of input.queries) {
    context.verdicts.set(
      query.queryId,
      judgeQuery(query, context, dismissedQueries, dismissedClusters, rejected),
    );
  }
  CONTEXTS.set(input, context);
  return context;
}

// Sorgu uygun mu: marka olmayan, gezinme amaçlı olmayan, yerel olmayan,
// >= 100 gösterimli ve en az bir anlamlı sözcüklü.
function judgeQuery(
  query: PlanQuery,
  context: Context,
  dismissedQueries: ReadonlySet<string>,
  dismissedClusters: ReadonlySet<string>,
  rejected: ReadonlySet<string>,
): Verdict {
  const { brandTerms } = context.input;
  if (query.impressions < CANDIDATE_MIN_IMPRESSIONS) {
    return { ok: false, reason: null };
  }
  if (query.isBrand || isFuzzyBrandQuery(query.text, brandTerms)) {
    return { ok: false, reason: "BRAND_QUERY" };
  }
  const intent =
    query.intent ?? ruleIntent(query.text, { isBrand: false }) ?? "informational";
  if (intent === "navigational") return { ok: false, reason: null };
  if (isLocalQuery(query.text)) return { ok: false, reason: "LOCAL_INTENT" };
  if (meaningfulTokens(query.text, brandTerms).length < 1) {
    return { ok: false, reason: null };
  }
  // Kişisel veri (e-posta, telefon) içeren sorgu hiçbir yerde saklanmaz: plana, fikre ya da takvime girmesin.
  if (maskGoogleText(query.text) !== query.text.replace(/\s+/g, " ").trim()) {
    return { ok: false, reason: null };
  }
  const clusterId = context.clusterOf.get(query.queryId) ?? null;
  if (
    dismissedQueries.has(query.queryId) ||
    (clusterId !== null && dismissedClusters.has(clusterId))
  ) {
    return { ok: false, reason: "DISMISSED_FINDING" };
  }
  if (rejected.has(keywordKey(query.text))) {
    return { ok: false, reason: "REJECTED_BEFORE" };
  }
  return { ok: true, intent };
}

function eligibleQueriesOf(cluster: PlanCluster, context: Context): PlanQuery[] {
  const out: PlanQuery[] = [];
  for (const id of context.clusterMembers.get(cluster.id) ?? []) {
    const query = context.queryById.get(id);
    const verdict = context.verdicts.get(id);
    if (query && verdict?.ok) out.push(query);
  }
  return out.sort(byImpressions);
}

function byImpressions(a: PlanQuery, b: PlanQuery): number {
  return b.impressions - a.impressions || compareText(a.queryId, b.queryId);
}

function foldedTitleText(page: PlanPage): string | null {
  const known = [page.title, page.h1].filter(
    (value): value is string => value !== null && value.trim() !== "",
  );
  return known.length === 0 ? null : foldForMatch(known.join(" "));
}

function coverageIn(tokens: readonly string[], folded: string): number {
  if (tokens.length === 0) return 1;
  const found = tokens.filter((token) => folded.includes(foldForMatch(token)));
  return found.length / tokens.length;
}

// Sayfanın ağırlıklı konumu (gösterimle); konumlu çift yoksa null.
function weightedPosition(pairs: readonly PlanPair[]): number | null {
  let weight = 0;
  let sum = 0;
  const positions: number[] = [];
  for (const pair of pairs) {
    if (pair.position === null) continue;
    positions.push(pair.position);
    weight += pair.impressions;
    sum += pair.position * pair.impressions;
  }
  if (positions.length === 0) return null;
  if (weight > 0) return sum / weight;
  return positions.reduce((a, b) => a + b, 0) / positions.length;
}

// Kümenin ana sayfası zayıf mı: pillarPageId yok; ya da sayfanın kümenin
// sorgu-sayfa çiftlerindeki ağırlıklı konumu > 20 (çift yoksa zayıf); ya da
// (başlık/H1 biliniyorsa) kümenin en çok gösterimli uygun sorgusunun anlamlı
// sözcüklerinin yarısından azı başlık+H1'de var. Bilinmeyen olgu coverage
// testiyle sayfayı zayıf yapmaz.
export function pillarIsWeak(
  cluster: PlanCluster,
  input: ContentPlanInput,
): boolean {
  if (cluster.pillarPageId === null) return true;
  const context = contextOf(input);
  const members = new Set(cluster.queryIds);
  const onPillar = input.pairs.filter(
    (pair) => members.has(pair.queryId) && pair.pageId === cluster.pillarPageId,
  );
  const position = weightedPosition(onPillar);
  if (position === null || position > PILLAR_WEAK_POSITION) return true;
  const page = context.pagesById.get(cluster.pillarPageId);
  const folded = page ? foldedTitleText(page) : null;
  const top = eligibleQueriesOf(cluster, context)[0];
  if (folded !== null && top) {
    const tokens = meaningfulTokens(top.text, input.brandTerms);
    if (coverageIn(tokens, folded) < PILLAR_MIN_COVERAGE) return true;
  }
  return false;
}

function isRising(query: PlanQuery, week: string): boolean {
  if (
    query.previousImpressions !== null &&
    query.previousImpressions > 0 &&
    query.impressions >= 2 * query.previousImpressions
  ) {
    return true;
  }
  return (
    query.firstSeenWeek >= addDaysToDayKey(week, -NEW_QUERY_WINDOW_DAYS) &&
    query.impressions >= CANDIDATE_MIN_IMPRESSIONS
  );
}

const CONFIDENCE_RANK: Record<PlanConfidence, number> = {
  SIGNIFICANT: 0,
  DIRECTIONAL: 1,
};

function findingFor(
  input: ContentPlanInput,
  queryIds: readonly string[],
  clusterId: string | null,
): PlanFindingRef | null {
  const matches = input.findings.filter((finding) => {
    if (finding.status === "DISMISSED") return false;
    if (finding.queryId) return queryIds.includes(finding.queryId);
    return finding.clusterId !== null && finding.clusterId === clusterId;
  });
  matches.sort(
    (a, b) =>
      CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
      compareText(a.ruleKey, b.ruleKey) ||
      compareText(a.id, b.id),
  );
  return matches[0] ?? null;
}

function reuseIdeaFor(input: ContentPlanInput, keyword: string): string | null {
  let best: { id: string; score: number } | null = null;
  for (const idea of input.poolIdeas) {
    const score = tokenJaccard(keyword, idea.keyword);
    if (score < REUSE_JACCARD) continue;
    if (best === null || score > best.score || (score === best.score && compareText(idea.id, best.id) < 0)) {
      best = { id: idea.id, score };
    }
  }
  return best?.id ?? null;
}

type Group = { leader: PlanQuery; leaderTokens: Set<string>; members: PlanQuery[] };

// Sorgular açgözlü (gösterime göre azalan, kararlı) alt konulara ayrılır.
function groupSubtopics(queries: readonly PlanQuery[]): Group[] {
  const groups: Group[] = [];
  for (const query of [...queries].sort(byImpressions)) {
    const tokens = new Set(meaningfulTokens(query.text));
    let target: Group | null = null;
    for (const group of groups) {
      if (jaccard(tokens, group.leaderTokens) >= SUBTOPIC_JACCARD) {
        target = group;
        break;
      }
    }
    if (target) target.members.push(query);
    else groups.push({ leader: query, leaderTokens: tokens, members: [query] });
  }
  return groups;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export type BuildCandidatesResult = {
  candidates: PlanCandidate[];
  filtered: PlanFiltered[];
  lowData: boolean;
  strongPillarClusterIds: string[];
};

export function buildCandidates(input: ContentPlanInput): BuildCandidatesResult {
  if (input.webImpressions28d < LOW_DATA_WEB_IMPRESSIONS) {
    return { candidates: [], filtered: [], lowData: true, strongPillarClusterIds: [] };
  }
  const context = contextOf(input);
  const filtered: PlanFiltered[] = [];
  const deprioritized = new Set(input.deprioritizedKeys);
  const clusterById = new Map(input.clusters.map((cluster) => [cluster.id, cluster]));
  const titleTexts = input.pages
    .map(foldedTitleText)
    .filter((text): text is string => text !== null);

  for (const query of input.queries) {
    const verdict = context.verdicts.get(query.queryId);
    if (verdict && !verdict.ok && verdict.reason !== null) {
      filtered.push({ candidateId: `query:${query.queryId}`, reason: verdict.reason });
    }
  }

  // Yeni makale konusu mu: bir sayfa 20. sıranın içindeyse (ilk 10 dahil) ya da
  // bir sayfanın başlığı/H1'i konuyu zaten karşılıyorsa değil (yenileme SC-F6'nın).
  const newTopic = new Map<string, boolean>();
  const isNewTopic = (query: PlanQuery): boolean => {
    const cached = newTopic.get(query.queryId);
    if (cached !== undefined) return cached;
    const best = bestPairOf(context.pairsByQuery.get(query.queryId));
    let result = true;
    if (best && best.position !== null && best.position <= GAP_POSITION) {
      result = false;
    } else {
      const tokens = meaningfulTokens(query.text, input.brandTerms);
      const covered = titleTexts.some(
        (text) => coverageIn(tokens, text) >= EXISTING_COVERAGE,
      );
      if (covered) result = false;
    }
    newTopic.set(query.queryId, result);
    if (!result) {
      filtered.push({ candidateId: `query:${query.queryId}`, reason: "EXISTING_PAGE" });
    }
    return result;
  };

  const candidates = new Map<string, PlanCandidate>();
  const add = (candidate: PlanCandidate) => {
    if (!candidates.has(candidate.id)) candidates.set(candidate.id, candidate);
  };

  const makeCandidate = (parts: {
    kind: "PILLAR" | "SUPPORT";
    clusterId: string | null;
    clusterName: string | null;
    leader: PlanQuery;
    shown: PlanQuery[];
    impressions: number;
    clicks: number;
    position: number | null;
    intent: PlanIntent;
  }): PlanCandidate => {
    const gap = parts.kind === "PILLAR" ? "NO_PILLAR" : "NO_PAGE";
    const key = keywordKey(parts.leader.text);
    const queryIds = parts.shown.map((query) => query.queryId);
    const finding = findingFor(input, queryIds, parts.clusterId);
    const rising = parts.shown.some((query) => isRising(query, input.week));
    const share = Math.min(
      1,
      parts.impressions / Math.max(1, input.nonBrandImpressions),
    );
    const confidence = finding?.confidence ?? "NONE";
    const score = round6(
      share *
        GAP_WEIGHT[gap] *
        INTENT_WEIGHT[parts.intent] *
        (rising ? RISING_BONUS : 1) *
        CONFIDENCE_FACTOR[confidence] *
        (deprioritized.has(key) ? DEPRIORITIZE_FACTOR : 1),
    );
    return {
      id: `${parts.kind}:${parts.clusterId ?? "q"}:${key}`,
      kind: parts.kind,
      clusterId: parts.clusterId,
      clusterName: parts.clusterName,
      keyword: parts.leader.text,
      queries: parts.shown.slice(1).map((query) => query.text),
      queryIds,
      intent: parts.intent,
      impressions: parts.impressions,
      clicks: parts.clicks,
      share,
      position: parts.position,
      gap,
      rising,
      findingId: finding?.id ?? null,
      findingConfidence: finding?.confidence ?? null,
      score,
      bestPageId:
        bestPairOf(context.pairsByQuery.get(parts.leader.queryId))?.pageId ?? null,
      reuseIdeaId: reuseIdeaFor(input, parts.leader.text),
    };
  };

  const intentOf = (query: PlanQuery): PlanIntent => {
    const verdict = context.verdicts.get(query.queryId);
    return verdict?.ok ? verdict.intent : "informational";
  };

  const supportFrom = (group: Group, cluster: PlanCluster | null): PlanCandidate => {
    const shown = group.members.slice(0, 1 + SUPPORTING_QUERIES);
    let position: number | null = null;
    for (const member of group.members) {
      const best = bestPairOf(context.pairsByQuery.get(member.queryId));
      if (best?.position != null && (position === null || best.position < position)) {
        position = best.position;
      }
    }
    return makeCandidate({
      kind: "SUPPORT",
      clusterId: cluster?.id ?? null,
      clusterName: cluster?.name ?? null,
      leader: group.leader,
      shown,
      impressions: group.members.reduce((sum, member) => sum + member.impressions, 0),
      clicks: group.members.reduce((sum, member) => sum + member.clicks, 0),
      position,
      intent: intentOf(group.leader),
    });
  };

  const strongPillarClusterIds: string[] = [];
  for (const cluster of input.clusters) {
    const weak = pillarIsWeak(cluster, input);
    if (!weak) strongPillarClusterIds.push(cluster.id);
    const eligible = eligibleQueriesOf(cluster, context);
    if (eligible.length === 0) continue;

    const fresh = eligible.filter(isNewTopic);
    for (const group of groupSubtopics(fresh)) add(supportFrom(group, cluster));

    if (weak) {
      const top = eligible[0]!;
      // Üst sorgu zaten yeni konu değilse (sayfa sıralanıyor/karşılanıyor)
      // pillar yazısı kopya olur; atlanır.
      if (isNewTopic(top)) {
        const shown = eligible.slice(0, 1 + SUPPORTING_QUERIES);
        const best = bestPairOf(context.pairsByQuery.get(top.queryId));
        add(
          makeCandidate({
            kind: "PILLAR",
            clusterId: cluster.id,
            clusterName: cluster.name,
            leader: top,
            shown,
            impressions: cluster.impressions,
            clicks: cluster.clicks,
            position: best?.position ?? null,
            intent: intentOf(top),
          }),
        );
      }
    }
  }

  // Kümesiz sorgular kendi başına birer SUPPORT adayıdır (ek çarpan yok).
  for (const query of [...input.queries].sort(byImpressions)) {
    const verdict = context.verdicts.get(query.queryId);
    if (!verdict?.ok) continue;
    const clusterId = context.clusterOf.get(query.queryId) ?? null;
    if (clusterId !== null && clusterById.has(clusterId)) continue;
    if (!isNewTopic(query)) continue;
    add(
      supportFrom(
        { leader: query, leaderTokens: new Set(meaningfulTokens(query.text)), members: [query] },
        null,
      ),
    );
  }

  const sorted = [...candidates.values()].sort(
    (a, b) => b.score - a.score || compareText(a.id, b.id),
  );
  return { candidates: sorted, filtered, lowData: false, strongPillarClusterIds };
}
