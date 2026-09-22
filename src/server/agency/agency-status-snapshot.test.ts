import { beforeEach, describe, expect, it, vi } from "vitest";

const getForProject = vi.fn();
vi.mock("@/server/repositories/agency-loop-state.repository", () => ({
  AgencyLoopStateRepository: { getForProject },
}));

const taskCount = vi.fn();
const dailyStatFindUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { count: taskCount },
    agencyDailyStat: { findUnique: dailyStatFindUnique },
  },
}));

const { getAgencyStatusSnapshot } = await import("./agency-status-snapshot");

beforeEach(() => {
  vi.clearAllMocks();
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
});
