import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves about slot-first generation when the plan allowance
// cannot pay for the piece: driveJobInline hands back the job as WAITING_BUDGET
// and the day is already planned. The model must be told the piece is PAUSED
// (image_paused / task_paused, with the pause wording and the planned day), never
// that it is ready, still rendering or still being written
// (docs/billing-tasks.md, "Park (WAITING_BUDGET) ve devam"). DB-less like
// slot-first.test.ts: the transaction runs against an in-memory Command store so
// the REAL schedule-slots and save core write the rows the stored card is read
// from.

type Json = Record<string, unknown>;

const store = {
  commands: new Map<string, { projectId: string; parsedIntent: Json | null }>(),
};

const tx = vi.hoisted(() => ({
  command: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  creative: { create: vi.fn() },
  // One Post per post of the plan (save-plan-core createPostsInTx).
  post: { create: vi.fn() },
}));
const transaction = vi.hoisted(() =>
  vi.fn<(fn: (t: typeof tx) => unknown, opts?: unknown) => unknown>(),
);
const commandFindUnique = vi.hoisted(() => vi.fn());
const executionJobFindUnique = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (fn: (t: typeof tx) => unknown, opts: unknown) =>
      transaction(fn, opts),
    command: { findUnique: commandFindUnique },
    executionJob: { findUnique: executionJobFindUnique },
  },
}));

const planForCapability = vi.hoisted(() => vi.fn());
vi.mock("@/server/commands/task-planner", () => ({
  TaskPlanner: { planForCapability },
}));

const driveJobInline = vi.hoisted(() => vi.fn());
vi.mock("./inline-job", () => ({ driveJobInline }));

const ensureProjectActive = vi.hoisted(() => vi.fn());
vi.mock("@/server/projects/activation", () => ({ ensureProjectActive }));

const loadSuggestedSlots = vi.hoisted(() => vi.fn());
vi.mock("@/server/works/free-slot-loader", () => ({ loadSuggestedSlots }));

vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: vi.fn().mockResolvedValue({}) },
}));

const subscribeCreativeProgress = vi.hoisted(() => vi.fn());
vi.mock("@/server/media/creative-progress", () => ({
  subscribeCreativeProgress,
}));

vi.mock("@/server/media/creative-layout", () => ({
  readLayoutMeta: () => null,
}));

const { slotWhenLabel } = await import("@/lib/works/slot-rules");
const { slotFirstImage, slotFirstText } = await import("./slot-first");
const { PAUSED_NOTE } = await import("./parked-job");

type Ctx = Parameters<typeof slotFirstImage>[1];

const work = (channels: string[]) =>
  ({
    id: "work-1",
    title: "Autumn",
    summary: null,
    status: "ACTIVE",
    channels,
    acknowledgedUnconnected: [],
    lastActivityAt: new Date().toISOString(),
  }) as never;

const makeCtx = (channels: string[]): Ctx => ({
  workspaceId: "ws-1",
  projectId: "proj-1",
  brandId: "brand-1",
  userId: "user-1",
  commandId: "turn-1",
  message: "Make a piece",
  phase: "ACTIVE",
  emit: vi.fn(),
  work: work(channels),
});

const imageArgs: Parameters<typeof slotFirstImage>[0] = {
  imagePrompt: "A warm cafe table with autumn leaves",
  headline: "Autumn menu",
  caption: "Our autumn menu is here. Come and taste it.",
  copy: "Seasonal dishes made with local produce.",
  platform: "INSTAGRAM",
  contentFormat: "FEED_PORTRAIT",
  quality: "draft",
};

const textArgs: Parameters<typeof slotFirstText>[0] = {
  capability: "CREATE_COPY",
  taskBrief: "A LinkedIn post about our new autumn menu for local suppliers",
  platform: "LINKEDIN",
};

const DAY_MS = 24 * 60 * 60 * 1000;

// Two days ahead of the clock, whatever day that is: far enough for the
// 60-minute lead rule to hold in any timezone, near enough for the 60-day horizon.
const slotDate = () =>
  new Date(Date.now() + 2 * DAY_MS).toISOString().slice(0, 10);

const PARKED = { status: "WAITING_BUDGET", errorMessage: null };

let creativeSeq = 0;
// The day the loader suggests in the current test: read once per test so the
// expectations cannot straddle midnight.
let suggestedDate = "";
const unsubscribe = vi.fn();

function storedCard(): Json {
  return (store.commands.get("turn-1")!.parsedIntent as { card: Json }).card;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.commands.clear();
  creativeSeq = 0;
  store.commands.set("turn-1", { projectId: "proj-1", parsedIntent: null });

  transaction.mockImplementation(async (fn) => fn(tx));
  tx.post.create.mockResolvedValue({ id: "post-1" });
  tx.command.findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) =>
      store.commands.get(where.id) ?? null,
  );
  tx.command.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Json }) => {
      const row = store.commands.get(where.id);
      if (row) row.parsedIntent = data.parsedIntent as Json;
    },
  );
  tx.creative.create.mockImplementation(async () => ({
    id: `cr-${++creativeSeq}`,
  }));
  commandFindUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) =>
      store.commands.get(where.id) ?? null,
  );

  ensureProjectActive.mockResolvedValue({ status: "ACTIVE", usable: true });
  suggestedDate = slotDate();
  loadSuggestedSlots.mockResolvedValue({
    timezone: "Europe/Istanbul",
    slots: [{ date: suggestedDate, time: "11:00" }],
  });
  planForCapability.mockResolvedValue({
    task: { id: "task-1", riskLevel: "LOW" },
    dispatched: true,
    job: { id: "job-1" },
  });
  driveJobInline.mockResolvedValue(PARKED);
  subscribeCreativeProgress.mockReturnValue(unsubscribe);
});

