import "server-only";

import { prisma } from "@/lib/prisma";
import { currencyCode, toMajorUnits } from "@/lib/ads/money";
import { nameWithoutTag } from "@/lib/ads/operation-tag";
import type { TrackedLinkRef } from "@/lib/tracked-links/types";
import type { GaRange } from "@/lib/website-analytics/analysis/types";
import {
  attributeCampaignRows,
  campaignRowsOf,
  CAMPAIGN_DIMENSIONS,
  CAMPAIGN_METRICS,
  legacyAdCandidates,
} from "@/lib/website-analytics/attribution/match";
import {
  GOOGLE_ADS_DIMENSIONS,
  GOOGLE_ADS_METRICS,
  GOOGLE_ADS_REPORT_KEY,
  googleAdsRowsOf,
} from "@/lib/website-analytics/attribution/google-ads";
import type {
  AttributionResult,
  CampaignSliceRow,
  GoogleAdsCampaignRow,
  LegacyMetaAd,
  MetaAdsWindow,
} from "@/lib/website-analytics/attribution/types";
import {
  addDays,
  dateToDayKey,
  dayKeyToDate,
  daysInRange,
} from "@/lib/website-analytics/days";
import {
  aggregateSlices,
  type GaStoredSlice,
} from "@/lib/website-analytics/slices";
import {
  readMergedSlices,
  readSlices,
} from "@/server/website-analytics/store";
import {
  findTrackedLinksForProject,
  resolveMetaAdLinks,
} from "@/server/tracked-links/store";

// GA-F6 atıf okuyucuları (docs/website-attribution.md "Atıf" ve "Reklam
// ölçümü"): GA ambarı, Meta aynası ve TrackedLink okunur; Google'a, Meta'ya
// ya da bir web sitesine hiç gidilmez ve Google metinleri (kampanya adı,
// içerik) loglanmaz. Her liste sınırlıdır, yalnız gereken sütunlar seçilir.

const NO_DAYS: ReadonlySet<string> = new Set();
const MAX_AD_IDS = 1000;
const MAX_LEGACY_ADS = 500;
const MAX_GOOGLE_ADS_ROWS = 500;

export async function loadAttributionLinks(
  projectId: string,
): Promise<TrackedLinkRef[]> {
  const records = await findTrackedLinksForProject(projectId);
  const resolved = await resolveMetaAdLinks(records);
  return resolved.map((record) => ({
    id: record.id,
    code: record.code,
    entityType: record.entityType,
    entityId: record.entityId,
    channel: record.channel,
    utmSource: record.utmSource,
    utmMedium: record.utmMedium,
    utmCampaign: record.utmCampaign,
    utmContent: record.utmContent,
    label: record.label,
    campaignExternalId: record.campaignExternalId,
    adExternalId: record.adExternalId,
    carriesCode: record.carriesCode,
    createdAt: record.createdAt,
  }));
}

// utm_content'i {{ad.id}} olan eski reklamlar: yalnız projenin Agentelse'in
// kurduğu reklamları; iki sorgu (reklamlar, sonra kampanyaları).
export async function loadLegacyMetaAds(
  projectId: string,
  contents: readonly string[],
): Promise<LegacyMetaAd[]> {
  if (contents.length === 0) return [];
  const ads = await prisma.adsObject.findMany({
    where: {
      projectId,
      createdByAgentelse: true,
      level: "AD",
      externalId: { in: contents.slice(0, MAX_LEGACY_ADS) },
    },
    select: { externalId: true, campaignExternalId: true },
    take: MAX_LEGACY_ADS,
  });
  const withCampaign = ads.flatMap((ad) =>
    ad.campaignExternalId
      ? [{ adExternalId: ad.externalId, campaignExternalId: ad.campaignExternalId }]
      : [],
  );
  if (withCampaign.length === 0) return [];
  const campaigns = await prisma.adsObject.findMany({
    where: {
      projectId,
      createdByAgentelse: true,
      level: "CAMPAIGN",
      externalId: {
        in: [...new Set(withCampaign.map((ad) => ad.campaignExternalId))],
      },
    },
    select: { externalId: true, name: true },
    take: MAX_LEGACY_ADS,
  });
  const names = new Map(
    campaigns.map((campaign) => [campaign.externalId, campaign.name]),
  );
  return withCampaign.map((ad) => {
    const name = names.get(ad.campaignExternalId);
    return {
      ...ad,
      label: name ? nameWithoutTag(name) : "Meta campaign",
    };
  });
}

