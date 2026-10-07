import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: bayrak kapalıyken ya da proje erişimi yokken depoya
// hiç gidilmez; yabancı site depodan NO_LINK olarak döner ve sabit mesajla
// çevrilir; CMS yolu çalışma alanı yöneticisi ister; FormData alanları (tekrar
// eden pageGroups dahil) doğru okunur; hata metni istemciye sızmaz.

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorkspaceManager: vi.fn(),
  revalidatePath: vi.fn(),
  create: vi.fn(),
  preview: vi.fn(),
  markApplied: vi.fn(),
  applyViaCms: vi.fn(),
  cancel: vi.fn(),
  checkNow: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
  isWorkspaceManager: mocks.isWorkspaceManager,
}));
vi.mock("@/server/seo/agency/split/store", () => ({
  GscSplitTests: {
    create: mocks.create,
    populationPreview: mocks.preview,
    markApplied: mocks.markApplied,
    applyViaCms: mocks.applyViaCms,
    cancel: mocks.cancel,
    checkNow: mocks.checkNow,
  },
}));

const {
  previewSplitPopulationAction,
  createSplitTestAction,
  markSplitTestAppliedAction,
  applySplitTestViaCmsAction,
  cancelSplitTestAction,
  checkSplitTestNowAction,
} = await import("./gsc-split-test-actions");
const { AgentelseError } = await import("@/server/security/errors");

function form(values: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  }
  return data;
}

const CREATE_FORM = {
  projectId: "project-1",
  linkId: "link-1",
  name: "Title test",
  changeKind: "TITLE_META",
  description: "Shorter titles",
  pageGroups: ["/blog", "/guides"],
  titlePattern: "{title} | {site}",
  metaPattern: "",
  schemaType: "",
  note: "",
};

