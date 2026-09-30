import { beforeEach, describe, expect, it, vi } from "vitest";

// create_task and a new social account. SOCIAL_ACCOUNT_SETUP opens an account in
// a browser and cannot run without a platform; the agent used to create it
// without one, the client was asked to approve a High Risk task, and only after
// they clicked Approve did it fail. Now the platform is asked for with buttons
// before any task or approval exists.

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
const submit = vi.hoisted(() => vi.fn());
vi.mock("@/server/commands/command-service", () => ({
  CommandService: { submit },
}));
vi.mock("@/server/commands/strategic-request", () => ({ saveIdea: vi.fn() }));
vi.mock("@/server/memory/memory-service", () => ({
  MemoryService: { remember: vi.fn() },
}));
vi.mock("@/server/work-session/work-session-service", () => ({
  WorkSessionService: { start: vi.fn(), update: vi.fn() },
}));

const { toolsForPhase, outcomeFromSubmission } = await import("./tools");

const createTask = toolsForPhase("ACTIVE").find(
  (tool) => tool.name === "create_task",
)!;

type Ctx = Parameters<typeof createTask.execute>[1];
const ctx = (overrides: Partial<Ctx> = {}): Ctx => ({
  workspaceId: "ws-1",
  projectId: "proj-1",
  brandId: "brand-1",
  userId: "user-1",
  commandId: "cmd-1",
  message: "Qr Hub Menü için sosyal medya yönetimi kurulumunu planla",
  phase: "ACTIVE",
  emit: vi.fn(),
  ...overrides,
});

const planned = {
  status: "PLANNED",
  commandId: "cmd-1",
  taskId: "task-1",
  dispatched: false,
  requiresApproval: true,
};

beforeEach(() => {
  vi.resetAllMocks();
  submit.mockResolvedValue(planned);
});

describe("create_task: a new social account", () => {
  const setup = (extra: Record<string, unknown> = {}) => ({
    capability: "SOCIAL_ACCOUNT_SETUP",
    taskBrief: "Set up the brand's social presence",
    ...extra,
  });

  it("asks which platform with buttons, and creates nothing, when none is given", async () => {
    const outcome = await createTask.execute(
      setup(),
      ctx({ ideaId: "idea-1" }),
    );

    expect(submit).not.toHaveBeenCalled();
    expect(outcome.status).toBe("ANSWERED");
    expect(outcome.card).toMatchObject({
      kind: "question",
      projectId: "proj-1",
      ideaId: "idea-1",
    });
    const options =
      outcome.card?.kind === "question"
        ? outcome.card.questions[0]!.options.map((option) => option.label)
        : [];
    expect(options).toEqual(["Instagram", "TikTok", "LinkedIn"]);
  });

  it("tells the model nothing was created and what to do once the client answers", async () => {
    const outcome = await createTask.execute(setup(), ctx());

    expect(outcome.result).toMatchObject({
      outcome: "platform_question_shown",
    });
    const note = String((outcome.result as { note: string }).note);
    expect(note).toContain("Nothing was created");
    expect(note).toContain("call create_task again with that platform");
  });

  it("asks again, saying why, for a platform an account cannot be set up on", async () => {
    const outcome = await createTask.execute(
      setup({ platform: "FACEBOOK" }),
      ctx(),
    );

    expect(submit).not.toHaveBeenCalled();
    expect(
      outcome.card?.kind === "question" && outcome.card.questions[0]!.question,
    ).toContain("can't be set up on FACEBOOK");
  });

  it("asks again for X too: no X browser profile can exist, so it could only fail after Approve", async () => {
    const outcome = await createTask.execute(setup({ platform: "X" }), ctx());

    expect(submit).not.toHaveBeenCalled();
    expect(
      outcome.card?.kind === "question" && outcome.card.questions[0]!.question,
    ).toContain("can't be set up on X");
  });

  it.each(["INSTAGRAM", "TIKTOK", "LINKEDIN"])(
    "goes ahead with %s",
    async (platform) => {
      const outcome = await createTask.execute(setup({ platform }), ctx());

      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit.mock.calls[0]![0].intent).toMatchObject({
        capability: "SOCIAL_ACCOUNT_SETUP",
        targetPlatform: platform,
      });
      expect(outcome.result).toMatchObject({ outcome: "task_created" });
    },
  );

  it("does not get in the way of any other capability, with or without a platform", async () => {
    for (const capability of [
      "CREATE_COPY",
      "COMPETITOR_RESEARCH",
      "REPORTING",
    ]) {
      submit.mockClear();
      await createTask.execute(
        { capability, taskBrief: "something", platform: undefined },
        ctx(),
      );
      expect(submit).toHaveBeenCalledTimes(1);
    }
  });
});

describe("create_task: what the model is told about the capability", () => {
  it("says it opens a NEW account, needs a platform and approval, and is not for planning", () => {
    const { description } = createTask;

    expect(description).toContain("SOCIAL_ACCOUNT_SETUP");
    expect(description).toContain("opens a NEW account");
    expect(description).toContain("always needs `platform`");
    expect(description).toContain(
      "Planning, organising or managing their social media is NOT that",
    );
  });

  it("still offers the capability: only the missing platform is refused", () => {
    expect(
      createTask.schema.safeParse({
        capability: "SOCIAL_ACCOUNT_SETUP",
        taskBrief: "x",
        platform: "INSTAGRAM",
      }).success,
    ).toBe(true);
  });
});

describe("outcomeFromSubmission: NEEDS_INPUT", () => {
  const needs = {
    status: "NEEDS_INPUT" as const,
    commandId: "cmd-1",
    field: "platform" as const,
    problem: "missing" as const,
    allowed: ["INSTAGRAM", "TIKTOK", "LINKEDIN"] as const,
  };

  it("tells the model nothing was created when a task was to be made", () => {
    const outcome = outcomeFromSubmission(needs);

    expect(outcome.status).toBe("ANSWERED");
    expect(outcome.result).toMatchObject({
      outcome: "needs_input",
      field: "platform",
    });
    expect(String((outcome.result as { note: string }).note)).toContain(
      "Nothing was created",
    );
  });

  it("tells the model nothing was approved when an approval was to be given", () => {
    const outcome = outcomeFromSubmission({ ...needs, approvalId: "appr-1" });

    const note = String((outcome.result as { note: string }).note);
    expect(note).toContain("Nothing was approved");
    expect(note).toContain("reject it and ask again");
  });
});
