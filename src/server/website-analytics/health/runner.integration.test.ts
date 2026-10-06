import { randomUUID } from "node:crypto";

import type { GaDailyTotal, Prisma } from "@prisma/client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import type { GaPiiProbeResult } from "@/lib/website-analytics/health/types";
import type { GaSyncContext } from "@/server/website-analytics/sync/context";

type PiiProbe = (
  ctx: GaSyncContext,
  input: { from: string; to: string; forced: boolean },
) => Promise<GaPiiProbeResult>;

const mocks = vi.hoisted(() => ({
  notifyProjectTelegram: vi.fn(),
  sendTelegramMessage: vi.fn(),
  pii: { override: null as PiiProbe | null },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/server/notifications/project-telegram-notifier", () => ({
  notifyProjectTelegram: mocks.notifyProjectTelegram,
}));
vi.mock("@/server/notifications/telegram.service", () => ({
  sendTelegramMessage: mocks.sendTelegramMessage,
}));
// PII yoklamasının yerine geçilebilen sarmalayıcı (spyOn yerine; ESM
// ad alanı yeniden tanımlanamayabilir). Geçersiz kılma yokken gerçek yol.
vi.mock("./probes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./probes")>();
  return {
    ...actual,
    runPiiProbe: (
      ctx: GaSyncContext,
      input: { from: string; to: string; forced: boolean },
    ) =>
      mocks.pii.override
        ? mocks.pii.override(ctx, input)
        : actual.runPiiProbe(ctx, input),
  };
});

import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone, zonedDateTimeToUtc } from "@/lib/timezone";
import { addDays, dayKeyToDate } from "@/lib/website-analytics/days";
import { evaluatePiiProbe } from "@/lib/website-analytics/health/pii-probe";
import { parseGaReport } from "@/lib/website-analytics/response";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { disconnectGoogleCredential } from "@/server/integrations/google-disconnect";
import { ensureGaLinkForProject } from "@/server/website-analytics/sync/links";
import { GaSync } from "@/server/website-analytics/sync/runner";
import { describeIntegration } from "@/test-support/integration-suite";

import { loadMeasurementHealth, readGaSuspectDays } from "./read";
import { GaHealth } from "./runner";

// GA-F3 ölçüm sağlığı gerçek Postgres'e karşı (yalnız CI ve yerel tek
// kullanımlık veritabanı; mock modda Google'a ve siteye hiç gidilmez): ilk
// tur 25 kontrol satırı, puan, parmak izi ve mock site sonucu yazar; ikinci
// tur boş geçer. Kesinti tatbikatı: dünün satırı silinince (etiket kaldırıldı)
// "I fixed it" MH1'i CRITICAL yapar, tek GA4 uyarısı ve projenin kendi
// Telegram'ına rakamsız tek mesaj gider; satır dönünce uyarı ve şüpheli gün
// temizlenir. MH12 tatbikatında ham adres hiçbir yere yazılmaz. Mülk
// değişince eski bağın uyarıları çözülür; birincil bağı kalmayan projenin
// uyarılarını günlük temizlik çözer; Disconnect her şeyi siler.

const TIME_ZONE = "Europe/Istanbul";

function textWithoutUrlAndName(text: string, projectName: string): string {
  return text.replaceAll(projectName, "").replace(/https?:\/\/\S+/g, "");
}