export type CampaignWindowRows = {
  rows: CampaignSliceRow[];
  days: number;
  coveredDays: number;
  // Kampanya ayrıntısının gerçekten okunduğu günler (HAFTA diliminin yedi günü
  // dâhil); aralığın geri kalanı GA tarafında körsüz sayılır.
  coveredDayKeys: ReadonlySet<string>;
  truncated: boolean;
};

// GA kampanya ayrıntısı olmayan günler (şüpheli günler ve dilimi olmayanlar):
// Meta penceresi de bu günleri dışarıda bırakır ki iki taraf aynı günleri
// karşılaştırsın; yoksa Meta tıklaması GA oturumundan çok görünür ve sahte
// "tıklama kaybı" doğar.
export function uncoveredDaysOf(
  range: GaRange,
  window: Pick<CampaignWindowRows, "coveredDayKeys">,
  exclude: ReadonlySet<string> = NO_DAYS,
): ReadonlySet<string> {
  const out = new Set(exclude);
  for (
    let day = range.from;
    day <= range.to;
    day = addDays(day, 1)
  ) {
    if (!window.coveredDayKeys.has(day)) out.add(day);
  }
  return out;
}

// "campaign" raporu: GÜN + HAFTA dilimleri tek tabloda. Dışarıda tutulan
// günlere (şüpheli günler) değen dilim düşer; bir HAFTA diliminin yedi günü de
// temiz olmalıdır.
export async function loadCampaignWindow(
  linkId: string,
  range: GaRange,
  exclude: ReadonlySet<string> = NO_DAYS,
): Promise<CampaignWindowRows> {
  const merged = await readMergedSlices(linkId, "campaign", range.from, range.to);
  const weekStarts = new Set(merged.plan.weeks);
  const kept: GaStoredSlice[] = [];
  const coveredDayKeys = new Set<string>();
  for (const slice of merged.slices) {
    if (weekStarts.has(slice.day)) {
      const weekDays: string[] = [];
      for (let offset = 0; offset < 7; offset += 1) {
        weekDays.push(addDays(slice.day, offset));
      }
      if (weekDays.some((day) => exclude.has(day))) continue;
      for (const day of weekDays) coveredDayKeys.add(day);
    } else {
      if (exclude.has(slice.day)) continue;
      coveredDayKeys.add(slice.day);
    }
    kept.push(slice);
  }
  const coveredDays = [...coveredDayKeys].filter(
    (day) => day >= range.from && day <= range.to,
  ).length;
  const table = aggregateSlices(
    kept,
    [...CAMPAIGN_DIMENSIONS],
    [...CAMPAIGN_METRICS],
  );
  return {
    rows: campaignRowsOf(table),
    days: daysInRange(range.from, range.to),
    coveredDays,
    coveredDayKeys,
    truncated: kept.some((slice) => slice.truncated || slice.otherRow !== null),
  };
}

type MetaWindowsResult = {
  currency: string | null;
  mixedCurrency: boolean;
  synced: boolean;
  windows: Map<string, MetaAdsWindow>;
};

