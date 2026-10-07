import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı (SC-F6 Actions & results eylemleri): bayrak ve açılış
// listesi kapalıyken hiçbir iş yapılmaz; dakikada sınır uygulanır; "Fix this"
// sonucu href ile döner; Mark as done APPLY geçişi yapıp doğrulamayı after() ile
// sıraya koyar; Check now çok sık basılınca anlaşılır mesaj verir; dismiss,
// "Not done yet" ve "It's live" doğru olayı gönderir; "I fixed this" eylemi
// açar; hata metni istemciye sızmaz.

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isRateLimited: vi.fn(),
  revalidatePath: vi.fn(),
  fixFinding: vi.fn(),
  trackHealthFix: vi.fn(),
  transitionAction: vi.fn(),
  requestCheckNow: vi.fn(),
  runAction: vi.fn(),
  afterFns: [] as (() => unknown)[],
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/server", () => ({
  after: (fn: () => unknown) => {
    mocks.afterFns.push(fn);
  },
}));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: mocks.isRateLimited }));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
}));
vi.mock("@/server/seo/actions/fix-this", () => ({
  fixFinding: mocks.fixFinding,
  trackHealthFix: mocks.trackHealthFix,
}));
vi.mock("@/server/seo/actions/store", () => ({
  transitionAction: mocks.transitionAction,
  requestCheckNow: mocks.requestCheckNow,
}));
vi.mock("@/server/seo/actions/verify", () => ({
  SeoActionVerifier: { runAction: mocks.runAction },
}));

const {
  fixOpportunity,
  markActionAppliedAction,
  undoActionAppliedAction,
  dismissActionAction,
  confirmActionLiveAction,
  checkActionNowAction,
  trackHealthFixAction,
} = await import("./seo-action-actions");

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const actionForm = () => form({ projectId: "project-1", actionId: "act-1" });

beforeEach(() => {
  mocks.afterFns.length = 0;
  vi.stubEnv("SEO_ACTIONS", "true");
  vi.stubEnv("SEO_HEALTH", "true");
  vi.stubEnv("SEO_CRAWL", "true");
  mocks.requireUser.mockResolvedValue({ userId: "user-1" });
  mocks.requireProjectAccess.mockResolvedValue({
    workspaceId: "workspace-1",
    defaultBrandId: "brand-1",
  });
  mocks.isRateLimited.mockReturnValue(false);
  mocks.transitionAction.mockResolvedValue({ ok: true, action: {} });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("gate", () => {
  it("does nothing when the loop flag is off", async () => {
    vi.stubEnv("SEO_ACTIONS", "");
    const result = await markActionAppliedAction(actionForm());
    expect(result).toEqual({
      ok: false,
      message: "Tracking changes isn't turned on.",
    });
    expect(mocks.transitionAction).not.toHaveBeenCalled();
    expect(await fixOpportunity("project-1", "finding-1")).toMatchObject({
      ok: false,
    });
    expect(mocks.fixFinding).not.toHaveBeenCalled();
  });

  it("does nothing outside the rollout allow-list", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SEO_ROLLOUT_PROJECTS", "someone-else");
    const result = await dismissActionAction(actionForm());
    expect(result.ok).toBe(false);
    expect(mocks.transitionAction).not.toHaveBeenCalled();
  });

  it("rate limits per user", async () => {
    mocks.isRateLimited.mockReturnValue(true);
    const result = await markActionAppliedAction(actionForm());
    expect(result).toEqual({ ok: false, message: "Slow down for a moment." });
    expect(mocks.isRateLimited).toHaveBeenCalledWith(
      "seo-actions:user-1",
      60,
      600_000,
    );
    expect(mocks.transitionAction).not.toHaveBeenCalled();
  });

  it("rejects malformed ids", async () => {
    const result = await markActionAppliedAction(
      form({ projectId: "project-1", actionId: "../x" }),
    );
    expect(result).toMatchObject({ ok: false });
    expect(mocks.transitionAction).not.toHaveBeenCalled();
    expect(await fixOpportunity("project-1", "bad id")).toMatchObject({
      ok: false,
    });
  });

  it("does not leak access error details", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.requireProjectAccess.mockRejectedValue(
      new Error("project secret-project in workspace w-1 not found"),
    );
    const result = await markActionAppliedAction(actionForm());
    expect(result).toEqual({
      ok: false,
      message: "The change could not be updated",
    });
  });
});

