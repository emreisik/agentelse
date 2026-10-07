import "server-only";

import { prisma } from "@/lib/prisma";
import { addDays, dayKeyToDate } from "@/lib/website-analytics/days";
import {
  GOOGLE_ADS_DIMENSIONS,
  GOOGLE_ADS_METRICS,
  GOOGLE_ADS_REPORT_KEY,
} from "@/lib/website-analytics/attribution/google-ads";
import {
  CAMPAIGN_DIMENSIONS,
  CAMPAIGN_METRICS,
} from "@/lib/website-analytics/attribution/match";
import type {
  CampaignSliceRow,
  GoogleAdsCampaignRow,
} from "@/lib/website-analytics/attribution/types";
import { cleanupTrackedLinks } from "@/server/tracked-links/test-support";

// Yalnız *.integration.test.ts dosyaları için: GA-F6 atıf testlerinin tohumu.
// GA ambarı (günlük toplamlar, campaign ve google_ads dilimleri) ve Meta
// aynası (hesap, nesneler, AD düzeyi içgörüler) catalog.ts ve şemadaki
// biçimle yazılır; Google'a ya da Meta'ya hiç gidilmez.

export async function seedAttributionGaLink(input: {
  workspaceId: string;
  projectId: string;
  brandId: string;
  through: string;
  days: number;
  sessionsPerDay?: number;
  keyEventsPerDay?: number;
  timeZone?: string;
  currency?: string | null;
  isMock?: boolean;
  streamUri?: string | null;
}): Promise<{ linkId: string; credentialId: string }> {
  const sessions = input.sessionsPerDay ?? 100;
  const keyEvents = input.keyEventsPerDay ?? 5;
  const propertyId = String(
    100_000_000 + Math.floor(Math.random() * 800_000_000),
  );
  const credential = await prisma.integrationCredential.create({
    data: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
      provider: "google_analytics",
      accountLabel: "owner@example.com",
      encryptedSecret: "x",
      status: "ACTIVE",
      metadata: {
        ga4Properties: [
          { propertyId, propertyName: "Web", accountName: "Acme" },
        ],
        selectedGa4PropertyId: propertyId,
        selectedGa4PropertyName: "Web",
      },
    },
  });
  const link = await prisma.gaPropertyLink.create({
    data: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      credentialId: credential.id,
      propertyId,
      isPrimary: true,
      isMock: input.isMock ?? false,
      propertyName: "Web",
      timeZone: input.timeZone ?? "Europe/Istanbul",
      currencyCode: input.currency === undefined ? "EUR" : input.currency,
      streamUri: input.streamUri ?? null,
      health: "OK",
      lastDailyDate: addDays(input.through, 1),
      lastDailyAt: new Date(),
    },
  });
  const start = addDays(input.through, -(input.days - 1));
  const fetchedAt = new Date();
  await prisma.gaDailyTotal.createMany({
    data: Array.from({ length: input.days }, (_, index) => {
      const day = addDays(start, index);
      return {
        linkId: link.id,
        projectId: input.projectId,
        date: dayKeyToDate(day),
        activeUsers: Math.round(0.8 * sessions),
        newUsers: Math.round(0.4 * sessions),
        sessions,
        engagedSessions: Math.round(0.6 * sessions),
        engagementSec: 60 * sessions,
        keyEvents,
        revenueMicros: BigInt(0),
        isFinal: day <= addDays(input.through, -7),
        fetchedAt,
      };
    }),
  });
  return { linkId: link.id, credentialId: credential.id };
}

