import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  isWorkspaceManager: vi.fn(),
  revalidatePath: vi.fn(),
  linkFindFirst: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  makePrimary: vi.fn(),
  save: vi.fn(),
  preview: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/prisma", () => ({
  prisma: { gscSiteLink: { findFirst: mocks.linkFindFirst } },
}));
vi.mock("@/server/integrations/search-console/search-analytics", () => ({
  gscMockMode: () => false,
}));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireProjectAccess: mocks.requireProjectAccess,
  isWorkspaceManager: mocks.isWorkspaceManager,
}));
vi.mock("@/server/seo/agency/sites", () => ({
  GscSites: { add: mocks.add, remove: mocks.remove, makePrimary: mocks.makePrimary },
}));
vi.mock("@/server/seo/agency/page-groups", () => ({
  GscPageGroups: { save: mocks.save, preview: mocks.preview },
}));

const {
  addSecondarySiteAction,
  makePrimarySiteAction,
  previewPageGroupRulesAction,
  removeSecondarySiteAction,
  savePageGroupRulesAction,
} = await import("./gsc-sites-actions");

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const RULES = JSON.stringify([
  { group: "/shop/reviews", match: "GLOB", pattern: "/shop/*/reviews" },
]);

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("GSC_AGENCY", "true");
  vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
  vi.stubEnv("GSC_SYNC_DEV_PROJECTS", "");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireUser.mockResolvedValue({ userId: "u1" });
  mocks.requireProjectAccess.mockResolvedValue({ workspaceId: "ws-1" });
  mocks.isWorkspaceManager.mockResolvedValue(true);
  mocks.linkFindFirst.mockResolvedValue({ id: "l1" });
  mocks.add.mockResolvedValue({ ok: true, linkId: "l1" });
  mocks.remove.mockResolvedValue({ ok: true });
  mocks.makePrimary.mockResolvedValue({ ok: true });
  mocks.save.mockResolvedValue({ ok: true, version: 1 });
  mocks.preview.mockResolvedValue({ groups: [], changed: 0, unmatched: 0, sampled: 0 });
});

