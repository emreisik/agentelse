import { resultLabel } from "@/lib/ads/results";

import {
  CROSS_CHECK,
  type AttributionGroup,
  type AttributionMetrics,
  type CrossCheckFlag,
  type MetaAdsWindow,
  type MetaVsGaRow,
} from "./types";

// Meta AD düzeyi ile GA'nın aynı reklamlar için gördüğü sayıların
// karşılaştırılması (docs/website-attribution.md "Reklam ölçümü"). Yalnız
// Agentelse'in kurup etiketlediği reklamlar iki tarafta da vardır. Saf modül.

const DEFAULT_LIMIT = 10;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// Web sitesi sonucu: piksel dönüşümü. Link tıklaması, mesaj gibi sonuçlar GA4
// key event'iyle karşılaştırılamaz.
export function isWebsiteResultType(actionType: string | null): boolean {
  return actionType?.startsWith("offsite_conversion.") ?? false;
}

// Tıklayıp siteye varmayanların oranı (0–1); oturum tıklamadan çoksa 0.
export function clickLoss(linkClicks: number, sessions: number): number | null {
  return linkClicks > 0 ? Math.max(0, 1 - sessions / linkClicks) : null;
}

// İki sayımın göreli farkı: |sonuç − key event| / büyüğü.
export function resultsGap(
  results: number | null,
  keyEvents: number,
): number | null {
  if (results === null) return null;
  const max = Math.max(results, keyEvents);
  return max > 0 ? Math.abs(results - keyEvents) / max : null;
}

export function costPer(
  spend: number | null,
  count: number | null,
): number | null {
  return spend !== null && count !== null && count > 0 ? spend / count : null;
}

export function crossCheckFlags(
  meta: MetaAdsWindow | null,
  ga: AttributionMetrics,
): CrossCheckFlag[] {
  if (!meta || meta.linkClicks < CROSS_CHECK.minClicks) return [];
  const flags: CrossCheckFlag[] = [];
  const loss = clickLoss(meta.linkClicks, ga.sessions);
  if (loss !== null && loss > CROSS_CHECK.maxClickLoss) {
    flags.push("click_loss");
  }
  if (
    isWebsiteResultType(meta.resultActionType) &&
    meta.results !== null &&
    Math.max(meta.results, ga.keyEvents) >= CROSS_CHECK.minConversions
  ) {
    const gap = resultsGap(meta.results, ga.keyEvents);
    if (gap !== null && gap > CROSS_CHECK.maxResultsGap) {
      flags.push("results_gap");
    }
  }
  return flags;
}

function rowOf(
  group: AttributionGroup,
  window: MetaAdsWindow | undefined,
): MetaVsGaRow {
  if (group.adExternalIds.length === 0 || !window) {
    return {
      groupKey: group.key,
      campaignExternalId: group.campaignExternalId,
      label: group.label,
      tracked: false,
      spend: null,
      linkClicks: null,
      sessions: group.metrics.sessions,
      clickToSessionPct: null,
      results: null,
      resultLabel: null,
      websiteResults: false,
      keyEvents: group.metrics.keyEvents,
      costPerResult: null,
      costPerKeyEvent: null,
      flags: [],
    };
  }
  const ga = group.adMetrics;
  return {
    groupKey: group.key,
    campaignExternalId: group.campaignExternalId,
    label: group.label,
    tracked: true,
    spend: window.spend,
    linkClicks: window.linkClicks,
    sessions: ga.sessions,
    clickToSessionPct:
      window.linkClicks > 0
        ? round1((ga.sessions / window.linkClicks) * 100)
        : null,
    results: window.results,
    resultLabel:
      window.results !== null ? resultLabel(window.resultActionType) : null,
    websiteResults: isWebsiteResultType(window.resultActionType),
    keyEvents: ga.keyEvents,
    costPerResult: costPer(window.spend, window.results),
    costPerKeyEvent: costPer(window.spend, ga.keyEvents),
    flags: crossCheckFlags(window, ga),
  };
}

// Yalnız Meta kampanyası grupları; harcama azalan (null sonda), sonra oturum.
export function metaVsGaRows(input: {
  groups: readonly AttributionGroup[];
  meta: ReadonlyMap<string, MetaAdsWindow> | null;
  limit?: number;
}): MetaVsGaRow[] {
  return input.groups
    .filter((group) => group.kind === "meta_campaign")
    .map((group) => rowOf(group, input.meta?.get(group.key)))
    .sort((a, b) => {
      if (a.spend === null && b.spend !== null) return 1;
      if (a.spend !== null && b.spend === null) return -1;
      return (
        (b.spend ?? 0) - (a.spend ?? 0) ||
        b.sessions - a.sessions ||
        a.groupKey.localeCompare(b.groupKey)
      );
    })
    .slice(0, input.limit ?? DEFAULT_LIMIT);
}
