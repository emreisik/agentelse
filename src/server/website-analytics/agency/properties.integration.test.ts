import { createHash, randomUUID } from "node:crypto";

import { Prisma, type GaPropertyLink } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/server/notifications/project-telegram-notifier", () => ({
  notifyProjectTelegram: vi.fn(),
}));
vi.mock("@/server/notifications/telegram.service", () => ({
  sendTelegramMessage: vi.fn(),
}));
// Anlatı ve açıklama modeli: çağrılırsa test düşer (ek mülk LLM çağırmaz).
const reasoning = vi.hoisted(() => ({
  isMockMode: vi.fn<() => boolean>(),
  run: vi.fn(),
}));
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: reasoning,
}));

import { prisma } from "@/lib/prisma";
import { gaAlertDedupeKey } from "@/lib/website-analytics/health/registry";
import { reportScopeKey, websiteWorkId } from "@/lib/website-analytics/reports/ids";
import { sampleWeeklyCard } from "@/lib/website-analytics/reports/test-fixtures";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { SiteAlerts } from "@/server/monitoring/site-alerts";
import { GaInsights } from "@/server/website-analytics/analysis/runner";
import { syncAlerts } from "@/server/website-analytics/health/checks";
import { GaHealth } from "@/server/website-analytics/health/runner";
import { loadWebsiteReportArchive } from "@/server/website-analytics/reports/read";
import { GaReports } from "@/server/website-analytics/reports/runner";
import {
  cleanupGaReportSeed,
  seedGaReportLink,
} from "@/server/website-analytics/reports/test-support";
import { GaRetention } from "@/server/website-analytics/retention";
import { ensureGaLinkForProject } from "@/server/website-analytics/sync/links";
import { GaSync } from "@/server/website-analytics/sync/runner";
import { describeIntegration } from "@/test-support/integration-suite";

import {
  addExtraGaProperty,
  loadGaProjectProperties,
  makeGaPropertyMain,
  removeExtraGaProperty,
} from "./properties";

// GA-F8 çoklu mülk gerçek Postgres'e karşı (yalnız CI ve yerel tek
// kullanımlık veritabanı; mock modda Google'a hiç gidilmez): ekleme (sınır,
// zaten bağlı, erişilemeyen, emekli satırın canlanması), ana mülk değişimi,
// kaldırma (kartlar, WEBSITE paylaşımları, uyarılar), saklama, senkron sırası,
// ek mülkte sağlık/analiz/rapor yan etkisizliği, komut kimlikleri, uyarı
// yalıtımı ve arşivin bağa göre süzülmesi.

const ENV_KEYS = [
  "GA_SYNC",
  "GA_AGENCY",
  "GA_REPORTS",
  "GA_HEALTH",
  "GA_INSIGHTS",
  "GA_CATALOG_CHECKS",
  "AGENTELSE_PROVIDER_MODE",
  "AGENTELSE_REASONING_MODE",
] as const;

// Pazartesi 2026-10-12 08:30 İstanbul; geçen hafta (5 Ekim) vadeli.
const MONDAY = new Date("2026-10-12T05:30:00.000Z");
const MONDAY_KEY = "2026-10-05";

