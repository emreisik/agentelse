import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import type { GaRange } from "@/lib/website-analytics/analysis/types";
import { addDays } from "@/lib/website-analytics/days";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { seedTrackedLink } from "@/server/tracked-links/test-support";
import { describeIntegration } from "@/test-support/integration-suite";

import { loadAdsCrossCheckInput, loadWebsiteAttribution } from "./read";
import {
  cleanupAttributionSeed,
  seedAttributionGaLink,
  seedCampaignSlices,
  seedGoogleAdsSlices,
  seedMetaAds,
} from "./test-support";

// GA-F6 atıf okuması gerçek Postgres'e karşı (Google'a ve Meta'ya hiç
// gidilmez): Agentelse'in etiketli linkleri GA kampanya dilimlerine, Meta
// AD düzeyi aynasıyla aynı reklamlar üzerinden bağlanır. Meta tarafı
// Agentelse'in kurmadığı reklamı saymaz, ikinci reklam hesabını sayar;
// bayraklar kapalıyken sorgu yoktur; şüpheli günler iki tarafta da düşer.

const RANGE: GaRange = { from: "2026-09-07", to: "2026-10-04" };
const PREVIOUS: GaRange = { from: "2026-08-10", to: "2026-09-06" };
const DAYS = 28;

function daysOf(range: GaRange): string[] {
  return Array.from({ length: DAYS }, (_, index) => addDays(range.from, index));
}

