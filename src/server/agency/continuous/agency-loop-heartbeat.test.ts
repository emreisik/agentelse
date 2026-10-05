import { beforeEach, describe, expect, it, vi } from "vitest";

// The core guarantee: AgencyLoopState.status actually reflects
// Project.status = PAUSED — previously the only engine that ever checked
// Project.status at all was SignalUniverse.runDueScans.

const autonomyPolicy = { findMany: vi.fn() };
const project = { findMany: vi.fn() };

vi.mock("@/lib/prisma", () => ({
  prisma: { autonomyPolicy, project },
}));

const statusesFor = vi.fn();
const setPausedMany = vi.fn().mockResolvedValue(undefined);
const resumeFromPauseMany = vi.fn().mockResolvedValue(undefined);
const touchMany = vi.fn().mockResolvedValue(undefined);

vi.mock("@/server/repositories/agency-loop-state.repository", () => ({
  AgencyLoopStateRepository: {
    statusesFor,
    setPausedMany,
    resumeFromPauseMany,
    touchMany,
  },
}));

const { AgencyLoopHeartbeat } =
  await import("@/server/agency/continuous/agency-loop-heartbeat");

const policy = { workspaceId: "ws-1", projectId: "p-1", brandId: "b-1" };

beforeEach(() => {
  vi.clearAllMocks();
  autonomyPolicy.findMany.mockResolvedValue([policy]);
});

describe("AgencyLoopHeartbeat.run", () => {
  it("pauses the loop state when the project is PAUSED and wasn't already", async () => {
    project.findMany.mockResolvedValue([{ id: "p-1", status: "PAUSED" }]);
    statusesFor.mockResolvedValue(new Map([["p-1", "RUNNING"]]));

    await AgencyLoopHeartbeat.run();

    expect(setPausedMany).toHaveBeenCalledWith(["p-1"], "Project is paused");
    expect(resumeFromPauseMany).not.toHaveBeenCalled();
    expect(touchMany).not.toHaveBeenCalled();
  });

  it("does not re-pause a loop state that's already PAUSED", async () => {
    project.findMany.mockResolvedValue([{ id: "p-1", status: "PAUSED" }]);
    statusesFor.mockResolvedValue(new Map([["p-1", "PAUSED"]]));

    await AgencyLoopHeartbeat.run();

    expect(setPausedMany).not.toHaveBeenCalled();
  });

  it("resumes a PAUSED loop state once the project is ACTIVE again", async () => {
    project.findMany.mockResolvedValue([{ id: "p-1", status: "ACTIVE" }]);
    statusesFor.mockResolvedValue(new Map([["p-1", "PAUSED"]]));

    await AgencyLoopHeartbeat.run();

    expect(resumeFromPauseMany).toHaveBeenCalledWith(["p-1"]);
    expect(setPausedMany).not.toHaveBeenCalled();
    expect(touchMany).not.toHaveBeenCalled();
  });

  it("just touches lastTickAt for a normal active, non-paused project", async () => {
    project.findMany.mockResolvedValue([{ id: "p-1", status: "ACTIVE" }]);
    statusesFor.mockResolvedValue(new Map([["p-1", "RUNNING"]]));

    await AgencyLoopHeartbeat.run();

    expect(touchMany).toHaveBeenCalledWith(["p-1"]);
    expect(setPausedMany).not.toHaveBeenCalled();
    expect(resumeFromPauseMany).not.toHaveBeenCalled();
  });
});
