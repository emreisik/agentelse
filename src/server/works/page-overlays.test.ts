import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const taskCount = vi.fn();
const creativeFindMany = vi.fn();
const scheduleCount = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { count: (...a: unknown[]) => taskCount(...a) },
    creative: { findMany: (...a: unknown[]) => creativeFindMany(...a) },
    projectSchedule: { count: (...a: unknown[]) => scheduleCount(...a) },
  },
}));
const getConnections = vi.fn();
vi.mock("@/server/integrations/channel-connections", () => ({
  getChannelConnections: (...a: unknown[]) => getConnections(...a),
}));
vi.mock("@/server/chat/content-plan", () => ({
  getProjectTimezone: async () => "Europe/Istanbul",
}));

import type { CreativeCardData } from "@/types/creative-card";
import type { IdeaEventCardData } from "@/types/idea-event-card";
import type {
  LiveCreativeRow,
  LiveInputs,
} from "@/server/agency/journey/live-creative-state";
import {
  applyWorkOverlays,
  collectScheduledIdeas,
  loadPostChannels,
  loadWorkActivity,
  loadWorkOverlayInputs,
  type WorkOverlayInputs,
} from "./page-overlays";

const NOW = new Date("2026-10-01T10:00:00Z");

const live: LiveInputs = {
  projectId: "p1",
  now: NOW,
  timezone: "Europe/Istanbul",
  connections: { instagram: { connected: true } } as LiveInputs["connections"],
  connectedPlatforms: new Set(["instagram"]),
  scheduleEnabled: true,
};

const row = (
  id: string,
  over: Partial<LiveCreativeRow> = {},
): LiveCreativeRow => ({
  id,
  status: "IN_REVIEW",
  platform: "INSTAGRAM",
  channel: "instagram",
  formatKey: "instagram.post",
  scheduledFor: new Date("2026-10-05T09:00:00Z"),
  planId: "plan1",
  version: { version: 2, assetId: "asset-live" },
  ...over,
});

type Plan = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;
const item = (
  ref: string | null,
  over: Partial<Plan["items"][number]> = {},
): Plan["items"][number] => ({
  date: "2026-10-04",
  time: "10:00",
  channel: "instagram",
  formatKey: "instagram.post",
  topic: "T",
  captionIdea: "C",
  ...(ref ? { origin: { kind: "idea" as const, ref } } : {}),
  ...over,
});
const plan = (
  items: Plan["items"],
  savedCreativeIds: string[],
  over: Partial<Plan> = {},
): Plan => ({
  kind: "content-plan-draft",
  title: "Plan",
  timezone: "Europe/Istanbul",
  state: "saved",
  items,
  savedCreativeIds,
  ...over,
});

const ready: Extract<CreativeCardData, { kind: "creative-ready" }> = {
  kind: "creative-ready",
  creativeId: "c1",
  title: "T",
  status: "IN_REVIEW",
  assetId: "old-asset",
  versionNumber: 1,
  approveIntent: "publish",
};

const optionsCard = (ids: string[]): IdeaEventCardData => ({
  kind: "idea-options",
  title: "Ideas",
  reason: "r",
  items: ids.map((ideaId) => ({ ideaId, title: ideaId, description: "d" })),
});

function inputsOf(
  rows: LiveCreativeRow[],
  cards: IdeaEventCardData[] = [],
): WorkOverlayInputs {
  const liveRows = new Map(rows.map((r) => [r.id, r] as const));
  return {
    live,
    liveRows,
    scheduledIdeas: collectScheduledIdeas(cards, liveRows, live.timezone),
    postChannels: new Map(),
  };
}

describe("collectScheduledIdeas", () => {
  it("counts an idea only while its slot row is live, with the live time", () => {
    const card = plan(
      [item("i1"), item("i2"), item("i3"), item("i4")],
      ["s1", "s2", "s3", "s4"],
    );
    const rows = new Map([
      ["s1", row("s1")],
      ["s2", row("s2", { status: "ARCHIVED" })],
      ["s3", row("s3", { status: "REJECTED" })],
      // s4 has no row at all
    ]);
    const out = collectScheduledIdeas([card], rows, "Europe/Istanbul");
    expect([...out.keys()]).toEqual(["i1"]);
    // 09:00Z is 12:00 in Istanbul: the Creative's time, not the stored 10:00.
    expect(out.get("i1")).toEqual({
      date: "2026-10-05",
      time: "12:00",
      channel: "instagram",
    });
  });

  it("ignores other origins, removed items, unsaved plans and plans without ids", () => {
    const rows = new Map([
      ["s1", row("s1")],
      ["s2", row("s2")],
      ["s3", row("s3")],
      ["s4", row("s4")],
    ]);
    const master = item(null, { origin: { kind: "master", ref: "m1" } });
    const out = collectScheduledIdeas(
      [
        plan([master], ["s1"]),
        plan([item("i2", { removed: true })], ["s2"]),
        plan([item("i3")], ["s3"], { state: "draft" }),
        plan([item("i4")], [], {}),
        undefined,
        optionsCard(["i9"]),
      ],
      rows,
    );
    expect(out.size).toBe(0);
  });

  it("keeps the first live item of an idea", () => {
    const card = plan(
      [item("i1", { channel: "facebook" }), item("i1")],
      ["s1", "s2"],
    );
    const rows = new Map([
      ["s1", row("s1", { scheduledFor: null })],
      ["s2", row("s2")],
    ]);
    const out = collectScheduledIdeas([card], rows);
    expect(out.get("i1")).toEqual({
      date: "2026-10-04",
      time: "10:00",
      channel: "facebook",
    });
  });
});

