import { beforeEach, describe, expect, it, vi } from "vitest";

// Disconnect'te atıf temizliği yarıda kalırsa günlük GaRetention taraması
// yalnız canlı GA bağı/kimliği olmayan projelerin kalanlarını siler.

const mocks = vi.hoisted(() => ({
  learningGroup: vi.fn(),
  decisionGroup: vi.fn(),
  learningDelete: vi.fn(),
  decisionFind: vi.fn(),
  linkFindMany: vi.fn(),
  credentialFindMany: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    brandLearning: {
      groupBy: mocks.learningGroup,
      deleteMany: mocks.learningDelete,
    },
    adsDecision: {
      groupBy: mocks.decisionGroup,
      findMany: mocks.decisionFind,
    },
    gaPropertyLink: { findMany: mocks.linkFindMany },
    integrationCredential: { findMany: mocks.credentialFindMany },
  },
}));
vi.mock("@/server/integrations/google/services", () => ({
  GOOGLE_PROVIDER: { analytics: "google_analytics" },
}));

const { sweepOrphanGaAttributionData } = await import("./cleanup");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.learningDelete.mockResolvedValue({ count: 2 });
  mocks.decisionFind.mockResolvedValue([]);
  mocks.linkFindMany.mockResolvedValue([]);
  mocks.credentialFindMany.mockResolvedValue([]);
});

describe("sweepOrphanGaAttributionData", () => {
  it("does nothing when no project holds GA4 attribution leftovers", async () => {
    mocks.learningGroup.mockResolvedValue([]);
    mocks.decisionGroup.mockResolvedValue([]);
    expect(await sweepOrphanGaAttributionData()).toBe(0);
    expect(mocks.learningDelete).not.toHaveBeenCalled();
  });

  it("cleans only projects with neither a live link nor a live credential", async () => {
    mocks.learningGroup.mockResolvedValue([
      { projectId: "p-orphan" },
      { projectId: "p-link" },
    ]);
    mocks.decisionGroup.mockResolvedValue([
      { projectId: "p-orphan" },
      { projectId: "p-cred" },
    ]);
    mocks.linkFindMany.mockResolvedValue([{ projectId: "p-link" }]);
    mocks.credentialFindMany.mockResolvedValue([{ projectId: "p-cred" }]);

    expect(await sweepOrphanGaAttributionData()).toBe(2);
    expect(mocks.learningDelete).toHaveBeenCalledTimes(1);
    expect(mocks.learningDelete.mock.calls[0]![0].where.projectId).toBe(
      "p-orphan",
    );
  });
});
