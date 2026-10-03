import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isRateLimited: vi.fn(),
  revalidatePath: vi.fn(),
  audit: vi.fn(),
  creativeFindUnique: vi.fn(),
  rememberRating: vi.fn(),
  getExample: vi.fn(),
  addFromAsset: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/prisma", () => ({
  prisma: { creative: { findUnique: mocks.creativeFindUnique } },
}));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: mocks.isRateLimited }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.audit },
}));
vi.mock("@/server/memory/memory-service", () => ({
  MemoryService: { rememberCreativeRating: mocks.rememberRating },
}));
vi.mock("@/server/brand/post-style-store", () => ({
  getExample: mocks.getExample,
}));
vi.mock("@/server/brand/post-style-service", () => ({
  addExampleFromAsset: mocks.addFromAsset,
}));

const { addLikedCreativeToPostStyleAction, rateCreativeAction } = await import(
  "./creative-rating-actions"
);

const creative = {
  id: "cr1",
  projectId: "p1",
  title: "Autumn sale",
  status: "IN_REVIEW",
  versions: [{ assetId: "asset-1" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ userId: "u1" });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "ws",
    defaultBrandId: "b1",
  });
  mocks.isRateLimited.mockReturnValue(false);
  mocks.audit.mockResolvedValue(undefined);
  mocks.creativeFindUnique.mockResolvedValue(creative);
  mocks.rememberRating.mockResolvedValue({ id: "m1" });
  mocks.getExample.mockResolvedValue(null);
  mocks.addFromAsset.mockResolvedValue({ ok: true, assetId: "asset-1", analyzed: true });
});

describe("rateCreativeAction", () => {
  it("checks access against the project of the post, then teaches the brand", async () => {
    const result = await rateCreativeAction({ creativeId: "cr1", rating: "LIKE" });

    expect(mocks.requireProjectAccess).toHaveBeenCalledWith("u1", "p1");
    expect(mocks.rememberRating).toHaveBeenCalledWith({
      scope: { workspaceId: "ws", projectId: "p1", brandId: "b1" },
      creativeId: "cr1",
      rating: "LIKE",
      reasons: [],
      note: undefined,
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/p1");
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "creative.rated",
        entityId: "cr1",
        metadata: { rating: "LIKE", learned: true },
      }),
    );
    expect(result).toEqual({ ok: true, canAddExample: true });
  });

  it("passes only the known reasons and a tidy note for a dislike", async () => {
    const result = await rateCreativeAction({
      creativeId: "cr1",
      rating: "DISLIKE",
      reasons: ["layout", "bogus", "layout"],
      note: "  too   busy  ",
    });

    expect(mocks.rememberRating).toHaveBeenCalledWith(
      expect.objectContaining({
        rating: "DISLIKE",
        reasons: ["layout"],
        note: "too busy",
      }),
    );
    // A dislike never offers to make the post an example.
    expect(result).toEqual({ ok: true, canAddExample: false });
  });

  it("does not offer a post that is already an example", async () => {
    mocks.getExample.mockResolvedValue({ assetId: "asset-1" });
    await expect(
      rateCreativeAction({ creativeId: "cr1", rating: "LIKE" }),
    ).resolves.toEqual({ ok: true, canAddExample: false });
  });

  it("does not offer a post without a picture", async () => {
    mocks.creativeFindUnique.mockResolvedValue({ ...creative, versions: [] });
    await expect(
      rateCreativeAction({ creativeId: "cr1", rating: "LIKE" }),
    ).resolves.toEqual({ ok: true, canAddExample: false });
    expect(mocks.getExample).not.toHaveBeenCalled();
  });

  it("refuses an unknown rating before touching anything", async () => {
    const result = await rateCreativeAction({ creativeId: "cr1", rating: "MEH" });
    expect(result.ok).toBe(false);
    expect(mocks.creativeFindUnique).not.toHaveBeenCalled();
    expect(mocks.rememberRating).not.toHaveBeenCalled();
  });

  it("refuses a post that does not exist or an id that is not an id", async () => {
    mocks.creativeFindUnique.mockResolvedValue(null);
    expect((await rateCreativeAction({ creativeId: "nope", rating: "LIKE" })).ok).toBe(false);
    expect((await rateCreativeAction({ creativeId: "x".repeat(80), rating: "LIKE" })).ok).toBe(false);
    expect(mocks.rememberRating).not.toHaveBeenCalled();
  });

  it("refuses when the user has no access to the project of the post", async () => {
    mocks.requireProjectAccess.mockRejectedValue(new Error("forbidden"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await rateCreativeAction({ creativeId: "cr1", rating: "LIKE" });

    expect(result.ok).toBe(false);
    expect(mocks.rememberRating).not.toHaveBeenCalled();
  });

  it("slows down a flood of taps", async () => {
    mocks.isRateLimited.mockReturnValue(true);
    const result = await rateCreativeAction({ creativeId: "cr1", rating: "LIKE" });
    expect(result.ok).toBe(false);
    expect(mocks.rememberRating).not.toHaveBeenCalled();
  });

  it("is still a success when the brand could not learn from it", async () => {
    mocks.rememberRating.mockResolvedValue(null);
    await expect(
      rateCreativeAction({ creativeId: "cr1", rating: "LIKE" }),
    ).resolves.toMatchObject({ ok: true });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { rating: "LIKE", learned: false } }),
    );
  });

  it("does not fail the tap when the audit log is down", async () => {
    mocks.audit.mockRejectedValue(new Error("audit down"));
    await expect(
      rateCreativeAction({ creativeId: "cr1", rating: "LIKE" }),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe("addLikedCreativeToPostStyleAction", () => {
  it("makes the picture of the liked post an example, without a second copy", async () => {
    const result = await addLikedCreativeToPostStyleAction({ creativeId: "cr1" });

    expect(mocks.addFromAsset).toHaveBeenCalledWith({
      scope: { workspaceId: "ws", projectId: "p1", brandId: "b1" },
      assetId: "asset-1",
      label: "Autumn sale",
      source: "liked",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/p1");
    expect(result).toEqual({ ok: true });
  });

  it("says why it could not add the picture", async () => {
    mocks.addFromAsset.mockResolvedValue({ ok: false, reason: "Post style is full." });
    await expect(
      addLikedCreativeToPostStyleAction({ creativeId: "cr1" }),
    ).resolves.toEqual({ ok: false, message: "Post style is full." });
  });

  it("refuses a post without a picture", async () => {
    mocks.creativeFindUnique.mockResolvedValue({ ...creative, versions: [] });
    const result = await addLikedCreativeToPostStyleAction({ creativeId: "cr1" });
    expect(result.ok).toBe(false);
    expect(mocks.addFromAsset).not.toHaveBeenCalled();
  });

  it("refuses a missing post and a user without access", async () => {
    mocks.creativeFindUnique.mockResolvedValue(null);
    expect((await addLikedCreativeToPostStyleAction({ creativeId: "nope" })).ok).toBe(false);

    mocks.creativeFindUnique.mockResolvedValue(creative);
    mocks.requireProjectAccess.mockRejectedValue(new Error("forbidden"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await addLikedCreativeToPostStyleAction({ creativeId: "cr1" })).ok).toBe(false);
    expect(mocks.addFromAsset).not.toHaveBeenCalled();
  });

  it("slows down a flood of additions", async () => {
    mocks.isRateLimited.mockReturnValue(true);
    const result = await addLikedCreativeToPostStyleAction({ creativeId: "cr1" });
    expect(result.ok).toBe(false);
    expect(mocks.addFromAsset).not.toHaveBeenCalled();
  });
});