describe("applyWorkOverlays", () => {
  it("marks only its own ideas as scheduled, from live rows", () => {
    const saved = plan([item("i1"), item("i2")], ["s1", "s2"]);
    const inputs = inputsOf(
      [row("s1"), row("s2", { status: "ARCHIVED" })],
      [saved],
    );
    const out = applyWorkOverlays(optionsCard(["i1", "i2", "i3"]), inputs);
    expect(
      out?.kind === "idea-options" && Object.keys(out.scheduled ?? {}),
    ).toEqual(["i1"]);
    const other = applyWorkOverlays(optionsCard(["i3"]), inputs);
    expect(other).toEqual(optionsCard(["i3"]));
  });

  it("leaves a Work without plans unchanged", () => {
    const inputs = inputsOf([]);
    const options = optionsCard(["i1"]);
    expect(applyWorkOverlays(options, inputs)).toBe(options);
    expect(applyWorkOverlays(undefined, inputs)).toBeUndefined();
    const question: IdeaEventCardData = {
      kind: "question",
      questions: [],
      projectId: "p1",
    };
    expect(applyWorkOverlays(question, inputs)).toBe(question);
  });

  it("overrides the stored connections of a plan card with the live ones", () => {
    const stored = plan([item("i1")], ["s1"], {
      connections: { instagram: { connected: false } } as Plan["connections"],
    });
    const out = applyWorkOverlays(stored, inputsOf([]));
    expect(out?.kind === "content-plan-draft" && out.connections).toEqual(
      live.connections,
    );
  });

  it("delegates the newest creative card to the live row", () => {
    const out = applyWorkOverlays(
      ready,
      inputsOf([row("c1", { status: "APPROVED" })]),
      {
        isNewestCreativeCard: true,
      },
    );
    expect(out?.kind === "creative-ready" && out.status).toBe("APPROVED");
    expect(out?.kind === "creative-ready" && out.assetId).toBe("asset-live");
  });

  it("never revives an older, page-archived card of a revised piece", () => {
    const archived = { ...ready, status: "ARCHIVED", approvalId: undefined };
    const out = applyWorkOverlays(archived, inputsOf([row("c1")]), {
      isNewestCreativeCard: false,
    });
    expect(out).toBe(archived);
    expect(out?.kind === "creative-ready" && out.status).toBe("ARCHIVED");
  });
});

describe("loadWorkOverlayInputs", () => {
  beforeEach(() => {
    creativeFindMany.mockReset();
    getConnections.mockResolvedValue({});
    scheduleCount.mockResolvedValue(0);
    creativeFindMany.mockResolvedValue([]);
  });

  it("loads the rows of creative cards and of every slot of saved plans (the pane shows each piece), never a draft's", async () => {
    const saved = plan(
      [item("i1"), item(null, { origin: { kind: "master", ref: "m" } })],
      ["s1", "s2"],
    );
    const draft = plan([item("i2")], ["s3"], { state: "draft" });
    await loadWorkOverlayInputs("p1", [ready, saved, draft, undefined]);
    const ids = (
      creativeFindMany.mock.calls[0]?.[0] as {
        where: { id: { in: string[] } };
      }
    ).where.id.in;
    expect([...ids].sort()).toEqual(["c1", "s1", "s2"]);
  });

  it("asks for no rows when there is nothing to look up", async () => {
    const out = await loadWorkOverlayInputs("p1", [optionsCard(["i1"])]);
    expect(creativeFindMany).not.toHaveBeenCalled();
    expect(out.liveRows.size).toBe(0);
    expect(out.scheduledIdeas.size).toBe(0);
  });
});

