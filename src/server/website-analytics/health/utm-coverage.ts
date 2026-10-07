import "server-only";

import type { GaPropertyLink } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import { gaAttributionEnabledFor } from "@/lib/website-analytics/attribution/flags";
import {
  addDays,
  dateToDayKey,
  dayKeyToDate,
  safeTimezone,
} from "@/lib/website-analytics/days";
import {
  evaluateUtmCoverage,
  UTM_COVERAGE,
  type UtmCoverageAd,
  type UtmCoverageInput,
  type UtmCoverageResult,
} from "@/lib/website-analytics/health/utm-coverage";
import { isAgxCampaign, parseAgxCode } from "@/lib/utm";
import {
  findTrackedLinksForProject,
  resolveMetaAdLinks,
} from "@/server/tracked-links/store";
import { loadCampaignWindow } from "@/server/website-analytics/attribution/data";
import { gaDataThrough, primaryGaLink } from "@/server/website-analytics/store";

// MH25 okuma tarafı (GA-F6): ölçüm sağlığı panelinin altında her görüntülemede
// hesaplanır; hiçbir şey saklanmaz, puana girmez, uyarı üretmez. Google'a ve
// Meta'ya çağrı yapmaz; yalnız ayna ve ambardan okur.

// Site trafiği getiren reklam setleri: hedef türü bilinmeyen, WEBSITE ya da
// UNDEFINED olanlar. Mesajlaşma ve gönderi hedefleri dışarıda kalır.
const WEBSITE_DESTINATIONS: readonly (string | null)[] = [
  null,
  "WEBSITE",
  "UNDEFINED",
];

export async function loadUtmCoverageInput(
  projectId: string,
  link: Pick<GaPropertyLink, "id" | "timeZone">,
  now: Date,
): Promise<UtmCoverageInput> {
  const today = dayKeyInTimezone(now, safeTimezone(link.timeZone));
  const windowFrom = addDays(today, -(UTM_COVERAGE.windowDays - 1));
  const { through: dataThrough } = await gaDataThrough(link.id);

  const adObjects = await prisma.adsObject.findMany({
    where: { projectId, level: "AD", createdByAgentelse: true },
    select: { externalId: true, parentExternalId: true },
    take: UTM_COVERAGE.maxAds,
  });
  const empty: UtmCoverageInput = {
    dataThrough,
    ads: [],
    seen: { codes: [], campaigns: [] },
  };
  if (adObjects.length === 0) return empty;

  const parents = [
    ...new Set(
      adObjects.flatMap((ad) => (ad.parentExternalId ? [ad.parentExternalId] : [])),
    ),
  ];
  const adSets =
    parents.length === 0
      ? []
      : await prisma.adsObject.findMany({
          where: { projectId, level: "ADSET", externalId: { in: parents } },
          select: { externalId: true, destinationType: true },
        });
  const destinationOf = new Map(
    adSets.map((adSet) => [adSet.externalId, adSet.destinationType]),
  );
  const websiteAdIds = adObjects
    .filter((ad) =>
      WEBSITE_DESTINATIONS.includes(
        ad.parentExternalId ? (destinationOf.get(ad.parentExternalId) ?? null) : null,
      ),
    )
    .map((ad) => ad.externalId);
  if (websiteAdIds.length === 0) return empty;

  const accounts = await prisma.adsAccountProject.findMany({
    where: { projectId },
    select: { adsAccountId: true },
  });
  if (accounts.length === 0) return empty;

  const clicks = await prisma.adsInsightDaily.groupBy({
    by: ["externalId"],
    where: {
      level: "AD",
      externalId: { in: websiteAdIds },
      adsAccountId: { in: accounts.map((account) => account.adsAccountId) },
      date: { gte: dayKeyToDate(windowFrom), lte: dayKeyToDate(today) },
      linkClicks: { gt: 0 },
    },
    _sum: { linkClicks: true },
    _min: { date: true },
  });

  const trackedLinks = await resolveMetaAdLinks(
    await findTrackedLinksForProject(projectId, { entityTypes: ["meta_ad"] }),
  );
  // Aynı reklama birden çok satır düşerse kodu taşıyan tercih edilir.
  const linkByAd = new Map<string, (typeof trackedLinks)[number]>();
  for (const tracked of trackedLinks) {
    if (!tracked.adExternalId) continue;
    const current = linkByAd.get(tracked.adExternalId);
    if (!current || (!current.carriesCode && tracked.carriesCode)) {
      linkByAd.set(tracked.adExternalId, tracked);
    }
  }

  const ads: UtmCoverageAd[] = [];
  for (const row of clicks) {
    const linkClicks = row._sum.linkClicks ?? 0;
    if (linkClicks < 1 || !row._min.date) continue;
    const tracked = linkByAd.get(row.externalId);
    const tagged = tracked?.carriesCode === true;
    ads.push({
      adExternalId: row.externalId,
      firstClickDay: dateToDayKey(row._min.date),
      linkClicks,
      tagged,
      code: tagged ? (tracked?.code ?? null) : null,
      utmCampaign: tagged ? (tracked?.utmCampaign ?? null) : null,
    });
  }

  // Kodun GA'da görünüp görünmediği yalnız etiketli reklam varken sorulur.
  const taggedAds = ads.filter((ad) => ad.tagged);
  if (taggedAds.length === 0 || !dataThrough) {
    return { dataThrough, ads, seen: { codes: [], campaigns: [] } };
  }
  const from = taggedAds.map((ad) => ad.firstClickDay).sort()[0]!;
  if (from > dataThrough) {
    return { dataThrough, ads, seen: { codes: [], campaigns: [] } };
  }
  const window = await loadCampaignWindow(link.id, { from, to: dataThrough });
  const codes = new Set<string>();
  const campaigns = new Set<string>();
  for (const row of window.rows) {
    const code = parseAgxCode(row.content);
    if (code) codes.add(code);
    if (isAgxCampaign(row.campaign)) {
      campaigns.add(row.campaign.trim().toLowerCase());
    }
  }
  return {
    dataThrough,
    ads,
    seen: { codes: [...codes], campaigns: [...campaigns] },
  };
}

// Bayrak kapalıyken sorgusuz null; birincil bağ yoksa ya da herhangi bir hata
// olursa da null (panel bozulmaz).
export async function loadUtmCoverageCheck(
  projectId: string,
  now: Date = new Date(),
): Promise<UtmCoverageResult | null> {
  if (!gaAttributionEnabledFor(projectId)) return null;
  try {
    const link = await primaryGaLink(projectId);
    if (!link) return null;
    return evaluateUtmCoverage(await loadUtmCoverageInput(projectId, link, now));
  } catch (error) {
    console.error("[utm-coverage] MH25 hesaplanamadı", {
      projectId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}
