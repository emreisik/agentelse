import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves about a content-plan run: (a) the saved plan card is
// claimed once (a fresh claim blocks a second, a stale one does not) and only
// the producible slots of the nearest week are taken, never slots that have
// content, are in flight or belong to another plan, (b) each slot becomes a
// Task that carries `planCreativeId` so its result lands IN the slot, (c) the
// pieces are announced first (run.items) and stream as item.* events, at most
// three at a time, (d) one failing piece never stops the others, (e) a run
// that could not start anything releases the claim.

const tx = {
  command: {
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
  },
  creative: { findMany: vi.fn() },
  task: { findMany: vi.fn() },
};
const ensureProjectActive = vi.fn();
vi.mock("@/server/projects/activation", () => ({ ensureProjectActive }));
const commandFindUnique = vi.fn();
const commandFindFirst = vi.fn();
const commandUpdate = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/prisma", () => ({
  prisma: {
    command: {
      findUnique: commandFindUnique,
      findFirst: commandFindFirst,
      update: commandUpdate,
    },
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  },
}));

const planForCapability = vi.fn();
vi.mock("@/server/commands/task-planner", () => ({
  TaskPlanner: { planForCapability },
}));
const driveJobInline = vi.fn();
vi.mock("./inline-job", () => ({ driveJobInline }));
const auditRecord = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: auditRecord },
}));

const { claimPlanProduction, productionFor, runContentPlan, RUN_CLAIM_TTL_MS } =
  await import("./plan-run");
const { CHANNELS } = await import("@/lib/content-channels");

import type { ChatStreamEvent } from "./types";

const NOW = new Date("2026-10-01T09:00:00Z");

const slotRow = (
  id: string,
  date: string,
  over: Record<string, unknown> = {},
) => ({
  id,
  planId: "plan-1",
  status: "DRAFT",
  currentVersionId: null,
  scheduledFor: new Date(`${date}T07:00:00Z`),
  channel: "instagram",
  formatKey: "instagram.post",
  title: `Topic ${id}`,
  platform: "INSTAGRAM",
  brief: `Idea ${id}`,
  ...over,
});

const planCard = (over: Record<string, unknown> = {}) => ({
  kind: "content-plan-draft",
  title: "Plan",
  timezone: "Europe/Istanbul",
  state: "saved",
  goal: "awareness",
  items: [],
  savedCreativeIds: ["a", "b", "c"],
  ...over,
});

const stored = (card: Record<string, unknown>) => ({
  projectId: "proj-1",
  parsedIntent: { card },
});

function setup(
  creatives: ReturnType<typeof slotRow>[],
  card: Record<string, unknown> = planCard(),
  tasks: unknown[] = [],
) {
  tx.command.findUnique.mockResolvedValue(stored(card));
  tx.creative.findMany.mockResolvedValue(creatives);
  tx.task.findMany.mockResolvedValue(tasks);
}

const claimInput = {
  projectId: "proj-1",
  commandId: "plan-1",
  now: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
  tx.command.update.mockResolvedValue(undefined);
  commandUpdate.mockResolvedValue(undefined);
  auditRecord.mockResolvedValue(undefined);
  ensureProjectActive.mockResolvedValue({ usable: true });
});

describe("productionFor", () => {
  it("renders image formats through the creative department at the format size", () => {
    const format = CHANNELS.instagram.formats.find(
      (f) => f.key === "instagram.story",
    )!;
    expect(productionFor("instagram", format)).toMatchObject({
      department: "CREATIVE",
      capability: "CREATE_SOCIAL_CREATIVE",
      targetPlatform: "INSTAGRAM",
      image: true,
      contentFormat: "STORY",
      label: "Instagram story",
    });
  });

  it("a carousel is one cover image whose slides go in the caption", () => {
    const format = CHANNELS.instagram.formats.find(
      (f) => f.key === "instagram.carousel",
    )!;
    const production = productionFor("instagram", format)!;
    expect(production.image).toBe(true);
    expect(production.brief).toContain("cover image of a carousel");
  });

  it("writes copy for reels, TikTok, LinkedIn, X, articles and ads", () => {
    const cases: [keyof typeof CHANNELS, string, string][] = [
      ["instagram", "instagram.reel", "SOCIAL_MEDIA"],
      ["tiktok", "tiktok.video", "SOCIAL_MEDIA"],
      ["linkedin", "linkedin.post", "SOCIAL_MEDIA"],
      ["x", "x.post", "SOCIAL_MEDIA"],
      ["x", "x.thread", "SOCIAL_MEDIA"],
      ["seo", "seo.article", "SEO"],
      ["ads", "ads.campaign", "PERFORMANCE_MARKETING"],
    ];
    for (const [channel, key, department] of cases) {
      const format = CHANNELS[channel].formats.find((f) => f.key === key)!;
      const production = productionFor(channel, format)!;
      expect(production, key).toMatchObject({
        capability: "CREATE_COPY",
        department,
        image: false,
      });
      expect(production.brief.length).toBeGreaterThan(10);
    }
  });

  it("a TikTok brief names TikTok, not Instagram", () => {
    const format = CHANNELS.tiktok.formats[0]!;
    const production = productionFor("tiktok", format)!;
    expect(production.brief).toContain("TikTok");
    expect(production.targetPlatform).toBe("TIKTOK");
  });

  it("every catalog format has a production path", () => {
    for (const channel of Object.values(CHANNELS)) {
      for (const format of channel.formats) {
        expect(productionFor(channel.key, format), format.key).toBeDefined();
      }
    }
  });
});

