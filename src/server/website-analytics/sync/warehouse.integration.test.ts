import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { disconnectGoogleCredential } from "@/server/integrations/google-disconnect";
import { describeIntegration } from "@/test-support/integration-suite";

import { buildWebsiteReport } from "../report";
import { ensureGaLinkForProject } from "./links";
import { GaSync } from "./runner";

// Google Analytics ambarı gerçek Postgres'e karşı (yalnız CI ve yerel tek
// kullanımlık veritabanı; mock modda Google'a hiç gidilmez): bağ tembel
// oluşur, metadata + günlük çekim + geri doldurma ham toplu upsert'lerle
// yazılır, aynı gün yeniden yazılınca kopya oluşmaz, Website raporu ambardan
// derlenir ve Disconnect bütün veriyi siler.

describeIntegration("GA warehouse sync (mock Google)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    sync: process.env.GA_SYNC,
    mode: process.env.AGENTELSE_PROVIDER_MODE,
  };
  let fixture: AgencyFixture;
  let credentialId: string;

  beforeAll(async () => {
    process.env.GA_SYNC = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    fixture = await createAgencyFixture(`ga-${runId}`);
    const credential = await prisma.integrationCredential.create({
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
            { propertyId: "424242", propertyName: "Web", accountName: "Acme" },
          ],
          selectedGa4PropertyId: "424242",
          selectedGa4PropertyName: "Web",
        },
      },
    });
    credentialId = credential.id;
  }, 60_000);

  afterAll(async () => {
    process.env.GA_SYNC = saved.sync;
    process.env.AGENTELSE_PROVIDER_MODE = saved.mode;
    await prisma.gaPropertyLink.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await prisma.integrationCredential.deleteMany({
      where: { workspaceId: fixture?.workspaceId },
    });
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("syncs metadata, the last days and the history into the warehouse", async () => {
    // Bağ doğrudan kurulur: runDue'nun periyodik bağ eşitlemesi (ga.links
    // kilidi) aynı veritabanındaki başka bir test dosyasınca alınmış olabilir.
    await ensureGaLinkForProject(fixture.projectId);
    // Geri doldurma tur başına en çok 10 istek: birkaç tur sürer.
    for (let round = 0; round < 10; round += 1) {
      await GaSync.runDue(3, new Date());
      const link = await prisma.gaPropertyLink.findFirst({
        where: { projectId: fixture.projectId },
      });
      if (link?.backfillDoneAt) break;
    }
    const link = await prisma.gaPropertyLink.findFirstOrThrow({
      where: { projectId: fixture.projectId },
    });
    expect(link).toMatchObject({
      propertyId: "424242",
      isPrimary: true,
      isMock: true,
      timeZone: "Europe/Istanbul",
      measurementId: "G-MOCK0000",
      health: "OK",
    });
    expect(link.lastDailyAt).not.toBeNull();
    expect(link.backfillDoneAt).not.toBeNull();

    const totals = await prisma.gaDailyTotal.count({
      where: { linkId: link.id },
    });
    // Revizyon penceresi + 400 günlük geri doldurma (mülk 2025-01-01'de açıldı).
    expect(totals).toBeGreaterThan(300);
    const finals = await prisma.gaDailyTotal.count({
      where: { linkId: link.id, isFinal: true },
    });
    expect(finals).toBeGreaterThan(0);
    expect(finals).toBeLessThan(totals);

    const slice = await prisma.gaReportSlice.findFirstOrThrow({
      where: { linkId: link.id, reportKey: "channel" },
      orderBy: { periodStart: "desc" },
    });
    expect(slice.dimensionHeaders).toEqual(["sessionDefaultChannelGroup"]);
    expect(Array.isArray(slice.rows)).toBe(true);
    expect(
      await prisma.gaReportSlice.count({
        where: { linkId: link.id, reportKey: "rolling_users" },
      }),
    ).toBe(1);
    expect(
      await prisma.gaMonthlySummary.count({ where: { linkId: link.id } }),
    ).toBeGreaterThan(0);
  }, 180_000);

  it("overwrites a re-fetched day instead of adding a copy", async () => {
    const link = await prisma.gaPropertyLink.findFirstOrThrow({
      where: { projectId: fixture.projectId },
    });
    const before = await prisma.gaDailyTotal.count({
      where: { linkId: link.id },
    });
    const later = new Date(Date.now() + 10 * 60_000);
    // Mülkün saat diliminde gece yarısına 10 dakikadan az kalmışsa "10 dakika sonra" yeni bir
    // gündür ve o gün haklı olarak bir satır ekler; kopya olmadığını yine kanıtlar.
    const dayOf = (instant: Date) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: link.timeZone ?? "Europe/Istanbul",
      }).format(instant);
    const newDay = dayOf(later) !== dayOf(new Date());
    const refreshed = await GaSync.refreshNow(fixture.projectId, later);
    expect(refreshed).toBe("refreshed");
    expect(
      await prisma.gaDailyTotal.count({ where: { linkId: link.id } }),
    ).toBe(before + (newDay ? 1 : 0));
  }, 60_000);

  it("builds the Website report from the warehouse", async () => {
    const result = await buildWebsiteReport(fixture.projectId, "28d");
    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    const { report } = result;
    expect(report.coverage).toEqual({ days: 28, expected: 28 });
    expect(report.kpis.map((kpi) => kpi.key)).toEqual(
      expect.arrayContaining([
        "users",
        "sessions",
        "engagementRate",
        "keyEvents",
      ]),
    );
    expect(report.trend).toHaveLength(28);
    expect(report.channels.rows.length).toBeGreaterThan(0);
    expect(report.landingPages.rows.length).toBeGreaterThan(0);
    expect(report.keyEvents.rows.map((row) => row.label)).toContain(
      "generate_lead",
    );
  });

  it("deletes the warehouse right away on Disconnect", async () => {
    const credential = await prisma.integrationCredential.findUniqueOrThrow({
      where: { id: credentialId },
    });
    // Mock kimlik: başka bağlantı yok, Google'a iptal isteği gitmesin diye
    // hesap kimliği vermiyoruz (iptal yalnız hesap tanınınca denenir).
    await disconnectGoogleCredential({ ...credential, metadata: {} });
    expect(
      await prisma.gaPropertyLink.count({
        where: { projectId: fixture.projectId },
      }),
    ).toBe(0);
    expect(
      await prisma.gaDailyTotal.count({
        where: { projectId: fixture.projectId },
      }),
    ).toBe(0);
    expect(
      await prisma.gaReportSlice.count({
        where: { projectId: fixture.projectId },
      }),
    ).toBe(0);
  });
});
