import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: bağlantısı kalmamış projenin rapor kartları ve
// hedef değerleri yalnız canlı kimliği olmayan projeler için ve bağ silinmeden
// ÖNCE temizlenir; proje taraması ve rapor saklaması günlük adımdan çağrılır
// (GA_REPORTS bayrağından bağımsız).

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  deleteReportData: vi.fn(),
  sweepReports: vi.fn(),
  sweepInsights: vi.fn(),
  deleteAttribution: vi.fn(),
  sweepAttribution: vi.fn(),
  reportRetention: vi.fn(),
  linkFindMany: vi.fn(),
  linkDeleteMany: vi.fn(),
  credentialFindMany: vi.fn(),
  sliceDeleteMany: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    gaReportSlice: { deleteMany: mocks.sliceDeleteMany },
    gaDailyTotal: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    gaMonthlySummary: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    gaPropertyLink: {
      findMany: mocks.linkFindMany,
      deleteMany: mocks.linkDeleteMany,
    },
    integrationCredential: { findMany: mocks.credentialFindMany },
  },
}));
vi.mock("@/lib/website-analytics/flags", () => ({
  GaFlags: { sync: () => true },
  gaGlobalWorkAllowedHere: () => true,
}));
vi.mock("@/server/observability/periodic", () => ({
  claimPeriodic: mocks.claim,
}));
vi.mock("@/server/integrations/google-client", () => ({
  GOOGLE_PROVIDER: { analytics: "google_analytics" },
}));
vi.mock("./analysis/cleanup", () => ({
  sweepOrphanGaInsightData: mocks.sweepInsights,
}));
vi.mock("./attribution/cleanup", () => ({
  deleteGaAttributionData: mocks.deleteAttribution,
  sweepOrphanGaAttributionData: mocks.sweepAttribution,
}));
vi.mock("./reports/cleanup", () => ({
  deleteGaReportData: mocks.deleteReportData,
  sweepOrphanGaReportData: mocks.sweepReports,
}));
vi.mock("./reports/retention", () => ({
  GaReportRetention: { runDue: mocks.reportRetention },
}));

const { GaRetention } = await import("./retention");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claim.mockResolvedValue(true);
  mocks.sliceDeleteMany.mockResolvedValue({ count: 0 });
  mocks.linkDeleteMany.mockResolvedValue({ count: 1 });
  mocks.deleteReportData.mockResolvedValue({});
  mocks.sweepReports.mockResolvedValue(0);
  mocks.sweepInsights.mockResolvedValue(0);
  mocks.deleteAttribution.mockResolvedValue({ learnings: 0, decisions: 0 });
  mocks.sweepAttribution.mockResolvedValue(0);
  mocks.reportRetention.mockResolvedValue(0);
});

describe("GaRetention.runDue", () => {
  it("clears report data only for projects without a live link, before the links go", async () => {
    mocks.linkFindMany.mockResolvedValue([
      { id: "l1", credentialId: "c-dead", projectId: "p-orphan" },
      { id: "l2", credentialId: "c-live", projectId: "p-live" },
      // p-mixed: biri canlı biri yetim bağ; projenin canlı bağı var.
      { id: "l3", credentialId: "c-dead", projectId: "p-mixed" },
      { id: "l4", credentialId: "c-live", projectId: "p-mixed" },
    ]);
    mocks.credentialFindMany.mockResolvedValue([{ id: "c-live" }]);
    await GaRetention.runDue(new Date("2026-10-07T03:00:00Z"));
    expect(mocks.deleteReportData).toHaveBeenCalledTimes(1);
    expect(mocks.deleteReportData).toHaveBeenCalledWith("p-orphan");
    // Son linkDeleteMany çağrısı yetim bağları siler (öncekisi eski bağlar).
    const lastLinkDelete = mocks.linkDeleteMany.mock.invocationCallOrder.at(-1)!;
    expect(mocks.deleteReportData.mock.invocationCallOrder[0]).toBeLessThan(
      lastLinkDelete,
    );
    expect(mocks.linkDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["l1", "l3"] } },
    });
  });

  it("runs the project sweep and the report retention every day", async () => {
    mocks.linkFindMany.mockResolvedValue([]);
    const now = new Date("2026-10-07T03:00:00Z");
    await GaRetention.runDue(now);
    expect(mocks.sweepReports).toHaveBeenCalledTimes(1);
    expect(mocks.sweepAttribution).toHaveBeenCalledTimes(1);
    expect(mocks.reportRetention).toHaveBeenCalledWith(now);
  });

  it("keeps the daily step going when the attribution sweep fails", async () => {
    mocks.linkFindMany.mockResolvedValue([]);
    mocks.sweepAttribution.mockRejectedValue(new Error("boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await GaRetention.runDue(new Date("2026-10-07T03:00:00Z"));
    expect(mocks.reportRetention).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("does nothing when the daily claim is taken", async () => {
    mocks.claim.mockResolvedValue(false);
    expect(await GaRetention.runDue()).toBe(0);
    expect(mocks.sweepReports).not.toHaveBeenCalled();
    expect(mocks.reportRetention).not.toHaveBeenCalled();
  });
});
