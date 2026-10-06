import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { dayKeyToDate } from "@/lib/website-analytics/days";
import type { PlanTargetProposal } from "@/lib/website-analytics/reports/types";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { GaGoals } from "./goals";
import { cleanupGaReportSeed, seedGaReportLink } from "./test-support";

// GA-F5 web.* hedefleri gerçek Postgres'e karşı (kabul: currentValue her gün
// güncellenir): refreshLink ay başından bugüne toplamı currentValue'ya yazar
// ve expectedShare'li ilerleme satırı tutar; ertesi gün değer değişir; hedef
// düzenlenince tempo yeni hedefle hesaplanır; hedef silinince ilerleme satırı
// gider; silinmiş bağ "gone" döner ve değere dokunulmaz; applyPlanTargets
// hedefi önce oluşturur, sonra günceller; bayrak kapalıyken refreshProject 0.

const THROUGH = "2026-10-05";
const NEXT = "2026-10-06";
const now = new Date("2026-10-07T08:00:00.000Z");

function proposalOf(
  metricKey: PlanTargetProposal["metricKey"],
  suggested: number,
): PlanTargetProposal {
  return {
    metricKey,
    label: "Key events",
    format: "count",
    baseline: 100,
    baselineMonths: 3,
    seasonalPct: null,
    realistic: suggested,
    low: suggested,
    high: suggested,
    suggested,
    currentGoal: null,
  };
}