// Json? alanı: null okunan değer yazarken Prisma.DbNull olmalı.
function jsonOrNull(
  value: Prisma.JsonValue | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describeIntegration("GA multi-property (GA-F8)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved: Record<string, string | undefined> = {};
  const fixtures: AgencyFixture[] = [];
  // Mülk kimlikleri çakışmasın diye çalıştırma başına sabit önek.
  const prop = (n: number) => `9${runId.replace(/\D/g, "").padEnd(4, "0")}${n}`;

  beforeAll(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.GA_SYNC = "true";
    process.env.GA_AGENCY = "true";
    process.env.GA_REPORTS = "true";
    process.env.GA_HEALTH = "true";
    process.env.GA_INSIGHTS = "on";
    process.env.GA_CATALOG_CHECKS = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    process.env.AGENTELSE_REASONING_MODE = "mock";
  });

  beforeEach(() => {
    reasoning.isMockMode.mockReset().mockReturnValue(true);
    reasoning.run.mockReset();
  });

  afterAll(async () => {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const fixture of fixtures) {
      await prisma.reportShare.deleteMany({
        where: { projectId: fixture.projectId },
      });
      await prisma.signal.deleteMany({ where: { projectId: fixture.projectId } });
      await prisma.brandLearning.deleteMany({
        where: { projectId: fixture.projectId },
      });
      await cleanupGaReportSeed(fixture.projectId);
      await teardownAgencyFixture(fixture.workspaceId);
    }
  }, 60_000);

  type Case = {
    fixture: AgencyFixture;
    projectId: string;
    credentialId: string;
    mainLinkId: string;
    mainPropertyId: string;
    extraIds: string[];
  };

  // Ambar tohumlu ana mülk + kimliğin erişebildiği ek mülk listesi.
  async function makeCase(name: string, extraCount = 6): Promise<Case> {
    const fixture = await createAgencyFixture(`ga-f8-${name}-${runId}`);
    fixtures.push(fixture);
    const seeded = await seedGaReportLink({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      through: "2026-10-11",
      days: 70,
      sessions: (_day, index) => 200 + (index % 7) * 10,
    });
    const main = await prisma.gaPropertyLink.findUniqueOrThrow({
      where: { id: seeded.linkId },
    });
    const extraIds = Array.from({ length: extraCount }, (_, i) =>
      prop(i + 1),
    );
    const credential = await prisma.integrationCredential.findUniqueOrThrow({
      where: { id: seeded.credentialId },
    });
    const metadata = credential.metadata as {
      ga4Properties: {
        propertyId: string;
        propertyName: string;
        accountName: string;
      }[];
    };
    await prisma.integrationCredential.update({
      where: { id: seeded.credentialId },
      data: {
        metadata: {
          ...metadata,
          ga4Properties: [
            ...metadata.ga4Properties,
            ...extraIds.map((propertyId) => ({
              propertyId,
              propertyName: `Extra ${propertyId}`,
              accountName: "Acme",
            })),
          ],
        } as unknown as Prisma.InputJsonValue,
      },
    });
    return {
      fixture,
      projectId: fixture.projectId,
      credentialId: seeded.credentialId,
      mainLinkId: seeded.linkId,
      mainPropertyId: main.propertyId,
      extraIds,
    };
  }

  // Ana mülkün ambar satırlarını ek mülke kopyalar ve bağı "senkronlanmış" yapar.
  async function seedExtraWarehouse(kase: Case, propertyId: string) {
    const link = await prisma.gaPropertyLink.findUniqueOrThrow({
      where: { projectId_propertyId: { projectId: kase.projectId, propertyId } },
    });
    const main = await prisma.gaPropertyLink.findUniqueOrThrow({
      where: { id: kase.mainLinkId },
    });
    const totals = await prisma.gaDailyTotal.findMany({
      where: { linkId: kase.mainLinkId },
    });
    await prisma.gaDailyTotal.createMany({
      data: totals.map((source) => {
        const { id, quality, ...row } = source;
        void id;
        return { ...row, linkId: link.id, quality: jsonOrNull(quality) };
      }),
    });
    const slices = await prisma.gaReportSlice.findMany({
      where: { linkId: kase.mainLinkId },
    });
    await prisma.gaReportSlice.createMany({
      data: slices.map((source) => {
        const { id, rows, otherRow, quality, ...row } = source;
        void id;
        return {
          ...row,
          linkId: link.id,
          rows: rows as Prisma.InputJsonValue,
          otherRow: jsonOrNull(otherRow),
          quality: jsonOrNull(quality),
        };
      }),
    });
    return prisma.gaPropertyLink.update({
      where: { id: link.id },
      data: {
        timeZone: main.timeZone,
        currencyCode: main.currencyCode,
        health: "OK",
        lastDailyDate: main.lastDailyDate,
        lastDailyAt: new Date(),
        lastMetadataAt: new Date(),
      },
    });
  }

  async function commandIds(projectId: string, prefix: string) {
    const rows = await prisma.command.findMany({
      where: { projectId, id: { startsWith: prefix } },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    return rows.map((row) => row.id);
  }

  it("adds extras, refuses the 5th, a duplicate, the main and an unknown property", async () => {
    const kase = await makeCase("add");
    const [e1, e2, e3, e4, e5] = kase.extraIds;
    const add = (propertyId: string | undefined) =>
      addExtraGaProperty({
        projectId: kase.projectId,
        propertyId: propertyId ?? "",
        actorUserId: "user-1",
      });

    expect(await add(e1)).toBe("ok");
    expect(await add(e2)).toBe("ok");
    expect(await add(e1)).toBe("already_linked");
    expect(await add(kase.mainPropertyId)).toBe("is_main");
    expect(await add("123")).toBe("not_accessible");
    expect(await add(e3)).toBe("ok");
    expect(await add(e4)).toBe("ok");
    expect(await add(e5)).toBe("limit");

    const state = await loadGaProjectProperties(kase.projectId);
    expect(state.primary?.id).toBe(kase.mainLinkId);
    expect(state.extras).toHaveLength(4);
    expect(state.extras.every((l) => l.isSecondary && !l.isPrimary)).toBe(true);
    expect(state.credentialStatus).toBe("ACTIVE");

    const audits = await prisma.auditLog.findMany({
      where: { projectId: kase.projectId, action: "ga_property.added" },
    });
    expect(audits).toHaveLength(4);
    expect(audits.every((a) => a.actorId === "user-1")).toBe(true);
  });

  it("revives a retired link and resets its lease and failure counters", async () => {
    const kase = await makeCase("revive");
    const [e1] = kase.extraIds;
    const otherCredential = "old-credential";
    await prisma.gaPropertyLink.create({
      data: {
        workspaceId: kase.fixture.workspaceId,
        projectId: kase.projectId,
        credentialId: otherCredential,
        propertyId: e1 ?? "",
        isPrimary: false,
        isSecondary: false,
        health: "AUTH",
        consecutiveFailures: 4,
        lastSyncError: "boom",
        syncLeaseUntil: new Date(Date.now() + 3_600_000),
        syncLeaseOwner: "ga-sync:old",
      },
    });
    expect(
      await addExtraGaProperty({ projectId: kase.projectId, propertyId: e1 ?? "" }),
    ).toBe("ok");
    const link = await prisma.gaPropertyLink.findUniqueOrThrow({
      where: {
        projectId_propertyId: { projectId: kase.projectId, propertyId: e1 ?? "" },
      },
    });
    expect(link).toMatchObject({
      isSecondary: true,
      isPrimary: false,
      credentialId: kase.credentialId,
      syncLeaseUntil: null,
      syncLeaseOwner: null,
      consecutiveFailures: 0,
      lastSyncError: null,
    });
  });

  it("swaps the main property and keeps both links", async () => {
    const kase = await makeCase("swap");
    const [e1] = kase.extraIds;
    await addExtraGaProperty({ projectId: kase.projectId, propertyId: e1 ?? "" });
    expect(
      await makeGaPropertyMain({ projectId: kase.projectId, propertyId: e1 ?? "" }),
    ).toBe("ok");

    const links = await prisma.gaPropertyLink.findMany({
      where: { projectId: kase.projectId },
    });
    expect(links).toHaveLength(2);
    const newMain = links.find((l) => l.propertyId === e1);
    const oldMain = links.find((l) => l.id === kase.mainLinkId);
    expect(newMain).toMatchObject({ isPrimary: true, isSecondary: false });
    expect(oldMain).toMatchObject({ isPrimary: false, isSecondary: true });
    const credential = await prisma.integrationCredential.findUniqueOrThrow({
      where: { id: kase.credentialId },
    });
    expect(
      (credential.metadata as { selectedGa4PropertyId: string })
        .selectedGa4PropertyId,
    ).toBe(e1);
    // Bağ eşitlemesi bu hâli bozmaz (seçili mülk = yeni ana mülk).
    await ensureGaLinkForProject(kase.projectId);
    const after = await prisma.gaPropertyLink.findMany({
      where: { projectId: kase.projectId },
    });
    expect(after.filter((l) => l.isPrimary)).toHaveLength(1);
    expect(after.find((l) => l.id === kase.mainLinkId)?.isSecondary).toBe(true);
    expect(
      await makeGaPropertyMain({ projectId: kase.projectId, propertyId: e1 ?? "" }),
    ).toBe("is_main");
  });

  it("removes an extra with its cards, WEBSITE shares and alerts, and nothing else", async () => {
    const kase = await makeCase("remove");
    const [e1] = kase.extraIds;
    await addExtraGaProperty({ projectId: kase.projectId, propertyId: e1 ?? "" });
    const extra = await prisma.gaPropertyLink.findUniqueOrThrow({
      where: {
        projectId_propertyId: { projectId: kase.projectId, propertyId: e1 ?? "" },
      },
    });
    const workId = websiteWorkId(kase.projectId);
    await prisma.work.create({
      data: {
        id: workId,
        workspaceId: kase.fixture.workspaceId,
        projectId: kase.projectId,
        title: "Website analytics",
        module: "analytics",
      },
    });
    const card = (linkId: string) =>
      ({ card: sampleWeeklyCard({ linkId }) }) as unknown as Prisma.InputJsonValue;
    const mine = `garep_weekly_${kase.projectId}_s_${extra.id}_2026-09-28`;
    const others = `garep_weekly_${kase.projectId}_2026-09-28`;
    for (const [id, linkId] of [
      [mine, extra.id],
      [others, kase.mainLinkId],
    ] as const) {
      await prisma.command.create({
        data: {
          id,
          workspaceId: kase.fixture.workspaceId,
          projectId: kase.projectId,
          workId,
          source: "SYSTEM",
          rawText: "",
          replyText: "Weekly website report",
          parsedIntent: card(linkId),
        },
      });
    }
    for (const [reportId, secret] of [
      [mine, "a"],
      [others, "b"],
    ] as const) {
      await prisma.reportShare.create({
        data: {
          workspaceId: kase.fixture.workspaceId,
          projectId: kase.projectId,
          kind: "WEBSITE",
          reportId,
          tokenHash: sha(`${runId}-${secret}`),
          branding: {},
          expiresAt: new Date(Date.now() + 86_400_000),
          createdByUserId: "user-1",
        },
      });
    }
    for (const linkId of [extra.id, kase.mainLinkId]) {
      await SiteAlerts.raise({
        workspaceId: kase.fixture.workspaceId,
        projectId: kase.projectId,
        source: "GA4",
        kind: "GA_MH1",
        severity: "WARN",
        dedupeKey: gaAlertDedupeKey(linkId, "MH1"),
        title: "Tracking problem",
      });
    }

    expect(
      await removeExtraGaProperty({
        projectId: kase.projectId,
        propertyId: e1 ?? "",
        actorUserId: "user-1",
      }),
    ).toBe("ok");

    expect(await prisma.gaPropertyLink.count({ where: { id: extra.id } })).toBe(0);
    expect(await commandIds(kase.projectId, "garep_")).toEqual([others]);
    const shares = await prisma.reportShare.findMany({
      where: { projectId: kase.projectId, kind: "WEBSITE" },
    });
    expect(shares.map((s) => s.reportId)).toEqual([others]);
    const alerts = await prisma.adsAlert.findMany({
      where: { projectId: kase.projectId, source: "GA4" },
    });
    expect(alerts.map((a) => a.dedupeKey)).toEqual([
      gaAlertDedupeKey(kase.mainLinkId, "MH1"),
    ]);
    // Ana mülk ve kendi bağı kaldırılamaz.
    expect(
      await removeExtraGaProperty({
        projectId: kase.projectId,
        propertyId: kase.mainPropertyId,
      }),
    ).toBe("is_main");
    expect(
      await prisma.auditLog.count({
        where: { projectId: kase.projectId, action: "ga_property.removed" },
      }),
    ).toBe(1);
  });

  it("keeps extras through retention but deletes retired links", async () => {
    const kase = await makeCase("retention");
    const [e1, e2] = kase.extraIds;
    await addExtraGaProperty({ projectId: kase.projectId, propertyId: e1 ?? "" });
    const retired = await prisma.gaPropertyLink.create({
      data: {
        workspaceId: kase.fixture.workspaceId,
        projectId: kase.projectId,
        credentialId: kase.credentialId,
        propertyId: e2 ?? "",
        isPrimary: false,
        isSecondary: false,
      },
    });
    const extra = await prisma.gaPropertyLink.findUniqueOrThrow({
      where: {
        projectId_propertyId: { projectId: kase.projectId, propertyId: e1 ?? "" },
      },
    });
    // updatedAt @updatedAt olduğu için ham SQL ile eskitilir.
    await prisma.$executeRaw`UPDATE "GaPropertyLink" SET "updatedAt" = NOW() - INTERVAL '90 days' WHERE "id" IN (${extra.id}, ${retired.id})`;
    await prisma.$executeRaw`DELETE FROM "SystemHeartbeat" WHERE "key" = 'ga.retention'`;
    await GaRetention.runDue(new Date());
    expect(await prisma.gaPropertyLink.count({ where: { id: extra.id } })).toBe(1);
    expect(await prisma.gaPropertyLink.count({ where: { id: retired.id } })).toBe(0);
  });

  it("syncs primaries first, always gives extras a slot and never runs catalog stages for them", async () => {
    const fixture = await createAgencyFixture(`ga-f8-sync-${runId}`);
    fixtures.push(fixture);
    const mainProp = prop(70);
    const extras = [prop(71), prop(72), prop(73)];
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
          ga4Properties: [mainProp, ...extras].map((propertyId) => ({
            propertyId,
            propertyName: `P ${propertyId}`,
            accountName: "Acme",
          })),
          selectedGa4PropertyId: mainProp,
          selectedGa4PropertyName: "Main",
        },
      },
    });
    await ensureGaLinkForProject(fixture.projectId);
    for (const propertyId of extras) {
      expect(await addExtraGaProperty({ projectId: fixture.projectId, propertyId })).toBe("ok");
    }
    // Diğer testlerin bağları sırayı bozmasın: kilitli sayılırlar.
    await prisma.gaPropertyLink.updateMany({
      where: { projectId: { not: fixture.projectId } },
      data: { syncLeaseUntil: new Date(Date.now() + 3_600_000) },
    });
    // Limit 1: ana mülk yeri alır, ekler yine de en az bir yer alır.
    const processed = await GaSync.runDue(1, new Date());
    expect(processed).toBe(2);
    const links = await prisma.gaPropertyLink.findMany({
      where: { projectId: fixture.projectId },
    });
    const main = links.find((l) => l.isPrimary);
    const synced = links.filter((l) => l.isSecondary && l.lastDailyAt !== null);
    expect(main?.lastDailyAt).not.toBeNull();
    expect(synced).toHaveLength(1);
    // Katalog denetimi (GA_CATALOG_CHECKS açık) yalnız ana mülkte yazılır.
    for (const link of links.filter((l) => l.isSecondary)) {
      expect(link.catalog).toBeNull();
    }
    await prisma.gaPropertyLink.deleteMany({ where: { projectId: fixture.projectId } });
    await prisma.integrationCredential.deleteMany({ where: { id: credential.id } });
  }, 60_000);

  it("runs health, analysis and reports for an extra without project-level side effects", async () => {
    const kase = await makeCase("engine");
    const [e1] = kase.extraIds;
    await addExtraGaProperty({ projectId: kase.projectId, propertyId: e1 ?? "" });
    const extra = await seedExtraWarehouse(kase, e1 ?? "");
    await prisma.gaReportSettings.create({
      data: {
        workspaceId: kase.fixture.workspaceId,
        projectId: kase.projectId,
        weeklyEnabled: true,
        monthlyEnabled: true,
        pulse: "notable",
        alertChat: true,
      },
    });

    // Sağlık: ek mülk için GaHealthRun ve kontrol satırları yazılır.
    await GaHealth.runDue(10, MONDAY);
    expect(await prisma.gaHealthRun.count({ where: { linkId: extra.id } })).toBe(1);
    expect(await prisma.gaHealthCheck.count({ where: { linkId: extra.id } })).toBeGreaterThan(0);

    // Analiz: bulgu yazılabilir ama Signal, BrandLearning ve LLM yok.
    const analysis = await GaInsights.analyzeLink(extra.id, { now: MONDAY });
    expect(analysis).not.toBe("busy");
    expect(await prisma.gaAnalysisRun.count({ where: { linkId: extra.id } })).toBe(1);
    expect(await prisma.signal.count({ where: { projectId: kase.projectId } })).toBe(0);
    expect(await prisma.brandLearning.count({ where: { projectId: kase.projectId } })).toBe(0);
    expect(reasoning.run).not.toHaveBeenCalled();

    // Rapor önce analizi beklemesin: analiz kapalı (kart yine de yazılır).
    process.env.GA_INSIGHTS = "";
    // Rapor: yalnız haftalık kart; kimlik kapsamlı; nabız/plan/hedef yazımı yok.
    const result = await GaReports.runLink(extra.id, { now: MONDAY, llmBudget: 3 });
    expect(typeof result).toBe("object");
    const weeklyId = `garep_weekly_${kase.projectId}_s_${extra.id}_${MONDAY_KEY}`;
    expect(await commandIds(kase.projectId, "garep_weekly_")).toEqual([weeklyId]);
    expect(await commandIds(kase.projectId, "garep_pulse_")).toEqual([]);
    expect(await commandIds(kase.projectId, "garep_plan_")).toEqual([]);
    expect(await commandIds(kase.projectId, "garep_alert_")).toEqual([]);
    const run = await prisma.gaReportRun.findUniqueOrThrow({
      where: { linkId: extra.id },
    });
    expect(run.lastWeek).toBe(MONDAY_KEY);
    expect(run).toMatchObject({
      lastGoalsDay: null,
      lastPulseDay: null,
      lastPulseAt: null,
      lastAlertScanAt: null,
      lastPlanMonth: null,
    });
    expect(reasoning.run).not.toHaveBeenCalled();
    expect(await prisma.gaGoalProgress.count({ where: { linkId: extra.id } })).toBe(0);
    const card = await prisma.command.findUniqueOrThrow({ where: { id: weeklyId } });
    expect((card.parsedIntent as { card: { linkId: string } }).card.linkId).toBe(extra.id);

    // İki mülk aynı dönemde çarpışmaz: ana mülk kendi (eski) kimliğiyle yazar.
    await GaReports.runLink(kase.mainLinkId, { now: MONDAY, llmBudget: 3 });
    const ids = await commandIds(kase.projectId, "garep_weekly_");
    expect(ids).toContain(weeklyId);
    expect(ids).toContain(`garep_weekly_${kase.projectId}_${MONDAY_KEY}`);
    expect(new Set(ids).size).toBe(2);
    expect(reportScopeKey(kase.projectId, { id: extra.id, isPrimary: false })).toBe(
      `${kase.projectId}_s_${extra.id}`,
    );
  }, 120_000);

  it("never lets one property's evaluation resolve another property's alert", async () => {
    const kase = await makeCase("alerts", 2);
    const [e1] = kase.extraIds;
    await addExtraGaProperty({ projectId: kase.projectId, propertyId: e1 ?? "" });
    const a = await prisma.gaPropertyLink.findUniqueOrThrow({ where: { id: kase.mainLinkId } });
    const b = await prisma.gaPropertyLink.findUniqueOrThrow({
      where: {
        projectId_propertyId: { projectId: kase.projectId, propertyId: e1 ?? "" },
      },
    });
    const raise = (link: GaPropertyLink) =>
      SiteAlerts.raise({
        workspaceId: kase.fixture.workspaceId,
        projectId: kase.projectId,
        source: "GA4",
        kind: "GA_MH1",
        severity: "WARN",
        dedupeKey: gaAlertDedupeKey(link.id, "MH1"),
        title: "Tracking problem",
      });
    const statusOf = async (link: GaPropertyLink) =>
      (
        await prisma.adsAlert.findUniqueOrThrow({
          where: {
            projectId_dedupeKey: {
              projectId: kase.projectId,
              dedupeKey: gaAlertDedupeKey(link.id, "MH1"),
            },
          },
        })
      ).status;

    await raise(a);
    await raise(b);
    // A değerlendirilir ve sorunu görmez: yalnız A'nın uyarısı çözülür.
    await syncAlerts(a, [], new Map(), MONDAY);
    expect(await statusOf(a)).toBe("RESOLVED");
    expect(await statusOf(b)).toBe("OPEN");
    // Tersi: B değerlendirilir, A'nın (yeniden açılan) uyarısı açık kalır.
    await raise(a);
    await syncAlerts(b, [], new Map(), MONDAY);
    expect(await statusOf(b)).toBe("RESOLVED");
    expect(await statusOf(a)).toBe("OPEN");
  });

  it("still resolves the alerts of a retired link when the new primary is evaluated", async () => {
    const kase = await makeCase("retired", 2);
    const [e1] = kase.extraIds;
    const main = await prisma.gaPropertyLink.findUniqueOrThrow({ where: { id: kase.mainLinkId } });
    // Eski seçim yolu: yeni mülk seçilir, eski ana mülk emekli olur.
    const credential = await prisma.integrationCredential.findUniqueOrThrow({
      where: { id: kase.credentialId },
    });
    await prisma.integrationCredential.update({
      where: { id: kase.credentialId },
      data: {
        metadata: {
          ...(credential.metadata as object),
          selectedGa4PropertyId: e1,
          selectedGa4PropertyName: "Extra",
        } as unknown as Prisma.InputJsonValue,
      },
    });
    await ensureGaLinkForProject(kase.projectId);
    const retired = await prisma.gaPropertyLink.findUniqueOrThrow({ where: { id: main.id } });
    expect(retired).toMatchObject({ isPrimary: false, isSecondary: false });
    const next = await prisma.gaPropertyLink.findUniqueOrThrow({
      where: {
        projectId_propertyId: { projectId: kase.projectId, propertyId: e1 ?? "" },
      },
    });
    expect(next.isPrimary).toBe(true);

    await SiteAlerts.raise({
      workspaceId: kase.fixture.workspaceId,
      projectId: kase.projectId,
      source: "GA4",
      kind: "GA_MH1",
      severity: "WARN",
      dedupeKey: gaAlertDedupeKey(retired.id, "MH1"),
      title: "Tracking problem",
    });
    await syncAlerts(next, [], new Map(), MONDAY);
    const alert = await prisma.adsAlert.findUniqueOrThrow({
      where: {
        projectId_dedupeKey: {
          projectId: kase.projectId,
          dedupeKey: gaAlertDedupeKey(retired.id, "MH1"),
        },
      },
    });
    expect(alert.status).toBe("RESOLVED");
  });

  it("filters the archive by link inside the query, even behind 12 newer cards", async () => {
    const kase = await makeCase("archive", 2);
    const [e1] = kase.extraIds;
    await addExtraGaProperty({ projectId: kase.projectId, propertyId: e1 ?? "" });
    const extra = await prisma.gaPropertyLink.findUniqueOrThrow({
      where: {
        projectId_propertyId: { projectId: kase.projectId, propertyId: e1 ?? "" },
      },
    });
    const workId = websiteWorkId(kase.projectId);
    await prisma.work.create({
      data: {
        id: workId,
        workspaceId: kase.fixture.workspaceId,
        projectId: kase.projectId,
        title: "Website analytics",
        module: "analytics",
      },
    });
    const base = Date.now();
    const post = (id: string, linkId: string, createdAt: Date) =>
      prisma.command.create({
        data: {
          id,
          workspaceId: kase.fixture.workspaceId,
          projectId: kase.projectId,
          workId,
          source: "SYSTEM",
          rawText: "",
          replyText: "Weekly website report",
          createdAt,
          parsedIntent: {
            card: sampleWeeklyCard({ linkId }),
          } as unknown as Prisma.InputJsonValue,
        },
      });
    const extraId = `garep_weekly_${kase.projectId}_s_${extra.id}_2026-08-03`;
    await post(extraId, extra.id, new Date(base - 10 * 86_400_000));
    for (let n = 0; n < 13; n += 1) {
      await post(
        `garep_weekly_${kase.projectId}_2026-09-${String(n + 1).padStart(2, "0")}`,
        kase.mainLinkId,
        new Date(base - n * 3_600_000),
      );
    }
    const unfiltered = await loadWebsiteReportArchive(kase.projectId);
    expect(unfiltered?.map((item) => item.commandId)).not.toContain(extraId);
    const filtered = await loadWebsiteReportArchive(kase.projectId, undefined, {
      linkId: extra.id,
    });
    expect(filtered?.map((item) => item.commandId)).toEqual([extraId]);
    const mainOnly = await loadWebsiteReportArchive(kase.projectId, 50, {
      linkId: kase.mainLinkId,
    });
    expect(mainOnly).toHaveLength(13);
  });
});
