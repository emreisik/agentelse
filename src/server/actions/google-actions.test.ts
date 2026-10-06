import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: Disconnect kalıcıdır. Koparılmış (REVOKED) bir
// Google bağlantısı "Run Test" ve liste yenilemeyle yeniden ACTIVE olamaz;
// bunu yalnız yeni bir OAuth bağlantısı yapabilir. Canlı ya da süresi dolmuş
// bağlantı çalışmaya devam eder ve durum yazımı REVOKED koşuluyla korunur.
// Disconnect ve seçili mülkü/siteyi değiştirmek yalnız OWNER/ADMIN'e açıktır;
// ilk seçimi bağlantıyı kuran her üye yapabilir.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const requireUser = vi.fn();
const requireProjectAccess = vi.fn();
const isWorkspaceManager = vi.fn();
vi.mock("@/server/security/tenant-context", () => ({
  requireUser,
  requireProjectAccess,
  isWorkspaceManager,
}));

const findUnique = vi.fn();
const update = vi.fn();
const updateMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { integrationCredential: { findUnique, update, updateMany } },
}));
const recordAudit = vi.fn();
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: recordAudit },
}));

const disconnectGoogleCredential = vi.fn();
vi.mock("@/server/integrations/google-disconnect", () => ({
  disconnectGoogleCredential,
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

const {
  disconnectGoogleAction,
  refreshGoogleListsAction,
  selectGa4PropertyAction,
  testGoogleConnectionAction,
} = await import("./google-actions");

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
  isWorkspaceManager.mockResolvedValue(true);
  disconnectGoogleCredential.mockResolvedValue({ revokedAtGoogle: true });
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

const selectForm = (propertyId: string) => {
  const data = new FormData();
  data.set("projectId", "proj-1");
  data.set("propertyId", propertyId);
  return data;
};

const twoProperties = (selected?: string) => ({
  id: "cred-ga",
  status: "ACTIVE",
  encryptedSecret: "encrypted",
  metadata: {
    ga4Properties: [
      { propertyId: "123", propertyName: "Web", accountName: "Acme" },
      { propertyId: "456", propertyName: "Shop", accountName: "Acme" },
    ],
    ...(selected ? { selectedGa4PropertyId: selected } : {}),
  },
});

describe("selectGa4PropertyAction", () => {
  it("lets the member who connected make the first choice", async () => {
    isWorkspaceManager.mockResolvedValue(false);
    findUnique.mockResolvedValue(twoProperties());

    expect(await selectGa4PropertyAction(selectForm("123"))).toEqual({
      ok: true,
    });
    expect(isWorkspaceManager).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cred-ga", status: { not: "REVOKED" } },
      }),
    );
  });

  it("keeps changing an existing choice to owners and admins", async () => {
    isWorkspaceManager.mockResolvedValue(false);
    findUnique.mockResolvedValue(twoProperties("123"));

    expect(await selectGa4PropertyAction(selectForm("456"))).toEqual({
      ok: false,
      message: "Only workspace owners and admins can change this.",
    });
    expect(updateMany).not.toHaveBeenCalled();

    isWorkspaceManager.mockResolvedValue(true);
    expect(await selectGa4PropertyAction(selectForm("456"))).toEqual({
      ok: true,
    });
  });

  it("does not edit a disconnected connection", async () => {
    findUnique.mockResolvedValue({ ...twoProperties(), status: "REVOKED" });
    expect(await selectGa4PropertyAction(selectForm("123"))).toEqual({
      ok: false,
      message: "Google Analytics connection not found",
    });
  });
});

describe("disconnectGoogleAction", () => {
  it("is for owners and admins only", async () => {
    isWorkspaceManager.mockResolvedValue(false);
    findUnique.mockResolvedValue(gaRow("ACTIVE"));

    expect(await disconnectGoogleAction(form("analytics"))).toEqual({
      ok: false,
      message: "Only workspace owners and admins can change this.",
    });
    expect(disconnectGoogleCredential).not.toHaveBeenCalled();
  });

  it("wipes the connection and records whether Google access was removed", async () => {
    const row = gaRow("ACTIVE");
    findUnique.mockResolvedValue(row);

    expect(await disconnectGoogleAction(form("analytics"))).toEqual({
      ok: true,
    });
    expect(disconnectGoogleCredential).toHaveBeenCalledWith(row);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "integration_credential.disconnected",
        metadata: { provider: "google_analytics", revokedAtGoogle: true },
      }),
    );
  });

  it("also cleans a row disconnected before tokens were wiped", async () => {
    findUnique.mockResolvedValue(gscRow("REVOKED"));
    expect(await disconnectGoogleAction(form("search_console"))).toEqual({
      ok: true,
    });
    expect(disconnectGoogleCredential).toHaveBeenCalled();
  });

  it("has nothing to do for an already wiped row", async () => {
    findUnique.mockResolvedValue({ ...gscRow("REVOKED"), encryptedSecret: "" });
    expect(await disconnectGoogleAction(form("search_console"))).toEqual({
      ok: true,
    });
    expect(disconnectGoogleCredential).not.toHaveBeenCalled();
  });
});
