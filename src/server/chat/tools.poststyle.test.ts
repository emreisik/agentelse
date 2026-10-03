import { beforeEach, describe, expect, it, vi } from "vitest";

// How the chat agent works with the brand's Post Style Kit: it reads it
// (get_visual_identity), saves the pictures a client attaches as examples
// (save_style_reference), and a Work's generate_image passes the kit's extras on.

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/server/agency/journey/continuation", () => ({
  loadPlanContinuation: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/server/integrations/channel-connections", () => ({
  getChannelConnections: vi.fn(),
}));
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
vi.mock("@/server/commands/strategic-request", () => ({ saveIdea: vi.fn() }));
const remember = vi.hoisted(() => vi.fn());
vi.mock("@/server/memory/memory-service", () => ({
  MemoryService: { remember },
}));
vi.mock("@/server/work-session/work-session-service", () => ({
  WorkSessionService: { start: vi.fn(), update: vi.fn() },
}));
const slotFirstImage = vi.hoisted(() => vi.fn());
vi.mock("./slot-first", () => ({ slotFirstText: vi.fn(), slotFirstImage }));
vi.mock("./content-plan", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./content-plan")>()),
  getProjectTimezone: vi.fn().mockResolvedValue("Europe/Istanbul"),
  supersedeOpenDrafts: vi.fn(),
}));

const resolveBrandStyleContext = vi.hoisted(() => vi.fn());
vi.mock("@/server/media/brand-style-context", () => ({ resolveBrandStyleContext }));
const addExampleFromAsset = vi.hoisted(() => vi.fn());
const ensureVisualIdentityRow = vi.hoisted(() => vi.fn());
vi.mock("@/server/brand/post-style-service", () => ({
  addExampleFromAsset,
  ensureVisualIdentityRow,
}));
const loadPostStyle = vi.hoisted(() => vi.fn());
const saveDirectives = vi.hoisted(() => vi.fn());
vi.mock("@/server/brand/post-style-store", () => ({ loadPostStyle, saveDirectives }));

const { toolsForPhase } = await import("./tools");

const defaultTool = (name: string) =>
  toolsForPhase("ACTIVE").find((candidate) => candidate.name === name)!;
const worksTool = (name: string) =>
  toolsForPhase("ACTIVE", { works: true }).find((candidate) => candidate.name === name)!;

const attachment = (
  assetId: string,
  filename: string,
  mimeType = "image/png",
) => ({ assetId, filename, mimeType, size: 1000 });

const ctx = (over: Record<string, unknown> = {}) => ({
  workspaceId: "ws",
  projectId: "p1",
  brandId: "b1",
  userId: "u1",
  commandId: "c1",
  message: "design my posts like this",
  phase: "ACTIVE" as const,
  emit: vi.fn(),
  ...over,
});

const analysis = {
  summary: "Dark premium product ad",
  layout: "",
  typography: "",
  colors: "",
  product: "",
  graphics: "",
  background: "",
  mood: "",
  recipe: "Recipe.",
};

beforeEach(() => {
  vi.clearAllMocks();
  addExampleFromAsset.mockResolvedValue({ ok: true, assetId: "x", analyzed: true });
  loadPostStyle.mockResolvedValue({
    directives: { text: "", fidelity: "match" },
    examples: [],
  });
  remember.mockResolvedValue({ status: "CREATED", superseded: 0 });
});

