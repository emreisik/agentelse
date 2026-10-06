import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { brandTermsHash } from "@/lib/seo/brand-terms";
import {
  addDays,
  addWeeks,
  dayKeyToDate,
  dayRange,
  lastCompleteWeekStart,
} from "@/lib/seo/dates";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { brandContextForLink, saveBrandTerms } from "./brand-terms";
import {
  readQuickWinRows,
  readSearchConsoleTotals,
  readSearchConsoleWarehouse,
} from "./readers";
import { buildSearchReport } from "./report";

// Search Console ambarının okuma yanı gerçek Postgres'e karşı (yalnız CI ve
// yerel tek kullanımlık veritabanı): ambar doğrudan tohumlanır (senkron P2'nin
// testinde), Search raporu, Analytics/sohbet/hızlı kazanım okuyucuları ve
// marka terimlerinin yeniden sınıflandırması buradan doğrulanır.

const SITE = "sc-domain:acme-test.com";
const FINAL = "2026-10-01";
const DAYS = 120;
const WEEKS = 8;
const FRESH_DAYS = 2;

const QUERIES = [
  {
    text: "acme pricing",
    isBrand: true,
    clicks: 40,
    impressions: 200,
    position: 1.5,
  },
  {
    text: "acme login",
    isBrand: true,
    clicks: 30,
    impressions: 150,
    position: 1.2,
  },
  {
    text: "running shoes",
    isBrand: false,
    clicks: 25,
    impressions: 900,
    position: 9,
  },
  {
    text: "trail shoes",
    isBrand: false,
    clicks: 20,
    impressions: 700,
    position: 12,
  },
  {
    text: "best sneakers",
    isBrand: false,
    clicks: 10,
    impressions: 1200,
    position: 15,
  },
  {
    text: "shoe size chart",
    isBrand: false,
    clicks: 8,
    impressions: 600,
    position: 18,
  },
  {
    text: "marathon training",
    isBrand: false,
    clicks: 5,
    impressions: 500,
    position: 25,
  },
  {
    text: "pricing plans",
    isBrand: false,
    clicks: 3,
    impressions: 300,
    position: 11,
  },
];

const PAGES = [
  { url: "https://www.acme-test.com/shoes", path: "/shoes", clicks: 60 },
  { url: "https://blog.acme-test.com/guide", path: "/guide", clicks: 30 },
  { url: "https://www.acme-test.com/", path: "/", clicks: 20 },
];

function dayClicks(index: number): number {
  return 100 + (index % 7);
}

