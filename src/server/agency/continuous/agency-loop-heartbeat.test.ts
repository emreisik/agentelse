import { beforeEach, describe, expect, it, vi } from "vitest";

// The core guarantee: AgencyLoopState.status actually reflects
// Project.status = PAUSED — previously the only engine that ever checked
// Project.status at all was SignalUniverse.runDueScans.

const autonomyPolicy = { findMany: vi.fn() };
const project = { findUnique: vi.fn() };

vi.mock("@/lib/prisma", () => ({
  prisma: { autonomyPolicy, project },
}));

const getOrCreate = vi.fn();
const setPaused = vi.fn().mockResolvedValue(undefined);
const resumeFromPause = vi.fn().mockResolvedValue(undefined);
const touch = vi.fn().mockResolvedValue(undefined);

vi.mock("@/server/repositories/agency-loop-state.repository", () => ({
  AgencyLoopStateRepository: { getOrCreate, setPaused, resumeFromPause, touch },
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
    project.findUnique.mockResolvedValue({ status: "PAUSED" });
    getOrCreate.mockResolvedValue({ status: "RUNNING" });

    await AgencyLoopHeartbeat.run();

    expect(setPaused).toHaveBeenCalledWith("p-1", "Project is paused");
    expect(resumeFromPause).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
  });

  it("does not re-pause a loop state that's already PAUSED", async () => {
    project.findUnique.mockResolvedValue({ status: "PAUSED" });
    getOrCreate.mockResolvedValue({ status: "PAUSED" });

    await AgencyLoopHeartbeat.run();

    expect(setPaused).not.toHaveBeenCalled();
  });

  it("resumes a PAUSED loop state once the project is ACTIVE again", async () => {
    project.findUnique.mockResolvedValue({ status: "ACTIVE" });
    getOrCreate.mockResolvedValue({ status: "PAUSED" });

    await AgencyLoopHeartbeat.run();

    expect(resumeFromPause).toHaveBeenCalledWith("p-1");
    expect(setPaused).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
  });

  it("just touches lastTickAt for a normal active, non-paused project", async () => {
    project.findUnique.mockResolvedValue({ status: "ACTIVE" });
    getOrCreate.mockResolvedValue({ status: "RUNNING" });

    await AgencyLoopHeartbeat.run();

    expect(touch).toHaveBeenCalledWith("p-1");
    expect(setPaused).not.toHaveBeenCalled();
    expect(resumeFromPause).not.toHaveBeenCalled();
  });
});
