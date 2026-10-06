import { randomUUID } from "node:crypto";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

// Anlatı modeli: varsayılan mock mod (anlatı yok); bir testte gerçek mod ve
// bir destekli + bir uydurma rakamlı cümle döner.
const reasoning = vi.hoisted(() => ({
  isMockMode: vi.fn<() => boolean>(),
  run: vi.fn(),
}));
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: reasoning,
}));

import { prisma } from "@/lib/prisma";
import { addDays, dayKeyToDate } from "@/lib/website-analytics/days";
import {
  reportCommandId,
  websiteWorkId,
} from "@/lib/website-analytics/reports/ids";
import type {
  MonthlyBody,
  PlanBody,
  WebsiteReportCardData,
  WeeklyBody,
} from "@/lib/website-analytics/reports/types";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { loadGaReportContext } from "./inputs";
import { GaReports } from "./runner";
import { cleanupGaReportSeed, seedGaReportLink } from "./test-support";
import { GaWeeklyReport } from "./weekly";

// GA-F5 rapor motoru gerçek Postgres'e karşı (yalnız CI ve yerel tek
// kullanımlık veritabanı; Google'a ve gerçek modele gidilmez): Pazartesi
// 08:00 öncesi haftalık rapor yok, sonrası var; KPI'lar tohumlanan
// ambar satırlarının toplamıdır; yalnız destekli cümle saklanır; yazılmış kart
// ambar değişse de değişmez; nabız yalnız kayda değer günde yazılır ve
// arşivlenmiş sohbeti açmaz; aylık rapor ve plan TEK turda yazılır, aylık
// hedef sonucu bitmiş ayın toplamıdır; ay ortası plan gelecek ayı hedefler;
// arşivli sohbet haftalık yazımla açılır; kritik uyarı bir kez kart olur,
// WARN -> CRITICAL yükselmesi yeni kart yazar; ayar kapalıysa rapor yok.

const TZ_NOW_MONDAY_0730 = new Date("2026-10-12T04:30:00.000Z");
const TZ_NOW_MONDAY_0830 = new Date("2026-10-12T05:30:00.000Z");

