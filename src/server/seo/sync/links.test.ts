import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: "Delete stored data" bağları sildikten SONRA
// projenin GSC uyarılarını siler ve denetimdeki GSC kökenli durumu kapsamı
// sıfırlamadan (resetScope: false; tarama verisi kalır) temizler. SC-F4: bağlar
// silinmeden ÖNCE yalnız bu kipin bağlarının fırsat verisi unutulur.

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  updateMany: vi.fn(),
  deleteAlerts: vi.fn(),
  forget: vi.fn(),
  forgetOpportunities: vi.fn(),
  forgetGoalValues: vi.fn(),
  forgetSeoActions: vi.fn(),
  forgetAgency: vi.fn(),
  update: vi.fn(),
  upsert: vi.fn(),
  credentials: vi.fn(),
  syncAllowed: vi.fn(() => false),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gscSiteLink: {
      findFirst: mocks.findFirst,
      findMany: mocks.findMany,
      deleteMany: mocks.deleteMany,
      updateMany: mocks.updateMany,
      update: mocks.update,
      upsert: mocks.upsert,
    },
    integrationCredential: { findMany: mocks.credentials },
  },
}));
vi.mock("@/lib/seo/flags", () => ({
  // Bağ yeniden kurulmaz: bu test yalnız silme sırasını sınar.
  gscSyncAllowedFor: mocks.syncAllowed,
  gscRestrictedProjects: () => null,
}));
vi.mock("@/server/integrations/search-console/search-analytics", () => ({
  gscMockMode: () => false,
}));
vi.mock("@/server/integrations/search-console/sites", () => ({
  propertyTypeOf: vi.fn(),
}));
vi.mock("@/server/integrations/google-client", () => ({
  GOOGLE_PROVIDER: { search_console: "GOOGLE_SEARCH_CONSOLE" },
}));
vi.mock("@/server/seo/health/alerts", () => ({
  deleteSearchConsoleAlertsForProjects: mocks.deleteAlerts,
}));
vi.mock("@/server/seo/opportunities/forget", () => ({
  forgetSearchOpportunitiesForLinks: mocks.forgetOpportunities,
}));
vi.mock("@/server/seo/actions/forget", () => ({
  forgetSeoActionsForProjectMode: mocks.forgetSeoActions,
}));
vi.mock("@/server/seo/reports/goals", () => ({
  forgetSeoGoalValues: mocks.forgetGoalValues,
}));
vi.mock("@/server/seo/agency/forget", () => ({
  forgetAgencyForProjectMode: mocks.forgetAgency,
}));
vi.mock("@/server/seo/site/sites", () => ({
  SeoSites: { forgetSearchConsoleData: mocks.forget },
}));

const { deleteGscDataForProject, ensureGscLinkForProject } = await import("./links");

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.findFirst.mockResolvedValue(null);
  mocks.findMany.mockResolvedValue([{ id: "link-1" }, { id: "link-2" }]);
  mocks.forgetOpportunities.mockResolvedValue({ ideas: 0, signals: 0 });
  mocks.deleteMany.mockResolvedValue({ count: 2 });
  mocks.deleteAlerts.mockResolvedValue(1);
  mocks.forget.mockResolvedValue(1);
  mocks.forgetGoalValues.mockResolvedValue(0);
  mocks.forgetSeoActions.mockResolvedValue({ actions: 0, learnings: 0, cards: 0 });
  mocks.forgetAgency.mockResolvedValue(undefined);
  mocks.syncAllowed.mockReturnValue(false);
});

describe("deleteGscDataForProject", () => {
  it("clears GSC alerts and GSC-derived audit state after the link delete, keeping the crawl scope", async () => {
    expect(await deleteGscDataForProject("proj-1")).toEqual({
      deletedLinks: 2,
    });
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { projectId: "proj-1", isMock: false },
    });
    expect(mocks.deleteAlerts).toHaveBeenCalledWith(["proj-1"]);
    expect(mocks.forget).toHaveBeenCalledWith(["proj-1"], {
      resetScope: false,
    });
    const deleted = mocks.deleteMany.mock.invocationCallOrder[0]!;
    expect(mocks.deleteAlerts.mock.invocationCallOrder[0]).toBeGreaterThan(
      deleted,
    );
    expect(mocks.forget.mock.invocationCallOrder[0]).toBeGreaterThan(deleted);
    // SC-F6: bu kipin SEO eylemleri bağlar silinmeden ÖNCE unutulur.
    expect(mocks.forgetSeoActions).toHaveBeenCalledWith("proj-1", false);
    expect(mocks.forgetSeoActions.mock.invocationCallOrder[0]).toBeLessThan(
      deleted,
    );
    // SC-F9: paylaşım/sayfa grubu/BigQuery izleri bağlar silinmeden ÖNCE unutulur.
    expect(mocks.forgetAgency).toHaveBeenCalledWith("proj-1", false);
    expect(mocks.forgetAgency.mock.invocationCallOrder[0]).toBeLessThan(deleted);
    // SC-F5: SEO hedeflerinin değeri bağlar silindikten sonra boşaltılır.
    expect(mocks.forgetGoalValues).toHaveBeenCalledWith(["proj-1"], {
      isMock: expect.any(Boolean),
    });
    expect(
      mocks.forgetGoalValues.mock.invocationCallOrder[0],
    ).toBeGreaterThan(deleted);
  });

  it("forgets the search opportunity data of this mode's links before deleting them", async () => {
    await deleteGscDataForProject("proj-1");
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { projectId: "proj-1", isMock: false },
      select: { id: true },
    });
    expect(mocks.forgetOpportunities).toHaveBeenCalledWith([
      "link-1",
      "link-2",
    ]);
    expect(
      mocks.forgetOpportunities.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.deleteMany.mock.invocationCallOrder[0]!);

    // Temizlik hatası silmeyi durdurmaz.
    mocks.forgetOpportunities.mockRejectedValue(new Error("db"));
    await expect(deleteGscDataForProject("proj-1")).resolves.toEqual({
      deletedLinks: 2,
    });
  });
});

describe("ensureGscLinkForProject", () => {
  it("promotes an existing secondary link of the selected site to a normal primary", async () => {
    mocks.syncAllowed.mockReturnValue(true);
    mocks.credentials.mockResolvedValue([
      {
        id: "cred-1",
        workspaceId: "ws-1",
        projectId: "proj-1",
        status: "ACTIVE",
        metadata: { selectedSearchConsoleSite: "sc-domain:example.com" },
      },
    ]);
    mocks.findMany.mockResolvedValue([
      {
        id: "link-9",
        siteUrl: "sc-domain:example.com",
        isPrimary: false,
        isMock: false,
        credentialId: "cred-1",
      },
    ]);
    await ensureGscLinkForProject("proj-1");
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "link-9" },
      data: {
        isPrimary: true,
        isSecondary: false,
        demotedAt: null,
        credentialId: "cred-1",
      },
    });
  });
});
