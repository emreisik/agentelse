import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: {
    gscSiteSetting: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    gscSiteLink: { findFirst: vi.fn(), findUnique: vi.fn() },
    gscPage: { findMany: vi.fn(), groupBy: vi.fn() },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
  },
  audit: vi.fn(),
  mock: false,
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.db }));
vi.mock("@/server/integrations/search-console/search-analytics", () => ({
  gscMockMode: () => mocks.mock,
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.audit },
}));

const { GscPageGroups, pageGroupRulesForLink } = await import("./page-groups");

const RULES = {
  v: 1,
  rules: [{ id: "r1", group: "/shop/reviews", match: "GLOB", pattern: "/shop/*/reviews" }],
} as const;

const link = { id: "link-1", projectId: "proj-1", siteUrl: "sc-domain:a.com", isMock: false };

function page(id: string, path: string, pageGroup: string | null) {
  return { id, path, pageGroup };
}

function setting(overrides: Record<string, unknown> = {}) {
  return {
    id: "set-1",
    isMock: false,
    pageGroupRules: RULES,
    rulesVersion: 2,
    groupsCursor: null,
    groupsLeaseUntil: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("GSC_AGENCY", "true");
  vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
  vi.stubEnv("GSC_SYNC_DEV_PROJECTS", "");
  mocks.mock = false;
  mocks.audit.mockReset().mockResolvedValue({});
  for (const group of Object.values(mocks.db)) {
    if (typeof group === "function") {
      (group as ReturnType<typeof vi.fn>).mockReset();
      continue;
    }
    for (const fn of Object.values(group)) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  mocks.db.gscSiteSetting.updateMany.mockResolvedValue({ count: 1 });
  mocks.db.$executeRaw.mockResolvedValue(1);
  mocks.db.gscSiteLink.findUnique.mockResolvedValue({
    ...link,
    lastWeeklyWeek: "2026-09-28",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pageGroupRulesForLink", () => {
  it("returns null without any prisma call when the flag is off", async () => {
    vi.stubEnv("GSC_AGENCY", "");
    expect(await pageGroupRulesForLink({ ...link, id: "off-1" })).toBeNull();
    expect(mocks.db.gscSiteSetting.findUnique).not.toHaveBeenCalled();
  });

  it("memoises the rules for 30 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
    mocks.db.gscSiteSetting.findUnique.mockResolvedValue(setting());
    const probe = { ...link, id: "memo-1" };
    const first = await pageGroupRulesForLink(probe);
    expect(first?.rules).toHaveLength(1);
    await pageGroupRulesForLink(probe);
    expect(mocks.db.gscSiteSetting.findUnique).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-10-07T10:00:31Z"));
    await pageGroupRulesForLink(probe);
    expect(mocks.db.gscSiteSetting.findUnique).toHaveBeenCalledTimes(2);
  });

  it("returns null for empty rules and for a setting of the other mode", async () => {
    mocks.db.gscSiteSetting.findUnique.mockResolvedValue(
      setting({ pageGroupRules: { v: 1, rules: [] } }),
    );
    expect(await pageGroupRulesForLink({ ...link, id: "empty-1" })).toBeNull();
    mocks.db.gscSiteSetting.findUnique.mockResolvedValue(setting({ isMock: true }));
    expect(await pageGroupRulesForLink({ ...link, id: "mode-1" })).toBeNull();
  });
});

describe("GscPageGroups.save", () => {
  beforeEach(() => {
    mocks.db.gscSiteLink.findFirst.mockResolvedValue({
      id: "link-1",
      workspaceId: "ws-1",
      siteUrl: "sc-domain:a.com",
    });
  });

  it("bumps the version, resets the cursor, clears the memo and audits", async () => {
    mocks.db.gscSiteSetting.findUnique.mockResolvedValue(setting());
    // Not defterini doldur.
    await pageGroupRulesForLink({ ...link, id: "link-1" });
    mocks.db.gscSiteSetting.findUnique.mockClear();
    mocks.db.gscSiteSetting.findUnique.mockResolvedValue({ id: "set-1", isMock: false });
    mocks.db.gscSiteSetting.update.mockResolvedValue({ rulesVersion: 3 });

    const result = await GscPageGroups.save({
      projectId: "proj-1",
      linkId: "link-1",
      rules: { v: 1, rules: [] },
      userId: "u1",
    });
    expect(result).toEqual({ ok: true, version: 3 });
    expect(mocks.db.gscSiteSetting.update).toHaveBeenCalledWith({
      where: { id: "set-1" },
      data: {
        pageGroupRules: { v: 1, rules: [] },
        rulesVersion: { increment: 1 },
        groupsCursor: null,
      },
      select: { rulesVersion: true },
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "gsc_page_groups.saved", entityType: "GscSiteSetting" }),
    );
    // Not defteri silindi: sonraki okuma yeniden sorgular.
    mocks.db.gscSiteSetting.findUnique.mockResolvedValue(setting());
    await pageGroupRulesForLink({ ...link, id: "link-1" });
    expect(mocks.db.gscSiteSetting.findUnique).toHaveBeenCalledTimes(2);
  });

  it("creates the setting at version 1 when none exists", async () => {
    mocks.db.gscSiteSetting.findUnique.mockResolvedValue(null);
    mocks.db.gscSiteSetting.create.mockResolvedValue({ rulesVersion: 1 });
    const result = await GscPageGroups.save({
      projectId: "proj-1",
      linkId: "link-1",
      rules: RULES as never,
      userId: "u1",
    });
    expect(result).toEqual({ ok: true, version: 1 });
  });

  it("refuses a foreign link, the other mode and the flag-off state", async () => {
    mocks.db.gscSiteLink.findFirst.mockResolvedValue(null);
    expect(
      await GscPageGroups.save({ projectId: "proj-1", linkId: "x", rules: RULES as never, userId: "u" }),
    ).toMatchObject({ ok: false });
    mocks.db.gscSiteLink.findFirst.mockResolvedValue({ id: "l", workspaceId: "w", siteUrl: "s" });
    mocks.db.gscSiteSetting.findUnique.mockResolvedValue({ id: "s", isMock: true });
    expect(
      await GscPageGroups.save({ projectId: "proj-1", linkId: "l", rules: RULES as never, userId: "u" }),
    ).toMatchObject({ ok: false });
    vi.stubEnv("GSC_AGENCY", "");
    mocks.db.gscSiteLink.findFirst.mockClear();
    expect(
      await GscPageGroups.save({ projectId: "proj-1", linkId: "l", rules: RULES as never, userId: "u" }),
    ).toMatchObject({ ok: false });
    expect(mocks.db.gscSiteLink.findFirst).not.toHaveBeenCalled();
  });
});

describe("GscPageGroups.read", () => {
  it("is empty without a query when the flag is off", async () => {
    vi.stubEnv("GSC_AGENCY", "");
    const state = await GscPageGroups.read("proj-1", "sc-domain:a.com");
    expect(state.rules.rules).toEqual([]);
    expect(mocks.db.gscSiteSetting.findUnique).not.toHaveBeenCalled();
  });

  it("reports applying while the applied version lags", async () => {
    mocks.db.gscSiteSetting.findUnique.mockResolvedValue(
      setting({ groupsAppliedVersion: 1, groupsAppliedWeek: null }),
    );
    expect(await GscPageGroups.read("proj-1", "sc-domain:a.com")).toMatchObject({
      version: 2,
      appliedVersion: 1,
      applying: true,
    });
  });
});

describe("GscPageGroups.regroupLink", () => {
  it("writes only the rows whose group changes and finishes the setting", async () => {
    mocks.db.gscSiteSetting.findUnique.mockResolvedValue(setting());
    mocks.db.gscPage.findMany.mockResolvedValue([
      page("a", "/shop/x/reviews", "/shop"),
      page("b", "/shop/y/reviews", "/shop/reviews"),
      page("c", "/blog/p", "/blog"),
    ]);
    const result = await GscPageGroups.regroupLink("link-1");
    expect(result).toEqual({ updated: 1, done: true });
    expect(mocks.db.$executeRaw).toHaveBeenCalledTimes(1);
    const sql = mocks.db.$executeRaw.mock.calls[0]?.[1] as { values: unknown[] };
    expect(sql.values).toContain("a");
    expect(sql.values).not.toContain("b");
    expect(mocks.db.gscSiteSetting.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ rulesVersion: 2 }),
        data: expect.objectContaining({
          groupsAppliedVersion: 2,
          groupsAppliedWeek: "2026-09-28",
          groupsCursor: null,
        }),
      }),
    );
  });

  it("resumes from the saved cursor and scans in id order", async () => {
    mocks.db.gscSiteSetting.findUnique.mockResolvedValue(setting({ groupsCursor: "p-100" }));
    mocks.db.gscPage.findMany.mockResolvedValue([]);
    await GscPageGroups.regroupLink("link-1");
    expect(mocks.db.gscPage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { linkId: "link-1", id: { gt: "p-100" } },
        orderBy: { id: "asc" },
        take: 2000,
      }),
    );
    expect(mocks.db.$executeRaw).not.toHaveBeenCalled();
  });

  it("respects a live lease and a lost claim", async () => {
    mocks.db.gscSiteSetting.findUnique.mockResolvedValue(
      setting({ groupsLeaseUntil: new Date(Date.now() + 60_000) }),
    );
    expect(await GscPageGroups.regroupLink("link-1")).toEqual({ updated: 0, done: false });
    expect(mocks.db.gscSiteSetting.updateMany).not.toHaveBeenCalled();

    mocks.db.gscSiteSetting.findUnique.mockResolvedValue(setting());
    mocks.db.gscSiteSetting.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await GscPageGroups.regroupLink("link-1")).toEqual({ updated: 0, done: false });
    expect(mocks.db.gscPage.findMany).not.toHaveBeenCalled();
  });

  it("applies default groups when the rules are empty", async () => {
    mocks.db.gscSiteSetting.findUnique.mockResolvedValue(
      setting({ pageGroupRules: { v: 1, rules: [] } }),
    );
    mocks.db.gscPage.findMany.mockResolvedValue([
      page("a", "/shop/x/reviews", "/shop/reviews"),
      page("b", "/", null),
    ]);
    const result = await GscPageGroups.regroupLink("link-1");
    expect(result.updated).toBe(2);
    const sql = mocks.db.$executeRaw.mock.calls[0]?.[1] as { values: unknown[] };
    expect(sql.values).toEqual(expect.arrayContaining(["a", "/shop", "b", "/"]));
  });

  it("stops when a save bumped the version mid-pass and releases the lease", async () => {
    mocks.db.gscSiteSetting.findUnique.mockResolvedValue(setting());
    mocks.db.gscPage.findMany.mockResolvedValue(
      Array.from({ length: 2000 }, (_, at) => page(`p${at}`, "/a", "/a")),
    );
    mocks.db.gscSiteSetting.updateMany
      .mockResolvedValueOnce({ count: 1 }) // kilit
      .mockResolvedValueOnce({ count: 0 }) // imleç: sürüm değişti
      .mockResolvedValue({ count: 1 }); // bırakma
    const result = await GscPageGroups.regroupLink("link-1");
    expect(result.done).toBe(false);
    expect(mocks.db.gscSiteSetting.updateMany).toHaveBeenLastCalledWith({
      where: expect.objectContaining({ id: "set-1" }),
      data: { groupsLeaseUntil: null, groupsLeaseOwner: null },
    });
  });

  it("stops at the time budget and keeps the cursor", async () => {
    mocks.db.gscSiteSetting.findUnique.mockResolvedValue(setting());
    const result = await GscPageGroups.regroupLink("link-1", { budgetMs: 0 });
    expect(result).toEqual({ updated: 0, done: false });
    expect(mocks.db.gscPage.findMany).not.toHaveBeenCalled();
  });
});

