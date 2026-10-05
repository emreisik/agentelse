import { beforeEach, describe, expect, it, vi } from "vitest";

// Revising a creative from the Studio or the chat card must lay the post out
// with the layout it already has. An edit re-composes an image that ALREADY
// carries its logo and band, so a different layout would stack a second logo /
// band on top of the first.

const prismaMock = vi.hoisted(() => ({
  creative: { findUniqueOrThrow: vi.fn() },
  asset: { findUnique: vi.fn(), create: vi.fn() },
  task: { findUnique: vi.fn() },
  brand: { findUnique: vi.fn() },
  brandDossier: { findUnique: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: vi.fn().mockResolvedValue({ userId: "u1" }),
  requireProjectAccess: vi.fn().mockResolvedValue(undefined),
}));
const addVersion = vi.hoisted(() => vi.fn());
vi.mock("@/server/repositories/creative.repository", () => ({
  CreativeRepository: { addVersion, transition: vi.fn() },
}));
vi.mock("@/server/repositories/approval.repository", () => ({
  ApprovalRepository: { create: vi.fn() },
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: vi.fn() },
}));
vi.mock("@/server/repositories/idea-chat.repository", () => ({
  IdeaChatRepository: {
    resolveIdeaIdForTask: vi.fn(),
    postSystemMessage: vi.fn(),
  },
}));
const generateCreativeImage = vi.hoisted(() => vi.fn());
vi.mock("@/server/media/creative-image", () => ({ generateCreativeImage }));
const applyBrandTemplate = vi.hoisted(() => vi.fn());
vi.mock("@/server/media/creative-template", () => ({ applyBrandTemplate }));
vi.mock("@/server/media/brand-logo", () => ({
  loadReferenceImage: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/server/agency/constitution/constitution-service", () => ({
  ConstitutionService: { getBrandContext: vi.fn().mockResolvedValue({}) },
}));
const resolveBrandStyleContext = vi.hoisted(() => vi.fn());
vi.mock("@/server/media/brand-style-context", () => ({
  resolveBrandStyleContext,
}));
vi.mock("@/server/storage/asset-storage", () => ({
  readAsset: vi.fn().mockResolvedValue(Buffer.from("png")),
}));

const { DEFAULT_KIT_TEMPLATE } = await import("@/lib/brand-kit");
const { buildPresetLayouts } = await import("@/lib/layout-templates");
const { performCreativeRevision } = await import("./creative-actions");

const FEED = { width: 1080, height: 1440 };

const style = (withLayouts: boolean) => ({
  logoAssetId: "logo-light",
  darkLogoAssetId: null,
  legacyApprovedColors: null,
  legacyVisualGuidelines: null,
  visualIdentity: {
    primaryColors: [{ hex: "#0b1f3a" }],
    secondaryColors: [{ hex: "#0d9488" }],
    accentColors: [{ hex: "#2dd4bf" }],
    photographyStyle: null,
    styleRefinement: null,
    moodTags: [],
    compositionNotes: null,
    backgroundTone: null,
    alwaysInclude: [],
    alwaysAvoid: [],
    referenceImageAssetId: null,
    layoutTemplates: withLayouts ? buildPresetLayouts(DEFAULT_KIT_TEMPLATE) : null,
    template: { ...DEFAULT_KIT_TEMPLATE },
  },
});

function creativeWith(generationMetadata: unknown) {
  return {
    id: "cr1",
    workspaceId: "w",
    projectId: "p",
    brandId: "b",
    platform: "INSTAGRAM",
    status: "IN_REVIEW",
    title: "Post",
    brief: "brief",
    createdByTaskId: null,
    versions: [
      {
        version: 1,
        assetId: "asset-1",
        caption: "cap",
        copy: "copy",
        generationMetadata,
      },
    ],
  };
}

const madeWith = (id: string) => ({
  layoutTemplate: { id, name: id },
  targetWidth: FEED.width,
  targetHeight: FEED.height,
});

const templateArgs = () =>
  applyBrandTemplate.mock.calls[0]![0] as {
    template: Record<string, unknown> | undefined;
    safeZone: unknown;
    trimLogo: boolean;
    text?: Record<string, unknown>;
  };
const versionMetadata = () =>
  (addVersion.mock.calls[0]![2] as { generationMetadata: Record<string, unknown> })
    .generationMetadata;

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.asset.findUnique.mockResolvedValue({
    storageKey: "k",
    mimeType: "image/png",
  });
  prismaMock.asset.create.mockResolvedValue({
    id: "asset-2",
    mimeType: "image/png",
    width: 1080,
    height: 1440,
  });
  generateCreativeImage.mockResolvedValue({
    storageKey: "r2://x.png",
    filename: "x.png",
    mimeType: "image/png",
    size: 1,
    provider: "openai",
    width: 1080,
    height: 1440,
  });
  applyBrandTemplate.mockResolvedValue(null);
  addVersion.mockResolvedValue({ version: 2 });
  resolveBrandStyleContext.mockResolvedValue(style(true));
});