describeIntegration("GA attribution read (GA-F6)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    utm: process.env.GA_UTM,
    sync: process.env.GA_SYNC,
    weekly: process.env.GA_WEEKLY,
  };
  let fixture: AgencyFixture;
  let linkId: string;
  const campaignId = `camp-${runId}`;
  const legacyCampaignId = `legacy-${runId}`;
  const adA = `ad-a-${runId}`;
  const adB = `ad-b-${runId}`;
  const adOther = `ad-x-${runId}`;
  // Eski {{ad.id}} reklamı: yalnız rakamlardan oluşan, ≥ 6 haneli kimlik.
  const legacyAd = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
  const commandId = `cmd-${runId}`;

  function restore(name: string, value: string | undefined) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  beforeAll(async () => {
    process.env.GA_UTM = "true";
    process.env.GA_SYNC = "true";
    delete process.env.GA_WEEKLY;
    fixture = await createAgencyFixture(`ga-attr-${runId}`);
    const ids = {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
    };
    const seeded = await seedAttributionGaLink({
      ...ids,
      through: RANGE.to,
      days: 60,
    });
    linkId = seeded.linkId;

    // Meta reklam linkleri AdsLaunch üzerinden tembel çözülür.
    await prisma.adsLaunch.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        commandId,
        launchKey: "k1",
        adAccountExternalId: "act_1",
        spec: {},
        specHash: "x",
        campaignExternalId: campaignId,
        progress: { ads: { "0": adA, "1": adB } },
      },
    });
    for (const [index, code] of ["aaaaaa", "bbbbbb"].entries()) {
      await seedTrackedLink({
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        entityType: "meta_ad",
        entityId: `${commandId}:${index}`,
        channel: "meta_ads",
        code,
        utmCampaign: "agx-spring",
        label: "Spring sale",
      });
    }
    await seedTrackedLink({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      entityType: "instagram_bio",
      entityId: "bio",
      channel: "instagram",
      code: "cccccc",
      utmCampaign: "agx-bio",
    });

    // GA campaign dilimleri: her gün aynı satırlar.
    const row = (
      campaign: string,
      source: string,
      medium: string,
      content: string,
      sessions: number,
      engagedSessions: number,
      keyEvents: number,
      revenue: number,
    ) => ({
      campaign,
      source,
      medium,
      content,
      sessions,
      engagedSessions,
      keyEvents,
      revenue,
    });
    const campaignRows = [
      row("agx-spring", "facebook", "paid_social", "agx_aaaaaa", 10, 6, 1, 5),
      row("agx-spring", "facebook", "paid_social", "agx_bbbbbb", 20, 12, 2, 10),
      row("agx-spring", "facebook", "paid_social", "(not set)", 4, 2, 0, 0),
      row("agx-bio", "instagram", "social", "agx_cccccc", 5, 3, 0, 0),
      row("spring-old", "meta", "paid_social", legacyAd, 3, 2, 0, 0),
      row("summer", "newsletter", "email", "(not set)", 50, 30, 3, 0),
    ];
    await seedCampaignSlices({
      linkId,
      projectId: fixture.projectId,
      days: daysOf(RANGE).map((day) => ({ day, rows: campaignRows })),
    });

    // Meta: ilk hesapta iki reklam (biri Agentelse'in kurmadığı, 1000 tık),
    // ikinci hesapta ikinci kodlu reklam, üçüncüde eski reklam.
    const offsite = "offsite_conversion.fb_pixel_lead";
    await seedMetaAds({
      ...ids,
      campaignExternalId: campaignId,
      name: "Spring sale [agx:abc123]",
      ads: [
        {
          adExternalId: adA,
          days: daysOf(RANGE).map((day) => ({
            day,
            spendMinor: 1000,
            linkClicks: 20,
            landingPageViews: 15,
            results: 2,
            resultActionType: offsite,
          })),
        },
        {
          adExternalId: adOther,
          createdByAgentelse: false,
          days: [{ day: "2026-09-10", spendMinor: 5000, linkClicks: 1000 }],
        },
      ],
    });
    await seedMetaAds({
      ...ids,
      campaignExternalId: campaignId,
      name: "Spring sale [agx:abc123]",
      ads: [
        {
          adExternalId: adB,
          days: daysOf(RANGE).map((day) => ({
            day,
            spendMinor: 2000,
            linkClicks: 40,
            landingPageViews: 30,
            results: 4,
            resultActionType: offsite,
          })),
        },
      ],
    });
    await seedMetaAds({
      ...ids,
      campaignExternalId: legacyCampaignId,
      name: "Old campaign [agx:def456]",
      ads: [
        {
          adExternalId: legacyAd,
          days: daysOf(RANGE).map((day) => ({
            day,
            spendMinor: 500,
            linkClicks: 10,
          })),
        },
      ],
    });

    // Google Ads: önceki ve şimdiki 28 gün.
    await seedGoogleAdsSlices({
      linkId,
      projectId: fixture.projectId,
      days: [...daysOf(PREVIOUS), ...daysOf(RANGE)].map((day) => ({
        day,
        rows: [
          day >= RANGE.from
            ? { campaign: "Brand", cost: 10, clicks: 50, sessions: 40, keyEvents: 2, revenue: 30 }
            : { campaign: "Brand", cost: 20, clicks: 50, sessions: 40, keyEvents: 1, revenue: 20 },
        ],
      })),
    });
  });

  afterAll(async () => {
    restore("GA_UTM", saved.utm);
    restore("GA_SYNC", saved.sync);
    restore("GA_WEEKLY", saved.weekly);
    await cleanupAttributionSeed(fixture.projectId);
    await teardownAgencyFixture(fixture.workspaceId);
  });

  it("shows From Agentelse rows with the right sessions per entity and the site share", async () => {
    const view = await loadWebsiteAttribution(fixture.projectId, RANGE);
    const from = view?.from;
    expect(from).toBeTruthy();
    expect(from?.trackedLinks).toBe(3);
    expect(from?.days).toBe(DAYS);
    expect(from?.coveredDays).toBe(DAYS);
    expect(from?.currency).toBe("EUR");
    // (10 + 20 + 4 + 5 + 3) × 28; kampanya dışı ve etiketsiz satırlar girmez.
    expect(from?.total.sessions).toBe(42 * DAYS);
    expect(from?.sitePct).toBe(42);
    expect(from?.rows.map((r) => [r.label, r.sessions])).toEqual([
      ["Spring sale", 34 * DAYS],
      ["Instagram bio link", 5 * DAYS],
      ["Old campaign", 3 * DAYS],
    ]);
    expect(from?.rows[0]?.kindLabel).toBe("Meta ads");
    expect(from?.rows[1]?.engagementRate).toBe(60);
    expect(from?.other).toBeNull();
  });

  it("compares Meta and GA for exactly the coded ads", async () => {
    const view = await loadWebsiteAttribution(fixture.projectId, RANGE);
    const meta = view?.ads?.meta;
    expect(meta?.synced).toBe(true);
    expect(meta?.currency).toBe("EUR");
    const row = meta?.rows.find((r) => r.campaignExternalId === campaignId);
    expect(row).toMatchObject({
      tracked: true,
      label: "Spring sale",
      // (10 + 20) × 28 EUR; Agentelse'in kurmadığı reklamın 50 EUR'u girmez.
      spend: 30 * DAYS,
      linkClicks: 60 * DAYS,
      sessions: 30 * DAYS,
      clickToSessionPct: 50,
      keyEvents: 3 * DAYS,
      results: 6 * DAYS,
      websiteResults: true,
      costPerKeyEvent: 10,
      costPerResult: 5,
    });
    expect(row?.flags).toEqual(["click_loss", "results_gap"]);
    expect(
      meta?.rows.find((r) => r.campaignExternalId === legacyCampaignId),
    ).toMatchObject({ tracked: true, sessions: 3 * DAYS, linkClicks: 10 * DAYS });
    expect(meta?.notes).toContain(
      "Only ads Agentelse created and tagged are compared; other ads in the same campaign are left out on both sides.",
    );
  });

  it("shows Google Ads rows with ROAS and the previous period", async () => {
    const view = await loadWebsiteAttribution(fixture.projectId, RANGE);
    const googleAds = view?.ads?.googleAds;
    expect(googleAds?.currency).toBe("EUR");
    expect(googleAds?.rows).toHaveLength(1);
    expect(googleAds?.rows[0]).toMatchObject({
      campaign: "Brand",
      cost: 10 * DAYS,
      keyEvents: 2 * DAYS,
      revenue: 30 * DAYS,
      roas: 3,
      costPerKeyEvent: 5,
      previousRoas: 1,
      previousCostPerKeyEvent: 20,
    });
  });

  it("returns null and touches no table when the flags are off", async () => {
    const spy = vi.spyOn(prisma.gaPropertyLink, "findFirst");
    try {
      delete process.env.GA_UTM;
      expect(await loadWebsiteAttribution(fixture.projectId, RANGE)).toBeNull();
      process.env.GA_UTM = "true";
      delete process.env.GA_SYNC;
      expect(await loadWebsiteAttribution(fixture.projectId, RANGE)).toBeNull();
      expect(
        await loadAdsCrossCheckInput({
          link: { id: linkId, projectId: fixture.projectId, currencyCode: "EUR" },
          window: RANGE,
          previousWindow: PREVIOUS,
          exclude: new Set(),
        }),
      ).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      process.env.GA_UTM = "true";
      process.env.GA_SYNC = "true";
    }
  });

  it("drops a suspect day on both the GA and the Meta side in the cross-check input", async () => {
    const input = await loadAdsCrossCheckInput({
      link: { id: linkId, projectId: fixture.projectId, currencyCode: "EUR" },
      window: RANGE,
      previousWindow: PREVIOUS,
      exclude: new Set(["2026-09-20"]),
    });
    const kept = DAYS - 1;
    const campaign = input?.campaigns.find(
      (c) => c.campaignExternalId === campaignId,
    );
    expect(input?.metaCurrency).toBe("EUR");
    expect(campaign?.ga.sessions).toBe(30 * kept);
    expect(campaign?.meta).toMatchObject({
      ads: 2,
      spend: 30 * kept,
      linkClicks: 60 * kept,
      activeDays: kept,
    });
    expect(campaign?.label).toBe("Spring sale");
    expect(input?.googleAds?.current[0]?.cost).toBe(10 * kept);
    expect(input?.googleAds?.previous[0]?.cost).toBe(20 * DAYS);
  });

  it("leaves googleAds out when a window has fewer than 21 clean days", async () => {
    const exclude = new Set(daysOf(RANGE).slice(0, 8));
    const input = await loadAdsCrossCheckInput({
      link: { id: linkId, projectId: fixture.projectId, currencyCode: "EUR" },
      window: RANGE,
      previousWindow: PREVIOUS,
      exclude,
    });
    expect(input?.googleAds).toBeNull();
    expect(input?.campaigns.length).toBeGreaterThan(0);
  });
});
