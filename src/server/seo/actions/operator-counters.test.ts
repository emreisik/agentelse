import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: bayrak kapalıyken null döner ve veritabanına
// gidilmez; sayaçlar yalnız sayıdır (iç içe kayıtlar dahil), 30 günlük
// INCONCLUSIVE nedenleri bilinen anahtarlara indirgenir ve bir sayaç
// düşerse 0 olur.

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  groupBy: vi.fn(),
  raw: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoAction: { count: mocks.count, groupBy: mocks.groupBy },
    $queryRaw: mocks.raw,
  },
}));

const { loadSeoActionCounters } = await import("./operator-counters");

const NOW = new Date("2026-10-07T12:00:00.000Z");
const ENV_KEYS = [
  "SEO_ACTIONS",
  "SEO_HEALTH",
  "SEO_CRAWL",
  "AGENTELSE_PROVIDER_MODE",
];
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

function onlyNumbers(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (value && typeof value === "object") {
    return Object.values(value).every(onlyNumbers);
  }
  return false;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SEO_ACTIONS = "true";
  process.env.SEO_HEALTH = "true";
  process.env.SEO_CRAWL = "true";
  delete process.env.AGENTELSE_PROVIDER_MODE;
  mocks.count.mockResolvedValue(4);
  mocks.groupBy.mockResolvedValue([
    { status: "WORKED", _count: { _all: 3 } },
    { status: "INCONCLUSIVE", _count: { _all: 2 } },
  ]);
  mocks.raw.mockResolvedValue([
    { reason: "LOW_DATA", count: 2 },
    { reason: "GOOGLE_UPDATE", count: 1 },
    { reason: "SOMETHING_ELSE", count: 9 },
    { reason: null, count: 5 },
  ]);
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("loadSeoActionCounters", () => {
  it("returns null without a database call when the loop is off", async () => {
    process.env.SEO_ACTIONS = "false";
    expect(await loadSeoActionCounters(NOW)).toBeNull();
    process.env.SEO_ACTIONS = "true";
    process.env.SEO_CRAWL = "false";
    expect(await loadSeoActionCounters(NOW)).toBeNull();
    expect(mocks.count).not.toHaveBeenCalled();
    expect(mocks.groupBy).not.toHaveBeenCalled();
    expect(mocks.raw).not.toHaveBeenCalled();
  });

  it("returns only numbers, including nested records", async () => {
    const counters = await loadSeoActionCounters(NOW);
    expect(counters).not.toBeNull();
    expect(onlyNumbers(counters)).toBe(true);
    expect(counters).toEqual({
      open: 4,
      awaitingVerification: 4,
      asked: 4,
      measuring: 4,
      evaluated30d: { worked: 3, didnt: 0, inconclusive: 2 },
      inconclusiveByReason30d: { LOW_DATA: 2, GOOGLE_UPDATE: 1 },
      expired30d: 4,
      learnings30d: 4,
    });
  });

  it("counts only the current mode", async () => {
    await loadSeoActionCounters(NOW);
    for (const call of mocks.count.mock.calls) {
      expect(call[0].where.isMock).toBe(false);
    }
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    mocks.count.mockClear();
    await loadSeoActionCounters(NOW);
    for (const call of mocks.count.mock.calls) {
      expect(call[0].where.isMock).toBe(true);
    }
  });

  it("selects no text columns (counts and groupings only)", async () => {
    await loadSeoActionCounters(NOW);
    for (const call of mocks.count.mock.calls) {
      expect(call[0].select).toBeUndefined();
    }
    expect(mocks.groupBy.mock.calls[0]![0].by).toEqual(["status"]);
  });

  it("falls back to 0 for a counter that fails", async () => {
    mocks.count.mockRejectedValue(new Error("db"));
    mocks.groupBy.mockRejectedValue(new Error("db"));
    mocks.raw.mockRejectedValue(new Error("db"));
    const counters = await loadSeoActionCounters(NOW);
    expect(counters).toEqual({
      open: 0,
      awaitingVerification: 0,
      asked: 0,
      measuring: 0,
      evaluated30d: { worked: 0, didnt: 0, inconclusive: 0 },
      inconclusiveByReason30d: {},
      expired30d: 0,
      learnings30d: 0,
    });
  });
});
