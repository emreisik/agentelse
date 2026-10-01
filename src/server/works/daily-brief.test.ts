import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  creatives: vi.fn(),
  tasks: vi.fn(),
  ideas: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    creative: { findMany: mocks.creatives },
    task: { findMany: mocks.tasks },
    idea: { count: mocks.ideas },
  },
}));

import { loadBriefExtras } from "@/server/works/daily-brief";

const TZ = "Europe/Istanbul";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.creatives.mockResolvedValue([]);
  mocks.tasks.mockResolvedValue([]);
  mocks.ideas.mockResolvedValue(0);
});

describe("loadBriefExtras", () => {
  it("windows the day at project-timezone midnight", async () => {
    await loadBriefExtras("p1", TZ, "2026-10-01");
    const where = mocks.creatives.mock.calls[0]![0].where;
    // Istanbul is UTC+3: local midnight is 21:00Z of the day before.
    expect(where.scheduledFor.gte.toISOString()).toBe("2026-09-30T21:00:00.000Z");
    expect(where.scheduledFor.lt.toISOString()).toBe("2026-10-01T21:00:00.000Z");
    const taskWhere = mocks.tasks.mock.calls[0]![0].where;
    expect(taskWhere.OR[0].completedAt.gte.toISOString()).toBe("2026-09-29T21:00:00.000Z");
    expect(taskWhere.OR[0].completedAt.lt.toISOString()).toBe("2026-09-30T21:00:00.000Z");
  });

  it("maps today's items with plan and format and drops archived stages", async () => {
    mocks.creatives.mockResolvedValue([
      {
        id: "c1",
        title: " Post ",
        channel: "instagram",
        formatKey: "instagram.carousel",
        planId: "pl1",
        status: "IN_REVIEW",
        currentVersionId: "v1",
        scheduledFor: new Date(),
      },
      {
        id: "c2",
        title: null,
        channel: null,
        formatKey: null,
        planId: null,
        status: "ARCHIVED",
        currentVersionId: null,
        scheduledFor: new Date(),
      },
    ]);
    const extras = await loadBriefExtras("p1", TZ, "2026-10-01");
    expect(extras.todayItems).toEqual([
      {
        id: "c1",
        title: "Post",
        channel: "instagram",
        stage: "IN_REVIEW",
        formatKey: "instagram.carousel",
        planId: "pl1",
      },
    ]);
  });

  it("counts yesterday's publish tasks, client-posted pieces and shortlisted ideas", async () => {
    mocks.tasks.mockResolvedValue([
      { status: "COMPLETED" },
      { status: "COMPLETED" },
      { status: "FAILED" },
    ]);
    mocks.creatives
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "m1", channel: null, formatKey: null }]);
    mocks.ideas.mockResolvedValue(4);
    const extras = await loadBriefExtras("p1", TZ, "2026-10-01");
    expect(extras.yesterdayPublished).toBe(3);
    expect(extras.yesterdayFailed).toBe(1);
    expect(extras.shortlistedIdeas).toBe(4);
  });

  it("counts a legacy auto-published piece once: through its completed publish task", async () => {
    mocks.tasks.mockResolvedValue([
      { status: "COMPLETED", payload: { creativeId: "auto1" } },
    ]);
    mocks.creatives.mockResolvedValueOnce([]).mockResolvedValueOnce([
      // Legacy rows without channel or format, also published by the task.
      { id: "auto1", channel: null, formatKey: null },
      // A really manual piece with no task still counts.
      { id: "manual1", channel: null, formatKey: null },
    ]);
    const extras = await loadBriefExtras("p1", TZ, "2026-10-01");
    expect(extras.yesterdayPublished).toBe(2);
  });

  it("runs at most four reads", async () => {
    await loadBriefExtras("p1", TZ, "2026-10-01");
    expect(
      mocks.creatives.mock.calls.length + mocks.tasks.mock.calls.length + mocks.ideas.mock.calls.length,
    ).toBe(4);
  });

  it("degrades one field per failed read and never throws", async () => {
    mocks.creatives.mockRejectedValue(new Error("db"));
    mocks.tasks.mockRejectedValue(new Error("db"));
    mocks.ideas.mockResolvedValue(2);
    await expect(loadBriefExtras("p1", TZ, "2026-10-01")).resolves.toEqual({
      todayItems: [],
      yesterdayPublished: 0,
      yesterdayFailed: 0,
      shortlistedIdeas: 2,
    });
  });

  it("returns empty extras for an unusable day or timezone", async () => {
    await expect(loadBriefExtras("p1", "Not/AZone", "2026-10-01")).resolves.toEqual({
      todayItems: [],
      yesterdayPublished: 0,
      yesterdayFailed: 0,
      shortlistedIdeas: 0,
    });
  });

  it("imports no network module", () => {
    const source = readFileSync("src/server/works/daily-brief.ts", "utf8");
    const imports = source.split("\n").filter((line) => /^import |from "/.test(line));
    expect(imports.join("\n")).not.toMatch(/graph|analytics|meta|ga4|http/i);
    expect(source).not.toMatch(/fetch\(/);
  });
});
