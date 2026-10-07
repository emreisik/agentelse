import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import type { CampaignSliceRow } from "@/lib/website-analytics/attribution/types";
import { addDays } from "@/lib/website-analytics/days";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { seedTrackedLink } from "@/server/tracked-links/test-support";
import { describeIntegration } from "@/test-support/integration-suite";

import {
  createGaCampaignEvidenceReader,
  getGaOutcomesForCampaign,
} from "./outcomes";
import {
  cleanupAttributionSeed,
  seedAttributionGaLink,
  seedCampaignSlices,
  seedMetaAds,
} from "./test-support";

// GA-F6 sonuç API'si ve optimizer kanıt okuyucusu gerçek Postgres'e karşı:
// kampanyanın sonuçları agx kodlu satırlardan ve eski {{ad.id}} satırından
// gelir; bilinmeyen kampanya, mock bağ ve kapalı bayrak null döner (kapalıyken
// sorgu yok). Okuyucu oluşturulurken sorgu yapmaz, tekrar çağrıda yeni dilim
// sorgusu yapmaz ve paylaşılan reklam hesabında başka projenin sayısını
// vermez.

const THROUGH = "2026-10-05";
const NOW = new Date("2026-10-07T00:00:00Z");
const RANGE = { from: addDays(THROUGH, -6), to: THROUGH };

