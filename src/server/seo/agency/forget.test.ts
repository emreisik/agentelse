import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: {
    seoReport: { findMany: vi.fn() },
    gscSiteSetting: { updateMany: vi.fn(), deleteMany: vi.fn() },
    gscBqSource: { updateMany: vi.fn(), deleteMany: vi.fn() },
    integrationCredential: { findUnique: vi.fn() },
  },
  deleteForReports: vi.fn(),
  deleteForProject: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.db }));
vi.mock("@/server/integrations/google-client", () => ({
  GOOGLE_PROVIDER: { search_console: "GOOGLE_SEARCH_CONSOLE" },
}));
vi.mock("@/server/report-share/store", () => ({
  ReportShares: {
    deleteForReports: mocks.deleteForReports,
    deleteForProject: mocks.deleteForProject,
  },
}));

const { forgetAgencyForCredential, forgetAgencyForProjectMode } = await import("./forget");

beforeEach(() => {
  vi.unstubAllEnvs();
  // Bayrak kapalı: silme yolları bayrağa bağlı değildir.
  vi.stubEnv("GSC_AGENCY", "");
  vi.stubEnv("GSC_SYNC", "");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.db.seoReport.findMany.mockReset().mockResolvedValue([{ id: "rep-1" }, { id: "rep-2" }]);
  mocks.db.gscSiteSetting.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mocks.db.gscSiteSetting.deleteMany.mockReset().mockResolvedValue({ count: 2 });
  mocks.db.gscBqSource.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mocks.db.gscBqSource.deleteMany.mockReset().mockResolvedValue({ count: 1 });
  mocks.db.integrationCredential.findUnique.mockReset().mockResolvedValue({
    projectId: "proj-1",
    provider: "GOOGLE_SEARCH_CONSOLE",
  });
  mocks.deleteForReports.mockReset().mockResolvedValue(2);
  mocks.deleteForProject.mockReset().mockResolvedValue(3);
});

describe("forgetAgencyForProjectMode", () => {
  it("runs with every flag off, deleting the shares of this mode's reports", async () => {
    await forgetAgencyForProjectMode("proj-1", false);
    expect(mocks.db.seoReport.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "proj-1", isMock: false } }),
    );
    expect(mocks.deleteForReports).toHaveBeenCalledWith("SEARCH", ["rep-1", "rep-2"]);
  });

  it("resets the applied page-group state but keeps rules and membership", async () => {
    await forgetAgencyForProjectMode("proj-1", false);
    expect(mocks.db.gscSiteSetting.updateMany).toHaveBeenCalledWith({
      where: { projectId: "proj-1", isMock: false },
      data: {
        groupsAppliedVersion: 0,
        groupsAppliedWeek: null,
        groupsCursor: null,
        groupsLeaseUntil: null,
        groupsLeaseOwner: null,
      },
    });
    expect(mocks.db.gscSiteSetting.deleteMany).not.toHaveBeenCalled();
  });

  it("clears Google-derived BigQuery fields, returns to DRAFT and keeps ids and caps", async () => {
    await forgetAgencyForProjectMode("proj-1", true);
    const call = mocks.db.gscBqSource.updateMany.mock.calls[0]?.[0] as { where: unknown; data: Record<string, unknown> };
    expect(call.where).toEqual({ projectId: "proj-1", isMock: true });
    expect(call.data).toEqual({
      reconcile: Prisma.DbNull,
      exportStart: null,
      exportedThrough: null,
      coverageCheckedAt: null,
      lastVerifiedAt: null,
      lastSyncAt: null,
      lastError: null,
      consecutiveFailures: 0,
      nextRunAt: null,
      leaseUntil: null,
      leaseOwner: null,
      status: "DRAFT",
    });
    for (const kept of ["bqProjectId", "dataset", "location", "bqSiteUrl", "maxBytesPerQuery", "monthlyBudgetBytes", "importAll", "bytesBilledMonth"]) {
      expect(call.data).not.toHaveProperty(kept);
    }
    expect(mocks.db.gscBqSource.deleteMany).not.toHaveBeenCalled();
  });

  it("never throws and keeps going when a step fails", async () => {
    mocks.db.seoReport.findMany.mockRejectedValue(new Error("db"));
    mocks.db.gscSiteSetting.updateMany.mockRejectedValue(new Error("db"));
    mocks.db.gscBqSource.updateMany.mockRejectedValue(new Error("db"));
    await expect(forgetAgencyForProjectMode("proj-1", false)).resolves.toBeUndefined();
    expect(mocks.db.gscBqSource.updateMany).toHaveBeenCalled();
  });

  it("skips the share delete when the mode has no reports", async () => {
    mocks.db.seoReport.findMany.mockResolvedValue([]);
    await forgetAgencyForProjectMode("proj-1", false);
    expect(mocks.deleteForReports).not.toHaveBeenCalled();
  });
});

describe("forgetAgencyForCredential", () => {
  it("deletes by project id, not by link rows, even when no link remains", async () => {
    const result = await forgetAgencyForCredential("cred-1");
    expect(result).toEqual({ shares: 3, settings: 2, bqSources: 1 });
    expect(mocks.deleteForProject).toHaveBeenCalledWith("SEARCH", "proj-1");
    expect(mocks.db.gscSiteSetting.deleteMany).toHaveBeenCalledWith({
      where: { projectId: "proj-1" },
    });
    expect(mocks.db.gscBqSource.deleteMany).toHaveBeenCalledWith({
      where: { projectId: "proj-1" },
    });
  });

  it("returns zeros for a credential of another provider or a missing one", async () => {
    mocks.db.integrationCredential.findUnique.mockResolvedValue({
      projectId: "proj-1",
      provider: "GOOGLE_ANALYTICS",
    });
    expect(await forgetAgencyForCredential("cred-ga")).toEqual({
      shares: 0,
      settings: 0,
      bqSources: 0,
    });
    mocks.db.integrationCredential.findUnique.mockResolvedValue(null);
    expect(await forgetAgencyForCredential("missing")).toEqual({
      shares: 0,
      settings: 0,
      bqSources: 0,
    });
    expect(mocks.db.gscSiteSetting.deleteMany).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    mocks.db.integrationCredential.findUnique.mockRejectedValue(new Error("db"));
    expect(await forgetAgencyForCredential("x")).toEqual({ shares: 0, settings: 0, bqSources: 0 });
    mocks.db.integrationCredential.findUnique.mockResolvedValue({
      projectId: "proj-1",
      provider: "GOOGLE_SEARCH_CONSOLE",
    });
    mocks.deleteForProject.mockRejectedValue(new Error("db"));
    mocks.db.gscSiteSetting.deleteMany.mockRejectedValue(new Error("db"));
    const result = await forgetAgencyForCredential("cred-1");
    expect(result).toEqual({ shares: 0, settings: 0, bqSources: 1 });
  });

  it("'Delete stored data' then Disconnect leaves no settings or BigQuery config", async () => {
    // Delete stored data: yapılandırma kalır.
    await forgetAgencyForProjectMode("proj-1", false);
    expect(mocks.db.gscSiteSetting.deleteMany).not.toHaveBeenCalled();
    // Disconnect: bağ satırı yok, yine de proje kimliğiyle silinir.
    await forgetAgencyForCredential("cred-1");
    expect(mocks.db.gscSiteSetting.deleteMany).toHaveBeenCalledWith({ where: { projectId: "proj-1" } });
    expect(mocks.db.gscBqSource.deleteMany).toHaveBeenCalledWith({ where: { projectId: "proj-1" } });
  });
});
