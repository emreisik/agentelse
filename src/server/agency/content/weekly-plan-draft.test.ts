import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: the weekly draft runs only on Sunday evening in the
// project's own timezone (and costs no query the rest of the week), only for a
// project that has not switched it off, whose next week has nothing planned and
// whose pool has ideas; one model call writes a post per fixed slot, the server
// keeps only pool ideas, cleans the words and checks the brand rules, and the
// Work and its SYSTEM plan card are written together under the week's id; a
// second worker or a second tick never drafts the same week twice; a failed
// model call is retried after an hour, not on every tick.

const project = { findMany: vi.fn() };
const projectSchedule = { findMany: vi.fn() };
const autonomyPolicy = { findMany: vi.fn() };
const work = { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() };
const creative = { count: vi.fn() };
const command = { findMany: vi.fn() };
const reasoningCall = { findFirst: vi.fn() };
const brand = { findFirst: vi.fn() };
const auditLog = { findFirst: vi.fn() };
const tx = {
  work: { create: vi.fn() },
  command: { create: vi.fn() },
  auditLog: { create: vi.fn() },
};
const $transaction = vi.fn(async (fn: (client: typeof tx) => unknown) =>
  fn(tx),
);
vi.mock("@/lib/prisma", () => ({
  prisma: {
    project,
    projectSchedule,
    autonomyPolicy,
    work,
    creative,
    command,
    reasoningCall,
    brand,
    auditLog,
    $transaction,
  },
}));
vi.mock("@/server/chat/card-store", () => ({ updateCommandCard: vi.fn() }));

const isWorksEnabled = vi.fn();
vi.mock("@/server/works/flag", () => ({ isWorksEnabled }));
vi.mock("@/server/integrations/channel-connections", () => ({
  getChannelConnections: vi.fn(async () => ({
    instagram: { connected: true },
  })),
}));
const loadIdeaPoolForPrompt = vi.fn();
const poolIdeaIds = vi.fn();
vi.mock("@/server/chat/idea-pool", () => ({
  loadIdeaPoolForPrompt,
  poolIdeaIds,
}));
vi.mock("@/server/agency/constitution/constitution-service", () => ({
  ConstitutionService: {
    getBrandContext: vi.fn(async () => ({ name: "Web Health" })),
  },
}));
vi.mock("@/server/memory/memory-service", () => ({
  MemoryService: {
    postLessons: vi.fn(async () => ({ worked: ["A worked"], didNotWork: [] })),
  },
}));
const run = vi.fn();
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { run },
}));
const isProjectAgencyActive = vi.fn();
vi.mock("@/server/repositories/agency-loop-state.repository", () => ({
  isProjectAgencyActive,
}));
const loadBrandRules = vi.fn();
vi.mock("@/server/works/brand-rule-loader", () => ({ loadBrandRules }));
vi.mock("@/server/brand/rule-language", () => ({
  brandRuleLanguageOf: vi.fn(async () => "tr"),
}));

// SC-F7: aylık SEO planı kapısı ve haftalık not
const seoContentPlanActiveFor = vi.fn();
vi.mock("@/lib/seo/content-plan/flags", () => ({ seoContentPlanActiveFor }));
const weeklySeoNote = vi.fn();
vi.mock("@/server/seo/content-plan/weekly", () => ({ weeklySeoNote }));

const {
  WeeklyPlanDraft,
  draftItems,
  sundayEveningSomewhere,
  clearWeeklyDraftMemo,
} = await import("./weekly-plan-draft");

// Sunday 4 Oct 2026, 16:00 UTC = 19:00 in Istanbul.
const SUNDAY_EVENING = new Date("2026-10-04T16:00:00Z");
const PROJECT = "cmgproject000000000000001";
const WORK_ID = `wkplan_${PROJECT}_2026-10-05`;

