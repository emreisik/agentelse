import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { evaluationWindows } from "@/lib/seo/actions/windows";
import { addDays, dayKeyToDate, gscToday } from "@/lib/seo/dates";
import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { evaluateSplitTest } from "./evaluate";
import { GscSplitTests } from "./store";

// Bölünmüş testler gerçek Postgres'e karşı (yalnız CI ve yerel tek kullanımlık
// veritabanı; mock kipte Google'a hiç gidilmez): 3 grup x 126 sayfa, önceki 8
// hafta nötr; test ÖNCE kurulur (kollar GscSplitTestPage'den okunur), sonra
// yalnız TEST kolundaki sayfalara +%30 yazılır; açık testteki sayfa yeniden
// kullanılamaz; kullanıcı beyanı (SeoSite yok) testi hemen ölçüme geçirir;
// değerlendirme WORKED/SIGNIFICANT verir ve plaseboyu saklar; bağ silinince
// test ve atamalar cascade ile gider. Sayfalar çiftler hâlinde aynı seriyi
// taşır: kurulum gereği iki kol önceden özdeştir, plasebo deterministik geçer.

describeIntegration("GSC split tests (mock Google)", () => {
  const runId = Date.now().toString(36);
  const saved = {
    sync: process.env.GSC_SYNC,
    agency: process.env.GSC_AGENCY,
    mode: process.env.AGENTELSE_PROVIDER_MODE,
  };
  const groups = ["/g1", "/g2", "/g3"];
  const perGroup = 126;
  let fixture: AgencyFixture;
  let linkId: string;
  let testId = "";
  let appliedDay = "";
  let windows: ReturnType<typeof evaluationWindows>;
  const pages: { id: string; group: string; base: number }[] = [];

  // Aynı tabana sahip sayfalar özdeş seri taşır; hafta etkisi tabana bağlıdır.
  const clicksOf = (base: number, week: number, lift: number) =>
    Math.round(base * 4 * (1 + 0.25 * Math.sin(base * 1.7 + week * 0.9)) * lift);

  async function insertWeeks(
    weeks: readonly string[],
    offset: number,
    lift: (pageId: string) => number,
  ) {
    const data = pages.flatMap((page) =>
      weeks.map((week, index) => {
        const impressions = 200 * page.base;
        return {
          linkId,
          projectId: fixture.projectId,
          weekStart: dayKeyToDate(week),
          pageId: page.id,
          clicks: clicksOf(page.base, offset + index, lift(page.id)),
          impressions,
          positionWeighted: impressions * 5,
        };
      }),
    );
    for (let from = 0; from < data.length; from += 1000) {
      await prisma.gscWeeklyPage.createMany({ data: data.slice(from, from + 1000) });
    }
    await prisma.gscPeriodFetch.createMany({
      data: weeks.map((week) => ({
        linkId,
        projectId: fixture.projectId,
        grain: "WEEK",
        periodStart: dayKeyToDate(week),
        key: "page",
        rowCount: pages.length,
        fetchedAt: new Date(),
      })),
    });
  }

  beforeAll(async () => {
    process.env.GSC_SYNC = "true";
    process.env.GSC_AGENCY = "true";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    fixture = await createAgencyFixture(`split-${runId}`);

    appliedDay = addDays(gscToday(new Date()), -56);
    const anchor = new Date(`${appliedDay}T12:00:00.000Z`);
    windows = evaluationWindows({ measureFrom: anchor, windowDays: 28 });

    const link = await prisma.gscSiteLink.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId: `cred-${runId}`,
        siteUrl: "sc-domain:example.com",
        isPrimary: true,
        isMock: true,
        propertyType: "DOMAIN",
        permissionLevel: "siteOwner",
        health: "OK",
        lastWeeklyWeek: windows.preWeeks[windows.preWeeks.length - 1] ?? null,
      },
    });
    linkId = link.id;

    for (const group of groups) {
      for (let index = 0; index < perGroup; index += 1) {
        pages.push({
          id: `${runId}-${group.slice(1)}-${String(index).padStart(3, "0")}`,
          group,
          base: 5 + (index % 7),
        });
      }
    }
    await prisma.gscPage.createMany({
      data: pages.map((page) => ({
        id: page.id,
        linkId,
        projectId: fixture.projectId,
        url: `https://example.com${page.group}/${page.id}`,
        urlHash: `hash-${page.id}`,
        path: `${page.group}/${page.id}`,
        pageGroup: page.group,
        firstSeenWeek: dayKeyToDate(windows.preWeeks[0] ?? appliedDay),
        lastSeenWeek: dayKeyToDate(windows.preWeeks[windows.preWeeks.length - 1] ?? appliedDay),
      })),
    });
    await insertWeeks(windows.preWeeks, 0, () => 1);
  }, 120_000);

  afterAll(async () => {
    process.env.GSC_SYNC = saved.sync;
    process.env.GSC_AGENCY = saved.agency;
    process.env.AGENTELSE_PROVIDER_MODE = saved.mode;
    await prisma.gscSiteLink.deleteMany({ where: { projectId: fixture?.projectId } });
    await teardownAgencyFixture(fixture?.workspaceId);
  }, 60_000);

  it("creates a balanced test per page group", async () => {
    const result = await GscSplitTests.create({
      projectId: fixture.projectId,
      linkId,
      userId: "user-1",
      name: "Titles",
      changeKind: "TITLE_META",
      description: null,
      pageGroups: groups,
      change: { titlePattern: "{title}", metaPattern: null, schemaType: null, note: null },
      now: new Date(`${appliedDay}T12:00:00.000Z`),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    testId = result.test.id;
    expect(result.test.arms).toEqual({ test: 189, control: 189 });
    expect(result.test.perGroup).toHaveLength(3);
    for (const group of result.test.perGroup) {
      expect(group.test).toBe(63);
      expect(group.control).toBe(63);
    }
    const stored = await prisma.gscSplitTestPage.groupBy({
      by: ["arm", "pageGroup"],
      where: { testId },
      _count: { _all: true },
    });
    expect(stored).toHaveLength(6);
    expect(stored.every((row) => row._count._all === 63)).toBe(true);
  });

  it("does not let a page in an open test join another", async () => {
    const again = await GscSplitTests.create({
      projectId: fixture.projectId,
      linkId,
      userId: "user-1",
      name: "Again",
      changeKind: "TITLE_META",
      description: null,
      pageGroups: ["/g1"],
      change: { titlePattern: null, metaPattern: null, schemaType: null, note: null },
      now: new Date(`${appliedDay}T12:00:00.000Z`),
    });
    expect(again).toMatchObject({ ok: false, code: "NOT_ELIGIBLE" });
  });

  it("measures a user-asserted change and finds the lift on the test arm", async () => {
    // Test kurulduktan SONRA: yalnız TEST kolundaki sayfalara +%30.
    const assigned = await prisma.gscSplitTestPage.findMany({
      where: { testId },
      select: { pageId: true, arm: true },
    });
    const testArm = new Set(assigned.filter((row) => row.arm === "TEST").map((row) => row.pageId));
    expect(testArm.size).toBe(189);
    await insertWeeks(windows.postWeeks, windows.preWeeks.length, (pageId) =>
      testArm.has(pageId) ? 1.3 : 1,
    );
    await prisma.gscSiteLink.update({
      where: { id: linkId },
      data: { lastWeeklyWeek: windows.lastNeededWeek },
    });

    const applied = await GscSplitTests.markApplied({
      projectId: fixture.projectId,
      testId,
      userId: "user-1",
      appliedOn: appliedDay,
    });
    expect(applied).toEqual({ ok: true });
    const measuring = await prisma.gscSplitTest.findUniqueOrThrow({ where: { id: testId } });
    expect(measuring.status).toBe("EVALUATING");
    expect(measuring.measureFrom?.toISOString()).toBe(`${appliedDay}T12:00:00.000Z`);

    expect(await evaluateSplitTest(testId, new Date())).toBe("evaluated");
    const done = await prisma.gscSplitTest.findUniqueOrThrow({ where: { id: testId } });
    expect(done.status).toBe("WORKED");
    expect(done.outcome).toBe("WORKED");
    expect(done.confidence).toBe("SIGNIFICANT");
    const evaluation = done.evaluation as {
      effect: number;
      low: number;
      placebo: { passed: boolean } | null;
      usedTest: number;
      usedControl: number;
    };
    expect(evaluation.effect).toBeGreaterThan(0.2);
    expect(evaluation.low).toBeGreaterThan(0);
    expect(evaluation.placebo?.passed).toBe(true);
    expect(evaluation.usedTest).toBe(189);
    expect(evaluation.usedControl).toBe(189);

    const [view] = await GscSplitTests.list(fixture.projectId, linkId);
    expect(view?.status).toBe("WORKED");
    expect(view?.evaluation?.placebo).not.toBeNull();
  });

  it("removes the tests and assignments when the link goes away", async () => {
    await prisma.gscSiteLink.deleteMany({ where: { projectId: fixture.projectId } });
    expect(await prisma.gscSplitTest.count({ where: { projectId: fixture.projectId } })).toBe(0);
    expect(await prisma.gscSplitTestPage.count({ where: { testId } })).toBe(0);
  });
});
