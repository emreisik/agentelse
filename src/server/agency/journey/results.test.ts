import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: results are the measurement loop's own words, tied to
// the plan piece they measured, newest real check per piece; mock-mode and
// empty results never show; only THIS project's plan pieces are looked at; and
// a failure is "no results", never an error on the page.

const planFindMany = vi.fn();
const taskFindMany = vi.fn();
const creativeFindMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    measurementPlan: { findMany: planFindMany },
    task: { findMany: taskFindMany },
    creative: { findMany: creativeFindMany },
  },
}));

const { toPlanResults, loadPlanResults } = await import("./results");

const at = (iso: string) => new Date(iso);
const check = (over: Record<string, unknown> = {}) => ({
  label: "24h engagement check",
  dueAt: at("2026-10-06T10:00:00Z"),
  resultSummary: { observation: "Reach 1.2k, 38 saves", isMock: false },
  ...over,
});
const creative = {
  id: "c1",
  title: "Clinic tour",
  channel: "instagram",
  formatKey: "instagram.reel",
};

describe("toPlanResults", () => {
  const tasks = [{ id: "t1", payload: { creativeId: "c1" } }];

  it("ties the newest real check to the piece it measured", () => {
    const results = toPlanResults({
      plans: [
        {
          taskId: "t1",
          checks: [
            check({ label: "24h", dueAt: at("2026-10-05T10:00:00Z") }),
            check({
              label: "72h",
              dueAt: at("2026-10-08T10:00:00Z"),
              resultSummary: { observation: "Reach 4k" },
            }),
          ],
        },
      ],
      tasks,
      creatives: [creative],
    });
    expect(results).toEqual([
      {
        creativeId: "c1",
        title: "Clinic tour",
        where: "Instagram · Reel",
        check: "72h",
        observation: "Reach 4k",
        checkedAt: "2026-10-08T10:00:00.000Z",
      },
    ]);
  });

  it("leaves out mock-mode, empty and non-text results", () => {
    const bad = [
      { observation: "made up", isMock: true },
      { observation: "   " },
      { observation: { reach: 5 } },
      { observation: null },
      null,
    ];
    for (const resultSummary of bad) {
      expect(
        toPlanResults({
          plans: [{ taskId: "t1", checks: [check({ resultSummary })] }],
          tasks,
          creatives: [creative],
        }),
      ).toEqual([]);
    }
  });

  it("skips plans whose task is not a plan piece's publish", () => {
    expect(
      toPlanResults({
        plans: [
          { taskId: "t1", checks: [check()] },
          { taskId: null, checks: [check()] },
          { taskId: "t9", checks: [check()] },
        ],
        tasks: [
          { id: "t1", payload: { creativeId: "not-a-plan-piece" } },
          { id: "t9", payload: { request: "x" } },
        ],
        creatives: [creative],
      }),
    ).toEqual([]);
  });

  it("trims a long observation and lists the newest first", () => {
    const results = toPlanResults({
      plans: [
        { taskId: "t1", checks: [check({ resultSummary: { observation: "x".repeat(2000) } })] },
        {
          taskId: "t2",
          checks: [check({ dueAt: at("2026-10-09T10:00:00Z") })],
        },
      ],
      tasks: [
        { id: "t1", payload: { creativeId: "c1" } },
        { id: "t2", payload: { creativeId: "c2" } },
      ],
      creatives: [creative, { ...creative, id: "c2", title: null, channel: null, formatKey: null }],
    });
    expect(results.map((r) => r.creativeId)).toEqual(["c2", "c1"]);
    expect(results[1]!.observation).toHaveLength(600);
    expect(results[0]).toMatchObject({ title: "Untitled", where: "Post" });
  });
});

describe("loadPlanResults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    planFindMany.mockResolvedValue([{ taskId: "t1", checks: [check()] }]);
    taskFindMany.mockResolvedValue([{ id: "t1", payload: { creativeId: "c1" } }]);
    creativeFindMany.mockResolvedValue([creative]);
  });

  it("looks only at this project's plan pieces and completed checks", async () => {
    const now = at("2026-10-10T00:00:00Z");
    const results = await loadPlanResults("proj-1", now);
    expect(results).toHaveLength(1);
    expect(planFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: "proj-1",
          taskId: { not: null },
          createdAt: { gte: at("2026-09-10T00:00:00Z") },
        },
        select: expect.objectContaining({
          checks: expect.objectContaining({ where: { status: "COMPLETED" } }),
        }),
      }),
    );
    expect(taskFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["t1"] }, projectId: "proj-1" } }),
    );
    expect(creativeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["c1"] }, projectId: "proj-1", planId: { not: null } },
      }),
    );
  });

  it("asks for nothing more when there is nothing to measure", async () => {
    planFindMany.mockResolvedValue([]);
    expect(await loadPlanResults("proj-1")).toEqual([]);
    expect(taskFindMany).not.toHaveBeenCalled();
  });

  it("a failure is 'no results', never an error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    planFindMany.mockRejectedValue(new Error("db down"));
    expect(await loadPlanResults("proj-1")).toEqual([]);
  });
});
