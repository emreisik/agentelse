import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves about the chat tools that run a job inline (create_task
// for text, generate_image for a picture) when the plan allowance cannot pay for
// it: driveJobInline hands back the job as WAITING_BUDGET, and the tool must say
// "paused" with a limit-notice card, never "ready", "done" or "still rendering"
// (docs/billing-tasks.md, "Park (WAITING_BUDGET) ve devam"). The helpers
// themselves (isParked, describePause, PAUSED_NOTE) are parked-job.test.ts's
// subject; here only the sizing of the job is stubbed.

const prismaMock = vi.hoisted(() => ({
  task: { findUnique: vi.fn() },
  executionJob: { findFirst: vi.fn(), findUnique: vi.fn() },
  usageBalance: { findUnique: vi.fn().mockResolvedValue(null) },
}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/server/integrations/meta-connection-status", () => ({
  getPublishTargets: vi.fn(),
}));
vi.mock("@/server/brand-twin/brand-twin", () => ({ getBrandTwin: vi.fn() }));
vi.mock("@/server/brand-twin/brand-twin-writes", () => ({
  recordUserDecision: vi.fn(),
}));
vi.mock("@/server/actions/agency-setup-actions", () => ({
  startAgencySetupForProject: vi.fn(),
}));
const submit = vi.hoisted(() => vi.fn());
vi.mock("@/server/commands/command-service", () => ({
  CommandService: { submit },
}));
const driveJobInline = vi.hoisted(() => vi.fn());
vi.mock("./inline-job", () => ({ driveJobInline }));
// Which allowance a job needs is usage-need's subject (provider-usage-
// declarations.test.ts); it also drags in the providers.
const usageNeedOf = vi.hoisted(() => vi.fn());
vi.mock("@/server/execution/usage-need", () => ({ usageNeedOf }));

const { toolsForPhase } = await import("./tools");
const { PAUSED_NOTE } = await import("./parked-job");
// Real, not mocked: the in-process channel the tool listens on for live previews.
const { hasCreativeProgressListener } =
  await import("@/server/media/creative-progress");

const tool = (name: string) =>
  toolsForPhase("ACTIVE").find((candidate) => candidate.name === name)!;

const ctx = {
  workspaceId: "w",
  projectId: "p",
  brandId: "b",
  userId: "u",
  commandId: "c",
  message: "make me something",
  phase: "ACTIVE" as const,
  emit: vi.fn(),
};

const PARKED = { status: "WAITING_BUDGET", errorMessage: null };

const planned = {
  status: "PLANNED",
  commandId: "c",
  taskId: "task-1",
  dispatched: true,
  requiresApproval: false,
};

// The two reasons a job parks, and the card each one must produce.
const REASONS = [
  ["QUOTA_EXCEEDED", "allowance-used"],
  ["NO_PLAN", "no-plan"],
] as const;

// Every outcome of the two tools that claims a result or progress.
const SUCCESS_OR_PROGRESS_OUTCOMES = [
  "task_completed",
  "task_still_running",
  "task_created",
  "task_failed",
  "image_ready",
  "image_still_rendering",
  "image_failed",
];

beforeEach(() => {
  vi.resetAllMocks();
  submit.mockResolvedValue(planned);
  prismaMock.executionJob.findFirst.mockResolvedValue({ id: "job-1" });
  prismaMock.task.findUnique.mockResolvedValue({ riskLevel: "LOW" });
  driveJobInline.mockResolvedValue(PARKED);
  usageNeedOf.mockReturnValue({ unit: "AI_MICROS", amount: BigInt(1) });
});

// The job row as the park step left it. It is the only findUnique a parked
// outcome may make: the finished result and the layout are read for finished
// jobs only.
const parkedRow = (errorCode: string, capability: string) =>
  prismaMock.executionJob.findUnique.mockResolvedValue({
    errorCode,
    capability,
    requestPayload: { request: "x" },
  });

const readTheFinishedJob = () =>
  prismaMock.executionJob.findUnique.mock.calls.filter(
    ([args]) =>
      (args as { select?: { rawResult?: boolean } }).select?.rawResult === true,
  );

