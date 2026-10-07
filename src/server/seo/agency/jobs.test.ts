import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeRaw: vi.fn(),
  claim: vi.fn(),
  reconcileAll: vi.fn(),
  regroupDue: vi.fn(),
  bqRunDue: vi.fn(),
  splitRunDue: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: { $executeRaw: mocks.executeRaw } }));
vi.mock("@/server/integrations/google-client", () => ({
  GOOGLE_PROVIDER: { search_console: "GOOGLE_SEARCH_CONSOLE" },
}));
vi.mock("@/server/observability/periodic", () => ({
  claimPeriodic: mocks.claim,
}));
vi.mock("@/server/seo/agency/bq/sync", () => ({
  GscBigQuerySync: { runDue: mocks.bqRunDue },
}));
vi.mock("@/server/seo/agency/split/store", () => ({
  GscSplitTests: { runDue: mocks.splitRunDue },
}));
vi.mock("./page-groups", () => ({
  GscPageGroups: { regroupDue: mocks.regroupDue },
}));
vi.mock("./sites", () => ({ GscSites: { reconcileAll: mocks.reconcileAll } }));

const { GscAgency } = await import("./jobs");

function allMocks() {
  return Object.values(mocks);
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("GSC_AGENCY", "true");
  vi.stubEnv("GSC_BIGQUERY", "true");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
  vi.stubEnv("GSC_SYNC_DEV_PROJECTS", "");
  for (const mock of allMocks()) mock.mockReset();
  mocks.claim.mockResolvedValue(true);
  mocks.reconcileAll.mockResolvedValue(1);
  mocks.regroupDue.mockResolvedValue(2);
  mocks.bqRunDue.mockResolvedValue(4);
  mocks.splitRunDue.mockResolvedValue(8);
  mocks.executeRaw.mockResolvedValue(0);
});

describe("GscAgency.runDue", () => {
  it("returns 0 with zero prisma or sibling calls when the flag is off", async () => {
    vi.stubEnv("GSC_AGENCY", "");
    expect(await GscAgency.runDue()).toBe(0);
    for (const mock of allMocks()) expect(mock).not.toHaveBeenCalled();
  });

  it("runs every step in order and sums the counts", async () => {
    const order: string[] = [];
    mocks.reconcileAll.mockImplementation(async () => (order.push("links"), 1));
    mocks.regroupDue.mockImplementation(async () => (order.push("groups"), 2));
    mocks.bqRunDue.mockImplementation(async () => (order.push("bq"), 4));
    mocks.splitRunDue.mockImplementation(async () => (order.push("split"), 8));
    mocks.executeRaw.mockImplementation(async () => (order.push("sweep"), 16));
    // Her süpürme parçası 500'den küçük döner, tek tur.
    const total = await GscAgency.runDue();
    expect(order.slice(0, 4)).toEqual(["links", "groups", "bq", "split"]);
    expect(order[4]).toBe("sweep");
    expect(total).toBe(1 + 2 + 4 + 8 + 16 * 6);
    expect(mocks.claim).toHaveBeenCalledWith("gsc.agency-links", 120_000, expect.any(Date));
    expect(mocks.claim).toHaveBeenCalledWith(
      "gsc.agency-retention",
      24 * 60 * 60_000,
      expect.any(Date),
    );
  });

  it("isolates a failing step: the others still run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.regroupDue.mockRejectedValue(new TypeError("boom"));
    const total = await GscAgency.runDue();
    expect(mocks.bqRunDue).toHaveBeenCalled();
    expect(mocks.splitRunDue).toHaveBeenCalled();
    expect(total).toBe(1 + 4 + 8);
    expect(console.error).toHaveBeenCalledWith("[gsc-agency] page-groups failed:", "TypeError");
  });

  it("runs the BigQuery step only when its flag is on", async () => {
    vi.stubEnv("GSC_BIGQUERY", "");
    await GscAgency.runDue();
    expect(mocks.bqRunDue).not.toHaveBeenCalled();
    expect(mocks.splitRunDue).toHaveBeenCalled();
  });

  it("passes one deadline (epoch ms) to the sub-jobs", async () => {
    const before = Date.now();
    await GscAgency.runDue(new Date(), { deadlineMs: 50_000 });
    const [, , groupsDeadline] = mocks.regroupDue.mock.calls[0] ?? [];
    const [, , bqDeadline] = mocks.bqRunDue.mock.calls[0] ?? [];
    const [, , splitDeadline] = mocks.splitRunDue.mock.calls[0] ?? [];
    expect(groupsDeadline).toBeGreaterThanOrEqual(before + 50_000);
    expect(groupsDeadline).toBeLessThan(before + 60_000);
    expect(bqDeadline).toBe(groupsDeadline);
    expect(splitDeadline).toBe(groupsDeadline);
  });

  it("skips the remaining steps once the overall deadline has passed", async () => {
    expect(await GscAgency.runDue(new Date(), { deadlineMs: -1 })).toBe(0);
    for (const mock of allMocks()) expect(mock).not.toHaveBeenCalled();
  });

  it("skips link reconcile and the sweep when the periodic claim is lost", async () => {
    mocks.claim.mockResolvedValue(false);
    await GscAgency.runDue();
    expect(mocks.reconcileAll).not.toHaveBeenCalled();
    expect(mocks.executeRaw).not.toHaveBeenCalled();
    expect(mocks.regroupDue).toHaveBeenCalled();
  });

  it("never claims a periodic key on a dev process sharing the live database", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@ep-live.neon.tech/db");
    await GscAgency.runDue();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.executeRaw).not.toHaveBeenCalled();
    expect(mocks.reconcileAll).toHaveBeenCalledTimes(1);
    // 2 dakikalık süreç içi kısma: hemen ikinci tur bağ hizalamaz.
    await GscAgency.runDue();
    expect(mocks.reconcileAll).toHaveBeenCalledTimes(1);
    expect(mocks.regroupDue).toHaveBeenCalledTimes(2);
  });

  it("repeats a sweep statement while it returns full chunks", async () => {
    mocks.executeRaw.mockResolvedValueOnce(500).mockResolvedValueOnce(3).mockResolvedValue(0);
    await GscAgency.runDue();
    // İlk tablo iki tur, kalan 5 ifade birer tur.
    expect(mocks.executeRaw).toHaveBeenCalledTimes(7);
  });
});