describeIntegration("GA measurement health (mock Google)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    sync: process.env.GA_SYNC,
    health: process.env.GA_HEALTH,
    websitePage: process.env.GA_WEBSITE_PAGE,
    mode: process.env.AGENTELSE_PROVIDER_MODE,
    devNotifications: process.env.ALLOW_DEV_NOTIFICATIONS,
  };
  const today = dayKeyInTimezone(new Date(), TIME_ZONE);
  const yesterday = addDays(today, -1);
  // Mülk saatiyle 17:00: günlük çekim penceresi ve realtime saatleri içinde.
  const now = zonedDateTimeToUtc(`${today}T17:00`, TIME_ZONE);
  const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
  let fixture: AgencyFixture;
  let credentialId: string;
  let linkId: string;
  let projectName: string;
  let removedDay: GaDailyTotal | null = null;

  function restoreEnv(name: keyof typeof saved, key: string) {
    const value = saved[name];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  beforeAll(async () => {
    process.env.GA_SYNC = "true";
    process.env.GA_HEALTH = "true";
    process.env.GA_WEBSITE_PAGE = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    process.env.ALLOW_DEV_NOTIFICATIONS = "true";
    fixture = await createAgencyFixture(`ga-health-${runId}`);
    const project = await prisma.project.update({
      where: { id: fixture.projectId },
      data: { domain: "example.com" },
      select: { name: true },
    });
    projectName = project.name;
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
    // Projenin kendi Telegram bağlantısı (gönderim mock'ta).
    await prisma.integrationCredential.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        provider: "telegram",
        encryptedSecret: "not-used-in-tests",
        status: "ACTIVE",
        metadata: { chatId: "c1" },
      },
    });
  }, 60_000);

  afterAll(async () => {
    restoreEnv("sync", "GA_SYNC");
    restoreEnv("health", "GA_HEALTH");
    restoreEnv("websitePage", "GA_WEBSITE_PAGE");
    restoreEnv("mode", "AGENTELSE_PROVIDER_MODE");
    restoreEnv("devNotifications", "ALLOW_DEV_NOTIFICATIONS");
    mocks.pii.override = null;
    await prisma.adsAlert.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await prisma.gaPropertyLink.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await prisma.integrationCredential.deleteMany({
      where: { workspaceId: fixture?.workspaceId },
    });
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("evaluates a synced link once and stores the results", async () => {
    await ensureGaLinkForProject(fixture.projectId);
    for (let round = 0; round < 10; round += 1) {
      await GaSync.runDue(3, now);
      const link = await prisma.gaPropertyLink.findFirst({
        where: { projectId: fixture.projectId },
      });
      if (link?.backfillDoneAt) break;
    }
    const synced = await prisma.gaPropertyLink.findFirstOrThrow({
      where: { projectId: fixture.projectId },
    });
    expect(synced.backfillDoneAt).not.toBeNull();
    // 17:00'de dün geldiyse günlük çekim lastDailyDate = bugün yazar; tatbikat
    // bunu varsayar.
    await prisma.gaPropertyLink.update({
      where: { id: synced.id },
      data: { lastDailyDate: today },
    });
    linkId = synced.id;

    expect(await GaHealth.runDue(5, now)).toBeGreaterThanOrEqual(1);

    expect(await prisma.gaHealthCheck.count({ where: { linkId } })).toBe(25);
    const link = await prisma.gaPropertyLink.findUniqueOrThrow({
      where: { id: linkId },
    });
    expect(link.healthScore).not.toBeNull();
    const run = await prisma.gaHealthRun.findUniqueOrThrow({
      where: { linkId },
    });
    expect(run.fingerprint).not.toBeNull();
    expect(run.evaluatedAt?.getTime()).toBe(now.getTime());
    expect(run.leaseOwner).toBeNull();
    expect(run.siteTag).toMatchObject({ v: 1, host: "example.com" });
    expect(run.siteCheckedAt?.getTime()).toBe(now.getTime());
  }, 240_000);

  it("skips the link on the next tick", async () => {
    expect(await GaHealth.runDue(5, now)).toBe(0);
  });

  it("turns a removed tag into a CRITICAL alert sent only to the project's Telegram", async () => {
    mocks.notifyProjectTelegram.mockClear();
    mocks.sendTelegramMessage.mockClear();
    const removed = await prisma.gaDailyTotal.delete({
      where: { linkId_date: { linkId, date: dayKeyToDate(yesterday) } },
    });
    expect(removed.sessions).toBeGreaterThan(0);

    expect(await GaHealth.recheckNow(fixture.projectId, at(0))).toBe(
      "rechecked",
    );

    const mh1 = await prisma.gaHealthCheck.findUniqueOrThrow({
      where: { linkId_checkKey: { linkId, checkKey: "MH1" } },
    });
    expect(mh1).toMatchObject({ status: "FAIL", severity: "CRITICAL" });
    expect(mh1.evidence).toMatchObject({ synthetic: true });
    expect(mh1.firstFailedAt).not.toBeNull();

    const alerts = await prisma.adsAlert.findMany({
      where: { projectId: fixture.projectId, kind: "GA_MH1" },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      source: "GA4",
      status: "OPEN",
      severity: "CRITICAL",
      dedupeKey: `ga4:${linkId}:MH1`,
    });

    const texts = mocks.notifyProjectTelegram.mock.calls.map((call) =>
      String(call[1]),
    );
    const mh1Texts = texts.filter((text) =>
      text.includes("Google Analytics stopped receiving data"),
    );
    expect(mh1Texts).toHaveLength(1);
    for (const text of texts) {
      expect(text).toContain("/site");
      expect(textWithoutUrlAndName(text, projectName)).not.toMatch(/\d/);
    }
    expect(mocks.notifyProjectTelegram.mock.calls[0]?.[0]).toBe(
      fixture.projectId,
    );
    expect(mocks.sendTelegramMessage).not.toHaveBeenCalled();

    const suspect = await readGaSuspectDays(linkId, yesterday, yesterday);
    expect(suspect.get(yesterday)).toContain("MH1");

    // Kesinti satırı daha sonra geri gelir.
    removedDay = removed;
  }, 120_000);

  it("keeps one alert and sends no second Telegram on a forced re-evaluation", async () => {
    mocks.notifyProjectTelegram.mockClear();
    expect(await GaHealth.recheckNow(fixture.projectId, at(11))).toBe(
      "rechecked",
    );
    expect(
      await prisma.adsAlert.count({
        where: {
          projectId: fixture.projectId,
          dedupeKey: `ga4:${linkId}:MH1`,
        },
      }),
    ).toBe(1);
    const mh1Texts = mocks.notifyProjectTelegram.mock.calls.filter((call) =>
      String(call[1]).includes("Google Analytics stopped receiving data"),
    );
    expect(mh1Texts).toHaveLength(0);
  }, 120_000);

  it("is throttled for ten minutes after a check", async () => {
    expect(await GaHealth.recheckNow(fixture.projectId, at(15))).toBe(
      "throttled",
    );
  });

  it("resolves the alert and clears the suspect day once the day arrives", async () => {
    const removed = removedDay;
    expect(removed).not.toBeNull();
    if (!removed) return;
    const { quality, ...row } = removed;
    await prisma.gaDailyTotal.create({
      data: {
        ...row,
        ...(quality === null
          ? {}
          : { quality: quality as Prisma.InputJsonValue }),
      },
    });

    expect(await GaHealth.recheckNow(fixture.projectId, at(22))).toBe(
      "rechecked",
    );
    const alert = await prisma.adsAlert.findUniqueOrThrow({
      where: {
        projectId_dedupeKey: {
          projectId: fixture.projectId,
          dedupeKey: `ga4:${linkId}:MH1`,
        },
      },
    });
    expect(alert.status).toBe("RESOLVED");
    const mh1 = await prisma.gaHealthCheck.findUniqueOrThrow({
      where: { linkId_checkKey: { linkId, checkKey: "MH1" } },
    });
    expect(mh1.status).toBe("PASS");
    expect(mh1.firstFailedAt).toBeNull();
    const suspect = await readGaSuspectDays(linkId, yesterday, yesterday);
    expect(suspect.size).toBe(0);
  }, 120_000);

  it("never stores the personal data a PII probe finds (MH12 drill)", async () => {
    mocks.notifyProjectTelegram.mockClear();
    mocks.pii.override = async (ctx, input) =>
      evaluatePiiProbe(
        parseGaReport({
          dimensionHeaders: [{ name: "pagePathPlusQueryString" }],
          metricHeaders: [{ name: "screenPageViews", type: "TYPE_INTEGER" }],
          rows: [
            {
              dimensionValues: [
                { value: "/signup?email=jane.doe@example.com" },
              ],
              metricValues: [{ value: "3" }],
            },
          ],
          rowCount: 1,
        }),
        { at: ctx.now.toISOString(), ...input },
      );
    try {
      expect(await GaHealth.recheckNow(fixture.projectId, at(33))).toBe(
        "rechecked",
      );
    } finally {
      mocks.pii.override = null;
    }

    const run = await prisma.gaHealthRun.findUniqueOrThrow({
      where: { linkId },
    });
    expect(run.piiProbe).toMatchObject({
      email: true,
      params: ["email"],
      pages: 1,
      views: 3,
      forced: true,
    });
    const mh12 = await prisma.gaHealthCheck.findUniqueOrThrow({
      where: { linkId_checkKey: { linkId, checkKey: "MH12" } },
    });
    expect(mh12).toMatchObject({ status: "FAIL", severity: "CRITICAL" });

    const checks = await prisma.gaHealthCheck.findMany({ where: { linkId } });
    const alerts = await prisma.adsAlert.findMany({
      where: { projectId: fixture.projectId },
      select: { title: true, detail: true, data: true },
    });
    const written = [
      JSON.stringify(checks.map((check) => check.evidence)),
      JSON.stringify(run.piiProbe),
      JSON.stringify(alerts),
      ...mocks.notifyProjectTelegram.mock.calls.map((call) => String(call[1])),
    ];
    for (const value of written) {
      expect(value).not.toContain("jane.doe");
      expect(value).not.toContain("@example");
    }
  }, 120_000);

  it("resolves the previous link's alerts after a property switch", async () => {
    const before = await prisma.adsAlert.count({
      where: {
        projectId: fixture.projectId,
        dedupeKey: { startsWith: `ga4:${linkId}:` },
        status: { in: ["OPEN", "ACKED", "MUTED"] },
      },
    });
    expect(before).toBeGreaterThan(0);

    const second = await prisma.gaPropertyLink.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId,
        propertyId: "434343",
        isPrimary: false,
        isMock: true,
        timeZone: TIME_ZONE,
        measurementId: "G-MOCK0001",
        lastMetadataAt: now,
        lastDailyDate: today,
      },
    });
    await prisma.gaPropertyLink.update({
      where: { id: linkId },
      data: { isPrimary: false },
    });
    await prisma.gaPropertyLink.update({
      where: { id: second.id },
      data: { isPrimary: true },
    });

    expect(await GaHealth.runDue(5, at(44))).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.gaHealthRun.count({ where: { linkId: second.id } }),
    ).toBe(1);
    expect(
      await prisma.adsAlert.count({
        where: {
          projectId: fixture.projectId,
          dedupeKey: { startsWith: `ga4:${linkId}:` },
          status: { in: ["OPEN", "ACKED", "MUTED"] },
        },
      }),
    ).toBe(0);
  }, 120_000);

  it("resolves open alerts of a project without a primary link in housekeeping", async () => {
    await prisma.gaPropertyLink.updateMany({
      where: { projectId: fixture.projectId },
      data: { isPrimary: false },
    });
    const dedupeKey = `ga4:${linkId}:MH24`;
    await prisma.adsAlert.upsert({
      where: {
        projectId_dedupeKey: { projectId: fixture.projectId, dedupeKey },
      },
      create: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        source: "GA4",
        kind: "GA_MH24",
        severity: "CRITICAL",
        status: "OPEN",
        dedupeKey,
        title: "Google Analytics access was lost",
      },
      update: { status: "OPEN", resolvedAt: null },
    });
    // Günlük temizlik kilidi bu test için serbest bırakılır.
    await prisma.systemHeartbeat.deleteMany({
      where: { key: "ga.health.housekeeping" },
    });

    await GaHealth.runDue(5, at(55));

    expect(
      await prisma.adsAlert.count({
        where: {
          projectId: fixture.projectId,
          source: "GA4",
          status: { in: ["OPEN", "ACKED", "MUTED"] },
        },
      }),
    ).toBe(0);
  }, 120_000);

  it("deletes checks, runs and GA4 alerts on Disconnect", async () => {
    expect(
      await prisma.adsAlert.count({
        where: { projectId: fixture.projectId, source: "GA4" },
      }),
    ).toBeGreaterThan(0);
    const credential = await prisma.integrationCredential.findUniqueOrThrow({
      where: { id: credentialId },
    });
    // Mock kimlik: Google'a iptal isteği gitmesin diye hesap kimliği yok.
    await disconnectGoogleCredential({ ...credential, metadata: {} });

    expect(
      await prisma.gaHealthCheck.count({
        where: { projectId: fixture.projectId },
      }),
    ).toBe(0);
    expect(
      await prisma.gaHealthRun.count({
        where: { projectId: fixture.projectId },
      }),
    ).toBe(0);
    expect(
      await prisma.adsAlert.count({
        where: { projectId: fixture.projectId, source: "GA4" },
      }),
    ).toBe(0);
  }, 60_000);

  it("does nothing while GA_HEALTH is unset", async () => {
    delete process.env.GA_HEALTH;
    try {
      expect(await GaHealth.runDue(5, at(66))).toBe(0);
      expect(await loadMeasurementHealth(fixture.projectId, at(66))).toBeNull();
    } finally {
      process.env.GA_HEALTH = "true";
    }
  });
});
