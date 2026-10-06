import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: "Make this post" puts the idea on the calendar as
// one post on every channel it names, through the same write as "Add to
// calendar" (createSlots), in a Social chat of its own, so the chat opens on
// a planned post it can make; the texts replayed to the model carry no idea
// text; a second press opens the chat that already holds the post; a brand
// rule, a gone idea and an older idea are refused before any write.

const idea = { findFirst: vi.fn() };
const command = { findFirst: vi.fn() };
const auditLog = { create: vi.fn() };
vi.mock("@/lib/prisma", () => ({
  prisma: { idea, command, auditLog },
}));
vi.mock("@/server/chat/content-plan", () => ({
  getProjectTimezone: vi.fn(async () => "Europe/Istanbul"),
}));
const markIdeasPlanned = vi.fn();
vi.mock("@/server/chat/idea-pool", () => ({ markIdeasPlanned }));
const createSlots = vi.fn();
vi.mock("@/server/chat/schedule-slots", () => ({ createSlots }));
vi.mock("@/server/integrations/channel-connections", () => ({
  getChannelConnections: vi.fn(async () => ({
    instagram: { connected: true },
    facebook: { connected: true },
  })),
}));
vi.mock("@/server/works/free-slot-loader", () => ({
  loadSuggestedSlots: vi.fn(async () => ({
    timezone: "Europe/Istanbul",
    slots: [{ date: "2026-10-08", time: "09:00" }],
  })),
}));
const loadBrandRules = vi.fn();
vi.mock("@/server/works/brand-rule-loader", () => ({ loadBrandRules }));
vi.mock("@/server/brand/rule-language", () => ({
  brandRuleLanguageOf: vi.fn(async () => "en"),
}));
vi.mock("@/server/works/flag", () => ({
  isModulesEnabled: vi.fn(() => true),
  isWorksEnabled: vi.fn(() => true),
}));

const { makeIdeaPost, IDEA_MADE_POST_ACTION } = await import("./idea-post");

const CONCEPT = {
  v: 2,
  module: "social",
  source: "season",
  draft: {
    hook: "Five new cups for colder mornings",
    headline: "The autumn menu is here",
    visual: "A latte on a wooden bar",
    caption: "Come try them Thursday.",
    channels: ["instagram", "facebook"],
    formatKey: "instagram.post",
    layoutId: "headline-top",
    pillar: "Product",
  },
};

const INPUT = {
  projectId: "p1",
  ideaId: "idea-1",
  userId: "u1",
  workspaceId: "w1",
  now: new Date("2026-10-06T10:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  idea.findFirst.mockResolvedValue({
    id: "idea-1",
    status: "VALIDATED",
    concept: CONCEPT,
    brandId: "b1",
  });
  loadBrandRules.mockResolvedValue(null);
  auditLog.create.mockResolvedValue({});
  createSlots.mockResolvedValue({
    ok: true,
    commandId: "cmd-1",
    created: [],
    existing: [],
    alreadyScheduled: false,
  });
});

describe("makeIdeaPost", () => {
  it("puts the idea on the calendar as one post, in a Social chat of its own", async () => {
    const result = await makeIdeaPost(INPUT);
    expect(result).toMatchObject({ ok: true, reused: false });

    const write = createSlots.mock.calls[0]![0];
    expect(result).toMatchObject({ workId: write.workId });
    expect(write).toMatchObject({
      scope: {
        workspaceId: "w1",
        projectId: "p1",
        brandId: "b1",
        userId: "u1",
      },
      via: "idea",
      timezone: "Europe/Istanbul",
      newWork: {
        title: "Five new cups for colder mornings",
        module: "social",
        channels: ["instagram", "facebook"],
        createdByUserId: "u1",
      },
    });
    // One post: the same day, time and idea on each channel.
    const shared = {
      date: "2026-10-08",
      time: "09:00",
      topic: "Five new cups for colder mornings",
      captionIdea:
        '"The autumn menu is here" | A latte on a wooden bar | Come try them Thursday.',
      origin: { kind: "idea", ref: "idea-1" },
      ideaId: "idea-1",
    };
    expect(write.targets).toEqual([
      { ...shared, channel: "instagram", formatKey: "instagram.post" },
      { ...shared, channel: "facebook", formatKey: "facebook.post" },
    ]);
    // Replayed to the model: channels, formats and the time, no idea text.
    expect(write.rawText).toBe("Make this post on Instagram and Facebook");
    expect(write.replyText).toContain("Thu 8 Oct, 09:00");
    expect(write.replyText).toContain("Instagram Post and Facebook Post");
    for (const text of [write.rawText, write.replyText]) {
      expect(text).not.toMatch(/cups|autumn|latte/i);
    }

    expect(markIdeasPlanned).toHaveBeenCalledWith("p1", ["idea-1"]);
    expect(auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: IDEA_MADE_POST_ACTION,
        entityType: "Idea",
        entityId: "idea-1",
        metadata: { workId: write.workId, commandId: "cmd-1" },
      }),
    });
  });

  it("opens the chat that already holds the post on a second press", async () => {
    createSlots.mockResolvedValueOnce({
      ok: true,
      commandId: "cmd-old",
      created: [],
      existing: [],
      alreadyScheduled: true,
    });
    command.findFirst.mockResolvedValueOnce({ workId: "work-old" });

    expect(await makeIdeaPost(INPUT)).toEqual({
      ok: true,
      workId: "work-old",
      reused: true,
    });
    expect(command.findFirst).toHaveBeenCalledWith({
      where: { id: "cmd-old", projectId: "p1" },
      select: { workId: true },
    });
    expect(auditLog.create).not.toHaveBeenCalled();
    // An earlier failed move to "Planned" heals.
    expect(markIdeasPlanned).toHaveBeenCalledWith("p1", ["idea-1"]);
  });

  it("refuses a gone idea, an older idea and a brand rule before any write", async () => {
    idea.findFirst.mockResolvedValueOnce({
      id: "idea-1",
      status: "ARCHIVED",
      concept: CONCEPT,
      brandId: "b1",
    });
    expect(await makeIdeaPost(INPUT)).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });

    idea.findFirst.mockResolvedValueOnce({
      id: "idea-1",
      status: "VALIDATED",
      concept: { bigIdea: "x" },
      brandId: "b1",
    });
    expect(await makeIdeaPost(INPUT)).toMatchObject({
      ok: false,
      code: "INVALID",
    });

    loadBrandRules.mockResolvedValueOnce({
      language: "en",
      never: [{ text: "latte", origin: "client-rule" }],
      approvedClaims: [],
      competitors: [],
    });
    expect(await makeIdeaPost(INPUT)).toMatchObject({
      ok: false,
      code: "BRAND_RULES",
    });

    expect(createSlots).not.toHaveBeenCalled();
    expect(markIdeasPlanned).not.toHaveBeenCalled();
  });
});
