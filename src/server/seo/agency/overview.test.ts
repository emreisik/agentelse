import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: bayrak kapalıyken veritabanına dokunulmaz, 20 bağ
// için en çok 7 sorgu atılır, ikincil satırlarda motor alanları boştur, 200
// bağda kesildi bayrağı yanar ve fırsat sorgusu yalnız motor açıkken çalışır.

const mocks = vi.hoisted(() => ({
  agencyOn: vi.fn(() => true),
  bigQueryOn: vi.fn(() => false),
  mockMode: vi.fn(() => false),
  linkFindMany: vi.fn(),
  queryRaw: vi.fn(),
  projectFindMany: vi.fn(),
  siteFindMany: vi.fn(),
  findingGroupBy: vi.fn(),
  alertGroupBy: vi.fn(),
  sourceFindMany: vi.fn(),
}));

vi.mock("@/lib/seo/agency/flags", () => ({
  gscAgencyOn: mocks.agencyOn,
  gscBigQueryOn: mocks.bigQueryOn,
}));
vi.mock("@/server/integrations/search-console/search-analytics", () => ({
  gscMockMode: mocks.mockMode,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    gscSiteLink: { findMany: mocks.linkFindMany },
    $queryRaw: mocks.queryRaw,
    project: { findMany: mocks.projectFindMany },
    seoSite: { findMany: mocks.siteFindMany },
    seoFinding: { groupBy: mocks.findingGroupBy },
    adsAlert: { groupBy: mocks.alertGroupBy },
    gscBqSource: { findMany: mocks.sourceFindMany },
  },
}));

const { loadSearchAgencyOverview } = await import("./overview");

const NOW = new Date("2026-10-07T12:00:00.000Z");

function link(index: number, over: Record<string, unknown> = {}) {
  return {
    id: `l${index}`,
    projectId: `p${index}`,
    siteUrl: `sc-domain:site${String(index).padStart(2, "0")}.com`,
    isPrimary: true,
    isSecondary: false,
    isMock: false,
    health: "OK",
    healthReason: null,
    lastFinalDate: "2026-10-05",
    backfillDoneAt: new Date("2026-09-01T00:00:00.000Z"),
    ...over,
  };
}

function totalQueries(): number {
  return [
    mocks.linkFindMany,
    mocks.queryRaw,
    mocks.projectFindMany,
    mocks.siteFindMany,
    mocks.findingGroupBy,
    mocks.alertGroupBy,
    mocks.sourceFindMany,
  ].reduce((sum, fn) => sum + fn.mock.calls.length, 0);
}