describeIntegration(
  "Search Console warehouse readers and Search report",
  () => {
    const runId = randomUUID().slice(0, 8);
    const saved = {
      sync: process.env.GSC_SYNC,
      mode: process.env.AGENTELSE_PROVIDER_MODE,
    };
    const lastWeek = lastCompleteWeekStart(FINAL);
    const weeks = Array.from({ length: WEEKS }, (_, i) =>
      addWeeks(lastWeek, -(WEEKS - 1 - i)),
    );
    const days = dayRange(addDays(FINAL, -(DAYS - 1)), FINAL);
    let fixture: AgencyFixture;
    let linkId: string;

    beforeAll(async () => {
      process.env.GSC_SYNC = "true";
      process.env.AGENTELSE_PROVIDER_MODE = "mock";
      fixture = await createAgencyFixture(`gsc-${runId}`);
      const brandHash = brandTermsHash(["acme"]);
      const link = await prisma.gscSiteLink.create({
        data: {
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          credentialId: `cred-${runId}`,
          siteUrl: SITE,
          isMock: true,
          propertyType: "DOMAIN",
          permissionLevel: "siteOwner",
          health: "OK",
          lastFinalDate: FINAL,
          lastWeeklyWeek: lastWeek,
          backfillDoneAt: new Date(),
          brandTerms: {
            v: 1,
            auto: [],
            user: ["acme"],
            removed: [],
            updatedAt: null,
          },
          brandSeriesHash: brandHash,
          brandClassifiedHash: brandHash,
        },
      });
      linkId = link.id;
      const base = { linkId, projectId: fixture.projectId };
      const fetchedAt = new Date();

      await prisma.gscDailyTotal.createMany({
        data: [
          ...days.map((day, index) => ({
            ...base,
            date: dayKeyToDate(day),
            searchType: "web",
            clicks: dayClicks(index),
            impressions: 1000,
            positionWeighted: 5000,
            brandClicks: 30,
            brandImpressions: 200,
            brandPositionWeighted: 400,
            fresh: false,
            fetchedAt,
          })),
          ...Array.from({ length: FRESH_DAYS }, (_, i) => ({
            ...base,
            date: dayKeyToDate(addDays(FINAL, i + 1)),
            searchType: "web",
            clicks: 50,
            impressions: 600,
            positionWeighted: 3000,
            fresh: true,
            fetchedAt,
          })),
        ],
      });

      const firstWeek = dayKeyToDate(weeks[0]!);
      const latestWeek = dayKeyToDate(lastWeek);
      const queries = await Promise.all(
        QUERIES.map((query, index) =>
          prisma.gscQuery.create({
            data: {
              ...base,
              text: query.text,
              textHash: `q${index}-${runId}`,
              isBrand: query.isBrand,
              firstSeenWeek: firstWeek,
              lastSeenWeek: latestWeek,
            },
          }),
        ),
      );
      const pages = await Promise.all(
        PAGES.map((page, index) =>
          prisma.gscPage.create({
            data: {
              ...base,
              url: page.url,
              urlHash: `p${index}-${runId}`,
              path: page.path,
              firstSeenWeek: firstWeek,
              lastSeenWeek: latestWeek,
            },
          }),
        ),
      );
      const queryClicks = QUERIES.reduce((sum, query) => sum + query.clicks, 0);
      const pageClicks = PAGES.reduce((sum, page) => sum + page.clicks, 0);
      for (const week of weeks) {
        const weekStart = dayKeyToDate(week);
        await prisma.gscWeeklyQuery.createMany({
          data: QUERIES.map((query, index) => ({
            ...base,
            weekStart,
            queryId: queries[index]!.id,
            clicks: query.clicks,
            impressions: query.impressions,
            positionWeighted: query.position * query.impressions,
          })),
        });
        await prisma.gscWeeklyPage.createMany({
          data: PAGES.map((page, index) => ({
            ...base,
            weekStart,
            pageId: pages[index]!.id,
            clicks: page.clicks,
            impressions: page.clicks * 20,
            positionWeighted: page.clicks * 20 * 4,
          })),
        });
        await prisma.gscPeriodFetch.createMany({
          data: [
            {
              ...base,
              grain: "WEEK",
              periodStart: weekStart,
              key: "query",
              rowCount: QUERIES.length,
              rowClicks: queryClicks,
              rowImpressions: 0,
              pages: 1,
              fetchedAt,
            },
            {
              ...base,
              grain: "WEEK",
              periodStart: weekStart,
              key: "page",
              rowCount: PAGES.length,
              rowClicks: pageClicks,
              rowImpressions: 0,
              pages: 1,
              fetchedAt,
            },
          ],
        });
      }
    }, 60_000);

    afterAll(async () => {
      process.env.GSC_SYNC = saved.sync;
      process.env.AGENTELSE_PROVIDER_MODE = saved.mode;
      await prisma.gscSiteLink.deleteMany({
        where: { projectId: fixture?.projectId },
      });
      await teardownAgencyFixture(fixture?.workspaceId);
    });

    it("builds the 28-day report from final days, with the brand split", async () => {
      const result = await buildSearchReport(fixture.projectId, "28d");
      expect(result.state).toBe("ready");
      if (result.state !== "ready") return;
      const { report } = result;
      expect(report.period.to).toBe(FINAL);
      expect(report.coverage).toEqual({ days: 28, expected: 28 });
      expect(report.link.brandSplit).toBe("ready");
      expect(report.kpis.map((kpi) => kpi.key)).toEqual([
        "nonBrandClicks",
        "brandClicks",
        "clicks",
        "impressions",
        "ctr",
        "position",
      ]);

      // KPI'lar taze günleri içermez.
      const expectedClicks = days
        .slice(DAYS - 28)
        .reduce((sum, _day, i) => sum + dayClicks(DAYS - 28 + i), 0);
      const total = report.kpis.find((kpi) => kpi.key === "clicks")!;
      expect(total.value).toBe(expectedClicks);
      expect(total.previous).not.toBeNull();
      expect(report.kpis[0]).toMatchObject({
        value: expectedClicks - 28 * 30,
        previous: expect.any(Number),
      });
      expect(report.kpis.find((kpi) => kpi.key === "position")).toMatchObject({
        value: 5,
        lowerIsBetter: true,
      });

      const fresh = report.trend.filter((point) => point.fresh);
      expect(fresh).toHaveLength(FRESH_DAYS);
      expect(fresh.every((point) => point.day > FINAL)).toBe(true);
      expect(report.trend.filter((point) => !point.fresh)).toHaveLength(28);
      expect(report.notes.some((note) => note.startsWith("Days after"))).toBe(
        true,
      );

      const acme = report.queries.rows.filter((row) =>
        row.label.includes("acme"),
      );
      expect(acme.length).toBe(2);
      expect(acme.every((row) => row.isBrand)).toBe(true);
      expect(report.queries.aggregation).toBe("By property");
      expect(report.pages.aggregation).toBe("By page");
      expect(report.pages.rows.map((row) => row.label)).toContain(
        "blog.acme-test.com/guide",
      );
      expect(report.pages.rows[0]).toMatchObject({
        label: "www.acme-test.com/shoes",
        href: "https://www.acme-test.com/shoes",
      });
      expect(report.anonymousShare).not.toBeNull();
      expect(report.anonymousShare!).toBeGreaterThan(0);
      expect(report.anonymousShare!).toBeLessThan(1);

      const nonBrand = await buildSearchReport(fixture.projectId, "28d", {
        queryFilter: "non-brand",
      });
      if (nonBrand.state !== "ready") throw new Error("not ready");
      expect(nonBrand.report.queryFilter).toBe("non-brand");
      expect(
        nonBrand.report.queries.rows.some((row) => row.label.includes("acme")),
      ).toBe(false);
      expect(nonBrand.report.queries.rows.length).toBe(QUERIES.length - 2);
    }, 30_000);

    it("reads the Analytics-module section, the chat totals and the quick wins", async () => {
      const section = await readSearchConsoleWarehouse({
        projectId: fixture.projectId,
        siteUrl: SITE,
        days: 28,
      });
      expect(section).not.toBeNull();
      expect(section!.to).toBe(FINAL);
      expect(section!.queries).toHaveLength(5);
      expect(section!.metrics.map((metric) => metric.key)).toEqual([
        "sc.clicks",
        "sc.impressions",
        "sc.ctr",
        "sc.position",
        "sc.nonBrandClicks",
        "sc.brandClicks",
      ]);

      const totals = await readSearchConsoleTotals({
        projectId: fixture.projectId,
        siteUrl: SITE,
        days: 28,
      });
      expect(totals).toMatchObject({ impressions: 28_000, position: 5 });
      expect(totals!.ctr).toBeGreaterThan(0);
      expect(totals!.ctr).toBeLessThan(1);
      expect(totals!.clicks).toBe(
        section!.metrics.find((metric) => metric.key === "sc.clicks")!.value,
      );

      // Başka site seçiliyse ambar okunmaz.
      expect(
        await readSearchConsoleTotals({
          projectId: fixture.projectId,
          siteUrl: "sc-domain:other.com",
          days: 28,
        }),
      ).toBeNull();

      const wins = await readQuickWinRows({
        projectId: fixture.projectId,
        siteUrl: SITE,
      });
      expect(wins).not.toBeNull();
      expect(wins!.some((row) => row.keys[0]!.includes("acme"))).toBe(false);
      expect(wins![0]).toMatchObject({ keys: ["best sneakers"], position: 15 });
    }, 30_000);

    it("falls back (null) when a week is missing or the flag is off", async () => {
      const removed = await prisma.gscPeriodFetch.findFirstOrThrow({
        where: {
          linkId,
          grain: "WEEK",
          key: "query",
          periodStart: dayKeyToDate(lastWeek),
        },
      });
      await prisma.gscPeriodFetch.delete({ where: { id: removed.id } });
      expect(
        await readSearchConsoleWarehouse({
          projectId: fixture.projectId,
          siteUrl: SITE,
          days: 28,
        }),
      ).toBeNull();
      expect(
        await readQuickWinRows({ projectId: fixture.projectId, siteUrl: SITE }),
      ).toBeNull();
      // Günlük toplamlar tam: sohbetin toplamı hafta istemez.
      expect(
        await readSearchConsoleTotals({
          projectId: fixture.projectId,
          siteUrl: SITE,
          days: 28,
        }),
      ).not.toBeNull();
      await prisma.gscPeriodFetch.create({
        data: {
          linkId: removed.linkId,
          projectId: removed.projectId,
          grain: removed.grain,
          periodStart: removed.periodStart,
          key: removed.key,
          rowCount: removed.rowCount,
          rowClicks: removed.rowClicks,
          rowImpressions: removed.rowImpressions,
          pages: removed.pages,
          fetchedAt: removed.fetchedAt,
        },
      });

      process.env.GSC_SYNC = "false";
      try {
        expect(
          await readSearchConsoleWarehouse({
            projectId: fixture.projectId,
            siteUrl: SITE,
            days: 28,
          }),
        ).toBeNull();
        expect(
          await readSearchConsoleTotals({
            projectId: fixture.projectId,
            siteUrl: SITE,
            days: 28,
          }),
        ).toBeNull();
        expect(
          await readQuickWinRows({
            projectId: fixture.projectId,
            siteUrl: SITE,
          }),
        ).toBeNull();
      } finally {
        process.env.GSC_SYNC = "true";
      }
    }, 30_000);

    it("hides the anonymous share when a covered week is truncated", async () => {
      const result = await buildSearchReport(fixture.projectId, "28d");
      if (result.state !== "ready") throw new Error("not ready");
      const covered = result.report.period.weeks;
      await prisma.gscPeriodFetch.updateMany({
        where: {
          linkId,
          grain: "WEEK",
          key: "query",
          periodStart: dayKeyToDate(covered.to),
        },
        data: { truncated: true },
      });
      const truncated = await buildSearchReport(fixture.projectId, "28d");
      if (truncated.state !== "ready") throw new Error("not ready");
      expect(truncated.report.anonymousShare).toBeNull();
      expect(truncated.report.queries.truncated).toBe(true);
      expect(truncated.report.queries.notes.join(" ")).toContain("50,000 rows");
      await prisma.gscPeriodFetch.updateMany({
        where: { linkId, grain: "WEEK", key: "query" },
        data: { truncated: false },
      });
    }, 30_000);

    it("reclassifies queries when brand terms are saved, and again on the next sync", async () => {
      const result = await saveBrandTerms({
        projectId: fixture.projectId,
        terms: ["acme", "Pricing"],
      });
      expect(result).toEqual({ ok: true, terms: ["acme", "pricing"] });
      const pricing = () =>
        prisma.gscQuery.findFirstOrThrow({
          where: { linkId, text: "pricing plans" },
        });
      expect((await pricing()).isBrand).toBe(true);
      expect(
        (
          await prisma.gscQuery.findFirstOrThrow({
            where: { linkId, text: "acme pricing" },
          })
        ).isBrand,
      ).toBe(true);
      let link = await prisma.gscSiteLink.findUniqueOrThrow({
        where: { id: linkId },
      });
      expect(link.brandClassifiedHash).toBeNull();
      expect(link.brandTerms).toMatchObject({ user: ["acme", "pricing"] });

      // Eski terimlerle süren bir senkronun geri çevirdiği satır.
      const row = await pricing();
      await prisma.gscQuery.update({
        where: { id: row.id },
        data: { isBrand: false },
      });
      const context = await brandContextForLink(link);
      expect(context.terms).toEqual(["acme", "pricing"]);
      expect(context.hash).toBe(brandTermsHash(["acme", "pricing"]));
      expect(context.regex).toMatch(/^\(\?i\)/);
      expect((await pricing()).isBrand).toBe(true);
      link = await prisma.gscSiteLink.findUniqueOrThrow({
        where: { id: linkId },
      });
      expect(link.brandClassifiedHash).toBe(context.hash);

      // Yeni terimlerin serisi henüz yok: ayrım bekliyor, KPI'lar toplamdan.
      const report = await buildSearchReport(fixture.projectId, "28d");
      if (report.state !== "ready") throw new Error("not ready");
      expect(report.report.link.brandSplit).toBe("pending");
      expect(report.report.kpis[0]!.key).toBe("clicks");
    }, 30_000);
  },
);
