import "server-only";

import type { GaPropertyLink } from "@prisma/client";

import type { GaRange } from "@/lib/website-analytics/analysis/types";
import { metaVsGaRows } from "@/lib/website-analytics/attribution/ads-compare";
import { ATTRIBUTION_COPY } from "@/lib/website-analytics/attribution/copy";
import { gaAttributionEnabledFor } from "@/lib/website-analytics/attribution/flags";
import { googleAdsViewRows } from "@/lib/website-analytics/attribution/google-ads";
import {
  engagementPct,
  fromAgentelseRows,
} from "@/lib/website-analytics/attribution/match";
import type {
  AdsCrossCheckCampaign,
  AdsOnWebsiteView,
  FromAgentelseView,
  GaAdsCrossCheckInput,
  WebsiteAttributionView,
} from "@/lib/website-analytics/attribution/types";
import { addDays, daysInRange } from "@/lib/website-analytics/days";
import { primaryGaLink, readDailyTotals } from "@/server/website-analytics/store";

import {
  attributeWindow,
  loadGoogleAdsWindow,
  loadMetaAdWindows,
  uncoveredDaysOf,
} from "./data";

// GA-F6 atıf okuması (docs/website-attribution.md): Website sayfasındaki
// "From Agentelse" ve "Your ads on your website" ile AN13/AN14 girdisi.
// Hepsi okuma anında hesaplanır; bayrak kapalıyken hiç sorgu yoktur.

const LABEL_CAP = 80;
// Google Ads karşılaştırması için iki pencerede de en az bu kadar temiz gün.
const MIN_GOOGLE_ADS_DAYS = 21;
const CROSS_CHECK_GOOGLE_ADS_ROWS = 100;
// AN13: GA kampanya ayrıntısı bu orandan azsa Meta ile karşılaştırma yapılmaz.
const MIN_GA_COVERAGE = 0.9;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function capLabel(label: string): string {
  return label.length > LABEL_CAP ? label.slice(0, LABEL_CAP) : label;
}

// Aynı uzunlukta, `range`'den hemen önce biten aralık.
function previousRangeOf(range: GaRange): GaRange {
  const days = daysInRange(range.from, range.to);
  const to = addDays(range.from, -1);
  return { from: addDays(to, -(days - 1)), to };
}

export async function loadWebsiteAttribution(
  projectId: string,
  range: GaRange,
): Promise<WebsiteAttributionView | null> {
  if (!gaAttributionEnabledFor(projectId)) return null;
  const link = await primaryGaLink(projectId);
  if (!link) return null;

  const [attributed, totals] = await Promise.all([
    attributeWindow({ projectId, linkId: link.id, range }),
    readDailyTotals(link.id, range.from, range.to),
  ]);
  const { result, window, links } = attributed;
  const siteSessions = totals.reduce((sum, row) => sum + row.sessions, 0);

  let from: FromAgentelseView | null = null;
  if (links.length > 0 || result.groups.length > 0) {
    const { rows, other } = fromAgentelseRows(result);
    const notes: string[] = [ATTRIBUTION_COPY.trackedOnly];
    if (window.truncated) notes.push(ATTRIBUTION_COPY.truncated);
    if (window.coveredDays < window.days) {
      notes.push(
        `${window.coveredDays} of ${window.days} days have campaign detail`,
      );
    }
    from = {
      range,
      currency: link.currencyCode,
      rows,
      other,
      total: {
        sessions: result.total.sessions,
        engagementRate: engagementPct(result.total),
        keyEvents: result.total.keyEvents,
        revenue: Math.round(result.total.revenue * 100) / 100,
      },
      sitePct:
        siteSessions > 0
          ? round1((result.total.sessions / siteSessions) * 100)
          : null,
      trackedLinks: links.length,
      days: window.days,
      coveredDays: window.coveredDays,
      truncated: window.truncated,
      notes,
    };
  }

  const metaGroups = result.groups.filter(
    (group) => group.kind === "meta_campaign",
  );
  const previousRange = previousRangeOf(range);
  const [metaWindows, googleCurrent, googlePrevious] = await Promise.all([
    metaGroups.length > 0
      ? loadMetaAdWindows(
          projectId,
          metaGroups.map((group) => ({
            key: group.key,
            adExternalIds: group.adExternalIds,
          })),
          range,
          // Meta yalnız GA'nın kampanya ayrıntısı olan günleri sayar.
          uncoveredDaysOf(range, window),
        )
      : Promise.resolve(null),
    loadGoogleAdsWindow(link.id, range),
    loadGoogleAdsWindow(link.id, previousRange),
  ]);

  let meta: AdsOnWebsiteView["meta"] = null;
  if (metaGroups.length > 0) {
    const synced = metaWindows?.synced ?? false;
    const rows = metaVsGaRows({
      groups: result.groups,
      meta: metaWindows?.windows ?? null,
    });
    const notes: string[] = [
      ATTRIBUTION_COPY.metaWindowNote,
      ATTRIBUTION_COPY.dayAlignmentNote,
      ATTRIBUTION_COPY.adLevelNote,
    ];
    if (window.coveredDays < window.days) {
      notes.push(ATTRIBUTION_COPY.coverageNote(window.coveredDays, window.days));
    }
    if (!synced) notes.push(ATTRIBUTION_COPY.notSynced);
    else if (rows.some((row) => !row.tracked)) {
      notes.push(ATTRIBUTION_COPY.metaPending);
    }
    if (metaWindows?.mixedCurrency) notes.push(ATTRIBUTION_COPY.mixedCurrency);
    const metaCurrency = metaWindows?.currency ?? null;
    if (
      metaCurrency &&
      link.currencyCode &&
      metaCurrency !== link.currencyCode
    ) {
      notes.push(ATTRIBUTION_COPY.currencyNote(metaCurrency, link.currencyCode));
    }
    meta = {
      currency: metaCurrency,
      gaCurrency: link.currencyCode,
      synced,
      rows,
      notes,
    };
  }

  const googleRows = googleCurrent
    ? googleAdsViewRows(googleCurrent.rows, googlePrevious?.rows ?? [])
    : [];
  const googleAds: AdsOnWebsiteView["googleAds"] =
    googleRows.length > 0
      ? {
          currency: link.currencyCode,
          rows: googleRows,
          notes: [ATTRIBUTION_COPY.googleAdsNote],
        }
      : null;

  const ads: AdsOnWebsiteView | null =
    meta || googleAds ? { range, meta, googleAds } : null;
  return { from, ads };
}

