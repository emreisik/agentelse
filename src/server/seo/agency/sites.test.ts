import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const db = {
    integrationCredential: { findUnique: vi.fn(), updateMany: vi.fn() },
    gscSiteLink: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    gscSiteSetting: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      createMany: vi.fn(),
    },
    gscBqSource: { findMany: vi.fn(), deleteMany: vi.fn() },
    seoSite: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  };
  return {
    db,
    audit: vi.fn(),
    forgetOpportunities: vi.fn(),
    deleteAlerts: vi.fn(),
    setViewed: vi.fn(),
    mock: false,
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks.db }));
vi.mock("@/server/integrations/google-client", () => ({
  GOOGLE_PROVIDER: { search_console: "GOOGLE_SEARCH_CONSOLE" },
}));
vi.mock("@/server/integrations/search-console/search-analytics", () => ({
  gscMockMode: () => mocks.mock,
}));
vi.mock("@/server/integrations/search-console/sites", () => ({
  propertyTypeOf: (siteUrl: string) =>
    siteUrl.startsWith("sc-domain:") ? "DOMAIN" : "URL_PREFIX",
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.audit },
}));
vi.mock("@/server/seo/health/alerts", () => ({
  deleteSearchConsoleAlertsForProjects: mocks.deleteAlerts,
}));
vi.mock("@/server/seo/opportunities/forget", () => ({
  forgetSearchOpportunitiesForLinks: mocks.forgetOpportunities,
}));
vi.mock("./site-context", () => ({ setViewedGscLink: mocks.setViewed }));

const { GscSites, resolveViewedSite } = await import("./sites");

const SITES = [
  { siteUrl: "sc-domain:main.com", permissionLevel: "siteOwner" },
  { siteUrl: "sc-domain:second.com", permissionLevel: "siteFullUser" },
  { siteUrl: "sc-domain:third.com", permissionLevel: "siteOwner" },
  { siteUrl: "sc-domain:unverified.com", permissionLevel: "siteUnverifiedUser" },
];

function credential(overrides: Record<string, unknown> = {}) {
  return {
    id: "cred-1",
    workspaceId: "ws-1",
    status: "ACTIVE",
    metadata: {
      searchConsoleSites: SITES,
      selectedSearchConsoleSite: "sc-domain:main.com",
      extra: "keep-me",
    },
    ...overrides,
  };
}

