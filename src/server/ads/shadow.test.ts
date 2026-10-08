import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  decisions: vi.fn(),
  update: vi.fn(),
  find: vi.fn(),
  account: vi.fn(),
  insights: vi.fn(),
  object: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    adsDecision: {
      findMany: (args: unknown) =>
        (args as { select?: unknown }).select ? db.find(args) : db.decisions(args),
      updateMany: db.update,
    },
    adsAccount: { findUnique: db.account },
    adsInsightDaily: { findMany: db.insights },
    adsObject: { findUnique: db.object },
  },
}));

import { AdsShadow } from "./shadow";

const NOW = new Date("2026-10-20T10:00:00Z");

function day(date: string, spendMinor: number, results: number) {
  return {
    date: new Date(`${date}T00:00:00Z`),
    spendMinor: BigInt(spendMinor),
    impressions: 1000,
    clicks: 10,
    linkClicks: 10,
    results,
    video3s: null,
    thruplays: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.account.mockResolvedValue({ timezoneName: "UTC" });
  db.update.mockResolvedValue({ count: 1 });
});

describe("AdsShadow.evaluateDue", () => {
  it("records that a flagged ad kept spending, and that the owner paused it too", async () => {
    db.decisions.mockResolvedValue([
      {
        id: "d1",
        kind: "PAUSE",
        adsAccountId: "acc",
        externalId: "ad1",
        level: "AD",
        createdAt: new Date("2026-10-10T08:00:00Z"),
        change: { field: "status", from: "ACTIVE", to: "PAUSED" },
      },
    ]);
    db.insights.mockResolvedValue([
      day("2026-10-05", 2_000, 0),
      day("2026-10-08", 2_000, 0),
      day("2026-10-11", 3_000, 0),
      day("2026-10-14", 3_000, 0),
    ]);
    db.object.mockResolvedValue({
      configuredStatus: "PAUSED",
      dailyBudgetMinor: null,
      goneAt: null,
    });

    expect(await AdsShadow.evaluateDue(20, NOW)).toBe(1);
    const call = db.update.mock.calls[0]![0] as {
      where: unknown;
      data: { outcome: string; outcomeData: Record<string, unknown> };
    };
    expect(call.where).toMatchObject({ id: "d1", status: "SHADOW", outcome: null });
    expect(call.data.outcome).toBe("SHADOW_PERSISTED");
    expect(call.data.outcomeData).toMatchObject({
      shadow: true,
      verdict: "PERSISTED",
      exposureMinor: 6_000,
      humanAgreed: true,
    });
  });

  it("leaves decisions that are not a week old alone", async () => {
    db.decisions.mockResolvedValue([]);
    expect(await AdsShadow.evaluateDue(20, NOW)).toBe(0);
    const where = (db.decisions.mock.calls[0]![0] as { where: { createdAt: { lt: Date } } })
      .where;
    expect(where.createdAt.lt.getTime()).toBeLessThan(NOW.getTime() - 7 * 86_400_000);
  });
});

describe("AdsShadow.scorecard", () => {
  it("turns judged decisions into a card", async () => {
    db.find.mockResolvedValue(
      Array.from({ length: 20 }, () => ({
        kind: "PAUSE",
        outcomeData: {
          shadow: true,
          verdict: "PERSISTED",
          ratio: 1,
          exposureMinor: 100,
          humanAgreed: true,
        },
      })),
    );
    const card = await AdsShadow.scorecard("proj", NOW);
    expect(card).toMatchObject({ total: 20, readiness: "READY", exposureMinor: 2_000 });
  });
});