async function seedDaySlices(input: {
  linkId: string;
  projectId: string;
  reportKey: string;
  dimensionHeaders: readonly string[];
  metricHeaders: readonly string[];
  days: readonly { day: string; rows: readonly (string | number)[][] }[];
}): Promise<void> {
  const fetchedAt = new Date();
  await prisma.gaReportSlice.createMany({
    data: input.days.map(({ day, rows }) => ({
      linkId: input.linkId,
      projectId: input.projectId,
      reportKey: input.reportKey,
      grain: "DAY",
      periodStart: dayKeyToDate(day),
      specVersion: 1,
      dimensionHeaders: [...input.dimensionHeaders],
      metricHeaders: [...input.metricHeaders],
      rows,
      rowCount: rows.length,
      truncated: false,
      quality: {},
      isFinal: true,
      fetchedAt,
    })),
  });
}

export async function seedCampaignSlices(input: {
  linkId: string;
  projectId: string;
  days: readonly { day: string; rows: readonly CampaignSliceRow[] }[];
}): Promise<void> {
  await seedDaySlices({
    linkId: input.linkId,
    projectId: input.projectId,
    reportKey: "campaign",
    dimensionHeaders: CAMPAIGN_DIMENSIONS,
    metricHeaders: CAMPAIGN_METRICS,
    days: input.days.map(({ day, rows }) => ({
      day,
      rows: rows.map((row) => [
        row.campaign,
        row.source,
        row.medium,
        row.content,
        row.sessions,
        row.engagedSessions,
        row.keyEvents,
        row.revenue,
      ]),
    })),
  });
}

export async function seedGoogleAdsSlices(input: {
  linkId: string;
  projectId: string;
  days: readonly { day: string; rows: readonly GoogleAdsCampaignRow[] }[];
}): Promise<void> {
  await seedDaySlices({
    linkId: input.linkId,
    projectId: input.projectId,
    reportKey: GOOGLE_ADS_REPORT_KEY,
    dimensionHeaders: GOOGLE_ADS_DIMENSIONS,
    metricHeaders: GOOGLE_ADS_METRICS,
    days: input.days.map(({ day, rows }) => ({
      day,
      rows: rows.map((row) => [
        row.campaign,
        row.cost,
        row.clicks,
        row.sessions,
        row.keyEvents,
        row.revenue,
      ]),
    })),
  });
}

type SeedMetaDay = {
  day: string;
  spendMinor: number;
  linkClicks: number;
  landingPageViews?: number;
  results?: number | null;
  resultActionType?: string | null;
};

