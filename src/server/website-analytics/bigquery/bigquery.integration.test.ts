import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { addDays, dateToDayKey, dayKeyToDate } from "@/lib/website-analytics/days";
import { buildGaStatements } from "@/lib/website-analytics/bigquery/sql";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { disconnectGoogleCredential } from "@/server/integrations/google-disconnect";
import {
  assertReadOnlySql,
  bigQueryClient,
  resetBigQueryMock,
} from "@/server/integrations/google/bigquery";
import { describeIntegration } from "@/test-support/integration-suite";

import { mockBigQueryDayNumbers, mockExportKeyFor } from "./mock";
import { loadBigQueryCard } from "./read";
import { GaBigQueryRunner } from "./runner";
import { verifyAndSaveBigQuerySource } from "./verify";

// GA4 BigQuery dışa aktarımı, mock modda gerçek Postgres'e karşı (SC-F9'un istemcisi
// ve sahte arka ucu birleştirmeden sonra vardır; Google'a ve BigQuery'ye hiç
// gidilmez): kurulum + kayıt çevrimdışı çalışır, runDue GaBigQueryDay yazar, ambar
// aynı sayılarla beslenince Export check tam "close" çıkar, üç gerçek ifade SC-F9'un
// salt-okunur denetiminden geçer, Disconnect kaynağı ve günleri siler.

