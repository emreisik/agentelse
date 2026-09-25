import { beforeEach, describe, expect, it, vi } from "vitest";

// Deep Path bridge (docs/brand-workspace-migration.md §7 Phase 8): a
// chat-classified "strategic" request must respect the SAME maxActiveIdeas
// cap an autonomously-generated idea does (mirrors idea-foundry.ts's
// generateForOpportunity gate), and must create the idea at RAW status so
// the existing Council/Director tick pipeline can pick it up — no new
// orchestration code involved.

const ideaCreate = vi.fn();
const ideaCountActive = vi.fn();
vi.mock("@/server/repositories/idea.repository", () => ({
  IdeaRepository: { create: ideaCreate, countActive: ideaCountActive },
}));

const postSystemMessage = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/idea-chat.repository", () => ({
  IdeaChatRepository: { postSystemMessage },
}));

const getOrCreate = vi.fn();
const checkAndIncrement = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/autonomy-policy.repository", () => ({
  AutonomyPolicyRepository: { getOrCreate, checkAndIncrement },
}));

const { createStrategicIdea } = await import("./strategic-request");

const scope = { workspaceId: "ws-1", projectId: "proj-1", brandId: "brand-1" };

beforeEach(() => {
  vi.clearAllMocks();
  postSystemMessage.mockResolvedValue(undefined);
  checkAndIncrement.mockResolvedValue(undefined);
});

describe("createStrategicIdea", () => {
  it("creates a RAW-status idea and posts a system message into its own thread", async () => {
    getOrCreate.mockResolvedValue({ unlimitedMode: false, maxActiveIdeas: 5 });
    ideaCountActive.mockResolvedValue(1);
    ideaCreate.mockResolvedValue({ id: "idea-1" });

    const result = await createStrategicIdea(scope, {
      title: "Enter the German market",
      description: "Research, positioning and a launch plan for Germany.",
      departments: ["MARKET_RESEARCH", "COPY_CONTENT"] as never,
    });

    expect(result).toEqual({ status: "CREATED", ideaId: "idea-1" });
    expect(ideaCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        projectId: "proj-1",
        brandId: "brand-1",
        title: "Enter the German market",
        description: "Research, positioning and a launch plan for Germany.",
        concept: {
          departmentsInvolved: ["MARKET_RESEARCH", "COPY_CONTENT"],
        },
      }),
    );
    // No explicit `status` is passed — IdeaRepository.create's schema
    // default (RAW) is what lets the existing Council tick pick this idea
    // up; passing a status here would be a landmine, not a feature.
    expect(ideaCreate.mock.calls[0]?.[0]?.status).toBeUndefined();
    expect(checkAndIncrement).toHaveBeenCalledWith(scope, "ideasCreated", 1);
    expect(postSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        projectId: "proj-1",
        ideaId: "idea-1",
        card: expect.objectContaining({
          kind: "idea",
          title: "Enter the German market",
        }),
      }),
    );
  });

  it("omits concept.departmentsInvolved when no departments are given", async () => {
    getOrCreate.mockResolvedValue({ unlimitedMode: false, maxActiveIdeas: 5 });
    ideaCountActive.mockResolvedValue(0);
    ideaCreate.mockResolvedValue({ id: "idea-2" });

    await createStrategicIdea(scope, {
      title: "Plan October",
      description: "A month-long content plan.",
    });

    expect(ideaCreate).toHaveBeenCalledWith(
      expect.objectContaining({ concept: undefined }),
    );
  });

  it("returns CAPPED and creates nothing when the project is at maxActiveIdeas", async () => {
    getOrCreate.mockResolvedValue({ unlimitedMode: false, maxActiveIdeas: 3 });
    ideaCountActive.mockResolvedValue(3);

    const result = await createStrategicIdea(scope, {
      title: "Another big idea",
      description: "…",
    });

    expect(result).toEqual({ status: "CAPPED" });
    expect(ideaCreate).not.toHaveBeenCalled();
    expect(checkAndIncrement).not.toHaveBeenCalled();
    expect(postSystemMessage).not.toHaveBeenCalled();
  });

  it("ignores the cap when unlimitedMode is on", async () => {
    getOrCreate.mockResolvedValue({ unlimitedMode: true, maxActiveIdeas: 1 });
    ideaCountActive.mockResolvedValue(50);
    ideaCreate.mockResolvedValue({ id: "idea-3" });

    const result = await createStrategicIdea(scope, {
      title: "Big idea under unlimited mode",
      description: "…",
    });

    expect(result).toEqual({ status: "CREATED", ideaId: "idea-3" });
  });

  it("still returns CREATED when posting the system message fails", async () => {
    getOrCreate.mockResolvedValue({ unlimitedMode: false, maxActiveIdeas: 5 });
    ideaCountActive.mockResolvedValue(0);
    ideaCreate.mockResolvedValue({ id: "idea-4" });
    postSystemMessage.mockRejectedValue(new Error("db blip"));

    const result = await createStrategicIdea(scope, {
      title: "Resilient to chat-post failure",
      description: "…",
    });

    expect(result).toEqual({ status: "CREATED", ideaId: "idea-4" });
  });

  it("still returns CREATED when the checkAndIncrement side-effect fails", async () => {
    getOrCreate.mockResolvedValue({ unlimitedMode: false, maxActiveIdeas: 5 });
    ideaCountActive.mockResolvedValue(0);
    ideaCreate.mockResolvedValue({ id: "idea-5" });
    checkAndIncrement.mockRejectedValue(new Error("budget row locked"));

    const result = await createStrategicIdea(scope, {
      title: "Resilient to increment failure",
      description: "…",
    });

    expect(result).toEqual({ status: "CREATED", ideaId: "idea-5" });
  });
});