describe("GscPageGroups.regroupDue", () => {
  it("is 0 without a query when the flag is off", async () => {
    vi.stubEnv("GSC_AGENCY", "");
    expect(await GscPageGroups.regroupDue()).toBe(0);
    expect(mocks.db.$queryRaw).not.toHaveBeenCalled();
  });

  it("skips a dev-guarded project", async () => {
    vi.stubEnv("GSC_ROLLOUT_PROJECTS", "other");
    mocks.db.$queryRaw.mockResolvedValue([{ linkId: "link-1", projectId: "proj-1" }]);
    expect(await GscPageGroups.regroupDue(2)).toBe(0);
    expect(mocks.db.gscSiteLink.findUnique).not.toHaveBeenCalled();
  });

  it("handles at most the limit and stops starting links after the deadline", async () => {
    mocks.db.$queryRaw.mockResolvedValue([
      { linkId: "l1", projectId: "p1" },
      { linkId: "l2", projectId: "p2" },
      { linkId: "l3", projectId: "p3" },
    ]);
    mocks.db.gscSiteLink.findUnique.mockResolvedValue(null);
    expect(await GscPageGroups.regroupDue(2)).toBe(2);

    mocks.db.gscSiteLink.findUnique.mockClear();
    expect(await GscPageGroups.regroupDue(2, new Date(), Date.now() - 1)).toBe(0);
    expect(mocks.db.gscSiteLink.findUnique).not.toHaveBeenCalled();
  });
});

describe("GscPageGroups.listGroups and preview", () => {
  it("lists groups by size and drops null groups", async () => {
    mocks.db.gscPage.groupBy.mockResolvedValue([
      { pageGroup: "/shop", _count: { _all: 9 } },
      { pageGroup: null, _count: { _all: 2 } },
    ]);
    expect(await GscPageGroups.listGroups("link-1")).toEqual([{ group: "/shop", pages: 9 }]);
  });

  it("previews on a sample of up to 5000 pages", async () => {
    mocks.db.gscPage.findMany.mockResolvedValue([
      { path: "/shop/x/reviews", pageGroup: "/shop" },
    ]);
    const preview = await GscPageGroups.preview({ linkId: "link-1", rules: RULES as never });
    expect(preview).toMatchObject({ sampled: 1, changed: 1, unmatched: 0 });
    expect(mocks.db.gscPage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5000 }),
    );
  });
});