describeIntegration("GA BigQuery export (mock)", () => {
  const runId = randomUUID().slice(0, 8);
  const propertyId = "424242";
  const saved = {
    agency: process.env.GA_AGENCY,
    sync: process.env.GA_SYNC,
    bq: process.env.GA_BIGQUERY,
    mode: process.env.AGENTELSE_PROVIDER_MODE,
  };
  const realFetch = globalThis.fetch;
  let fixture: AgencyFixture;
  let credentialId: string;
  let linkId: string;
  let fetchCalls = 0;
  const now = new Date();

  beforeAll(async () => {
    process.env.GA_AGENCY = "true";
    process.env.GA_SYNC = "true";
    process.env.GA_BIGQUERY = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    // Ağ yok: herhangi bir fetch çağrısı testi düşürür.
    vi.stubGlobal("fetch", () => {
      fetchCalls += 1;
      throw new Error("network is not allowed in mock mode");
    });
    resetBigQueryMock();
    fixture = await createAgencyFixture(`gabq-${runId}`);
    const credential = await prisma.integrationCredential.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        provider: "google_analytics",
        accountLabel: "owner@example.com",
        encryptedSecret: "not-used-in-mock-mode",
        status: "ACTIVE",
        metadata: {},
      },
    });
    credentialId = credential.id;
    const link = await prisma.gaPropertyLink.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId,
        propertyId,
        isPrimary: true,
        isMock: true,
        health: "OK",
        timeZone: "UTC",
        keyEvents: [{ eventName: "generate_lead" }],
      },
    });
    linkId = link.id;

    // Ambar, dışa aktarımla AYNI sayılarla beslenir: karşılaştırma tam "close" çıkar.
    const today = dateToDayKey(now);
    const key = mockExportKeyFor(propertyId);
    const rows = [];
    for (let back = 1; back <= 28; back += 1) {
      const day = addDays(today, -back);
      const numbers = mockBigQueryDayNumbers(key, day);
      rows.push({
        linkId,
        projectId: fixture.projectId,
        date: dayKeyToDate(day),
        activeUsers: numbers.users,
        sessions: numbers.sessions,
        isFinal: true,
        fetchedAt: now,
      });
    }
    await prisma.gaDailyTotal.createMany({ data: rows });
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    globalThis.fetch = realFetch;
    process.env.GA_AGENCY = saved.agency;
    process.env.GA_SYNC = saved.sync;
    process.env.GA_BIGQUERY = saved.bq;
    process.env.AGENTELSE_PROVIDER_MODE = saved.mode;
    await prisma.gaPropertyLink.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await prisma.integrationCredential.deleteMany({
      where: { workspaceId: fixture?.workspaceId },
    });
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("verifies and saves a source on a mock link offline", async () => {
    // Başka bir dataset adı bağlama kuralıyla ağa çıkmadan reddedilir.
    const refused = await verifyAndSaveBigQuerySource({
      projectId: fixture.projectId,
      linkId,
      userId: "user-1",
      config: { gcpProjectId: "my-company-123456", datasetId: "analytics_999999" },
    });
    expect(refused).toMatchObject({ ok: false, code: "invalid" });

    const result = await verifyAndSaveBigQuerySource({
      projectId: fixture.projectId,
      linkId,
      userId: "user-1",
      config: { gcpProjectId: "my-company-123456", datasetId: `analytics_${propertyId}` },
    });
    expect(result).toEqual({ ok: true });

    const source = await prisma.gaBigQuerySource.findUniqueOrThrow({
      where: { linkId },
    });
    expect(source).toMatchObject({
      status: "OK",
      gcpProjectId: "my-company-123456",
      datasetId: `analytics_${propertyId}`,
      lastError: null,
    });
    expect(
      await prisma.auditLog.count({
        where: { projectId: fixture.projectId, action: "ga_bigquery.source_saved" },
      }),
    ).toBe(1);
  }, 60_000);

  it("writes GaBigQueryDay rows when the runner is due", async () => {
    // Başka bir test dosyası tick kilidini az önce almış olabilir.
    await prisma.systemHeartbeat.deleteMany({ where: { key: "ga.bigquery" } });
    // Kayıt anı gerçek saatle nextRunAt'ı yazar (dosya yüklenirken yakalanan
    // `now`'dan sonra); tick'i bir dakika sonrasına koy ki kaynak vadesi gelmiş olsun.
    const processed = await GaBigQueryRunner.runDue(
      5,
      new Date(now.getTime() + 60_000),
    );
    expect(processed).toBeGreaterThanOrEqual(1);

    const days = await prisma.gaBigQueryDay.findMany({ where: { linkId } });
    expect(days).toHaveLength(28);
    const yesterday = addDays(dateToDayKey(now), -1);
    const source = await prisma.gaBigQuerySource.findUniqueOrThrow({ where: { linkId } });
    expect(source.lastDay).toBe(yesterday);
    expect(source.status).toBe("OK");
    expect(source.lastError).toBeNull();
    expect(source.usageBytes > BigInt(0)).toBe(true);
    expect(source.nextRunAt && source.nextRunAt.getTime() > now.getTime()).toBe(true);

    const row = days.find((day) => dateToDayKey(day.date) === yesterday);
    const expected = mockBigQueryDayNumbers(mockExportKeyFor(propertyId), yesterday);
    expect(row).toMatchObject({
      events: expected.events,
      users: expected.users,
      sessions: expected.sessions,
      keyEvents: expected.keyEvents,
    });
    expect(Array.isArray(row?.topEvents)).toBe(true);
    expect(Array.isArray(row?.topPages)).toBe(true);
  }, 60_000);

  it("compares the export with the warehouse as exactly 'close'", async () => {
    const view = await loadBigQueryCard(fixture.projectId, linkId);
    expect(view.state).toBe("ok");
    expect(view.suggestedDataset).toBe(`analytics_${propertyId}`);
    expect(view.compare).toMatchObject({
      level: "close",
      days: 28,
      sessionsDiffPct: 0,
      usersDiffPct: 0,
    });
    expect(view.topEvents.length).toBeGreaterThan(0);
    expect(view.topPages.length).toBeGreaterThan(0);
    expect(view.usageBytes).toBeGreaterThan(0);
  });

  it("builds three statements that pass the shared read-only check", () => {
    const statements = buildGaStatements(
      { projectId: "my-company-123456", datasetId: `analytics_${propertyId}` },
      { fromDay: "2026-09-01", toDay: "2026-09-28", keyEventNames: ["generate_lead"] },
    );
    expect(statements).not.toBeNull();
    for (const statement of [statements?.daily, statements?.events, statements?.pages]) {
      expect(() => assertReadOnlySql(statement?.sql ?? "")).not.toThrow();
    }
    // Aynı istemci yapılandırılmış sayılır (mock arka uç).
    expect(bigQueryClient().configured()).toBe(true);
  });

  it("deletes the source and its days on Disconnect and never touched the network", async () => {
    const credential = await prisma.integrationCredential.findUniqueOrThrow({
      where: { id: credentialId },
    });
    await disconnectGoogleCredential({ ...credential, metadata: {} });
    expect(await prisma.gaBigQuerySource.count({ where: { projectId: fixture.projectId } })).toBe(0);
    expect(await prisma.gaBigQueryDay.count({ where: { projectId: fixture.projectId } })).toBe(0);
    expect(fetchCalls).toBe(0);
  }, 60_000);
});
