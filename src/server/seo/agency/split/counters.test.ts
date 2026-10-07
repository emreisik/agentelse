import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: bayrak kapalıyken sayaçlar null döner ve
// veritabanına gidilmez; açıkken tek groupBy sorgusu durumları sayılara çevirir.

const mocks = vi.hoisted(() => ({ groupBy: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: { gscSplitTest: { groupBy: mocks.groupBy } },
}));

const { loadSplitCounters } = await import("./counters");

beforeEach(() => {
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "");
  vi.stubEnv("GSC_SYNC", "");
  vi.stubEnv("GSC_AGENCY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("loadSplitCounters", () => {
  it("is null and query-free with the flag off", async () => {
    expect(await loadSplitCounters()).toBeNull();
    vi.stubEnv("GSC_AGENCY", "true");
    expect(await loadSplitCounters()).toBeNull();
    expect(mocks.groupBy).not.toHaveBeenCalled();
  });

  it("turns one grouped query into counters", async () => {
    vi.stubEnv("GSC_SYNC", "true");
    vi.stubEnv("GSC_AGENCY", "true");
    mocks.groupBy.mockResolvedValue([
      { status: "DRAFT", _count: { _all: 2 } },
      { status: "APPLIED", _count: { _all: 1 } },
      { status: "EVALUATING", _count: { _all: 3 } },
      { status: "WORKED", _count: { _all: 4 } },
      { status: "DIDNT", _count: { _all: 5 } },
      { status: "INCONCLUSIVE", _count: { _all: 6 } },
      { status: "EXPIRED", _count: { _all: 7 } },
    ]);
    expect(await loadSplitCounters(new Date("2026-10-01T00:00:00.000Z"))).toEqual({
      open: 6,
      applied: 1,
      evaluating: 3,
      evaluated30d: { worked: 4, didnt: 5, inconclusive: 6 },
      expired30d: 7,
    });
    expect(mocks.groupBy).toHaveBeenCalledTimes(1);
  });

  it("returns zeros for an empty table", async () => {
    vi.stubEnv("GSC_SYNC", "true");
    vi.stubEnv("GSC_AGENCY", "true");
    mocks.groupBy.mockResolvedValue([]);
    expect(await loadSplitCounters()).toEqual({
      open: 0,
      applied: 0,
      evaluating: 0,
      evaluated30d: { worked: 0, didnt: 0, inconclusive: 0 },
      expired30d: 0,
    });
  });
});