describe("claimPlanProduction", () => {
  it("takes the producible slots of the nearest week and marks the card running", async () => {
    setup(
      [
        slotRow("a", "2026-10-01"),
        slotRow("b", "2026-10-03"),
        slotRow("c", "2026-10-20"),
      ],
      planCard(),
    );
    const claim = await claimPlanProduction(claimInput);
    expect(claim).toMatchObject({ ok: true, startedAt: NOW.toISOString() });
    if (!claim.ok) return;
    expect(claim.slots.map((slot) => slot.id)).toEqual(["a", "b"]);
    expect(claim.slots[0]).toMatchObject({
      title: "Topic a",
      production: { capability: "CREATE_SOCIAL_CREATIVE", image: true },
    });
    // The brief carries the idea, the goal and the planned time.
    expect(claim.slots[0]!.request).toContain("Idea a");
    expect(claim.slots[0]!.request).toContain("Goal of the plan: awareness");
    expect(claim.slots[0]!.request).toContain("Planned for: 2026-10-01 10:00");
    expect(tx.command.update).toHaveBeenCalledWith({
      where: { id: "plan-1" },
      data: {
        parsedIntent: {
          card: expect.objectContaining({
            production: {
              state: "running",
              creativeIds: ["a", "b"],
              startedAt: NOW.toISOString(),
            },
          }),
        },
      },
    });
  });

  it("only looks at this plan's slots of this project", async () => {
    setup([slotRow("a", "2026-10-01")]);
    await claimPlanProduction(claimInput);
    expect(tx.creative.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ["a", "b", "c"] },
          projectId: "proj-1",
          planId: "plan-1",
        },
      }),
    );
  });

  it("never takes slots that already have content or a job in flight", async () => {
    setup(
      [
        slotRow("a", "2026-10-01", {
          currentVersionId: "v1",
          status: "IN_REVIEW",
        }),
        slotRow("b", "2026-10-02"),
        slotRow("c", "2026-10-03", { status: "APPROVED" }),
      ],
      planCard(),
      [
        {
          status: "RUNNING",
          payload: { planCreativeId: "b" },
          updatedAt: NOW,
        },
      ],
    );
    const claim = await claimPlanProduction(claimInput);
    expect(claim).toEqual({
      ok: false,
      message: "This plan is already being produced.",
    });
    expect(tx.command.update).not.toHaveBeenCalled();
  });

  it("retries a slot whose last job failed", async () => {
    setup(
      [
        slotRow("a", "2026-10-01"),
        slotRow("b", "2026-10-02", { status: "APPROVED" }),
      ],
      planCard(),
      [{ status: "FAILED", payload: { planCreativeId: "a" }, updatedAt: NOW }],
    );
    const claim = await claimPlanProduction(claimInput);
    expect(claim.ok && claim.slots.map((slot) => slot.id)).toEqual(["a"]);
  });

  it("caps one click at seven slots", async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      slotRow(`s${i}`, "2026-10-02"),
    );
    setup(many, planCard({ savedCreativeIds: many.map((row) => row.id) }));
    const claim = await claimPlanProduction(claimInput);
    expect(claim.ok && claim.slots).toHaveLength(7);
  });

  it("skips a slot the catalog cannot produce", async () => {
    setup([
      slotRow("a", "2026-10-01", {
        channel: "facebook",
        formatKey: "facebook.post",
      }),
      slotRow("b", "2026-10-02"),
    ]);
    const claim = await claimPlanProduction(claimInput);
    expect(claim.ok && claim.slots.map((slot) => slot.id)).toEqual(["b"]);
  });

  it("refuses a plan that is not saved, is superseded or is not a plan", async () => {
    setup([slotRow("a", "2026-10-01")], planCard({ state: "draft" }));
    expect(await claimPlanProduction(claimInput)).toEqual({
      ok: false,
      message: "Save the plan first.",
    });
    setup([slotRow("a", "2026-10-01")], planCard({ state: "superseded" }));
    expect(await claimPlanProduction(claimInput)).toMatchObject({
      ok: false,
      message: expect.stringContaining("newer version"),
    });
    setup([], { kind: "content-package" });
    expect(await claimPlanProduction(claimInput)).toEqual({
      ok: false,
      message: "Plan not found.",
    });
    // Another project's plan looks like no plan at all.
    tx.command.findUnique.mockResolvedValue({
      projectId: "other",
      parsedIntent: { card: planCard() },
    });
    expect(await claimPlanProduction(claimInput)).toEqual({
      ok: false,
      message: "Plan not found.",
    });
    expect(tx.command.update).not.toHaveBeenCalled();
  });

  it("a fresh run blocks a second claim, an abandoned one does not", async () => {
    const running = (startedAt: Date) =>
      planCard({
        production: {
          state: "running",
          creativeIds: ["a"],
          startedAt: startedAt.toISOString(),
        },
      });
    setup(
      [slotRow("a", "2026-10-01")],
      running(new Date(NOW.getTime() - 60_000)),
    );
    expect(await claimPlanProduction(claimInput)).toEqual({
      ok: false,
      message: "This plan is already being produced.",
    });

    setup(
      [slotRow("a", "2026-10-01")],
      running(new Date(NOW.getTime() - RUN_CLAIM_TTL_MS - 1)),
    );
    expect(await claimPlanProduction(claimInput)).toMatchObject({ ok: true });
  });

  it("a finished run does not block the next week", async () => {
    setup(
      [slotRow("a", "2026-10-09")],
      planCard({
        production: {
          state: "done",
          creativeIds: ["x"],
          startedAt: NOW.toISOString(),
          finishedAt: NOW.toISOString(),
        },
      }),
    );
    expect(await claimPlanProduction(claimInput)).toMatchObject({ ok: true });
  });

  it("says so when there is nothing left to produce", async () => {
    setup([slotRow("a", "2026-10-01", { status: "APPROVED" })]);
    expect(await claimPlanProduction(claimInput)).toEqual({
      ok: false,
      message: "There is nothing left to produce in this plan.",
    });
  });
});

