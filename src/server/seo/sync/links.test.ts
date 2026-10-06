import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: "Delete stored data" bağları sildikten SONRA
// projenin GSC uyarılarını siler ve denetimdeki GSC kökenli durumu kapsamı
// sıfırlamadan (resetScope: false; tarama verisi kalır) temizler.

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  deleteMany: vi.fn(),
  updateMany: vi.fn(),
  deleteAlerts: vi.fn(),
  forget: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gscSiteLink: {
      findFirst: mocks.findFirst,
      deleteMany: mocks.deleteMany,
      updateMany: mocks.updateMany,
    },
  },
}));
vi.mock("@/lib/seo/flags", () => ({
  // Bağ yeniden kurulmaz: bu test yalnız silme sırasını sınar.
  gscSyncAllowedFor: () => false,
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
vi.mock("@/server/seo/site/sites", () => ({
  SeoSites: { forgetSearchConsoleData: mocks.forget },
}));

const { deleteGscDataForProject } = await import("./links");

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.findFirst.mockResolvedValue(null);
  mocks.deleteMany.mockResolvedValue({ count: 2 });
  mocks.deleteAlerts.mockResolvedValue(1);
  mocks.forget.mockResolvedValue(1);
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
  });
});