describe("get_visual_identity and the kit", () => {
  const identity = (postStyle: unknown) => ({
    logoAssetId: null,
    darkLogoAssetId: null,
    approvedColors: null,
    visualIdentity: {
      primaryColors: [],
      secondaryColors: [],
      accentColors: [],
      photographyStyle: null,
      styleRefinement: null,
      moodTags: [],
      compositionNotes: null,
      backgroundTone: null,
      alwaysInclude: [],
      alwaysAvoid: [],
      referenceImageAssetId: null,
      ...(postStyle ? { postStyle } : {}),
      template: {
        enabled: true,
        logoPosition: "BOTTOM_RIGHT",
        accentBarEnabled: false,
        accentBarPosition: "BOTTOM",
      },
    },
  });

  it("tells the agent what the kit holds: ids to pick from, a one-line digest each, and what to leave to it", async () => {
    resolveBrandStyleContext.mockResolvedValue(
      identity({
        fidelity: "match",
        directives: "Always product-focused.",
        examples: [
          { assetId: "ex-1", label: "Auction ad", analysis },
          { assetId: "ex-2", label: "Plain", analysis: null },
        ],
      }),
    );
    const { result } = await defaultTool("get_visual_identity").execute({}, ctx());
    expect(result).toMatchObject({
      postStyle: {
        fidelity: "match",
        directives: "Always product-focused.",
        examples: [
          { id: "ex-1", label: "Auction ad", summary: "Dark premium product ad" },
          { id: "ex-2", label: "Plain", summary: "Plain" },
        ],
      },
    });
    expect((result as { postStyle: { note: string } }).postStyle.note).toContain(
      "Do not describe another look in imagePrompt",
    );
  });

  it("has no postStyle for a brand without a kit", async () => {
    resolveBrandStyleContext.mockResolvedValue(identity(null));
    const { result } = await defaultTool("get_visual_identity").execute({}, ctx());
    expect(result).not.toHaveProperty("postStyle");
  });
});