describe("create_task with a text job the plan cannot pay for", () => {
  const run = (capability = "CREATE_COPY") => {
    const create = tool("create_task");
    return create.execute(
      create.schema.parse({
        capability,
        taskBrief: "A short caption for the autumn sale",
      }),
      ctx,
    );
  };

  it("pauses the task: planned, a limit-notice card, and the model told it is NOT made", async () => {
    parkedRow("QUOTA_EXCEEDED", "CREATE_COPY");

    const outcome = await run();

    expect(driveJobInline).toHaveBeenCalledWith("job-1", "LOW");
    // The card says why THIS job waits: it is read from the job row.
    expect(prismaMock.executionJob.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "job-1" } }),
    );
    expect(outcome.status).toBe("PLANNED");
    expect(outcome.card).toMatchObject({
      kind: "limit-notice",
      reason: "allowance-used",
      unit: "AI_MICROS",
    });
    expect(outcome.result).toEqual({
      outcome: "task_paused",
      taskId: "task-1",
      note: PAUSED_NOTE,
    });
  });

  it.each(REASONS)(
    "shows the %s story on the card",
    async (errorCode, reason) => {
      parkedRow(errorCode, "CREATE_COPY");

      const outcome = await run();

      expect(outcome.card).toMatchObject({ kind: "limit-notice", reason });
      expect(outcome.result).toMatchObject({ outcome: "task_paused" });
    },
  );

  it("never claims a result, progress or a queued job, and reads no finished result", async () => {
    parkedRow("QUOTA_EXCEEDED", "REPORTING");

    const outcome = await run("REPORTING");

    const result = outcome.result as Record<string, unknown>;
    expect(SUCCESS_OR_PROGRESS_OUTCOMES).not.toContain(result.outcome);
    expect(result).not.toHaveProperty("result");
    expect(result).not.toHaveProperty("truncated");
    expect(JSON.stringify(outcome)).not.toContain("The work is queued");
    expect(readTheFinishedJob()).toHaveLength(0);
    expect(outcome.status).not.toBe("ERROR");
  });
});

describe("generate_image with a picture job the plan cannot pay for", () => {
  const run = () => {
    const generate = tool("generate_image");
    return generate.execute(
      generate.schema.parse({
        imagePrompt: "A calm clinic reception",
        caption: "Caption",
        copy: "Copy",
        platform: "INSTAGRAM",
        contentFormat: "FEED_PORTRAIT",
      }),
      ctx,
    );
  };

  beforeEach(() => {
    usageNeedOf.mockReturnValue({ unit: "IMAGE", amount: BigInt(1) });
  });

  it("pauses the picture: planned, a limit-notice card, and the model told it is NOT made", async () => {
    parkedRow("QUOTA_EXCEEDED", "CREATE_SOCIAL_CREATIVE");

    const outcome = await run();

    expect(driveJobInline).toHaveBeenCalledWith("job-1", "LOW");
    // The card says why THIS job waits: it is read from the job row.
    expect(prismaMock.executionJob.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "job-1" } }),
    );
    expect(outcome.status).toBe("PLANNED");
    expect(outcome.card).toMatchObject({
      kind: "limit-notice",
      reason: "allowance-used",
      unit: "IMAGE",
    });
    expect(outcome.result).toEqual({
      outcome: "image_paused",
      taskId: "task-1",
      note: PAUSED_NOTE,
    });
  });

  it.each(REASONS)(
    "shows the %s story on the card",
    async (errorCode, reason) => {
      parkedRow(errorCode, "CREATE_SOCIAL_CREATIVE");

      const outcome = await run();

      expect(outcome.card).toMatchObject({ kind: "limit-notice", reason });
      expect(outcome.result).toMatchObject({ outcome: "image_paused" });
    },
  );

  // beginJobBilling closes a job whose task is already finished or cancelled and
  // hands it back CANCELLED: that is not a picture, and must not read as "ready".
  it("a job that was cancelled before it started is reported as not made, never as a ready picture", async () => {
    driveJobInline.mockResolvedValue({
      status: "CANCELLED",
      errorMessage: null,
    });

    const outcome = await run();

    expect(outcome.status).toBe("ERROR");
    expect(outcome.result).toMatchObject({
      outcome: "image_failed",
      taskId: "task-1",
      error: "the task was cancelled",
    });
    expect(JSON.stringify(outcome)).not.toContain("image_ready");
  });

  it("lets go of the live preview listener when the picture pauses", async () => {
    parkedRow("QUOTA_EXCEEDED", "CREATE_SOCIAL_CREATIVE");
    let listeningWhileDriving = false;
    driveJobInline.mockImplementation(async () => {
      listeningWhileDriving = hasCreativeProgressListener("job-1");
      return PARKED;
    });

    await run();

    // The tool listened while the job ran (nothing to let go of otherwise)...
    expect(listeningWhileDriving).toBe(true);
    // ...and the paused exit does not leave the listener behind.
    expect(hasCreativeProgressListener("job-1")).toBe(false);
  });

  it("never says the image is ready, rendering or failed, and reads no layout", async () => {
    parkedRow("QUOTA_EXCEEDED", "CREATE_SOCIAL_CREATIVE");

    const outcome = await run();

    const result = outcome.result as Record<string, unknown>;
    expect(SUCCESS_OR_PROGRESS_OUTCOMES).not.toContain(result.outcome);
    expect(result).not.toHaveProperty("layout");
    expect(JSON.stringify(outcome.result)).not.toContain(
      "already visible to the client",
    );
    expect(readTheFinishedJob()).toHaveLength(0);
    expect(outcome.status).not.toBe("ERROR");
  });
});
