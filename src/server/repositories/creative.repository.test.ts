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

describe("CreativeRepository.listScheduledInRange", () => {
  it("runs a slim, bounded query that skips archived and rejected creatives", async () => {
    findMany.mockResolvedValueOnce([]);
    const from = new Date("2026-10-01");
    const to = new Date("2026-10-31");

    await CreativeRepository.listScheduledInRange("proj-1", { from, to });

    const call = findMany.mock.calls[0]![0];
    expect(call.where).toEqual({
      projectId: "proj-1",
      scheduledFor: { gte: from, lte: to },
      status: { notIn: ["ARCHIVED", "REJECTED"] },
      excludedAt: null,
    });
    expect(call.orderBy).toEqual({ scheduledFor: "asc" });
    expect(call.take).toBe(500);
    expect(call.select).toEqual({
      id: true,
      scheduledFor: true,
      channel: true,
      platform: true,
      status: true,
    });
    expect(call.include).toBeUndefined();
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

describe("CreativeRepository.appendVersionTx", () => {
  function makeTx(latest: number | null) {
    return {
      creative: {
        findFirst: vi.fn().mockResolvedValue(
          latest === null
            ? null
            : { id: "c1", versions: latest === 0 ? [] : [{ version: latest }] },
        ),
        update: vi.fn().mockResolvedValue({}),
      },
      creativeVersion: {
        create: vi.fn().mockResolvedValue({ id: "v-new", version: 0 }),
      },
    };
  }

  it("creates the next version and points the creative at it, over the given tx", async () => {
    const tx = makeTx(2);
    const out = await CreativeRepository.appendVersionTx(
      tx as never,
      "c1",
      "p1",
      { assetId: "a2", revisionReason: "Picked another picture" },
    );
    expect(tx.creative.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "c1", projectId: "p1" } }),
    );
    expect(tx.creativeVersion.create.mock.calls[0]![0].data).toMatchObject({
      creativeId: "c1",
      version: 3,
      assetId: "a2",
    });
    expect(tx.creative.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { currentVersionId: "v-new" },
    });
    expect(out.id).toBe("v-new");
  });

  it("starts at version 1 and refuses a creative outside the project", async () => {
    const tx = makeTx(0);
    await CreativeRepository.appendVersionTx(tx as never, "c1", "p1", {});
    expect(tx.creativeVersion.create.mock.calls[0]![0].data.version).toBe(1);
    await expect(
      CreativeRepository.appendVersionTx(makeTx(null) as never, "c1", "p2", {}),
    ).rejects.toThrow(/not found/);
  });
});
