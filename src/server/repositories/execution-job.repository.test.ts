import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    executionJob: {
      updateMany: prismaMocks.updateMany,
    },
  },
}));

import { ExecutionJobRepository } from "@/server/repositories/execution-job.repository";

describe("ExecutionJobRepository.claimQueuedForProvider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("allows only one provider execution claim for the same queued job", async () => {
    let persistedStatus = "QUEUED";
    prismaMocks.updateMany.mockImplementation(
      async (input: { where: { status: string } }) => {
        if (input.where.status === "QUEUED" && persistedStatus === "QUEUED") {
          persistedStatus = "RUNNING";
          return { count: 1 };
        }
        return { count: 0 };
      },
    );

    const claims = await Promise.all([
      ExecutionJobRepository.claimQueuedForProvider("job-1", {
        type: "OPENCLAW",
        key: "openclaw",
      }),
      ExecutionJobRepository.claimQueuedForProvider("job-1", {
        type: "OPENCLAW",
        key: "openclaw",
      }),
    ]);

    expect(claims.sort()).toEqual([false, true]);
    expect(prismaMocks.updateMany).toHaveBeenCalledTimes(2);
    expect(prismaMocks.updateMany).toHaveBeenCalledWith({
      where: { id: "job-1", status: "QUEUED" },
      data: {
        status: "RUNNING",
        providerType: "OPENCLAW",
        providerId: "openclaw",
        startedAt: expect.any(Date),
        attemptCount: { increment: 1 },
      },
    });
  });

  it("requeues only a RUNNING dispatch without a provider reference", async () => {
    prismaMocks.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      ExecutionJobRepository.recoverStalledProviderDispatch("job-1"),
    ).resolves.toBe(true);

    expect(prismaMocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: "job-1",
        status: "RUNNING",
        providerExecutionReference: null,
      },
      data: {
        status: "QUEUED",
        providerType: "SYSTEM",
        providerId: null,
        startedAt: null,
      },
    });
  });
});