function link(overrides: Record<string, unknown> = {}) {
  return {
    id: "link-x",
    projectId: "proj-1",
    siteUrl: "sc-domain:second.com",
    isMock: false,
    isPrimary: false,
    isSecondary: true,
    demotedAt: null,
    health: "OK",
    lastFinalDate: "2026-10-01",
    backfillDoneAt: null,
    permissionLevel: "siteFullUser",
    ...overrides,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("GSC_AGENCY", "true");
  vi.stubEnv("GSC_BIGQUERY", "");
  vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
  vi.stubEnv("GSC_SYNC_DEV_PROJECTS", "");
  mocks.mock = false;
  mocks.audit.mockReset().mockResolvedValue({});
  mocks.forgetOpportunities.mockReset().mockResolvedValue({ ideas: 0, signals: 0 });
  mocks.deleteAlerts.mockReset().mockResolvedValue(0);
  mocks.setViewed.mockReset();
  for (const group of Object.values(mocks.db)) {
    if (typeof group === "function") continue;
    for (const fn of Object.values(group)) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  mocks.db.$transaction.mockReset().mockImplementation(async (arg: unknown) => {
    if (typeof arg === "function") return (arg as (tx: unknown) => unknown)(mocks.db);
    return Promise.all(arg as Promise<unknown>[]);
  });
  mocks.db.integrationCredential.findUnique.mockResolvedValue(credential());
  mocks.db.gscSiteLink.findMany.mockResolvedValue([]);
  mocks.db.gscSiteSetting.findUnique.mockResolvedValue(null);
  mocks.db.gscSiteLink.create.mockResolvedValue({ id: "link-new" });
  mocks.db.gscSiteSetting.create.mockResolvedValue({});
  mocks.db.seoSite.updateMany.mockResolvedValue({ count: 1 });
});

const input = { projectId: "proj-1", siteUrl: "sc-domain:second.com", userId: "u1" };

describe("GscSites.add", () => {
  it("creates the setting and a secondary link, audited", async () => {
    expect(await GscSites.add(input)).toEqual({ ok: true, linkId: "link-new" });
    expect(mocks.db.gscSiteSetting.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ isExtra: true, isMock: false, siteUrl: input.siteUrl }),
    });
    expect(mocks.db.gscSiteLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        isPrimary: false,
        isSecondary: true,
        demotedAt: null,
        propertyType: "DOMAIN",
        permissionLevel: "siteFullUser",
      }),
      select: { id: true },
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "gsc_site.added", entityId: "link-new" }),
    );
  });

  it("is NOT_ALLOWED when the flag is off", async () => {
    vi.stubEnv("GSC_AGENCY", "");
    expect(await GscSites.add(input)).toEqual({ ok: false, code: "NOT_ALLOWED" });
    expect(mocks.db.integrationCredential.findUnique).not.toHaveBeenCalled();
  });

  it("is NOT_CONNECTED without a usable credential", async () => {
    mocks.db.integrationCredential.findUnique.mockResolvedValue(null);
    expect(await GscSites.add(input)).toMatchObject({ code: "NOT_CONNECTED" });
    mocks.db.integrationCredential.findUnique.mockResolvedValue(
      credential({ status: "REVOKED" }),
    );
    expect(await GscSites.add(input)).toMatchObject({ code: "NOT_CONNECTED" });
  });

  it("is NOT_IN_ACCOUNT, UNVERIFIED and IS_PRIMARY from the account list", async () => {
    expect(await GscSites.add({ ...input, siteUrl: "sc-domain:nope.com" })).toMatchObject({
      code: "NOT_IN_ACCOUNT",
    });
    expect(
      await GscSites.add({ ...input, siteUrl: "sc-domain:unverified.com" }),
    ).toMatchObject({ code: "UNVERIFIED" });
    expect(await GscSites.add({ ...input, siteUrl: "sc-domain:main.com" })).toMatchObject({
      code: "IS_PRIMARY",
    });
  });

  it("is ALREADY_ADDED for an existing secondary", async () => {
    mocks.db.gscSiteLink.findMany.mockResolvedValue([link()]);
    expect(await GscSites.add(input)).toMatchObject({ code: "ALREADY_ADDED" });
    expect(mocks.db.gscSiteLink.create).not.toHaveBeenCalled();
  });

  it("is OTHER_MODE for a link or a setting of the other mode, never flipping it", async () => {
    mocks.db.gscSiteLink.findMany.mockResolvedValue([link({ isMock: true })]);
    expect(await GscSites.add(input)).toMatchObject({ code: "OTHER_MODE" });
    mocks.db.gscSiteLink.findMany.mockResolvedValue([]);
    mocks.db.gscSiteSetting.findUnique.mockResolvedValue({ id: "s1", isMock: true });
    expect(await GscSites.add(input)).toMatchObject({ code: "OTHER_MODE" });
    expect(mocks.db.gscSiteSetting.update).not.toHaveBeenCalled();
    expect(mocks.db.gscSiteLink.update).not.toHaveBeenCalled();
  });

  it("is LIMIT when the primary plus secondaries reach 5", async () => {
    mocks.db.gscSiteLink.findMany.mockResolvedValue(
      [1, 2, 3, 4].map((n) => link({ id: `l${n}`, siteUrl: `sc-domain:x${n}.com` })),
    );
    expect(await GscSites.add(input)).toMatchObject({ code: "LIMIT" });
    mocks.db.gscSiteLink.findMany.mockResolvedValue(
      [1, 2, 3].map((n) => link({ id: `l${n}`, siteUrl: `sc-domain:x${n}.com` })),
    );
    expect(await GscSites.add(input)).toMatchObject({ ok: true });
  });

  it("revives a retired link of the same mode", async () => {
    mocks.db.gscSiteLink.findMany.mockResolvedValue([
      link({ id: "old", isSecondary: false, demotedAt: new Date() }),
    ]);
    mocks.db.gscSiteLink.update.mockResolvedValue({ id: "old" });
    expect(await GscSites.add(input)).toEqual({ ok: true, linkId: "old" });
    expect(mocks.db.gscSiteLink.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isSecondary: true, isPrimary: false, demotedAt: null }),
      }),
    );
    expect(mocks.db.gscSiteLink.create).not.toHaveBeenCalled();
  });

  it("maps a P2002 race to ALREADY_ADDED", async () => {
    mocks.db.gscSiteLink.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "6",
      }),
    );
    expect(await GscSites.add(input)).toEqual({ ok: false, code: "ALREADY_ADDED" });
  });
});