beforeEach(() => {
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("GSC_AGENCY", "true");
  vi.stubEnv("NODE_ENV", "test");
  mocks.requireUser.mockResolvedValue({ userId: "user-1" });
  mocks.requireProjectAccess.mockResolvedValue({ workspaceId: "ws-1", projectId: "project-1" });
  mocks.isWorkspaceManager.mockResolvedValue(true);
  mocks.create.mockResolvedValue({ ok: true, test: {} });
  mocks.markApplied.mockResolvedValue({ ok: true });
  mocks.applyViaCms.mockResolvedValue({ ok: true, proposed: 2, skipped: 0 });
  mocks.cancel.mockResolvedValue({ ok: true });
  mocks.checkNow.mockResolvedValue("queued");
  mocks.preview.mockResolvedValue({ ok: true, pages: 10 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("guards", () => {
  it("does nothing when the flag is off", async () => {
    vi.stubEnv("GSC_AGENCY", "");
    expect(await createSplitTestAction(form(CREATE_FORM))).toEqual({ ok: false, message: "Not available" });
    expect(await cancelSplitTestAction(form({ projectId: "project-1", testId: "t1" }))).toEqual({ ok: false, message: "Not available" });
    expect(await previewSplitPopulationAction({ projectId: "project-1", linkId: "l", pageGroups: ["/a"] })).toEqual({ ok: false, message: "Not available" });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it("refuses a non-member without reaching the store", async () => {
    mocks.requireProjectAccess.mockRejectedValue(new AgentelseError("PERMISSION_DENIED", "secret workspace id"));
    const result = await createSplitTestAction(form(CREATE_FORM));
    expect(result).toEqual({ ok: false, message: "This project isn't available." });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("asks to sign in again when the session is gone", async () => {
    mocks.requireUser.mockRejectedValue(new AgentelseError("LOGIN_REQUIRED", "x"));
    expect(await createSplitTestAction(form(CREATE_FORM))).toEqual({ ok: false, message: "Please sign in again." });
  });

  it("does not leak unexpected error text", async () => {
    mocks.create.mockRejectedValue(new Error("password=hunter2 at db.internal"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await createSplitTestAction(form(CREATE_FORM));
    error.mockRestore();
    expect(result).toEqual({ ok: false, message: "That didn't work. Try again." });
  });

  it("rejects malformed ids", async () => {
    expect(await createSplitTestAction(form({ ...CREATE_FORM, projectId: "../x" }))).toMatchObject({ ok: false });
    expect(await cancelSplitTestAction(form({ projectId: "project-1", testId: "a b" }))).toMatchObject({ ok: false });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
});

describe("createSplitTestAction", () => {
  it("reads the form including repeated page groups", async () => {
    expect(await createSplitTestAction(form(CREATE_FORM))).toEqual({ ok: true });
    expect(mocks.create).toHaveBeenCalledWith({
      projectId: "project-1",
      linkId: "link-1",
      userId: "user-1",
      name: "Title test",
      changeKind: "TITLE_META",
      description: "Shorter titles",
      pageGroups: ["/blog", "/guides"],
      change: { titlePattern: "{title} | {site}", metaPattern: null, schemaType: null, note: null },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/project-1/arama");
  });

  it("rejects an unknown change kind", async () => {
    expect(await createSplitTestAction(form({ ...CREATE_FORM, changeKind: "NOPE" }))).toMatchObject({ ok: false });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("turns store codes into the store's fixed messages", async () => {
    mocks.create.mockResolvedValue({ ok: false, code: "NO_LINK", message: "That site isn't available." });
    expect(await createSplitTestAction(form({ ...CREATE_FORM, linkId: "foreign" }))).toEqual({ ok: false, message: "That site isn't available." });
    mocks.create.mockResolvedValue({ ok: false, code: "NOT_ELIGIBLE", message: "Each page group needs at least 100 pages with search traffic." });
    expect(await createSplitTestAction(form(CREATE_FORM))).toEqual({
      ok: false,
      message: "Each page group needs at least 100 pages with search traffic.",
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("previewSplitPopulationAction", () => {
  it("passes cleaned groups to the store", async () => {
    const result = await previewSplitPopulationAction({
      projectId: "project-1",
      linkId: "link-1",
      pageGroups: ["/a", " /b ", "", "x".repeat(200)],
    });
    expect(result).toEqual({ ok: true, pages: 10 });
    expect(mocks.preview).toHaveBeenCalledWith({
      projectId: "project-1",
      linkId: "link-1",
      pageGroups: ["/a", "/b"],
    });
  });

  it("rejects a malformed input", async () => {
    const result = await previewSplitPopulationAction({
      projectId: "project-1",
      linkId: "bad id",
      pageGroups: ["/a"],
    });
    expect(result).toMatchObject({ ok: false });
    expect(mocks.preview).not.toHaveBeenCalled();
  });
});

describe("other actions", () => {
  const idForm = { projectId: "project-1", testId: "split-1" };

  it("marks a test applied with the day", async () => {
    expect(await markSplitTestAppliedAction(form({ ...idForm, appliedOn: "2026-09-09" }))).toEqual({ ok: true });
    expect(mocks.markApplied).toHaveBeenCalledWith({
      projectId: "project-1",
      testId: "split-1",
      userId: "user-1",
      appliedOn: "2026-09-09",
    });
  });

  it("passes the store's refusal message through", async () => {
    mocks.markApplied.mockResolvedValue({ ok: false, message: "That day is in the future." });
    expect(await markSplitTestAppliedAction(form({ ...idForm, appliedOn: "2099-01-01" }))).toEqual({
      ok: false,
      message: "That day is in the future.",
    });
  });

  it("needs a workspace manager for the CMS path", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    expect(await applySplitTestViaCmsAction(form(idForm))).toEqual({
      ok: false,
      message: "Only workspace owners and admins can change this.",
    });
    expect(mocks.applyViaCms).not.toHaveBeenCalled();
    mocks.isWorkspaceManager.mockResolvedValue(true);
    expect(await applySplitTestViaCmsAction(form(idForm))).toEqual({ ok: true });
    expect(mocks.applyViaCms).toHaveBeenCalledTimes(1);
  });

  it("cancels a test", async () => {
    expect(await cancelSplitTestAction(form(idForm))).toEqual({ ok: true });
    expect(mocks.cancel).toHaveBeenCalledWith({ projectId: "project-1", testId: "split-1", userId: "user-1" });
  });

  it("maps the check-now answers to fixed messages", async () => {
    expect(await checkSplitTestNowAction(form(idForm))).toEqual({ ok: true });
    mocks.checkNow.mockResolvedValue("too_soon");
    expect(await checkSplitTestNowAction(form(idForm))).toEqual({
      ok: false,
      message: "We checked this a few minutes ago. Try again shortly.",
    });
    mocks.checkNow.mockResolvedValue("not_found");
    expect(await checkSplitTestNowAction(form(idForm))).toEqual({ ok: false, message: "This test no longer exists." });
  });
});