beforeEach(() => {
  vi.clearAllMocks();
  clearWeeklyDraftMemo();
  console.error = vi.fn();
  isWorksEnabled.mockReturnValue(true);
  project.findMany.mockResolvedValue([{ id: PROJECT, workspaceId: "w1" }]);
  projectSchedule.findMany.mockResolvedValue([]);
  autonomyPolicy.findMany.mockResolvedValue([
    { projectId: PROJECT, autopilotMode: "AUTOPILOT" },
  ]);
  isProjectAgencyActive.mockResolvedValue(true);
  seoContentPlanActiveFor.mockReturnValue(false);
  weeklySeoNote.mockResolvedValue("");
  work.findUnique.mockResolvedValue(null);
  work.findMany.mockResolvedValue([]);
  creative.count.mockResolvedValue(0);
  command.findMany.mockResolvedValue([]);
  reasoningCall.findFirst.mockResolvedValue(null);
  brand.findFirst.mockResolvedValue({ id: "b1" });
  auditLog.findFirst.mockResolvedValue(null);
  loadIdeaPoolForPrompt.mockResolvedValue([
    { id: "idea-1", title: "Clinic tour", summary: "Show the clinic" },
  ]);
  poolIdeaIds.mockResolvedValue(new Set(["idea-1"]));
  loadBrandRules.mockResolvedValue(null);
  run.mockResolvedValue({
    output: {
      posts: [
        {
          slot: 1,
          ideaId: "idea-1",
          topic: "Inside the clinic",
          captionIdea: "Meet the team.",
          purpose: "Build trust",
        },
        {
          slot: 2,
          ideaId: "made-up",
          topic: "Patient story",
          captionIdea: "A real story.",
        },
        { slot: 3, topic: "Q&A day", captionIdea: "Ask us anything." },
      ],
    },
    isMock: false,
  });
});

describe("sundayEveningSomewhere", () => {
  it("is true only while some timezone can be at Sunday 18:00-24:00", () => {
    expect(sundayEveningSomewhere(new Date("2026-10-04T03:59:00Z"))).toBe(
      false,
    );
    expect(sundayEveningSomewhere(new Date("2026-10-04T04:00:00Z"))).toBe(true);
    expect(sundayEveningSomewhere(new Date("2026-10-05T11:59:00Z"))).toBe(true);
    expect(sundayEveningSomewhere(new Date("2026-10-05T12:00:00Z"))).toBe(
      false,
    );
    expect(sundayEveningSomewhere(new Date("2026-10-07T12:00:00Z"))).toBe(
      false,
    );
  });
});

describe("draftItems", () => {
  const slots = [
    {
      date: "2026-10-05",
      time: "10:00",
      channel: "instagram" as const,
      formatKey: "instagram.post",
    },
    {
      date: "2026-10-07",
      time: "10:00",
      channel: "instagram" as const,
      formatKey: "instagram.post",
    },
  ];

  it("puts each post on its slot and drops unknown, repeated or unclean ones", () => {
    const items = draftItems(
      {
        posts: [
          { slot: 2, topic: "Second", captionIdea: "Two." },
          {
            slot: 1,
            topic: "First",
            captionIdea: "One.",
            ideaId: " idea-1 ",
            purpose: "Open",
          },
          { slot: 1, topic: "Again", captionIdea: "Dup." },
          { slot: 9, topic: "Nowhere", captionIdea: "No slot." },
          { slot: 2, topic: "", captionIdea: "Empty topic." },
        ],
      },
      slots,
    );
    expect(items).toEqual([
      {
        date: "2026-10-05",
        time: "10:00",
        channel: "instagram",
        formatKey: "instagram.post",
        topic: "First",
        captionIdea: "One.",
        purpose: "Open",
        ideaId: "idea-1",
      },
      {
        date: "2026-10-07",
        time: "10:00",
        channel: "instagram",
        formatKey: "instagram.post",
        topic: "Second",
        captionIdea: "Two.",
      },
    ]);
  });
});

