import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves about the journey snapshot: it reads only THIS
// project's plan slots (archived ones out), ties jobs to slots through the plan
// Command and Task.payload.planCreativeId, reports whether anything releases
// approved posts, and never takes a page down (null / [] on any failure).

const creativeFindMany = vi.fn();
const taskFindMany = vi.fn();
const scheduleCount = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    creative: { findMany: creativeFindMany },
    task: { findMany: taskFindMany },
    projectSchedule: { count: scheduleCount },
  },
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
  scheduleCount.mockResolvedValue(0);
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
        },
      }),
    );
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
