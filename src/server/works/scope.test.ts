import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ taskFindMany: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: { task: { findMany: mocks.taskFindMany } },
}));

const {
  decisionBelongsTo,
  decisionBelongsToWork,
  workIdsByTask,
  workOwnersByTask,
} = await import("./scope");

describe("decisionBelongsTo", () => {
  const owners = new Map<string, string | null>([
    ["t-here", "w1"],
    ["t-there", "w2"],
    ["t-legacy", null],
  ]);

  it("keeps a decision from this Work", () => {
    expect(decisionBelongsTo("w1", "t-here", owners)).toBe(true);
  });
  it("hides a decision that belongs to another Work", () => {
    expect(decisionBelongsTo("w1", "t-there", owners)).toBe(false);
  });
  it("shows taskless, unknown and Work-less decisions everywhere", () => {
    expect(decisionBelongsTo("w1", undefined, owners)).toBe(true);
    expect(decisionBelongsTo("w1", "t-unknown", owners)).toBe(true);
    expect(decisionBelongsTo("w1", "t-legacy", owners)).toBe(true);
  });
});

describe("workOwnersByTask / workIdsByTask", () => {
  it("returns the owner Work and the capability, scoped to the project", async () => {
    mocks.taskFindMany.mockResolvedValueOnce([
      { id: "t1", capability: "META_CAMPAIGN_UPDATE", command: null },
      { id: "t2", capability: "IMAGE_CREATE", command: { workId: "w1" } },
    ]);
    const owners = await workOwnersByTask("p1", ["t1", "t2"]);
    expect(mocks.taskFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["t1", "t2"] }, projectId: "p1" },
      }),
    );
    expect(owners.get("t1")).toEqual({
      workId: null,
      capability: "META_CAMPAIGN_UPDATE",
    });
    expect(owners.get("t2")).toEqual({ workId: "w1", capability: "IMAGE_CREATE" });
  });

  it("keeps the old workIdsByTask signature and result", async () => {
    mocks.taskFindMany.mockResolvedValueOnce([
      { id: "t1", capability: "META_CAMPAIGN_UPDATE", command: null },
      { id: "t2", capability: "IMAGE_CREATE", command: { workId: "w1" } },
    ]);
    const ids = await workIdsByTask("p1", ["t1", "t2"]);
    expect([...ids]).toEqual([
      ["t1", null],
      ["t2", "w1"],
    ]);
  });

  it("makes no query for no task ids", async () => {
    mocks.taskFindMany.mockClear();
    expect((await workOwnersByTask("p1", [])).size).toBe(0);
    expect(mocks.taskFindMany).not.toHaveBeenCalled();
  });
});

// Guard W108 (ads-scope): real-money proposals must never become unreachable.
describe("decisionBelongsToWork", () => {
  const spend = { workId: null, capability: "META_CAMPAIGN_UPDATE" };
  const base = {
    workId: "w1",
    channels: ["instagram"],
    isToday: false,
    taskId: "t1",
    owner: spend as { workId: string | null; capability: string } | undefined,
    anyActiveWorkCoversAds: true,
  };

  it("shows an unowned spend approval in a Work that chose ads", () => {
    expect(
      decisionBelongsToWork({ ...base, channels: ["instagram", "ads"] }),
    ).toBe(true);
  });
  it("shows it in the Today Work", () => {
    expect(decisionBelongsToWork({ ...base, isToday: true })).toBe(true);
  });
  it("hides it from other Works while an ads Work exists", () => {
    expect(decisionBelongsToWork(base)).toBe(false);
    expect(
      decisionBelongsToWork({
        ...base,
        owner: { workId: null, capability: "META_ADSET_UPDATE" },
      }),
    ).toBe(false);
  });
  it("shows it in EVERY Work when no active Work covers ads", () => {
    expect(
      decisionBelongsToWork({ ...base, anyActiveWorkCoversAds: false }),
    ).toBe(true);
  });
  it("keeps owned decisions strictly scoped, spend or not", () => {
    const owned = { workId: "w2", capability: "META_CAMPAIGN_UPDATE" };
    expect(
      decisionBelongsToWork({
        ...base,
        owner: owned,
        anyActiveWorkCoversAds: false,
        isToday: true,
        channels: ["ads"],
      }),
    ).toBe(false);
    expect(
      decisionBelongsToWork({
        ...base,
        owner: { workId: "w1", capability: "IMAGE_CREATE" },
      }),
    ).toBe(true);
  });
  it("keeps non-META unowned, taskless and unknown decisions everywhere", () => {
    expect(
      decisionBelongsToWork({
        ...base,
        owner: { workId: null, capability: "INSTAGRAM_PUBLISH" },
      }),
    ).toBe(true);
    expect(decisionBelongsToWork({ ...base, taskId: undefined })).toBe(true);
    expect(decisionBelongsToWork({ ...base, owner: undefined })).toBe(true);
  });
  it("still matches decisionBelongsTo for every non-spend case", () => {
    const owners = new Map<string, string | null>([
      ["t-here", "w1"],
      ["t-there", "w2"],
      ["t-legacy", null],
    ]);
    const caps: Record<string, string> = {
      "t-here": "IMAGE_CREATE",
      "t-there": "IMAGE_CREATE",
      "t-legacy": "IMAGE_CREATE",
    };
    for (const taskId of ["t-here", "t-there", "t-legacy", "t-unknown", undefined]) {
      const owner = taskId !== undefined && owners.has(taskId)
        ? { workId: owners.get(taskId) ?? null, capability: caps[taskId] ?? "" }
        : undefined;
      expect(
        decisionBelongsToWork({
          workId: "w1",
          channels: [],
          isToday: false,
          taskId,
          owner,
          anyActiveWorkCoversAds: true,
        }),
      ).toBe(decisionBelongsTo("w1", taskId, owners));
    }
  });
});