describeIntegration("GA goals (GA-F5)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    sync: process.env.GA_SYNC,
    reports: process.env.GA_REPORTS,
  };
  let fixture: AgencyFixture;
  let linkId: string;
  let goalId: string;

  function restore(name: string, value: string | undefined) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  const link = () =>
    prisma.gaPropertyLink.findUniqueOrThrow({ where: { id: linkId } });
  const goal = (id: string) =>
    prisma.projectGoal.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    process.env.GA_SYNC = "true";
    process.env.GA_REPORTS = "true";
    fixture = await createAgencyFixture(`ga-goals-${runId}`);
    const seeded = await seedGaReportLink({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      through: THROUGH,
      days: 90,
      sessions: () => 100,
    });
    linkId = seeded.linkId;
    const created = await prisma.projectGoal.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        title: "Website sessions per month",
        metricKey: "web.sessions",
        targetValue: 3000,
        status: "ACTIVE",
      },
    });
    goalId = created.id;
  });

  afterAll(async () => {
    restore("GA_SYNC", saved.sync);
    restore("GA_REPORTS", saved.reports);
    await cleanupGaReportSeed(fixture.projectId);
    await teardownAgencyFixture(fixture.workspaceId);
  });

  it("writes the month-to-date value and progress", async () => {
    const result = await GaGoals.refreshLink({
      link: await link(),
      through: THROUGH,
      country: null,
      now,
    });
    expect(result).toBe(1);
    // 1-5 Ekim: 5 gün x 100 oturum.
    expect((await goal(goalId)).currentValue).toBe(500);
    const progress = await prisma.gaGoalProgress.findUniqueOrThrow({
      where: { goalId },
    });
    expect(progress).toMatchObject({
      linkId,
      projectId: fixture.projectId,
      metricKey: "web.sessions",
      month: "2026-10",
      through: THROUGH,
      dayOfMonth: 5,
      daysInMonth: 31,
      monthToDate: 500,
      forecastBasis: "ok",
    });
    expect(progress.expectedShare).toBeGreaterThan(0);
    expect(progress.expectedShare).toBeLessThan(1);
    expect(progress.forecast).toBeCloseTo(3100, 0);
    // Aynı gün için ikinci yenileme değer değiştirmez.
    expect(
      await GaGoals.refreshLink({
        link: await link(),
        through: THROUGH,
        country: null,
        now,
      }),
    ).toBe(0);
  });

  it("changes the value when the next day arrives", async () => {
    await prisma.gaDailyTotal.create({
      data: {
        linkId,
        projectId: fixture.projectId,
        date: dayKeyToDate(NEXT),
        sessions: 100,
        engagedSessions: 60,
        keyEvents: 5,
        fetchedAt: now,
      },
    });
    const result = await GaGoals.refreshLink({
      link: await link(),
      through: NEXT,
      country: null,
      now,
    });
    expect(result).toBe(1);
    expect((await goal(goalId)).currentValue).toBe(600);
    expect(
      (await prisma.gaGoalProgress.findUniqueOrThrow({ where: { goalId } }))
        .dayOfMonth,
    ).toBe(6);
  });

  it("computes pace with the current target when it is edited", async () => {
    const [onTrack] = await GaGoals.loadProgress(fixture.projectId);
    expect(onTrack).toMatchObject({
      goalId,
      metricKey: "web.sessions",
      target: 3000,
      monthToDate: 600,
      pace: "on_track",
    });
    await prisma.projectGoal.update({
      where: { id: goalId },
      data: { targetValue: 100 },
    });
    expect((await GaGoals.loadProgress(fixture.projectId))[0]).toMatchObject({
      target: 100,
      pace: "achieved",
    });
    await prisma.projectGoal.update({
      where: { id: goalId },
      data: { targetValue: 1_000_000 },
    });
    const behind = (await GaGoals.loadProgress(fixture.projectId))[0];
    expect(behind?.target).toBe(1_000_000);
    expect(behind?.pace).toBe("behind");
    await prisma.projectGoal.update({
      where: { id: goalId },
      data: { targetValue: 3000 },
    });
  });

  it("returns no progress while the flag is off and no refresh", async () => {
    delete process.env.GA_REPORTS;
    expect(await GaGoals.loadProgress(fixture.projectId)).toEqual([]);
    expect(await GaGoals.refreshProject(fixture.projectId, now)).toBe(0);
    process.env.GA_REPORTS = "true";
    expect(await GaGoals.loadProgress(fixture.projectId)).toHaveLength(1);
  });

  it("removes progress when the goal is deleted", async () => {
    await prisma.projectGoal.delete({ where: { id: goalId } });
    expect(
      await GaGoals.refreshLink({
        link: await link(),
        through: NEXT,
        country: null,
        now,
      }),
    ).toBe(0);
    expect(
      await prisma.gaGoalProgress.count({ where: { goalId } }),
    ).toBe(0);
    expect(await GaGoals.loadProgress(fixture.projectId)).toEqual([]);
  });

  it("creates then updates a goal from plan targets", async () => {
    const proposals = [proposalOf("web.key_events", 120)];
    expect(
      await GaGoals.applyPlanTargets({
        projectId: fixture.projectId,
        workspaceId: fixture.workspaceId,
        userId: "user-1",
        proposals,
        metricKeys: ["web.key_events", "web.sessions"],
        isMock: false,
      }),
    ).toEqual({ created: 1, updated: 0 });
    const created = await prisma.projectGoal.findFirstOrThrow({
      where: { projectId: fixture.projectId, metricKey: "web.key_events" },
    });
    expect(created).toMatchObject({
      title: "Website key events per month",
      targetValue: 120,
      status: "ACTIVE",
      approvedByType: "USER",
      approvedByUserId: "user-1",
      priority: 2,
      brandId: fixture.brandId,
    });
    expect(
      await GaGoals.applyPlanTargets({
        projectId: fixture.projectId,
        workspaceId: fixture.workspaceId,
        userId: "user-2",
        proposals: [proposalOf("web.key_events", 150)],
        metricKeys: ["web.key_events"],
        isMock: false,
      }),
    ).toEqual({ created: 0, updated: 1 });
    const updated = await goal(created.id);
    expect(updated.targetValue).toBe(150);
    expect(updated.approvedByUserId).toBe("user-2");
    expect(
      await prisma.projectGoal.count({
        where: { projectId: fixture.projectId, metricKey: "web.key_events" },
      }),
    ).toBe(1);
  });

  it("returns gone and leaves the value when the link was deleted", async () => {
    const tracked = await prisma.projectGoal.findFirstOrThrow({
      where: { projectId: fixture.projectId, metricKey: "web.key_events" },
    });
    await prisma.projectGoal.update({
      where: { id: tracked.id },
      data: { currentValue: 42 },
    });
    const stale = await link();
    await prisma.gaPropertyLink.delete({ where: { id: linkId } });
    expect(
      await GaGoals.refreshLink({
        link: stale,
        through: NEXT,
        country: null,
        now,
      }),
    ).toBe("gone");
    expect((await goal(tracked.id)).currentValue).toBe(42);
    expect(
      await prisma.gaGoalProgress.count({
        where: { projectId: fixture.projectId },
      }),
    ).toBe(0);
  });
});