describe("save_style_reference", () => {
  const run = (args: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    defaultTool("save_style_reference").execute(args as never, ctx(over));

  it("is a note tool the injection guard refuses in a tainted turn", () => {
    const tool = defaultTool("save_style_reference");
    expect(tool.kind).toBe("note");
    expect(tool.sensitive).toBe(true);
  });

  it("saves the pictures attached to this message as examples of the brand, named after their file", async () => {
    const outcome = await run(
      {},
      {
        attachments: [
          attachment("a1", "iphone-ad.png"),
          attachment("a2", "second.jpg", "image/jpeg"),
          attachment("doc", "brief.pdf", "application/pdf"),
        ],
      },
    );
    expect(addExampleFromAsset).toHaveBeenCalledTimes(2);
    expect(addExampleFromAsset.mock.calls[0]![0]).toEqual({
      scope: { workspaceId: "ws", projectId: "p1", brandId: "b1" },
      assetId: "a1",
      label: "iphone-ad",
      source: "chat",
    });
    expect(outcome.result).toMatchObject({
      outcome: "saved",
      examplesSaved: 2,
      examplesAnalysed: 2,
      failed: [],
      instructionSaved: false,
    });
    expect((outcome.result as { note: string }).note).toContain("Post style");
  });

  it("at most four pictures a message, and a failure is reported with its reason", async () => {
    addExampleFromAsset
      .mockResolvedValueOnce({ ok: true, assetId: "a1", analyzed: false })
      .mockResolvedValueOnce({ ok: false, reason: "That picture isn't available." });
    const many = Array.from({ length: 6 }, (_, i) => attachment(`a${i}`, `p${i}.png`));
    const outcome = await run({ label: "Series" }, { attachments: many });
    expect(addExampleFromAsset).toHaveBeenCalledTimes(4);
    expect(addExampleFromAsset.mock.calls[0]![0].label).toBe("Series");
    expect(outcome.result).toMatchObject({
      examplesSaved: 3,
      examplesAnalysed: 2,
      failed: [{ filename: "p1.png", reason: "That picture isn't available." }],
    });
  });

  it("the client's design rule joins the standing instructions and the brand memory, in their words", async () => {
    loadPostStyle.mockResolvedValue({
      directives: { text: "Always dark.", fidelity: "match" },
      examples: [],
    });
    const outcome = await run(
      { instruction: "  Designs are   product-focused:\nthe real product is the hero. " },
      { attachments: [attachment("a1", "ad.png")] },
    );
    expect(ensureVisualIdentityRow).toHaveBeenCalledTimes(1);
    expect(saveDirectives).toHaveBeenCalledWith(
      { workspaceId: "ws", projectId: "p1", brandId: "b1" },
      {
        text: "Always dark.\nDesigns are product-focused: the real product is the hero.",
        fidelity: "match",
      },
    );
    expect(remember).toHaveBeenCalledTimes(1);
    expect(remember.mock.calls[0]![0]).toMatchObject({
      insight: "Designs are product-focused: the real product is the hero.",
      polarity: "WORKS",
      source: "USER_EXPLICIT",
    });
    expect(outcome.result).toMatchObject({ instructionSaved: true });
  });

  it("a rule that is already in the instructions is not added twice", async () => {
    loadPostStyle.mockResolvedValue({
      directives: { text: "Designs are product-focused.", fidelity: "match" },
      examples: [],
    });
    await run({ instruction: "designs are product-focused." });
    expect(saveDirectives.mock.calls[0]![1].text).toBe("Designs are product-focused.");
  });

  it("keeps the fidelity the client chose, and the one it had when they chose none", async () => {
    loadPostStyle.mockResolvedValue({
      directives: { text: "x", fidelity: "inspired" },
      examples: [],
    });
    await run({ fidelity: "match" }, { attachments: [attachment("a1", "ad.png")] });
    expect(saveDirectives.mock.calls[0]![1].fidelity).toBe("match");
    saveDirectives.mockClear();
    await run({ instruction: "Always dark." });
    expect(saveDirectives.mock.calls[0]![1].fidelity).toBe("inspired");
  });

  it("full instructions are never overwritten: the client is told where to shorten them", async () => {
    loadPostStyle.mockResolvedValue({
      directives: { text: "x".repeat(1990), fidelity: "match" },
      examples: [],
    });
    const outcome = await run({ instruction: "This will not fit in what is left." });
    expect(saveDirectives).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
    expect(outcome.result).toMatchObject({
      instructionSaved: false,
      outcome: "not_saved",
      instructionNote: expect.stringContaining("Brand Brain"),
    });
  });

  it("a turn saves only a few memories, like remember_preference", async () => {
    const tired = ctx({ memoryWrites: 3 });
    await defaultTool("save_style_reference").execute(
      { instruction: "Always dark." } as never,
      tired,
    );
    expect(saveDirectives).toHaveBeenCalledTimes(1);
    expect(remember).not.toHaveBeenCalled();
  });

  it("with nothing attached and no rule it does nothing and tells the model to ask for the picture", async () => {
    const outcome = await run({}, { attachments: [attachment("doc", "a.pdf", "application/pdf")] });
    expect(outcome).toMatchObject({
      nothingDone: true,
      result: { outcome: "nothing_to_save" },
    });
    expect(addExampleFromAsset).not.toHaveBeenCalled();
    expect(saveDirectives).not.toHaveBeenCalled();
  });
});

describe("a Work's generate_image", () => {
  const work = { id: "w1", title: "Chat", status: "ACTIVE", channels: ["instagram"] };
  const args = {
    imagePrompt: "iPhone 16 Pro Max",
    caption: "c",
    copy: "d",
    contentFormat: "FEED_PORTRAIT",
  };

  beforeEach(() => {
    slotFirstImage.mockResolvedValue({ result: { outcome: "slot_planned" } });
  });

  it("passes the kit's extras on to the planned slot: the examples, the product photos of THIS message, the other texts", async () => {
    await worksTool("generate_image").execute(
      {
        ...args,
        headline: "iPhone 16 Pro Max",
        styleExampleIds: ["ex-1"],
        usePhotosFromThisMessage: true,
        onImageText: ["Başlangıç 1 TL", "Teklif ver"],
      } as never,
      ctx({
        work,
        attachments: [
          attachment("prod-1", "iphone.jpg", "image/jpeg"),
          attachment("doc", "brief.pdf", "application/pdf"),
        ],
      }) as never,
    );
    const passed = slotFirstImage.mock.calls[0]![0];
    expect(passed).toMatchObject({
      imagePrompt: "iPhone 16 Pro Max",
      headline: "iPhone 16 Pro Max",
      styleExampleIds: ["ex-1"],
      productAssetIds: ["prod-1"],
      onImageText: ["Başlangıç 1 TL", "Teklif ver"],
    });
  });

  it("without the flag no attachment becomes a product picture", async () => {
    await worksTool("generate_image").execute(
      args as never,
      ctx({ work, attachments: [attachment("prod-1", "iphone.jpg")] }) as never,
    );
    const passed = slotFirstImage.mock.calls[0]![0];
    expect(passed.productAssetIds).toBeUndefined();
    expect(passed.styleExampleIds).toBeUndefined();
  });

  it("at most three product pictures", async () => {
    await worksTool("generate_image").execute(
      { ...args, usePhotosFromThisMessage: true } as never,
      ctx({
        work,
        attachments: ["a", "b", "c", "d"].map((id) => attachment(id, `${id}.png`)),
      }) as never,
    );
    expect(slotFirstImage.mock.calls[0]![0].productAssetIds).toEqual(["a", "b", "c"]);
  });
});