describe("GscSites.remove", () => {
  it("refuses a primary and unknown links", async () => {
    mocks.db.gscSiteLink.findFirst.mockResolvedValue(link({ isPrimary: true, isSecondary: false }));
    expect(await GscSites.remove({ projectId: "proj-1", linkId: "l", userId: "u1" })).toMatchObject({
      ok: false,
    });
    mocks.db.gscSiteLink.findFirst.mockResolvedValue(null);
    expect(await GscSites.remove({ projectId: "proj-1", linkId: "l", userId: "u1" })).toMatchObject({
      ok: false,
    });
    expect(mocks.db.gscSiteLink.delete).not.toHaveBeenCalled();
  });

  it("deletes a secondary with its BigQuery source and clears the membership", async () => {
    mocks.db.gscSiteLink.findFirst.mockResolvedValue(
      link({ id: "l2", workspaceId: "ws-1" }),
    );
    expect(await GscSites.remove({ projectId: "proj-1", linkId: "l2", userId: "u1" })).toEqual({
      ok: true,
    });
    expect(mocks.db.gscSiteSetting.updateMany).toHaveBeenCalledWith({
      where: { projectId: "proj-1", siteUrl: "sc-domain:second.com", isMock: false },
      data: { isExtra: false },
    });
    expect(mocks.db.gscBqSource.deleteMany).toHaveBeenCalled();
    expect(mocks.db.gscSiteLink.delete).toHaveBeenCalledWith({ where: { id: "l2" } });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "gsc_site.removed" }),
    );
  });
});

describe("GscSites.makePrimary", () => {
  const args = { projectId: "proj-1", linkId: "l2", userId: "u1" };

  beforeEach(() => {
    mocks.db.gscSiteLink.findFirst
      .mockResolvedValueOnce(link({ id: "l2" }))
      .mockResolvedValueOnce({ id: "l1", siteUrl: "sc-domain:main.com" });
    mocks.db.integrationCredential.updateMany.mockResolvedValue({ count: 1 });
    mocks.db.gscSiteSetting.updateMany.mockResolvedValue({ count: 1 });
  });

  it("swaps flags, metadata and settings in one transaction, then cleans the old primary", async () => {
    expect(await GscSites.makePrimary(args)).toEqual({ ok: true });
    expect(mocks.db.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.db.integrationCredential.updateMany).toHaveBeenCalledWith({
      where: { id: "cred-1", status: { not: "REVOKED" } },
      data: {
        metadata: expect.objectContaining({
          selectedSearchConsoleSite: "sc-domain:second.com",
          extra: "keep-me",
        }),
      },
    });
    expect(mocks.db.gscSiteLink.update).toHaveBeenCalledWith({
      where: { id: "l1" },
      data: {
        isPrimary: false,
        isSecondary: true,
        demotedAt: null,
        syncLeaseUntil: null,
        syncLeaseOwner: null,
      },
    });
    expect(mocks.db.gscSiteLink.update).toHaveBeenCalledWith({
      where: { id: "l2" },
      data: { isPrimary: true, isSecondary: false, demotedAt: null },
    });
    expect(mocks.db.gscSiteSetting.updateMany).toHaveBeenCalledWith({
      where: { projectId: "proj-1", siteUrl: "sc-domain:main.com", isMock: false },
      data: { isExtra: true },
    });
    expect(mocks.db.gscSiteSetting.updateMany).toHaveBeenCalledWith({
      where: { projectId: "proj-1", siteUrl: "sc-domain:second.com", isMock: false },
      data: { isExtra: false },
    });
    expect(mocks.forgetOpportunities).toHaveBeenCalledWith(["l1"]);
    expect(mocks.deleteAlerts).toHaveBeenCalledWith(["proj-1"]);
    expect(mocks.db.seoSite.updateMany).toHaveBeenCalledWith({
      where: { projectId: "proj-1", isMock: false },
      data: { healthParts: Prisma.DbNull, healthComputedAt: null },
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "gsc_site.primary_changed" }),
    );
  });

  it("creates the old primary's setting when none exists", async () => {
    mocks.db.gscSiteSetting.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    expect(await GscSites.makePrimary(args)).toEqual({ ok: true });
    expect(mocks.db.gscSiteSetting.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });

  it("survives failing cleanups", async () => {
    mocks.forgetOpportunities.mockRejectedValue(new Error("boom"));
    mocks.deleteAlerts.mockRejectedValue(new Error("boom"));
    mocks.db.seoSite.updateMany.mockRejectedValue(new Error("boom"));
    expect(await GscSites.makePrimary(args)).toEqual({ ok: true });
  });

  it("refuses a link of another mode and a revoked credential rolls back", async () => {
    mocks.db.gscSiteLink.findFirst.mockReset().mockResolvedValueOnce(link({ isMock: true }));
    expect(await GscSites.makePrimary(args)).toMatchObject({ ok: false });
    expect(mocks.db.$transaction).not.toHaveBeenCalled();

    mocks.db.gscSiteLink.findFirst
      .mockReset()
      .mockResolvedValueOnce(link({ id: "l2" }))
      .mockResolvedValueOnce({ id: "l1", siteUrl: "sc-domain:main.com" });
    mocks.db.integrationCredential.updateMany.mockResolvedValue({ count: 0 });
    expect(await GscSites.makePrimary(args)).toMatchObject({ ok: false });
    expect(mocks.forgetOpportunities).not.toHaveBeenCalled();
  });
});