describe("guards", () => {
  it("refuses non-managers before touching any store", async () => {
    mocks.isWorkspaceManager.mockResolvedValue(false);
    const message = "Only workspace owners and admins can change this.";
    expect(await addSecondarySiteAction(form({ projectId: "p", siteUrl: "s" }))).toEqual({ ok: false, message });
    expect(await removeSecondarySiteAction(form({ projectId: "p", linkId: "l" }))).toEqual({ ok: false, message });
    expect(await makePrimarySiteAction(form({ projectId: "p", linkId: "l" }))).toEqual({ ok: false, message });
    expect(await savePageGroupRulesAction(form({ projectId: "p", linkId: "l", rules: RULES }))).toEqual({ ok: false, message });
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("is 'Not available' when the flag is off, before the manager check", async () => {
    vi.stubEnv("GSC_AGENCY", "");
    expect(await addSecondarySiteAction(form({ projectId: "p", siteUrl: "s" }))).toEqual({
      ok: false,
      message: "Not available",
    });
    expect(mocks.isWorkspaceManager).not.toHaveBeenCalled();
  });

  it("runs the checks in order: user, project access, flag, manager", async () => {
    const order: string[] = [];
    mocks.requireUser.mockImplementation(async () => (order.push("user"), { userId: "u1" }));
    mocks.requireProjectAccess.mockImplementation(async () => (order.push("access"), { workspaceId: "ws-1" }));
    mocks.isWorkspaceManager.mockImplementation(async () => (order.push("manager"), true));
    await addSecondarySiteAction(form({ projectId: "p", siteUrl: "s" }));
    expect(order).toEqual(["user", "access", "manager"]);
  });

  it("returns fixed copy and never the raw error text", async () => {
    const { AgentelseError } = await import("@/server/security/errors");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run = () => addSecondarySiteAction(form({ projectId: "p", siteUrl: "s" }));
    mocks.requireProjectAccess.mockRejectedValue(
      new AgentelseError("PERMISSION_DENIED", "User u1 has no access to workspace w9"),
    );
    expect(await run()).toEqual({ ok: false, message: "This project isn't available." });
    mocks.requireProjectAccess.mockRejectedValue(
      new AgentelseError("SESSION_EXPIRED", "Session expired for u1"),
    );
    expect(await run()).toEqual({ ok: false, message: "Please sign in again." });
    mocks.requireProjectAccess.mockRejectedValue(new Error("Unique constraint failed on GscSiteLink"));
    expect(await run()).toEqual({ ok: false, message: "Operation failed" });
    spy.mockRestore();
  });
});

describe("site actions", () => {
  it("maps add codes to fixed messages and revalidates on success", async () => {
    mocks.add.mockResolvedValue({ ok: false, code: "LIMIT" });
    expect(await addSecondarySiteAction(form({ projectId: "p", siteUrl: "s" }))).toEqual({
      ok: false,
      message: "A project can track up to 5 Search Console sites.",
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    mocks.add.mockResolvedValue({ ok: true, linkId: "l1" });
    expect(await addSecondarySiteAction(form({ projectId: "p", siteUrl: "s" }))).toEqual({ ok: true });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/p/arama");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/search");
  });

  it("passes the link id to remove and make-primary", async () => {
    await removeSecondarySiteAction(form({ projectId: "p", linkId: "l9" }));
    expect(mocks.remove).toHaveBeenCalledWith({ projectId: "p", linkId: "l9", userId: "u1" });
    await makePrimarySiteAction(form({ projectId: "p", linkId: "l9" }));
    expect(mocks.makePrimary).toHaveBeenCalledWith({ projectId: "p", linkId: "l9", userId: "u1" });
  });
});

describe("page group actions", () => {
  it("surfaces the first validation error and saves nothing", async () => {
    const bad = JSON.stringify([
      { group: "no-slash", match: "PREFIX", pattern: "/a" },
      { group: "/ok", match: "GLOB", pattern: "/x/**/y" },
    ]);
    const result = await savePageGroupRulesAction(form({ projectId: "p", linkId: "l1", rules: bad }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/^Rule 1: /);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("rejects bad JSON and oversized input", async () => {
    expect(await savePageGroupRulesAction(form({ projectId: "p", linkId: "l1", rules: "{" }))).toEqual({
      ok: false,
      message: "Invalid rules",
    });
    const big = JSON.stringify([{ group: "/a", match: "PREFIX", pattern: `/${"a".repeat(30_000)}` }]);
    expect(await savePageGroupRulesAction(form({ projectId: "p", linkId: "l1", rules: big }))).toEqual({
      ok: false,
      message: "The rules are too long.",
    });
  });

  it("refuses a link that does not belong to the project", async () => {
    mocks.linkFindFirst.mockResolvedValue(null);
    expect(await savePageGroupRulesAction(form({ projectId: "p", linkId: "foreign", rules: RULES }))).toEqual({
      ok: false,
      message: "Site not found",
    });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(
      await previewPageGroupRulesAction({
        projectId: "p",
        linkId: "foreign",
        rules: [{ group: "/a", match: "PREFIX", pattern: "/a" }],
      }),
    ).toEqual({ ok: false, message: "Site not found" });
  });

  it("saves validated rules and previews read-only", async () => {
    expect(await savePageGroupRulesAction(form({ projectId: "p", linkId: "l1", rules: RULES }))).toEqual({ ok: true });
    const saved = mocks.save.mock.calls[0]?.[0];
    expect(saved).toMatchObject({ projectId: "p", linkId: "l1", userId: "u1" });
    expect(saved.rules.rules[0]).toMatchObject({ group: "/shop/reviews", match: "GLOB" });

    const preview = await previewPageGroupRulesAction({
      projectId: "p",
      linkId: "l1",
      rules: [{ group: "/a", match: "PREFIX", pattern: "/a" }],
    });
    expect(preview.ok).toBe(true);
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(2);
  });
});
