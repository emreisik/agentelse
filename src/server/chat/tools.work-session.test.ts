import { beforeEach, describe, expect, it, vi } from "vitest";

// The two tools of a work session. They only keep the checkpoint (the steps are
// done with the ordinary tools), so this suite pins down: when they are offered,
// what they hand to the store, what they tell the model, that a message which
// read outside content can no longer write words into the checkpoint, and that
// the ids of what tools produce come back for the steps to point at.

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
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
vi.mock("@/server/commands/command-service", () => ({
  CommandService: { submit: vi.fn() },
}));
const saveIdea = vi.hoisted(() => vi.fn());
vi.mock("@/server/commands/strategic-request", () => ({ saveIdea }));
vi.mock("@/server/memory/memory-service", () => ({
  MemoryService: { remember: vi.fn() },
}));
const start = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
vi.mock("@/server/work-session/work-session-service", () => ({
  WorkSessionService: { start, update },
}));

const { toolsForPhase, outcomeFromSubmission } = await import("./tools");
import { createSession, type WorkSession } from "@/server/work-session/session";

const tool = (name: string, phase: "ACTIVE" | "ON_HOLD" = "ACTIVE") =>
  toolsForPhase(phase).find((candidate) => candidate.name === name)!;

type Ctx = Parameters<ReturnType<typeof tool>["execute"]>[1];
const baseCtx = (overrides: Partial<Ctx> = {}): Ctx => ({
  workspaceId: "ws-1",
  projectId: "proj-1",
  brandId: "brand-1",
  userId: "user-1",
  commandId: "cmd-1",
  message: "Prepare the autumn campaign",
  phase: "ACTIVE",
  session: {},
  emit: vi.fn(),
  ...overrides,
});