describe("slotFirstImage with a job the plan cannot pay for", () => {
  it("says the picture is paused and the day stays planned", async () => {
    const ctx = makeCtx(["instagram"]);

    const outcome = await slotFirstImage(imageArgs, ctx);

    expect(driveJobInline).toHaveBeenCalledWith("job-1", "LOW");
    expect(outcome.status).toBe("ANSWERED");
    expect(outcome.result).toMatchObject({
      outcome: "image_paused",
      taskId: "task-1",
      slot: {
        when: slotWhenLabel(suggestedDate, "11:00"),
        channel: "Instagram",
        format: "Post",
      },
    });
    const note = (outcome.result as { note: string }).note;
    expect(note).toContain(PAUSED_NOTE);
    expect(note).toContain("The day stays planned");
    // ...and the model is still told to say WHEN it is planned.
    expect(note).toContain("Say in ONE sentence when it is planned");
    expect(outcome.nothingDone).toBeUndefined();

    // The slot really exists: one Creative, on the turn's saved card.
    expect(tx.creative.create).toHaveBeenCalledTimes(1);
    expect(planForCapability).toHaveBeenCalledTimes(1);
    expect(ctx.slotsCreated).toBe(1);
    expect(ctx.planOwner).toBe("slots");
    expect(outcome.card).toEqual(storedCard());
    expect(outcome.cardPersisted).toBe(true);
    expect(outcome.card).toMatchObject({
      kind: "content-plan-draft",
      state: "saved",
      savedCreativeIds: ["cr-1"],
    });
  });

  it("never says the image is ready, still rendering, failed or waiting for approval", async () => {
    const outcome = await slotFirstImage(imageArgs, makeCtx(["instagram"]));

    const result = outcome.result as { outcome: string; note: string };
    for (const claimed of [
      "image_ready",
      "image_still_rendering",
      "image_failed",
      "image_waiting_for_approval",
    ]) {
      expect(result.outcome).not.toBe(claimed);
    }
    // The notes of those outcomes, which the paused note must not borrow.
    expect(result.note).not.toContain("already visible to the client");
    expect(result.note).not.toContain("will appear in its slot");
    expect(result.note).not.toContain("could not be generated");
    expect(result).not.toHaveProperty("layout");
    expect(outcome.status).not.toBe("ERROR");
    // No finished image to read a layout from.
    expect(executionJobFindUnique).not.toHaveBeenCalled();
  });

  it("still lets go of the live preview subscription", async () => {
    await slotFirstImage(imageArgs, makeCtx(["instagram"]));

    expect(subscribeCreativeProgress).toHaveBeenCalledWith(
      "job-1",
      expect.any(Function),
    );
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("slotFirstText with a job the plan cannot pay for", () => {
  it("says the text is paused and the day stays planned", async () => {
    const ctx = makeCtx(["linkedin"]);

    const outcome = await slotFirstText(textArgs, ctx);

    expect(driveJobInline).toHaveBeenCalledWith("job-1", "LOW");
    expect(outcome.status).toBe("ANSWERED");
    expect(outcome.result).toMatchObject({
      outcome: "task_paused",
      taskId: "task-1",
      slot: {
        when: slotWhenLabel(suggestedDate, "11:00"),
        channel: "LinkedIn",
        format: "Post",
      },
    });
    const note = (outcome.result as { note: string }).note;
    expect(note).toContain(PAUSED_NOTE);
    expect(note).toContain("The day stays planned");
    expect(note).toContain("Say in ONE sentence when it is planned");
    expect(outcome.nothingDone).toBeUndefined();

    expect(tx.creative.create).toHaveBeenCalledTimes(1);
    expect(planForCapability).toHaveBeenCalledTimes(1);
    expect(ctx.slotsCreated).toBe(1);
    expect(outcome.card).toEqual(storedCard());
    expect(outcome.cardPersisted).toBe(true);
    expect(outcome.card).toMatchObject({
      kind: "content-plan-draft",
      state: "saved",
      savedCreativeIds: ["cr-1"],
    });
  });

  it("never says the text is written, being written or failed, and reads no result", async () => {
    const outcome = await slotFirstText(textArgs, makeCtx(["linkedin"]));

    const result = outcome.result as { outcome: string; note: string };
    for (const claimed of [
      "task_completed",
      "task_still_running",
      "task_failed",
      "task_waiting_for_approval",
    ]) {
      expect(result.outcome).not.toBe(claimed);
    }
    expect(result.note).not.toContain("already in its slot");
    expect(result.note).not.toContain("still being written");
    expect(result.note).not.toContain("could not be produced");
    expect(result).not.toHaveProperty("result");
    expect(result).not.toHaveProperty("truncated");
    expect(outcome.status).not.toBe("ERROR");
    expect(executionJobFindUnique).not.toHaveBeenCalled();
  });
});
