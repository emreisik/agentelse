import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { brandTermsHash } from "@/lib/seo/brand-terms";
import { dayKeyToDate, dayRange } from "@/lib/seo/dates";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { forecastSearchMonth, readMonthlySeries } from "./forecast";
import { reportContextFor } from "./inputs";

// Aylık seri ve tahmin gerçek Postgres'e karşı (yalnız CI ve yerel tek
// kullanımlık veritabanı; mock kipte Google'a gidilmez): 18 aylık günlük
// toplam tohumlanır. Taze günü olan ay ve kısmi (şimdiki) ay seriye girmez;
// 15 ay geçmişle tahmin "seasonal" olur; bir ayın marka değeri eksikse metrik
// toplam tıklamaya düşer; son 90 günde görülen sayfalar yönlendirici olarak
// ayrı gösterilir.

const FIRST_DAY = "2025-04-01";
const FINAL = "2026-10-05";
const TARGET = "2026-10-01";
const FRESH_DAY = "2025-06-15";

describeIntegration("SEO forecast loader", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    sync: process.env.GSC_SYNC,
    mode: process.env.AGENTELSE_PROVIDER_MODE,
  };
  let fixture: AgencyFixture;
  let linkId: string;

  beforeAll(async () => {
    process.env.GSC_SYNC = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    fixture = await createAgencyFixture(`seo-forecast-${runId}`);
    const brandHash = brandTermsHash(["acme"]);
    const link = await prisma.gscSiteLink.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId: `cred-${runId}`,
        siteUrl: "sc-domain:acme-test.com",
        isMock: true,
        health: "OK",
        lastFinalDate: FINAL,
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

    // Her gün 100 tık, 20'si marka; ekim ayı yalnız 5 gün.
    await prisma.gscDailyTotal.createMany({
      data: dayRange(FIRST_DAY, FINAL).map((day) => ({
        ...base,
        date: dayKeyToDate(day),
        searchType: "web",
        clicks: 100,
        impressions: 1000,
        positionWeighted: 5000,
        brandClicks: 20,
        brandImpressions: 100,
        brandPositionWeighted: 200,
        fresh: day === FRESH_DAY,
        fetchedAt,
      })),
    });

    // Yeni içerik: biri eski, biri son 90 gün içinde görülen iki sayfa.
    const pages = await Promise.all(
      [
        { path: "/old", firstSeen: "2025-01-06", clicks: 160 },
        { path: "/fresh", firstSeen: "2026-08-10", clicks: 40 },
      ].map((page, index) =>
        prisma.gscPage.create({
          data: {
            ...base,
            url: `https://www.acme-test.com${page.path}`,
            urlHash: `fp${index}-${runId}`,
            path: page.path,
            firstSeenWeek: dayKeyToDate(page.firstSeen),
            lastSeenWeek: dayKeyToDate("2026-09-28"),
          },
        }),
      ),
    );
    await prisma.gscMonthlyPage.createMany({
      data: [160, 40].map((clicks, index) => ({
        ...base,
        month: dayKeyToDate("2026-09-01"),
        pageId: pages[index]!.id,
        clicks,
        impressions: clicks * 10,
        positionWeighted: clicks * 10 * 5,
      })),
    });
  }, 120_000);

  afterAll(async () => {
    process.env.GSC_SYNC = saved.sync;
    process.env.AGENTELSE_PROVIDER_MODE = saved.mode;
    await prisma.gscSiteLink.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("excludes the month with a fresh day and the partial current month", async () => {
    const series = await readMonthlySeries(linkId, "clicks", "2026-10-01");
    const months = series.map((point) => point.month);
    expect(months).not.toContain("2025-06-01");
    expect(months).not.toContain("2026-10-01");
    expect(months[0]).toBe("2025-04-01");
    expect(months.at(-1)).toBe("2026-09-01");
    expect(months).toHaveLength(17);
    expect(series.find((point) => point.month === "2026-09-01")).toEqual({
      month: "2026-09-01",
      value: 3000,
      days: 30,
    });
    const nonBrand = await readMonthlySeries(
      linkId,
      "nonBrandClicks",
      "2026-09-01",
    );
    expect(nonBrand.find((point) => point.month === "2026-09-01")?.value).toBe(
      2400,
    );
  });

  it("limits the series to the requested number of months", async () => {
    const series = await readMonthlySeries(linkId, "clicks", "2026-09-01", 3);
    expect(series.map((point) => point.month)).toEqual([
      "2026-07-01",
      "2026-08-01",
      "2026-09-01",
    ]);
  });

  it("forecasts next month's non-brand clicks seasonally with 15 months of history", async () => {
    const ctx = await reportContextFor(fixture.projectId);
    expect(ctx?.brandSplitReady).toBe(true);
    const forecast = await forecastSearchMonth(ctx!, TARGET);
    expect(forecast).toMatchObject({
      metric: "nonBrandClicks",
      month: TARGET,
      method: "seasonal",
      value: 2480,
    });
    expect(forecast?.low).toBeLessThan(2480);
    expect(forecast?.high).toBeGreaterThan(2480);
    expect(forecast?.newContent).toEqual({ clicks: 40, pages: 1, share: 0.2 });
  });

  it("falls back to total clicks when a month has missing brand values", async () => {
    await prisma.gscDailyTotal.updateMany({
      where: { linkId, date: dayKeyToDate("2026-08-10") },
      data: {
        brandClicks: null,
        brandImpressions: null,
        brandPositionWeighted: null,
      },
    });
    const ctx = await reportContextFor(fixture.projectId);
    const forecast = await forecastSearchMonth(ctx!, TARGET);
    expect(forecast).toMatchObject({
      metric: "clicks",
      method: "seasonal",
      value: 3100,
    });
  });
});
