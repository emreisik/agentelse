import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import type { GscSiteLink } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  addDays,
  dayKeyToDate,
  gscToday,
  lastCompleteWeekStart,
} from "@/lib/seo/dates";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";
import { ensureGscLinkForProject } from "@/server/seo/sync/links";
import { GscSync } from "@/server/seo/sync/runner";

import { setMockExportDryRunBytes, setMockExportSize } from "./mock-export";
import { saveBqSource, setBqSourceState } from "./source";
import { GscBigQuerySync } from "./sync";
import { verifyBqSource } from "./verify";

// BigQuery içe aktarma gerçek Postgres'e karşı (mock BigQuery, mock Google):
// API'nin kırpılmış haftası BigQuery'nin 62.000 sorgusuyla değişir (kaynak BQ,
// kırpılma yok), günlük toplamlara dokunulmaz, ikinci tur bir şey almaz,
// kırpılmamış API haftası değişmez, aylık bayt sayacı artar, tavanı aşan tahmin
// dönemi kaynağı bozmadan atlar ve sahiplik düşünce kaynak NOT_OWNER ile
// ERROR olur.

describeIntegration("GSC BigQuery export import (mock BigQuery)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    sync: process.env.GSC_SYNC,
    agency: process.env.GSC_AGENCY,
    bigquery: process.env.GSC_BIGQUERY,
    mode: process.env.AGENTELSE_PROVIDER_MODE,
  };
  let fixture: AgencyFixture;
  let link: GscSiteLink;
  let sourceId: string;
  let week: string;
  let otherWeek: string;
  let capWeek: string;

  const weekDate = (day: string) => dayKeyToDate(day);

  async function currentLink(): Promise<GscSiteLink> {
    return prisma.gscSiteLink.findFirstOrThrow({
      where: { projectId: fixture.projectId, isPrimary: true },
    });
  }

  async function dailyTotals() {
    return prisma.gscDailyTotal.aggregate({
      where: { linkId: link.id },
      _count: { _all: true },
      _sum: { clicks: true, impressions: true },
    });
  }

  async function syncUntilIdle(): Promise<number> {
    let total = 0;
    for (let round = 0; round < 10; round += 1) {
      const result = await GscBigQuerySync.syncSource(sourceId);
      total += result.imported;
      if (result.imported === 0) break;
    }
    return total;
  }

  beforeAll(async () => {
    process.env.GSC_SYNC = "true";
    process.env.GSC_AGENCY = "true";
    process.env.GSC_BIGQUERY = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    fixture = await createAgencyFixture(`bq-${runId}`);
    await prisma.integrationCredential.create({
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
    await ensureGscLinkForProject(fixture.projectId);
    // API mock senkronu: günlük, geri doldurma, haftalık ve aylık özetler.
    for (let round = 0; round < 40; round += 1) {
      await GscSync.runDue(3, new Date());
      if ((await currentLink()).backfillDoneAt) break;
    }
    link = await currentLink();
    expect(link.backfillDoneAt).not.toBeNull();
    expect(link.permissionLevel).toBe("siteOwner");

    // Dışa aktarım penceresi bugün−120 … bugün−3: son tam hafta içeride.
    const today = gscToday(new Date());
    week = lastCompleteWeekStart(addDays(today, -3));
    otherWeek = addDays(week, -14);
    capWeek = addDays(week, -7);

    // API'nin bu haftası kırpılmış: 50.000 yapay sorgu satırı.
    await prisma.gscWeeklyQuery.deleteMany({
      where: { linkId: link.id, weekStart: weekDate(week) },
    });
    await prisma.$executeRaw`
      INSERT INTO "GscQuery" ("id", "linkId", "projectId", "text", "textHash", "isBrand", "firstSeenWeek", "lastSeenWeek")
      SELECT ${"synq-" + runId + "-"} || g, ${link.id}, ${link.projectId}, 'synthetic ' || g, ${"synhash-" + runId + "-"} || g, false, ${week}::date, ${week}::date
      FROM generate_series(1, 50000) AS g
    `;
    await prisma.$executeRaw`
      INSERT INTO "GscWeeklyQuery" ("id", "linkId", "projectId", "weekStart", "queryId", "clicks", "impressions", "positionWeighted")
      SELECT ${"synw-" + runId + "-"} || g, ${link.id}, ${link.projectId}, ${week}::date, ${"synq-" + runId + "-"} || g, 1, 2, 3
      FROM generate_series(1, 50000) AS g
    `;
    await prisma.gscPeriodFetch.update({
      where: {
        linkId_grain_periodStart_key: {
          linkId: link.id,
          grain: "WEEK",
          periodStart: weekDate(week),
          key: "query",
        },
      },
      data: { truncated: true, rowCount: 50_000, source: "API" },
    });
    setMockExportSize({ query: 62_000 });
  }, 300_000);

  afterAll(async () => {
    setMockExportSize(null);
    setMockExportDryRunBytes(null);
    process.env.GSC_SYNC = saved.sync;
    process.env.GSC_AGENCY = saved.agency;
    process.env.GSC_BIGQUERY = saved.bigquery;
    process.env.AGENTELSE_PROVIDER_MODE = saved.mode;
    await prisma.gscBqSource.deleteMany({
      where: { workspaceId: fixture?.workspaceId },
    });
    await prisma.gscSiteLink.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await prisma.auditLog.deleteMany({
      where: { workspaceId: fixture?.workspaceId },
    });
    await prisma.integrationCredential.deleteMany({
      where: { workspaceId: fixture?.workspaceId },
    });
    await teardownAgencyFixture(fixture?.workspaceId);
    // 62.000 sorgu satırının cascade silinmesi yavaş makinede 2 dakikayı aşar.
  }, 300_000);

  it("creates, verifies and enables the source for the property owner", async () => {
    const saveResult = await saveBqSource({
      projectId: fixture.projectId,
      linkId: link.id,
      bqProjectId: "my-cloud-proj",
      dataset: "searchconsole",
      maxBytesPerQuery: 10 * 1024 ** 3,
      monthlyBudgetBytes: 300 * 1024 ** 3,
      importAll: false,
      userId: "user-integration",
    });
    expect(saveResult).toEqual({ ok: true });

    const verified = await verifyBqSource({
      projectId: fixture.projectId,
      linkId: link.id,
      userId: "user-integration",
    });
    expect(verified.errorCode).toBeNull();
    expect(verified.ok).toBe(true);
    expect(verified.steps.find((step) => step.key === "reconcile")?.state).toBe("ok");

    const source = await prisma.gscBqSource.findFirstOrThrow({
      where: { projectId: fixture.projectId },
    });
    sourceId = source.id;
    expect(source).toMatchObject({
      status: "VERIFIED",
      location: "US",
      bqSiteUrl: "sc-domain:example.com",
      isMock: true,
    });

    expect(
      await setBqSourceState({
        projectId: fixture.projectId,
        linkId: link.id,
        state: "ON",
        userId: "user-integration",
      }),
    ).toEqual({ ok: true });
  }, 120_000);

  it("replaces the truncated API week with the 62,000 BigQuery queries and leaves the rest alone", async () => {
    const before = await dailyTotals();
    const otherBefore = await prisma.gscPeriodFetch.findUniqueOrThrow({
      where: {
        linkId_grain_periodStart_key: {
          linkId: link.id,
          grain: "WEEK",
          periodStart: weekDate(otherWeek),
          key: "query",
        },
      },
    });
    const usageBefore = await prisma.gscBqSource.findUniqueOrThrow({ where: { id: sourceId } });

    const imported = await syncUntilIdle();
    expect(imported).toBeGreaterThanOrEqual(1);

    expect(
      await prisma.gscWeeklyQuery.count({
        where: { linkId: link.id, weekStart: weekDate(week) },
      }),
    ).toBe(62_000);
    const fetch = await prisma.gscPeriodFetch.findUniqueOrThrow({
      where: {
        linkId_grain_periodStart_key: {
          linkId: link.id,
          grain: "WEEK",
          periodStart: weekDate(week),
          key: "query",
        },
      },
    });
    expect(fetch).toMatchObject({ source: "BQ", truncated: false, rowCount: 62_000 });

    // Günlük toplamlara BigQuery asla yazmaz.
    expect(await dailyTotals()).toEqual(before);

    // Kırpılmamış API haftası (importAll kapalı) olduğu gibi kalır.
    const otherAfter = await prisma.gscPeriodFetch.findUniqueOrThrow({
      where: { id: otherBefore.id },
    });
    expect(otherAfter).toMatchObject({
      source: "API",
      rowCount: otherBefore.rowCount,
      fetchedAt: otherBefore.fetchedAt,
    });

    // Aylık bayt sayacı ilerledi.
    const usageAfter = await prisma.gscBqSource.findUniqueOrThrow({ where: { id: sourceId } });
    expect(Number(usageAfter.bytesBilledMonth)).toBeGreaterThan(Number(usageBefore.bytesBilledMonth));
    expect(usageAfter.queriesMonth).toBeGreaterThan(usageBefore.queriesMonth);
    expect(usageAfter.status).toBe("ACTIVE");
    expect(usageAfter.lastSyncAt).not.toBeNull();
  }, 300_000);

  it("a second run imports nothing", async () => {
    expect((await GscBigQuerySync.syncSource(sourceId)).imported).toBe(0);
    expect(
      await prisma.gscWeeklyQuery.count({
        where: { linkId: link.id, weekStart: weekDate(week) },
      }),
    ).toBe(62_000);
  }, 120_000);

  it("skips a period whose estimate is over the cap without failing the source", async () => {
    await prisma.gscPeriodFetch.update({
      where: {
        linkId_grain_periodStart_key: {
          linkId: link.id,
          grain: "WEEK",
          periodStart: weekDate(capWeek),
          key: "query",
        },
      },
      data: { truncated: true },
    });
    setMockExportDryRunBytes(20_000_000_000);
    try {
      const result = await GscBigQuerySync.syncSource(sourceId);
      expect(result).toMatchObject({ imported: 0, status: "ACTIVE", reason: "PERIOD_TOO_BIG" });
    } finally {
      setMockExportDryRunBytes(null);
    }
    const source = await prisma.gscBqSource.findUniqueOrThrow({ where: { id: sourceId } });
    expect(source).toMatchObject({ status: "ACTIVE", lastError: "PERIOD_TOO_BIG" });
    const fetch = await prisma.gscPeriodFetch.findUniqueOrThrow({
      where: {
        linkId_grain_periodStart_key: {
          linkId: link.id,
          grain: "WEEK",
          periodStart: weekDate(capWeek),
          key: "query",
        },
      },
    });
    expect(fetch).toMatchObject({ source: "API", truncated: true });
  }, 120_000);

  it("ends in ERROR NOT_OWNER once the property permission is no longer owner", async () => {
    await prisma.gscSiteLink.update({
      where: { id: link.id },
      data: { permissionLevel: "siteRestrictedUser" },
    });
    const result = await GscBigQuerySync.syncSource(sourceId);
    expect(result).toMatchObject({ imported: 0, status: "ERROR", reason: "NOT_OWNER" });
    const source = await prisma.gscBqSource.findUniqueOrThrow({ where: { id: sourceId } });
    expect(source).toMatchObject({ status: "ERROR", lastError: "NOT_OWNER", nextRunAt: null });
    // Sahiplik yokken yeniden açılamaz.
    expect(
      (
        await setBqSourceState({
          projectId: fixture.projectId,
          linkId: link.id,
          state: "ON",
          userId: "user-integration",
        })
      ).ok,
    ).toBe(false);
  }, 120_000);
});
