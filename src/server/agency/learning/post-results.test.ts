import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: the results views list the project's published posts
// with the owner's latest verdict and the pool idea each came from (from the
// plan card, else the link recorded at publish); Instagram numbers come from
// one read of the account's latest media, matched by the media id the publish
// job kept, compared with the other recent posts, and are never asked for when
// no post needs them; a verdict teaches memory, moves the idea to LEARNED with
// its result merged, and leaves the audit row that marks the post judged.

const creative = { findMany: vi.fn(), findFirst: vi.fn() };
const task = { findMany: vi.fn() };
const auditLog = { findMany: vi.fn(), findFirst: vi.fn() };
const command = { findMany: vi.fn(), findFirst: vi.fn() };
const executionJob = { findMany: vi.fn() };
const integrationCredential = { findUnique: vi.fn() };
const ideaTx = { findFirst: vi.fn(), update: vi.fn() };
const $transaction = vi.fn(async (fn: (tx: unknown) => unknown) =>
  fn({ $executeRaw: vi.fn(), idea: ideaTx }),
);
vi.mock("@/lib/prisma", () => ({
  prisma: {
    creative,
    task,
    auditLog,
    command,
    executionJob,
    integrationCredential,
    $transaction,
  },
}));

const fetchInstagramPostStats = vi.fn();
vi.mock("@/server/integrations/meta-client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/server/integrations/meta-client")
  >()),
  fetchInstagramPostStats,
}));
vi.mock("@/server/integrations/instagram-target", () => ({
  resolveInstagramTarget: vi.fn(() => ({
    igUserId: "ig-1",
    login: "instagram",
  })),
  instagramLoginExpired: vi.fn(() => false),
  instagramAccessFor: vi.fn(async () => ({
    accessToken: "t",
    api: "instagram",
  })),
}));
vi.mock("@/server/security/crypto", () => ({
  decryptSecret: vi.fn(() => "s"),
}));

const rememberPostResult = vi.fn();
vi.mock("@/server/memory/memory-service", () => ({
  MemoryService: { rememberPostResult },
}));
const record = vi.fn();
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record },
}));
const advanceForScheduling = vi.fn();
vi.mock("@/server/repositories/idea.repository", () => ({
  IdeaRepository: { advanceForScheduling },
}));

const {
  loadPostResults,
  recordPostVerdict,
  ideaOfCard,
  postsAwaitingVerdict,
  countAwaitingVerdict,
  recordPublishedIdeaLink,
  clearPostResultsCache,
} = await import("./post-results");

