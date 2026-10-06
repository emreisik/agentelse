import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import type { GscSiteLink } from "@prisma/client";

import {
  brandTermsHash,
  effectiveBrandTerms,
  parseBrandTermsConfig,
} from "@/lib/seo/brand-terms";
import {
  addDays,
  dateToDayKey,
  dayKeyToDate,
  dayRange,
  gscToday,
  monthEnd,
  shiftMonthsClamped,
  weekEndOf,
} from "@/lib/seo/dates";
import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { disconnectGoogleCredential } from "@/server/integrations/google-disconnect";
import { describeIntegration } from "@/test-support/integration-suite";

import { GscRetention } from "../retention";
import { deleteGscDataForProject, ensureGscLinkForProject } from "./links";
import { GscSync } from "./runner";

// Search Console ambarı gerçek Postgres'e karşı (yalnız CI ve yerel tek
// kullanımlık veritabanı; mock kipte Google'a hiç gidilmez): bağ tembel
// oluşur; günlük çekim kesin/taze günleri ayırır; geri doldurma 16 ayı,
// marka serisini, kırılımları ve haftalık/aylık özetleri yazar; sözlükler
// kişisel veriden arındırılır; boşluk kapanır; terim değişikliği marka
// serisini yeniden çeker; saklama arşiv ayarına uyar, eski bağları siler;
// "Delete stored data" ve Disconnect ambarı temizler.

