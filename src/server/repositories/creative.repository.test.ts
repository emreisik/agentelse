import { beforeEach, describe, expect, it, vi } from "vitest";

// Content calendar's read/write path (spec: takvim) — verifies the query
// shape sent to Prisma, same mocking pattern as
// agency-loop-state.repository.test.ts (mock the prisma client, assert on
// the args the repository builds).

const findMany = vi.fn();
const updateMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { creative: { findMany, updateMany } },
}));

const { CreativeRepository } = await import("./creative.repository");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CreativeRepository.listForCalendarRange", () => {
  it("matches creatives scheduled in range OR unscheduled-but-plannable, ordered day-first", async () => {
    findMany.mockResolvedValueOnce([]);
    const from = new Date("2026-10-01");
    const to = new Date("2026-10-31");

    await CreativeRepository.listForCalendarRange("proj-1", { from, to });

    expect(findMany).toHaveBeenCalledTimes(1);
    const call = findMany.mock.calls[0]![0];
    expect(call.where).toEqual({
      projectId: "proj-1",
      OR: [
        { scheduledFor: { gte: from, lte: to } },
        {
          scheduledFor: null,
          platform: { not: null },
          status: { in: ["DRAFT", "IN_REVIEW", "APPROVED"] },
        },
      ],
    });
    expect(call.orderBy).toEqual([
      { scheduledFor: { sort: "asc", nulls: "last" } },
      { createdAt: "asc" },
    ]);
    expect(call.include.versions).toMatchObject({
      orderBy: { version: "desc" },
      take: 1,
      include: { asset: true },
    });
  });
});

describe("CreativeRepository.listRecentForPanel", () => {
  it("fetches the most recent creatives for the project, latest version+asset only", async () => {
    findMany.mockResolvedValueOnce([]);

    await CreativeRepository.listRecentForPanel("proj-1");

    expect(findMany).toHaveBeenCalledTimes(1);
    const call = findMany.mock.calls[0]![0];
    expect(call.where).toEqual({ projectId: "proj-1" });
    expect(call.orderBy).toEqual({ createdAt: "desc" });
    expect(call.take).toBe(24);
    expect(call.include.versions).toMatchObject({
      orderBy: { version: "desc" },
      take: 1,
      include: { asset: true },
    });
  });

  it("respects a custom limit", async () => {
    findMany.mockResolvedValueOnce([]);

    await CreativeRepository.listRecentForPanel("proj-1", 6);

    expect(findMany.mock.calls[0]![0].take).toBe(6);
  });
});

describe("CreativeRepository.setScheduledFor", () => {
  it("scopes the update to the given project and sets scheduledFor", async () => {
    updateMany.mockResolvedValueOnce({ count: 1 });
    const date = new Date("2026-10-15");

    const result = await CreativeRepository.setScheduledFor(
      "creative-1",
      "proj-1",
      date,
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "creative-1", projectId: "proj-1" },
      data: { scheduledFor: date },
    });
    expect(result).toEqual({ count: 1 });
  });

  it("clears the day when given null", async () => {
    updateMany.mockResolvedValueOnce({ count: 1 });

    await CreativeRepository.setScheduledFor("creative-1", "proj-1", null);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "creative-1", projectId: "proj-1" },
      data: { scheduledFor: null },
    });
  });
});
