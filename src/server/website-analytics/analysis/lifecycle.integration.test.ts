import { randomUUID } from "node:crypto";

import type { GaPropertyLink, Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import type {
  An1Evidence,
  An3Evidence,
  GaFindingCandidate,
  GaFindingMode,
} from "@/lib/website-analytics/analysis/types";
import { addDays, dayKeyToDate } from "@/lib/website-analytics/days";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { GaFindingEvaluator } from "./evaluator";
import { GaFindingActions } from "./lifecycle";
import { persistCandidates } from "./persist";
import { GaFindingRetention } from "./retention";

// GA-F4 yaşam döngüsü gerçek Postgres'e karşı: accept → done → değerlendirme
// (after penceresi ambarda) EVALUATED WORKED + tek GA4 öğrenmesi (yolsuz);
// DIDNT öğrenme yazmaz; AN3 (koşul) reddi gelecek haftanın adayını bastırır,
// AN1 (olay) reddi ertesi günün AN1'ini bastırmaz; review kararı yazılır;
// gölge satırda eylem "invalid"; saklama 731 gün önce kapanmışı siler, 729
// gün önce kapanmışı tutar.

const DAY_MS = 86_400_000;
// Değerlendirme: done 20 Ağustos → önce [23 Tem, 19 Ağu], sonra [27 Ağu, 23 Eyl].
const DONE_AT = new Date("2026-08-20T09:00:00.000Z");
const CHANGE_DAY = "2026-08-20";
const EVALUATE_AT = new Date("2026-10-12T10:00:00.000Z");

type Page = { sessions: number; keyEvents: number };

function pagesOf(day: string): Record<string, Page> {
  const improved = day >= CHANGE_DAY;
  return {
    "/pricing": { sessions: 450, keyEvents: improved ? 15 : 1 },
    "/": { sessions: 400, keyEvents: 21 },
    "/contact": { sessions: 150, keyEvents: 8 },
  };
}

function an3(page: string, rate: number): An3Evidence {
  return {
    v: 1,
    rule: "AN3",
    variant: "cro",
    window: { from: "2026-07-20", to: "2026-08-16" },
    page,
    sessions: 12_600,
    keyEvents: Math.round(12_600 * rate),
    rate,
    restSessions: 15_400,
    restKeyEvents: 812,
    restRate: 0.0527,
    ratio: rate / 0.0527,
    threshold: 8_400,
    p: 0.0001,
    bhAccepted: true,
    excludedDays: [],
    holidays: [],
  };
}

function an3Candidate(
  page: string,
  window: { from: string; to: string; key: string },
): GaFindingCandidate {
  return {
    ruleKey: "AN3",
    kind: "OPPORTUNITY",
    subject: `page:${page}`,
    period: { grain: "WINDOW28", ...window },
    severity: "WARN",
    confidence: "SIGNIFICANT",
    evidence: {
      ...an3(page, 0.002),
      window: { from: window.from, to: window.to },
    },
    impact: {
      metric: "keyEvents",
      perWeek: 40,
      low: 30,
      high: 50,
      directional: false,
    },
    impactShare: 0.2,
  };
}

function an1Candidate(day: string): GaFindingCandidate {
  const evidence: An1Evidence = {
    v: 1,
    rule: "AN1",
    mode: "day",
    target: day,
    readings: [],
    primary: "sessions",
    excludedDays: [],
    breakdown: null,
    seasonalChecked: false,
    preliminary: false,
  };
  return {
    ruleKey: "AN1",
    kind: "ANOMALY",
    subject: "site",
    period: { grain: "DAY", from: day, to: day, key: day },
    severity: "WARN",
    confidence: "SIGNIFICANT",
    evidence,
    impact: null,
    impactShare: 0.5,
  };
}

describeIntegration("GA insight lifecycle (GA-F4)", () => {
  const runId = randomUUID().slice(0, 8);
  const userId = `user-${runId}`;
  const saved = {
    sync: process.env.GA_SYNC,
    insights: process.env.GA_INSIGHTS,
  };
  let fixture: AgencyFixture;
  let link: GaPropertyLink;

  async function createFinding(
    page: string,
    mode: GaFindingMode = "live",
  ): Promise<string> {
    const row = await prisma.gaFinding.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        linkId: link.id,
        ruleKey: "AN3",
        ruleVersion: 1,
        kind: "OPPORTUNITY",
        subject: `page:${page}`,
        subjectKey: randomUUID().replace(/-/g, "").slice(0, 16),
        periodGrain: "WINDOW28",
        periodKey: "2026-W33:28d",
        periodStart: dayKeyToDate("2026-07-20"),
        periodEnd: dayKeyToDate("2026-08-16"),
        severity: "WARN",
        confidence: "SIGNIFICANT",
        mode,
        priority: 1,
        evidence: an3(page, 0.002) as unknown as Prisma.InputJsonValue,
        fingerprint: `${link.id}:AN3:${randomUUID()}`,
      },
    });
    return row.id;
  }

  async function acceptAndDone(findingId: string) {
    const base = { projectId: fixture.projectId, findingId, userId };
    expect(
      await GaFindingActions.accept({
        ...base,
        now: new Date(DONE_AT.getTime() - DAY_MS),
      }),
    ).toBe("ok");
    expect(await GaFindingActions.markDone({ ...base, now: DONE_AT })).toBe(
      "ok",
    );
    const row = await prisma.gaFinding.findUniqueOrThrow({
      where: { id: findingId },
    });
    expect(row.status).toBe("DONE");
    expect(row.evaluateAfter?.getTime()).toBe(DONE_AT.getTime() + 36 * DAY_MS);
  }

  beforeAll(async () => {
    process.env.GA_SYNC = "true";
    process.env.GA_INSIGHTS = "on";
    fixture = await createAgencyFixture(`ga-life-${runId}`);
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
    link = await prisma.gaPropertyLink.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        credentialId: credential.id,
        propertyId: `life-${runId}`,
        isPrimary: true,
        timeZone: "Europe/Istanbul",
        currencyCode: "EUR",
        health: "OK",
        lastDailyDate: "2026-10-11",
      },
    });
    const fetchedAt = new Date();
    const days: string[] = [];
    for (let day = "2026-07-01"; day <= "2026-10-10"; day = addDays(day, 1)) {
      days.push(day);
    }
    await prisma.gaDailyTotal.createMany({
      data: days.map((day) => {
        const pages = Object.values(pagesOf(day));
        const sessions = pages.reduce((sum, page) => sum + page.sessions, 0);
        return {
          linkId: link.id,
          projectId: fixture.projectId,
          date: dayKeyToDate(day),
          sessions,
          engagedSessions: Math.round(sessions * 0.6),
          keyEvents: pages.reduce((sum, page) => sum + page.keyEvents, 0),
          isFinal: true,
          fetchedAt,
        };
      }),
    });
    await prisma.gaReportSlice.createMany({
      data: days.map((day) => ({
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
        rows: Object.entries(pagesOf(day)).map(([path, page]) => [
          path,
          page.sessions,
          Math.round(page.sessions * 0.6),
          page.keyEvents,
          0,
          page.sessions * 40,
        ]),
        rowCount: 3,
        isFinal: true,
        fetchedAt,
      })),
    });
  }, 120_000);

  beforeEach(async () => {
    // Paylaşılan kilitler önceki koşulardan kalmasın.
    await prisma.systemHeartbeat.deleteMany({
      where: { key: { in: ["ga.findings.evaluate", "ga.findings.retention"] } },
    });
  });

  afterAll(async () => {
    process.env.GA_SYNC = saved.sync;
    process.env.GA_INSIGHTS = saved.insights;
    if (fixture) {
      await prisma.brandLearning.deleteMany({
        where: { projectId: fixture.projectId },
      });
      await prisma.gaPropertyLink.deleteMany({
        where: { projectId: fixture.projectId },
      });
      await prisma.integrationCredential.deleteMany({
        where: { workspaceId: fixture.workspaceId },
      });
    }
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("evaluates a done finding as WORKED and writes one path-free learning", async () => {
    const findingId = await createFinding("/pricing");
    await acceptAndDone(findingId);
    expect(
      await GaFindingEvaluator.runDue(20, EVALUATE_AT),
    ).toBeGreaterThanOrEqual(1);

    const row = await prisma.gaFinding.findUniqueOrThrow({
      where: { id: findingId },
    });
    expect(row).toMatchObject({
      status: "EVALUATED",
      outcome: "WORKED",
      closedReason: "evaluated",
    });
    expect(row.closedAt).not.toBeNull();
    expect(row.evaluatedAt).not.toBeNull();

    const learnings = await prisma.brandLearning.findMany({
      where: { projectId: fixture.projectId, sourceType: "GA4" },
    });
    expect(learnings).toHaveLength(1);
    expect(learnings[0]).toMatchObject({
      polarity: "WORKS",
      sourceRef: findingId,
      brandId: fixture.brandId,
    });
    expect(learnings[0]?.insight).not.toMatch(/\//);
  }, 120_000);

  it("writes no learning for a DIDNT outcome", async () => {
    const findingId = await createFinding("/contact");
    await acceptAndDone(findingId);
    await GaFindingEvaluator.runDue(
      20,
      new Date(EVALUATE_AT.getTime() + 3_600_000),
    );
    const row = await prisma.gaFinding.findUniqueOrThrow({
      where: { id: findingId },
    });
    expect(row).toMatchObject({ status: "EVALUATED", outcome: "DIDNT" });
    expect(
      await prisma.brandLearning.count({
        where: { sourceType: "GA4", sourceRef: findingId },
      }),
    ).toBe(0);
  }, 120_000);

  it("suppresses next week's AN3 after a dismiss but not the next day's AN1", async () => {
    const now = new Date("2026-09-07T10:00:00.000Z");
    const persist = (candidate: GaFindingCandidate, at: Date) =>
      persistCandidates({
        link,
        candidates: [candidate],
        mode: "live",
        now: at,
      });

    const week1 = await persist(
      an3Candidate("/landing-x", {
        from: "2026-08-03",
        to: "2026-08-30",
        key: "2026-W35:28d",
      }),
      now,
    );
    expect(week1.created).toHaveLength(1);
    expect(
      await GaFindingActions.dismiss({
        projectId: fixture.projectId,
        findingId: week1.created[0]!,
        userId,
        now,
      }),
    ).toBe("ok");
    const dismissed = await prisma.gaFinding.findUniqueOrThrow({
      where: { id: week1.created[0]! },
    });
    expect(dismissed).toMatchObject({
      status: "DISMISSED",
      closedReason: "dismissed",
    });
    expect(dismissed.closedAt).not.toBeNull();
    const week2 = await persist(
      an3Candidate("/landing-x", {
        from: "2026-08-10",
        to: "2026-09-06",
        key: "2026-W36:28d",
      }),
      new Date(now.getTime() + 7 * DAY_MS),
    );
    expect(week2).toMatchObject({ created: [], suppressed: 1 });

    const day1 = await persist(an1Candidate("2026-09-05"), now);
    expect(day1.created).toHaveLength(1);
    expect(
      await GaFindingActions.dismiss({
        projectId: fixture.projectId,
        findingId: day1.created[0]!,
        userId,
        now,
      }),
    ).toBe("ok");
    const day2 = await persist(
      an1Candidate("2026-09-06"),
      new Date(now.getTime() + DAY_MS),
    );
    expect(day2.created).toHaveLength(1);
  }, 60_000);

  it("records an operator review verdict", async () => {
    const findingId = await createFinding("/review", "shadow");
    expect(
      await GaFindingActions.review({
        projectId: fixture.projectId,
        findingId,
        userId,
        verdict: "USEFUL",
      }),
    ).toBe("ok");
    const row = await prisma.gaFinding.findUniqueOrThrow({
      where: { id: findingId },
    });
    expect(row).toMatchObject({
      reviewVerdict: "USEFUL",
      reviewedByUserId: userId,
    });
    expect(row.reviewedAt).not.toBeNull();
  });

  it("rejects user actions on a shadow finding", async () => {
    const findingId = await createFinding("/shadow-only", "shadow");
    const base = { projectId: fixture.projectId, findingId, userId };
    expect(await GaFindingActions.accept(base)).toBe("invalid");
    expect(await GaFindingActions.dismiss(base)).toBe("invalid");
    expect(await GaFindingActions.markDone(base)).toBe("invalid");
    expect(
      await GaFindingActions.accept({ ...base, projectId: "another-project" }),
    ).toBe("not_found");
  });

  it("deletes findings closed 731 days ago and keeps those closed 729 days ago", async () => {
    const now = new Date("2027-01-01T12:00:00.000Z");
    const old = await createFinding("/old");
    const recent = await createFinding("/recent");
    await prisma.gaFinding.update({
      where: { id: old },
      data: {
        status: "EXPIRED",
        closedReason: "ttl",
        closedAt: new Date(now.getTime() - 731 * DAY_MS),
      },
    });
    await prisma.gaFinding.update({
      where: { id: recent },
      data: {
        status: "EXPIRED",
        closedReason: "ttl",
        closedAt: new Date(now.getTime() - 729 * DAY_MS),
      },
    });
    expect(await GaFindingRetention.runDue(now)).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.gaFinding.findUnique({ where: { id: old } }),
    ).toBeNull();
    expect(
      await prisma.gaFinding.findUnique({ where: { id: recent } }),
    ).not.toBeNull();
  });
});