describe("GscSites.reconcile", () => {
  it("creates the missing secondary link for an extra setting", async () => {
    mocks.db.gscSiteSetting.findMany.mockResolvedValue([
      { id: "s1", siteUrl: "sc-domain:second.com", isExtra: true, workspaceId: "ws-1" },
    ]);
    expect(await GscSites.reconcile("proj-1")).toBe(1);
    expect(mocks.db.gscSiteLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ isPrimary: false, isSecondary: true }),
    });
  });

  it("drops membership of a site that left the account and deletes its link", async () => {
    mocks.db.gscSiteSetting.findMany.mockResolvedValue([
      { id: "s1", siteUrl: "sc-domain:gone.com", isExtra: true, workspaceId: "ws-1" },
    ]);
    mocks.db.gscSiteLink.findMany.mockResolvedValue([
      link({ id: "lg", siteUrl: "sc-domain:gone.com" }),
    ]);
    mocks.db.gscSiteLink.deleteMany.mockResolvedValue({ count: 1 });
    expect(await GscSites.reconcile("proj-1")).toBe(2);
    expect(mocks.db.gscSiteSetting.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { isExtra: false },
    });
    expect(mocks.db.gscSiteLink.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ["lg"] } }) }),
    );
  });

  it("ignores extras beyond the maximum without deleting their links", async () => {
    const settings = [1, 2, 3, 4, 5].map((n) => ({
      id: `s${n}`,
      siteUrl: `sc-domain:x${n}.com`,
      isExtra: true,
      workspaceId: "ws-1",
    }));
    mocks.db.integrationCredential.findUnique.mockResolvedValue(
      credential({
        metadata: {
          selectedSearchConsoleSite: "sc-domain:main.com",
          searchConsoleSites: [
            { siteUrl: "sc-domain:main.com", permissionLevel: "siteOwner" },
            ...settings.map((s) => ({ siteUrl: s.siteUrl, permissionLevel: "siteOwner" })),
          ],
        },
      }),
    );
    mocks.db.gscSiteSetting.findMany.mockResolvedValue(settings);
    mocks.db.gscSiteLink.findMany.mockResolvedValue([
      link({ id: "l5", siteUrl: "sc-domain:x5.com" }),
    ]);
    expect(await GscSites.reconcile("proj-1")).toBe(4);
    expect(mocks.db.gscSiteLink.create).toHaveBeenCalledTimes(4);
    expect(mocks.db.gscSiteLink.deleteMany).not.toHaveBeenCalled();
  });

  it("does nothing without extras or secondaries and is off with the flag", async () => {
    mocks.db.gscSiteSetting.findMany.mockResolvedValue([]);
    expect(await GscSites.reconcile("proj-1")).toBe(0);
    vi.stubEnv("GSC_AGENCY", "");
    mocks.db.integrationCredential.findUnique.mockClear();
    expect(await GscSites.reconcile("proj-1")).toBe(0);
    expect(mocks.db.integrationCredential.findUnique).not.toHaveBeenCalled();
  });
});

