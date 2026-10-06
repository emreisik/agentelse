import { reachImpact } from "@/lib/seo/impact";
import type { RuleSnapshot } from "@/lib/seo/opportunity-types";

import { internalLinksCopy } from "./copy";
import {
  crawlFactsFor,
  finishRule,
  isHomepage,
  makeDraft,
  pagePathOf,
  snapshotIndex,
  topQueryOfPage,
  type RankedDraft,
} from "./helpers";
import type { SeoRule } from "./types";

// SO8 iç bağlantı: tam tarama gerekir. ≥ 100 gösterim alan, ana sayfa
// olmayan, dizine girebilen ve ≤ 2 iç bağlantısı olan sayfalara, en çok
// sorgusunun kümesinde sıralanan dizine girebilir sayfalardan (yoksa aynı
// bölümün sayfalarından) tıklamaya göre en çok 3 kaynak önerilir; zaten bağ
// verenler ve sayfanın kendisi hariç. Bağ metni en çok sorgudur (≤ 60).

export const SO8_MIN_IMPRESSIONS = 100;
export const SO8_MAX_INLINKS = 2;
export const SO8_MAX_SOURCES = 3;
export const SO8_ANCHOR_MAX = 60;
export const SO8_MAX = 10;

function linkable(snapshot: RuleSnapshot, pageId: string): boolean {
  const facts = crawlFactsFor(snapshot, pageId);
  return (
    facts !== null &&
    facts.indexable !== false &&
    !facts.noindex &&
    (facts.status ?? 200) < 400
  );
}

function rankByClicks(clicks: Map<string, number>): string[] {
  return [...clicks]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([pageId]) => pageId);
}

export const SO8: SeoRule = {
  key: "SO8_INTERNAL_LINKS",
  version: 1,
  querySignal: false,
  evaluate(snapshot) {
    const crawl = snapshot.crawl;
    if (!crawl || !crawl.complete) {
      return { evaluable: false, reason: "NO_CRAWL" };
    }
    const index = snapshotIndex(snapshot);
    const linkedFrom = new Map<string, Set<string>>();
    for (const link of crawl.links) {
      if (!link.toPageId || !link.fromPageId) continue;
      const set = linkedFrom.get(link.toPageId) ?? new Set<string>();
      set.add(link.fromPageId);
      linkedFrom.set(link.toPageId, set);
    }

    const items: RankedDraft[] = [];
    for (const target of snapshot.pages) {
      if (target.impressions < SO8_MIN_IMPRESSIONS) continue;
      const facts = crawlFactsFor(snapshot, target.pageId);
      if (!facts || facts.inlinks > SO8_MAX_INLINKS) continue;
      if (isHomepage(snapshot, target.pageId) || facts.indexable === false) {
        continue;
      }
      const excluded = linkedFrom.get(target.pageId) ?? new Set<string>();
      const eligible = (pageId: string) =>
        pageId !== target.pageId &&
        !excluded.has(pageId) &&
        linkable(snapshot, pageId);

      const top = topQueryOfPage(snapshot, target.pageId);
      const clusterId = top?.clusterId ?? null;
      const cluster = clusterId ? index.clusters.get(clusterId) : undefined;
      let sources: string[] = [];
      if (cluster) {
        const clicks = new Map<string, number>();
        for (const queryId of cluster.queryIds) {
          for (const pair of index.pairsByQuery.get(queryId) ?? []) {
            if (!eligible(pair.pageId)) continue;
            clicks.set(
              pair.pageId,
              (clicks.get(pair.pageId) ?? 0) + pair.clicks,
            );
          }
        }
        sources = rankByClicks(clicks);
      }
      if (sources.length === 0 && target.pageGroup) {
        const clicks = new Map<string, number>();
        for (const candidate of snapshot.pages) {
          if (candidate.pageGroup !== target.pageGroup) continue;
          if (!eligible(candidate.pageId)) continue;
          clicks.set(candidate.pageId, candidate.clicks);
        }
        sources = rankByClicks(clicks);
      }
      sources = sources.slice(0, SO8_MAX_SOURCES);
      if (sources.length < 1) continue;

      const anchor = Array.from(top?.text ?? facts.title ?? "")
        .slice(0, SO8_ANCHOR_MAX)
        .join("")
        .trim();
      const metrics = {
        impressions: Math.round(target.impressions),
        inlinks: facts.inlinks,
        sources: sources.length,
      };
      items.push({
        rank: target.impressions,
        draft: makeDraft(snapshot, {
          ruleKey: "SO8_INTERNAL_LINKS",
          kind: "OPPORTUNITY",
          subject: `page:${target.pageId}`,
          severity: "INFO",
          confidence: "DIRECTIONAL",
          effort: "S",
          actionKind: "INTERNAL_LINKS",
          impact: reachImpact(target.impressions),
          ...internalLinksCopy({ path: target.path, ...metrics }),
          evidence: {
            window: snapshot.current,
            metrics,
            links: sources.map((from) => ({
              fromPath: pagePathOf(snapshot, from),
              toPath: target.path,
              anchor,
            })),
          },
          pageId: target.pageId,
          keyword: top?.text ?? null,
        }),
      });
    }
    return finishRule(items, SO8_MAX);
  },
};
