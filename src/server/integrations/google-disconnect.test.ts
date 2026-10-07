import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: Disconnect token'ı ve Google verisini her
// durumda hemen siler; Google'da iptal yalnız aynı hesabı kullanan başka canlı
// bağlantı yoksa yapılır ve iptal başarısız olsa da silme yine olur. GA-F4
// bulgu türevleri GA bağından, SC-F4 fırsat verisi GSC bağından önce silinir;
// fırsat temizliği başarısız olsa da Disconnect biter. GA-F5 rapor kartları GA
// bağından önce silinir; SC-F5 SEO hedef değerleri GSC bağından sonra boşaltılır.

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  deleteLinks: vi.fn(),
  deleteGscLinks: vi.fn(),
  findGscLinks: vi.fn(),
  deleteGaReports: vi.fn(),
  forgetSeoGoalValues: vi.fn(),
  revokeGoogleToken: vi.fn(),
  deleteHealthAlerts: vi.fn(),
  deleteSearchAlerts: vi.fn(),
  forgetSearchConsoleData: vi.fn(),
  deleteGaInsights: vi.fn(),
  forgetOpportunities: vi.fn().mockResolvedValue({ ideas: 0, signals: 0 }),
  deleteGaAttribution: vi.fn(),
  forgetSeoActions: vi.fn(),
  cancelGaFixes: vi.fn(),
  gaFixesEnabled: vi.fn(),
  forgetSeoContentPlans: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    integrationCredential: { findMany: mocks.findMany, update: mocks.update },
    gaPropertyLink: { deleteMany: mocks.deleteLinks },
    gscSiteLink: {
      findMany: mocks.findGscLinks,
      deleteMany: mocks.deleteGscLinks,
    },
  },
}));
vi.mock("@/server/security/crypto", () => ({
  decryptSecret: (value: string) => `plain(${value})`,
}));
vi.mock("@/server/integrations/google/oauth", () => ({
  revokeGoogleToken: mocks.revokeGoogleToken,
}));
vi.mock("@/server/website-analytics/health/cleanup", () => ({
  deleteGaHealthAlertsForCredential: mocks.deleteHealthAlerts,
}));
vi.mock("@/server/website-analytics/reports/cleanup", () => ({
  deleteGaReportDataForCredential: mocks.deleteGaReports,
}));
vi.mock("@/server/seo/reports/goals", () => ({
  forgetSeoGoalValues: mocks.forgetSeoGoalValues,
}));
vi.mock("@/server/seo/health/alerts", () => ({
  deleteSearchConsoleAlerts: mocks.deleteSearchAlerts,
}));
vi.mock("@/server/website-analytics/analysis/cleanup", () => ({
  deleteGaInsightDerivedDataForCredential: mocks.deleteGaInsights,
}));
vi.mock("@/server/website-analytics/attribution/cleanup", () => ({
  deleteGaAttributionDataForCredential: mocks.deleteGaAttribution,
}));
vi.mock("@/server/seo/actions/forget", () => ({
  forgetSeoActionsForCredential: mocks.forgetSeoActions,
}));
vi.mock("@/server/seo/opportunities/forget", () => ({
  forgetSearchOpportunitiesForCredential: mocks.forgetOpportunities,
}));
vi.mock("@/server/website-analytics/fixes/cleanup", () => ({
  cancelPendingGaFixesForCredential: mocks.cancelGaFixes,
}));
vi.mock("@/lib/website-analytics/fixes/flags", () => ({
  gaFixesEnabled: mocks.gaFixesEnabled,
}));
vi.mock("@/server/seo/content-plan/forget", () => ({
  forgetSeoContentPlansForCredential: mocks.forgetSeoContentPlans,
}));
vi.mock("@/server/seo/site/sites", () => ({
  SeoSites: { forgetSearchConsoleData: mocks.forgetSearchConsoleData },
}));

const { disconnectGoogleCredential } = await import("./google-disconnect");

