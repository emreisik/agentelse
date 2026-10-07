import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves about a content-package run: (a) the card is claimed
// once (draft -> started) and only the ticked items run, (b) each item becomes
// a Task for its department that is driven inline, streaming tagged events
// (start, live image previews, the final card + its persisted chat row),
// (c) one failing item never stops the others, (d) a run that could not start
// anything reopens the card.

const tx = {
  command: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue(undefined) },
  work: { findFirst: vi.fn() },
};
const isWorksEnabled = vi.fn(() => false);
vi.mock("@/server/works/flag", () => ({ isWorksEnabled }));
// The run's project gate is ensureProjectActive (a project that never ran
// setup is activated on the spot; only a paused/closed one is refused).
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

// Running a job inline (claiming its dispatch event, starting it, waiting for
// it) is inline-job.test.ts's subject; here it is just "the job settles".
const driveJobInline = vi.fn();
vi.mock("./inline-job", () => ({ driveJobInline }));

const auditRecord = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: auditRecord },
}));

const { claimContentPackage, runContentPackage, packageRequestText } =
  await import("./content-package-run");
const { emitCreativeProgress } = await import("@/server/media/creative-progress");
const { AgentelseError } = await import("@/server/security/errors");

import type { ChatStreamEvent } from "./types";

const pkg = (state: string) => ({
  card: {
    kind: "content-package",
    topic: "Kommo CRM",
    state,
    items: [
      {
        id: "post",
        deliverable: "instagram_post",
        title: "Post",
        angle: "A",
        contentFormat: "FEED_PORTRAIT",
      },
      { id: "seo", deliverable: "seo_article", title: "Yazı", angle: "B" },
      { id: "reel", deliverable: "reel_idea", title: "Reel", angle: "C" },
    ],
  },
});

const base = {
  workspaceId: "ws-1",
  projectId: "proj-1",
  brandId: "brand-1",
  userId: "user-1",
  commandId: "cmd-1",
  // No real waiting in tests for a card another process is still writing.
  finalCardPolls: { tries: 2, everyMs: 0 },
};

async function collect(
  gen: AsyncGenerator<ChatStreamEvent>,
): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

const forItem = (events: ChatStreamEvent[], itemId: string) =>
  events.filter((event) => "itemId" in event && event.itemId === itemId);

beforeEach(() => {
  vi.clearAllMocks();
  ensureProjectActive.mockResolvedValue({ status: "ACTIVE", usable: true });
  tx.command.findUnique.mockResolvedValue({
    projectId: "proj-1",
    parsedIntent: pkg("draft"),
  });
  planForCapability.mockImplementation(async (input: { title: string }) => ({
    task: { id: `task-${input.title}`, riskLevel: "LOW" },
    dispatched: true,
    job: { id: `job-${input.title}` },
  }));
  driveJobInline.mockResolvedValue({ status: "COMPLETED", errorMessage: null });
  commandFindFirst.mockResolvedValue(null);
  isWorksEnabled.mockReturnValue(false);
});

describe("claimContentPackage Work gate", () => {
  const gateSetup = (work: Record<string, unknown> | null) => {
    tx.command.findUnique.mockImplementation(
      async (args: { select: Record<string, boolean> }) =>
        args.select.workId
          ? { workId: "work-1" }
          : { projectId: "proj-1", parsedIntent: pkg("draft") },
    );
    tx.work.findFirst.mockResolvedValue(work);
  };

  it("refuses a completed Work and writes nothing", async () => {
    isWorksEnabled.mockReturnValue(true);
    gateSetup({ status: "DONE", channels: [] });
    const result = await claimContentPackage({
      projectId: "proj-1",
      commandId: "cmd-1",
      selections: [{ id: "i1" }],
    });
    expect(result).toEqual({
      ok: false,
      message: "This Work is completed. Reopen it to continue.",
    });
    expect(tx.command.update).not.toHaveBeenCalled();
  });

  it("runs no Work query with the flag off", async () => {
    gateSetup({ status: "DONE", channels: [] });
    await claimContentPackage({
      projectId: "proj-1",
      commandId: "cmd-1",
      selections: [{ id: "i1" }],
    });
    expect(tx.work.findFirst).not.toHaveBeenCalled();
  });
});