const NOW = new Date("2026-10-10T12:00:00Z");
const planCard = {
  kind: "content-plan-draft",
  title: "Plan",
  timezone: "Europe/Istanbul",
  state: "saved",
  items: [
    {
      date: "2026-10-05",
      time: "10:00",
      topic: "A",
      captionIdea: "a",
      ideaId: "idea-1",
    },
    { date: "2026-10-07", time: "10:00", topic: "B", captionIdea: "b" },
  ],
  savedCreativeIds: ["c1", "c2"],
};
const published = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Post ${id}`,
  channel: "instagram",
  formatKey: "instagram.post",
  planId: "plan-1",
  updatedAt: new Date("2026-10-06T10:00:00Z"),
  versions: [{ assetId: `asset-${id}` }],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  clearPostResultsCache();
  console.error = vi.fn();
  creative.findMany.mockResolvedValue([published("c1"), published("c2")]);
  task.findMany.mockResolvedValue([
    {
      id: "t1",
      capability: "INSTAGRAM_PUBLISH",
      completedAt: new Date("2026-10-05T07:01:00Z"),
      payload: { creativeId: "c1" },
    },
    {
      id: "t2",
      capability: "LINKEDIN_PUBLISH",
      completedAt: new Date("2026-10-07T07:01:00Z"),
      payload: { creativeId: "c2" },
    },
  ]);
  executionJob.findMany.mockResolvedValue([
    { taskId: "t1", rawResult: { postId: "m1" } },
  ]);
  auditLog.findMany.mockResolvedValue([]);
  command.findMany.mockResolvedValue([
    { id: "plan-1", parsedIntent: { card: planCard } },
  ]);
  integrationCredential.findUnique.mockResolvedValue({
    status: "ACTIVE",
    metadata: {},
    encryptedSecret: "x",
  });
  fetchInstagramPostStats.mockResolvedValue([
    {
      id: "m1",
      likes: 90,
      comments: 10,
      permalink: "https://instagram.com/p/m1",
    },
    { id: "m2", likes: 20, comments: 0, permalink: null },
    { id: "m3", likes: 30, comments: 0, permalink: null },
    { id: "m4", likes: 40, comments: 0, permalink: null },
  ]);
});

describe("ideaOfCard", () => {
  it("finds the idea of a saved slot by its position", () => {
    expect(ideaOfCard(planCard, "c1")).toBe("idea-1");
    expect(ideaOfCard(planCard, "c2")).toBeNull();
    expect(ideaOfCard(planCard, "c9")).toBeNull();
    expect(ideaOfCard({ kind: "creative-ready" }, "c1")).toBeNull();
  });
});

describe("loadPostResults", () => {
  it("lists published posts with live Instagram numbers, the idea and the verdict", async () => {
    auditLog.findMany.mockImplementation(
      async ({ where }: { where: { action: string } }) =>
        where.action === "creative.result_verdict"
          ? [
              { entityId: "c1", metadata: { verdict: "WORKED" } },
              { entityId: "c1", metadata: { verdict: "DIDNT" } },
            ]
          : [],
    );

    const { items, statsNote } = await loadPostResults("p1", { now: NOW });

    expect(statsNote).toBeNull();
    expect(items).toEqual([
      // Waiting for a verdict first, then the judged ones.
      {
        creativeId: "c2",
        title: "Post c2",
        channel: "instagram",
        formatKey: "instagram.post",
        publishedAt: "2026-10-07T07:01:00.000Z",
        assetId: "asset-c2",
        ideaId: null,
        verdict: null,
        // A LinkedIn publish: nothing to read.
        stats: null,
      },
      {
        creativeId: "c1",
        title: "Post c1",
        channel: "instagram",
        formatKey: "instagram.post",
        publishedAt: "2026-10-05T07:01:00.000Z",
        assetId: "asset-c1",
        ideaId: "idea-1",
        // The newest audit row wins.
        verdict: "WORKED",
        stats: {
          likes: 90,
          comments: 10,
          permalink: "https://instagram.com/p/m1",
          comparison: "above",
        },
      },
    ]);
    expect(fetchInstagramPostStats).toHaveBeenCalledTimes(1);
    expect(fetchInstagramPostStats).toHaveBeenCalledWith(
      expect.objectContaining({ igUserId: "ig-1", limit: 50 }),
    );
  });

  it("does not read Instagram when no post was published there by the agency", async () => {
    executionJob.findMany.mockResolvedValue([]);
    const { items } = await loadPostResults("p1", { now: NOW });
    expect(fetchInstagramPostStats).not.toHaveBeenCalled();
    expect(items.every((item) => item.stats === null)).toBe(true);
  });

  it("reads Instagram once for several views, and says why numbers are missing", async () => {
    await loadPostResults("p1", { now: NOW });
    await loadPostResults("p1", { now: NOW, creativeId: "c1" });
    expect(fetchInstagramPostStats).toHaveBeenCalledTimes(1);

    clearPostResultsCache();
    integrationCredential.findUnique.mockResolvedValue(null);
    const { statsNote, items } = await loadPostResults("p1", { now: NOW });
    expect(statsNote).toBe("not_connected");
    expect(items[0]!.stats).toBeNull();
  });

  it("falls back to the idea link recorded at publish when the plan card is gone", async () => {
    command.findMany.mockResolvedValue([]);
    auditLog.findMany.mockImplementation(
      async ({ where }: { where: { action: string } }) =>
        where.action === "creative.published"
          ? [{ entityId: "c2", metadata: { ideaId: "idea-7" } }]
          : [],
    );
    const { items } = await loadPostResults("p1", { now: NOW });
    expect(items.find((item) => item.creativeId === "c2")?.ideaId).toBe(
      "idea-7",
    );
  });

  it("returns nothing without published posts", async () => {
    creative.findMany.mockResolvedValue([]);
    expect(await loadPostResults("p1", { now: NOW })).toEqual({
      items: [],
      statsNote: null,
    });
    expect(task.findMany).not.toHaveBeenCalled();
  });
});

describe("recordPublishedIdeaLink", () => {
  const input = { workspaceId: "w1", projectId: "p1", creativeId: "c1", taskId: "t1" };

  it("records the idea a published piece came from, once", async () => {
    auditLog.findFirst.mockResolvedValue(null);
    creative.findFirst.mockResolvedValue({ planId: "plan-1", brandId: "b1" });
    command.findFirst.mockResolvedValue({ parsedIntent: { card: planCard } });
    await recordPublishedIdeaLink(input);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "creative.published",
        entityId: "c1",
        metadata: { ideaId: "idea-1", planId: "plan-1", taskId: "t1" },
      }),
    );

    // A retried trigger or a manual mark after it writes nothing more.
    record.mockClear();
    auditLog.findFirst.mockResolvedValue({ id: "a1" });
    await recordPublishedIdeaLink(input);
    expect(record).not.toHaveBeenCalled();
  });

  it("writes nothing for a piece with no idea, and never throws", async () => {
    auditLog.findFirst.mockResolvedValue(null);
    creative.findFirst.mockResolvedValue({ planId: "plan-1", brandId: "b1" });
    command.findFirst.mockResolvedValue({ parsedIntent: { card: planCard } });
    await recordPublishedIdeaLink({ ...input, creativeId: "c2" });
    expect(record).not.toHaveBeenCalled();

    auditLog.findFirst.mockRejectedValue(new Error("db down"));
    await expect(recordPublishedIdeaLink(input)).resolves.toBeUndefined();
  });
});

describe("countAwaitingVerdict", () => {
  it("counts the unjudged among the posts the results dialog lists", async () => {
    creative.findMany.mockResolvedValue([{ id: "c1" }, { id: "c2" }, { id: "c3" }]);
    auditLog.findMany.mockResolvedValue([{ entityId: "c2" }]);
    expect(await countAwaitingVerdict("p1", NOW)).toBe(2);
    expect(creative.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: "p1", status: "PUBLISHED" }),
        take: 60,
      }),
    );
  });
});

describe("postsAwaitingVerdict", () => {
  it("keeps the posts without a verdict row", async () => {
    auditLog.findMany.mockResolvedValue([{ entityId: "c1" }]);
    expect(await postsAwaitingVerdict("p1", ["c1", "c2"])).toEqual(["c2"]);
    auditLog.findMany.mockClear();
    expect(await postsAwaitingVerdict("p1", [])).toEqual([]);
    expect(auditLog.findMany).not.toHaveBeenCalled();
  });
});

describe("recordPostVerdict", () => {
  const input = {
    workspaceId: "w1",
    projectId: "p1",
    brandId: "b1",
    userId: "u1",
    creativeId: "c1",
    verdict: "WORKED" as const,
    now: NOW,
  };

  it("refuses a post that is not published", async () => {
    creative.findFirst.mockResolvedValue({
      status: "APPROVED",
      planId: "plan-1",
    });
    expect(await recordPostVerdict(input)).toEqual({
      ok: false,
      reason: "NOT_PUBLISHED",
    });
    expect(rememberPostResult).not.toHaveBeenCalled();
    creative.findFirst.mockResolvedValue(null);
    expect(await recordPostVerdict(input)).toEqual({
      ok: false,
      reason: "NOT_FOUND",
    });
  });

  it("teaches memory, moves the idea to LEARNED with its result, and marks the post judged", async () => {
    creative.findFirst.mockResolvedValue({
      status: "PUBLISHED",
      planId: "plan-1",
    });
    command.findFirst.mockResolvedValue({ parsedIntent: { card: planCard } });
    advanceForScheduling.mockResolvedValue("MEASURING");
    ideaTx.findFirst.mockResolvedValue({
      status: "MEASURING",
      scores: { x: 1 },
    });

    expect(await recordPostVerdict(input)).toEqual({
      ok: true,
      ideaLearned: true,
    });

    expect(rememberPostResult).toHaveBeenCalledWith({
      scope: { workspaceId: "w1", projectId: "p1", brandId: "b1" },
      creativeId: "c1",
      verdict: "WORKED",
      note: undefined,
    });
    expect(advanceForScheduling).toHaveBeenCalledWith("idea-1", "p1");
    expect(ideaTx.update).toHaveBeenCalledWith({
      where: { id: "idea-1" },
      data: {
        status: "LEARNED",
        scores: {
          x: 1,
          results: {
            posts: { c1: { verdict: "WORKED", at: NOW.toISOString() } },
            worked: 1,
            didNotWork: 0,
          },
        },
      },
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "creative.result_verdict",
        entityType: "Creative",
        entityId: "c1",
        actorType: "USER",
        metadata: { verdict: "WORKED", ideaId: "idea-1", ideaLearned: true },
      }),
    );
  });

  it("still records the lesson and the verdict when the idea cannot move", async () => {
    creative.findFirst.mockResolvedValue({
      status: "PUBLISHED",
      planId: "plan-1",
    });
    command.findFirst.mockResolvedValue({ parsedIntent: { card: planCard } });
    advanceForScheduling.mockRejectedValue(new Error("archived"));

    expect(await recordPostVerdict(input)).toEqual({
      ok: true,
      ideaLearned: false,
    });
    expect(rememberPostResult).toHaveBeenCalled();
    expect(ideaTx.update).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalled();
  });

  it("records a post with no idea without touching ideas", async () => {
    creative.findFirst.mockResolvedValue({ status: "PUBLISHED", planId: null });
    auditLog.findFirst.mockResolvedValue(null);
    expect(await recordPostVerdict({ ...input, creativeId: "c9" })).toEqual({
      ok: true,
      ideaLearned: false,
    });
    expect(advanceForScheduling).not.toHaveBeenCalled();
  });
});
