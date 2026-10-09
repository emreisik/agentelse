import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The revision policy (docs/billing-tasks.md): a post's first picture costs an
// image right, the first revisions of it are free, later ones cost a right again,
// a picture cut from the brand's own photo is never charged; the right is charged
// only when the new picture was stored, and a refusal is worded for the client.

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


// What the allowance gate is asked for, and how the hold is settled.
const allowance = vi.hoisted(() => ({
  begin: vi.fn(),
  finish: vi.fn(),
  meter: { workspaceId: "w" } as never,
}));
vi.mock("@/server/billing/operation", () => ({
  beginOperation: allowance.begin,
}));

const { performCreativeRevision } = await import("./creative-actions");
const { AgentelseError } = await import("@/server/security/errors");

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
  allowance.begin.mockReset();
  allowance.finish.mockReset();
  allowance.begin.mockResolvedValue({
    meter: allowance.meter,
    finish: allowance.finish,
  });
});

function revise(
  version: { version: number; assetId: string | null; generationMetadata?: unknown },
  mode: "new" | "edit" = "new",
) {
  prismaMock.creative.findUniqueOrThrow.mockResolvedValue({
    id: "cr1", workspaceId: "w", projectId: "p", brandId: "b",
    platform: "INSTAGRAM", status: "IN_REVIEW", title: "Post", brief: "brief",
    createdByTaskId: null,
    versions: [{ caption: "c", copy: "x", generationMetadata: {}, ...version }],
  });
  return performCreativeRevision({
    creativeId: "cr1", instruction: "", mode, userId: "u1",
  });
}

const reserved = () =>
  (allowance.begin.mock.calls[0]![0] as { reserve: Record<string, unknown> })
    .reserve;

describe("which revisions cost an image right", () => {
  it("the first two revisions of a post's picture are free", async () => {
    for (const version of [1, 2]) {
      allowance.begin.mockClear();
      await revise({ version, assetId: "asset-1" });
      expect(reserved()).toEqual({});
    }
  });

  it("the third revision costs one image right", async () => {
    expect(await revise({ version: 3, assetId: "asset-1" })).toEqual({ ok: true });
    expect(reserved()).toEqual({ IMAGE: 1 });
    expect(allowance.begin.mock.calls[0]![0]).toMatchObject({
      workspaceId: "w",
      projectId: "p",
      userId: "u1",
      source: "action",
      module: "SOCIAL",
    });
  });

  it("an edit counts like a regenerate", async () => {
    await revise({ version: 3, assetId: "asset-1" }, "edit");
    expect(reserved()).toEqual({ IMAGE: 1 });
  });

  it("the post's FIRST picture is its main image and always costs a right", async () => {
    await revise({ version: 1, assetId: null });
    expect(reserved()).toEqual({ IMAGE: 1 });
  });

  it("a picture cut from the brand's own photo is never charged, however many times", async () => {
    await revise({
      version: 9,
      assetId: "asset-1",
      generationMetadata: { photoSource: { assetId: "photo-1", fit: "cover" } },
    });
    expect(reserved()).toEqual({});
  });

  it("even a free revision needs a valid plan", async () => {
    await revise({ version: 1, assetId: "asset-1" });
    expect(allowance.begin.mock.calls[0]![0]).toMatchObject({
      requireAccess: true,
    });
  });
});

describe("what is charged", () => {
  it("charges the picture once the new version is stored", async () => {
    await revise({ version: 3, assetId: "asset-1" });
    expect(addVersion).toHaveBeenCalledTimes(1);
    expect(allowance.finish).toHaveBeenCalledTimes(1);
    expect(allowance.finish).toHaveBeenCalledWith("delivered");
  });

  it("hands the right back when no picture came out", async () => {
    generateCreativeImage.mockResolvedValue(null);
    const result = await revise({ version: 3, assetId: "asset-1" });
    expect(result).toMatchObject({ ok: false });
    expect(addVersion).not.toHaveBeenCalled();
    expect(allowance.finish).toHaveBeenCalledWith("failed");
  });

  it("hands the right back when the work blows up before the version is stored", async () => {
    generateCreativeImage.mockRejectedValue(new Error("model exploded"));
    const result = await revise({ version: 3, assetId: "asset-1" });
    expect(result).toEqual({ ok: false, message: "model exploded" });
    expect(allowance.finish).toHaveBeenCalledWith("aborted");
  });

  it("draws nothing and charges nothing when the gate refuses", async () => {
    allowance.begin.mockRejectedValue(
      new AgentelseError("QUOTA_EXCEEDED", "Plan allowance used up", {
        meta: { unit: "IMAGE", resetsAt: "2026-11-01T00:00:00.000Z" },
      }),
    );
    const result = await revise({ version: 3, assetId: "asset-1" });
    expect(generateCreativeImage).not.toHaveBeenCalled();
    expect(directImage).not.toHaveBeenCalled();
    expect(addVersion).not.toHaveBeenCalled();
    // Worded for the client: which allowance and when it renews, no jargon.
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toContain(
      "image credits are used up",
    );
    expect((result as { message: string }).message).toContain("Nov 1");
  });
});
