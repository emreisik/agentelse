import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: Disconnect kalıcıdır. Koparılmış (REVOKED) bir
// Google bağlantısı token'ını hâlâ tutsa da "Run Test" ve liste yenileme onu
// yeniden ACTIVE yapamaz; bunu yalnız yeni bir OAuth bağlantısı yapabilir.
// Canlı ya da süresi dolmuş bağlantı çalışmaya devam eder ve durum yazımı
// REVOKED koşuluyla korunur.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const requireUser = vi.fn();
const requireProjectAccess = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess,
}));

const findUnique = vi.fn();
const update = vi.fn();
const updateMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { integrationCredential: { findUnique, update, updateMany } },
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: vi.fn() },
}));

const getFreshGoogleAccessToken = vi.fn();
vi.mock("@/server/integrations/google-token", () => ({
  getFreshGoogleAccessToken,
}));

const fetchGa4Report = vi.fn();
const fetchSearchConsoleSiteList = vi.fn();
vi.mock("@/server/integrations/google-client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/server/integrations/google-client")
  >()),
  fetchGa4Report,
  fetchSearchConsoleSiteList,
}));

const { testGoogleConnectionAction, refreshGoogleListsAction } =
  await import("./google-actions");

const form = (service: "analytics" | "search_console") => {
  const data = new FormData();
  data.set("projectId", "proj-1");
  data.set("service", service);
  return data;
};

const SITE = { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" };

const gaRow = (status: string) => ({
  id: "cred-ga",
  status,
  encryptedSecret: "encrypted",
  metadata: {
    ga4Properties: [
      { propertyId: "123", propertyName: "Web", accountName: "Acme" },
    ],
    selectedGa4PropertyId: "123",
    selectedGa4PropertyName: "Web",
  },
});

const gscRow = (status: string) => ({
  id: "cred-gsc",
  status,
  encryptedSecret: "encrypted",
  metadata: {
    searchConsoleSites: [SITE],
    selectedSearchConsoleSite: SITE.siteUrl,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ userId: "user-1", email: null });
  requireProjectAccess.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: "proj-1",
    defaultBrandId: "brand-1",
  });
  getFreshGoogleAccessToken.mockResolvedValue("access-token");
  fetchGa4Report.mockResolvedValue({ activeUsers: 42, sessions: 60 });
  fetchSearchConsoleSiteList.mockResolvedValue({ searchConsoleSites: [SITE] });
  update.mockResolvedValue({});
  updateMany.mockResolvedValue({ count: 1 });
});

describe("testGoogleConnectionAction", () => {
  it("does not bring a disconnected connection back", async () => {
    findUnique.mockResolvedValue(gaRow("REVOKED"));

    expect(await testGoogleConnectionAction(form("analytics"))).toEqual({
      ok: false,
      message: "Google Analytics connection not found",
    });
    expect(getFreshGoogleAccessToken).not.toHaveBeenCalled();
    expect(fetchGa4Report).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("still tests a live connection and writes ACTIVE only while not REVOKED", async () => {
    findUnique.mockResolvedValue(gaRow("ACTIVE"));

    expect(await testGoogleConnectionAction(form("analytics"))).toEqual({
      ok: true,
    });
    expect(fetchGa4Report).toHaveBeenCalledWith("access-token", "123");
    // Test sürerken gelen bir Disconnect kazanır.
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cred-ga", status: { not: "REVOKED" } },
        data: expect.objectContaining({ status: "ACTIVE" }),
      }),
    );
    expect(update).not.toHaveBeenCalled();
  });
});

describe("refreshGoogleListsAction", () => {
  it("does not bring a disconnected connection back", async () => {
    findUnique.mockResolvedValue(gscRow("REVOKED"));

    expect(await refreshGoogleListsAction(form("search_console"))).toEqual({
      ok: false,
      message: "Google Search Console connection not found",
    });
    expect(getFreshGoogleAccessToken).not.toHaveBeenCalled();
    expect(fetchSearchConsoleSiteList).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("an expired connection whose token works again becomes ACTIVE, still guarded", async () => {
    findUnique.mockResolvedValue(gscRow("EXPIRED"));

    expect(await refreshGoogleListsAction(form("search_console"))).toEqual({
      ok: true,
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cred-gsc", status: { not: "REVOKED" } },
        data: expect.objectContaining({
          status: "ACTIVE",
          metadata: expect.objectContaining({
            selectedSearchConsoleSite: SITE.siteUrl,
          }),
        }),
      }),
    );
  });
});
