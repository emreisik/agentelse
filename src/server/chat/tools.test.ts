import { describe, expect, it, vi } from "vitest";

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
