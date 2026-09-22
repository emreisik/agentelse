import { beforeEach, describe, expect, it, vi } from "vitest";

// Circuit breaker (audit scenarios I/J): recordNoProgress must trip the
// loop from RUNNING to WAITING once the consecutive-no-progress streak
// crosses the threshold, with a computed nextWakeAt — and recordProgress
// must always bring it back to RUNNING, clearing the streak.

const update = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { agencyLoopState: { update } },
}));

const { AgencyLoopStateRepository } =
  await import("./agency-loop-state.repository");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AgencyLoopStateRepository.recordNoProgress (circuit breaker, audit scenarios I/J)", () => {
  it("does not transition to WAITING before the streak reaches the threshold", async () => {
    update.mockResolvedValueOnce({
      status: "RUNNING",
      consecutiveNoProgressCycles: 3,
    });

    await AgencyLoopStateRepository.recordNoProgress("p-1");

    expect(update).toHaveBeenCalledTimes(1);
  });

  it("transitions RUNNING -> WAITING with a computed nextWakeAt once the streak hits the threshold", async () => {
    update
      .mockResolvedValueOnce({
        status: "RUNNING",
        consecutiveNoProgressCycles: 5,
      })
      .mockResolvedValueOnce({
        status: "WAITING",
        consecutiveNoProgressCycles: 5,
      });

    await AgencyLoopStateRepository.recordNoProgress("p-1");

    expect(update).toHaveBeenCalledTimes(2);
    const secondCall = update.mock.calls[1]![0];
    expect(secondCall.where).toEqual({ projectId: "p-1" });
    expect(secondCall.data.status).toBe("WAITING");
    expect(secondCall.data.nextWakeAt).toBeInstanceOf(Date);
    expect(secondCall.data.nextWakeAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("does not re-trip (no second write) once already WAITING", async () => {
    update.mockResolvedValueOnce({
      status: "WAITING",
      consecutiveNoProgressCycles: 8,
    });

    await AgencyLoopStateRepository.recordNoProgress("p-1");

    expect(update).toHaveBeenCalledTimes(1);
  });

  it("does not trip a PAUSED loop into WAITING", async () => {
    update.mockResolvedValueOnce({
      status: "PAUSED",
      consecutiveNoProgressCycles: 9,
    });

    await AgencyLoopStateRepository.recordNoProgress("p-1");

    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe("AgencyLoopStateRepository.recordProgress (recovers from WAITING)", () => {
  it("resets status to RUNNING and clears the no-progress streak", async () => {
    update.mockResolvedValueOnce({ status: "RUNNING" });

    await AgencyLoopStateRepository.recordProgress("p-1");

    expect(update).toHaveBeenCalledWith({
      where: { projectId: "p-1" },
      data: expect.objectContaining({
        status: "RUNNING",
        consecutiveNoProgressCycles: 0,
        blockedReason: null,
      }),
    });
  });
});