describe("fixOpportunity", () => {
  it("passes the user's scope and returns the href", async () => {
    mocks.fixFinding.mockResolvedValue({
      ok: true,
      actionId: "act-1",
      href: "/projects/project-1?work=seofix_act-1",
      opened: "manager",
    });
    const result = await fixOpportunity("project-1", "finding-1");
    expect(result).toEqual({
      ok: true,
      actionId: "act-1",
      href: "/projects/project-1?work=seofix_act-1",
      opened: "manager",
    });
    expect(mocks.fixFinding).toHaveBeenCalledWith({
      projectId: "project-1",
      findingId: "finding-1",
      userId: "user-1",
      workspaceId: "workspace-1",
      brandId: "brand-1",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/projects/project-1/arama",
    );
  });

  it("returns the failure message untouched", async () => {
    mocks.fixFinding.mockResolvedValue({
      ok: false,
      message: "This opportunity is no longer open.",
    });
    expect(await fixOpportunity("project-1", "finding-1")).toEqual({
      ok: false,
      message: "This opportunity is no longer open.",
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("transitions", () => {
  it("Mark as done sends APPLY and verifies after the response", async () => {
    const result = await markActionAppliedAction(actionForm());
    expect(result.ok).toBe(true);
    expect(mocks.transitionAction).toHaveBeenCalledWith({
      projectId: "project-1",
      actionId: "act-1",
      event: "APPLY",
      userId: "user-1",
    });
    expect(mocks.afterFns).toHaveLength(1);
    expect(mocks.runAction).not.toHaveBeenCalled();
    await mocks.afterFns[0]!();
    expect(mocks.runAction).toHaveBeenCalledWith("act-1");
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/projects/project-1/arama",
    );
  });

  it("does not verify when the transition is invalid", async () => {
    mocks.transitionAction.mockResolvedValue({
      ok: false,
      reason: "invalid_transition",
    });
    const result = await markActionAppliedAction(actionForm());
    expect(result).toEqual({
      ok: false,
      message: "This change can't be updated right now.",
    });
    expect(mocks.afterFns).toHaveLength(0);
    mocks.transitionAction.mockResolvedValue({
      ok: false,
      reason: "not_found",
    });
    expect(await markActionAppliedAction(actionForm())).toEqual({
      ok: false,
      message: "This change is no longer tracked.",
    });
  });

  it.each([
    ["Not done yet", undoActionAppliedAction, "UNDO_APPLY"],
    ["Dismiss", dismissActionAction, "DISMISS"],
    ["It's live", confirmActionLiveAction, "CONFIRM_LIVE"],
  ] as const)("%s sends %s", async (_label, action, event) => {
    const result = await action(actionForm());
    expect(result.ok).toBe(true);
    expect(mocks.transitionAction).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "act-1", event, userId: "user-1" }),
    );
    expect(mocks.afterFns).toHaveLength(0);
  });
});

describe("checkActionNowAction", () => {
  it("queues the check and verifies after the response", async () => {
    mocks.requestCheckNow.mockResolvedValue("queued");
    const result = await checkActionNowAction(actionForm());
    expect(result.ok).toBe(true);
    expect(mocks.requestCheckNow).toHaveBeenCalledWith("project-1", "act-1");
    expect(mocks.afterFns).toHaveLength(1);
  });

  it("explains a too-soon request", async () => {
    mocks.requestCheckNow.mockResolvedValue("too_soon");
    expect(await checkActionNowAction(actionForm())).toEqual({
      ok: false,
      message: "We checked this a few minutes ago. Try again shortly.",
    });
    expect(mocks.afterFns).toHaveLength(0);
  });

  it("explains an action that cannot be checked", async () => {
    mocks.requestCheckNow.mockResolvedValue("not_found");
    expect(await checkActionNowAction(actionForm())).toEqual({
      ok: false,
      message: "This change can't be checked right now.",
    });
  });
});

describe("trackHealthFixAction", () => {
  const health = () => form({ projectId: "project-1", alertId: "alert-1" });

  it("tracks the issue and verifies once", async () => {
    mocks.trackHealthFix.mockResolvedValue({ ok: true, actionId: "act-5" });
    const result = await trackHealthFixAction(health());
    expect(result.ok).toBe(true);
    expect(mocks.trackHealthFix).toHaveBeenCalledWith({
      projectId: "project-1",
      alertId: "alert-1",
      userId: "user-1",
      workspaceId: "workspace-1",
    });
    await mocks.afterFns[0]!();
    expect(mocks.runAction).toHaveBeenCalledWith("act-5");
  });

  it("returns the failure message and does not verify", async () => {
    mocks.trackHealthFix.mockResolvedValue({
      ok: false,
      message: "This issue is no longer open.",
    });
    expect(await trackHealthFixAction(health())).toEqual({
      ok: false,
      message: "This issue is no longer open.",
    });
    expect(mocks.afterFns).toHaveLength(0);
  });
});