const credential = {
  id: "cred-ga",
  encryptedSecret: "enc-1",
  metadata: {
    googleSub: "sub-1",
    connectedEmail: "owner@example.com",
    ga4Properties: [{ propertyId: "1", propertyName: "Web", accountName: "A" }],
    selectedGa4PropertyId: "1",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([]);
  mocks.update.mockResolvedValue({});
  mocks.deleteLinks.mockResolvedValue({ count: 1 });
  mocks.deleteGscLinks.mockResolvedValue({ count: 1 });
  mocks.findGscLinks.mockResolvedValue([]);
  mocks.deleteGaReports.mockResolvedValue({ commands: 0 });
  mocks.forgetSeoGoalValues.mockResolvedValue(0);
  mocks.revokeGoogleToken.mockResolvedValue(undefined);
  mocks.deleteHealthAlerts.mockResolvedValue(0);
  mocks.deleteSearchAlerts.mockResolvedValue({ deleted: 0, projectIds: ["p1"] });
  mocks.forgetSearchConsoleData.mockResolvedValue(1);
  mocks.deleteGaInsights.mockResolvedValue({
    signals: 0,
    findings: 0,
    insights: 0,
    opportunities: 0,
    learnings: 0,
    ideas: 0,
  });
  mocks.forgetOpportunities.mockResolvedValue({ ideas: 0, signals: 0 });
  mocks.deleteGaAttribution.mockResolvedValue({ learnings: 0, decisions: 0 });
  mocks.forgetSeoActions.mockResolvedValue({ actions: 0, learnings: 0, cards: 0 });
  mocks.gaFixesEnabled.mockReturnValue(false);
  mocks.cancelGaFixes.mockResolvedValue(0);
  mocks.forgetSeoContentPlans.mockResolvedValue({ ideas: 0, pieces: 0 });
});

function expectWiped() {
  expect(mocks.update).toHaveBeenCalledWith({
    where: { id: "cred-ga" },
    data: {
      status: "REVOKED",
      encryptedSecret: "",
      metadata: { disconnectedAt: expect.any(String) },
    },
  });
  // Google Analytics ve Search Console ambarları da bağla birlikte gider.
  expect(mocks.deleteLinks).toHaveBeenCalledWith({
    where: { credentialId: "cred-ga" },
  });
  expect(mocks.deleteGscLinks).toHaveBeenCalledWith({
    where: { credentialId: "cred-ga" },
  });
  // GA-F3: ölçüm uyarıları bağdan önce silinir.
  expect(mocks.deleteHealthAlerts).toHaveBeenCalledWith("cred-ga");
  expect(mocks.deleteHealthAlerts.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.deleteLinks.mock.invocationCallOrder[0]!,
  );
  // GA-F4: bulgulardan türeyen veri bir kez, GA bağından önce silinir.
  expect(mocks.deleteGaInsights).toHaveBeenCalledTimes(1);
  expect(mocks.deleteGaInsights).toHaveBeenCalledWith("cred-ga");
  expect(mocks.deleteGaInsights.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.deleteLinks.mock.invocationCallOrder[0]!,
  );
  // GA-F5: rapor kartları bir kez, GA bağı silindikten SONRA silinir (yazarların bağ denetimi yeni yazımı durdursun).
  expect(mocks.deleteGaReports).toHaveBeenCalledTimes(1);
  expect(mocks.deleteGaReports).toHaveBeenCalledWith("cred-ga");
  expect(mocks.deleteGaReports.mock.invocationCallOrder[0]).toBeGreaterThan(
    mocks.deleteLinks.mock.invocationCallOrder[0]!,
  );
  // SC-F5: bağ yoksa boş liste, hedef değerleri GSC bağı silindikten sonra boşaltılır.
  expect(mocks.forgetSeoGoalValues).toHaveBeenCalledTimes(1);
  expect(mocks.forgetSeoGoalValues.mock.invocationCallOrder[0]).toBeGreaterThan(
    mocks.deleteGscLinks.mock.invocationCallOrder[0]!,
  );
  // GA-F6: atıf öğrenmeleri ve ga4_* kanıtı bir kez, GA bağından önce silinir.
  expect(mocks.deleteGaAttribution).toHaveBeenCalledTimes(1);
  expect(mocks.deleteGaAttribution).toHaveBeenCalledWith("cred-ga");
  expect(mocks.deleteGaAttribution.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.deleteLinks.mock.invocationCallOrder[0]!,
  );
  // SC-F6: SEO eylemleri bir kez, GSC bağından önce silinir.
  expect(mocks.forgetSeoActions).toHaveBeenCalledTimes(1);
  expect(mocks.forgetSeoActions).toHaveBeenCalledWith("cred-ga");
  expect(mocks.forgetSeoActions.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.deleteGscLinks.mock.invocationCallOrder[0]!,
  );
  // SC-F4: fırsat sinyalleri ve havuz fikirleri GSC bağından önce silinir.
  expect(mocks.forgetOpportunities).toHaveBeenCalledWith("cred-ga");
  expect(mocks.forgetOpportunities.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.deleteGscLinks.mock.invocationCallOrder[0]!,
  );
  // SC-F3: GSC uyarıları bağdan önce, denetim durumu bağdan sonra temizlenir.
  expect(mocks.deleteSearchAlerts).toHaveBeenCalledWith("cred-ga");
  expect(mocks.deleteSearchAlerts.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.deleteGscLinks.mock.invocationCallOrder[0]!,
  );
  expect(mocks.forgetSearchConsoleData).toHaveBeenCalledWith(["p1"], {
    resetScope: true,
  });
  expect(
    mocks.forgetSearchConsoleData.mock.invocationCallOrder[0],
  ).toBeGreaterThan(mocks.deleteGscLinks.mock.invocationCallOrder[0]!);
}

