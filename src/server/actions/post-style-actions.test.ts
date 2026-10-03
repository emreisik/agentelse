import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isRateLimited: vi.fn(),
  revalidatePath: vi.fn(),
  audit: vi.fn(),
  addFromBytes: vi.fn(),
  ensureRow: vi.fn(),
  fetchLink: vi.fn(),
  reanalyze: vi.fn(),
  getExample: vi.fn(),
  removeExample: vi.fn(),
  saveDirectives: vi.fn(),
  saveExample: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: mocks.isRateLimited }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.audit },
}));
vi.mock("@/server/brand/post-style-service", () => ({
  MAX_EXAMPLE_UPLOAD_BYTES: 8 * 1024 * 1024,
  addExampleFromBytes: mocks.addFromBytes,
  ensureVisualIdentityRow: mocks.ensureRow,
  fetchLinkImage: mocks.fetchLink,
  reanalyzeExample: mocks.reanalyze,
}));
vi.mock("@/server/brand/post-style-store", () => ({
  getExample: mocks.getExample,
  removeExample: mocks.removeExample,
  saveDirectives: mocks.saveDirectives,
  saveExample: mocks.saveExample,
}));

const {
  addPostStyleExamplesAction,
  reanalyzePostStyleExampleAction,
  removePostStyleExampleAction,
  setPostStyleExampleAction,
  updatePostStyleDirectivesAction,
} = await import("./post-style-actions");

const scope = { workspaceId: "ws", projectId: "p1", brandId: "b1" };

function file(name: string, type: string, size = 100): File {
  return new File([new Uint8Array(size)], name, { type });
}

function form(parts: { files?: File[]; links?: string; projectId?: string }): FormData {
  const data = new FormData();
  data.set("projectId", parts.projectId ?? "p1");
  if (parts.links !== undefined) data.set("links", parts.links);
  for (const entry of parts.files ?? []) data.append("files", entry);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ userId: "u1" });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "ws",
    defaultBrandId: "b1",
  });
  mocks.isRateLimited.mockReturnValue(false);
  mocks.audit.mockResolvedValue(undefined);
  mocks.addFromBytes.mockResolvedValue({ ok: true, assetId: "a1", analyzed: true });
  mocks.fetchLink.mockResolvedValue({ ok: true, bytes: Buffer.from("x"), url: "https://x.com/a.png" });
  mocks.getExample.mockResolvedValue({
    assetId: "a1",
    label: "Old",
    source: "upload",
    enabled: true,
    analysis: null,
    addedAt: "2026-10-01T00:00:00.000Z",
  });
  mocks.removeExample.mockResolvedValue(true);
  mocks.reanalyze.mockResolvedValue(true);
});

