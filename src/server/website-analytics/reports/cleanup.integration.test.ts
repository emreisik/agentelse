import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { websiteWorkId } from "@/lib/website-analytics/reports/ids";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import {
  deleteGaReportData,
  deleteGaReportDataForCredential,
} from "./cleanup";
import { GaReportRetention } from "./retention";
import { cleanupGaReportSeed, seedGaReportLink } from "./test-support";

// GA-F5 Disconnect temizliği ve saklama gerçek Postgres'e karşı: garep_
// komutu silinir, kullanıcının WEB mesajı ve Work kalır; yalnız garep_
// komutları varsa Work da gider; web.* hedefinin currentValue'su boşalır ve
// ilerleme satırı silinir; Search Console kimliği hiçbir şey silmez. Saklama:
// 100 günlük nabız silinir, 100 günlük haftalık kalır, 401 günlük aylık
// silinir.

const DAY_MS = 86_400_000;

describeIntegration("GA report cleanup and retention (GA-F5)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    sync: process.env.GA_SYNC,
    reports: process.env.GA_REPORTS,
  };
  let fixture: AgencyFixture;
  let credentialId: string;
  let linkId: string;
  let goalId: string;

  const workId = () => websiteWorkId(fixture.projectId);
  const id = (variant: string, key: string) =>
    `garep_${variant}_${fixture.projectId}_${key}`;

  function restore(name: string, value: string | undefined) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  async function seedWork(options: { withUserMessage: boolean }) {
    await prisma.work.create({
      data: {
        id: workId(),
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        title: "Website analytics",
        module: "analytics",
      },
    });
    await prisma.command.create({
      data: {
        id: id("weekly", "2026-09-28"),
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        workId: workId(),
        source: "SYSTEM",
        rawText: "",
        replyText: "Weekly website report",
      },
    });
    if (options.withUserMessage) {
      await prisma.command.create({
        data: {
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          workId: workId(),
          source: "WEB",
          rawText: "How did last week go?",
        },
      });
    }
  }

  async function seedProgress() {
    await prisma.projectGoal.update({
      where: { id: goalId },
      data: { currentValue: 321 },
    });
    await prisma.gaGoalProgress.upsert({
      where: { goalId },
      create: {
        goalId,
        linkId,
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        metricKey: "web.sessions",
        month: "2026-10",
        through: "2026-10-05",
        dayOfMonth: 5,
        daysInMonth: 31,
        monthToDate: 321,
        forecastBasis: "ok",
      },
      update: { monthToDate: 321 },
    });
  }

  beforeAll(async () => {
    process.env.GA_SYNC = "true";
    process.env.GA_REPORTS = "true";
    fixture = await createAgencyFixture(`ga-cleanup-${runId}`);
    const seeded = await seedGaReportLink({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      through: "2026-10-05",
      days: 3,
      sessions: () => 100,
    });
    credentialId = seeded.credentialId;
    linkId = seeded.linkId;
    const goal = await prisma.projectGoal.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        title: "Website sessions per month",
        metricKey: "web.sessions",
        targetValue: 3000,
        currentValue: 321,
        status: "ACTIVE",
      },
    });
    goalId = goal.id;
  });

  afterAll(async () => {
    restore("GA_SYNC", saved.sync);
    restore("GA_REPORTS", saved.reports);
    await cleanupGaReportSeed(fixture.projectId);
    await teardownAgencyFixture(fixture.workspaceId);
  });

  it("keeps the Work while the user has messages in it", async () => {
    await seedWork({ withUserMessage: true });
    await seedProgress();
    const result = await deleteGaReportDataForCredential(credentialId);
    expect(result).toEqual({ commands: 1, goals: 1, progress: 1, works: 0 });
    expect(
      await prisma.command.count({
        where: { workId: workId(), source: "SYSTEM" },
      }),
    ).toBe(0);
    expect(
      await prisma.command.count({ where: { workId: workId(), source: "WEB" } }),
    ).toBe(1);
    expect(await prisma.work.count({ where: { id: workId() } })).toBe(1);
    const goal = await prisma.projectGoal.findUniqueOrThrow({
      where: { id: goalId },
    });
    expect(goal.currentValue).toBeNull();
    expect(goal.targetValue).toBe(3000);
    expect(await prisma.gaGoalProgress.count({ where: { goalId } })).toBe(0);
  });

  it("deletes the Work too when only report cards were in it", async () => {
    await prisma.command.deleteMany({ where: { workId: workId() } });
    await prisma.work.deleteMany({ where: { id: workId() } });
    await seedWork({ withUserMessage: false });
    const result = await deleteGaReportData(fixture.projectId);
    expect(result).toMatchObject({ commands: 1, works: 1 });
    expect(await prisma.work.count({ where: { id: workId() } })).toBe(0);
  });

  it("does nothing for a Search Console credential", async () => {
    const search = await prisma.integrationCredential.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        provider: "google_search_console",
        encryptedSecret: "x",
        status: "ACTIVE",
      },
    });
    await seedWork({ withUserMessage: false });
    await seedProgress();
    expect(await deleteGaReportDataForCredential(search.id)).toEqual({
      commands: 0,
      goals: 0,
      progress: 0,
      works: 0,
    });
    expect(
      await prisma.command.count({ where: { workId: workId() } }),
    ).toBe(1);
    expect(
      (await prisma.projectGoal.findUniqueOrThrow({ where: { id: goalId } }))
        .currentValue,
    ).toBe(321);
    await prisma.command.deleteMany({ where: { workId: workId() } });
    await prisma.work.deleteMany({ where: { id: workId() } });
  });

  it("deletes expired cards by variant retention", async () => {
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
    await prisma.work.create({
      data: {
        id: workId(),
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        title: "Website analytics",
        module: "analytics",
      },
    });
    const card = (key: string, variant: string, createdAt: Date) =>
      prisma.command.create({
        data: {
          id: id(variant, key),
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          workId: workId(),
          source: "SYSTEM",
          rawText: "",
          createdAt,
        },
      });
    await card("old-pulse", "pulse", ago(100));
    await card("fresh-pulse", "pulse", ago(10));
    await card("old-weekly", "weekly", ago(100));
    await card("old-monthly", "monthly", ago(401));
    await card("fresh-monthly", "monthly", ago(399));
    await prisma.command.create({
      data: {
        id: `user-note-${runId}`,
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        workId: workId(),
        source: "WEB",
        rawText: "old user note",
        createdAt: ago(500),
      },
    });
    // Sürekli claim kilidi: önceki turu temizle ki claim alınabilsin.
    await prisma.systemHeartbeat.deleteMany({
      where: { key: "ga.reports.retention" },
    });
    const deleted = await GaReportRetention.runDue(now);
    expect(deleted).toBeGreaterThanOrEqual(2);
    const left = await prisma.command.findMany({
      where: { workId: workId() },
      select: { id: true },
    });
    expect(left.map((row) => row.id).sort()).toEqual(
      [
        id("pulse", "fresh-pulse"),
        id("weekly", "old-weekly"),
        id("monthly", "fresh-monthly"),
        `user-note-${runId}`,
      ].sort(),
    );
    // Aynı gün ikinci tur claim alamaz.
    expect(await GaReportRetention.runDue(now)).toBe(0);
  });

  it("still runs retention while the flag is off", async () => {
    delete process.env.GA_REPORTS;
    await prisma.systemHeartbeat.deleteMany({
      where: { key: "ga.reports.retention" },
    });
    await prisma.work.deleteMany({ where: { id: workId() } });
    await prisma.work.create({
      data: {
        id: workId(),
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        title: "Website analytics",
        module: "analytics",
      },
    });
    await prisma.command.create({
      data: {
        id: id("weekly", "flag-off-old"),
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        workId: workId(),
        source: "SYSTEM",
        rawText: "",
        createdAt: new Date(Date.now() - 500 * DAY_MS),
      },
    });
    try {
      expect(await GaReportRetention.runDue(new Date())).toBeGreaterThanOrEqual(
        1,
      );
      expect(
        await prisma.command.count({ where: { workId: workId() } }),
      ).toBe(0);
    } finally {
      process.env.GA_REPORTS = "true";
      await prisma.command.deleteMany({ where: { workId: workId() } });
      await prisma.work.deleteMany({ where: { id: workId() } });
    }
  });
});
