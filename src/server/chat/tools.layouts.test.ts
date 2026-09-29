import { beforeEach, describe, expect, it, vi } from "vitest";

// How the chat agent works with the brand's saved post layouts: it can read
// them (get_visual_identity), pick one for generate_image, and the reply is
// told which layout the finished image really used.

const prismaMock = vi.hoisted(() => ({
  executionJob: { findFirst: vi.fn(), findUnique: vi.fn() },
  task: { findUnique: vi.fn() },
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
const startExecution = vi.hoisted(() => vi.fn());
vi.mock("@/server/execution/execution-service", () => ({
  ExecutionService: { startExecution },
}));
// The turn drives its own job, so it takes the job's dispatch event first.
vi.mock("@/server/repositories/outbox.repository", () => ({
  OutboxRepository: {
    claimDispatchForInline: vi.fn().mockResolvedValue("claimed"),
  },
}));
const resolveBrandStyleContext = vi.hoisted(() => vi.fn());
vi.mock("@/server/media/brand-style-context", () => ({
  resolveBrandStyleContext,
}));

const { DEFAULT_KIT_TEMPLATE } = await import("@/lib/brand-kit");
const { buildPresetLayouts } = await import("@/lib/layout-templates");
const { layoutsForChat, toolsForPhase } = await import("./tools");

const layouts = buildPresetLayouts(DEFAULT_KIT_TEMPLATE);
const tool = (name: string) =>
  toolsForPhase("ACTIVE").find((candidate) => candidate.name === name)!;

const ctx = {
  workspaceId: "w",
  projectId: "p",
  brandId: "b",
  userId: "u",
  commandId: "c",
  message: "make a post",
  setupPhase: "ACTIVE" as const,
  emit: vi.fn(),
};

describe("layoutsForChat", () => {
  it("is null for a brand without saved layouts", () => {
    expect(layoutsForChat(null)).toBeNull();
    expect(layoutsForChat(undefined)).toBeNull();
  });

  it("describes each layout by what the model needs to choose, not by geometry", () => {
    const view = layoutsForChat(layouts)!;
    expect(view.defaultId).toBe(layouts.defaultId);
    expect(view.items.map((item) => item.id)).toEqual(
      layouts.items.map((item) => item.id),
    );

    const band = view.items.find((item) => item.id === "bottom-band")!;
    expect(band).toMatchObject({
      name: "Brand band",
      headline: true,
      summary: expect.stringContaining("brand band bottom"),
    });
    expect(JSON.stringify(view)).not.toContain("sizePercent");

    // Each layout says which formats it suits; an empty list means every one.
    expect(view.items.some((item) => Array.isArray(item.formats))).toBe(true);
    const anyFormat = layoutsForChat({
      ...layouts,
      items: layouts.items.map((item) => ({ ...item, formats: [] })),
    })!;
    expect(anyFormat.items.every((item) => item.formats === "any")).toBe(true);
    expect(view.note).toContain("layoutId");
  });

  it("marks a layout without a headline so text is never planned onto it", () => {
    const view = layoutsForChat(layouts)!;
    expect(view.items.find((item) => item.id === "minimal-corner")!.headline).toBe(
      false,
    );
  });
});

describe("get_visual_identity", () => {
  beforeEach(() => vi.clearAllMocks());

  const identity = (layoutTemplates: typeof layouts | null) => ({
    logoAssetId: null,
    darkLogoAssetId: "logo-dark",
    approvedColors: null,
    visualIdentity: {
      primaryColors: [{ hex: "#0b1f3a" }],
      secondaryColors: [],
      accentColors: [{ hex: "#2dd4bf" }],
      photographyStyle: null,
      styleRefinement: null,
      moodTags: [],
      compositionNotes: null,
      backgroundTone: null,
      alwaysInclude: [],
      alwaysAvoid: [],
      referenceImageAssetId: null,
      layoutTemplates,
      template: { ...DEFAULT_KIT_TEMPLATE },
    },
  });

  it("lists the layouts and counts a dark-only logo as a logo", async () => {
    resolveBrandStyleContext.mockResolvedValue(identity(layouts));
    const { result } = await tool("get_visual_identity").execute({}, ctx);
    expect(result).toMatchObject({
      hasLogo: true,
      layouts: { defaultId: layouts.defaultId },
    });
  });

  it("reports no layouts when the brand has none", async () => {
    resolveBrandStyleContext.mockResolvedValue(identity(null));
    const { result } = await tool("get_visual_identity").execute({}, ctx);
    expect(result).toMatchObject({ layouts: null });
  });
});

describe("generate_image with layouts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    submit.mockResolvedValue({
      status: "PLANNED",
      commandId: "c",
      taskId: "task-1",
      dispatched: true,
      requiresApproval: false,
    });
    prismaMock.executionJob.findFirst.mockResolvedValue({ id: "job-1" });
    prismaMock.task.findUnique.mockResolvedValue({ riskLevel: "LOW" });
    startExecution.mockResolvedValue({ status: "COMPLETED", errorMessage: null });
  });

  const run = (extra: Record<string, unknown> = {}) => {
    const generate = tool("generate_image");
    return generate.execute(
      generate.schema.parse({
        imagePrompt: "A calm clinic reception",
        caption: "Caption",
        copy: "Copy",
        platform: "INSTAGRAM",
        contentFormat: "FEED_PORTRAIT",
        ...extra,
      }),
      ctx,
    );
  };

  const presetSent = () =>
    (submit.mock.calls[0]![0] as { payloadExtra: { preset: Record<string, unknown> } })
      .payloadExtra.preset;

  it("offers layoutId in the tool schema", () => {
    const schema = tool("generate_image").schema.parse({
      imagePrompt: "x",
      caption: "c",
      copy: "c",
      layoutId: "bottom-band",
    });
    expect(schema).toMatchObject({ layoutId: "bottom-band" });
  });

  it("passes the chosen layout to the provider, trimmed", async () => {
    prismaMock.executionJob.findUnique.mockResolvedValue({
      rawResult: { layoutTemplate: { id: "bottom-band", name: "Brand band" } },
    });
    await run({ layoutId: "  bottom-band " });
    expect(presetSent().layoutId).toBe("bottom-band");
  });

  it("sends no layout when none is chosen or the id is blank", async () => {
    prismaMock.executionJob.findUnique.mockResolvedValue({ rawResult: {} });
    await run({ layoutId: "   " });
    expect(presetSent().layoutId).toBeUndefined();
  });

  it("tells the reply which layout the finished image used", async () => {
    prismaMock.executionJob.findUnique.mockResolvedValue({
      rawResult: { layoutTemplate: { id: "bottom-band", name: "Brand band" } },
    });
    const { result } = await run({ layoutId: "bottom-band" });
    expect(result).toMatchObject({
      outcome: "image_ready",
      layout: { id: "bottom-band", name: "Brand band" },
    });
    expect((result as { note: string }).note).toContain('"Brand band" layout');
    expect((result as { note: string }).note).not.toContain("does not exist");
  });

  it("says so when the requested layout did not exist and the default was used", async () => {
    prismaMock.executionJob.findUnique.mockResolvedValue({
      rawResult: { layoutTemplate: { id: "classic", name: "Classic" } },
    });
    const { result } = await run({ layoutId: "made-up" });
    expect((result as { note: string }).note).toContain(
      'does not exist for this brand, so its "Classic" layout was used',
    );
  });

  it("stays silent about layouts for brands that have none", async () => {
    prismaMock.executionJob.findUnique.mockResolvedValue({
      rawResult: { layoutTemplate: null },
    });
    const { result } = await run();
    expect(result).toMatchObject({ outcome: "image_ready", layout: null });
    expect((result as { note: string }).note).not.toContain("layout");
  });

  it("a failed read of the layout never turns a finished image into an error", async () => {
    prismaMock.executionJob.findUnique.mockRejectedValue(new Error("db blip"));
    const outcome = await run({ layoutId: "bottom-band" });
    expect(outcome.status).toBe("PLANNED");
    expect(outcome.result).toMatchObject({ outcome: "image_ready", layout: null });
  });
});
