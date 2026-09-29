import { afterEach, describe, expect, it, vi } from "vitest";

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

const { outcomeFromSubmission, toolsForPhase, toOpenAITools } =
  await import("./tools");

const planResult = (ideasConsidered: number) => ({
  ideasConsidered,
  imagesGenerated: ideasConsidered,
  imagesFailed: 0,
  scheduled: 0,
  cappedForToday: false,
  pendingReview: 0,
  items: [],
});

describe("outcomeFromSubmission", () => {
  it("answers in words instead of an empty 0/0 card when nothing was planned", () => {
    const outcome = outcomeFromSubmission({
      status: "WEEKLY_PLAN_CREATED",
      commandId: "c",
      summary: "0/0 created",
      result: planResult(0),
    });
    expect(outcome.card).toBeUndefined();
    expect(outcome.status).toBe("ANSWERED");
    expect(JSON.stringify(outcome.result)).toContain("weekly_plan_empty");
  });

  it("keeps the summary card when the plan produced something", () => {
    const outcome = outcomeFromSubmission({
      status: "WEEKLY_PLAN_CREATED",
      commandId: "c",
      summary: "3/3 created",
      result: planResult(3),
    });
    expect(outcome.card).toMatchObject({ kind: "content-plan-summary" });
    expect(outcome.status).toBe("PLANNED");
  });
});

describe("toolsForPhase", () => {
  const names = (phase: "ACTIVE" | "ON_HOLD") =>
    toolsForPhase(phase).map((t) => t.name);

  it("offers work tools on an active project, with no onboarding tool in the way", () => {
    expect(names("ACTIVE")).toContain("create_task");
    expect(names("ACTIVE")).toContain("generate_image");
    // The full 12-stage pipeline is no longer something the agent starts on
    // its own; setup is not a prerequisite for working.
    expect(names("ACTIVE")).not.toContain("start_brand_setup");
    expect(names("ON_HOLD")).not.toContain("start_brand_setup");
  });

  it("keeps a paused or closed project read-only: it can talk and look things up, never start work", () => {
    const onHold = names("ON_HOLD");
    expect(onHold).toEqual(
      expect.arrayContaining([
        "ask_user",
        "remember_preference",
        "get_brand_profile",
      ]),
    );
    for (const work of [
      "create_task",
      "generate_image",
      "start_strategic_project",
      "generate_ideas_from_opportunities",
      "decide_approval",
      "propose_content_plan",
      "propose_content_package",
    ]) {
      expect(onHold, work).not.toContain(work);
    }
  });
});

describe("planning tools", () => {
  it("offers propose_content_plan and steers away from the batch planner", () => {
    const tools = toolsForPhase("ACTIVE");
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "propose_content_plan",
        "get_connected_platforms",
      ]),
    );

    const createTask = toOpenAITools(tools).find(
      (t) => "name" in t && t.name === "create_task",
    ) as { parameters: { properties: { capability: { enum: string[] } } } };
    expect(createTask.parameters.properties.capability.enum).not.toContain(
      "CREATE_CONTENT_PLAN",
    );
    expect(createTask.parameters.properties.capability.enum).toContain(
      "CREATE_COPY",
    );
  });

  it("offers the planning wizard once active, and its plan schema is channel-based", () => {
    const tools = toolsForPhase("ACTIVE");
    expect(tools.map((t) => t.name)).toContain("start_plan_brief");
    const plan = toOpenAITools(tools).find(
      (t) => "name" in t && t.name === "propose_content_plan",
    ) as {
      parameters: {
        properties: {
          goal: { enum: string[] };
          items: { items: { properties: { channel: { enum: string[] } } } };
        };
      };
    };
    expect(plan.parameters.properties.goal.enum).toContain("leads");
    expect(
      plan.parameters.properties.items.items.properties.channel.enum,
    ).toEqual(["instagram", "tiktok", "linkedin", "x", "seo", "ads"]);
  });

  it("does not offer planning on a project that is on hold", () => {
    expect(toolsForPhase("ON_HOLD").map((t) => t.name)).not.toContain(
      "start_plan_brief",
    );
    expect(toolsForPhase("ON_HOLD").map((t) => t.name)).not.toContain(
      "propose_content_plan",
    );
  });
});

