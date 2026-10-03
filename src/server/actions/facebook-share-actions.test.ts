import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: the Facebook row's actions act only on a creative of
// a project the person can access, and another workspace's creative reads
// exactly like a missing one (no workspace id or query text reaches the
// browser); unexpected errors become a generic message.

const requireUser = vi.fn();
const requireProjectAccess = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess,
}));

const creativeFindUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { creative: { findUnique: creativeFindUnique } },
}));

const shareCreativeToFacebookCore = vi.fn();
const editFacebookShareCore = vi.fn();
const deleteFacebookShareCore = vi.fn();
vi.mock("@/server/commands/facebook-share", () => ({
  shareCreativeToFacebookCore,
  editFacebookShareCore,
  deleteFacebookShareCore,
}));

const {
  deleteFacebookPostAction,
  editFacebookPostAction,
  shareCreativeToFacebookAction,
} = await import("./facebook-share-actions");
const { AgentelseError } = await import("@/server/security/errors");

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ userId: "user-1", email: null });
  requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: "proj-1",
    defaultBrandId: "brand-1",
  });
  creativeFindUnique.mockResolvedValue({ projectId: "proj-1" });
  shareCreativeToFacebookCore.mockResolvedValue({
    ok: true,
    message: "Shared",
  });
  editFacebookShareCore.mockResolvedValue({ ok: true, message: "Updated" });
  deleteFacebookShareCore.mockResolvedValue({ ok: true, message: "Deleted" });
});

describe("facebook share actions", () => {
  it("pass the creative's own project scope to the core", async () => {
    await shareCreativeToFacebookAction("cr-1");
    await editFacebookPostAction("cr-1", "New text");
    await deleteFacebookPostAction("cr-1");

    const scope = {
      creativeId: "cr-1",
      projectId: "proj-1",
      workspaceId: "ws-1",
      actorUserId: "user-1",
    };
    expect(shareCreativeToFacebookCore).toHaveBeenCalledWith(scope);
    expect(editFacebookShareCore).toHaveBeenCalledWith({
      ...scope,
      message: "New text",
    });
    expect(deleteFacebookShareCore).toHaveBeenCalledWith(scope);
  });

  it("answer another workspace's creative exactly like a missing one", async () => {
    creativeFindUnique.mockResolvedValue(null);
    const missing = await shareCreativeToFacebookAction("cr-1");

    creativeFindUnique.mockResolvedValue({ projectId: "proj-other" });
    requireProjectAccess.mockRejectedValue(
      new AgentelseError(
        "PERMISSION_DENIED",
        "User user-1 has no access to workspace ws-9",
      ),
    );
    const foreign = await shareCreativeToFacebookAction("cr-1");

    expect(foreign).toEqual(missing);
    expect(foreign).toEqual({ ok: false, message: "Creative not found." });
    expect(JSON.stringify(foreign)).not.toContain("ws-9");
    expect(shareCreativeToFacebookCore).not.toHaveBeenCalled();
  });

  it("refuse a non-string id without querying, and hide unexpected errors", async () => {
    expect(await deleteFacebookPostAction(42 as unknown as string)).toEqual({
      ok: false,
      message: "Creative not found.",
    });
    expect(creativeFindUnique).not.toHaveBeenCalled();

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    editFacebookShareCore.mockRejectedValue(
      new Error("Invalid prisma.task.findFirst() invocation"),
    );
    const result = await editFacebookPostAction("cr-1", "Text");
    expect(result).toEqual({
      ok: false,
      message: "Something went wrong, please try again.",
    });
  });
});
