import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

// Google çağrıları sayılsın diye gerçek (mock modlu) uygulamalar sarılır.
vi.mock(
  "@/server/integrations/google-analytics/data-api",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/server/integrations/google-analytics/data-api")
      >();
    return {
      ...actual,
      runGaReport: vi.fn(actual.runGaReport),
      runGaReportBatch: vi.fn(actual.runGaReportBatch),
    };
  },
);
vi.mock(
  "@/server/integrations/google-analytics/realtime",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/server/integrations/google-analytics/realtime")
      >();
    return {
      ...actual,
      runGaRealtimeActiveUsers: vi.fn(actual.runGaRealtimeActiveUsers),
    };
  },
);

import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import { safeTimezone } from "@/lib/website-analytics/days";
import { overviewWindow } from "@/lib/website-analytics/overview";
import { sumTotals } from "@/lib/website-analytics/totals";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import {
  runGaReport,
  runGaReportBatch,
} from "@/server/integrations/google-analytics/data-api";
import { runGaRealtimeActiveUsers } from "@/server/integrations/google-analytics/realtime";
import { describeIntegration } from "@/test-support/integration-suite";

import { GaLive, resetGaLiveCaches } from "./live";
import { loadWebsiteOverview } from "./overview";
import { buildWebsiteReport } from "./report";
import { gaDataThrough, readDailyTotals } from "./store";
import { deleteGaLinksForProject, ensureGaLinkForProject } from "./sync/links";
import { GaSync } from "./sync/runner";

// Website yüzeyleri gerçek Postgres'e karşı (mock Google): canlı sayılar
// bayrakla açılır, bellekte önbelleklenir (ikinci çağrı Google'a gitmez),
// Brand kartı ambarın 28 gününü toplar, Site search bayraksız boş kalır ve
// bağ silinince canlı sayılar not_connected döner.

const reportCalls = () =>
  vi.mocked(runGaReport).mock.calls.length +
  vi.mocked(runGaReportBatch).mock.calls.length;

describeIntegration("GA Website surfaces (mock Google)", () => {
  const runId = randomUUID().slice(0, 8);
  const keys = [
    "GA_SYNC",
    "GA_WEBSITE_PAGE",
    "GA_LIVE",
    "GA_BRAND_CARD",
    "GA_WEEKLY",
    "AGENTELSE_PROVIDER_MODE",
  ] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let fixture: AgencyFixture;

  beforeAll(async () => {
    process.env.GA_SYNC = "true";
    process.env.GA_WEBSITE_PAGE = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    delete process.env.GA_LIVE;
    delete process.env.GA_BRAND_CARD;
    delete process.env.GA_WEEKLY;
    resetGaLiveCaches();
    fixture = await createAgencyFixture(`ga-live-${runId}`);
    await prisma.integrationCredential.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        provider: "google_analytics",
        accountLabel: "owner@example.com",
        encryptedSecret: "not-used-in-mock-mode",
        status: "ACTIVE",
        metadata: {
          ga4Properties: [
            { propertyId: "535353", propertyName: "Web", accountName: "Acme" },
          ],
          selectedGa4PropertyId: "535353",
          selectedGa4PropertyName: "Web",
        },
      },
    });
    // Bağ doğrudan kurulur: runDue'nun periyodik bağ eşitlemesi (ga.links
    // kilidi) aynı veritabanındaki başka bir test dosyasınca alınmış olabilir.
    await ensureGaLinkForProject(fixture.projectId);
    // Bağ, günlük çekim ve geri doldurma (tur başına en çok 10 istek).
    for (let round = 0; round < 10; round += 1) {
      await GaSync.runDue(3, new Date());
      const link = await prisma.gaPropertyLink.findFirst({
        where: { projectId: fixture.projectId },
      });
      if (link?.backfillDoneAt) break;
    }
  }, 180_000);

  afterAll(async () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetGaLiveCaches();
    await prisma.gaPropertyLink.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await prisma.integrationCredential.deleteMany({
      where: { workspaceId: fixture?.workspaceId },
    });
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("stays off without GA_LIVE", async () => {
    expect(await GaLive.todaySoFar(fixture.projectId)).toEqual({
      ok: false,
      reason: "off",
    });
    expect(await GaLive.rightNow(fixture.projectId)).toEqual({
      ok: false,
      reason: "off",
    });
  });

  it("reads today so far once and serves the second call from memory", async () => {
    process.env.GA_LIVE = "true";
    const before = reportCalls();
    const first = await GaLive.todaySoFar(fixture.projectId);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.cached).toBe(false);
    expect(first.today.sessions).toBeGreaterThan(0);
    expect(first.today.timeZone).toBe("Europe/Istanbul");
    expect(reportCalls()).toBe(before + 1);

    const second = await GaLive.todaySoFar(fixture.projectId);
    expect(second).toMatchObject({ ok: true, cached: true });
    expect(reportCalls()).toBe(before + 1);
  });

  it("reads right now once a minute per property", async () => {
    const calls = () => vi.mocked(runGaRealtimeActiveUsers).mock.calls.length;
    const before = calls();
    const at = new Date();
    const first = await GaLive.rightNow(fixture.projectId, at);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.cached).toBe(false);
    expect(first.now.activeUsers).toBeGreaterThanOrEqual(2);
    expect(first.now.activeUsers).toBeLessThanOrEqual(14);

    const second = await GaLive.rightNow(
      fixture.projectId,
      new Date(at.getTime() + 30_000),
    );
    expect(second).toMatchObject({ ok: true, cached: true });
    expect(calls()).toBe(before + 1);
  });

  it("builds the Brand card from the warehouse's last 28 days", async () => {
    expect(await loadWebsiteOverview(fixture.projectId)).toEqual({
      ok: false,
      reason: "off",
    });
    process.env.GA_BRAND_CARD = "true";
    const now = new Date();
    const overview = await loadWebsiteOverview(fixture.projectId, now);
    expect(overview.ok).toBe(true);
    if (!overview.ok) return;

    const link = await prisma.gaPropertyLink.findFirstOrThrow({
      where: { projectId: fixture.projectId },
    });
    const today = dayKeyInTimezone(now, safeTimezone(link.timeZone));
    const { through } = await gaDataThrough(link.id);
    const window = overviewWindow(today, through);
    expect(window).not.toBeNull();
    const rows = await readDailyTotals(
      link.id,
      window!.current.from,
      window!.current.to,
    );
    expect(rows).toHaveLength(28);
    const sums = sumTotals(rows);
    expect(overview.days).toBe(28);
    expect(overview.sessions).toBe(sums.sessions);
    expect(overview.keyEvents).toBe(sums.keyEvents);
    expect(overview.dataThrough).toBe(through);
    expect(overview.health).toBe("ok");
  });

  it("has no Site search table with GA_WEEKLY off", async () => {
    const result = await buildWebsiteReport(fixture.projectId, "28d");
    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    expect(result.report.siteSearch).toBeNull();
  });

  it("returns not_connected once the link is deleted", async () => {
    await deleteGaLinksForProject(fixture.projectId);
    expect(await GaLive.todaySoFar(fixture.projectId)).toEqual({
      ok: false,
      reason: "not_connected",
    });
    expect(await GaLive.rightNow(fixture.projectId)).toEqual({
      ok: false,
      reason: "not_connected",
    });
  });
});
