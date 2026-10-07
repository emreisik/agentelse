import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  allowed: vi.fn(() => true),
  claim: vi.fn(async () => true),
  risc: vi.fn(async () => 0),
  bigQuery: vi.fn(async () => 0),
  sweep: vi.fn(async () => 0),
}));

vi.mock("@/lib/website-analytics/flags", () => ({
  gaGlobalWorkAllowedHere: mocks.allowed,
}));
vi.mock("@/server/observability/periodic", () => ({
  claimPeriodic: mocks.claim,
}));
vi.mock("@/server/integrations/google/risc/retention", () => ({
  GoogleRisc: { retention: mocks.risc },
}));
vi.mock("@/server/website-analytics/bigquery/reader", () => ({
  GaBigQuery: { retention: mocks.bigQuery },
}));
vi.mock("@/server/website-analytics/agency/share-forget", () => ({
  sweepOrphanWebsiteShares: mocks.sweep,
}));

import { GaAgencyRetention } from "./retention";

// Bu dosyanın kanıtladığı (GA-F8): günlük saklama toplayıcısı yalnız küresel iş
// koruması ve günlük kilitle sınırlıdır, üç parçayı toplar, bir parçanın hatası
// diğerlerini durdurmaz ve ajans bayrakları kapalıyken de çalışır.

const NOW = new Date("2026-10-07T03:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.allowed.mockReturnValue(true);
  mocks.claim.mockResolvedValue(true);
  mocks.risc.mockResolvedValue(0);
  mocks.bigQuery.mockResolvedValue(0);
  mocks.sweep.mockResolvedValue(0);
});

describe("GaAgencyRetention.runDue", () => {
  it("does nothing in a dev process that shares the live database", async () => {
    mocks.allowed.mockReturnValue(false);
    expect(await GaAgencyRetention.runDue(NOW)).toBe(0);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.risc).not.toHaveBeenCalled();
  });

  it("does nothing when the daily claim is not won", async () => {
    mocks.claim.mockResolvedValue(false);
    expect(await GaAgencyRetention.runDue(NOW)).toBe(0);
    expect(mocks.claim).toHaveBeenCalledWith("ga.agency.retention", 86_400_000, NOW);
    expect(mocks.sweep).not.toHaveBeenCalled();
  });

  it("sums the three parts", async () => {
    mocks.risc.mockResolvedValue(3);
    mocks.bigQuery.mockResolvedValue(10);
    mocks.sweep.mockResolvedValue(2);
    expect(await GaAgencyRetention.runDue(NOW)).toBe(15);
    expect(mocks.risc).toHaveBeenCalledWith(NOW);
    expect(mocks.bigQuery).toHaveBeenCalledWith(NOW);
  });

  it("keeps going when one part fails and logs only the error name", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.risc.mockRejectedValue(new TypeError("secret detail"));
    mocks.bigQuery.mockResolvedValue(4);
    mocks.sweep.mockResolvedValue(1);
    expect(await GaAgencyRetention.runDue(NOW)).toBe(5);
    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).toContain("TypeError");
    expect(logged).not.toContain("secret detail");
    spy.mockRestore();
  });

  it("runs with every agency flag off (documented exception)", async () => {
    vi.stubEnv("GA_AGENCY", "");
    vi.stubEnv("GA_SYNC", "");
    vi.stubEnv("GOOGLE_RISC", "");
    mocks.sweep.mockResolvedValue(7);
    expect(await GaAgencyRetention.runDue(NOW)).toBe(7);
  });
});
