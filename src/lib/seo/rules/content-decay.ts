import { addMonths, monthEnd } from "@/lib/seo/dates";
import { clicksImpact } from "@/lib/seo/impact";
import type {
  PairStat,
  RuleSnapshot,
  SeoActionKind,
  SeoEffort,
  DecayCause,
  SeoMetric,
} from "@/lib/seo/opportunity-types";

import { contentDecayCopy } from "./copy";
import { decayCause } from "./decay-cause";
import { monthlyPeriodKey } from "./fingerprint";
import {
  evidencePage,
  finishRule,
  hasIndexProblem,
  makeDraft,
  pagePathOf,
  snapshotIndex,
  sumMetrics,
  topQueryOfPage,
  type RankedDraft,
} from "./helpers";
import type { SeoRule } from "./types";

// SO3 içerik erimesi (aylık): son 3 tam ayın tıklaması (R) önceki 3 aya (P)
// göre ≥ %30 ve ≥ max(30, P'nin %10'u) düştüyse; 15 aylık geçmiş varsa geçen
// yılın aynı 3 ayına (Y) göre de ≥ %30 düşmüş olmalı (mevsimsellik elenir).
// Neden decayCause ile seçilir ve eylemi belirler. Dönem ay anahtarıdır.

export const SO3_MIN_MONTHS = 6;
export const SO3_YOY_MONTHS = 15;
export const SO3_MIN_DROP = 0.3;
export const SO3_MIN_LOSS = 30;
export const SO3_MIN_LOSS_SHARE = 0.1;
export const SO3_SIGNIFICANT_LOSS = 100;
export const SO3_TOP_QUERIES = 5;
export const SO3_MAX = 10;

export const SO3_CTR_NOTE =
  "Clicks fell while the position held; AI Overviews or new search features may take some of them.";

const ACTION_BY_CAUSE: Readonly<
  Record<DecayCause, { actionKind: SeoActionKind; effort: SeoEffort }>
> = {
  INDEX: { actionKind: "TECH_FIX", effort: "VARIES" },
  CANNIBALIZATION: { actionKind: "CONSOLIDATE", effort: "M" },
  RANKING: { actionKind: "CONTENT_REFRESH", effort: "M" },
  DEMAND: { actionKind: "INVESTIGATE", effort: "VARIES" },
  CTR: { actionKind: "TITLE_META", effort: "S" },
  MIXED: { actionKind: "CONTENT_REFRESH", effort: "M" },
};

// Sayfanın önceki penceredeki ilk 5 sorgusunda kendi payının düşüşü ve diğer
// sayfaların payının artışı (Q'ya göre). Önceki pencere eksikse null.
function shareShift(
  snapshot: RuleSnapshot,
  pageId: string,
): { ownShareDrop: number | null; otherShareRise: number | null } {
  if (!snapshot.previousComplete) {
    return { ownShareDrop: null, otherShareRise: null };
  }
  const index = snapshotIndex(snapshot);
  const top = [...(index.previousPairsByPage.get(pageId) ?? [])]
    .sort(
      (a, b) =>
        b.clicks - a.clicks ||
        b.impressions - a.impressions ||
        a.queryId.localeCompare(b.queryId),
    )
    .slice(0, SO3_TOP_QUERIES);
  let prevQ = 0;
  let prevOwn = 0;
  let prevOther = 0;
  let curQ = 0;
  let curOwn = 0;
  let curOther = 0;
  const split = (pairs: readonly PairStat[]) => {
    let own = 0;
    let other = 0;
    for (const p of pairs) {
      if (p.pageId === pageId) own += p.impressions;
      else other += p.impressions;
    }
    return { own, other };
  };
  for (const item of top) {
    const previous = split(index.previousPairsByQuery.get(item.queryId) ?? []);
    const current = split(index.pairsByQuery.get(item.queryId) ?? []);
    prevQ += index.previousQueries.get(item.queryId)?.impressions ?? 0;
    curQ += index.queries.get(item.queryId)?.impressions ?? 0;
    prevOwn += previous.own;
    prevOther += previous.other;
    curOwn += current.own;
    curOther += current.other;
  }
  if (prevQ <= 0) return { ownShareDrop: null, otherShareRise: null };
  const ownNow = curQ > 0 ? curOwn / curQ : 0;
  const otherNow = curQ > 0 ? curOther / curQ : 0;
  return {
    ownShareDrop: prevOwn / prevQ - ownNow,
    otherShareRise: otherNow - prevOther / prevQ,
  };
}