function dayRange(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

// Tohumun günlük oturum serisi: gün -> oturum (test-support ile aynı sıra).
function seriesOf(
  through: string,
  days: number,
  sessions: (day: string, index: number) => number,
): Map<string, number> {
  const start = addDays(through, -(days - 1));
  const series = new Map<string, number>();
  for (let index = 0; index < days; index += 1) {
    const day = addDays(start, index);
    series.set(day, Math.max(0, Math.round(sessions(day, index))));
  }
  return series;
}

function sumOf(
  series: ReadonlyMap<string, number>,
  from: string,
  to: string,
  map: (sessions: number) => number = (sessions) => sessions,
): number {
  let total = 0;
  for (const day of dayRange(from, to)) total += map(series.get(day) ?? 0);
  return total;
}

const steady = (_day: string, index: number) => 200 + (index % 7) * 10;
// Hafta içi gürültülü ama sabit seri; son gün seed çağrısında ezilir.
const noisy = (_day: string, index: number) => 300 + (index % 3) * 3;

function weeklyBody(card: WebsiteReportCardData | null): WeeklyBody {
  if (!card || card.body.variant !== "weekly") {
    throw new Error("weekly card missing");
  }
  return card.body;
}
function monthlyBody(card: WebsiteReportCardData | null): MonthlyBody {
  if (!card || card.body.variant !== "monthly") {
    throw new Error("monthly card missing");
  }
  return card.body;
}
function planBody(card: WebsiteReportCardData | null): PlanBody {
  if (!card || card.body.variant !== "plan") {
    throw new Error("plan card missing");
  }
  return card.body;
}

async function commandExists(id: string): Promise<boolean> {
  return (await prisma.command.count({ where: { id } })) === 1;
}

async function cardOf(id: string): Promise<WebsiteReportCardData | null> {
  const row = await prisma.command.findUnique({
    where: { id },
    select: { parsedIntent: true },
  });
  const intent = row?.parsedIntent as unknown as {
    card?: WebsiteReportCardData;
  } | null;
  return intent?.card ?? null;
}

async function cardCount(projectId: string, variant: string): Promise<number> {
  return prisma.command.count({
    where: { projectId, id: { startsWith: `garep_${variant}_` } },
  });
}

describeIntegration("GA reports runner (GA-F5)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    sync: process.env.GA_SYNC,
    reports: process.env.GA_REPORTS,
    insights: process.env.GA_INSIGHTS,
    health: process.env.GA_HEALTH,
    weekly: process.env.GA_WEEKLY,
    page: process.env.GA_WEBSITE_PAGE,
    provider: process.env.AGENTELSE_PROVIDER_MODE,
    reasoning: process.env.AGENTELSE_REASONING_MODE,
  };
  const fixtures: AgencyFixture[] = [];

  type Case = {
    fixture: AgencyFixture;
    projectId: string;
    linkId: string;
    series: Map<string, number>;
  };

  // Her test kendi projesinde koşar: durum paylaşılmaz.
  async function makeCase(input: {
    name: string;
    through: string;
    days: number;
    sessions: (day: string, index: number) => number;
    settings?: Partial<{
      weeklyEnabled: boolean;
      monthlyEnabled: boolean;
      pulse: string;
      alertChat: boolean;
    }>;
    run?: Partial<{
      lastWeek: string;
      lastMonth: string;
      lastPlanMonth: string;
    }>;
  }): Promise<Case> {
    const fixture = await createAgencyFixture(`ga-rep-${input.name}-${runId}`);
    fixtures.push(fixture);
    const seeded = await seedGaReportLink({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      through: input.through,
      days: input.days,
      sessions: input.sessions,
    });
    await prisma.gaReportSettings.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        weeklyEnabled: false,
        monthlyEnabled: false,
        pulse: "off",
        alertChat: false,
        ...input.settings,
      },
    });
    if (input.run) {
      await prisma.gaReportRun.create({
        data: {
          linkId: seeded.linkId,
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          ...input.run,
        },
      });
    }
    return {
      fixture,
      projectId: fixture.projectId,
      linkId: seeded.linkId,
      series: seriesOf(input.through, input.days, input.sessions),
    };
  }

  beforeAll(() => {
    process.env.GA_SYNC = "true";
    process.env.GA_REPORTS = "true";
    process.env.GA_INSIGHTS = "";
    process.env.GA_HEALTH = "";
    process.env.GA_WEEKLY = "";
    process.env.GA_WEBSITE_PAGE = "";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    process.env.AGENTELSE_REASONING_MODE = "mock";
  });

  beforeEach(() => {
    reasoning.isMockMode.mockReset().mockReturnValue(true);
    reasoning.run.mockReset();
  });

  afterAll(async () => {
    for (const [key, value] of [
      ["GA_SYNC", saved.sync],
      ["GA_REPORTS", saved.reports],
      ["GA_INSIGHTS", saved.insights],
      ["GA_HEALTH", saved.health],
      ["GA_WEEKLY", saved.weekly],
      ["GA_WEBSITE_PAGE", saved.page],
      ["AGENTELSE_PROVIDER_MODE", saved.provider],
      ["AGENTELSE_REASONING_MODE", saved.reasoning],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const fixture of fixtures) {
      await cleanupGaReportSeed(fixture.projectId);
      await teardownAgencyFixture(fixture.workspaceId);
    }
  });

  describe("weekly report on Monday (Europe/Istanbul)", () => {
    let kase: Case;
    let weeklyId: string;
    let originalCard: WebsiteReportCardData | null = null;

    beforeAll(async () => {
      kase = await makeCase({
        name: "weekly",
        through: "2026-10-11",
        days: 120,
        sessions: steady,
        settings: { weeklyEnabled: true },
        // Geçen haftanın raporu zaten yazılmış: yalnız bu haftanınki sınanır.
        run: {
          lastWeek: "2026-09-28",
          lastMonth: "2026-09",
          lastPlanMonth: "2026-11",
        },
      });
      weeklyId = reportCommandId("weekly", kase.projectId, "2026-10-05");
    }, 120_000);

    it("is not posted at 07:30 local time", async () => {
      const result = await GaReports.runLink(kase.linkId, {
        now: TZ_NOW_MONDAY_0730,
      });
      expect(result).toMatchObject({ weekly: null });
      expect(await commandExists(weeklyId)).toBe(false);
    }, 120_000);

    it("is posted at 08:30 local time into the Website analytics chat", async () => {
      const result = await GaReports.runLink(kase.linkId, {
        now: TZ_NOW_MONDAY_0830,
      });
      expect(result).toMatchObject({ weekly: "posted", llmCalls: 0 });
      const command = await prisma.command.findUniqueOrThrow({
        where: { id: weeklyId },
      });
      expect(command.workId).toBe(websiteWorkId(kase.projectId));
      expect(command.source).toBe("SYSTEM");
      const work = await prisma.work.findUniqueOrThrow({
        where: { id: websiteWorkId(kase.projectId) },
      });
      expect(work).toMatchObject({
        module: "analytics",
        title: "Website analytics",
        status: "ACTIVE",
      });
      originalCard = await cardOf(weeklyId);
    }, 120_000);

    it("shows the sums of the seeded warehouse rows", async () => {
      const body = weeklyBody(originalCard ?? (await cardOf(weeklyId)));
      const sessions = body.kpis.find((kpi) => kpi.key === "sessions");
      const keyEvents = body.kpis.find((kpi) => kpi.key === "keyEvents");
      expect(sessions?.value).toBe(
        sumOf(kase.series, "2026-10-05", "2026-10-11"),
      );
      expect(sessions?.previous).toBe(
        sumOf(kase.series, "2026-09-28", "2026-10-04"),
      );
      const keyEventsOf = (count: number) => Math.round(count * 0.05);
      expect(keyEvents?.value).toBe(
        sumOf(kase.series, "2026-10-05", "2026-10-11", keyEventsOf),
      );
      expect(keyEvents?.previous).toBe(
        sumOf(kase.series, "2026-09-28", "2026-10-04", keyEventsOf),
      );
    }, 120_000);

    it("never changes a posted card, even when the warehouse does", async () => {
      await prisma.gaDailyTotal.updateMany({
        where: {
          linkId: kase.linkId,
          date: {
            gte: dayKeyToDate("2026-10-05"),
            lte: dayKeyToDate("2026-10-11"),
          },
        },
        data: { sessions: { increment: 500 } },
      });
      await GaReports.runLink(kase.linkId, { now: TZ_NOW_MONDAY_0830 });
      const link = await prisma.gaPropertyLink.findUniqueOrThrow({
        where: { id: kase.linkId },
      });
      const ctx = await loadGaReportContext(link, TZ_NOW_MONDAY_0830);
      if (!ctx) throw new Error("context missing");
      const direct = await GaWeeklyReport.write(
        ctx,
        { monday: "2026-10-05", sunday: "2026-10-11" },
        "off",
        { narrative: "allow" },
      );
      expect(direct).toEqual({ result: "exists", narrative: null });
      expect(await cardCount(kase.projectId, "weekly")).toBe(1);
      expect(await cardOf(weeklyId)).toEqual(originalCard);
    }, 120_000);
  });

  it("stores only the supported sentence of the model's summary", async () => {
    const kase = await makeCase({
      name: "narrative",
      through: "2026-10-11",
      days: 120,
      sessions: steady,
      settings: { weeklyEnabled: true },
      run: {
        lastWeek: "2026-09-28",
        lastMonth: "2026-09",
        lastPlanMonth: "2026-11",
      },
    });
    const current = sumOf(kase.series, "2026-10-05", "2026-10-11");
    reasoning.isMockMode.mockReturnValue(false);
    reasoning.run.mockResolvedValue({
      output: {
        headline: `Sessions were ${current.toLocaleString("en-US")} last week.`,
        highlights: ["Sessions grew by 987,654 percent."],
        watchouts: [],
        nextSteps: [],
      },
      isMock: false,
      reasoningCallId: "call-1",
    });
    const result = await GaReports.runLink(kase.linkId, {
      now: TZ_NOW_MONDAY_0830,
    });
    expect(result).toMatchObject({ weekly: "posted", llmCalls: 1 });
    expect(reasoning.run).toHaveBeenCalledTimes(1);
    const card = await cardOf(
      reportCommandId("weekly", kase.projectId, "2026-10-05"),
    );
    expect(card?.narrative?.headline).toContain(
      current.toLocaleString("en-US"),
    );
    expect(card?.narrative?.highlights).toEqual([]);
  }, 120_000);

  describe("pulse", () => {
    const NOW = new Date("2026-10-12T10:00:00.000Z");
    const dropYesterday = (day: string, index: number) =>
      day === "2026-10-11" ? 90 : noisy(day, index);

    it("is posted after a 70 percent drop yesterday", async () => {
      const kase = await makeCase({
        name: "pulse-drop",
        through: "2026-10-11",
        days: 120,
        sessions: dropYesterday,
        settings: { pulse: "notable" },
      });
      const result = await GaReports.runLink(kase.linkId, { now: NOW });
      expect(result).toMatchObject({ pulse: "posted" });
      expect(
        await commandExists(
          reportCommandId("pulse", kase.projectId, "2026-10-11"),
        ),
      ).toBe(true);
    }, 120_000);

    it("stays quiet on a normal day but remembers it looked", async () => {
      const kase = await makeCase({
        name: "pulse-quiet",
        through: "2026-10-11",
        days: 120,
        sessions: noisy,
        settings: { pulse: "notable" },
      });
      const result = await GaReports.runLink(kase.linkId, { now: NOW });
      expect(result).toMatchObject({ pulse: "quiet" });
      expect(await cardCount(kase.projectId, "pulse")).toBe(0);
      const run = await prisma.gaReportRun.findUniqueOrThrow({
        where: { linkId: kase.linkId },
      });
      expect(run.lastPulseDay).toBe("2026-10-11");
      expect(run.lastPulseAt?.toISOString()).toBe(NOW.toISOString());
    }, 120_000);

    it("is skipped while the Website analytics chat is archived", async () => {
      const kase = await makeCase({
        name: "pulse-archived",
        through: "2026-10-11",
        days: 120,
        sessions: dropYesterday,
        settings: { pulse: "notable" },
      });
      await prisma.work.create({
        data: {
          id: websiteWorkId(kase.projectId),
          workspaceId: kase.fixture.workspaceId,
          projectId: kase.projectId,
          title: "Website analytics",
          module: "analytics",
          status: "ARCHIVED",
        },
      });
      const result = await GaReports.runLink(kase.linkId, { now: NOW });
      expect(result).toMatchObject({ pulse: "closed" });
      expect(await cardCount(kase.projectId, "pulse")).toBe(0);
      const work = await prisma.work.findUniqueOrThrow({
        where: { id: websiteWorkId(kase.projectId) },
      });
      expect(work.status).toBe("ARCHIVED");
    }, 120_000);
  });

  it("reopens an archived Website analytics chat with the weekly report", async () => {
    const kase = await makeCase({
      name: "reopen",
      through: "2026-10-11",
      days: 120,
      sessions: steady,
      settings: { weeklyEnabled: true },
      run: {
        lastWeek: "2026-09-28",
        lastMonth: "2026-09",
        lastPlanMonth: "2026-11",
      },
    });
    await prisma.work.create({
      data: {
        id: websiteWorkId(kase.projectId),
        workspaceId: kase.fixture.workspaceId,
        projectId: kase.projectId,
        title: "Website analytics",
        module: "analytics",
        status: "ARCHIVED",
      },
    });
    const result = await GaReports.runLink(kase.linkId, {
      now: TZ_NOW_MONDAY_0830,
    });
    expect(result).toMatchObject({ weekly: "posted" });
    const work = await prisma.work.findUniqueOrThrow({
      where: { id: websiteWorkId(kase.projectId) },
    });
    expect(work.status).toBe("ACTIVE");
  }, 120_000);

  it("posts no weekly report when weekly reports are switched off", async () => {
    const kase = await makeCase({
      name: "weekly-off",
      through: "2026-10-11",
      days: 120,
      sessions: steady,
      settings: { weeklyEnabled: false },
      run: { lastMonth: "2026-09", lastPlanMonth: "2026-11" },
    });
    const result = await GaReports.runLink(kase.linkId, {
      now: TZ_NOW_MONDAY_0830,
    });
    expect(result).toMatchObject({ weekly: null });
    expect(await cardCount(kase.projectId, "weekly")).toBe(0);
  }, 120_000);

  describe("monthly report and plan", () => {
    it("posts both in ONE call, with October's final goal result", async () => {
      const kase = await makeCase({
        name: "month",
        through: "2026-11-01",
        days: 200,
        sessions: steady,
        settings: { monthlyEnabled: true },
      });
      await prisma.projectGoal.create({
        data: {
          workspaceId: kase.fixture.workspaceId,
          projectId: kase.projectId,
          brandId: kase.fixture.brandId,
          title: "Website sessions per month",
          metricKey: "web.sessions",
          targetValue: 9_000,
          status: "ACTIVE",
          approvedByType: "USER",
        },
      });
      const now = new Date("2026-11-02T05:30:00.000Z");
      const result = await GaReports.runLink(kase.linkId, { now });
      expect(result).toMatchObject({ monthly: "posted", plan: "posted" });

      const monthly = monthlyBody(
        await cardOf(reportCommandId("monthly", kase.projectId, "2026-10")),
      );
      const plan = planBody(
        await cardOf(reportCommandId("plan", kase.projectId, "2026-11")),
      );
      expect(plan.month).toBe("2026-11");

      // Kasım ilerleme satırı (günlük hedef yenilemesi) artık var...
      const goal = await prisma.projectGoal.findFirstOrThrow({
        where: { projectId: kase.projectId, metricKey: "web.sessions" },
      });
      const progress = await prisma.gaGoalProgress.findUniqueOrThrow({
        where: { goalId: goal.id },
      });
      expect(progress.month).toBe("2026-11");
      // ...ama aylık rapor Ekim'in bitmiş sonucunu gösterir.
      expect(monthly.month).toBe("2026-10");
      const goalSnap = monthly.goals.find((snap) => snap.goalId === goal.id);
      expect(goalSnap).toMatchObject({ month: "2026-10", final: true });
      expect(goalSnap?.monthToDate).toBe(
        sumOf(kase.series, "2026-10-01", "2026-10-31"),
      );
    }, 180_000);

    it("targets next month when the plan is posted mid-month", async () => {
      const kase = await makeCase({
        name: "plan-rollout",
        through: "2026-10-19",
        days: 200,
        sessions: steady,
        settings: { monthlyEnabled: true },
        run: { lastMonth: "2026-09" },
      });
      const now = new Date("2026-10-20T05:30:00.000Z");
      const result = await GaReports.runLink(kase.linkId, { now });
      expect(result).toMatchObject({ plan: "posted" });
      expect(
        await commandExists(reportCommandId("plan", kase.projectId, "2026-11")),
      ).toBe(true);
      expect(
        await commandExists(reportCommandId("plan", kase.projectId, "2026-10")),
      ).toBe(false);
    }, 120_000);
  });

  describe("critical alerts", () => {
    const NOW = new Date("2026-10-13T10:00:00.000Z");
    const HOUR = 3_600_000;

    async function alertCase(name: string): Promise<Case> {
      return makeCase({
        name,
        through: "2026-10-12",
        days: 120,
        sessions: noisy,
        settings: { alertChat: true },
      });
    }

    it("posts one card for a new CRITICAL alert and none on the next run", async () => {
      const kase = await alertCase("alert-new");
      const alert = await prisma.adsAlert.create({
        data: {
          workspaceId: kase.fixture.workspaceId,
          projectId: kase.projectId,
          source: "GA4",
          kind: "GA_MH1",
          severity: "CRITICAL",
          status: "OPEN",
          dedupeKey: `ga4:mh1:${runId}`,
          title: "The tracking tag stopped sending data",
          firstSeenAt: new Date(NOW.getTime() - HOUR),
          updatedAt: new Date(NOW.getTime() - HOUR),
        },
      });
      const first = await GaReports.runLink(kase.linkId, { now: NOW });
      expect(first).toMatchObject({ alerts: 1 });
      expect(await cardCount(kase.projectId, "alert")).toBe(1);
      const command = await prisma.command.findFirstOrThrow({
        where: {
          projectId: kase.projectId,
          id: { startsWith: "garep_alert_" },
        },
      });
      expect(command.id).toContain(alert.id);

      const second = await GaReports.runLink(kase.linkId, { now: NOW });
      expect(second).toMatchObject({ alerts: 0 });
      expect(await cardCount(kase.projectId, "alert")).toBe(1);
    }, 120_000);

    it("posts a card when a WARN alert is escalated to CRITICAL", async () => {
      const kase = await alertCase("alert-escalate");
      const alert = await prisma.adsAlert.create({
        data: {
          workspaceId: kase.fixture.workspaceId,
          projectId: kase.projectId,
          source: "GA4",
          kind: "GA_MH6",
          severity: "WARN",
          status: "OPEN",
          dedupeKey: `ga4:mh6:${runId}`,
          title: "Key events stopped arriving",
          firstSeenAt: new Date(NOW.getTime() - 10 * 24 * HOUR),
          updatedAt: new Date(NOW.getTime() - 10 * 24 * HOUR),
        },
      });
      await GaReports.runLink(kase.linkId, { now: NOW });
      expect(await cardCount(kase.projectId, "alert")).toBe(0);

      // Yükselme: firstSeenAt aynı kalır, önem derecesi ve updatedAt değişir.
      await prisma.adsAlert.update({
        where: { id: alert.id },
        data: {
          severity: "CRITICAL",
          updatedAt: new Date(NOW.getTime() + HOUR),
        },
      });
      const later = new Date(NOW.getTime() + 2 * HOUR);
      const result = await GaReports.runLink(kase.linkId, { now: later });
      expect(result).toMatchObject({ alerts: 1 });
      expect(await cardCount(kase.projectId, "alert")).toBe(1);
    }, 120_000);
  });
});
