import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves about the journey snapshot: it reads only THIS
// project's plan slots (archived ones out), ties jobs to slots through the plan
// Command and Task.payload.planCreativeId, reports whether anything releases
// approved posts, and never takes a page down (null / [] on any failure).

const creativeFindMany = vi.fn();
const taskFindMany = vi.fn();
const commandFindMany = vi.fn();
const commandCount = vi.fn().mockResolvedValue(0);
const scheduleCount = vi.fn();
const ideaCount = vi.fn();
const workFindFirst = vi.fn();
const auditFindMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    creative: { findMany: creativeFindMany },
    task: { findMany: taskFindMany },
    command: { findMany: commandFindMany, count: commandCount },
    projectSchedule: { count: scheduleCount },
    idea: { count: ideaCount },
    work: { findFirst: workFindFirst },
    auditLog: { findMany: auditFindMany },
  },
}));
// The results count has its own suite (post-results.test.ts).
const countAwaitingVerdict = vi.fn();
vi.mock("@/server/agency/learning/post-results", () => ({
  countAwaitingVerdict,
}));

vi.mock("@/server/chat/content-plan", () => ({
  getProjectTimezone: vi.fn().mockResolvedValue("Europe/Istanbul"),
  todayInTimezone: vi.fn().mockReturnValue("2026-10-01"),
}));
const getChannelConnections = vi.fn();
vi.mock("@/server/integrations/channel-connections", () => ({
  getChannelConnections,
}));
// The measurement results have their own suite (results.test.ts).
const loadPlanResults = vi.fn();
vi.mock("./results", () => ({ loadPlanResults }));

const { loadJourneySnapshot, loadNextSteps } = await import("./snapshot");

const slot = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  planId: "plan-1",
  status: "DRAFT",
  currentVersionId: null,
  scheduledFor: new Date("2026-10-03T07:00:00Z"),
  channel: "instagram",
  formatKey: "instagram.post",
  title: `Topic ${id}`,
  platform: "INSTAGRAM",
  versions: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  creativeFindMany.mockResolvedValue([slot("a"), slot("b")]);
  taskFindMany.mockResolvedValue([]);
  commandFindMany.mockResolvedValue([]);
  scheduleCount.mockResolvedValue(0);
  ideaCount.mockResolvedValue(0);
  workFindFirst.mockResolvedValue(null);
  auditFindMany.mockResolvedValue([]);
  countAwaitingVerdict.mockResolvedValue(0);
  getChannelConnections.mockResolvedValue({ instagram: { connected: true } });
  loadPlanResults.mockResolvedValue([]);
});