describe("legacy-loop gating of start_strategic_project", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.LEGACY_AGENCY_LOOP;
  });
  const names = () => toolsForPhase("ACTIVE").map((t) => t.name);

  it("is offered while the legacy loop is fully on (the default)", () => {
    delete process.env.LEGACY_AGENCY_LOOP;
    expect(names()).toContain("start_strategic_project");
  });

  it.each(["drain", "off"])(
    "is withdrawn in %s mode, because the Director that plans it is no longer running",
    (mode) => {
      vi.stubEnv("LEGACY_AGENCY_LOOP", mode);
      expect(names()).not.toContain("start_strategic_project");
      // Everything the agent can do on its own is still there.
      expect(names()).toEqual(
        expect.arrayContaining([
          "create_task",
          "generate_image",
          "save_idea",
          "generate_ideas_from_opportunities",
        ]),
      );
    },
  );

  it("offers save_idea in every mode", () => {
    for (const mode of ["on", "drain", "off"]) {
      vi.stubEnv("LEGACY_AGENCY_LOOP", mode);
      expect(names()).toContain("save_idea");
    }
  });
});

describe("save_idea", () => {
  const ctx = {
    workspaceId: "w",
    projectId: "p",
    brandId: "b",
    userId: "u",
    commandId: "c",
    message: "keep that one",
    phase: "ACTIVE" as const,
    emit: vi.fn(),
  };
  const tool = () =>
    toolsForPhase("ACTIVE").find((candidate) => candidate.name === "save_idea")!;

  it("is a note, so it never uses up the turn's one work action", () => {
    expect(tool().kind).toBe("note");
  });

  it("saves the idea for this project and says nothing was produced", async () => {
    saveIdea.mockResolvedValue({ status: "CREATED", ideaId: "idea-1" });

    const outcome = await tool().execute(
      { title: "  Autumn series ", description: " Weekly recipes. ", lens: "CONTENT" },
      ctx,
    );

    expect(saveIdea).toHaveBeenCalledWith(
      { workspaceId: "w", projectId: "p", brandId: "b" },
      { title: "Autumn series", description: "Weekly recipes.", lens: "CONTENT" },
    );
    expect(outcome.result).toMatchObject({ outcome: "idea_saved" });
    expect(JSON.stringify(outcome.result)).toContain("do not claim any work");
  });

  it("reports the active-ideas cap instead of pretending it saved", async () => {
    saveIdea.mockResolvedValue({ status: "CAPPED" });

    const outcome = await tool().execute(
      { title: "One more", description: "…" },
      ctx,
    );

    expect(outcome.status).toBe("ERROR");
    expect(outcome.result).toMatchObject({ outcome: "blocked_idea_cap" });
  });

  it("validates its input", () => {
    const schema = tool().schema;
    expect(schema.safeParse({ title: "", description: "x" }).success).toBe(false);
    expect(schema.safeParse({ title: "x".repeat(121), description: "x" }).success).toBe(false);
    // An unknown lens degrades to "no lens" instead of failing the call.
    expect(
      schema.safeParse({ title: "x", description: "y", lens: "NOT_A_LENS" }),
    ).toMatchObject({ success: true, data: { lens: undefined } });
  });
});

describe("empty idea backlog", () => {
  it("points the agent at proposing and saving ideas itself", () => {
    const outcome = outcomeFromSubmission({
      status: "IDEAS_GENERATED_FROM_OPPORTUNITIES",
      commandId: "c",
      count: 0,
    });
    expect(JSON.stringify(outcome.result)).toContain("save_idea");
  });
});