describeIntegration("GSC warehouse sync (mock Google)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    sync: process.env.GSC_SYNC,
    mode: process.env.AGENTELSE_PROVIDER_MODE,
  };
  let fixture: AgencyFixture;
  let credentialId: string;

  async function primary(): Promise<GscSiteLink> {
    return prisma.gscSiteLink.findFirstOrThrow({
      where: { projectId: fixture.projectId, isPrimary: true },
    });
  }

  async function runUntil(
    done: (link: GscSiteLink) => boolean,
    rounds = 40,
    now: () => Date = () => new Date(),
  ): Promise<GscSiteLink> {
    for (let round = 0; round < rounds; round += 1) {
      await GscSync.runDue(3, now());
      const link = await primary();
      if (done(link)) return link;
    }
    return primary();
  }

  function expectedBrandHash(link: GscSiteLink): string {
    return brandTermsHash(
      effectiveBrandTerms(parseBrandTermsConfig(link.brandTerms)),
    );
  }

  beforeAll(async () => {
    process.env.GSC_SYNC = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    fixture = await createAgencyFixture(`gsc-${runId}`);
    const credential = await prisma.integrationCredential.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        provider: "google_search_console",
        accountLabel: "owner@example.com",
        encryptedSecret: "not-used-in-mock-mode",
        status: "ACTIVE",
        metadata: {
          searchConsoleSites: [
            { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
          ],
          selectedSearchConsoleSite: "sc-domain:example.com",
        },
      },
    });
    credentialId = credential.id;
    await ensureGscLinkForProject(fixture.projectId);
    await prisma.gscSiteLink.updateMany({
      where: { projectId: fixture.projectId },
      data: {
        brandTerms: {
          v: 1,
          auto: [],
          user: ["acme"],
          removed: [],
          updatedAt: null,
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    process.env.GSC_SYNC = saved.sync;
    process.env.AGENTELSE_PROVIDER_MODE = saved.mode;
    await prisma.gscSiteLink.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await prisma.integrationCredential.deleteMany({
      where: { workspaceId: fixture?.workspaceId },
    });
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("syncs the daily window, the 16-month history, the brand series and the summaries", async () => {
    const link = await runUntil((candidate) => !!candidate.backfillDoneAt);
    const today = gscToday(new Date());
    expect(link).toMatchObject({
      siteUrl: "sc-domain:example.com",
      isPrimary: true,
      isMock: true,
      propertyType: "DOMAIN",
      permissionLevel: "siteOwner",
      health: "OK",
    });
    expect(link.backfillDoneAt).not.toBeNull();
    expect(link.lastFinalDate).toBe(addDays(today, -3));

    // Kesin günler fresh=false, son iki gün taze.
    const recent = await prisma.gscDailyTotal.findMany({
      where: {
        linkId: link.id,
        searchType: "web",
        date: { gte: dayKeyToDate(addDays(today, -5)) },
      },
      orderBy: { date: "asc" },
      select: { date: true, fresh: true },
    });
    expect(recent.map((row) => [dateToDayKey(row.date), row.fresh])).toEqual([
      [addDays(today, -5), false],
      [addDays(today, -4), false],
      [addDays(today, -3), false],
      [addDays(today, -2), true],
      [addDays(today, -1), true],
    ]);

    const web = await prisma.gscDailyTotal.count({
      where: { linkId: link.id, searchType: "web" },
    });
    expect(web).toBeGreaterThan(400);
    expect(
      await prisma.gscDailyTotal.count({
        where: { linkId: link.id, date: { lt: dayKeyToDate("2025-01-01") } },
      }),
    ).toBe(0);

    const types = link.searchTypes as { empty?: string[] } | null;
    expect(types?.empty).toEqual(
      expect.arrayContaining(["news", "discover", "googleNews"]),
    );

    // Marka serisi: bütün kesin web günlerinde dolu, toplamdan küçük.
    expect(link.brandSeriesHash).toBe(expectedBrandHash(link));
    expect(
      await prisma.gscDailyTotal.count({
        where: {
          linkId: link.id,
          searchType: "web",
          fresh: false,
          brandClicks: null,
        },
      }),
    ).toBe(0);
    const sample = await prisma.gscDailyTotal.findFirstOrThrow({
      where: {
        linkId: link.id,
        searchType: "web",
        fresh: false,
        clicks: { gt: 0 },
      },
      orderBy: { date: "desc" },
    });
    expect(sample.brandClicks).not.toBeNull();
    expect(sample.brandClicks!).toBeLessThan(sample.clicks);

    // Sözlükler kişisel veriden arındırılmış.
    const queries = await prisma.gscQuery.findMany({
      where: { linkId: link.id },
      select: { text: true },
    });
    const texts = queries.map((query) => query.text);
    expect(texts.some((text) => text.includes("@"))).toBe(false);
    expect(texts.some((text) => text.includes("[email]"))).toBe(true);
    expect(texts.some((text) => text.includes("[phone]"))).toBe(true);
    const pages = await prisma.gscPage.findMany({
      where: { linkId: link.id },
      select: { url: true },
    });
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.some((page) => page.url.includes("?"))).toBe(false);

    const weeks = await prisma.gscWeeklyQuery.groupBy({
      by: ["weekStart"],
      where: { linkId: link.id },
    });
    expect(weeks.length).toBeGreaterThanOrEqual(10);
    const months = await prisma.gscMonthlyQuery.groupBy({
      by: ["month"],
      where: { linkId: link.id },
    });
    expect(months.length).toBeGreaterThanOrEqual(10);

    // Anonim pay: sorgu satırlarının toplamı günlük toplamdan küçük.
    const fetch = await prisma.gscPeriodFetch.findFirstOrThrow({
      where: { linkId: link.id, grain: "WEEK", key: "query" },
      orderBy: { periodStart: "desc" },
    });
    const week = dateToDayKey(fetch.periodStart);
    const daily = await prisma.gscDailyTotal.aggregate({
      where: {
        linkId: link.id,
        searchType: "web",
        date: {
          gte: dayKeyToDate(week),
          lte: dayKeyToDate(weekEndOf(week)),
        },
      },
      _sum: { clicks: true },
    });
    expect(fetch.rowClicks).toBeGreaterThan(0);
    expect(fetch.rowClicks).toBeLessThan(daily._sum.clicks ?? 0);
  }, 600_000);

  it("closes a gap after the link was offline", async () => {
    const before = await primary();
    const today = gscToday(new Date());
    const offlineFrom = addDays(before.lastFinalDate!, -40);
    await prisma.gscDailyTotal.deleteMany({
      where: {
        linkId: before.id,
        searchType: "web",
        date: {
          gt: dayKeyToDate(offlineFrom),
          lte: dayKeyToDate(addDays(today, -11)),
        },
      },
    });
    await prisma.gscSiteLink.update({
      where: { id: before.id },
      data: {
        lastFinalDate: offlineFrom,
        lastDailyAt: null,
        lastDailySlot: null,
      },
    });
    const link = await runUntil((candidate) => {
      const state = candidate.backfill as { gaps?: unknown[] } | null;
      return candidate.lastDailyAt !== null && (state?.gaps?.length ?? 0) === 0;
    });
    const expected = dayRange(addDays(offlineFrom, 1), addDays(today, -1));
    const present = await prisma.gscDailyTotal.count({
      where: {
        linkId: link.id,
        searchType: "web",
        date: {
          gte: dayKeyToDate(expected[0]!),
          lte: dayKeyToDate(expected[expected.length - 1]!),
        },
      },
    });
    expect(present).toBe(expected.length);
  }, 300_000);

  it("refetches the brand series when the brand terms change", async () => {
    const before = await primary();
    const config = parseBrandTermsConfig(before.brandTerms);
    await prisma.gscSiteLink.update({
      where: { id: before.id },
      data: {
        brandTerms: { ...config, user: ["acme", "widget"] },
        brandClassifiedHash: null,
      },
    });
    const link = await runUntil(
      (candidate) => candidate.brandSeriesHash === expectedBrandHash(candidate),
    );
    expect(link.brandSeriesHash).toBe(expectedBrandHash(link));
    expect(link.brandSeriesHash).not.toBe(before.brandSeriesHash);
    const state = link.backfill as { brandHash?: string } | null;
    expect(state?.brandHash).toBe(link.brandSeriesHash);
  }, 300_000);

  it("re-fetches the daily window on Refresh without adding copies", async () => {
    const link = await primary();
    const before = await prisma.gscDailyTotal.count({
      where: { linkId: link.id },
    });
    const refreshed = await GscSync.refreshNow(
      fixture.projectId,
      new Date(Date.now() + 10 * 60_000),
    );
    expect(refreshed).toBe("refreshed");
    expect(
      await prisma.gscDailyTotal.count({ where: { linkId: link.id } }),
    ).toBe(before);
  }, 60_000);

  it("keeps archived rows, rolls up old slices and deletes stale demoted links", async () => {
    const link = await primary();
    const today = gscToday(new Date());
    const twoYears = shiftMonthsClamped(today, -24);
    const oldMonth = `${twoYears.slice(0, 7)}-01`;
    await prisma.gscDailyTotal.create({
      data: {
        linkId: link.id,
        projectId: link.projectId,
        date: dayKeyToDate(twoYears),
        searchType: "web",
        clicks: 5,
        impressions: 50,
        positionWeighted: 100,
        fetchedAt: new Date(),
      },
    });
    for (const day of [oldMonth, addDays(oldMonth, 1), monthEnd(oldMonth)]) {
      await prisma.gscDailySlice.create({
        data: {
          linkId: link.id,
          projectId: link.projectId,
          kind: "country",
          date: dayKeyToDate(day),
          rows: [
            ["tur", 2, 20, 40],
            ["usa", 1, 10, 30],
          ],
          rowCount: 2,
          fetchedAt: new Date(),
        },
      });
    }
    const demoted = (daysAgo: number, siteUrl: string) =>
      prisma.gscSiteLink.create({
        data: {
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          credentialId,
          siteUrl,
          isPrimary: false,
          isMock: true,
          demotedAt: new Date(Date.now() - daysAgo * 86_400_000),
        },
      });
    const stale = await demoted(31, "https://old.example.com/");
    const recent = await demoted(1, "https://recent.example.com/");
    // Kota yazımı updatedAt'i ilerletir; silme demotedAt'e bakar.
    await prisma.gscSiteLink.update({
      where: { id: recent.id },
      data: { rateLimitedUntil: new Date(Date.now() + 60_000) },
    });

    await prisma.systemHeartbeat.deleteMany({
      where: { key: "gsc.retention" },
    });
    await GscRetention.runDue(new Date());

    expect(
      await prisma.gscDailyTotal.count({
        where: { linkId: link.id, date: dayKeyToDate(twoYears) },
      }),
    ).toBe(1);
    expect(
      await prisma.gscDailySlice.count({
        where: {
          linkId: link.id,
          kind: "country",
          date: { lt: dayKeyToDate(addDays(oldMonth, 40)) },
        },
      }),
    ).toBe(0);
    const rolled = await prisma.gscDailySlice.findUniqueOrThrow({
      where: {
        linkId_kind_date: {
          linkId: link.id,
          kind: "country_month",
          date: dayKeyToDate(oldMonth),
        },
      },
    });
    expect(rolled.rows).toEqual([
      ["tur", 6, 60, 120],
      ["usa", 3, 30, 90],
    ]);
    expect(
      await prisma.gscSiteLink.findUnique({ where: { id: stale.id } }),
    ).toBeNull();
    expect(
      await prisma.gscSiteLink.findUnique({ where: { id: recent.id } }),
    ).not.toBeNull();
    expect((await primary()).id).toBe(link.id);
  }, 120_000);

  it("prunes everything older than 16 months when the archive is off", async () => {
    const link = await primary();
    const twoYears = shiftMonthsClamped(gscToday(new Date()), -24);
    const old = await prisma.gscQuery.create({
      data: {
        linkId: link.id,
        projectId: link.projectId,
        text: "old only query",
        textHash: `old-${runId}`,
        firstSeenWeek: dayKeyToDate(twoYears),
        lastSeenWeek: dayKeyToDate(twoYears),
      },
    });
    await prisma.gscSiteLink.update({
      where: { id: link.id },
      data: { archive: false },
    });
    const deleted = await GscRetention.pruneLink(link.id);
    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(
      await prisma.gscDailyTotal.count({
        where: { linkId: link.id, date: dayKeyToDate(twoYears) },
      }),
    ).toBe(0);
    expect(
      await prisma.gscQuery.findUnique({ where: { id: old.id } }),
    ).toBeNull();
    expect(
      await prisma.gscDailyTotal.count({ where: { linkId: link.id } }),
    ).toBeGreaterThan(400);
  }, 60_000);

  it("deletes the stored data and recreates the link with the same settings", async () => {
    const before = await primary();
    const result = await deleteGscDataForProject(fixture.projectId);
    expect(result.deletedLinks).toBeGreaterThanOrEqual(1);
    const link = await primary();
    expect(link.id).not.toBe(before.id);
    expect(link.archive).toBe(false);
    expect(parseBrandTermsConfig(link.brandTerms).user).toEqual([
      "acme",
      "widget",
    ]);
    expect(
      await prisma.gscDailyTotal.count({
        where: { projectId: fixture.projectId },
      }),
    ).toBe(0);
  }, 60_000);

  it("deletes the warehouse right away on Disconnect", async () => {
    await GscSync.runDue(3, new Date());
    expect(
      await prisma.gscDailyTotal.count({
        where: { projectId: fixture.projectId },
      }),
    ).toBeGreaterThan(0);
    const credential = await prisma.integrationCredential.findUniqueOrThrow({
      where: { id: credentialId },
    });
    await disconnectGoogleCredential({ ...credential, metadata: {} });
    for (const count of await Promise.all([
      prisma.gscSiteLink.count({ where: { projectId: fixture.projectId } }),
      prisma.gscDailyTotal.count({ where: { projectId: fixture.projectId } }),
      prisma.gscQuery.count({ where: { projectId: fixture.projectId } }),
      prisma.gscWeeklyQuery.count({ where: { projectId: fixture.projectId } }),
    ])) {
      expect(count).toBe(0);
    }
  }, 120_000);
});
