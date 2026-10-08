import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

// "Regenerate" on a post made from the brand's own photo cuts that photo again
// (to the new format if it changed): it never replaces the real photo with an
// AI picture. An edit is the person asking the model to change the pixels, and
// stays as it was.

const prismaMock = vi.hoisted(() => ({
  creative: { findUniqueOrThrow: vi.fn() },
  asset: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  brandMedia: { findUnique: vi.fn() },
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
  IdeaChatRepository: { resolveIdeaIdForTask: vi.fn(), postSystemMessage: vi.fn() },
}));
const generateCreativeImage = vi.hoisted(() => vi.fn());
vi.mock("@/server/media/creative-image", () => ({ generateCreativeImage }));
const applyBrandTemplate = vi.hoisted(() => vi.fn());
vi.mock("@/server/media/creative-template", () => ({ applyBrandTemplate }));
const directImage = vi.hoisted(() => vi.fn());
vi.mock("@/server/media/art-director", () => ({ directImage }));
vi.mock("@/server/media/brand-logo", () => ({
  loadReferenceImage: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/server/agency/constitution/constitution-service", () => ({
  ConstitutionService: { getBrandContext: vi.fn().mockResolvedValue({}) },
}));
const resolveBrandStyleContext = vi.hoisted(() => vi.fn());
vi.mock("@/server/media/brand-style-context", () => ({ resolveBrandStyleContext }));
const storage = vi.hoisted(() => ({
  readAsset: vi.fn(),
  putAsset: vi.fn(),
  overwriteAsset: vi.fn(),
}));
vi.mock("@/server/storage/asset-storage", () => storage);

const { performCreativeRevision } = await import("./creative-actions");

const metadata = { photoSource: { assetId: "photo-1", fit: "cover" } };

beforeEach(async () => {
  vi.clearAllMocks();
  const photo = await sharp({
    create: { width: 1600, height: 1200, channels: 3, background: "#806040" },
  })
    .jpeg()
    .toBuffer();
  storage.readAsset.mockResolvedValue(photo);
  storage.putAsset.mockResolvedValue({ storageKey: "r2://cut.jpg", filename: "cut.jpg" });
  prismaMock.asset.findFirst.mockResolvedValue({ id: "photo-1", storageKey: "r2://orig.jpg" });
  prismaMock.asset.findUnique.mockResolvedValue({ storageKey: "k", mimeType: "image/png" });
  prismaMock.asset.create.mockResolvedValue({ id: "asset-2", mimeType: "image/jpeg", width: 1080, height: 1440 });
  prismaMock.brandMedia.findUnique.mockResolvedValue({ focalX: 0.5, focalY: 0.5, description: null });
  prismaMock.brandDossier.findUnique.mockResolvedValue(null);
  applyBrandTemplate.mockResolvedValue(null);
  addVersion.mockResolvedValue({ version: 2 });
  directImage.mockResolvedValue(null);
  generateCreativeImage.mockResolvedValue({
    storageKey: "r2://ai.png", filename: "ai.png", mimeType: "image/png",
    size: 1, provider: "openai", width: 1080, height: 1440,
  });
  resolveBrandStyleContext.mockResolvedValue({
    logoAssetId: null, darkLogoAssetId: null,
    legacyApprovedColors: null, legacyVisualGuidelines: null,
    visualIdentity: null,
  });
});

function revise(mode: "new" | "edit", generationMetadata: unknown, contentFormat?: "STORY") {
  prismaMock.creative.findUniqueOrThrow.mockResolvedValue({
    id: "cr1", workspaceId: "w", projectId: "p", brandId: "b",
    platform: "INSTAGRAM", status: "IN_REVIEW", title: "Post", brief: "brief",
    createdByTaskId: null,
    versions: [{ version: 1, assetId: "asset-1", caption: "c", copy: "x", generationMetadata }],
  });
  return performCreativeRevision({
    creativeId: "cr1", instruction: "", mode, userId: "u1", contentFormat,
  });
}

describe("regenerating a post made from the brand's own photo", () => {
  it("cuts the photo again with no image model and no art director", async () => {
    expect(await revise("new", metadata)).toEqual({ ok: true });
    expect(generateCreativeImage).not.toHaveBeenCalled();
    expect(directImage).not.toHaveBeenCalled();
    expect(storage.overwriteAsset).not.toHaveBeenCalled();
    const saved = addVersion.mock.calls[0]![2] as {
      generationMetadata: { photoSource?: { assetId: string }; targetHeight: number };
    };
    expect(saved.generationMetadata.photoSource?.assetId).toBe("photo-1");
  });

  it("follows a format change: the same photo, cut to a Story", async () => {
    await revise("new", metadata, "STORY");
    const saved = addVersion.mock.calls[0]![2] as {
      generationMetadata: { photoSource?: { fit: string }; targetHeight: number };
    };
    expect(saved.generationMetadata.targetHeight).toBe(1920);
    // A landscape photo on a Story is shown whole over a blurred copy.
    expect(saved.generationMetadata.photoSource?.fit).toBe("extend");
  });

  it("looks the photo up inside the post's own project", async () => {
    await revise("new", metadata);
    expect(prismaMock.asset.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "photo-1", projectId: "p", type: "IMAGE" },
      }),
    );
  });

  it("an edit still goes to the image model, as the person asked", async () => {
    await revise("edit", metadata);
    expect(generateCreativeImage).toHaveBeenCalledTimes(1);
  });

  it("a post without a photo is regenerated as before", async () => {
    await revise("new", { prompt: "old" });
    expect(generateCreativeImage).toHaveBeenCalledTimes(1);
  });
});