describe("disconnectGoogleCredential", () => {
  it("revokes at Google when no other connection uses the account", async () => {
    expect(await disconnectGoogleCredential(credential)).toEqual({
      revokedAtGoogle: true,
    });
    expect(mocks.revokeGoogleToken).toHaveBeenCalledWith("plain(enc-1)");
    expectWiped();
  });

  it("keeps Google access while the same account still runs Search Console", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "cred-gsc",
        encryptedSecret: "enc-2",
        metadata: { googleSub: "sub-1", connectedEmail: "owner@example.com" },
      },
    ]);
    expect(await disconnectGoogleCredential(credential)).toEqual({
      revokedAtGoogle: false,
    });
    expect(mocks.revokeGoogleToken).not.toHaveBeenCalled();
    expectWiped();
  });

  it("looks for the same account across every workspace, except revoked rows", async () => {
    await disconnectGoogleCredential(credential);
    const where = mocks.findMany.mock.calls[0]?.[0].where;
    expect(where.id).toEqual({ not: "cred-ga" });
    expect(where.status).toEqual({ not: "REVOKED" });
    expect(where.workspaceId).toBeUndefined();
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { encryptedSecret: "enc-1" },
        { metadata: { path: ["googleSub"], equals: "sub-1" } },
      ]),
    );
  });

  it("still wipes the token when Google's revoke fails", async () => {
    mocks.revokeGoogleToken.mockRejectedValue(new Error("network"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await disconnectGoogleCredential(credential)).toEqual({
      revokedAtGoogle: false,
    });
    expectWiped();
  });

  it("finishes the disconnect when the search cleanup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.deleteSearchAlerts.mockRejectedValue(new Error("db"));
    await disconnectGoogleCredential(credential);
    expect(mocks.deleteGscLinks).toHaveBeenCalled();
    // Uyarı silme başarısızsa proje listesi boştur; durum temizliği atlanır.
    expect(mocks.forgetSearchConsoleData).not.toHaveBeenCalled();

    mocks.deleteSearchAlerts.mockResolvedValue({ deleted: 1, projectIds: ["p1"] });
    mocks.forgetSearchConsoleData.mockRejectedValue(new Error("db"));
    await expect(disconnectGoogleCredential(credential)).resolves.toEqual({
      revokedAtGoogle: true,
    });
  });

  it("still wipes both warehouses when the measurement alert cleanup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.deleteHealthAlerts.mockRejectedValue(new Error("db"));
    await expect(disconnectGoogleCredential(credential)).resolves.toEqual({
      revokedAtGoogle: true,
    });
    expect(mocks.deleteLinks).toHaveBeenCalledWith({
      where: { credentialId: "cred-ga" },
    });
    expect(mocks.deleteGscLinks).toHaveBeenCalledWith({
      where: { credentialId: "cred-ga" },
    });
  });

  it("still wipes both warehouses when the website insight cleanup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.deleteGaInsights.mockRejectedValue(new Error("timeout"));
    await expect(disconnectGoogleCredential(credential)).resolves.toEqual({
      revokedAtGoogle: true,
    });
    expect(mocks.deleteLinks).toHaveBeenCalledWith({
      where: { credentialId: "cred-ga" },
    });
    expect(mocks.forgetOpportunities).toHaveBeenCalledWith("cred-ga");
    expect(mocks.deleteGscLinks).toHaveBeenCalledWith({
      where: { credentialId: "cred-ga" },
    });
  });

  it("finishes the disconnect when the search opportunity cleanup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.forgetOpportunities.mockRejectedValue(new Error("db"));
    await expect(disconnectGoogleCredential(credential)).resolves.toEqual({
      revokedAtGoogle: true,
    });
    expect(mocks.deleteGscLinks).toHaveBeenCalledWith({
      where: { credentialId: "cred-ga" },
    });
  });

  it("clears the SEO goal values of every project the credential was linked to", async () => {
    mocks.findGscLinks.mockResolvedValue([
      { projectId: "p1" },
      { projectId: "p1" },
      { projectId: "p2" },
    ]);
    await disconnectGoogleCredential(credential);
    expect(mocks.forgetSeoGoalValues).toHaveBeenCalledWith(["p1", "p2"]);
    expect(mocks.findGscLinks.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteGscLinks.mock.invocationCallOrder[0]!,
    );
  });

  it("still finishes when the attribution or SEO action cleanup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.deleteGaAttribution.mockRejectedValue(new Error("db"));
    mocks.forgetSeoActions.mockRejectedValue(new Error("db"));
    await expect(disconnectGoogleCredential(credential)).resolves.toEqual({
      revokedAtGoogle: true,
    });
    expect(mocks.deleteLinks).toHaveBeenCalled();
    expect(mocks.deleteGscLinks).toHaveBeenCalled();
  });

  it("with no search link it passes an empty project list", async () => {
    await disconnectGoogleCredential(credential);
    expect(mocks.forgetSeoGoalValues).toHaveBeenCalledWith([]);
  });

  it("still finishes when the website report or SEO goal cleanup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.deleteGaReports.mockRejectedValue(new Error("db"));
    mocks.forgetSeoGoalValues.mockRejectedValue(new Error("db"));
    await expect(disconnectGoogleCredential(credential)).resolves.toEqual({
      revokedAtGoogle: true,
    });
    expect(mocks.deleteLinks).toHaveBeenCalled();
    expect(mocks.deleteGscLinks).toHaveBeenCalled();
  });

  it("does not call Google for a row whose token is already gone", async () => {
    await disconnectGoogleCredential({ ...credential, encryptedSecret: "" });
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.revokeGoogleToken).not.toHaveBeenCalled();
    expectWiped();
  });
});

