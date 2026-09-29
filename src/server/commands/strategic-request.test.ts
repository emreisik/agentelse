import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deep Path bridge (docs/brand-workspace-migration.md §7 Phase 8): a
// chat-classified "strategic" request must respect the SAME maxActiveIdeas
// cap an autonomously-generated idea does (mirrors idea-foundry.ts's
// generateForOpportunity gate), and must create the idea at RAW status so
// the existing Council/Director tick pipeline can pick it up — no new
// orchestration code involved.

const ideaCreate = vi.fn();
const ideaCountActive = vi.fn();
const promoteToShortlist = vi.fn();
vi.mock("@/server/repositories/idea.repository", () => ({
  IdeaRepository: {
    create: ideaCreate,
    countActive: ideaCountActive,
    promoteToShortlist,
  },
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

const { createStrategicIdea, saveIdea } = await import("./strategic-request");

const scope = { workspaceId: "ws-1", projectId: "proj-1", brandId: "brand-1" };

beforeEach(() => {
  vi.clearAllMocks();
  postSystemMessage.mockResolvedValue(undefined);
  checkAndIncrement.mockResolvedValue(undefined);
  promoteToShortlist.mockResolvedValue("SHORTLISTED");
  delete process.env.LEGACY_AGENCY_LOOP;
});

afterEach(() => {
  vi.unstubAllEnvs();
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

describe("saveIdea", () => {
  it("records the idea with its lens and announces it as saved, not as a project", async () => {
    getOrCreate.mockResolvedValue({ unlimitedMode: false, maxActiveIdeas: 5 });
    ideaCountActive.mockResolvedValue(0);
    ideaCreate.mockResolvedValue({ id: "idea-9" });

    const result = await saveIdea(scope, {
      title: "Autumn recipe series",
      description: "Weekly seasonal recipes shot in the customer's kitchen.",
      lens: "CONTENT",
    });

    expect(result).toEqual({ status: "CREATED", ideaId: "idea-9" });
    expect(ideaCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Autumn recipe series",
        lens: "CONTENT",
        concept: undefined,
      }),
    );
    expect(postSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        ideaId: "idea-9",
        text: expect.stringContaining("Idea saved"),
      }),
    );
  });

  it("respects the same active-ideas cap and creates nothing past it", async () => {
    getOrCreate.mockResolvedValue({ unlimitedMode: false, maxActiveIdeas: 2 });
    ideaCountActive.mockResolvedValue(2);

    const result = await saveIdea(scope, { title: "One more", description: "…" });

    expect(result).toEqual({ status: "CAPPED" });
    expect(ideaCreate).not.toHaveBeenCalled();
  });
});

describe("shortlisting when the Council is off", () => {
  beforeEach(() => {
    getOrCreate.mockResolvedValue({ unlimitedMode: false, maxActiveIdeas: 5 });
    ideaCountActive.mockResolvedValue(0);
    ideaCreate.mockResolvedValue({ id: "idea-7" });
  });

  it("leaves the idea RAW for the Council while the legacy loop is on", async () => {
    await createStrategicIdea(scope, { title: "Big", description: "…" });
    await saveIdea(scope, { title: "Small", description: "…" });

    expect(promoteToShortlist).not.toHaveBeenCalled();
  });

  it.each(["drain", "off"])(
    "shortlists both kinds of idea straight away in %s mode",
    async (mode) => {
      vi.stubEnv("LEGACY_AGENCY_LOOP", mode);

      await createStrategicIdea(scope, { title: "Big", description: "…" });
      await saveIdea(scope, { title: "Small", description: "…" });

      expect(promoteToShortlist).toHaveBeenCalledTimes(2);
      expect(promoteToShortlist).toHaveBeenCalledWith("idea-7", "proj-1");
    },
  );

  it("still creates the idea when the promotion fails", async () => {
    vi.stubEnv("LEGACY_AGENCY_LOOP", "off");
    promoteToShortlist.mockRejectedValue(new Error("db blip"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await saveIdea(scope, { title: "Small", description: "…" });

    expect(result).toEqual({ status: "CREATED", ideaId: "idea-7" });
  });
});
