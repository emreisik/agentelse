import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentelseError } from "@/server/security/errors";

// Bu dosyanın kanıtladığı (SC-F8 eylem katmanı): her eylem önce oturumu ve proje
// erişimini doğrular, sonra bayrağı yeniden denetler (kapalıysa sabit mesaj, iş
// yok); onay yalnız OWNER/ADMIN'e ve HİÇBİR onay çağrısından önce kapanır, ret
// için eylem kendi rol denetimini yapmaz ama kapı (ApprovalRepository.decide)
// üyeyi reddeder ve sabit mesaj döner; karardan sonra SeoApply.syncApprovalState çağrılır; geri
// alma, ayarlar ve IndexNow yalnız yönetici; öneri eylemleri hız sınırlıdır;
// istemciye yalnız sabit mesajlar gider.

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  isRateLimited: vi.fn(),
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorkspaceManager: vi.fn(),
  approvalFindFirst: vi.fn(),
  applyApprovalDecision: vi.fn(),
  propose: vi.fn(),
  syncApprovalState: vi.fn(),
  undo: vi.fn(),
  getChangeInProject: vi.fn(),
  ensureActionForFinding: vi.fn(),
  listApplyCandidates: vi.fn(),
  remainingLinksOf: vi.fn(),
  enable: vi.fn(),
  verify: vi.fn(),
  disable: vi.fn(),
  saveApplySettings: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/prisma", () => ({
  prisma: { approval: { findFirst: mocks.approvalFindFirst } },
}));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: mocks.isRateLimited }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
  isWorkspaceManager: mocks.isWorkspaceManager,
}));
vi.mock("@/server/commands/approval-decisions", () => ({
  applyApprovalDecision: mocks.applyApprovalDecision,
}));
vi.mock("@/server/seo/apply/seo-apply", () => ({
  SeoApply: {
    propose: mocks.propose,
    syncApprovalState: mocks.syncApprovalState,
    undo: mocks.undo,
  },
}));
vi.mock("@/server/seo/apply/store", () => ({
  getChangeInProject: mocks.getChangeInProject,
}));
vi.mock("@/server/seo/apply/action-link", () => ({
  ensureActionForFinding: mocks.ensureActionForFinding,
  listApplyCandidates: mocks.listApplyCandidates,
  remainingLinksOf: mocks.remainingLinksOf,
}));
vi.mock("@/server/seo/apply/indexnow", () => ({
  SeoIndexNow: {
    enable: mocks.enable,
    verify: mocks.verify,
    disable: mocks.disable,
  },
}));
vi.mock("@/server/seo/apply/settings", () => ({
  saveApplySettings: mocks.saveApplySettings,
}));

import {
  decideSeoChangeAction,
  indexNowDisableAction,
  indexNowEnableAction,
  indexNowVerifyAction,
  proposeApplyAction,
  proposeMakeLiveAction,
  proposePublishArticleAction,
  saveApplySettingsAction,
  undoSeoChangeAction,
} from "./seo-apply-actions";

const FLAGS = ["SEO_APPLY", "SEO_HEALTH", "SEO_INDEXNOW"] as const;
const ORIGINAL: Record<string, string | undefined> = Object.fromEntries(
  FLAGS.map((name) => [name, process.env[name]]),
);

function flags(options: { apply: boolean; indexNow?: boolean }): void {
  process.env.SEO_HEALTH = "true";
  process.env.SEO_APPLY = options.apply ? "true" : "";
  process.env.SEO_INDEXNOW = options.indexNow ? "true" : "";
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

const BASE = { projectId: "p1" };

beforeEach(() => {
  vi.clearAllMocks();
  flags({ apply: true });
  mocks.requireUser.mockResolvedValue({ userId: "u1" });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "w1",
    projectId: "p1",
    defaultBrandId: "b1",
  });
  mocks.isWorkspaceManager.mockResolvedValue(true);
  mocks.isRateLimited.mockReturnValue(false);
  mocks.propose.mockResolvedValue({
    ok: true,
    changeId: "c1",
    status: "PROPOSED",
    created: true,
    approvalId: "a1",
    preview: [],
  });
  mocks.getChangeInProject.mockResolvedValue({
    id: "c1",
    status: "PROPOSED",
    approvalId: "a1",
  });
  mocks.approvalFindFirst.mockResolvedValue({ id: "a1", status: "PENDING" });
  mocks.applyApprovalDecision.mockResolvedValue(undefined);
  mocks.syncApprovalState.mockResolvedValue("APPROVED");
  mocks.undo.mockResolvedValue({ ok: true });
  mocks.listApplyCandidates.mockResolvedValue([]);
  mocks.remainingLinksOf.mockResolvedValue([]);
  mocks.enable.mockResolvedValue({ key: "abcd1234abcd1234", enabled: true });
  mocks.verify.mockResolvedValue({ ok: true });
  mocks.saveApplySettings.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const name of FLAGS) {
    if (ORIGINAL[name] === undefined) delete process.env[name];
    else process.env[name] = ORIGINAL[name];
  }
});