const revise = (
  mode: "edit" | "new",
  previous: unknown,
  extra: { layoutId?: string; contentFormat?: "STORY" } = {},
) => {
  prismaMock.creative.findUniqueOrThrow.mockResolvedValue(creativeWith(previous));
  return performCreativeRevision({
    creativeId: "cr1",
    instruction: "warmer light",
    mode,
    userId: "u1",
    ...extra,
  });
};

describe("performCreativeRevision with post layouts", () => {
  it("edit: re-composes with the layout the image already carries", async () => {
    const result = await revise("edit", madeWith("bottom-band"));
    expect(result).toEqual({ ok: true });

    expect(templateArgs().template).toMatchObject({
      logoOnBar: true,
      accentBarHeightPercent: 13,
    });
    expect(templateArgs().trimLogo).toBe(true);
    expect(versionMetadata().layoutTemplate).toEqual({
      id: "bottom-band",
      name: "Brand band",
    });
  });

  it("edit: an image made before layouts existed is composed exactly as before", async () => {
    await revise("edit", { prompt: "old" });

    // The brand's base template, not the brand's default layout on top of it.
    expect(templateArgs().template).toEqual(DEFAULT_KIT_TEMPLATE);
    expect(templateArgs().safeZone).toBeUndefined();
    expect(templateArgs().trimLogo).toBe(false);
    expect(versionMetadata().layoutTemplate).toBeNull();
  });

  it("edit: a Studio pick is ignored, the pixels being edited decide", async () => {
    await revise("edit", madeWith("bottom-band"), { layoutId: "headline-top" });
    expect(versionMetadata().layoutTemplate).toMatchObject({ id: "bottom-band" });
  });

  it("new: regenerating keeps the layout, tells the image model what to leave clear", async () => {
    await revise("new", madeWith("bottom-band"));

    const prompt = generateCreativeImage.mock.calls[0]![0] as string;
    expect(prompt).toContain("bottom 13% of the frame");
    expect(prompt).toContain("bottom part of the frame stays plain");
    expect(versionMetadata().layoutTemplate).toMatchObject({ id: "bottom-band" });
  });

  it("new: the Studio picker switches the layout", async () => {
    await revise("new", madeWith("bottom-band"), { layoutId: "headline-top" });
    expect(versionMetadata().layoutTemplate).toMatchObject({ id: "headline-top" });
  });

  it("new: switching to a Story brings the layout made for it and the platform safe zone", async () => {
    await revise("new", madeWith("bottom-band"), { contentFormat: "STORY" });

    expect(versionMetadata().layoutTemplate).toMatchObject({ id: "story-full" });
    expect(templateArgs().safeZone).toEqual({ top: 13, bottom: 17.7 });
  });

  it("new: a regenerate sets the post's words again in the layout's headline zone", async () => {
    const words = { headline: "Yeni sezon başladı", lines: ["Şimdi keşfet"] };
    prismaMock.brandDossier.findUnique.mockResolvedValue({
      approvedFonts: ["Playfair Display"],
    });
    applyBrandTemplate.mockResolvedValue({ size: 2, textDrawn: true });
    await revise("new", { ...madeWith("headline-top"), onImageText: words });

    expect(templateArgs().text).toMatchObject({
      ...words,
      placement: { zone: "TOP" },
      fontFamily: "Playfair Display",
      darkInk: "#0b1f3a",
      accentHex: "#2dd4bf",
    });
    // Recorded again, so the next regenerate keeps them too.
    expect(versionMetadata().onImageText).toEqual(words);
  });

  it("edit: words already baked into the pixels are not set a second time", async () => {
    await revise("edit", {
      ...madeWith("headline-top"),
      onImageText: { headline: "Yeni sezon" },
    });
    expect(templateArgs().text).toBeUndefined();
    expect(versionMetadata().onImageText).toBeUndefined();
  });

  it("brands without saved layouts revise exactly as before", async () => {
    resolveBrandStyleContext.mockResolvedValue(style(false));
    await revise("new", { prompt: "old" });

    expect(templateArgs().template).toEqual(DEFAULT_KIT_TEMPLATE);
    expect(templateArgs().safeZone).toBeUndefined();
    expect(versionMetadata().layoutTemplate).toBeNull();
  });
});
