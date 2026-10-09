import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RevisionVersion } from "@/lib/billing/revision-policy";

// The revision policy (docs/billing-tasks.md, lib/billing/revision-policy.ts): a
// post's first picture costs an image right, the first revisions of an AI picture
// are free, later ones cost a right again, a picture cut from the brand's own
// photo is never charged; the right is charged only when the new picture was
// stored, and a refusal is worded for the client. The decision comes from the
// post's HISTORY (not its version number), and one picture change per post runs
// at a time.

const prismaMock = vi.hoisted(() => ({
  creative: { findUniqueOrThrow: vi.fn() },
  creativeVersion: { findMany: vi.fn() },
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
  IdeaChatRepository: {
    resolveIdeaIdForTask: vi.fn(),
    postSystemMessage: vi.fn(),
  },
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
vi.mock("@/server/media/brand-style-context", () => ({
  resolveBrandStyleContext,
}));
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

// Billing mode and the per-post lock.
const billing = vi.hoisted(() => ({ mode: "enforce" as string }));
vi.mock("@/server/billing/config", () => ({
  getBillingConfig: () => ({ mode: billing.mode }),
}));
const lease = vi.hoisted(() => ({ acquire: vi.fn(), release: vi.fn() }));
vi.mock("@/server/billing/lease", () => ({ acquireLease: lease.acquire }));

const { performCreativeRevision } = await import("./creative-actions");
const { AgentelseError } = await import("@/server/security/errors");

beforeEach(async () => {
  vi.clearAllMocks();
  billing.mode = "enforce";
  const photo = await sharp({
    create: { width: 1600, height: 1200, channels: 3, background: "#806040" },
  })
    .jpeg()
    .toBuffer();
  storage.readAsset.mockResolvedValue(photo);
  storage.putAsset.mockResolvedValue({
    storageKey: "r2://cut.jpg",
    filename: "cut.jpg",
  });
  prismaMock.asset.findFirst.mockResolvedValue({
    id: "photo-1",
    storageKey: "r2://orig.jpg",
  });
  prismaMock.asset.findUnique.mockResolvedValue({
    storageKey: "k",
    mimeType: "image/png",
  });
  prismaMock.asset.create.mockResolvedValue({
    id: "asset-2",
    mimeType: "image/jpeg",
    width: 1080,
    height: 1440,
  });
  prismaMock.brandMedia.findUnique.mockResolvedValue({
    focalX: 0.5,
    focalY: 0.5,
    description: null,
  });
  prismaMock.brandDossier.findUnique.mockResolvedValue(null);
  applyBrandTemplate.mockResolvedValue(null);
  addVersion.mockResolvedValue({ version: 2 });
  directImage.mockResolvedValue(null);
  generateCreativeImage.mockResolvedValue({
    storageKey: "r2://ai.png",
    filename: "ai.png",
    mimeType: "image/png",
    size: 1,
    provider: "openai",
    width: 1080,
    height: 1440,
  });
  resolveBrandStyleContext.mockResolvedValue({
    logoAssetId: null,
    darkLogoAssetId: null,
    legacyApprovedColors: null,
    legacyVisualGuidelines: null,
    visualIdentity: null,
  });
  allowance.begin.mockReset();
  allowance.finish.mockReset();
  allowance.begin.mockResolvedValue({
    meter: allowance.meter,
    finish: allowance.finish,
  });
  lease.acquire.mockReset();
  lease.release.mockReset();
  lease.acquire.mockResolvedValue({ release: lease.release });
});

// --- the post's history, named after what really writes each version ---------

const drawnByJob: Partial<RevisionVersion> = {
  generationProvider: "openai-creative",
  generationMetadata: { prompt: "p" },
};
const upload: Partial<RevisionVersion> = {
  generationProvider: null,
  generationMetadata: null,
};
const photoCut: Partial<RevisionVersion> = {
  generationProvider: "openai-creative",
  generationMetadata: { photoSource: { assetId: "photo-1", fit: "cover" } },
};
const freeRevision: Partial<RevisionVersion> = {
  generationProvider: "openai",
  generationMetadata: { prompt: "p" },
  revisionReason: "Image regenerated per instruction: warmer",
};
const captionEdit: Partial<RevisionVersion> = {
  revisionReason: "Edited by you",
};
const variantPick: Partial<RevisionVersion> = {
  revisionReason: "Picked another picture",
};
const noPicture: Partial<RevisionVersion> = {
  assetId: null,
  generationProvider: "plan-run",
  generationMetadata: { taskId: "t1" },
};

function history(...steps: Partial<RevisionVersion>[]): RevisionVersion[] {
  return steps.map((step, index) => ({
    version: index + 1,
    assetId: `asset-${index + 1}`,
    generationProvider: "openai-creative",
    generationMetadata: null,
    revisionReason: null,
    ...step,
  }));
}

function revise(versions: RevisionVersion[], mode: "new" | "edit" = "new") {
  const latest = versions[versions.length - 1]!;
  prismaMock.creative.findUniqueOrThrow.mockResolvedValue({
    id: "cr1",
    workspaceId: "w",
    projectId: "p",
    brandId: "b",
    platform: "INSTAGRAM",
    status: "IN_REVIEW",
    title: "Post",
    brief: "brief",
    createdByTaskId: null,
    versions: [{ caption: "c", copy: "x", ...latest }],
  });
  prismaMock.creativeVersion.findMany.mockResolvedValue(versions);
  return performCreativeRevision({
    creativeId: "cr1",
    instruction: "",
    mode,
    userId: "u1",
  });
}

const reserved = (call = 0) =>
  (allowance.begin.mock.calls[call]![0] as { reserve: Record<string, unknown> })
    .reserve;

const storedMetadata = () =>
  (
    addVersion.mock.calls[0]![2] as {
      generationMetadata: Record<string, unknown>;
    }
  ).generationMetadata;

describe("which revisions cost an image right", () => {
  it("the first two revisions of an AI picture are free", async () => {
    await revise(history(drawnByJob));
    expect(reserved()).toEqual({});
    allowance.begin.mockClear();
    await revise(history(drawnByJob, freeRevision));
    expect(reserved()).toEqual({});
  });

  it("the third revision costs one image right and is marked as paid", async () => {
    expect(
      await revise(history(drawnByJob, freeRevision, freeRevision)),
    ).toEqual({ ok: true });
    expect(reserved()).toEqual({ IMAGE: 1 });
    expect(allowance.begin.mock.calls[0]![0]).toMatchObject({
      workspaceId: "w",
      projectId: "p",
      userId: "u1",
      source: "action",
      module: "SOCIAL",
    });
    expect(storedMetadata().paid).toBe(true);
  });

  it("a free revision is not marked as paid", async () => {
    await revise(history(drawnByJob));
    expect(storedMetadata()).not.toHaveProperty("paid");
  });

  // Editing the words or picking another picture also adds a version. The old
  // rule counted version numbers, so a person who had edited a caption twice was
  // charged (or, with no credits left, refused) for their first picture revision.
  it("caption edits and picture picks do not use up the free revisions", async () => {
    await revise(
      history(
        drawnByJob,
        captionEdit,
        captionEdit,
        variantPick,
        captionEdit,
        variantPick,
      ),
    );
    expect(reserved()).toEqual({});
  });

  it("an edit counts like a regenerate", async () => {
    await revise(history(drawnByJob, freeRevision, freeRevision), "edit");
    expect(reserved()).toEqual({ IMAGE: 1 });
  });

  it("the post's FIRST picture is its main image and always costs a right", async () => {
    await revise(history(noPicture));
    expect(reserved()).toEqual({ IMAGE: 1 });
  });

  // A picture that did not cost a right (an upload, a photo, an adaptation) is not
  // an AI picture that earned free revisions: the first AI picture over it is a
  // new main image. Otherwise every Creative made from a library file would hand
  // out free AI pictures for ever.
  it("the first AI picture over an uploaded file costs a right", async () => {
    await revise(history(upload));
    expect(reserved()).toEqual({ IMAGE: 1 });
    expect(storedMetadata().paid).toBe(true);
  });

  it("an AI edit of a picture cut from a photo costs a right", async () => {
    await revise(history(photoCut), "edit");
    expect(reserved()).toEqual({ IMAGE: 1 });
  });

  it("the first AI picture over an adapted picture costs a right", async () => {
    await revise(
      history({
        generationProvider: "openai-creative",
        generationMetadata: { adaptedFrom: "asset-main" },
      }),
    );
    expect(reserved()).toEqual({ IMAGE: 1 });
  });

  it("re-cutting the brand's own photo is never charged, however many times", async () => {
    await revise(history(photoCut, photoCut, photoCut, photoCut, photoCut));
    expect(reserved()).toEqual({});
    expect(generateCreativeImage).not.toHaveBeenCalled();
    expect(storedMetadata()).not.toHaveProperty("paid");
  });

  // The decision used to be made from the metadata alone: if the photo was deleted
  // in the meantime the code fell through to drawing a brand-new AI picture, with
  // nothing reserved.
  it("when the photo can no longer be loaded, the picture that gets drawn costs a right", async () => {
    prismaMock.asset.findFirst.mockResolvedValue(null);
    await revise(history(photoCut));
    expect(generateCreativeImage).toHaveBeenCalled();
    expect(reserved()).toEqual({ IMAGE: 1 });
  });

  it("even a free revision needs a valid plan", async () => {
    await revise(history(drawnByJob));
    expect(allowance.begin.mock.calls[0]![0]).toMatchObject({
      requireAccess: true,
    });
  });

  // A second request for the same post must not be able to share the first one's
  // hold (or its free revision): the key is unique per call, not a millisecond.
  it("names every revision's hold uniquely, even within one millisecond", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T12:00:00.000Z"));
    try {
      await revise(history(drawnByJob));
      await revise(history(drawnByJob));
    } finally {
      vi.useRealTimers();
    }
    const [a, b] = allowance.begin.mock.calls.map(
      (call) => (call[0] as { operationId: string }).operationId,
    );
    expect(a).not.toBe(b);
    expect(a).toMatch(/^revise:cr1:/);
  });
});

describe("one picture change per post at a time", () => {
  it("takes the post's lock before reading its history and frees it afterwards", async () => {
    await revise(history(drawnByJob));
    expect(lease.acquire).toHaveBeenCalledTimes(1);
    expect(lease.acquire.mock.calls[0]![0]).toBe("creative.revise:cr1");
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it("refuses a second change while the first runs: nothing is drawn or held", async () => {
    lease.acquire.mockResolvedValue(null);
    const result = await revise(history(drawnByJob));
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toContain("already being");
    expect(allowance.begin).not.toHaveBeenCalled();
    expect(generateCreativeImage).not.toHaveBeenCalled();
    expect(prismaMock.creativeVersion.findMany).not.toHaveBeenCalled();
  });

  it("frees the lock when the work fails", async () => {
    generateCreativeImage.mockRejectedValue(new Error("model exploded"));
    await revise(history(drawnByJob));
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it("frees the lock when the plan refuses", async () => {
    allowance.begin.mockRejectedValue(
      new AgentelseError("QUOTA_EXCEEDED", "Plan allowance used up", {
        meta: { unit: "IMAGE" },
      }),
    );
    await revise(history(drawnByJob, freeRevision, freeRevision));
    expect(lease.release).toHaveBeenCalledTimes(1);
  });
});

describe("billing off changes nothing", () => {
  it("asks no history, takes no lock, holds nothing and marks nothing", async () => {
    billing.mode = "off";
    expect(
      await revise(history(drawnByJob, freeRevision, freeRevision)),
    ).toEqual({ ok: true });
    expect(prismaMock.creativeVersion.findMany).not.toHaveBeenCalled();
    expect(lease.acquire).not.toHaveBeenCalled();
    expect(reserved()).toEqual({});
    expect(storedMetadata()).not.toHaveProperty("paid");
  });
});

describe("what is charged", () => {
  it("charges the picture once the new version is stored", async () => {
    await revise(history(drawnByJob, freeRevision, freeRevision));
    expect(addVersion).toHaveBeenCalledTimes(1);
    expect(allowance.finish).toHaveBeenCalledTimes(1);
    expect(allowance.finish).toHaveBeenCalledWith("delivered");
  });

  it("hands the right back when no picture came out", async () => {
    generateCreativeImage.mockResolvedValue(null);
    const result = await revise(
      history(drawnByJob, freeRevision, freeRevision),
    );
    expect(result).toMatchObject({ ok: false });
    expect(addVersion).not.toHaveBeenCalled();
    expect(allowance.finish).toHaveBeenCalledWith("failed");
  });

  it("hands the right back when the work blows up before the version is stored", async () => {
    generateCreativeImage.mockRejectedValue(new Error("model exploded"));
    const result = await revise(
      history(drawnByJob, freeRevision, freeRevision),
    );
    expect(result).toEqual({ ok: false, message: "model exploded" });
    expect(allowance.finish).toHaveBeenCalledWith("aborted");
  });

  it("draws nothing and charges nothing when the gate refuses", async () => {
    allowance.begin.mockRejectedValue(
      new AgentelseError("QUOTA_EXCEEDED", "Plan allowance used up", {
        meta: { unit: "IMAGE", resetsAt: "2026-11-01T00:00:00.000Z" },
      }),
    );
    const result = await revise(
      history(drawnByJob, freeRevision, freeRevision),
    );
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
