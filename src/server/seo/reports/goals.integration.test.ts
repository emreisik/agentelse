import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { addDays, dayKeyToDate, dayRange } from "@/lib/seo/dates";
import type { SeoGoalMetricKey } from "@/lib/seo/reports/types";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import {
  archiveSeoGoal,
  forgetSeoGoalValues,
  listSeoGoals,
  refreshSeoGoals,
  upsertSeoGoal,
} from "./goals";

// SEO hedefleri gerçek Postgres'e karşı (yalnız CI ve yerel tek kullanımlık
// veritabanı; mock kipte Google'a gidilmez): upsert mock kipte ACTIVE, USER
// onaylı, isMock=true hedef yazar ve ikinci çağrıda hedef değerini günceller;
// yenileme son 30 kesin günün tıklamasını yazar, yeni gün gelince değer
// kayar; gerçek (isMock=false) hedef mock bağ üzerinden değişmez; markasız
// hedef ayrım yokken eski değeri korur (no_brand_split); arşiv ilerleme
// satırını siler; unutma yalnız beş tam anahtarı boşaltır.

const FINAL = "2026-10-01";
const DAYS = 120;

describeIntegration("SEO goals", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    sync: process.env.GSC_SYNC,
    mode: process.env.AGENTELSE_PROVIDER_MODE,
  };
  let fixture: AgencyFixture;
  let linkId: string;

  const goal = (metricKey: SeoGoalMetricKey, target: number) => ({
    workspaceId: fixture.workspaceId,
    projectId: fixture.projectId,
    brandId: fixture.brandId,
    userId: "user-test",
    metricKey,
    target,
  });

  beforeAll(async () => {
    process.env.GSC_SYNC = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    fixture = await createAgencyFixture(`seo-goals-${runId}`);
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
    await prisma.gscDailyTotal.createMany({
      data: dayRange(addDays(FINAL, -(DAYS - 1)), FINAL).map((day) => ({
        linkId,
        projectId: fixture.projectId,
        date: dayKeyToDate(day),
        searchType: "web",
        clicks: 100,
        impressions: 1000,
        positionWeighted: 5000,
        fresh: false,
        fetchedAt: new Date(),
      })),
    });
  }, 60_000);

  afterAll(async () => {
    process.env.GSC_SYNC = saved.sync;
    process.env.AGENTELSE_PROVIDER_MODE = saved.mode;
    await prisma.seoGoalProgress.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await prisma.projectGoal.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await prisma.gscSiteLink.deleteMany({
      where: { projectId: fixture?.projectId },
    });
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("creates an ACTIVE, user-approved, mock goal and updates the target on the second call", async () => {
    const first = await upsertSeoGoal(goal("gsc.clicks", 5000));
    expect(first.created).toBe(true);
    const row = await prisma.projectGoal.findUniqueOrThrow({
      where: { id: first.goalId },
    });
    expect(row).toMatchObject({
      metricKey: "gsc.clicks",
      status: "ACTIVE",
      approvedByType: "USER",
      approvedByUserId: "user-test",
      isMock: true,
      targetValue: 5000,
      currentValue: null,
    });
    expect(row.title).toBe("Reach 5,000 search clicks a month");
    expect(row.description).toBe(
      "Measured daily from Google Search Console (last 30 days).",
    );

    const second = await upsertSeoGoal(goal("gsc.clicks", 6000));
    expect(second).toEqual({ goalId: first.goalId, created: false });
    const updated = await prisma.projectGoal.findUniqueOrThrow({
      where: { id: first.goalId },
    });
    expect(updated.targetValue).toBe(6000);
    expect(
      await prisma.projectGoal.count({
        where: { projectId: fixture.projectId, metricKey: "gsc.clicks" },
      }),
    ).toBe(1);
  });

  it("writes the sum of the last 30 final days and moves with a new final day", async () => {
    // Gerçek (isMock=false) hedef mock bağ üzerinden değişmez.
    const real = await prisma.projectGoal.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        title: "Real clicks goal",
        metricKey: "gsc.clicks",
        targetValue: 9000,
        currentValue: 7,
        status: "ACTIVE",
        isMock: false,
      },
    });

    expect(await refreshSeoGoals(fixture.projectId)).toBe(1);
    const [goalRow] = await prisma.projectGoal.findMany({
      where: { projectId: fixture.projectId, isMock: true },
    });
    expect(goalRow?.currentValue).toBe(3000);
    const progress = await prisma.seoGoalProgress.findUniqueOrThrow({
      where: { goalId: goalRow!.id },
    });
    expect(progress).toMatchObject({
      linkId,
      isMock: true,
      value: 3000,
      measuredThrough: FINAL,
    });
    expect(
      ["achieved", "on_track", "behind", "at_risk", "unknown"].includes(
        progress.pace,
      ),
    ).toBe(true);

    // Yeni kesin gün: 500 tık; son 30 gün 29 × 100 + 500 olur.
    const next = addDays(FINAL, 1);
    await prisma.gscDailyTotal.create({
      data: {
        linkId,
        projectId: fixture.projectId,
        date: dayKeyToDate(next),
        searchType: "web",
        clicks: 500,
        impressions: 5000,
        positionWeighted: 25000,
        fresh: false,
        fetchedAt: new Date(),
      },
    });
    await prisma.gscSiteLink.update({
      where: { id: linkId },
      data: { lastFinalDate: next },
    });
    expect(await refreshSeoGoals(fixture.projectId)).toBe(1);
    const moved = await prisma.projectGoal.findUniqueOrThrow({
      where: { id: goalRow!.id },
    });
    expect(moved.currentValue).toBe(3400);

    const untouched = await prisma.projectGoal.findUniqueOrThrow({
      where: { id: real.id },
    });
    expect(untouched.currentValue).toBe(7);
    expect(
      await prisma.seoGoalProgress.count({ where: { goalId: real.id } }),
    ).toBe(0);

    const listed = await listSeoGoals(fixture.projectId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      goalId: goalRow!.id,
      current: 3400,
      target: 6000,
      measuredThrough: next,
    });
  });

  it("keeps the stored value of a non-brand goal while the brand split is missing", async () => {
    const created = await upsertSeoGoal(goal("gsc.nonBrandClicks", 2000));
    await prisma.projectGoal.update({
      where: { id: created.goalId },
      data: { currentValue: 123 },
    });
    await refreshSeoGoals(fixture.projectId);
    const row = await prisma.projectGoal.findUniqueOrThrow({
      where: { id: created.goalId },
    });
    expect(row.currentValue).toBe(123);
    const progress = await prisma.seoGoalProgress.findUniqueOrThrow({
      where: { goalId: created.goalId },
    });
    expect(progress).toMatchObject({
      value: null,
      reason: "no_brand_split",
      pace: "unknown",
    });
  });

  it("deletes the progress row when the goal is archived", async () => {
    const created = await upsertSeoGoal(goal("gsc.top10Queries", 30));
    await refreshSeoGoals(fixture.projectId);
    expect(
      await prisma.seoGoalProgress.count({ where: { goalId: created.goalId } }),
    ).toBe(1);
    expect(await archiveSeoGoal(fixture.projectId, created.goalId)).toBe(true);
    expect(
      await prisma.seoGoalProgress.count({ where: { goalId: created.goalId } }),
    ).toBe(0);
    const row = await prisma.projectGoal.findUniqueOrThrow({
      where: { id: created.goalId },
    });
    expect(row.status).toBe("ARCHIVED");
    // Başka projenin ya da SEO anahtarı olmayan hedef arşivlenmez.
    expect(await archiveSeoGoal("other-project", created.goalId)).toBe(false);
  });

  it("nulls only the five SEO keys when the values are forgotten", async () => {
    const other = (metricKey: string) =>
      prisma.projectGoal.create({
        data: {
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          brandId: fixture.brandId,
          title: `Goal ${metricKey}`,
          metricKey,
          currentValue: 5,
          status: "ACTIVE",
          isMock: true,
        },
      });
    const ads = await other("ads.cpl");
    const traffic = await other("seo.traffic");
    const seo = await other("gsc.clicks");

    expect(
      await forgetSeoGoalValues([fixture.projectId]),
    ).toBeGreaterThanOrEqual(1);
    const read = (id: string) =>
      prisma.projectGoal.findUniqueOrThrow({ where: { id } });
    expect((await read(seo.id)).currentValue).toBeNull();
    expect((await read(ads.id)).currentValue).toBe(5);
    expect((await read(traffic.id)).currentValue).toBe(5);
    expect(
      await prisma.seoGoalProgress.count({
        where: { projectId: fixture.projectId },
      }),
    ).toBe(0);
    expect(await forgetSeoGoalValues([])).toBe(0);
  });
});
