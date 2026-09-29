import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves about running a job inline: exactly one side runs the
// provider (this caller after taking the job's dispatch event, or the worker
// that already holds it), and the caller always gets the settled outcome.

const findUniqueOrThrow = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { executionJob: { findUniqueOrThrow } },
}));

const startExecution = vi.fn();
vi.mock("@/server/execution/execution-service", () => ({
  ExecutionService: { startExecution },
}));

const claimDispatchForInline = vi.fn();
vi.mock("@/server/repositories/outbox.repository", () => ({
  OutboxRepository: { claimDispatchForInline },
}));

const { driveJobInline, waitForJobToSettle } = await import("./inline-job");

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