const T0 = new Date("2026-09-30T10:00:00.000Z");
function sessionOf(steps = ["Research", "Write", "Render"]): WorkSession {
  const created = createSession(
    { goal: "Autumn campaign", steps },
    T0,
    "rev-1",
  );
  if (!created.ok) throw new Error(created.error);
  return created.session;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("start_work_session", () => {
  it("is a note the agent has while the project is active, not on hold", () => {
    expect(tool("start_work_session").kind).toBe("note");
    expect(toolsForPhase("ON_HOLD").map((t) => t.name)).not.toContain(
      "start_work_session",
    );
    expect(toolsForPhase("ACTIVE").map((t) => t.name)).toContain(
      "start_work_session",
    );
  });

  it("cannot be used once outside content was read, and does not decide anything", () => {
    expect(tool("start_work_session").sensitive).toBe(true);
    expect(tool("start_work_session").decisive).toBeFalsy();
  });

  it("wants a goal and two to eight steps", () => {
    const { schema } = tool("start_work_session");

    expect(schema.safeParse({ goal: "g", steps: ["a", "b"] }).success).toBe(
      true,
    );
    expect(schema.safeParse({ goal: "g", steps: ["a"] }).success).toBe(false);
    expect(
      schema.safeParse({
        goal: "g",
        steps: Array.from({ length: 9 }, (_, i) => `s${i}`),
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ steps: ["a", "b"] }).success).toBe(false);
  });

  it("opens the session for the project and tells the model to start on it", async () => {
    start.mockResolvedValue({
      status: "STARTED",
      id: "cmd-s1",
      session: sessionOf(),
    });
    const ctx = baseCtx();

    const outcome = await tool("start_work_session").execute(
      { goal: "Autumn campaign", steps: ["Research", "Write", "Render"] },
      ctx,
    );

    expect(start).toHaveBeenCalledWith(
      { workspaceId: "ws-1", projectId: "proj-1", brandId: "brand-1" },
      {
        goal: "Autumn campaign",
        steps: ["Research", "Write", "Render"],
        userId: "user-1",
      },
    );
    expect(outcome.result).toMatchObject({
      outcome: "session_started",
      steps: [
        { id: "s1", title: "Research" },
        { id: "s2", title: "Write" },
        { id: "s3", title: "Render" },
      ],
    });
    expect(String((outcome.result as { note: string }).note)).toContain(
      "nothing has been done yet",
    );
  });

  it("marks the turn as belonging to the session", async () => {
    start.mockResolvedValue({
      status: "STARTED",
      id: "cmd-s1",
      session: sessionOf(),
    });
    const ctx = baseCtx();

    await tool("start_work_session").execute(
      { goal: "Autumn campaign", steps: ["a", "b"] },
      ctx,
    );

    expect(ctx.session?.id).toBe("cmd-s1");
  });

  it("does not start a second one; it points the model at the open one", async () => {
    start.mockResolvedValue({
      status: "ALREADY_ACTIVE",
      id: "cmd-old",
      session: sessionOf(),
    });
    const ctx = baseCtx();

    const outcome = await tool("start_work_session").execute(
      { goal: "Something else", steps: ["a", "b"] },
      ctx,
    );

    expect(outcome.result).toMatchObject({
      outcome: "session_already_active",
      goal: "Autumn campaign",
      progress: { done: 0, total: 3, next: { id: "s1", title: "Research" } },
    });
    // The message still runs under the session that is open.
    expect(ctx.session?.id).toBe("cmd-old");
  });

  it("reports why it did not start, and leaves the turn as an ordinary one", async () => {
    start.mockResolvedValue({ status: "INVALID", error: "needs steps" });
    const ctx = baseCtx();

    const outcome = await tool("start_work_session").execute(
      { goal: " ", steps: ["a", "b"] },
      ctx,
    );

    expect(outcome.result).toEqual({
      outcome: "not_started",
      error: "needs steps",
    });
    expect(ctx.session?.id).toBeUndefined();
  });

  it("works for a caller that keeps no session handle", async () => {
    start.mockResolvedValue({
      status: "STARTED",
      id: "cmd-s1",
      session: sessionOf(),
    });

    await expect(
      tool("start_work_session").execute(
        { goal: "g", steps: ["a", "b"] },
        baseCtx({ session: undefined }),
      ),
    ).resolves.toBeDefined();
  });
});

describe("update_work_session", () => {
  const options = { freeText: true, userId: "user-1" };

  it("is a plain note, available while the project is active", () => {
    const updateTool = tool("update_work_session");

    expect(updateTool.kind).toBe("note");
    expect(updateTool.sensitive).toBeFalsy();
    expect(updateTool.decisive).toBeFalsy();
    expect(toolsForPhase("ON_HOLD").map((t) => t.name)).not.toContain(
      "update_work_session",
    );
  });

  it("takes a partial update and refuses a status it does not know", () => {
    const { schema } = tool("update_work_session");

    expect(schema.safeParse({ stepId: "s1", status: "DONE" }).success).toBe(
      true,
    );
    expect(schema.safeParse({ cancel: true }).success).toBe(true);
    expect(schema.safeParse({ addSteps: ["More"] }).success).toBe(true);
    expect(schema.safeParse({ stepId: "s1", status: "FINISHED" }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({
        stepId: "s1",
        artifacts: [{ kind: "campaign", id: "x" }],
      }).success,
    ).toBe(false);
  });

  it("hands the update to the store for this project, free to write words", async () => {
    update.mockResolvedValue({
      status: "UPDATED",
      session: sessionOf(),
      ended: null,
      ignored: [],
    });
    const args = {
      stepId: "s1",
      status: "DONE",
      note: "Three competitors",
      artifacts: [{ kind: "task", id: "task_1" }],
    };

    await tool("update_work_session").execute(args, baseCtx());

    expect(update).toHaveBeenCalledWith(
      { workspaceId: "ws-1", projectId: "proj-1", brandId: "brand-1" },
      args,
      options,
    );
  });

  it("writes no words when the message has read outside content", async () => {
    update.mockResolvedValue({
      status: "UPDATED",
      session: sessionOf(),
      ended: null,
      ignored: ["note"],
    });

    const outcome = await tool("update_work_session").execute(
      { stepId: "s1", status: "DONE", note: "from a web page" },
      baseCtx({ tainted: true }),
    );

    expect(update.mock.calls[0]![2]).toEqual({
      freeText: false,
      userId: "user-1",
    });
    expect(outcome.result).toMatchObject({
      outcome: "updated",
      ignored: ["note"],
    });
    expect(String((outcome.result as { note: string }).note)).toContain(
      "outside the conversation",
    );
  });

  it("reports progress and what comes next", async () => {
    let session = sessionOf();
    session = {
      ...session,
      steps: session.steps.map((step) =>
        step.id === "s1" ? { ...step, status: "DONE" as const } : step,
      ),
    };
    update.mockResolvedValue({
      status: "UPDATED",
      session,
      ended: null,
      ignored: [],
    });

    const outcome = await tool("update_work_session").execute(
      { stepId: "s1", status: "DONE" },
      baseCtx(),
    );

    expect(outcome.result).toEqual({
      outcome: "updated",
      progress: "1 of 3 steps settled",
      next: { id: "s2", title: "Write" },
    });
  });

  it("tells the model to wrap up when the last step closes the session", async () => {
    const session = {
      ...sessionOf(["a", "b"]),
      status: "COMPLETED" as const,
      steps: sessionOf(["a", "b"]).steps.map((step) => ({
        ...step,
        status: "DONE" as const,
      })),
    };
    update.mockResolvedValue({
      status: "UPDATED",
      session,
      ended: "COMPLETED",
      ignored: [],
    });

    const outcome = await tool("update_work_session").execute(
      { stepId: "s2", status: "DONE" },
      baseCtx(),
    );

    expect(outcome.result).toMatchObject({
      outcome: "session_completed",
      progress: "2 of 2 steps settled",
    });
    expect(String((outcome.result as { note: string }).note)).toContain(
      "what was produced",
    );
    expect(outcome.result).not.toHaveProperty("next");
  });

  it("keeps both notes when the closing update also dropped words", async () => {
    update.mockResolvedValue({
      status: "UPDATED",
      session: sessionOf(["a", "b"]),
      ended: "COMPLETED",
      ignored: ["note"],
    });

    const outcome = await tool("update_work_session").execute(
      { stepId: "s2", status: "DONE", note: "x" },
      baseCtx({ tainted: true }),
    );

    const note = String((outcome.result as { note: string }).note);
    expect(note).toContain("what was produced");
    expect(note).toContain("outside the conversation");
  });

  it("confirms a cancel", async () => {
    update.mockResolvedValue({
      status: "UPDATED",
      session: sessionOf(),
      ended: "CANCELLED",
      ignored: [],
    });

    const outcome = await tool("update_work_session").execute(
      { cancel: true },
      baseCtx(),
    );

    expect(outcome.result).toMatchObject({ outcome: "session_cancelled" });
  });

  it("says so when there is no session to update", async () => {
    update.mockResolvedValue({ status: "NONE" });

    const outcome = await tool("update_work_session").execute(
      { stepId: "s1", status: "DONE" },
      baseCtx(),
    );

    expect(outcome.result).toMatchObject({ outcome: "no_active_session" });
  });

  it("passes on why an update was refused", async () => {
    update.mockResolvedValue({
      status: "REJECTED",
      error: 'Unknown step "s9".',
    });

    const outcome = await tool("update_work_session").execute(
      { stepId: "s9", status: "DONE" },
      baseCtx(),
    );

    expect(outcome.result).toEqual({
      outcome: "not_updated",
      error: 'Unknown step "s9".',
    });
  });
});

describe("what tools hand back for a step to point at", () => {
  it("a queued task result carries the task id", () => {
    const outcome = outcomeFromSubmission({
      status: "PLANNED",
      commandId: "cmd-1",
      taskId: "task_42",
      dispatched: true,
      requiresApproval: false,
    });

    expect(outcome.result).toMatchObject({
      outcome: "task_created",
      taskId: "task_42",
    });
  });

  it("a saved idea result carries the idea id", async () => {
    saveIdea.mockResolvedValue({ status: "CREATED", ideaId: "idea_7" });

    const outcome = await tool("save_idea").execute(
      { title: "Autumn story", description: "A series about autumn" },
      baseCtx(),
    );

    expect(outcome.result).toMatchObject({
      outcome: "idea_saved",
      ideaId: "idea_7",
    });
  });
});