describeIntegration("GA outcomes read API (GA-F6)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = { utm: process.env.GA_UTM, sync: process.env.GA_SYNC };
  let main: AgencyFixture;
  let mock: AgencyFixture;
  let other: AgencyFixture;
  const campaignA = `cmp-a-${runId}`;
  const campaignB = `cmp-b-${runId}`;
  // Eski {{ad.id}} reklamı: yalnız rakamlardan oluşan, ≥ 6 haneli kimlik.
  const legacyAd = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

  function restore(name: string, value: string | undefined) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  function coded(code: string): CampaignSliceRow {
    return {
      campaign: "agx-spring-sale",
      source: "facebook",
      medium: "paid_social",
      content: `agx_${code}`,
      sessions: 40,
      engagedSessions: 24,
      keyEvents: 4,
      revenue: 0,
    };
  }

  const legacy: CampaignSliceRow = {
    campaign: "spring_legacy",
    source: "facebook",
    medium: "paid_social",
    content: legacyAd,
    sessions: 10,
    engagedSessions: 6,
    keyEvents: 1,
    revenue: 0,
  };

  async function seedProject(
    fixture: AgencyFixture,
    options: {
      code: string;
      campaignExternalId: string;
      isMock?: boolean;
      withLegacy?: boolean;
    },
  ): Promise<{ linkId: string }> {
    const seeded = await seedAttributionGaLink({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      through: THROUGH,
      days: 30,
      isMock: options.isMock,
    });
    await seedTrackedLink({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      entityType: "meta_ad",
      entityId: `cmd-${options.code}:0`,
      channel: "meta_ads",
      code: options.code,
      utmCampaign: "agx-spring-sale",
      label: "Spring Sale",
      campaignExternalId: options.campaignExternalId,
      adExternalId: `ad-${options.code}`,
    });
    await seedCampaignSlices({
      linkId: seeded.linkId,
      projectId: fixture.projectId,
      days: Array.from({ length: 14 }, (_, index) => ({
        day: addDays(THROUGH, index - 13),
        rows: [
          coded(options.code),
          ...(options.withLegacy ? [legacy] : []),
        ],
      })),
    });
    return { linkId: seeded.linkId };
  }

  beforeAll(async () => {
    process.env.GA_UTM = "true";
    process.env.GA_SYNC = "true";
    main = await createAgencyFixture(`ga-out-${runId}`);
    mock = await createAgencyFixture(`ga-out-m-${runId}`);
    other = await createAgencyFixture(`ga-out-o-${runId}`);

    await seedProject(main, {
      code: `a${runId.slice(0, 5)}`,
      campaignExternalId: campaignA,
      withLegacy: true,
    });
    // Eski reklam Agentelse'in kurduğu bir AD olarak aynada durmalı.
    const meta = await seedMetaAds({
      workspaceId: main.workspaceId,
      projectId: main.projectId,
      brandId: main.brandId,
      campaignExternalId: campaignA,
      name: "Spring Sale",
      ads: [
        {
          adExternalId: legacyAd,
          days: [{ day: THROUGH, spendMinor: 1000, linkClicks: 50 }],
        },
      ],
    });
    await seedProject(mock, {
      code: `m${runId.slice(0, 5)}`,
      campaignExternalId: campaignA,
      isMock: true,
    });
    await seedProject(other, {
      code: `b${runId.slice(0, 5)}`,
      campaignExternalId: campaignB,
    });
    // Aynı reklam hesabı ikinci projeye de bağlı.
    await prisma.adsAccountProject.create({
      data: {
        adsAccountId: meta.adsAccountId,
        projectId: other.projectId,
        brandId: other.brandId,
        selected: true,
      },
    });
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.GA_UTM = "true";
  });

  afterAll(async () => {
    restore("GA_UTM", saved.utm);
    restore("GA_SYNC", saved.sync);
    for (const fixture of [other, mock, main]) {
      if (!fixture) continue;
      await cleanupAttributionSeed(fixture.projectId);
      await teardownAgencyFixture(fixture.workspaceId);
    }
  });

  it("returns the campaign's sessions and key events from coded and legacy rows", async () => {
    const result = await getGaOutcomesForCampaign(
      main.projectId,
      campaignA,
      RANGE,
    );
    // 7 gün × (40 kodlu + 10 eski oturum), (4 + 1) key event.
    expect(result).toMatchObject({
      source: "GA4",
      campaignExternalId: campaignA,
      range: RANGE,
      currency: "EUR",
      sessions: 350,
      engagedSessions: 210,
      keyEvents: 35,
      revenue: 0,
      trackedLinks: 2,
      days: 7,
      coveredDays: 7,
    });
  });

  it("returns null for an unknown campaign and for a mock link", async () => {
    expect(
      await getGaOutcomesForCampaign(main.projectId, "cmp-unknown", RANGE),
    ).toBeNull();
    expect(
      await getGaOutcomesForCampaign(mock.projectId, campaignA, RANGE),
    ).toBeNull();
  });

  // "Bayrak kapalıyken sorgu yok" sözü outcomes.test.ts'te (Prisma temsilcileri
  // casusla sarılınca geri dönmez, o yüzden burada yalnız sonuç denetlenir).
  it("returns null when the flag is off, even with data", async () => {
    process.env.GA_UTM = "false";
    expect(
      await getGaOutcomesForCampaign(main.projectId, campaignA, RANGE),
    ).toBeNull();
    expect(
      await createGaCampaignEvidenceReader({ now: NOW })(
        main.projectId,
        campaignA,
      ),
    ).toBeNull();
  });

  it("evidence reader: flat ga4_* primitives, memoized per campaign", async () => {
    const read = createGaCampaignEvidenceReader({ now: NOW });
    expect(await read(main.projectId, null)).toBeNull();

    const evidence = await read(main.projectId, campaignA);
    expect(evidence).toEqual({
      ga4_source: "GA4",
      ga4_from: RANGE.from,
      ga4_to: RANGE.to,
      ga4_sessions: 350,
      ga4_engaged_sessions: 210,
      ga4_key_events: 35,
      ga4_covered_days: 7,
    });
    for (const [key, value] of Object.entries(evidence ?? {})) {
      expect(key.startsWith("ga4_")).toBe(true);
      expect(key).not.toMatch(/offsite/i);
      expect(["string", "number"]).toContain(typeof value);
    }

    expect(await read(main.projectId, campaignA)).toEqual(evidence);
    expect(await read(main.projectId, "cmp-unknown")).toBeNull();
  });

  it("evidence reader: null for a mock link", async () => {
    const read = createGaCampaignEvidenceReader({ now: NOW });
    expect(await read(mock.projectId, campaignA)).toBeNull();
  });

  it("evidence reader: two projects on one shared ad account never mix", async () => {
    const read = createGaCampaignEvidenceReader({ now: NOW });
    // B projesi A'nın kampanya kimliğiyle çağrılırsa A'nın sayıları gelmez.
    expect(await read(other.projectId, campaignA)).toBeNull();
    expect((await read(main.projectId, campaignA))?.ga4_sessions).toBe(350);
    expect((await read(other.projectId, campaignB))?.ga4_sessions).toBe(280);
  });
});
