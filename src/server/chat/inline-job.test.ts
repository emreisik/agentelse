import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentelseError } from "@/server/security/errors";

// What this suite proves about running a job inline: exactly one side runs the
// provider (this caller after taking the job's dispatch event, or the worker
// that already holds it), and the caller always gets the settled outcome.

const findUniqueOrThrow = vi.fn();
const findUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { executionJob: { findUniqueOrThrow, findUnique } },
}));

const startExecution = vi.fn();
vi.mock("@/server/execution/execution-service", () => ({
  ExecutionService: { startExecution },
}));

const claimDispatchForInline = vi.fn();
const enqueue = vi.fn();
vi.mock("@/server/repositories/outbox.repository", () => ({
  OUTBOX_EVENT_TYPES: { EXECUTION_DISPATCH: "execution.dispatch" },
  OutboxRepository: { claimDispatchForInline, enqueue },
}));

const { driveJobInline, waitForJobToSettle } = await import("./inline-job");
const { isParked } = await import("./parked-job");

const completed = { status: "COMPLETED", errorMessage: null };
const running = { status: "RUNNING", errorMessage: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("driveJobInline", () => {
  it("takes the dispatch event, then starts the job itself", async () => {
    claimDispatchForInline.mockResolvedValue("claimed");
    startExecution.mockResolvedValue(completed);

    await expect(driveJobInline("job-1", "LOW")).resolves.toEqual(completed);

    expect(claimDispatchForInline).toHaveBeenCalledWith("job-1");
    // No stalled-dispatch recovery option: the worker's own retry path is the
    // only caller that may reset a RUNNING job.
    expect(startExecution).toHaveBeenCalledWith("job-1", "LOW");
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("starts the job when no live dispatch event exists", async () => {
    claimDispatchForInline.mockResolvedValue("none");
    startExecution.mockResolvedValue(completed);

    await driveJobInline("job-1", "LOW");

    expect(startExecution).toHaveBeenCalledTimes(1);
  });

  it("leaves the job to the worker that holds its dispatch event", async () => {
    claimDispatchForInline.mockResolvedValue("worker");
    findUniqueOrThrow
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(completed);

    const result = driveJobInline("job-1", "LOW");
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toEqual(completed);
    // Starting it here too would run the provider twice.
    expect(startExecution).not.toHaveBeenCalled();
  });

  it("waits for a job that was still running when start returned", async () => {
    claimDispatchForInline.mockResolvedValue("claimed");
    startExecution.mockResolvedValue(running);
    findUniqueOrThrow.mockResolvedValue(completed);

    await expect(driveJobInline("job-1", "LOW")).resolves.toEqual(completed);
    expect(findUniqueOrThrow).toHaveBeenCalledTimes(1);
  });
});

describe("waitForJobToSettle", () => {
  it("gives up after the wait limit and reports the job as still running", async () => {
    findUniqueOrThrow.mockResolvedValue(running);

    const result = waitForJobToSettle("job-1");
    await vi.advanceTimersByTimeAsync(160_000);

    await expect(result).resolves.toEqual(running);
  });
});

describe("plan allowance", () => {
  it("returns a parked job as it is: waiting, not failed and not rendering", async () => {
    const parked = { status: "WAITING_BUDGET", errorMessage: "used up" };
    claimDispatchForInline.mockResolvedValue("claimed");
    startExecution.mockResolvedValue(parked);

    const result = await driveJobInline("job-1", "LOW");

    expect(result).toEqual(parked);
    expect(isParked(result)).toBe(true);
    // A parked job is a settled outcome: nothing to wait for here.
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
    expect(isParked({ status: "COMPLETED" })).toBe(false);
    expect(isParked({ status: "QUEUED" })).toBe(false);
  });

  it("hands the job back to the worker when the usage ledger cannot be read", async () => {
    claimDispatchForInline.mockResolvedValue("claimed");
    startExecution.mockRejectedValue(
      new AgentelseError("BILLING_UNAVAILABLE", "ledger down", {
        retryable: true,
      }),
    );
    findUnique.mockResolvedValue({
      workspaceId: "ws-1",
      projectId: "p-1",
      status: "QUEUED",
    });

    await expect(driveJobInline("job-1", "LOW")).resolves.toEqual({
      status: "QUEUED",
      errorMessage: null,
    });

    // The event taken above is replaced, so the job is not left queued with
    // nothing that would ever start it.
    expect(enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: "ws-1",
        projectId: "p-1",
        eventType: "execution.dispatch",
        executionJobId: "job-1",
        payload: { executionJobId: "job-1", riskLevel: "LOW" },
      }),
    );
  });
});
