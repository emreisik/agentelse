import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: the weekly web scan runs once a week per active
// project (a failed one again after six hours), longest-unscanned first and a
// few projects per tick; only signals with a real http(s) source are stored,
// with a known category, trimmed, without repeats and capped; and they go in
// through the signal front door so the usual chain takes over.

const project = { findMany: vi.fn() };
const reasoningCall = { findMany: vi.fn() };
const brand = { findFirst: vi.fn() };
vi.mock("@/lib/prisma", () => ({ prisma: { project, reasoningCall, brand } }));

const getBrandContext = vi.fn();
vi.mock("@/server/agency/constitution/constitution-service", () => ({
  ConstitutionService: { getBrandContext },
}));

const ingestRaw = vi.fn();
vi.mock("@/server/agency/signals/signal-universe", () => ({
  SignalUniverse: { ingestRaw },
}));

const run = vi.fn();
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { run },
}));

const isProjectAgencyActive = vi.fn();
vi.mock("@/server/repositories/agency-loop-state.repository", () => ({
  isProjectAgencyActive,
}));

const { WebSignalScanner, normalizeWebSignals, webScanDue } =
  await import("./web-signal-scanner");

const NOW = new Date("2026-10-04T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

beforeEach(() => {
  vi.clearAllMocks();
  console.error = vi.fn();
  isProjectAgencyActive.mockResolvedValue(true);
  brand.findFirst.mockResolvedValue({ id: "b1", name: "Web Health" });
  getBrandContext.mockResolvedValue({ markets: ["Türkiye", 3] });
  ingestRaw.mockResolvedValue({ duplicate: false });
  run.mockResolvedValue({
    output: {
      signals: [
        {
          category: "COMPETITOR",
          title: "Rival launches a clinic package",
          summary: "A rival offers a bundle.",
          sourceUrl: "https://news.example.com/a",
          date: "2026-10-01",
        },
      ],
    },
    isMock: false,
  });
});

describe("webScanDue", () => {
  it("scans weekly, and retries a failure after six hours", () => {
    expect(webScanDue(null, NOW)).toBe(true);
    expect(webScanDue({ createdAt: daysAgo(6), status: "OK" }, NOW)).toBe(
      false,
    );
    expect(webScanDue({ createdAt: daysAgo(7), status: "OK" }, NOW)).toBe(true);
    expect(
      webScanDue(
        { createdAt: new Date(NOW.getTime() - 3_600_000), status: "ERROR" },
        NOW,
      ),
    ).toBe(false);
    expect(
      webScanDue(
        { createdAt: new Date(NOW.getTime() - 7 * 3_600_000), status: "ERROR" },
        NOW,
      ),
    ).toBe(true);
  });
});

describe("normalizeWebSignals", () => {
  const signal = (over: Record<string, unknown> = {}) => ({
    category: "SOCIAL_TREND",
    title: "  A trend  ",
    summary: " Why it matters ",
    sourceUrl: "https://example.com/t",
    date: "2026-10-01",
    ...over,
  });

  it("keeps only real sources, a known category, trimmed and once", () => {
    const out = normalizeWebSignals(
      {
        signals: [
          signal(),
          signal(), // a repeat
          signal({ sourceUrl: "javascript:alert(1)", title: "Bad source" }),
          signal({ sourceUrl: "not a url", title: "No source" }),
          signal({ title: "   ", sourceUrl: "https://example.com/empty" }),
          signal({
            category: "WEIRD",
            title: "Odd category",
            sourceUrl: "https://example.com/o",
          }),
          signal({
            title: "No date",
            sourceUrl: "https://example.com/d",
            date: undefined,
          }),
        ],
      },
      NOW,
    );
    expect(out.map((s) => s.title)).toEqual([
      "A trend",
      "Odd category",
      "No date",
    ]);
    expect(out[0]).toMatchObject({
      category: "SOCIAL_TREND",
      summary: "Why it matters",
      sourceUrl: "https://example.com/t",
      occurredAt: new Date("2026-10-01T00:00:00Z"),
    });
    expect(out[1]!.category).toBe("MARKET");
    expect(out[2]!.occurredAt).toBeUndefined();
  });

  it("stores at most eight", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      signal({ title: `S${i}`, sourceUrl: `https://example.com/${i}` }),
    );
    expect(normalizeWebSignals({ signals: many }, NOW)).toHaveLength(8);
  });
});

describe("WebSignalScanner.runDueScans", () => {
  it("scans due projects, longest-unscanned first, at most `limit`", async () => {
    project.findMany.mockResolvedValue([
      { id: "p-fresh", workspaceId: "w" },
      { id: "p-old", workspaceId: "w" },
      { id: "p-never", workspaceId: "w" },
    ]);
    reasoningCall.findMany.mockResolvedValue([
      { projectId: "p-fresh", createdAt: daysAgo(1), status: "OK" },
      { projectId: "p-old", createdAt: daysAgo(9), status: "OK" },
    ]);

    expect(await WebSignalScanner.runDueScans(1, NOW)).toBe(1);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![1]).toMatchObject({
      projectId: "p-never",
      brandId: "b1",
      context: {
        brandName: "Web Health",
        market: "Türkiye",
        today: "2026-10-04",
      },
    });
    expect(reasoningCall.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ purpose: "signal.webScan" }),
      }),
    );
  });

  it("stores each signal through the signal front door with its source", async () => {
    project.findMany.mockResolvedValue([{ id: "p1", workspaceId: "w" }]);
    reasoningCall.findMany.mockResolvedValue([]);

    await WebSignalScanner.runDueScans(2, NOW);

    expect(ingestRaw).toHaveBeenCalledWith({
      workspaceId: "w",
      projectId: "p1",
      brandId: "b1",
      source: "web-scan",
      category: "COMPETITOR",
      externalRef: "https://news.example.com/a",
      title: "Rival launches a clinic package",
      summary: "A rival offers a bundle.",
      payload: { sourceUrl: "https://news.example.com/a" },
      occurredAt: new Date("2026-10-01T00:00:00Z"),
      reliability: 0.6,
    });
  });

  it("skips a paused project and one without a brand, and survives a failed call", async () => {
    project.findMany.mockResolvedValue([
      { id: "p-paused", workspaceId: "w" },
      { id: "p-nobrand", workspaceId: "w" },
      { id: "p-fails", workspaceId: "w" },
    ]);
    reasoningCall.findMany.mockResolvedValue([]);
    isProjectAgencyActive.mockImplementation(
      async (id: string) => id !== "p-paused",
    );
    brand.findFirst.mockImplementation(
      async ({ where }: { where: { projectId: string } }) =>
        where.projectId === "p-nobrand" ? null : { id: "b1", name: "Brand" },
    );
    run.mockRejectedValue(new Error("search down"));

    expect(await WebSignalScanner.runDueScans(5, NOW)).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(ingestRaw).not.toHaveBeenCalled();
  });

  it("does nothing without active projects", async () => {
    project.findMany.mockResolvedValue([]);
    expect(await WebSignalScanner.runDueScans(2, NOW)).toBe(0);
    expect(reasoningCall.findMany).not.toHaveBeenCalled();
  });
});
