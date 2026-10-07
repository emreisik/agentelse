import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: nüfus tek ham sorguyla okunur, grup/hafta/dışlanan
// kimlikler SQL'e parametre olarak gider (metne gömülmez); sınır 4001 satırla
// anlaşılır ve capped döner; sayfa başına grup seçilir; kapsama yalnız önceki
// haftaları sayar; açık testlerin ve açık eylemlerin sayfaları ayrılır;
// SeoSite yoksa kapsam null.

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  coverage: vi.fn(),
  splitPages: vi.fn(),
  actions: vi.fn(),
  site: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: mocks.queryRaw,
    gscSplitTestPage: { findMany: mocks.splitPages },
    seoAction: { findMany: mocks.actions },
    seoSite: { findUnique: mocks.site },
  },
}));
vi.mock("@/server/seo/store", () => ({ readPeriodCoverage: mocks.coverage }));
vi.mock("@/server/seo/site/scope", () => ({
  parseStoredScope: (value: unknown) =>
    value && typeof value === "object" ? (value as { root: string }) : null,
}));

const { readPopulation, openPageIds, splitSiteScope } = await import("./population");

const PRE = ["2026-06-08", "2026-06-15", "2026-06-22", "2026-06-29"];

function rows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    pageId: `p${index}`,
    pageGroup: index % 2 === 0 ? "/a" : "/b",
    clicks: 1000 - index,
    impressions: 5000,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.coverage.mockResolvedValue({
    periods: ["2026-06-08", "2026-06-15", "2026-06-22", "2026-06-29", "2026-07-06"],
    truncated: false,
    rowClicks: 0,
    rowImpressions: 0,
  });
});

describe("readPopulation", () => {
  it("passes groups, weeks and exclusions as parameters", async () => {
    mocks.queryRaw.mockResolvedValue(rows(3));
    const result = await readPopulation({
      linkId: "link-1",
      pageGroups: ["/a", "/b'; DROP TABLE x;--"],
      preWeeks: PRE,
      excludePageIds: new Set(["x1", "x2"]),
    });
    const [strings, ...values] = mocks.queryRaw.mock.calls[0] as [string[], ...unknown[]];
    const text = strings.join("?");
    expect(text).not.toContain("DROP TABLE");
    expect(text).toContain("LIMIT");
    expect(values).toContain("link-1");
    expect(values).toContainEqual(["/a", "/b'; DROP TABLE x;--"]);
    const dates = values.find((value) => Array.isArray(value) && value[0] instanceof Date);
    expect(dates).toHaveLength(4);
    expect(values.some((value) => value instanceof Object && "values" in value)).toBe(true);
    expect(result.candidates).toHaveLength(3);
    expect(result.capped).toBe(false);
    expect(result.totalPages).toBe(3);
  });

  it("selects the group per page and converts the numbers", async () => {
    mocks.queryRaw.mockResolvedValue(rows(2));
    const result = await readPopulation({ linkId: "l", pageGroups: ["/a", "/b"], preWeeks: PRE });
    expect(result.candidates[0]).toEqual({
      pageId: "p0",
      group: "/a",
      preClicks: 1000,
      preImpressions: 5000,
    });
    expect(result.candidates[1]?.group).toBe("/b");
  });

  it("marks the population capped when the extra row came back", async () => {
    mocks.queryRaw.mockResolvedValue(rows(4001));
    const result = await readPopulation({ linkId: "l", pageGroups: ["/a"], preWeeks: PRE });
    expect(result.capped).toBe(true);
    expect(result.candidates).toHaveLength(4000);
  });

  it("counts only covered pre weeks", async () => {
    mocks.queryRaw.mockResolvedValue([]);
    const result = await readPopulation({ linkId: "l", pageGroups: ["/a"], preWeeks: PRE });
    expect(result.coveredWeeks).toBe(4);
    expect(mocks.coverage).toHaveBeenCalledWith("l", "WEEK", "page", "2026-06-08", "2026-06-29");
  });

  it("does not query without groups or weeks", async () => {
    const none = await readPopulation({ linkId: "l", pageGroups: [], preWeeks: PRE });
    expect(none).toEqual({ candidates: [], coveredWeeks: 0, totalPages: 0, capped: false });
    await readPopulation({ linkId: "l", pageGroups: ["/a"], preWeeks: [] });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });
});

describe("openPageIds", () => {
  it("joins open test pages and open action pages", async () => {
    mocks.splitPages.mockResolvedValue([{ pageId: "a" }, { pageId: "b" }]);
    mocks.actions.mockResolvedValue([{ pageId: "b" }, { pageId: "c" }]);
    const ids = await openPageIds({ projectId: "p", linkId: "l", isMock: false });
    expect([...ids].sort()).toEqual(["a", "b", "c"]);
    expect(mocks.splitPages.mock.calls[0]?.[0].where.test.status.in).toEqual([
      "DRAFT",
      "APPLIED",
      "EVALUATING",
    ]);
  });

  it("keeps the test pages when the action read fails", async () => {
    mocks.splitPages.mockResolvedValue([{ pageId: "a" }]);
    mocks.actions.mockRejectedValue(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ids = await openPageIds({ projectId: "p", linkId: "l", isMock: false });
    expect([...ids]).toEqual(["a"]);
    warn.mockRestore();
  });
});

describe("splitSiteScope", () => {
  it("returns the origin host and the scope root", async () => {
    mocks.site.mockResolvedValue({
      id: "site-1",
      origin: "https://www.example.com",
      scope: { root: "Example.com" },
    });
    expect(await splitSiteScope("p")).toEqual({
      siteId: "site-1",
      hosts: ["www.example.com", "example.com"],
    });
  });

  it("is null without a site, an origin or a scope", async () => {
    mocks.site.mockResolvedValue(null);
    expect(await splitSiteScope("p")).toBeNull();
    mocks.site.mockResolvedValue({ id: "s", origin: null, scope: { root: "x.com" } });
    expect(await splitSiteScope("p")).toBeNull();
    mocks.site.mockResolvedValue({ id: "s", origin: "https://x.com", scope: null });
    expect(await splitSiteScope("p")).toBeNull();
  });
});
