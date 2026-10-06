import { randomUUID } from "node:crypto";

import type { GaPropertyLink, Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import {
  gaFindingFingerprint,
  GaSubjects,
  subjectKeyOf,
} from "@/lib/website-analytics/analysis/keys";
import type { An15Evidence } from "@/lib/website-analytics/analysis/types";
import { addDays, dayKeyToDate } from "@/lib/website-analytics/days";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { GaInsights } from "./runner";

// GA-F4 analiz motoru gerçek Postgres'e karşı (yalnız CI ve yerel tek
// kullanımlık veritabanı; Google'a ve modele gidilmez): aynı sorun iki hafta
// iki satır olur (ilki SUPERSEDED, ikincisi previousId + occurrences 2);
// TR tatilindeki düşüş anomali değildir; normal gündeki düşüş AN1 yazar ve
// gün sonradan şüpheli işaretlenince RESOLVED "measurement" olur; 28 günlük
// penceredeki şüpheli gün AN3'ü çözmez; gölge modda sinyal yok, canlı modda
// yolsuz ve rakamsız sinyal; kilit tutulurken "busy"; yalnız haftalık tur
// AN15'e dokunmaz.

type Page = { sessions: number; keyEvents: number };
type DayData = {
  sessions: number;
  keyEvents: number;
  pages: Record<string, Page>;
};

const NORMAL_PAGES: Record<string, Page> = {
  "/pricing": { sessions: 450, keyEvents: 1 },
  "/": { sessions: 250, keyEvents: 13 },
  "/blog/a": { sessions: 150, keyEvents: 8 },
  "/contact": { sessions: 150, keyEvents: 8 },
};

function scaled(factor: number): DayData {
  const pages: Record<string, Page> = {};
  for (const [path, page] of Object.entries(NORMAL_PAGES)) {
    pages[path] = {
      sessions: Math.round(page.sessions * factor),
      keyEvents: Math.round(page.keyEvents * factor),
    };
  }
  const values = Object.values(pages);
  return {
    sessions: values.reduce((sum, page) => sum + page.sessions, 0),
    keyEvents: values.reduce((sum, page) => sum + page.keyEvents, 0),
    pages,
  };
}

function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

describeIntegration("GA insights engine (GA-F4)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    sync: process.env.GA_SYNC,
    insights: process.env.GA_INSIGHTS,
    projects: process.env.GA_INSIGHTS_PROJECTS,
    health: process.env.GA_HEALTH,
    weekly: process.env.GA_WEEKLY,
    provider: process.env.AGENTELSE_PROVIDER_MODE,
    reasoning: process.env.AGENTELSE_REASONING_MODE,
  };
  const fixtures: AgencyFixture[] = [];

  async function seedLink(input: {
    name: string;
    from: string;
    to: string;
    lastDailyDate: string;
    data: (day: string) => DayData;
  }): Promise<{ fixture: AgencyFixture; link: GaPropertyLink }> {
    const fixture = await createAgencyFixture(`ga-an-${input.name}-${runId}`);
    fixtures.push(fixture);
    const credential = await prisma.integrationCredential.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        provider: "google_analytics",
        accountLabel: "owner@example.com",
        encryptedSecret: "not-used",
        status: "ACTIVE",
      },
    });
    const link = await prisma.gaPropertyLink.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId: credential.id,
        propertyId: `an-${input.name}-${runId}`,
        isPrimary: true,
        isMock: false,
        timeZone: "Europe/Istanbul",
        currencyCode: "EUR",
        health: "OK",
        lastMetadataAt: new Date(),
        lastDailyDate: input.lastDailyDate,
      },
    });
    const fetchedAt = new Date();
    const days = daysBetween(input.from, input.to);
    await prisma.gaDailyTotal.createMany({
      data: days.map((day) => {
        const data = input.data(day);
        return {
          linkId: link.id,
          projectId: fixture.projectId,
          date: dayKeyToDate(day),
          activeUsers: Math.round(data.sessions * 0.8),
          newUsers: Math.round(data.sessions * 0.5),
          sessions: data.sessions,
          engagedSessions: Math.round(data.sessions * 0.6),
          engagementSec: data.sessions * 50,
          sessionDurationSec: data.sessions * 80,
          screenPageViews: data.sessions * 3,
          keyEvents: data.keyEvents,
          isFinal: true,
          fetchedAt,
        };
      }),
    });
    const slices: Prisma.GaReportSliceCreateManyInput[] = [];
    for (const day of days) {
      const data = input.data(day);
      const organic = Math.round(data.sessions * 0.6);
      const organicKe = Math.round(data.keyEvents * 0.6);
      slices.push({
        linkId: link.id,
        projectId: fixture.projectId,
        reportKey: "channel",
        grain: "DAY",
        periodStart: dayKeyToDate(day),
        specVersion: 1,
        dimensionHeaders: ["sessionDefaultChannelGroup"],
        metricHeaders: [
          "sessions",
          "engagedSessions",
          "activeUsers",
          "newUsers",
          "keyEvents",
          "totalRevenue",
        ],
        rows: [
          [
            "Organic Search",
            organic,
            Math.round(organic * 0.6),
            organic,
            0,
            organicKe,
            0,
          ],
          [
            "Direct",
            data.sessions - organic,
            Math.round((data.sessions - organic) * 0.6),
            data.sessions - organic,
            0,
            data.keyEvents - organicKe,
            0,
          ],
        ],
        rowCount: 2,
        isFinal: true,
        fetchedAt,
      });
      slices.push({
        linkId: link.id,
        projectId: fixture.projectId,
        reportKey: "landing_page",
        grain: "DAY",
        periodStart: dayKeyToDate(day),
        specVersion: 1,
        dimensionHeaders: ["landingPage"],
        metricHeaders: [
          "sessions",
          "engagedSessions",
          "keyEvents",
          "totalRevenue",
          "userEngagementDuration",
        ],
        rows: Object.entries(data.pages).map(([path, page]) => [
          path,
          page.sessions,
          Math.round(page.sessions * 0.6),
          page.keyEvents,
          0,
          page.sessions * 50,
        ]),
        rowCount: Object.keys(data.pages).length,
        isFinal: true,
        fetchedAt,
      });
    }
    await prisma.gaReportSlice.createMany({ data: slices });
    return { fixture, link };
  }

  async function markSuspect(link: GaPropertyLink, days: string[]) {
    const suspectDays = Object.fromEntries(days.map((day) => [day, ["MH1"]]));
    await prisma.gaHealthRun.upsert({
      where: { linkId: link.id },
      create: {
        linkId: link.id,
        workspaceId: link.workspaceId,
        projectId: link.projectId,
        suspectDays,
      },
      update: { suspectDays },
    });
  }

  beforeAll(() => {
    process.env.GA_SYNC = "true";
    process.env.GA_INSIGHTS = "shadow";
    process.env.GA_INSIGHTS_PROJECTS = "";
    process.env.GA_HEALTH = "";
    process.env.GA_WEEKLY = "";
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    process.env.AGENTELSE_REASONING_MODE = "mock";
  });

  afterAll(async () => {
    for (const [key, value] of [
      ["GA_SYNC", saved.sync],
      ["GA_INSIGHTS", saved.insights],
      ["GA_INSIGHTS_PROJECTS", saved.projects],
      ["GA_HEALTH", saved.health],
      ["GA_WEEKLY", saved.weekly],
      ["AGENTELSE_PROVIDER_MODE", saved.provider],
      ["AGENTELSE_REASONING_MODE", saved.reasoning],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const fixture of fixtures) {
      await prisma.gaPropertyLink.deleteMany({
        where: { projectId: fixture.projectId },
      });
      await prisma.integrationCredential.deleteMany({
        where: { workspaceId: fixture.workspaceId },
      });
      await teardownAgencyFixture(fixture.workspaceId);
    }
  });

  describe("a low-converting landing page over two weeks (shadow)", () => {
    let link: GaPropertyLink;
    let projectId: string;
    const now1 = new Date("2026-08-31T12:00:00.000Z");
    const now2 = new Date("2026-09-07T12:00:00.000Z");

    beforeAll(async () => {
      process.env.GA_INSIGHTS = "shadow";
      const seeded = await seedLink({
        name: "two-weeks",
        from: "2026-04-30",
        to: "2026-09-06",
        lastDailyDate: "2026-08-31",
        data: () => scaled(1),
      });
      link = seeded.link;
      projectId = seeded.fixture.projectId;
    }, 120_000);

    it("creates two AN3 findings and supersedes the first", async () => {
      const first = await GaInsights.analyzeLink(link.id, { now: now1 });
      expect(first).toMatchObject({ week: "2026-08-24" });
      await prisma.gaPropertyLink.update({
        where: { id: link.id },
        data: { lastDailyDate: "2026-09-07" },
      });
      const second = await GaInsights.analyzeLink(link.id, { now: now2 });
      expect(second).toMatchObject({ week: "2026-08-31" });

      const rows = await prisma.gaFinding.findMany({
        where: { linkId: link.id, ruleKey: "AN3", subject: "page:/pricing" },
        orderBy: { periodStart: "asc" },
      });
      expect(rows).toHaveLength(2);
      const [older, newer] = rows;
      expect(older?.fingerprint).not.toBe(newer?.fingerprint);
      expect(older).toMatchObject({
        status: "SUPERSEDED",
        closedReason: "newer",
        mode: "shadow",
      });
      expect(older?.closedAt).not.toBeNull();
      expect(newer).toMatchObject({
        status: "OPEN",
        previousId: older?.id,
        occurrences: 2,
        mode: "shadow",
      });
    }, 120_000);

    it("stores shadow rows only and ingests no signal", async () => {
      const modes = await prisma.gaFinding.groupBy({
        by: ["mode"],
        where: { linkId: link.id },
        _count: { _all: true },
      });
      expect(modes.map((row) => row.mode)).toEqual(["shadow"]);
      expect(await prisma.signal.count({ where: { projectId } })).toBe(0);
    });

    it("leaves an open AN15 row alone on a weekly-only run", async () => {
      const subjectKey = subjectKeyOf(GaSubjects.goal("goal-x"));
      const evidence: An15Evidence = {
        v: 1,
        rule: "AN15",
        goalId: "goal-x",
        goalTitle: "Website visits",
        metricKey: "web.sessions",
        month: "2026-09",
        target: 50_000,
        monthToDate: 6_000,
        forecast: 30_000,
        paceRatio: 0.6,
        dayOfMonth: 6,
        daysInMonth: 30,
        through: "2026-09-06",
      };
      const goalRow = await prisma.gaFinding.create({
        data: {
          workspaceId: link.workspaceId,
          projectId,
          linkId: link.id,
          ruleKey: "AN15",
          ruleVersion: 1,
          kind: "RISK",
          subject: GaSubjects.goal("goal-x"),
          subjectKey,
          periodGrain: "MONTH",
          periodKey: "2026-09",
          periodStart: dayKeyToDate("2026-09-01"),
          periodEnd: dayKeyToDate("2026-09-30"),
          severity: "WARN",
          confidence: "DIRECTIONAL",
          mode: "shadow",
          priority: 1,
          evidence: evidence as unknown as Prisma.InputJsonValue,
          fingerprint: gaFindingFingerprint({
            linkId: link.id,
            ruleKey: "AN15",
            subjectKey,
            periodKey: "2026-09",
          }),
        },
      });
      // Günlük kısım bu gün için koştu, hafta yeniden vadeli.
      await prisma.gaAnalysisRun.update({
        where: { linkId: link.id },
        data: { lastWeek: "2026-08-24", lastDailyDay: "2026-09-06" },
      });
      const result = await GaInsights.analyzeLink(link.id, {
        now: new Date(now2.getTime() + 3_600_000),
      });
      expect(result).toMatchObject({ daily: [], week: "2026-08-31" });
      const after = await prisma.gaFinding.findUniqueOrThrow({
        where: { id: goalRow.id },
      });
      expect(after.status).toBe("OPEN");
    }, 120_000);

    it("does not resolve the AN3 finding when a window day turns suspect", async () => {
      await markSuspect(link, ["2026-09-01"]);
      await GaInsights.analyzeLink(link.id, {
        now: new Date(now2.getTime() + 2 * 3_600_000),
      });
      const an3 = await prisma.gaFinding.findFirstOrThrow({
        where: {
          linkId: link.id,
          ruleKey: "AN3",
          subject: "page:/pricing",
          periodKey: "2026-W36:28d",
        },
      });
      expect(an3.status).toBe("OPEN");
      // AN15 kendi şüpheli günlerini dışlamaz: ölçüm sorunu olarak çözülür.
      const goal = await prisma.gaFinding.findFirstOrThrow({
        where: { linkId: link.id, ruleKey: "AN15" },
      });
      expect(goal).toMatchObject({
        status: "RESOLVED",
        closedReason: "measurement",
      });
    }, 120_000);

    it("returns busy while another run holds the lease", async () => {
      const now = new Date(now2.getTime() + 3 * 3_600_000);
      await prisma.gaAnalysisRun.update({
        where: { linkId: link.id },
        data: {
          leaseUntil: new Date(now.getTime() + 60_000),
          leaseOwner: "another-process",
        },
      });
      expect(await GaInsights.analyzeLink(link.id, { now })).toBe("busy");
      const run = await prisma.gaAnalysisRun.findUniqueOrThrow({
        where: { linkId: link.id },
      });
      expect(run.leaseOwner).toBe("another-process");
      await prisma.gaAnalysisRun.update({
        where: { linkId: link.id },
        data: { leaseUntil: null, leaseOwner: null },
      });
    });
  });

  it("does not flag a drop on a Turkish public holiday", async () => {
    process.env.GA_INSIGHTS = "shadow";
    const { fixture, link } = await seedLink({
      name: "holiday",
      from: "2026-04-23",
      to: "2026-08-30",
      lastDailyDate: "2026-08-31",
      // 30 Ağustos Zafer Bayramı: %90 düşüş.
      data: (day) => (day === "2026-08-30" ? scaled(0.1) : scaled(1)),
    });
    await prisma.project.update({
      where: { id: fixture.projectId },
      data: { country: "TR", countries: ["TR"] },
    });
    // 05:00 İstanbul: haftalık kısım henüz vadeli değil.
    const result = await GaInsights.analyzeLink(link.id, {
      now: new Date("2026-08-31T02:00:00.000Z"),
    });
    expect(result).toMatchObject({
      daily: ["2026-08-28", "2026-08-29", "2026-08-30"],
      week: null,
    });
    expect(
      await prisma.gaFinding.count({
        where: { linkId: link.id, ruleKey: "AN1" },
      }),
    ).toBe(0);
  }, 120_000);

  it("flags a drop on a normal day and resolves it once the day turns suspect", async () => {
    process.env.GA_INSIGHTS = "shadow";
    const { link } = await seedLink({
      name: "drop",
      from: "2026-04-20",
      to: "2026-08-27",
      lastDailyDate: "2026-08-28",
      data: (day) => (day === "2026-08-27" ? scaled(0.1) : scaled(1)),
    });
    const now = new Date("2026-08-28T12:00:00.000Z");
    await GaInsights.analyzeLink(link.id, { now });
    const rows = await prisma.gaFinding.findMany({
      where: { linkId: link.id, ruleKey: "AN1" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ periodKey: "2026-08-27", status: "OPEN" });

    await markSuspect(link, ["2026-08-27"]);
    await GaInsights.analyzeLink(link.id, {
      now: new Date(now.getTime() + 3_600_000),
    });
    const resolved = await prisma.gaFinding.findUniqueOrThrow({
      where: { id: rows[0]!.id },
    });
    expect(resolved).toMatchObject({
      status: "RESOLVED",
      closedReason: "measurement",
    });
    expect(resolved.closedAt).not.toBeNull();
  }, 120_000);

  it("ingests path-free, digit-free signals in live mode", async () => {
    process.env.GA_INSIGHTS = "on";
    try {
      const { fixture, link } = await seedLink({
        name: "live",
        from: "2026-04-23",
        to: "2026-08-30",
        lastDailyDate: "2026-08-31",
        // Son hafta iki katı: anlamlı haftalık değişim (AN2).
        data: (day) => (day >= "2026-08-24" ? scaled(2) : scaled(1)),
      });
      const result = await GaInsights.analyzeLink(link.id, {
        now: new Date("2026-08-31T12:00:00.000Z"),
      });
      expect(result).toMatchObject({ week: "2026-08-24" });
      const findings = await prisma.gaFinding.findMany({
        where: { linkId: link.id },
        select: { mode: true, ruleKey: true },
      });
      expect(findings.every((row) => row.mode === "live")).toBe(true);
      expect(findings.some((row) => row.ruleKey === "AN2")).toBe(true);

      const signals = await prisma.signal.findMany({
        where: { projectId: fixture.projectId, source: "ga-insights" },
      });
      expect(signals.length).toBeGreaterThan(0);
      expect(
        signals.some(
          (signal) =>
            (signal.payload as { ruleKey?: string } | null)?.ruleKey === "AN2",
        ),
      ).toBe(true);
      for (const signal of signals) {
        expect(signal.externalRef).toMatch(
          /^ga:[^:]+:AN\d+:[0-9a-f]{16}:\d{4}-W\d{2}$/,
        );
        expect(signal.title).not.toMatch(/\//);
        expect(signal.title).not.toMatch(/\d/);
      }
      const linked = await prisma.gaFinding.count({
        where: { linkId: link.id, signalId: { not: null } },
      });
      expect(linked).toBeGreaterThanOrEqual(signals.length);
    } finally {
      process.env.GA_INSIGHTS = "shadow";
    }
  }, 120_000);
});
