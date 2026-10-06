import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { brandTermsHash } from "@/lib/seo/brand-terms";
import { addDays, dayKeyToDate, dayRange } from "@/lib/seo/dates";
import { readSeoReportSnapshot } from "@/lib/seo/reports/snapshot";
import type { SeoReportTable } from "@/lib/seo/reports/types";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { reportContextForLink } from "./inputs";
import { buildWeeklyReport } from "./weekly";

// Haftalık SEO raporunun anlık görüntüsü gerçek Postgres'e karşı (yalnız CI
// ve yerel tek kullanımlık veritabanı): ambar doğrudan tohumlanır, KPI'lar,
// tablolar ve anonim pay tohumdaki toplamlarla birebir karşılaştırılır ve
// anlık görüntü JSON gidiş-dönüşünde değişmez.

const SITE = "sc-domain:acme-test.com";
const WEEK = "2026-09-28";
const PREV_WEEK = "2026-09-21";
const FINAL = "2026-10-04";

// Önceki hafta 100 + i, bu hafta 120 + i tıklama; marka günlük 30.
const PREV_CLICKS = (i: number) => 100 + i;
const CUR_CLICKS = (i: number) => 120 + i;
const PREV_IMPRESSIONS = 1000;
const CUR_IMPRESSIONS = 1100;
const BRAND_DAILY = 30;

const QUERIES = [
  { text: "shoe a", isBrand: false, prev: [20, 400], cur: [5, 100] },
  { text: "shoe b", isBrand: false, prev: [5, 100], cur: [30, 300] },
  { text: "shoe c", isBrand: false, prev: null, cur: [4, 500] },
  { text: "acme brand", isBrand: true, prev: [10, 50], cur: [50, 200] },
] as const;

const PAGES = [
  {
    path: "/lost",
    url: "https://www.acme-test.com/lost",
    prev: [30, 600],
    cur: [4, 80],
  },
  {
    path: "/won",
    url: "https://www.acme-test.com/won",
    prev: [5, 100],
    cur: [25, 500],
  },
] as const;

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