// Meta AD düzeyi içgörüleri, projeye bağlı bütün reklam hesaplarından, yalnız
// verilen reklam kimlikleri için. Projenin hiç reklam hesabı yoksa null.
export async function loadMetaAdWindows(
  projectId: string,
  groups: readonly { key: string; adExternalIds: readonly string[] }[],
  range: GaRange,
  exclude: ReadonlySet<string> = NO_DAYS,
): Promise<MetaWindowsResult | null> {
  const accounts = await prisma.adsAccountProject.findMany({
    where: { projectId },
    select: { adsAccountId: true },
  });
  if (accounts.length === 0) return null;

  const groupOfAd = new Map<string, string>();
  for (const group of groups) {
    for (const adId of group.adExternalIds) {
      if (groupOfAd.size >= MAX_AD_IDS) break;
      if (!groupOfAd.has(adId)) groupOfAd.set(adId, group.key);
    }
  }
  const accountIds = accounts.map((account) => account.adsAccountId);
  // "Senkron" = hesapta AD düzeyi herhangi bir içgörü satırı var; çözülmüş
  // reklamı olmayan bir proje "hesap senkron değil" gibi gösterilmesin.
  const accountSynced = async () =>
    (await prisma.adsInsightDaily.findFirst({
      where: { level: "AD", adsAccountId: { in: accountIds } },
      select: { id: true },
    })) !== null;
  if (groupOfAd.size === 0) {
    return {
      currency: null,
      mixedCurrency: false,
      synced: await accountSynced(),
      windows: new Map(),
    };
  }

  const found = await prisma.adsInsightDaily.findMany({
    where: {
      level: "AD",
      externalId: { in: [...groupOfAd.keys()] },
      adsAccountId: { in: accountIds },
      date: { gte: dayKeyToDate(range.from), lte: dayKeyToDate(range.to) },
    },
    select: {
      adsAccountId: true,
      externalId: true,
      date: true,
      spendMinor: true,
      linkClicks: true,
      landingPageViews: true,
      results: true,
      resultActionType: true,
    },
    orderBy: [{ date: "asc" }, { externalId: "asc" }],
  });
  const rows = found.filter((row) => !exclude.has(dateToDayKey(row.date)));

  const rowAccountIds = [...new Set(rows.map((row) => row.adsAccountId))];
  const accountRows =
    rowAccountIds.length === 0
      ? []
      : await prisma.adsAccount.findMany({
          where: { id: { in: rowAccountIds } },
          select: { id: true, currency: true },
        });
  const currencies = new Set(
    accountRows.map((account) => currencyCode(account.currency) ?? ""),
  );
  const mixedCurrency = currencies.size > 1;
  const onlyCurrency = currencies.size === 1 ? [...currencies][0]! : "";
  const currency = mixedCurrency || onlyCurrency === "" ? null : onlyCurrency;

  type Sum = {
    ads: Set<string>;
    spendMinor: number;
    linkClicks: number;
    landingPageViews: number;
    results: number | null;
    resultActionType: string | null;
    spendDays: Set<string>;
  };
  const sums = new Map<string, Sum>();
  for (const row of rows) {
    const key = groupOfAd.get(row.externalId);
    if (!key) continue;
    const sum = sums.get(key) ?? {
      ads: new Set<string>(),
      spendMinor: 0,
      linkClicks: 0,
      landingPageViews: 0,
      results: null,
      resultActionType: null,
      spendDays: new Set<string>(),
    };
    const spend = Number(row.spendMinor);
    sum.ads.add(row.externalId);
    sum.spendMinor += spend;
    sum.linkClicks += row.linkClicks;
    sum.landingPageViews += row.landingPageViews;
    if (row.results !== null) sum.results = (sum.results ?? 0) + row.results;
    if (sum.resultActionType === null && row.resultActionType) {
      sum.resultActionType = row.resultActionType;
    }
    if (spend > 0) sum.spendDays.add(dateToDayKey(row.date));
    sums.set(key, sum);
  }

  const windows = new Map<string, MetaAdsWindow>();
  for (const [key, sum] of sums) {
    windows.set(key, {
      groupKey: key,
      ads: sum.ads.size,
      spend: mixedCurrency ? null : toMajorUnits(sum.spendMinor, currency),
      linkClicks: sum.linkClicks,
      landingPageViews: sum.landingPageViews,
      results: sum.results,
      resultActionType: sum.resultActionType,
      activeDays: sum.spendDays.size,
    });
  }
  return {
    currency,
    mixedCurrency,
    synced: found.length > 0 || (await accountSynced()),
    windows,
  };
}

// GA4 Google Ads kampanya raporu (yalnız DAY dilimleri); katalog denetimi
// raporu açmadıysa ya da dışarıda tutulmayan gün kalmadıysa null.
export async function loadGoogleAdsWindow(
  linkId: string,
  range: GaRange,
  exclude: ReadonlySet<string> = NO_DAYS,
): Promise<{ rows: GoogleAdsCampaignRow[]; coveredDays: number } | null> {
  const slices = await readSlices(
    linkId,
    GOOGLE_ADS_REPORT_KEY,
    range.from,
    range.to,
  );
  const kept = slices.filter((slice) => !exclude.has(slice.day));
  if (kept.length === 0) return null;
  const table = aggregateSlices(
    kept,
    [...GOOGLE_ADS_DIMENSIONS],
    [...GOOGLE_ADS_METRICS],
  );
  return {
    rows: googleAdsRowsOf(table).slice(0, MAX_GOOGLE_ADS_ROWS),
    coveredDays: kept.length,
  };
}

export async function attributeWindow(input: {
  projectId: string;
  linkId: string;
  range: GaRange;
  exclude?: ReadonlySet<string>;
}): Promise<{
  result: AttributionResult;
  window: CampaignWindowRows;
  links: TrackedLinkRef[];
  legacy: LegacyMetaAd[];
}> {
  const [links, window] = await Promise.all([
    loadAttributionLinks(input.projectId),
    loadCampaignWindow(input.linkId, input.range, input.exclude),
  ]);
  const legacy = await loadLegacyMetaAds(
    input.projectId,
    legacyAdCandidates(window.rows),
  );
  return {
    result: attributeCampaignRows(window.rows, links, legacy),
    window,
    links,
    legacy,
  };
}