describe("loadWorkActivity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    taskCount.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("is true when a recent task of the Work is in flight, and bounds the age", async () => {
    taskCount.mockResolvedValue(2);
    await expect(loadWorkActivity("p1", "w1")).resolves.toEqual({
      working: true,
    });
    const where = (
      taskCount.mock.calls[0]?.[0] as {
        where: {
          projectId: string;
          command: { workId: string };
          status: { in: string[] };
          updatedAt: { gte: Date };
        };
      }
    ).where;
    expect(where.projectId).toBe("p1");
    expect(where.command).toEqual({ workId: "w1" });
    expect(where.status.in).toEqual([
      "QUEUED",
      "RUNNING",
      "WAITING_PROVIDER",
      "VERIFYING",
    ]);
    expect(where.updatedAt.gte.getTime()).toBe(NOW.getTime() - 30 * 60_000);
  });

  it("is false with no active task and on a read error", async () => {
    taskCount.mockResolvedValue(0);
    await expect(loadWorkActivity("p1", "w1")).resolves.toEqual({
      working: false,
    });
    taskCount.mockRejectedValue(new Error("db down"));
    await expect(loadWorkActivity("p1", "w1")).resolves.toEqual({
      working: false,
    });
  });
});

// docs/works.md "Posts": a creative card knows its post and the channels the
// post goes to, so it never offers a second Facebook post.
describe("the post of a creative card", () => {
  beforeEach(() => {
    creativeFindMany.mockReset();
    getConnections.mockResolvedValue({});
    scheduleCount.mockResolvedValue(0);
  });

  it("gives the newest card its post and the channels left in it", () => {
    const inputs: WorkOverlayInputs = {
      ...inputsOf([row("c1", { postId: "post1" })]),
      postChannels: new Map([["post1", ["instagram", "facebook"]]]),
    };
    const out = applyWorkOverlays(ready, inputs, {
      isNewestCreativeCard: true,
    });
    expect(out?.kind === "creative-ready" && out.postId).toBe("post1");
    expect(out?.kind === "creative-ready" && out.postChannels).toEqual([
      "instagram",
      "facebook",
    ]);
  });

  it("adds nothing to a piece without a post", () => {
    const out = applyWorkOverlays(ready, inputsOf([row("c1")]), {
      isNewestCreativeCard: true,
    });
    expect(out?.kind === "creative-ready" && "postId" in out).toBe(false);
    expect(out?.kind === "creative-ready" && "postChannels" in out).toBe(
      false,
    );
  });

  it("lists each post's channels once, leaving out the left-out ones", async () => {
    creativeFindMany.mockResolvedValue([
      { id: "a", postId: "post1", channel: "instagram", excludedAt: null },
      { id: "b", postId: "post1", channel: "instagram", excludedAt: null },
      {
        id: "c",
        postId: "post1",
        channel: "facebook",
        excludedAt: new Date(),
      },
      { id: "d", postId: "post2", channel: "facebook", excludedAt: null },
    ]);
    const out = await loadPostChannels("p1", ["post1", "post2", "post1"]);
    expect(out.get("post1")).toEqual(["instagram"]);
    expect(out.get("post2")).toEqual(["facebook"]);
    expect(
      (creativeFindMany.mock.calls[0]?.[0] as { where: unknown }).where,
    ).toEqual({ projectId: "p1", postId: { in: ["post1", "post2"] } });
  });

  it("asks nothing without posts and never throws", async () => {
    await expect(loadPostChannels("p1", [])).resolves.toEqual(new Map());
    expect(creativeFindMany).not.toHaveBeenCalled();
    creativeFindMany.mockRejectedValue(new Error("db down"));
    await expect(loadPostChannels("p1", ["post1"])).resolves.toEqual(
      new Map(),
    );
  });

  it("reads the channels of the posts of creative cards only", async () => {
    const liveRow = (id: string, postId: string) => ({
      id,
      status: "IN_REVIEW",
      platform: "INSTAGRAM",
      channel: "instagram",
      formatKey: "instagram.post",
      scheduledFor: null,
      planId: null,
      postId,
      excludedAt: null,
      versions: [],
    });
    creativeFindMany
      .mockResolvedValueOnce([liveRow("c1", "post1"), liveRow("s1", "post2")])
      .mockResolvedValueOnce([
        { id: "c1", postId: "post1", channel: "instagram", excludedAt: null },
        { id: "f1", postId: "post1", channel: "facebook", excludedAt: null },
      ]);
    const out = await loadWorkOverlayInputs("p1", [
      ready,
      plan([item("i1")], ["s1"]),
    ]);
    expect(out.postChannels.get("post1")).toEqual(["instagram", "facebook"]);
    const where = (
      creativeFindMany.mock.calls[1]?.[0] as {
        where: { postId: { in: string[] } };
      }
    ).where;
    // A plan's slots are tabs of their post's slide: no share of their own.
    expect(where.postId.in).toEqual(["post1"]);
  });
});
