import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { seedTrackedLink } from "@/server/tracked-links/test-support";
import {
  cleanupAttributionSeed,
  seedAttributionGaLink,
  seedCampaignSlices,
  seedMetaAds,
} from "@/server/website-analytics/attribution/test-support";
import { describeIntegration } from "@/test-support/integration-suite";

import { loadUtmCoverageCheck } from "./utm-coverage";

// MH25 gerçek Postgres'e karşı (Google'a ve Meta'ya hiç gidilmez): Agentelse'in
// açtığı site reklamlarının etiket kapsamı ve kodun GA campaign dilimlerinde
// görünmesi. Testler sırayla ilerler ve aynı tohumu adım adım değiştirir.
// Mesajlaşma hedefli reklam seti kapsama girmez; GA_UTM kapalıyken sorgu yok.

const THROUGH = "2026-10-06";
// Hesap günü (İstanbul) 8 Ekim: pencere 11 Eylül - 8 Ekim
const NOW = new Date("2026-10-08T12:00:00.000Z");
const CLICK_DAYS = ["2026-09-30", "2026-10-01", "2026-10-02"];
const CAMPAIGN_ID = "camp-mh25";
const CODES = ["aaa111", "bbb222", "ccc333", "ddd444"];

describeIntegration("MH25 UTM coverage", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    utm: process.env.GA_UTM,
    sync: process.env.GA_SYNC,
    dev: process.env.GA_SYNC_DEV_PROJECTS,
  };
  let fixture: AgencyFixture;
  let linkId = "";

  function restore(name: string, value: string | undefined) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  function adId(index: number): string {
    return `ad-${runId}-${index}`;
  }

  async function tag(index: number, utmContent?: string) {
    await seedTrackedLink({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      entityType: "meta_ad",
      entityId: `cmd-${runId}:${index}`,
      channel: "meta_ads",
      code: CODES[index]!,
      utmCampaign: "agx-test",
      campaignExternalId: CAMPAIGN_ID,
      adExternalId: adId(index),
      ...(utmContent ? { utmContent } : {}),
    });
  }

  beforeAll(async () => {
    process.env.GA_UTM = "true";
    process.env.GA_SYNC = "true";
    delete process.env.GA_SYNC_DEV_PROJECTS;
    fixture = await createAgencyFixture(`ga-mh25-${runId}`);
    const seeded = await seedAttributionGaLink({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      through: THROUGH,
      days: 28,
    });
    linkId = seeded.linkId;
    const days = CLICK_DAYS.map((day) => ({
      day,
      spendMinor: 500,
      linkClicks: 10,
    }));
    await seedMetaAds({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      campaignExternalId: CAMPAIGN_ID,
      name: "MH25 campaign",
      ads: [
        // 0-2 etiketli; 3 etiketsiz; 4 mesajlaşma hedefli (kapsam dışı)
        { adExternalId: adId(0), days },
        { adExternalId: adId(1), days },
        { adExternalId: adId(2), days },
        { adExternalId: adId(3), days },
        { adExternalId: adId(4), adSetDestinationType: "MESSENGER", days },
      ],
    });
    await tag(0);
    await tag(1);
    await tag(2);
  });

  afterAll(async () => {
    restore("GA_UTM", saved.utm);
    restore("GA_SYNC", saved.sync);
    restore("GA_SYNC_DEV_PROJECTS", saved.dev);
    await cleanupAttributionSeed(fixture.projectId);
    await teardownAgencyFixture(fixture.workspaceId);
  });

  it("flags an Agentelse ad without a tracked link as low coverage and skips messaging ads", async () => {
    const result = await loadUtmCoverageCheck(fixture.projectId, NOW);
    expect(result?.status).toBe("WARN");
    expect(result?.severity).toBe("INFO");
    expect(result?.evidence.reason).toBe("low_coverage");
    // 4 site reklamı (mesajlaşma hedefli olan sayılmaz), 3'ü etiketli
    expect(result?.evidence.ads).toBe(4);
    expect(result?.evidence.tagged).toBe(3);
    expect(result?.evidence.coveragePct).toBe(75);
  });

  it("does not count a link whose own utm_content won as tagged", async () => {
    await tag(3, "my-own-content");
    const result = await loadUtmCoverageCheck(fixture.projectId, NOW);
    expect(result?.evidence.reason).toBe("low_coverage");
    expect(result?.evidence.tagged).toBe(3);
    await prisma.trackedLink.deleteMany({
      where: { projectId: fixture.projectId, adExternalId: adId(3) },
    });
  });

  it("warns when tagged ads have clicks but their codes never reach the campaign slices", async () => {
    await tag(3);
    const result = await loadUtmCoverageCheck(fixture.projectId, NOW);
    expect(result?.evidence.coveragePct).toBe(100);
    expect(result?.status).toBe("WARN");
    expect(result?.evidence.reason).toBe("not_seen");
    expect(result?.evidence.unseen).toBe(4);
  });

  it("passes when the codes (or their agx campaign) appear in the campaign slices", async () => {
    // 0-2 kodla görülür; 3'ün kodu yok ama agx-test kampanyası görülür
    await seedCampaignSlices({
      linkId,
      projectId: fixture.projectId,
      days: [
        {
          day: "2026-10-03",
          rows: CODES.slice(0, 3).map((code) => ({
            campaign: "agx-test",
            source: "facebook",
            medium: "paid_social",
            content: `agx_${code}`,
            sessions: 5,
            engagedSessions: 3,
            keyEvents: 1,
            revenue: 0,
          })),
        },
      ],
    });
    const result = await loadUtmCoverageCheck(fixture.projectId, NOW);
    expect(result?.status).toBe("PASS");
    expect(result?.evidence.reason).toBe("ok");
    expect(result?.evidence.unseen).toBe(0);
  });

  it("returns null without any query when GA_UTM is off", async () => {
    const spy = vi.spyOn(prisma.gaPropertyLink, "findFirst");
    delete process.env.GA_UTM;
    try {
      expect(await loadUtmCoverageCheck(fixture.projectId, NOW)).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.env.GA_UTM = "true";
      spy.mockRestore();
    }
  });
});