describe("claimContentPackage", () => {
  it("claims only the ticked items, once each, with a valid format", async () => {
    const claim = await claimContentPackage({
      projectId: "proj-1",
      commandId: "cmd-1",
      selections: [
        { id: "post", contentFormat: "STORY" },
        { id: "post" },
        { id: "seo", contentFormat: "STORY" },
        { id: "nope" },
      ],
    });

    expect(claim).toEqual({
      ok: true,
      topic: "Kommo CRM",
      items: [
        expect.objectContaining({ id: "post", contentFormat: "STORY" }),
        // Only image deliverables carry a format.
        expect.objectContaining({ id: "seo", contentFormat: undefined }),
      ],
    });
    expect(tx.command.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          parsedIntent: {
            card: expect.objectContaining({
              state: "started",
              startedCount: 2,
              startedItemIds: ["post", "seo"],
            }),
          },
        },
      }),
    );
  });

  it("stamps when the package was started", async () => {
    await claimContentPackage({
      projectId: "proj-1",
      commandId: "cmd-1",
      selections: [{ id: "seo" }],
    });
    const written = tx.command.update.mock.calls[0]![0].data.parsedIntent.card;
    expect(Date.parse(written.startedAt)).not.toBeNaN();
  });

  it("explains a lost claim race instead of surfacing database text", async () => {
    const { Prisma } = await import("@prisma/client");
    tx.command.findUnique.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("write conflict", {
        code: "P2034",
        clientVersion: "test",
      }),
    );
    expect(
      await claimContentPackage({
        projectId: "proj-1",
        commandId: "cmd-1",
        selections: [{ id: "seo" }],
      }),
    ).toEqual({ ok: false, message: "This package is already being started." });

    // Anything else is a real failure and still throws.
    tx.command.findUnique.mockRejectedValue(new Error("db down"));
    await expect(
      claimContentPackage({
        projectId: "proj-1",
        commandId: "cmd-1",
        selections: [{ id: "seo" }],
      }),
    ).rejects.toThrow("db down");
  });

  it("falls back to the 3:4 post for an unknown format", async () => {
    const claim = await claimContentPackage({
      projectId: "proj-1",
      commandId: "cmd-1",
      selections: [{ id: "post", contentFormat: "BANNER" }],
    });
    expect(claim).toMatchObject({
      ok: true,
      items: [{ id: "post", contentFormat: "FEED_PORTRAIT" }],
    });
  });

  it("refuses a package that was already started, replaced or is not there", async () => {
    tx.command.findUnique.mockResolvedValue({
      projectId: "proj-1",
      parsedIntent: pkg("started"),
    });
    expect(
      await claimContentPackage({
        projectId: "proj-1",
        commandId: "cmd-1",
        selections: [{ id: "seo" }],
      }),
    ).toEqual({ ok: false, message: "This package was already started." });

    tx.command.findUnique.mockResolvedValue({
      projectId: "proj-1",
      parsedIntent: pkg("superseded"),
    });
    expect(
      await claimContentPackage({
        projectId: "proj-1",
        commandId: "cmd-1",
        selections: [{ id: "seo" }],
      }),
    ).toMatchObject({ ok: false });

    tx.command.findUnique.mockResolvedValue({
      projectId: "other-project",
      parsedIntent: pkg("draft"),
    });
    expect(
      await claimContentPackage({
        projectId: "proj-1",
        commandId: "cmd-1",
        selections: [{ id: "seo" }],
      }),
    ).toEqual({ ok: false, message: "Package not found." });
    expect(tx.command.update).not.toHaveBeenCalled();
  });

  it("needs at least one valid selection", async () => {
    expect(
      await claimContentPackage({
        projectId: "proj-1",
        commandId: "cmd-1",
        selections: [{ id: "nope" }],
      }),
    ).toEqual({ ok: false, message: "Select at least one item." });
    expect(tx.command.update).not.toHaveBeenCalled();
  });
});