// AN13 / AN14 girdisi: yalnız Agentelse'in kurup etiketlediği reklamlar (AD
// düzeyi) ve iki pencerenin Google Ads satırları. `exclude` iki pencerenin
// şüpheli günleridir; hem GA hem Meta tarafında düşer.
export async function loadAdsCrossCheckInput(input: {
  link: Pick<GaPropertyLink, "id" | "projectId" | "currencyCode">;
  window: GaRange;
  previousWindow: GaRange;
  exclude: ReadonlySet<string>;
}): Promise<GaAdsCrossCheckInput | null> {
  const { link, exclude } = input;
  if (!gaAttributionEnabledFor(link.projectId)) return null;

  const [attributed, googleCurrent, googlePrevious] = await Promise.all([
    attributeWindow({
      projectId: link.projectId,
      linkId: link.id,
      range: input.window,
      exclude,
    }),
    loadGoogleAdsWindow(link.id, input.window, exclude),
    loadGoogleAdsWindow(link.id, input.previousWindow, exclude),
  ]);

  // GA kampanya ayrıntısı, dışarıda tutulmayan günlerin en az %90'ını
  // kapsamıyorsa Meta karşılaştırması yapılmaz (sahte tıklama kaybı olurdu).
  const expectedDays = Math.max(
    0,
    attributed.window.days -
      [...exclude].filter(
        (day) => day >= input.window.from && day <= input.window.to,
      ).length,
  );
  const gaCovered =
    expectedDays > 0 &&
    attributed.window.coveredDays >= expectedDays * MIN_GA_COVERAGE;
  const candidates = attributed.result.groups.filter(
    (group) =>
      gaCovered &&
      group.kind === "meta_campaign" &&
      group.campaignExternalId !== null &&
      group.adExternalIds.length > 0,
  );
  const metaWindows =
    candidates.length > 0
      ? await loadMetaAdWindows(
          link.projectId,
          candidates.map((group) => ({
            key: group.key,
            adExternalIds: group.adExternalIds,
          })),
          input.window,
          uncoveredDaysOf(input.window, attributed.window, exclude),
        )
      : null;

  const campaigns: AdsCrossCheckCampaign[] = [];
  for (const group of candidates) {
    const window = metaWindows?.windows.get(group.key);
    if (!window || group.campaignExternalId === null) continue;
    campaigns.push({
      groupKey: group.key,
      campaignExternalId: group.campaignExternalId,
      label: capLabel(group.label),
      meta: window,
      ga: group.adMetrics,
    });
  }

  const googleAds =
    googleCurrent &&
    googlePrevious &&
    googleCurrent.coveredDays >= MIN_GOOGLE_ADS_DAYS &&
    googlePrevious.coveredDays >= MIN_GOOGLE_ADS_DAYS
      ? {
          current: googleCurrent.rows.slice(0, CROSS_CHECK_GOOGLE_ADS_ROWS),
          previous: googlePrevious.rows.slice(0, CROSS_CHECK_GOOGLE_ADS_ROWS),
        }
      : null;

  if (campaigns.length === 0 && googleAds === null) return null;
  return {
    window: input.window,
    previousWindow: input.previousWindow,
    metaCurrency: metaWindows?.currency ?? null,
    campaigns,
    googleAds,
  };
}