export const SO3: SeoRule = {
  key: "SO3_CONTENT_DECAY",
  version: 1,
  querySignal: true,
  evaluate(snapshot) {
    const months = [...new Set(snapshot.months)].sort();
    if (!snapshot.monthlyPages || months.length < SO3_MIN_MONTHS) {
      return { evaluable: false, reason: "LOW_HISTORY" };
    }
    const last = months[months.length - 1]!;
    const recentMonths = months.slice(-3);
    const priorMonths = months.slice(-6, -3);
    const yoy = months.length >= SO3_YOY_MONTHS;
    const yearAgoMonths = new Set(recentMonths.map((m) => addMonths(m, -12)));
    const recentSet = new Set(recentMonths);
    const priorSet = new Set(priorMonths);

    const byPage = new Map<
      string,
      { recent: SeoMetric[]; prior: SeoMetric[]; yearAgo: SeoMetric[] }
    >();
    for (const row of snapshot.monthlyPages) {
      const bucket = byPage.get(row.pageId) ?? {
        recent: [],
        prior: [],
        yearAgo: [],
      };
      if (recentSet.has(row.month)) bucket.recent.push(row);
      else if (priorSet.has(row.month)) bucket.prior.push(row);
      else if (yearAgoMonths.has(row.month)) bucket.yearAgo.push(row);
      byPage.set(row.pageId, bucket);
    }

    const window = { from: recentMonths[0]!, to: monthEnd(last) };
    const compare = {
      from: priorMonths[0]!,
      to: monthEnd(priorMonths[priorMonths.length - 1]!),
    };
    const items: RankedDraft[] = [];
    for (const [pageId, bucket] of byPage) {
      const recent = sumMetrics(bucket.recent);
      const prior = sumMetrics(bucket.prior);
      const R = recent.clicks;
      const P = prior.clicks;
      if (P <= 0) continue;
      const loss = P - R;
      if (loss / P < SO3_MIN_DROP) continue;
      if (loss < Math.max(SO3_MIN_LOSS, SO3_MIN_LOSS_SHARE * P)) continue;
      const Y = yoy ? sumMetrics(bucket.yearAgo).clicks : null;
      if (Y !== null && !(Y > 0 && (Y - R) / Y >= SO3_MIN_DROP)) continue;

      const cause = decayCause({
        recent,
        prior,
        indexProblem: hasIndexProblem(snapshot, pageId),
        ...shareShift(snapshot, pageId),
      });
      const { actionKind, effort } = ACTION_BY_CAUSE[cause];
      const confidence =
        Y !== null && loss >= SO3_SIGNIFICANT_LOSS
          ? "SIGNIFICANT"
          : "DIRECTIONAL";
      const metrics: Record<string, number> = {
        recentClicks: Math.round(R),
        priorClicks: Math.round(P),
        lostClicks: Math.round(loss),
        dropPercent: Math.round((loss / P) * 100),
      };
      if (Y !== null) metrics.yearAgoClicks = Math.round(Y);
      items.push({
        rank: loss,
        draft: makeDraft(snapshot, {
          ruleKey: "SO3_CONTENT_DECAY",
          kind: "RISK",
          subject: `page:${pageId}`,
          severity: "WARN",
          confidence,
          effort,
          actionKind,
          impact: clicksImpact((0.5 * loss) / 3, confidence),
          ...contentDecayCopy({
            path: pagePathOf(snapshot, pageId),
            recentClicks: metrics.recentClicks!,
            priorClicks: metrics.priorClicks!,
            dropPercent: metrics.dropPercent!,
            yearAgo: Y !== null,
            cause,
          }),
          evidence: {
            window,
            compare,
            metrics,
            pages: [evidencePage(snapshot, pageId, recent)],
            cause,
            ...(cause === "CTR" ? { notes: [SO3_CTR_NOTE] } : {}),
          },
          pageId,
          keyword: topQueryOfPage(snapshot, pageId)?.text ?? null,
          ideaWorthy: cause === "RANKING" || cause === "CTR",
          signalWorthy: true,
          period: {
            start: window.from,
            end: window.to,
            key: monthlyPeriodKey(last),
          },
        }),
      });
    }
    return finishRule(items, SO3_MAX);
  },
};