describe("WeeklyPlanDraft.runDue", () => {
  it("drafts next week into a Work of its own with a SYSTEM plan card", async () => {
    expect(await WeeklyPlanDraft.runDue(2, SUNDAY_EVENING)).toBe(1);

    // One model call, with the fixed slots, the pool and the lessons.
    expect(run).toHaveBeenCalledTimes(1);
    const context = run.mock.calls[0]![1].context;
    expect(context.slots).toEqual([
      "1. Mon 5 Oct 10:00 · instagram.post",
      "2. Wed 7 Oct 10:00 · instagram.post",
      "3. Fri 9 Oct 10:00 · instagram.post",
    ]);
    expect(context.ideaPool).toEqual([
      { id: "idea-1", title: "Clinic tour", summary: "Show the clinic" },
    ]);
    expect(context.postResults).toEqual({
      worked: ["A worked"],
      didNotWork: [],
    });

    expect(tx.work.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: WORK_ID,
        projectId: PROJECT,
        title: "Weekly plan · 5–11 Oct",
        channels: [],
      }),
    });
    const row = tx.command.create.mock.calls[0]![0].data;
    expect(row).toMatchObject({
      id: `wkplancmd_${PROJECT}_2026-10-05`,
      workId: WORK_ID,
      source: "SYSTEM",
      rawText: "",
      replyStatus: "ANSWERED",
    });
    expect(row.replyText).toContain("3 posts");
    const card = row.parsedIntent.card;
    expect(card).toMatchObject({
      kind: "content-plan-draft",
      title: "Weekly plan",
      state: "draft",
      brandCheck: { state: "skipped" },
    });
    expect(card.items).toHaveLength(3);
    // The pool idea is kept and labelled; the made-up id is dropped.
    expect(card.items[0]).toMatchObject({
      ideaId: "idea-1",
      from: "Idea pool",
    });
    expect(card.items[1]).not.toHaveProperty("ideaId");
    expect(card.items[2]).not.toHaveProperty("ideaId");
    // The durable "drafted" marker is written with them.
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "weekly_plan.drafted",
        entityType: "Project",
        entityId: `${PROJECT}:2026-10-05`,
      }),
    });
  });

  // SC-F7: aylık SEO slotu sosyal taslağı engellemez; kapalıyken sorgu eskisi gibidir.
  it("keeps the old planned-count where-clause for a project outside the SEO content plan", async () => {
    await WeeklyPlanDraft.runDue(2, SUNDAY_EVENING);
    const where = creative.count.mock.calls[0]![0].where;
    expect(where).not.toHaveProperty("OR");
    expect(seoContentPlanActiveFor).toHaveBeenCalledWith(PROJECT);
    expect(weeklySeoNote).toHaveBeenCalledTimes(1);
  });

  it("does not count seo-channel pieces as a planned week when the SEO plan is active", async () => {
    seoContentPlanActiveFor.mockReturnValue(true);
    expect(await WeeklyPlanDraft.runDue(2, SUNDAY_EVENING)).toBe(1);
    const where = creative.count.mock.calls[0]![0].where;
    expect(where.OR).toEqual([{ channel: null }, { channel: { not: "seo" } }]);
    // The where-clause alone decides: a seo-only week counts 0 and is drafted.
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("adds the SEO note to the draft's reply", async () => {
    seoContentPlanActiveFor.mockReturnValue(true);
    weeklySeoNote.mockResolvedValue(
      "One SEO article from this month's plan is also due this week.",
    );
    await WeeklyPlanDraft.runDue(2, SUNDAY_EVENING);
    const row = tx.command.create.mock.calls[0]![0].data;
    expect(row.replyText).toContain("3 posts");
    expect(row.replyText).toContain(
      "One SEO article from this month's plan is also due this week.",
    );
    const [, from, to] = weeklySeoNote.mock.calls[0]!;
    expect(from).toBeInstanceOf(Date);
    expect(to.getTime() - from.getTime()).toBe(7 * 86_400_000);
  });

  it("never drafts a week again after its chat was deleted, even in a fresh process", async () => {
    auditLog.findFirst.mockResolvedValue({ id: "marker" });
    expect(await WeeklyPlanDraft.runDue(2, SUNDAY_EVENING)).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("reads a timezone the runtime does not know as the default, without stopping other projects", async () => {
    project.findMany.mockResolvedValue([
      { id: "bad", workspaceId: "w1" },
      { id: PROJECT, workspaceId: "w1" },
    ]);
    projectSchedule.findMany.mockResolvedValue([
      { projectId: "bad", timezone: "UTC+3" },
    ]);
    autonomyPolicy.findMany.mockResolvedValue([]);
    expect(await WeeklyPlanDraft.runDue(2, SUNDAY_EVENING)).toBe(2);
  });

  it("notices the switch turned on the same evening", async () => {
    autonomyPolicy.findMany.mockResolvedValueOnce([
      { projectId: PROJECT, autopilotMode: "REVIEW_EVERYTHING" },
    ]);
    expect(await WeeklyPlanDraft.runDue(2, SUNDAY_EVENING)).toBe(0);
    // The owner switches it on: the next tick drafts.
    expect(await WeeklyPlanDraft.runDue(2, SUNDAY_EVENING)).toBe(1);
  });

  it("costs no query outside the Sunday-evening window, and none without Works", async () => {
    expect(
      await WeeklyPlanDraft.runDue(2, new Date("2026-10-07T12:00:00Z")),
    ).toBe(0);
    isWorksEnabled.mockReturnValue(false);
    expect(await WeeklyPlanDraft.runDue(2, SUNDAY_EVENING)).toBe(0);
    expect(project.findMany).not.toHaveBeenCalled();
  });

  it("uses the project's own timezone", async () => {
    // 19:00 in Istanbul is 09:00 in Los Angeles: not yet.
    projectSchedule.findMany.mockResolvedValue([
      { projectId: PROJECT, timezone: "America/Los_Angeles" },
    ]);
    expect(await WeeklyPlanDraft.runDue(2, SUNDAY_EVENING)).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("skips a project that switched it off, and does not ask again that week", async () => {
    autonomyPolicy.findMany.mockResolvedValue([
      { projectId: PROJECT, autopilotMode: "REVIEW_EVERYTHING" },
    ]);
    expect(await WeeklyPlanDraft.runDue(2, SUNDAY_EVENING)).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(work.findUnique).not.toHaveBeenCalled();
  });

  it("skips a week that is already drafted, planned, covered by an open draft, or has no ideas", async () => {
    work.findUnique.mockResolvedValueOnce({ id: WORK_ID });
    expect(await WeeklyPlanDraft.runDue(2, SUNDAY_EVENING)).toBe(0);

    clearWeeklyDraftMemo();
    creative.count.mockResolvedValueOnce(2);
    expect(await WeeklyPlanDraft.runDue(2, SUNDAY_EVENING)).toBe(0);

    clearWeeklyDraftMemo();
    command.findMany.mockResolvedValueOnce([
      {
        parsedIntent: {
          card: {
            kind: "content-plan-draft",
            state: "draft",
            items: [{ date: "2026-10-08" }],
          },
        },
      },
    ]);
    expect(await WeeklyPlanDraft.runDue(2, SUNDAY_EVENING)).toBe(0);

    clearWeeklyDraftMemo();
    loadIdeaPoolForPrompt.mockResolvedValueOnce([]);
    expect(await WeeklyPlanDraft.runDue(2, SUNDAY_EVENING)).toBe(0);

    expect(run).not.toHaveBeenCalled();
  });

  it("decides a week once per process: the next tick of the same evening asks nothing", async () => {
    expect(await WeeklyPlanDraft.runDue(2, SUNDAY_EVENING)).toBe(1);
    work.findUnique.mockClear();
    expect(await WeeklyPlanDraft.runDue(2, SUNDAY_EVENING)).toBe(0);
    expect(work.findUnique).not.toHaveBeenCalled();
  });

  it("treats a concurrent write of the same week as already drafted", async () => {
    $transaction.mockRejectedValueOnce(
      Object.assign(new Error("dup"), { code: "P2002" }),
    );
    expect(await WeeklyPlanDraft.runDue(2, SUNDAY_EVENING)).toBe(0);
  });

  it("waits an hour after a failed model call, and tries again later", async () => {
    const failedAt = new Date(SUNDAY_EVENING.getTime() - 10 * 60_000);
    reasoningCall.findFirst.mockResolvedValue({ createdAt: failedAt, status: "ERROR" });
    expect(await WeeklyPlanDraft.runDue(2, SUNDAY_EVENING)).toBe(0);
    expect(run).not.toHaveBeenCalled();

    // Not settled for the week: once the hour has passed it drafts.
    const later = new Date(failedAt.getTime() + 61 * 60_000);
    expect(await WeeklyPlanDraft.runDue(2, later)).toBe(1);
  });
});
