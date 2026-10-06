import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { addDays, dayKeyToDate, dayRange } from "@/lib/seo/dates";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { loadDiagnoseInput, runSearchDiagnosis } from "./diagnose";
import { reportContextFor } from "./inputs";

// Teşhis yükleyicisi gerçek Postgres'e karşı (yalnız CI ve yerel tek
// kullanımlık veritabanı; mock kipte Google'a gidilmez): 56 kesin gün ve
// haftalık sorgu özetleri tohumlanır. (a) konum düşüşü "ranking", (b) üç eksik
// gün "data", (c) düşüş yoksa neden yok; (d) SEO_HEALTH açıkken gscPageKey ile
// eşleşen SeoPage'in noindex bilgisi kaybeden sayfaya taşınır.

const FINAL = "2026-10-04";
const FIRST = "2026-08-10";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const PREVIOUS_WEEKS = ["2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31"];
const CURRENT_WEEKS = ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"];

type SeedQuery = {
  text: string;
  prevClicks: number;
  curClicks: number;
  impressions: number;
  prevPosition: number;
  curPosition: number;
};

describeIntegration("Search drop diagnosis loader", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    sync: process.env.GSC_SYNC,
    reports: process.env.SEO_REPORTS,
    health: process.env.SEO_HEALTH,
    mode: process.env.AGENTELSE_PROVIDER_MODE,
  };
  let fixture: AgencyFixture;
  let linkId: string;

  async function clearWarehouse() {
    await prisma.gscDailyTotal.deleteMany({ where: { linkId } });
    await prisma.gscPeriodFetch.deleteMany({ where: { linkId } });
    await prisma.gscQuery.deleteMany({ where: { linkId } });
    await prisma.gscPage.deleteMany({ where: { linkId } });
  }

  async function seedDays(input: {
    previousClicks: number;
    currentClicks: number;
    previousPosition: number;
    currentPosition: number;
    skip?: string[];
  }) {
    const fetchedAt = new Date();
    const days = dayRange(FIRST, FINAL).filter(
      (day) => !(input.skip ?? []).includes(day),
    );
    await prisma.gscDailyTotal.createMany({
      data: days.map((day) => {
        const current = day >= "2026-09-07";
        const clicks = current ? input.currentClicks : input.previousClicks;
        const position = current
          ? input.currentPosition
          : input.previousPosition;
        return {
          linkId,
          projectId: fixture.projectId,
          date: dayKeyToDate(day),
          searchType: "web",
          clicks,
          impressions: 1000,
          positionWeighted: 1000 * position,
          fresh: false,
          fetchedAt,
        };
      }),
    });
  }

  async function seedQueries(queries: SeedQuery[]) {
    const base = { linkId, projectId: fixture.projectId };
    const fetchedAt = new Date();
    const created = await Promise.all(
      queries.map((query, index) =>
        prisma.gscQuery.create({
          data: {
            ...base,
            text: query.text,
            textHash: `d${index}-${runId}-${query.text}`,
            firstSeenWeek: dayKeyToDate("2026-06-01"),
            lastSeenWeek: dayKeyToDate("2026-09-28"),
          },
        }),
      ),
    );
    for (const week of [...PREVIOUS_WEEKS, ...CURRENT_WEEKS]) {
      const current = CURRENT_WEEKS.includes(week);
      await prisma.gscWeeklyQuery.createMany({
        data: queries.map((query, index) => ({
          ...base,
          weekStart: dayKeyToDate(week),
          queryId: created[index]!.id,
          clicks: current ? query.curClicks : query.prevClicks,
          impressions: query.impressions,
          positionWeighted:
            query.impressions *
            (current ? query.curPosition : query.prevPosition),
        })),
      });
      await prisma.gscPeriodFetch.create({
        data: {
          ...base,
          grain: "WEEK",
          periodStart: dayKeyToDate(week),
          key: "query",
          rowCount: queries.length,
          fetchedAt,
        },
      });
    }
  }

  const steady: SeedQuery[] = [
    "running shoes",
    "trail shoes",
    "best sneakers",
    "shoe size chart",
  ].map((text) => ({
    text,
    prevClicks: 40,
    curClicks: 40,
    impressions: 500,
    prevPosition: 6,
    curPosition: 6,
  }));

  beforeAll(async () => {
    process.env.GSC_SYNC = "true";
    process.env.SEO_REPORTS = "true";
    process.env.SEO_HEALTH = "";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    fixture = await createAgencyFixture(`seo-diagnose-${runId}`);
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
      },
    });
    linkId = link.id;
  }, 60_000);

  afterAll(async () => {
    process.env.GSC_SYNC = saved.sync;
    process.env.SEO_REPORTS = saved.reports;
    process.env.SEO_HEALTH = saved.health;
    process.env.AGENTELSE_PROVIDER_MODE = saved.mode;
    await prisma.seoSite.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await prisma.gscSiteLink.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("names a ranking drop as the primary cause", async () => {
    await clearWarehouse();
    await seedDays({
      previousClicks: 100,
      currentClicks: 60,
      previousPosition: 6,
      currentPosition: 8,
    });
    await seedQueries(
      steady.map((query) => ({
        ...query,
        curClicks: 20,
        curPosition: 8,
      })),
    );
    const result = await runSearchDiagnosis(fixture.projectId, {
      days: 28,
      end: FINAL,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnosis).toMatchObject({
      dropped: true,
      primary: "ranking",
      current: 1680,
      previous: 2800,
    });
    expect(result.diagnosis.askUser.map((ask) => ask.screen)).toEqual([
      "Manual actions",
      "Security issues",
    ]);
  });

  it("names a data problem when days are missing", async () => {
    await clearWarehouse();
    await seedDays({
      previousClicks: 100,
      currentClicks: 70,
      previousPosition: 6,
      currentPosition: 6,
      skip: ["2026-09-20", "2026-09-21", "2026-09-22"],
    });
    await seedQueries(steady);
    const result = await runSearchDiagnosis(fixture.projectId, {
      days: 28,
      end: FINAL,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnosis.dropped).toBe(true);
    expect(result.diagnosis.primary).toBe("data");
    expect(
      result.diagnosis.steps.find((step) => step.key === "data")?.metrics
        .missingDays,
    ).toBe(3);
  });

  it("finds no cause when clicks did not drop", async () => {
    await clearWarehouse();
    await seedDays({
      previousClicks: 100,
      currentClicks: 100,
      previousPosition: 6,
      currentPosition: 6,
    });
    await seedQueries(steady);
    const result = await runSearchDiagnosis(fixture.projectId, {
      days: 28,
      end: FINAL,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnosis).toMatchObject({
      dropped: false,
      primary: null,
      askUser: [],
    });
  });

  it("answers not_enough_data when the stored history is shorter than two windows", async () => {
    await clearWarehouse();
    await seedDays({
      previousClicks: 100,
      currentClicks: 100,
      previousPosition: 6,
      currentPosition: 6,
    });
    await prisma.gscDailyTotal.deleteMany({
      where: { linkId, date: { lt: dayKeyToDate(addDays(FIRST, 5)) } },
    });
    const result = await runSearchDiagnosis(fixture.projectId, {
      days: 28,
      end: FINAL,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "not_enough_data" });
  });

  it("carries the crawl's noindex onto a lost page matched by gscPageKey", async () => {
    await clearWarehouse();
    await seedDays({
      previousClicks: 100,
      currentClicks: 60,
      previousPosition: 6,
      currentPosition: 6,
    });
    await seedQueries(steady);
    const base = { linkId, projectId: fixture.projectId };
    const page = await prisma.gscPage.create({
      data: {
        ...base,
        url: "https://www.acme-test.com/old",
        urlHash: `pg-${runId}`,
        path: "/old",
        firstSeenWeek: dayKeyToDate("2026-06-01"),
        lastSeenWeek: dayKeyToDate("2026-09-28"),
      },
    });
    for (const week of [...PREVIOUS_WEEKS, ...CURRENT_WEEKS]) {
      await prisma.gscWeeklyPage.create({
        data: {
          ...base,
          weekStart: dayKeyToDate(week),
          pageId: page.id,
          clicks: CURRENT_WEEKS.includes(week) ? 0 : 30,
          impressions: 400,
          positionWeighted: 400 * 5,
        },
      });
    }
    const site = await prisma.seoSite.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        isMock: true,
      },
    });
    await prisma.seoPage.create({
      data: {
        siteId: site.id,
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        url: "https://www.acme-test.com/old",
        urlHash: `seo-${runId}`,
        path: "/old",
        discoveredVia: "CRAWL",
        status: 200,
        noindex: true,
        firstSeenAt: new Date(),
      },
    });

    process.env.SEO_HEALTH = "true";
    try {
      const ctx = await reportContextFor(fixture.projectId);
      expect(ctx).not.toBeNull();
      const input = await loadDiagnoseInput(ctx!, {
        days: 28,
        end: FINAL,
        now: NOW,
      });
      expect(input?.health.available).toBe(true);
      const lost = input?.pages.find((row) => row.label === "/old");
      expect(lost).toMatchObject({ status: 200, noindex: true, indexed: null });
      expect(lost?.previous.clicks).toBe(120);
      expect(lost?.current.clicks).toBe(0);
    } finally {
      process.env.SEO_HEALTH = "";
    }
  });
});
