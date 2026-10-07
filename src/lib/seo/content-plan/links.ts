import { meaningfulTokens } from "@/lib/seo/tokens";
import { foldForMatch } from "@/lib/text-fold";

import type {
  PlanLink,
  PlanPage,
  PlanPair,
  PlanSlotKind,
} from "./types";

// İç bağlantı planı (SC-F7): yeni makaleye hangi mevcut sayfalardan bağlantı
// verilmeli (linkFrom) ve makale hangi sayfalara bağlanmalı (linkTo). Kaynaklar
// tarayıcının sayfa olgularıdır; tarama yoksa yalnız Search Console sayfaları
// kullanılır ve sonuç doğrulanmamış (verified=false) sayılır. Saf.

export const LINK_FROM_MAX = 4;
export const LINK_TO_MAX = 3;
export const ANCHOR_MAX = 60;
export const LINK_MIN_SCORE = 0.15;
const AUTHORITY_INLINKS = 30;

function clip(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  if (chars.length <= max) return chars.join("");
  const cut = chars.slice(0, max).join("");
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
}

// Daha önce kullanılmamış (taken: katlanmış metinler) bir çapa metni seçer:
// önce anahtar kelimenin kendisi (hedef başına tek birebir eşleşme), sonra
// alternatifler, anahtar kelimenin sözcük alt kümeleri ve sayfa başlığı.
// Hepsi alınmışsa anahtar kelime yine döner (çağıran tekrarı kabul eder).
export function anchorFor(
  keyword: string,
  pageTitle: string | null,
  taken: ReadonlySet<string>,
  alternatives: readonly string[] = [],
): string {
  const words = keyword.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const subsets: string[] = [];
  if (words.length >= 3) {
    subsets.push(words.slice(1).join(" "), words.slice(0, -1).join(" "));
  }
  const options = [keyword, ...alternatives, ...subsets, pageTitle ?? ""]
    .map((text) => clip(text, ANCHOR_MAX))
    .filter((text) => text !== "");
  for (const option of options) {
    if (!taken.has(foldForMatch(option))) return option;
  }
  return options[0] ?? "";
}

function labelOf(page: PlanPage): string {
  const title = page.title?.trim();
  if (title) return title;
  const last = page.path.split("?")[0]!.split("/").filter(Boolean).pop() ?? "";
  return last.replace(/[-_]+/g, " ").trim() || page.path;
}

type Scored = { page: PlanPage; score: number };

function eligibleSources(pages: readonly PlanPage[]): PlanPage[] {
  const usable = pages.filter(
    (page) =>
      page.url.trim() !== "" &&
      page.indexable !== false &&
      !page.noindex &&
      (page.status === null || page.status === 200),
  );
  const inner = usable.filter((page) => !page.isHomepage);
  return inner.length > 0 ? inner : usable;
}

export function planInternalLinks(input: {
  keyword: string;
  queries: readonly string[];
  kind: PlanSlotKind;
  clusterId: string | null;
  // YALNIZ güçlü bir ana sayfa için geçilir; aksi hâlde null.
  pillarPageId: string | null;
  clusterQueryIds: readonly string[];
  pages: readonly PlanPage[];
  pairs: readonly PlanPair[];
  hasCrawl: boolean;
  crawlComplete: boolean;
}): { linkFrom: PlanLink[]; linkTo: PlanLink[]; verified: boolean } {
  const verified = input.hasCrawl && input.crawlComplete;
  const sources = eligibleSources(input.pages);
  const targetTokens = [
    ...new Set([
      ...meaningfulTokens(input.keyword),
      ...input.queries.flatMap((query) => meaningfulTokens(query)),
    ]),
  ];
  const members = new Set(input.clusterQueryIds);
  const clusterImpressions = new Map<string, number>();
  let clusterTotal = 0;
  for (const pair of input.pairs) {
    if (!members.has(pair.queryId)) continue;
    clusterTotal += pair.impressions;
    clusterImpressions.set(
      pair.pageId,
      (clusterImpressions.get(pair.pageId) ?? 0) + pair.impressions,
    );
  }
  const maxImpressions = sources.reduce((max, page) => Math.max(max, page.impressions), 0);

  const scoreOf = (page: PlanPage): number => {
    const text = foldForMatch(
      [page.title, page.h1, ...page.path.split(/[/?#]/).map((part) => part.replace(/[-_]+/g, " "))]
        .filter(Boolean)
        .join(" "),
    );
    const relevance =
      targetTokens.length === 0
        ? 0
        : targetTokens.filter((token) => text.includes(foldForMatch(token))).length /
          targetTokens.length;
    const presence =
      page.pageId && clusterTotal > 0
        ? (clusterImpressions.get(page.pageId) ?? 0) / clusterTotal
        : 0;
    const authority =
      page.inlinks !== null
        ? Math.min(1, Math.log1p(page.inlinks) / Math.log1p(AUTHORITY_INLINKS))
        : maxImpressions > 0
          ? page.impressions / maxImpressions
          : 0;
    return Math.round((0.5 * relevance + 0.3 * presence + 0.2 * authority) * 1_000_000) / 1_000_000;
  };

  const ranked: Scored[] = sources
    .map((page) => ({ page, score: scoreOf(page) }))
    .filter((item) => item.score >= LINK_MIN_SCORE)
    .sort((a, b) => b.score - a.score || (a.page.url < b.page.url ? -1 : a.page.url > b.page.url ? 1 : 0));

  const pillar =
    input.kind === "SUPPORT" && input.pillarPageId !== null
      ? (sources.find((page) => page.pageId === input.pillarPageId) ?? null)
      : null;
  const related = ranked.filter((item) => item.page !== pillar);

  const fromPages: { page: PlanPage; role: PlanLink["role"] }[] = [];
  if (pillar) fromPages.push({ page: pillar, role: "pillar" });
  for (const item of related) {
    if (fromPages.length >= LINK_FROM_MAX) break;
    fromPages.push({ page: item.page, role: "related" });
  }

  // linkFrom çapaları yeni makaleyi tarif eder: biri birebir anahtar kelime,
  // diğerleri ilgili sorgular ve alt kümeler.
  const takenFrom = new Set<string>();
  const linkFrom: PlanLink[] = fromPages.map(({ page, role }) => {
    const anchor = anchorFor(input.keyword, null, takenFrom, input.queries);
    takenFrom.add(foldForMatch(anchor));
    return { url: page.url, path: page.path, anchor, role };
  });

  const toPages: { page: PlanPage; role: PlanLink["role"] }[] = [];
  if (input.kind === "SUPPORT") {
    // Ana sayfa + linkFrom'da olmayan en iyi 2 ilgili sayfa.
    if (pillar) toPages.push({ page: pillar, role: "pillar" });
    const fromSet = new Set(fromPages.map((item) => item.page));
    let related2 = 0;
    for (const item of related) {
      if (related2 >= 2) break;
      if (fromSet.has(item.page)) continue;
      toPages.push({ page: item.page, role: "related" });
      related2 += 1;
    }
  } else {
    for (const item of related) {
      if (toPages.length >= LINK_TO_MAX) break;
      toPages.push({ page: item.page, role: "related" });
    }
  }
  // linkTo çapaları hedef sayfayı tarif eder (başlık ya da yol).
  const takenTo = new Set<string>();
  const linkTo: PlanLink[] = toPages.slice(0, LINK_TO_MAX).map(({ page, role }) => {
    const anchor = anchorFor(labelOf(page), null, takenTo);
    takenTo.add(foldForMatch(anchor));
    return { url: page.url, path: page.path, anchor, role };
  });

  return { linkFrom, linkTo, verified };
}