describe("runContentPlan", () => {
  const base = {
    workspaceId: "ws-1",
    projectId: "proj-1",
    brandId: "brand-1",
    userId: "user-1",
    commandId: "plan-1",
    finalCardPolls: { tries: 1, everyMs: 0 },
  };

  async function collect(): Promise<ChatStreamEvent[]> {
    const events: ChatStreamEvent[] = [];
    for await (const event of runContentPlan(base)) events.push(event);
    return events;
  }

  function planTasks() {
    let n = 0;
    planForCapability.mockImplementation(async () => {
      n += 1;
      return {
        task: { id: `task-${n}`, riskLevel: "LOW" },
        job: { id: `job-${n}` },
        dispatched: true,
      };
    });
    driveJobInline.mockResolvedValue({
      status: "COMPLETED",
      errorMessage: null,
    });
    commandFindFirst.mockResolvedValue({
      id: "row-1",
      replyText: "Ready",
      parsedIntent: {
        card: {
          kind: "creative-ready",
          taskId: "t",
          title: "T",
          creativeId: "c",
          status: "IN_REVIEW",
        },
      },
    });
  }

  it("announces the pieces, then runs each one into its own slot", async () => {
    setup(
      [
        slotRow("a", "2026-10-01"),
        slotRow("b", "2026-10-02", {
          channel: "linkedin",
          formatKey: "linkedin.post",
          platform: "LINKEDIN",
        }),
      ],
      planCard({ savedCreativeIds: ["a", "b"] }),
    );
    planTasks();
    const events = await collect();

    expect(events[0]).toEqual({
      type: "run.items",
      items: [
        {
          id: "a",
          title: "Topic a",
          label: "Instagram post",
          department: "CREATIVE",
          image: true,
        },
        {
          id: "b",
          title: "Topic b",
          label: "LinkedIn post",
          department: "SOCIAL_MEDIA",
          image: false,
        },
      ],
    });
    expect(planForCapability).toHaveBeenCalledTimes(2);
    const calls = planForCapability.mock.calls.map((c) => c[0]);
    // The slot IS the link: its id rides the task payload, the plan is the lineage.
    expect(calls[0]).toMatchObject({
      commandId: "plan-1",
      capability: "CREATE_SOCIAL_CREATIVE",
      targetPlatform: "INSTAGRAM",
      departmentKey: "CREATIVE",
      payloadExtra: {
        planCreativeId: "a",
        contentFormat: "FEED_PORTRAIT",
        quality: "medium",
      },
    });
    expect(calls[1]).toMatchObject({
      capability: "CREATE_COPY",
      targetPlatform: "LINKEDIN",
      payloadExtra: { planCreativeId: "b" },
    });
    expect(calls[1].payloadExtra).not.toHaveProperty("contentFormat");

    const done = events.filter((e) => e.type === "item.done");
    expect(done).toHaveLength(2);
    expect(events.at(-1)).toEqual({
      type: "package.done",
      started: 2,
      failed: 0,
    });
  });

  it("marks the card done with the original start time and audits the run", async () => {
    setup([slotRow("a", "2026-10-01")], planCard({ savedCreativeIds: ["a"] }));
    planTasks();
    commandFindUnique.mockResolvedValue({
      parsedIntent: { card: planCard({ production: { state: "running" } }) },
    });
    await collect();
    const written = commandUpdate.mock.calls.at(-1)![0].data.parsedIntent.card;
    expect(written.production).toMatchObject({
      state: "done",
      creativeIds: ["a"],
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
    });
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "content_plan.production_started",
        entityId: "plan-1",
        metadata: { items: 1, requested: 1, failed: 0 },
      }),
    );
  });

  it("one failing piece never stops the others", async () => {
    setup(
      [slotRow("a", "2026-10-01"), slotRow("b", "2026-10-02")],
      planCard({ savedCreativeIds: ["a", "b"] }),
    );
    planTasks();
    let call = 0;
    driveJobInline.mockImplementation(async () => {
      call += 1;
      if (call === 1) return { status: "FAILED", errorMessage: "boom" };
      return { status: "COMPLETED", errorMessage: null };
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const events = await collect();
    const done = events.filter((e) => e.type === "item.done") as Extract<
      ChatStreamEvent,
      { type: "item.done" }
    >[];
    expect(done.map((e) => e.ok).sort()).toEqual([false, true]);
    expect(events.at(-1)).toEqual({
      type: "package.done",
      started: 2,
      failed: 1,
    });
  });

  it("runs at most three pieces at a time", async () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      slotRow(`s${i}`, "2026-10-02"),
    );
    setup(many, planCard({ savedCreativeIds: many.map((row) => row.id) }));
    planTasks();
    let running = 0;
    let peak = 0;
    driveJobInline.mockImplementation(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return { status: "COMPLETED", errorMessage: null };
    });
    await collect();
    expect(planForCapability).toHaveBeenCalledTimes(7);
    expect(peak).toBe(3);
  });

  it("releases the claim when nothing could be started", async () => {
    setup([slotRow("a", "2026-10-01")], planCard({ savedCreativeIds: ["a"] }));
    planForCapability.mockRejectedValue(new Error("db down"));
    commandFindUnique.mockResolvedValue({
      parsedIntent: { card: planCard({ production: { state: "running" } }) },
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const events = await collect();
    const written = commandUpdate.mock.calls.at(-1)![0].data.parsedIntent.card;
    // undefined is dropped when the card is written as JSON: the claim is gone.
    expect(written.production).toBeUndefined();
    expect(auditRecord).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({
      type: "package.done",
      started: 0,
      failed: 1,
    });
  });

  it("refuses a paused project and a refused claim without starting anything", async () => {
    ensureProjectActive.mockResolvedValue({ usable: false });
    const paused = await collect();
    expect(paused).toEqual([
      { type: "error", code: "PROJECT_INACTIVE", message: expect.any(String) },
    ]);

    ensureProjectActive.mockResolvedValue({ usable: true });
    setup([], planCard({ state: "draft" }));
    const refused = await collect();
    expect(refused).toEqual([
      { type: "error", code: "PLAN", message: "Save the plan first." },
    ]);
    expect(planForCapability).not.toHaveBeenCalled();
  });
});