beforeEach(() => {
  vi.stubEnv("SEO_INSIGHTS", "on");
  vi.stubEnv("GSC_SYNC", "true");
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.agencyOn.mockReturnValue(true);
  mocks.bigQueryOn.mockReturnValue(false);
  mocks.mockMode.mockReturnValue(false);
  mocks.linkFindMany.mockResolvedValue([]);
  mocks.queryRaw.mockResolvedValue([]);
  mocks.projectFindMany.mockResolvedValue([]);
  mocks.siteFindMany.mockResolvedValue([]);
  mocks.findingGroupBy.mockResolvedValue([]);
  mocks.alertGroupBy.mockResolvedValue([]);
  mocks.sourceFindMany.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe("flag off", () => {
  it("returns an empty overview without any database call", async () => {
    mocks.agencyOn.mockReturnValue(false);
    const result = await loadSearchAgencyOverview("w1", NOW);
    expect(result.rows).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.totals.sites).toBe(0);
    expect(totalQueries()).toBe(0);
  });
});

describe("empty workspace", () => {
  it("stops after the link query", async () => {
    const result = await loadSearchAgencyOverview("w1", NOW);
    expect(result.rows).toEqual([]);
    expect(totalQueries()).toBe(1);
  });
});

describe("20 links", () => {
  async function twenty() {
    const links = Array.from({ length: 20 }, (_, i) => link(i + 1));
    mocks.linkFindMany.mockResolvedValue(links);
    mocks.projectFindMany.mockResolvedValue(
      links.map((l) => ({ id: l.projectId, name: `Project ${l.projectId}` })),
    );
    mocks.queryRaw.mockResolvedValue(
      links.map((l, i) => ({
        linkId: l.id,
        clicks: 1000 + i,
        impressions: 20000,
        positionWeighted: 20000 * 4.25,
        previousClicks: 2000,
        days: 56,
      })),
    );
    return loadSearchAgencyOverview("w1", NOW);
  }

  it("lists all rows with at most 7 queries", async () => {
    const result = await twenty();
    expect(result.rows).toHaveLength(20);
    expect(result.totals.sites).toBe(20);
    expect(result.totals.projects).toBe(20);
    expect(totalQueries()).toBeLessThanOrEqual(7);
  });

  it("computes clicks, change and average position", async () => {
    const result = await twenty();
    const row = result.rows.find((r) => r.linkId === "l1");
    expect(row).toMatchObject({
      clicks: 1000,
      previousClicks: 2000,
      clicksChangePct: -50,
      impressions: 20000,
      position: 4.3,
      siteLabel: "site01.com",
      projectName: "Project p1",
      backfillDone: true,
      role: "PRIMARY",
    });
    // 28 gün tamamen düşüş, yeterli tıklama: dikkat ister
    expect(row?.attention).toBeGreaterThanOrEqual(25);
    expect(row?.attentionReasons).toContain("Clicks fell 50%");
  });
});

describe("change needs 56 stored days", () => {
  it("gives clicks but no change or previous clicks below 56 days", async () => {
    mocks.linkFindMany.mockResolvedValue([link(1)]);
    mocks.queryRaw.mockResolvedValue([
      {
        linkId: "l1",
        clicks: 300,
        impressions: 5000,
        positionWeighted: 5000 * 8,
        previousClicks: 100,
        days: 40,
      },
    ]);
    const [row] = (await loadSearchAgencyOverview("w1", NOW)).rows;
    expect(row?.clicks).toBe(300);
    expect(row?.previousClicks).toBeNull();
    expect(row?.clicksChangePct).toBeNull();
  });

  it("leaves everything empty for a link with no stored days", async () => {
    mocks.linkFindMany.mockResolvedValue([link(1, { lastFinalDate: null })]);
    const [row] = (await loadSearchAgencyOverview("w1", NOW)).rows;
    expect(row).toMatchObject({
      clicks: null,
      impressions: null,
      position: null,
      finalThrough: null,
    });
  });
});

describe("secondary sites", () => {
  it("never get engine fields", async () => {
    mocks.linkFindMany.mockResolvedValue([
      link(1, { id: "primary", projectId: "p1" }),
      link(2, {
        id: "secondary",
        projectId: "p1",
        isPrimary: false,
        isSecondary: true,
        siteUrl: "https://shop.example.com/",
      }),
    ]);
    mocks.siteFindMany.mockResolvedValue([
      {
        projectId: "p1",
        healthParts: { value: 72, parts: [], cappedByCritical: true },
      },
    ]);
    mocks.findingGroupBy.mockResolvedValue([{ linkId: "primary", _count: { _all: 4 } }]);
    mocks.alertGroupBy.mockResolvedValue([
      { projectId: "p1", severity: "CRITICAL", _count: { _all: 2 } },
      { projectId: "p1", severity: "WARN", _count: { _all: 3 } },
    ]);
    const { rows } = await loadSearchAgencyOverview("w1", NOW);
    const primary = rows.find((r) => r.linkId === "primary");
    const secondary = rows.find((r) => r.linkId === "secondary");

    expect(primary).toMatchObject({
      healthScore: 72,
      healthCapped: true,
      openOpportunities: 4,
      critical: 2,
      warn: 3,
    });
    expect(secondary).toMatchObject({
      role: "SECONDARY",
      healthScore: null,
      healthCapped: false,
      openOpportunities: null,
      critical: 0,
      warn: 0,
      siteLabel: "shop.example.com",
    });
    // Birincil bağ yalnız birincil proje kimlikleriyle sorulur
    expect(mocks.findingGroupBy.mock.calls[0]?.[0].where.linkId.in).toEqual(["primary"]);
  });

  it("skips the engine queries when the workspace only has secondary sites", async () => {
    mocks.linkFindMany.mockResolvedValue([
      link(1, { isPrimary: false, isSecondary: true }),
    ]);
    await loadSearchAgencyOverview("w1", NOW);
    expect(mocks.siteFindMany).not.toHaveBeenCalled();
    expect(mocks.findingGroupBy).not.toHaveBeenCalled();
    expect(mocks.alertGroupBy).not.toHaveBeenCalled();
  });
});

describe("truncation", () => {
  it("flags a list that hit the 200 link cap", async () => {
    const links = Array.from({ length: 200 }, (_, i) => link(i + 1));
    mocks.linkFindMany.mockResolvedValue(links);
    const result = await loadSearchAgencyOverview("w1", NOW);
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(200);
    expect(mocks.linkFindMany.mock.calls[0]?.[0].take).toBe(200);
    expect(totalQueries()).toBeLessThanOrEqual(7);
  });

  it("is not truncated below the cap", async () => {
    mocks.linkFindMany.mockResolvedValue([link(1)]);
    expect((await loadSearchAgencyOverview("w1", NOW)).truncated).toBe(false);
  });
});

describe("insights flag", () => {
  it("leaves openOpportunities null and skips the finding query when off", async () => {
    vi.stubEnv("SEO_INSIGHTS", "off");
    mocks.linkFindMany.mockResolvedValue([link(1)]);
    const [row] = (await loadSearchAgencyOverview("w1", NOW)).rows;
    expect(row?.openOpportunities).toBeNull();
    expect(mocks.findingGroupBy).not.toHaveBeenCalled();
  });

  it("shows 0 open opportunities when the engine is on and there are none", async () => {
    mocks.linkFindMany.mockResolvedValue([link(1)]);
    const [row] = (await loadSearchAgencyOverview("w1", NOW)).rows;
    expect(row?.openOpportunities).toBe(0);
  });
});

describe("BigQuery badge", () => {
  it("is OFF without the BigQuery flag and no query is made", async () => {
    mocks.linkFindMany.mockResolvedValue([link(1)]);
    const [row] = (await loadSearchAgencyOverview("w1", NOW)).rows;
    expect(row?.bigQuery).toBe("OFF");
    expect(mocks.sourceFindMany).not.toHaveBeenCalled();
  });

  it("maps the source status by project and site when the flag is on", async () => {
    mocks.bigQueryOn.mockReturnValue(true);
    mocks.linkFindMany.mockResolvedValue([link(1), link(2)]);
    mocks.sourceFindMany.mockResolvedValue([
      { projectId: "p1", siteUrl: "sc-domain:site01.com", status: "ERROR" },
      { projectId: "p2", siteUrl: "https://other.com/", status: "ACTIVE" },
    ]);
    const { rows } = await loadSearchAgencyOverview("w1", NOW);
    expect(rows.find((r) => r.linkId === "l1")?.bigQuery).toBe("ERROR");
    expect(rows.find((r) => r.linkId === "l2")?.bigQuery).toBe("OFF");
    expect(
      rows.find((r) => r.linkId === "l1")?.attentionReasons,
    ).toContain("BigQuery export needs attention");
  });
});

describe("mode and ordering", () => {
  it("queries only the current mode", async () => {
    mocks.mockMode.mockReturnValue(true);
    mocks.linkFindMany.mockResolvedValue([link(1, { isMock: true })]);
    await loadSearchAgencyOverview("w1", NOW);
    expect(mocks.linkFindMany.mock.calls[0]?.[0].where).toMatchObject({
      workspaceId: "w1",
      isMock: true,
    });
    expect(mocks.siteFindMany.mock.calls[0]?.[0].where.isMock).toBe(true);
  });

  it("sorts rows needing attention first", async () => {
    mocks.linkFindMany.mockResolvedValue([
      link(1),
      link(2, { health: "AUTH" }),
    ]);
    const { rows, totals } = await loadSearchAgencyOverview("w1", NOW);
    expect(rows.map((r) => r.linkId)).toEqual(["l2", "l1"]);
    expect(totals.needAttention).toBe(1);
  });
});
