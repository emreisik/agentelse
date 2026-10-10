import { beforeEach, describe, expect, it, vi } from "vitest";

const getForProject = vi.fn();
vi.mock("@/server/repositories/agency-loop-state.repository", () => ({
  AgencyLoopStateRepository: { getForProject },
}));

const taskCount = vi.fn();
const taskFindMany = vi.fn().mockResolvedValue([]);
const dailyStatFindUnique = vi.fn();
const approvalFindMany = vi.fn().mockResolvedValue([]);
vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { count: taskCount, findMany: taskFindMany },
    approval: { findMany: approvalFindMany },
    agencyDailyStat: { findUnique: dailyStatFindUnique },
  },
}));

const { getAgencyStatusSnapshot } = await import("./agency-status-snapshot");

beforeEach(() => {
  vi.clearAllMocks();
  taskFindMany.mockResolvedValue([]);
  approvalFindMany.mockResolvedValue([]);
});

describe("getAgencyStatusSnapshot", () => {
  it("returns null when the project has no AgencyLoopState row yet", async () => {
    getForProject.mockResolvedValue(null);

    const snapshot = await getAgencyStatusSnapshot("proj-new");

    expect(snapshot).toBeNull();
    expect(taskCount).not.toHaveBeenCalled();
  });

  it("excludes internal capabilities from tasksNow/tasksWaiting and defaults today's stats to zero when no AgencyDailyStat row exists", async () => {
    getForProject.mockResolvedValue({
      status: "RUNNING",
      lastTickAt: new Date("2026-09-22T10:00:00Z"),
      lastProgressAt: null,
      nextWakeAt: null,
      blockedReason: null,
      consecutiveNoProgressCycles: 0,
    });
    taskCount.mockResolvedValueOnce(3).mockResolvedValueOnce(2);
    dailyStatFindUnique.mockResolvedValue(null);

    const snapshot = await getAgencyStatusSnapshot("proj-1");

    expect(snapshot).toEqual({
      status: "RUNNING",
      lastTickAt: "2026-09-22T10:00:00.000Z",
      lastProgressAt: null,
      nextWakeAt: null,
      blockedReason: null,
      consecutiveNoProgressCycles: 0,
      tasksNow: 3,
      tasksWaiting: 2,
      activeJobs: [],
      today: {
        tasksCreated: 0,
        signalsIngested: 0,
        opportunitiesCreated: 0,
        ideasCreated: 0,
        reasoningCalls: 0,
        reasoningCostUsd: 0,
      },
    });
    expect(taskCount).toHaveBeenNthCalledWith(1, {
      where: {
        projectId: "proj-1",
        status: { in: ["READY", "QUEUED", "RUNNING", "VERIFYING"] },
        capability: {
          notIn: ["SIGNAL_SCAN", "MEASUREMENT_CHECK", "VERIFY_EXTERNAL_ACTION"],
        },
      },
    });
    expect(taskCount).toHaveBeenNthCalledWith(2, {
      where: {
        projectId: "proj-1",
        status: {
          in: [
            "WAITING_INPUT",
            "WAITING_HUMAN",
            "WAITING_APPROVAL",
            "WAITING_PROVIDER",
          ],
        },
        capability: {
          notIn: ["SIGNAL_SCAN", "MEASUREMENT_CHECK", "VERIFY_EXTERNAL_ACTION"],
        },
      },
    });
  });

  it("surfaces today's AgencyDailyStat counters when a row exists", async () => {
    getForProject.mockResolvedValue({
      status: "WAITING",
      lastTickAt: null,
      lastProgressAt: null,
      nextWakeAt: new Date("2026-09-22T12:00:00Z"),
      blockedReason: null,
      consecutiveNoProgressCycles: 6,
    });
    taskCount.mockResolvedValue(0);
    dailyStatFindUnique.mockResolvedValue({
      tasksCreated: 5,
      signalsIngested: 12,
      opportunitiesCreated: 2,
      ideasCreated: 1,
      reasoningCalls: 40,
      reasoningCostUsd: 3.25,
    });

    const snapshot = await getAgencyStatusSnapshot("proj-2");

    expect(snapshot?.today).toEqual({
      tasksCreated: 5,
      signalsIngested: 12,
      opportunitiesCreated: 2,
      ideasCreated: 1,
      reasoningCalls: 40,
      reasoningCostUsd: 3.25,
    });
    expect(snapshot?.consecutiveNoProgressCycles).toBe(6);
  });

  it("maps active task rows into named jobs with plain-language status words, stripping any legacy capability prefix from the title", async () => {
    getForProject.mockResolvedValue({
      status: "RUNNING",
      lastTickAt: null,
      lastProgressAt: null,
      nextWakeAt: null,
      blockedReason: null,
      consecutiveNoProgressCycles: 0,
    });
    taskCount.mockResolvedValue(0);
    dailyStatFindUnique.mockResolvedValue(null);
    taskFindMany.mockResolvedValue([
      {
        id: "task-1",
        title: "CREATE_CAMPAIGN_BRIEF: Russia Wholesale Campaign",
        status: "RUNNING",
      },
      { id: "task-2", title: "Friday Reel", status: "WAITING_APPROVAL" },
    ]);

    approvalFindMany.mockResolvedValue([
      { id: "appr-2", taskId: "task-2", level: "LEVEL_3_CLIENT" },
    ]);

    const snapshot = await getAgencyStatusSnapshot("proj-3");

    expect(snapshot?.activeJobs).toEqual([
      {
        id: "task-1",
        title: "Russia Wholesale Campaign",
        statusWord: "Creating",
      },
      {
        id: "task-2",
        title: "Friday Reel",
        statusWord: "Needs approval",
        approval: { id: "appr-2", spend: false },
      },
    ]);
    // Only the waiting task is looked up, and only its pending approval.
    expect(approvalFindMany).toHaveBeenCalledWith({
      where: { projectId: "proj-3", taskId: { in: ["task-2"] }, status: "PENDING" },
      select: { id: true, taskId: true, level: true },
    });
  });

  it("marks a LEVEL_4 approval as spend so the popover asks twice", async () => {
    getForProject.mockResolvedValue({
      status: "RUNNING",
      lastTickAt: null,
      lastProgressAt: null,
      nextWakeAt: null,
      blockedReason: null,
      consecutiveNoProgressCycles: 0,
    });
    taskCount.mockResolvedValue(0);
    dailyStatFindUnique.mockResolvedValue(null);
    taskFindMany.mockResolvedValue([
      { id: "task-9", title: "Update Meta campaign budget", status: "WAITING_APPROVAL" },
    ]);
    approvalFindMany.mockResolvedValue([
      { id: "appr-9", taskId: "task-9", level: "LEVEL_4_CRITICAL" },
    ]);

    const snapshot = await getAgencyStatusSnapshot("proj-4");

    expect(snapshot?.activeJobs[0]?.approval).toEqual({
      id: "appr-9",
      spend: true,
    });
  });
});