describe("addPostStyleExamplesAction", () => {
  it("adds pictures and links, tells what could not be added and refreshes the page", async () => {
    mocks.addFromBytes
      .mockResolvedValueOnce({ ok: true, assetId: "a1", analyzed: true })
      .mockResolvedValueOnce({ ok: true, assetId: "a2", analyzed: false })
      .mockResolvedValueOnce({ ok: false, reason: "The picture is too small." });
    mocks.fetchLink.mockResolvedValueOnce({ ok: true, bytes: Buffer.from("x"), url: "u" });
    const result = await addPostStyleExamplesAction(
      form({
        files: [file("one.png", "image/png"), file("two.jpg", "image/jpeg")],
        links: "https://x.com/a.png",
      }),
    );
    expect(result).toEqual({
      ok: true,
      added: 2,
      analyzed: 1,
      failed: [{ name: "https://x.com/a.png", reason: "The picture is too small." }],
    });
    // The file name is the first label, without its extension.
    expect(mocks.addFromBytes.mock.calls[0]![0]).toMatchObject({
      scope,
      label: "one",
      source: "upload",
    });
    expect(mocks.addFromBytes.mock.calls[2]![0]).toMatchObject({
      source: "link",
      url: "https://x.com/a.png",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/p1");
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });

  it("a link that gives no picture is reported with its reason, never thrown", async () => {
    mocks.fetchLink.mockResolvedValue({ ok: false, reason: "No picture was found on that page." });
    const result = await addPostStyleExamplesAction(
      form({ links: "https://www.instagram.com/p/abc/" }),
    );
    expect(result).toEqual({
      ok: true,
      added: 0,
      analyzed: 0,
      failed: [
        {
          name: "https://www.instagram.com/p/abc/",
          reason: "No picture was found on that page.",
        },
      ],
    });
    expect(mocks.addFromBytes).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a type or size the model does not take, before reading the file", async () => {
    const result = await addPostStyleExamplesAction(
      form({
        files: [
          file("a.gif", "image/gif"),
          file("b.png", "image/png", 9 * 1024 * 1024),
        ],
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      added: 0,
      failed: [
        { name: "a.gif", reason: "Use a PNG, JPG or WebP picture." },
        { name: "b.png", reason: "That picture is larger than 8 MB." },
      ],
    });
    expect(mocks.addFromBytes).not.toHaveBeenCalled();
  });

  it("asks for something to add, and no more than six at a time", async () => {
    expect(await addPostStyleExamplesAction(form({}))).toEqual({
      ok: false,
      message: "Add at least one picture or link.",
    });
    const seven = Array.from({ length: 7 }, (_, i) => file(`${i}.png`, "image/png"));
    expect(await addPostStyleExamplesAction(form({ files: seven }))).toEqual({
      ok: false,
      message: "Add at most 6 at a time.",
    });
  });

  it("is rate limited, and needs a project the user can open", async () => {
    mocks.isRateLimited.mockReturnValue(true);
    expect(
      await addPostStyleExamplesAction(form({ files: [file("a.png", "image/png")] })),
    ).toEqual({ ok: false, message: "Slow down for a moment." });
    expect(await addPostStyleExamplesAction(form({ projectId: "" }))).toEqual({
      ok: false,
      message: "Project not found.",
    });
    mocks.requireProjectAccess.mockRejectedValue(new Error("no access"));
    mocks.isRateLimited.mockReturnValue(false);
    expect(
      await addPostStyleExamplesAction(form({ files: [file("a.png", "image/png")] })),
    ).toEqual({ ok: false, message: "That didn't work. Try again." });
  });
});

describe("updatePostStyleDirectivesAction", () => {
  it("saves the instructions and how closely to follow the examples", async () => {
    const result = await updatePostStyleDirectivesAction({
      projectId: "p1",
      text: "  Always product-focused.  ",
      fidelity: "inspired",
    });
    expect(result).toEqual({ ok: true });
    expect(mocks.ensureRow).toHaveBeenCalledWith(scope);
    expect(mocks.saveDirectives).toHaveBeenCalledWith(scope, {
      text: "Always product-focused.",
      fidelity: "inspired",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/p1");
  });

  it("refuses a text that is too long and a fidelity it does not know", async () => {
    expect(
      await updatePostStyleDirectivesAction({
        projectId: "p1",
        text: "x".repeat(2001),
        fidelity: "match",
      }),
    ).toEqual({
      ok: false,
      message: "Keep the instructions under 2000 characters.",
    });
    expect(
      await updatePostStyleDirectivesAction({
        projectId: "p1",
        text: "ok",
        fidelity: "wild",
      }),
    ).toEqual({ ok: false, message: "Pick how closely posts follow the examples." });
    expect(mocks.saveDirectives).not.toHaveBeenCalled();
  });
});

describe("setPostStyleExampleAction", () => {
  it("switches an example off and renames it, clipped", async () => {
    const result = await setPostStyleExampleAction({
      projectId: "p1",
      assetId: "a1",
      enabled: false,
      label: `  ${"n".repeat(100)}  `,
    });
    expect(result).toEqual({ ok: true });
    const saved = mocks.saveExample.mock.calls[0]![1];
    expect(saved.enabled).toBe(false);
    expect(saved.label).toHaveLength(60);
    // Only the brand's own examples are looked up.
    expect(mocks.getExample).toHaveBeenCalledWith("b1", "a1");
  });

  it("an example that is gone says so", async () => {
    mocks.getExample.mockResolvedValue(null);
    expect(
      await setPostStyleExampleAction({ projectId: "p1", assetId: "x", enabled: true }),
    ).toEqual({ ok: false, message: "That example is gone." });
    expect(mocks.saveExample).not.toHaveBeenCalled();
  });
});

describe("removePostStyleExampleAction and reanalyzePostStyleExampleAction", () => {
  it("removes the example (the picture stays in the library)", async () => {
    expect(await removePostStyleExampleAction({ projectId: "p1", assetId: "a1" })).toEqual({
      ok: true,
    });
    expect(mocks.removeExample).toHaveBeenCalledWith("b1", "a1");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/p1");
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ userId: "u1" });
    mocks.requireProjectAccess.mockResolvedValue({ workspaceId: "ws", defaultBrandId: "b1" });
    mocks.removeExample.mockResolvedValue(false);
    expect(await removePostStyleExampleAction({ projectId: "p1", assetId: "a1" })).toEqual({
      ok: true,
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("reads an example again, or says it could not", async () => {
    expect(await reanalyzePostStyleExampleAction({ projectId: "p1", assetId: "a1" })).toEqual({
      ok: true,
    });
    expect(mocks.reanalyze).toHaveBeenCalledWith(scope, "a1");
    mocks.reanalyze.mockResolvedValue(false);
    expect(await reanalyzePostStyleExampleAction({ projectId: "p1", assetId: "a1" })).toEqual({
      ok: false,
      message: "The picture couldn't be read. Try again.",
    });
  });
});