describe("loadJourneySnapshot", () => {
  it("reads this project's plan slots only, archived ones excluded", async () => {
    await loadJourneySnapshot("proj-1");
    expect(creativeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: "proj-1",
          planId: { not: null },
          status: { not: "ARCHIVED" },
          excludedAt: null,
        },
      }),
    );
  });

  // W07: the default call is byte-identical to the pre-Works query and never
  // reads Command rows.
  it("without options the creative query is exactly the old one and no command is read", async () => {
    const snapshot = await loadJourneySnapshot("proj-1");
    expect(creativeFindMany).toHaveBeenCalledTimes(1);
    expect(creativeFindMany.mock.calls[0]![0]).toEqual({
      where: {
        projectId: "proj-1",
        planId: { not: null },
        status: { not: "ARCHIVED" },
        excludedAt: null,
      },
      orderBy: [{ scheduledFor: { sort: "asc", nulls: "last" } }],
      take: 300,
      select: {
        id: true,
        planId: true,
        status: true,
        currentVersionId: true,
        scheduledFor: true,
        channel: true,
        formatKey: true,
        title: true,
        platform: true,
        postId: true,
        versions: {
          orderBy: { version: "desc" },
          take: 1,
          select: { assetId: true },
        },
      },
    });
    expect(commandFindMany).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveProperty("workScoped");
    await loadJourneySnapshot("proj-1", {});
    expect(commandFindMany).not.toHaveBeenCalled();
  });

  it("with a workId it reads that Work's plan commands, then only creatives of those plans", async () => {
    commandFindMany.mockResolvedValue([{ id: "plan-1" }, { id: "plan-2" }]);
    const snapshot = await loadJourneySnapshot("proj-1", { workId: "w1" });
    expect(commandFindMany).toHaveBeenCalledWith({
      where: {
        projectId: "proj-1",
        workId: "w1",
        cardKind: "content-plan-draft",
      },
      select: { id: true },
      take: 200,
    });
    expect(creativeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: "proj-1",
          planId: { in: ["plan-1", "plan-2"] },
          status: { not: "ARCHIVED" },
          excludedAt: null,
        },
      }),
    );
    expect(snapshot?.workScoped).toBe(true);
    expect(snapshot?.items).toHaveLength(2);
  });

  it("a Work with no plans has no items but still reports the rest", async () => {
    commandFindMany.mockResolvedValue([]);
    loadPlanResults.mockResolvedValue([]);
    const snapshot = await loadJourneySnapshot("proj-1", { workId: "w1" });
    expect(creativeFindMany).not.toHaveBeenCalled();
    expect(taskFindMany).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({
      today: "2026-10-01",
      items: [],
      workScoped: true,
      connections: { instagram: { connected: true } },
      publishScheduleEnabled: false,
      results: [],
    });
  });

  it("loadNextSteps passes the options through and keeps the null-safe behaviour", async () => {
    commandFindMany.mockResolvedValue([{ id: "plan-1" }]);
    creativeFindMany.mockResolvedValue([
      slot("a", { status: "IN_REVIEW", currentVersionId: "v1" }),
      slot("b", { status: "IN_REVIEW", currentVersionId: "v2" }),
    ]);
    const steps = await loadNextSteps("proj-1", { workId: "w1" });
    expect(steps[0]?.action.kind).toBe("approve_plan");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    commandFindMany.mockRejectedValue(new Error("db down"));
    expect(await loadJourneySnapshot("proj-1", { workId: "w1" })).toBeNull();
    expect(await loadNextSteps("proj-1", { workId: "w1" })).toEqual([]);
  });

  it("derives each slot's stage, day and latest image", async () => {
    creativeFindMany.mockResolvedValue([
      slot("a"),
      slot("b", {
        status: "IN_REVIEW",
        currentVersionId: "v1",
        versions: [{ assetId: "asset-1" }],
      }),
    ]);
    const snapshot = await loadJourneySnapshot("proj-1");
    expect(snapshot).toMatchObject({
      today: "2026-10-01",
      publishScheduleEnabled: false,
      connections: { instagram: { connected: true } },
    });
    expect(snapshot?.items).toEqual([
      expect.objectContaining({ id: "a", stage: "PLANNED", date: "2026-10-03" }),
      expect.objectContaining({
        id: "b",
        stage: "IN_REVIEW",
        assetId: "asset-1",
        publish: "auto",
      }),
    ]);
  });

  it("ties jobs to slots through the plan's Command and the slot id in the payload", async () => {
    taskFindMany.mockResolvedValue([
      { status: "RUNNING", payload: { planCreativeId: "a" }, updatedAt: new Date() },
      // A package task under the same Command has no slot: ignored.
      { status: "RUNNING", payload: { request: "x" }, updatedAt: new Date() },
    ]);
    const snapshot = await loadJourneySnapshot("proj-1");
    expect(taskFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: "proj-1", commandId: { in: ["plan-1"] } },
      }),
    );
    expect(snapshot?.items.map((item) => [item.id, item.stage])).toEqual([
      ["a", "PRODUCING"],
      ["b", "PLANNED"],
    ]);
  });

  it("reports an enabled publish schedule", async () => {
    scheduleCount.mockResolvedValue(1);
    expect((await loadJourneySnapshot("proj-1"))?.publishScheduleEnabled).toBe(true);
    expect(scheduleCount).toHaveBeenCalledWith({
      where: { projectId: "proj-1", capability: "INSTAGRAM_PUBLISH", enabled: true },
    });
  });

  it("carries the measurement results along", async () => {
    const result = {
      creativeId: "a",
      title: "Topic a",
      where: "Instagram · Post",
      check: "24h",
      observation: "Reach 1.2k",
      checkedAt: "2026-10-02T10:00:00.000Z",
    };
    loadPlanResults.mockResolvedValue([result]);
    expect((await loadJourneySnapshot("proj-1"))?.results).toEqual([result]);
    expect(loadPlanResults).toHaveBeenCalledWith("proj-1");
  });

  it("does not look for jobs when there is no plan", async () => {
    creativeFindMany.mockResolvedValue([]);
    const snapshot = await loadJourneySnapshot("proj-1");
    expect(snapshot?.items).toEqual([]);
    expect(taskFindMany).not.toHaveBeenCalled();
  });

  it("never takes the page down", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    creativeFindMany.mockRejectedValue(new Error("db down"));
    expect(await loadJourneySnapshot("proj-1")).toBeNull();
    expect(await loadNextSteps("proj-1")).toEqual([]);
  });
});

describe("loadNextSteps", () => {
  it("turns the snapshot into steps", async () => {
    const steps = await loadNextSteps("proj-1");
    expect(steps[0]).toMatchObject({
      key: "produce",
      action: { kind: "produce_plan", planId: "plan-1", count: 2 },
    });
  });
});