describeIntegration("Weekly SEO report snapshot", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    sync: process.env.GSC_SYNC,
    mode: process.env.AGENTELSE_PROVIDER_MODE,
    health: process.env.SEO_HEALTH,
    insights: process.env.SEO_INSIGHTS,
  };
  const curDays = dayRange(WEEK, FINAL);
  const prevDays = dayRange(PREV_WEEK, addDays(WEEK, -1));
  let fixture: AgencyFixture;
  let linkId: string;

  beforeAll(async () => {
    process.env.GSC_SYNC = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    delete process.env.SEO_HEALTH;
    delete process.env.SEO_INSIGHTS;
    fixture = await createAgencyFixture(`seo-weekly-${runId}`);
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
        lastWeeklyWeek: WEEK,
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

    // 14 kesin gün: bu hafta ve bir önceki hafta, marka değerleriyle.
    await prisma.gscDailyTotal.createMany({
      data: [
        ...prevDays.map((day, i) => ({
          ...base,
          date: dayKeyToDate(day),
          searchType: "web",
          clicks: PREV_CLICKS(i),
          impressions: PREV_IMPRESSIONS,
          positionWeighted: PREV_IMPRESSIONS * 5,
          brandClicks: BRAND_DAILY,
          brandImpressions: 200,
          brandPositionWeighted: 400,
          fresh: false,
          fetchedAt,
        })),
        ...curDays.map((day, i) => ({
          ...base,
          date: dayKeyToDate(day),
          searchType: "web",
          clicks: CUR_CLICKS(i),
          impressions: CUR_IMPRESSIONS,
          positionWeighted: CUR_IMPRESSIONS * 5,
          brandClicks: BRAND_DAILY,
          brandImpressions: 200,
          brandPositionWeighted: 400,
          fresh: false,
          fetchedAt,
        })),
      ],
    });

    const prevStart = dayKeyToDate(PREV_WEEK);
    const curStart = dayKeyToDate(WEEK);
    const queryRows = await Promise.all(
      QUERIES.map((query, index) =>
        prisma.gscQuery.create({
          data: {
            ...base,
            text: query.text,
            textHash: `q${index}-${runId}`,
            isBrand: query.isBrand,
            firstSeenWeek: prevStart,
            lastSeenWeek: curStart,
          },
        }),
      ),
    );
    const pageRows = await Promise.all(
      PAGES.map((page, index) =>
        prisma.gscPage.create({
          data: {
            ...base,
            url: page.url,
            urlHash: `p${index}-${runId}`,
            path: page.path,
            firstSeenWeek: prevStart,
            lastSeenWeek: curStart,
          },
        }),
      ),
    );
    const weekly = (weekStart: Date, period: "prev" | "cur") => ({
      queries: QUERIES.flatMap((query, index) => {
        const values = query[period];
        if (!values) return [];
        return [
          {
            ...base,
            weekStart,
            queryId: queryRows[index]!.id,
            clicks: values[0],
            impressions: values[1],
            positionWeighted: values[1] * 6,
          },
        ];
      }),
      pages: PAGES.map((page, index) => ({
        ...base,
        weekStart,
        pageId: pageRows[index]!.id,
        clicks: page[period][0],
        impressions: page[period][1],
        positionWeighted: page[period][1] * 4,
      })),
    });
    for (const [weekStart, period] of [
      [prevStart, "prev"],
      [curStart, "cur"],
    ] as const) {
      const rows = weekly(weekStart, period);
      await prisma.gscWeeklyQuery.createMany({ data: rows.queries });
      await prisma.gscWeeklyPage.createMany({ data: rows.pages });
      await prisma.gscPeriodFetch.createMany({
        data: [
          {
            ...base,
            grain: "WEEK",
            periodStart: weekStart,
            key: "query",
            rowCount: rows.queries.length,
            rowClicks: sum(rows.queries.map((row) => row.clicks)),
            rowImpressions: 0,
            pages: 1,
            fetchedAt,
          },
          {
            ...base,
            grain: "WEEK",
            periodStart: weekStart,
            key: "page",
            rowCount: rows.pages.length,
            rowClicks: sum(rows.pages.map((row) => row.clicks)),
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
    if (saved.health === undefined) delete process.env.SEO_HEALTH;
    else process.env.SEO_HEALTH = saved.health;
    if (saved.insights === undefined) delete process.env.SEO_INSIGHTS;
    else process.env.SEO_INSIGHTS = saved.insights;
    await prisma.gscSiteLink.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  async function build() {
    const link = await prisma.gscSiteLink.findUniqueOrThrow({
      where: { id: linkId },
    });
    const ctx = await reportContextForLink(link);
    if (!ctx) throw new Error("rapor bağlamı kurulamadı");
    const result = await buildWeeklyReport(
      ctx,
      WEEK,
      new Date("2026-10-07T12:00:00Z"),
    );
    if (!("snapshot" in result)) {
      throw new Error(`rapor beklendi, atlandı: ${result.skipped}`);
    }
    return result.snapshot;
  }

  it("builds KPIs that equal the sums and ratios of the seeded rows", async () => {
    const snapshot = await build();
    const curClicks = sum(curDays.map((_, i) => CUR_CLICKS(i)));
    const prevClicks = sum(prevDays.map((_, i) => PREV_CLICKS(i)));
    const curImpressions = CUR_IMPRESSIONS * 7;
    const prevImpressions = PREV_IMPRESSIONS * 7;
    const brand = BRAND_DAILY * 7;

    expect(snapshot).toMatchObject({
      kind: "WEEKLY",
      periodKey: `W:${WEEK}`,
      period: { from: WEEK, to: FINAL },
      compare: { from: PREV_WEEK, to: "2026-09-27" },
      yearAgo: null,
      site: { isMock: true },
      finalThrough: FINAL,
      brandSplit: true,
    });
    const kpis = snapshot.sections[0];
    if (kpis?.type !== "kpis") throw new Error("kpis beklendi");
    const byKey = Object.fromEntries(kpis.kpis.map((kpi) => [kpi.key, kpi]));
    expect(kpis.kpis.map((kpi) => kpi.key)).toEqual([
      "nonBrandClicks",
      "brandClicks",
      "clicks",
      "impressions",
      "ctr",
      "position",
    ]);
    expect(byKey.clicks).toMatchObject({
      value: curClicks,
      previous: prevClicks,
      yearAgo: null,
    });
    expect(byKey.brandClicks).toMatchObject({ value: brand, previous: brand });
    expect(byKey.nonBrandClicks).toMatchObject({
      value: curClicks - brand,
      previous: prevClicks - brand,
    });
    expect(byKey.impressions).toMatchObject({
      value: curImpressions,
      previous: prevImpressions,
    });
    expect(byKey.ctr?.value).toBe(
      Math.round((curClicks / curImpressions) * 10000) / 100,
    );
    expect(byKey.ctr?.previous).toBe(
      Math.round((prevClicks / prevImpressions) * 10000) / 100,
    );
    expect(byKey.position).toMatchObject({ value: 5, previous: 5 });
    expect(kpis.compareLabel).toBe("vs the week before");
    expect(kpis.yearAgoLabel).toBeNull();
  });

  it("builds the tables from the seeded weekly deltas, brand queries excluded", async () => {
    const snapshot = await build();
    const tables = snapshot.sections.flatMap((section) =>
      section.type === "table" ? [section.table] : [],
    );
    const labels = (key: SeoReportTable["key"]) =>
      tables.find((table) => table.key === key)?.rows.map((row) => row.label);
    expect(tables.map((table) => table.key)).toEqual([
      "losing_queries",
      "winning_queries",
      "rising_queries",
      "losing_pages",
      "winning_pages",
    ]);
    expect(labels("losing_queries")).toEqual(["shoe a"]);
    expect(labels("winning_queries")).toEqual(["shoe b", "shoe c"]);
    expect(labels("rising_queries")).toEqual(["shoe c", "shoe b"]);
    expect(labels("losing_pages")).toEqual(["/lost"]);
    expect(labels("winning_pages")).toEqual(["/won"]);
    const loser = tables[0]!.rows[0]!;
    expect(loser).toMatchObject({
      clicks: 5,
      previousClicks: 20,
      impressions: 100,
      previousImpressions: 400,
      isBrand: false,
    });
    expect(loser.position).toBe(6);
    expect(tables[3]!.rows[0]!.url).toBe("https://www.acme-test.com/lost");
    // Sağlık ve fırsat bayrakları kapalı: başka bölüm yok, teşhis de yok.
    expect(snapshot.sections.map((section) => section.type)).toEqual([
      "kpis",
      "table",
      "table",
      "table",
      "table",
      "table",
    ]);
  });

  it("computes the anonymous share as 1 - rowClicks / clicks", async () => {
    const snapshot = await build();
    const curClicks = sum(curDays.map((_, i) => CUR_CLICKS(i)));
    const rowClicks = sum(QUERIES.map((query) => query.cur[0]));
    expect(snapshot.anonymousShare).toBeCloseTo(1 - rowClicks / curClicks, 10);
    expect(snapshot.notes).toContain(
      `${Math.round((1 - rowClicks / curClicks) * 100)}% of clicks come from searches Google doesn't show.`,
    );
  });

  it("survives the JSON round-trip through readSeoReportSnapshot unchanged", async () => {
    const snapshot = await build();
    const stored: unknown = JSON.parse(JSON.stringify(snapshot));
    expect(readSeoReportSnapshot(stored)).toEqual(snapshot);
  });
});