// Her çağrı yeni bir reklam hesabı kurur ve projeye seçili bağlar; ikinci bir
// çağrı projeye ikinci hesabı ekler. Kampanya satırlarının içgörüsü reklamların
// toplamıdır.
export async function seedMetaAds(input: {
  workspaceId: string;
  projectId: string;
  brandId: string;
  campaignExternalId: string;
  name: string;
  currency?: string;
  ads: readonly {
    adExternalId: string;
    createdByAgentelse?: boolean;
    adSetDestinationType?: string | null;
    days: readonly SeedMetaDay[];
  }[];
}): Promise<{ adsAccountId: string }> {
  const account = await prisma.adsAccount.create({
    data: {
      workspaceId: input.workspaceId,
      externalId: `act_${Math.floor(Math.random() * 1e12)}`,
      name: "Test account",
      currency: input.currency ?? "EUR",
      timezoneName: "Europe/Istanbul",
    },
  });
  await prisma.adsAccountProject.create({
    data: {
      adsAccountId: account.id,
      projectId: input.projectId,
      brandId: input.brandId,
      selected: true,
    },
  });
  await prisma.adsObject.create({
    data: {
      adsAccountId: account.id,
      projectId: input.projectId,
      level: "CAMPAIGN",
      externalId: input.campaignExternalId,
      campaignExternalId: input.campaignExternalId,
      name: input.name,
      createdByAgentelse: input.ads.some((ad) => ad.createdByAgentelse ?? true),
    },
  });
  for (const ad of input.ads) {
    const adSetId = `${ad.adExternalId}_set`;
    await prisma.adsObject.create({
      data: {
        adsAccountId: account.id,
        projectId: input.projectId,
        level: "ADSET",
        externalId: adSetId,
        parentExternalId: input.campaignExternalId,
        campaignExternalId: input.campaignExternalId,
        name: `Ad set ${ad.adExternalId}`,
        destinationType: ad.adSetDestinationType ?? "WEBSITE",
        createdByAgentelse: ad.createdByAgentelse ?? true,
      },
    });
    await prisma.adsObject.create({
      data: {
        adsAccountId: account.id,
        projectId: input.projectId,
        level: "AD",
        externalId: ad.adExternalId,
        parentExternalId: adSetId,
        campaignExternalId: input.campaignExternalId,
        name: `Ad ${ad.adExternalId}`,
        createdByAgentelse: ad.createdByAgentelse ?? true,
      },
    });
  }

  const campaignDays = new Map<string, SeedMetaDay>();
  const insights = input.ads.flatMap((ad) =>
    ad.days.map((day) => {
      const sum = campaignDays.get(day.day);
      campaignDays.set(day.day, {
        day: day.day,
        spendMinor: (sum?.spendMinor ?? 0) + day.spendMinor,
        linkClicks: (sum?.linkClicks ?? 0) + day.linkClicks,
        landingPageViews:
          (sum?.landingPageViews ?? 0) + (day.landingPageViews ?? 0),
        results:
          day.results === undefined || day.results === null
            ? (sum?.results ?? null)
            : (sum?.results ?? 0) + day.results,
        resultActionType: day.resultActionType ?? sum?.resultActionType ?? null,
      });
      return {
        adsAccountId: account.id,
        projectId: input.projectId,
        level: "AD" as const,
        externalId: ad.adExternalId,
        date: dayKeyToDate(day.day),
        spendMinor: BigInt(day.spendMinor),
        linkClicks: day.linkClicks,
        landingPageViews: day.landingPageViews ?? 0,
        results: day.results ?? null,
        resultActionType: day.resultActionType ?? null,
        isFinal: true,
      };
    }),
  );
  await prisma.adsInsightDaily.createMany({ data: insights });
  await prisma.adsInsightDaily.createMany({
    data: [...campaignDays.values()].map((day) => ({
      adsAccountId: account.id,
      projectId: input.projectId,
      level: "CAMPAIGN" as const,
      externalId: input.campaignExternalId,
      date: dayKeyToDate(day.day),
      spendMinor: BigInt(day.spendMinor),
      linkClicks: day.linkClicks,
      landingPageViews: day.landingPageViews ?? 0,
      results: day.results ?? null,
      resultActionType: day.resultActionType ?? null,
      isFinal: true,
    })),
  });
  return { adsAccountId: account.id };
}

// Tohumu siler: etiketli linkler, lansmanlar, Meta aynası, GA bağı (dilimler
// ve günlük toplamlar cascade ile) ve kimlikleri.
export async function cleanupAttributionSeed(projectId: string): Promise<void> {
  await cleanupTrackedLinks(projectId);
  await prisma.adsLaunch.deleteMany({ where: { projectId } });
  const accounts = await prisma.adsAccountProject.findMany({
    where: { projectId },
    select: { adsAccountId: true },
  });
  const accountIds = accounts.map((account) => account.adsAccountId);
  if (accountIds.length > 0) {
    await prisma.adsInsightDaily.deleteMany({
      where: { adsAccountId: { in: accountIds } },
    });
    await prisma.adsObject.deleteMany({
      where: { adsAccountId: { in: accountIds } },
    });
    await prisma.adsAccountProject.deleteMany({
      where: { adsAccountId: { in: accountIds } },
    });
    await prisma.adsAccount.deleteMany({ where: { id: { in: accountIds } } });
  }
  await prisma.gaPropertyLink.deleteMany({ where: { projectId } });
  await prisma.integrationCredential.deleteMany({
    where: { projectId, provider: "google_analytics" },
  });
}