describe("access and flag order", () => {
  it("checks the session and project access before the flag", async () => {
    flags({ apply: false });
    const result = await proposePublishArticleAction(
      form({ ...BASE, creativeId: "cr1" }),
    );
    expect(result).toEqual({
      ok: false,
      message: "Website changes are not switched on for this project.",
    });
    expect(mocks.requireUser).toHaveBeenCalledOnce();
    expect(mocks.requireProjectAccess).toHaveBeenCalledWith("u1", "p1");
    expect(mocks.requireUser.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.requireProjectAccess.mock.invocationCallOrder[0]!,
    );
    expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("does nothing at all when the flag is off, whatever the action", async () => {
    flags({ apply: false });
    const results = await Promise.all([
      proposePublishArticleAction(form({ ...BASE, creativeId: "cr1" })),
      proposeMakeLiveAction(form({ ...BASE, changeId: "c1" })),
      proposeApplyAction(form({ ...BASE, kind: "TITLE_META", url: "https://a.com/x", title: "T" })),
      decideSeoChangeAction(form({ ...BASE, changeId: "c1", decision: "reject" })),
      undoSeoChangeAction(form({ ...BASE, changeId: "c1" })),
      saveApplySettingsAction(form({ ...BASE, dailyLimit: "5" })),
    ]);
    for (const result of results) expect(result.ok).toBe(false);
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(mocks.applyApprovalDecision).not.toHaveBeenCalled();
    expect(mocks.undo).not.toHaveBeenCalled();
    expect(mocks.saveApplySettings).not.toHaveBeenCalled();
    expect(mocks.approvalFindFirst).not.toHaveBeenCalled();
  });

  it("answers an access error with a fixed message and no detail", async () => {
    mocks.requireProjectAccess.mockRejectedValue(
      new AgentelseError("PERMISSION_DENIED", "User u1 has no access to workspace w9"),
    );
    const result = await proposePublishArticleAction(
      form({ ...BASE, creativeId: "cr1" }),
    );
    expect(result).toEqual({ ok: false, message: "This project isn't available." });
    expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("asks to sign in again when the session is gone", async () => {
    mocks.requireUser.mockRejectedValue(
      new AgentelseError("LOGIN_REQUIRED", "no session"),
    );
    const result = await undoSeoChangeAction(form({ ...BASE, changeId: "c1" }));
    expect(result).toEqual({ ok: false, message: "Please sign in again." });
  });
});

describe("propose actions", () => {
  it("proposes an article draft for any member and reports the change", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    const result = await proposePublishArticleAction(
      form({ ...BASE, creativeId: "cr1" }),
    );
    expect(result).toMatchObject({ ok: true, changeId: "c1" });
    expect(mocks.propose).toHaveBeenCalledWith({
      projectId: "p1",
      userId: "u1",
      kind: "PUBLISH_ARTICLE",
      creativeId: "cr1",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/p1/arama");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/p1/integrations");
  });

  it("is rate limited and rejects a malformed id", async () => {
    mocks.isRateLimited.mockReturnValue(true);
    const limited = await proposePublishArticleAction(
      form({ ...BASE, creativeId: "cr1" }),
    );
    expect(limited.ok).toBe(false);
    expect(mocks.propose).not.toHaveBeenCalled();

    mocks.isRateLimited.mockReturnValue(false);
    const bad = await proposePublishArticleAction(
      form({ ...BASE, creativeId: "x y/../z" }),
    );
    expect(bad.ok).toBe(false);
    expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("passes a refusal message through and never a thrown message", async () => {
    mocks.propose.mockResolvedValueOnce({
      ok: false,
      code: "not_connected",
      message: "Connect WordPress first.",
    });
    const refused = await proposeMakeLiveAction(form({ ...BASE, changeId: "c1" }));
    expect(refused).toEqual({ ok: false, message: "Connect WordPress first." });

    mocks.propose.mockRejectedValueOnce(new Error("secret https://x.example/wp?key=abc"));
    const thrown = await proposeMakeLiveAction(form({ ...BASE, changeId: "c1" }));
    expect(thrown.ok).toBe(false);
    expect(JSON.stringify(thrown)).not.toContain("secret");
  });

  it("fills a title/description proposal from the action when the form has no text", async () => {
    mocks.listApplyCandidates.mockResolvedValue([
      {
        actionId: "act1",
        findingId: "f1",
        kind: "TITLE_META",
        status: "ACCEPTED",
        targetUrl: "https://example.com/pricing",
        after: { title: "New title", metaDescription: "New description" },
        links: [],
      },
    ]);
    const result = await proposeApplyAction(
      form({ ...BASE, kind: "TITLE_META", actionId: "act1" }),
    );
    expect(result.ok).toBe(true);
    expect(mocks.propose).toHaveBeenCalledWith({
      projectId: "p1",
      userId: "u1",
      kind: "TITLE_META",
      url: "https://example.com/pricing",
      title: "New title",
      metaDescription: "New description",
      actionId: "act1",
    });
  });

  it("refuses a title/description proposal without any text", async () => {
    const result = await proposeApplyAction(
      form({ ...BASE, kind: "TITLE_META", url: "https://example.com/x" }),
    );
    expect(result).toEqual({ ok: false, message: "Add a title or a description." });
    expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("creates the action for a finding and proposes at most three links", async () => {
    mocks.ensureActionForFinding.mockResolvedValue({ ok: true, actionId: "act9" });
    const links = JSON.stringify([
      { toUrl: "https://example.com/a", anchor: "alpha" },
      { toUrl: "https://example.com/b", anchor: "beta" },
    ]);
    const result = await proposeApplyAction(
      form({
        ...BASE,
        kind: "INTERNAL_LINKS",
        findingId: "f1",
        url: "https://example.com/blog",
        links,
      }),
    );
    expect(result.ok).toBe(true);
    expect(mocks.ensureActionForFinding).toHaveBeenCalledWith({
      projectId: "p1",
      findingId: "f1",
      userId: "u1",
      workspaceId: "w1",
      brandId: "b1",
    });
    expect(mocks.propose).toHaveBeenCalledWith({
      projectId: "p1",
      userId: "u1",
      kind: "INTERNAL_LINKS",
      url: "https://example.com/blog",
      links: [
        { toUrl: "https://example.com/a", anchor: "alpha" },
        { toUrl: "https://example.com/b", anchor: "beta" },
      ],
      actionId: "act9",
    });

    const tooMany = JSON.stringify(
      Array.from({ length: 4 }, (_, index) => ({
        toUrl: `https://example.com/${index}`,
        anchor: `anchor ${index}`,
      })),
    );
    mocks.propose.mockClear();
    const rejected = await proposeApplyAction(
      form({
        ...BASE,
        kind: "INTERNAL_LINKS",
        actionId: "act9",
        url: "https://example.com/blog",
        links: tooMany,
      }),
    );
    expect(rejected.ok).toBe(false);
    expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("takes the first page's remaining links when none are sent", async () => {
    mocks.remainingLinksOf.mockResolvedValue([
      { fromUrl: "https://example.com/p1", toUrl: "https://example.com/a", anchor: "a1" },
      { fromUrl: "https://example.com/p2", toUrl: "https://example.com/b", anchor: "b1" },
      { fromUrl: "https://example.com/p1", toUrl: "https://example.com/c", anchor: "c1" },
    ]);
    await proposeApplyAction(
      form({ ...BASE, kind: "INTERNAL_LINKS", actionId: "act2" }),
    );
    expect(mocks.propose).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/p1",
        links: [
          { toUrl: "https://example.com/a", anchor: "a1" },
          { toUrl: "https://example.com/c", anchor: "c1" },
        ],
      }),
    );
  });

  it("does not propose when the finding has no action to link", async () => {
    mocks.ensureActionForFinding.mockResolvedValue({ ok: false });
    const result = await proposeApplyAction(
      form({ ...BASE, kind: "INTERNAL_LINKS", findingId: "f1" }),
    );
    expect(result.ok).toBe(false);
    expect(mocks.propose).not.toHaveBeenCalled();
  });
});

describe("decideSeoChangeAction", () => {
  it("refuses approval for a member before any approval or change read", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    const result = await decideSeoChangeAction(
      form({ ...BASE, changeId: "c1", decision: "approve" }),
    );
    expect(result).toEqual({
      ok: false,
      message: "Only a workspace owner or admin can approve this.",
    });
    expect(mocks.getChangeInProject).not.toHaveBeenCalled();
    expect(mocks.approvalFindFirst).not.toHaveBeenCalled();
    expect(mocks.applyApprovalDecision).not.toHaveBeenCalled();
    expect(mocks.syncApprovalState).not.toHaveBeenCalled();
  });

  it("approves as a manager and then syncs the change", async () => {
    const result = await decideSeoChangeAction(
      form({ ...BASE, changeId: "c1", decision: "approve" }),
    );
    expect(result).toMatchObject({ ok: true, changeId: "c1" });
    expect(mocks.applyApprovalDecision).toHaveBeenCalledWith({
      approval: { id: "a1", status: "PENDING" },
      to: "APPROVED",
      reviewedByUserId: "u1",
      actorType: "USER",
    });
    expect(mocks.syncApprovalState).toHaveBeenCalledWith("c1");
    expect(mocks.applyApprovalDecision.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.syncApprovalState.mock.invocationCallOrder[0]!,
    );
    expect(mocks.approvalFindFirst).toHaveBeenCalledWith({
      where: { id: "a1", projectId: "p1" },
    });
  });

  it("leaves the reject role check to the approval gate", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    const result = await decideSeoChangeAction(
      form({ ...BASE, changeId: "c1", decision: "reject" }),
    );
    expect(result.ok).toBe(true);
    expect(mocks.isWorkspaceManager).not.toHaveBeenCalled();
    expect(mocks.applyApprovalDecision).toHaveBeenCalledWith(
      expect.objectContaining({ to: "REJECTED" }),
    );
    expect(mocks.syncApprovalState).toHaveBeenCalledWith("c1");
  });

  it("does not decide twice: a settled approval only syncs the row", async () => {
    mocks.approvalFindFirst.mockResolvedValue({ id: "a1", status: "REJECTED" });
    const result = await decideSeoChangeAction(
      form({ ...BASE, changeId: "c1", decision: "approve" }),
    );
    expect(result).toEqual({
      ok: false,
      message: "This change is no longer waiting for a decision.",
    });
    expect(mocks.applyApprovalDecision).not.toHaveBeenCalled();
    expect(mocks.syncApprovalState).toHaveBeenCalledWith("c1");
  });

  it("keeps the decision when the sync fails afterwards", async () => {
    mocks.syncApprovalState.mockRejectedValue(new Error("boom"));
    const result = await decideSeoChangeAction(
      form({ ...BASE, changeId: "c1", decision: "approve" }),
    );
    expect(result.ok).toBe(true);
  });

  it("shows a fixed message when the decision gate refuses the role", async () => {
    mocks.applyApprovalDecision.mockRejectedValue(
      new AgentelseError("PERMISSION_DENIED", "internal detail"),
    );
    const approve = await decideSeoChangeAction(
      form({ ...BASE, changeId: "c1", decision: "approve" }),
    );
    expect(approve).toEqual({
      ok: false,
      message: "Only a workspace owner or admin can approve this.",
    });
    const reject = await decideSeoChangeAction(
      form({ ...BASE, changeId: "c1", decision: "reject" }),
    );
    expect(reject).toEqual({
      ok: false,
      message: "Only a workspace owner or admin can reject this.",
    });
  });

  it("rejects an unknown decision and a missing change", async () => {
    const unknown = await decideSeoChangeAction(
      form({ ...BASE, changeId: "c1", decision: "maybe" }),
    );
    expect(unknown.ok).toBe(false);
    mocks.getChangeInProject.mockResolvedValue(null);
    const missing = await decideSeoChangeAction(
      form({ ...BASE, changeId: "c1", decision: "reject" }),
    );
    expect(missing).toEqual({ ok: false, message: "This change was not found." });
  });
});

describe("undoSeoChangeAction", () => {
  it("is manager only and checks the role in the action", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    const result = await undoSeoChangeAction(form({ ...BASE, changeId: "c1" }));
    expect(result).toEqual({
      ok: false,
      message: "Only a workspace owner or admin can undo this.",
    });
    expect(mocks.undo).not.toHaveBeenCalled();
  });

  it("undoes for a manager and passes the engine message through", async () => {
    const ok = await undoSeoChangeAction(form({ ...BASE, changeId: "c1" }));
    expect(ok).toMatchObject({ ok: true, changeId: "c1" });
    expect(mocks.undo).toHaveBeenCalledWith({
      projectId: "p1",
      changeId: "c1",
      userId: "u1",
    });
    mocks.undo.mockResolvedValue({ ok: false, message: "Fixed engine text." });
    const failed = await undoSeoChangeAction(form({ ...BASE, changeId: "c1" }));
    expect(failed).toEqual({ ok: false, message: "Fixed engine text." });
  });
});

describe("settings and IndexNow", () => {
  it("saves the daily limit for a manager only, within the range", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    const member = await saveApplySettingsAction(form({ ...BASE, dailyLimit: "5" }));
    expect(member.ok).toBe(false);
    expect(mocks.saveApplySettings).not.toHaveBeenCalled();

    mocks.isWorkspaceManager.mockResolvedValue(true);
    for (const bad of ["0", "26", "abc", "", "2.5"]) {
      const result = await saveApplySettingsAction(form({ ...BASE, dailyLimit: bad }));
      expect(result.ok).toBe(false);
    }
    expect(mocks.saveApplySettings).not.toHaveBeenCalled();

    const saved = await saveApplySettingsAction(form({ ...BASE, dailyLimit: "12" }));
    expect(saved.ok).toBe(true);
    expect(mocks.saveApplySettings).toHaveBeenCalledWith({
      projectId: "p1",
      workspaceId: "w1",
      userId: "u1",
      dailyLimit: 12,
    });
  });

  it("does nothing for IndexNow while SEO_INDEXNOW is off", async () => {
    flags({ apply: true, indexNow: false });
    const results = await Promise.all([
      indexNowEnableAction(form(BASE)),
      indexNowVerifyAction(form(BASE)),
      indexNowDisableAction(form(BASE)),
    ]);
    for (const result of results) {
      expect(result).toEqual({
        ok: false,
        message: "IndexNow is not switched on for this project.",
      });
    }
    expect(mocks.enable).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.disable).not.toHaveBeenCalled();
  });

  it("allows IndexNow actions for managers only", async () => {
    flags({ apply: true, indexNow: true });
    mocks.isWorkspaceManager.mockResolvedValue(false);
    const results = await Promise.all([
      indexNowEnableAction(form(BASE)),
      indexNowVerifyAction(form(BASE)),
      indexNowDisableAction(form(BASE)),
    ]);
    for (const result of results) expect(result.ok).toBe(false);
    expect(mocks.enable).not.toHaveBeenCalled();

    mocks.isWorkspaceManager.mockResolvedValue(true);
    expect((await indexNowEnableAction(form(BASE))).ok).toBe(true);
    expect(mocks.enable).toHaveBeenCalledWith("p1", "w1", "u1");
    expect((await indexNowVerifyAction(form(BASE))).ok).toBe(true);
    expect(mocks.verify).toHaveBeenCalledWith("p1", "u1");
    expect((await indexNowDisableAction(form(BASE))).ok).toBe(true);
    expect(mocks.disable).toHaveBeenCalledWith("p1", "u1");
  });

  it("passes the verification refusal through", async () => {
    flags({ apply: true, indexNow: true });
    mocks.verify.mockResolvedValue({ ok: false, message: "Switch IndexNow on first." });
    const result = await indexNowVerifyAction(form(BASE));
    expect(result).toEqual({ ok: false, message: "Switch IndexNow on first." });
  });
});