describe("runContentPackage", () => {
  it("runs every ticked item inline and streams start, previews and the final card", async () => {
    driveJobInline.mockImplementation(async (jobId: string) => {
      if (jobId === "job-Post") {
        emitCreativeProgress(jobId, {
          type: "partial",
          index: 0,
          dataUrl: "data:image/png;base64,AAA",
        });
      }
      return { status: "COMPLETED", errorMessage: null };
    });
    commandFindFirst.mockImplementation(
      async ({ where }: { where: { cardTaskId: string } }) =>
        where.cardTaskId === "task-Post"
          ? {
              id: "row-post",
              replyText: "Creative ready: Post — awaiting approval.",
              parsedIntent: {
                card: { kind: "creative-ready", taskId: "task-Post", title: "Post" },
              },
            }
          : {
              id: "row-seo",
              replyText: "Task completed: Yazı",
              parsedIntent: {
                card: {
                  kind: "task-result",
                  taskId: "task-Yazı",
                  title: "Yazı",
                  status: "COMPLETED",
                  resultText: "Makale",
                },
              },
            },
    );

    const events = await collect(
      runContentPackage({
        ...base,
        selections: [{ id: "post", contentFormat: "STORY" }, { id: "seo" }],
      }),
    );

    // Each item: start -> (previews) -> done, the final card comes with the
    // persisted row it lives on.
    expect(forItem(events, "post").map((e) => e.type)).toEqual([
      "item.start",
      "item.partial",
      "item.done",
    ]);
    expect(forItem(events, "seo").map((e) => e.type)).toEqual([
      "item.start",
      "item.done",
    ]);
    expect(forItem(events, "post").at(-1)).toMatchObject({
      ok: true,
      commandId: "row-post",
      card: { kind: "creative-ready" },
    });
    expect(forItem(events, "seo").at(-1)).toMatchObject({
      ok: true,
      commandId: "row-seo",
      card: { kind: "task-result", resultText: "Makale" },
    });
    expect(events.at(-1)).toEqual({ type: "package.done", started: 2, failed: 0 });

    // Each item is a task for its own department, driven right here.
    expect(planForCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "CREATE_SOCIAL_CREATIVE",
        departmentKey: "CREATIVE",
        targetPlatform: "INSTAGRAM",
        title: "Post",
        commandId: "cmd-1",
        createdByType: "USER",
        // Chat renders are drafts (medium), like generate_image.
        payloadExtra: { contentFormat: "STORY", quality: "medium" },
        request: expect.stringContaining("Topic: Kommo CRM"),
      }),
    );
    expect(planForCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "CREATE_COPY",
        departmentKey: "SEO",
        targetPlatform: undefined,
        payloadExtra: undefined,
      }),
    );
    expect(driveJobInline).toHaveBeenCalledWith("job-Post", "LOW");
    expect(driveJobInline).toHaveBeenCalledWith("job-Yazı", "LOW");
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: "content_package.started" }),
    );
  });

  it("lets one failing item fail alone", async () => {
    commandFindUnique.mockResolvedValue({ parsedIntent: pkg("started") });
    planForCapability.mockImplementation(async (input: { title: string }) => {
      if (input.title === "Yazı") throw new Error("boom");
      return {
        task: { id: "task-1", riskLevel: "LOW" },
        dispatched: true,
        job: { id: "job-1" },
      };
    });

    const events = await collect(
      runContentPackage({
        ...base,
        selections: [{ id: "post" }, { id: "seo" }],
      }),
    );

    expect(forItem(events, "seo").at(-1)).toMatchObject({
      type: "item.done",
      ok: false,
    });
    expect(forItem(events, "post").at(-1)).toMatchObject({
      type: "item.done",
      ok: true,
    });
    expect(events.at(-1)).toEqual({ type: "package.done", started: 1, failed: 1 });
    // Something was started, so the card stays "started" — but it now lists
    // only what really got a task.
    expect(commandUpdate).toHaveBeenCalledTimes(1);
    expect(commandUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          parsedIntent: {
            card: expect.objectContaining({
              state: "started",
              startedCount: 1,
              startedItemIds: ["post"],
            }),
          },
        },
      }),
    );
  });

  it("reopens the card when nothing could be started", async () => {
    planForCapability.mockRejectedValue(new Error("boom"));
    commandFindUnique.mockResolvedValue({ parsedIntent: pkg("started") });

    const events = await collect(
      runContentPackage({ ...base, selections: [{ id: "seo" }] }),
    );

    expect(events.at(-1)).toEqual({ type: "package.done", started: 0, failed: 1 });
    expect(commandUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          parsedIntent: { card: expect.objectContaining({ state: "draft" }) },
        },
      }),
    );
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it("does not run a task that is parked behind an approval", async () => {
    planForCapability.mockResolvedValue({
      task: { id: "task-1", riskLevel: "LOW" },
      dispatched: false,
    });

    const events = await collect(
      runContentPackage({ ...base, selections: [{ id: "seo" }] }),
    );

    expect(driveJobInline).not.toHaveBeenCalled();
    expect(forItem(events, "seo").at(-1)).toMatchObject({
      type: "item.done",
      ok: true,
      reply: expect.stringContaining("needs your approval"),
    });
  });

  it("reports a failed render with a failure card when the chat row has none", async () => {
    driveJobInline.mockResolvedValue({
      status: "FAILED",
      errorMessage: "image model unavailable",
    });

    const events = await collect(
      runContentPackage({ ...base, selections: [{ id: "post" }] }),
    );

    expect(forItem(events, "post").at(-1)).toMatchObject({
      type: "item.done",
      ok: false,
      card: {
        kind: "creative-failed",
        taskId: "task-Post",
        message: "image model unavailable",
      },
    });
    // The task exists, so the card does not reopen.
    expect(events.at(-1)).toEqual({ type: "package.done", started: 1, failed: 1 });
  });

  it("says so when the job is still running after the wait", async () => {
    driveJobInline.mockResolvedValue({ status: "RUNNING", errorMessage: null });

    const events = await collect(
      runContentPackage({ ...base, selections: [{ id: "seo" }] }),
    );

    expect(forItem(events, "seo").at(-1)).toMatchObject({
      type: "item.done",
      ok: true,
      reply: expect.stringContaining("still being made"),
    });
    expect(forItem(events, "seo").at(-1)).not.toHaveProperty("card");
    // No point looking for a final card yet.
    expect(commandFindFirst).not.toHaveBeenCalled();
  });

  it("reports a cancelled job as cancelled, not as still running", async () => {
    driveJobInline.mockResolvedValue({ status: "CANCELLED", errorMessage: null });

    const events = await collect(
      runContentPackage({ ...base, selections: [{ id: "seo" }] }),
    );

    expect(forItem(events, "seo").at(-1)).toMatchObject({
      type: "item.done",
      ok: false,
      reply: expect.stringContaining("cancelled"),
    });
  });

  it("waits a moment for the card of a job another process finished", async () => {
    // The job is COMPLETED, but the process that ran it is still resolving
    // the chat row: the first look finds the running card, the second the result.
    commandFindFirst
      .mockResolvedValueOnce({
        id: "row-seo",
        replyText: "Task started",
        parsedIntent: {
          card: { kind: "task-running", taskId: "task-Yazı", title: "Yazı" },
        },
      })
      .mockResolvedValueOnce({
        id: "row-seo",
        replyText: "Task completed: Yazı",
        parsedIntent: {
          card: {
            kind: "task-result",
            taskId: "task-Yazı",
            title: "Yazı",
            status: "COMPLETED",
            resultText: "Makale",
          },
        },
      });

    const events = await collect(
      runContentPackage({ ...base, selections: [{ id: "seo" }] }),
    );

    expect(commandFindFirst).toHaveBeenCalledTimes(2);
    expect(forItem(events, "seo").at(-1)).toMatchObject({
      ok: true,
      commandId: "row-seo",
      card: { kind: "task-result", resultText: "Makale" },
    });
  });

  it("does not hand back an in-progress card as the result", async () => {
    commandFindFirst.mockResolvedValue({
      id: "row-seo",
      replyText: "Task started",
      parsedIntent: {
        card: { kind: "task-running", taskId: "task-Yazı", title: "Yazı" },
      },
    });

    const events = await collect(
      runContentPackage({ ...base, selections: [{ id: "seo" }] }),
    );

    // The row never became final within the wait: finish without a card and
    // let the page's own refresh deliver it.
    const done = forItem(events, "seo").at(-1);
    expect(done).toMatchObject({ type: "item.done", ok: true });
    expect((done as { card?: unknown }).card).toBeUndefined();
    expect((done as { commandId?: unknown }).commandId).toBeUndefined();
  });

  it("turns a recognized limit into a limit-notice card", async () => {
    driveJobInline.mockRejectedValue(
      new AgentelseError("BUDGET_EXCEEDED", "cap", {
        meta: { limit: "maxTasksPerDay", cap: 20, used: 20 },
      }),
    );

    const events = await collect(
      runContentPackage({ ...base, selections: [{ id: "seo" }] }),
    );

    expect(forItem(events, "seo").at(-1)).toMatchObject({
      type: "item.done",
      ok: false,
      card: { kind: "limit-notice", reason: "daily-tasks", cap: 20, used: 20 },
    });
  });

  it("does not blame a missing key when the provider is circuit-broken", async () => {
    driveJobInline.mockRejectedValue(
      new AgentelseError("PROVIDER_UNAVAILABLE", "circuit breaker: openai-creative"),
    );

    const events = await collect(
      runContentPackage({ ...base, selections: [{ id: "post" }] }),
    );

    const done = forItem(events, "post").at(-1);
    expect(done).toMatchObject({
      type: "item.done",
      ok: false,
      reply: expect.stringContaining("temporarily unavailable"),
    });
    // No limit card: it would blame a missing API key.
    expect((done as { card?: unknown }).card).toBeUndefined();
  });

  it("stops before claiming when the project is on hold", async () => {
    ensureProjectActive.mockResolvedValue({ status: "PAUSED", usable: false });

    const events = await collect(
      runContentPackage({ ...base, selections: [{ id: "seo" }] }),
    );

    expect(events).toEqual([
      expect.objectContaining({ type: "error", code: "PROJECT_INACTIVE" }),
    ]);
    expect(tx.command.findUnique).not.toHaveBeenCalled();
  });

  it("activates a project that never ran setup instead of refusing the run", async () => {
    tx.command.findUnique.mockResolvedValue({
      projectId: "proj-1",
      parsedIntent: pkg("started"),
    });

    await collect(runContentPackage({ ...base, selections: [{ id: "seo" }] }));

    expect(ensureProjectActive).toHaveBeenCalledWith("proj-1");
    // It got as far as claiming the package (here refused as already started).
    expect(tx.command.findUnique).toHaveBeenCalled();
  });

  it("reports a refused claim as an error event", async () => {
    tx.command.findUnique.mockResolvedValue({
      projectId: "proj-1",
      parsedIntent: pkg("started"),
    });

    const events = await collect(
      runContentPackage({ ...base, selections: [{ id: "seo" }] }),
    );

    expect(events).toEqual([
      {
        type: "error",
        code: "PACKAGE",
        message: "This package was already started.",
      },
    ]);
    expect(planForCapability).not.toHaveBeenCalled();
  });
});

describe("packageRequestText", () => {
  it("briefs the worker with the piece, its angle, the topic and the shape", () => {
    const text = packageRequestText(
      {
        id: "seo",
        deliverable: "seo_article",
        title: "Yazı",
        angle: "B",
      },
      "Kommo CRM",
    );
    expect(text).toContain("SEO article: Yazı");
    expect(text).toContain("Angle: B");
    expect(text).toContain("Topic: Kommo CRM");
    expect(text).toContain("meta title");
  });
});
