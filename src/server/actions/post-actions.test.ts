import { beforeEach, describe, expect, it, vi } from "vitest";

// The post-level actions (docs/works.md "Posts"): one Approve for the post
// (through the usual decision, which approves its other channels), a channel
// out of or back into its post, and Post now through each channel's own path.

const mocks = vi.hoisted(() => ({
  postFindUnique: vi.fn(),
  creativeFindMany: vi.fn(),
  creativeFindUnique: vi.fn(),
  creativeCount: vi.fn(),
  creativeUpdate: vi.fn(),
  postUpdate: vi.fn(),
  approvalFindFirst: vi.fn(),
  applyApprovalDecision: vi.fn(),
  publishCreativeCore: vi.fn(),
  publishCreativeToSocialCore: vi.fn(),
  shareCreativeToFacebookCore: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    post: { findUnique: mocks.postFindUnique, update: mocks.postUpdate },
    creative: {
      findMany: mocks.creativeFindMany,
      findUnique: mocks.creativeFindUnique,
      count: mocks.creativeCount,
      update: mocks.creativeUpdate,
    },
    approval: { findFirst: mocks.approvalFindFirst },
    $transaction: async (writes: unknown[]) => Promise.all(writes),
  },
}));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: async () => ({ userId: "u1" }),
  requireProjectAccess: async () => ({ workspaceId: "ws" }),
}));
vi.mock("@/server/commands/approval-decisions", () => ({
  applyApprovalDecision: mocks.applyApprovalDecision,
}));
vi.mock("@/server/commands/publish-creative", () => ({
  publishCreativeCore: mocks.publishCreativeCore,
  publishCreativeToSocialCore: mocks.publishCreativeToSocialCore,
}));
vi.mock("@/server/commands/facebook-share", () => ({
  shareCreativeToFacebookCore: mocks.shareCreativeToFacebookCore,
}));

const { approvePostAction, publishPostNowAction, setDeliveryExcludedAction } =
  await import("./post-actions");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.postFindUnique.mockResolvedValue({ id: "post-1", projectId: "p1" });
  mocks.creativeUpdate.mockResolvedValue({});
  mocks.postUpdate.mockResolvedValue({});
});

describe("approvePostAction", () => {
  it("approves the post's first waiting channel through the usual decision", async () => {
    mocks.creativeFindMany.mockResolvedValue([
      { id: "ig", status: "IN_REVIEW" },
      { id: "fb", status: "IN_REVIEW" },
    ]);
    mocks.approvalFindFirst.mockResolvedValue({ id: "ap1" });
    expect(await approvePostAction("post-1")).toEqual({ ok: true });
    expect(mocks.applyApprovalDecision).toHaveBeenCalledWith(
      expect.objectContaining({ approval: { id: "ap1" }, to: "APPROVED" }),
    );
  });

  it("waits until every channel left in the post has its content", async () => {
    mocks.creativeFindMany.mockResolvedValue([
      { id: "ig", status: "IN_REVIEW" },
      { id: "story", status: "DRAFT" },
    ]);
    expect(await approvePostAction("post-1")).toMatchObject({ ok: false });
    expect(mocks.applyApprovalDecision).not.toHaveBeenCalled();
  });

  it("refuses an unknown post", async () => {
    mocks.postFindUnique.mockResolvedValue(null);
    expect(await approvePostAction("nope")).toMatchObject({ ok: false });
  });
});

describe("setDeliveryExcludedAction", () => {
  it("keeps at least one channel in the post", async () => {
    mocks.creativeFindUnique.mockResolvedValue({
      projectId: "p1",
      postId: "post-1",
      status: "IN_REVIEW",
      excludedAt: null,
    });
    mocks.creativeCount.mockResolvedValue(0);
    expect(await setDeliveryExcludedAction("ig", true)).toEqual({
      ok: false,
      message: "A post keeps at least one channel.",
    });
    expect(mocks.creativeUpdate).not.toHaveBeenCalled();
  });

  it("takes a channel back in and reopens the post's approval", async () => {
    mocks.creativeFindUnique.mockResolvedValue({
      projectId: "p1",
      postId: "post-1",
      status: "IN_REVIEW",
      excludedAt: new Date(),
    });
    expect(await setDeliveryExcludedAction("fb", false)).toEqual({ ok: true });
    expect(mocks.creativeUpdate).toHaveBeenCalledWith({
      where: { id: "fb" },
      data: { excludedAt: null },
    });
    expect(mocks.postUpdate).toHaveBeenCalledWith({
      where: { id: "post-1" },
      data: { approvedAt: null, approvedByUserId: null },
    });
  });

  it("never touches a posted channel", async () => {
    mocks.creativeFindUnique.mockResolvedValue({
      projectId: "p1",
      postId: "post-1",
      status: "PUBLISHED",
      excludedAt: null,
    });
    expect(await setDeliveryExcludedAction("fb", true)).toMatchObject({
      ok: false,
    });
  });
});

describe("publishPostNowAction", () => {
  it("posts each approved channel through its own path", async () => {
    mocks.creativeFindMany.mockResolvedValue([
      { id: "ig", channel: "instagram", formatKey: "instagram.post" },
      { id: "story", channel: "instagram", formatKey: "instagram.story" },
      { id: "fb", channel: "facebook", formatKey: "facebook.post" },
    ]);
    mocks.publishCreativeCore.mockResolvedValue({ ok: true, message: "ok" });
    mocks.shareCreativeToFacebookCore.mockResolvedValue({
      ok: true,
      message: "ok",
    });

    expect(await publishPostNowAction("post-1")).toEqual({ ok: true });
    expect(
      mocks.publishCreativeCore.mock.calls.map((c) => c[0].format),
    ).toEqual(["FEED", "STORIES"]);
    expect(mocks.shareCreativeToFacebookCore).toHaveBeenCalledWith(
      expect.objectContaining({ creativeId: "fb" }),
    );
  });
});