describe("GA-F7 and SC-F7 cleanup on disconnect", () => {
  it("cancels pending GA fixes before the GA link is deleted when the flag is on", async () => {
    mocks.gaFixesEnabled.mockReturnValue(true);
    await disconnectGoogleCredential(credential);
    expect(mocks.cancelGaFixes).toHaveBeenCalledTimes(1);
    expect(mocks.cancelGaFixes).toHaveBeenCalledWith("cred-ga");
    expect(mocks.cancelGaFixes.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteLinks.mock.invocationCallOrder[0]!,
    );
  });

  it("does not stop the disconnect when the GA fix cancellation rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.gaFixesEnabled.mockReturnValue(true);
    mocks.cancelGaFixes.mockRejectedValue(new Error("db"));
    await expect(disconnectGoogleCredential(credential)).resolves.toEqual({
      revokedAtGoogle: true,
    });
    expect(mocks.deleteLinks).toHaveBeenCalledWith({
      where: { credentialId: "cred-ga" },
    });
    expect(mocks.deleteGscLinks).toHaveBeenCalled();
  });

  it("does not call the GA fix cleanup with the flag off", async () => {
    await disconnectGoogleCredential(credential);
    expect(mocks.cancelGaFixes).not.toHaveBeenCalled();
  });

  it("forgets the SEO content plan before the GSC link is deleted, flag-independent", async () => {
    await disconnectGoogleCredential(credential);
    expect(mocks.forgetSeoContentPlans).toHaveBeenCalledWith("cred-ga");
    expect(
      mocks.forgetSeoContentPlans.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.deleteGscLinks.mock.invocationCallOrder[0]!);
  });

  it("finishes the disconnect when the SEO content plan cleanup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.forgetSeoContentPlans.mockRejectedValue(new Error("db"));
    await expect(disconnectGoogleCredential(credential)).resolves.toEqual({
      revokedAtGoogle: true,
    });
    expect(mocks.deleteGscLinks).toHaveBeenCalled();
  });
});