describe("GscSites.reconcileAll", () => {
  it("returns 0 before any query when the flag is off", async () => {
    vi.stubEnv("GSC_AGENCY", "");
    expect(await GscSites.reconcileAll()).toBe(0);
    expect(mocks.db.gscSiteSetting.findMany).not.toHaveBeenCalled();
  });

  it("is empty for an empty restricted list and scoped for a rollout list", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@ep-live.neon.tech/db");
    expect(await GscSites.reconcileAll()).toBe(0);
    expect(mocks.db.gscSiteSetting.findMany).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
    vi.stubEnv("GSC_SYNC", "true");
    vi.stubEnv("GSC_AGENCY", "true");
    vi.stubEnv("GSC_ROLLOUT_PROJECTS", "proj-1");
    mocks.db.gscSiteSetting.findMany.mockResolvedValue([]);
    mocks.db.gscSiteLink.findMany.mockResolvedValue([]);
    await GscSites.reconcileAll();
    expect(mocks.db.gscSiteSetting.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: { in: ["proj-1"] } }),
      }),
    );
  });
});

describe("GscSites.list and candidates", () => {
  it("is empty with the flag off, without a query", async () => {
    vi.stubEnv("GSC_AGENCY", "");
    expect(await GscSites.list("proj-1")).toEqual([]);
    expect(mocks.db.gscSiteLink.findMany).not.toHaveBeenCalled();
  });

  it("puts the primary first and adds the BigQuery badge from one query", async () => {
    vi.stubEnv("GSC_BIGQUERY", "true");
    mocks.db.gscSiteLink.findMany.mockResolvedValue([
      link({ id: "b", siteUrl: "sc-domain:b.com" }),
      link({ id: "p", siteUrl: "sc-domain:z.com", isPrimary: true, isSecondary: false, permissionLevel: "siteOwner" }),
    ]);
    mocks.db.gscBqSource.findMany.mockResolvedValue([
      { siteUrl: "sc-domain:z.com", status: "ACTIVE" },
    ]);
    const sites = await GscSites.list("proj-1");
    expect(sites.map((s) => s.linkId)).toEqual(["p", "b"]);
    expect(sites[0]).toMatchObject({ role: "PRIMARY", bigQuery: "ACTIVE", isOwner: true });
    expect(sites[1]).toMatchObject({ role: "SECONDARY", bigQuery: "OFF", isOwner: false });
    expect(mocks.db.gscBqSource.findMany).toHaveBeenCalledTimes(1);
  });

  it("lists account sites minus primary, linked and unverified ones", async () => {
    mocks.db.gscSiteLink.findMany.mockResolvedValue([{ siteUrl: "sc-domain:second.com" }]);
    expect(await GscSites.candidates("proj-1")).toEqual([
      { siteUrl: "sc-domain:third.com", siteLabel: "third.com", permissionLevel: "siteOwner" },
    ]);
  });
});

describe("resolveViewedSite", () => {
  it("returns the off view without any prisma call when the flag is off", async () => {
    vi.stubEnv("GSC_AGENCY", "");
    expect(await resolveViewedSite("proj-1", "l2")).toEqual({
      agency: false,
      sites: [],
      viewed: null,
      isPrimaryView: true,
    });
    expect(mocks.db.gscSiteLink.findMany).not.toHaveBeenCalled();
    expect(mocks.db.gscSiteLink.findFirst).not.toHaveBeenCalled();
    expect(mocks.setViewed).not.toHaveBeenCalled();
  });

  const rows = [
    link({ id: "p", siteUrl: "sc-domain:a.com", isPrimary: true, isSecondary: false }),
    link({ id: "s", siteUrl: "sc-domain:b.com" }),
  ];

  it("falls back to the primary for an unknown or foreign link id", async () => {
    mocks.db.gscSiteLink.findMany.mockResolvedValue(rows);
    const view = await resolveViewedSite("proj-1", "foreign-id");
    expect(view.viewed?.linkId).toBe("p");
    expect(view.isPrimaryView).toBe(true);
    expect(mocks.setViewed).not.toHaveBeenCalled();
  });

  it("sets the override only for a secondary view, with the full row", async () => {
    mocks.db.gscSiteLink.findMany.mockResolvedValue(rows);
    mocks.db.gscSiteLink.findFirst.mockResolvedValue(rows[1]);
    const view = await resolveViewedSite("proj-1", "s");
    expect(view.viewed?.linkId).toBe("s");
    expect(view.isPrimaryView).toBe(false);
    expect(mocks.setViewed).toHaveBeenCalledWith(rows[1]);
    mocks.setViewed.mockClear();
    const primary = await resolveViewedSite("proj-1", "p");
    expect(primary.isPrimaryView).toBe(true);
    expect(mocks.setViewed).not.toHaveBeenCalled();
  });
});
