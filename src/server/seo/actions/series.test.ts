import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: işlenen sayfa pageId ve normalizePageUrl().hash ile
// çözülür (tarayıcı özeti targetUrlHash ile ASLA); aday SQL'i ±%50 bandını ve
// grubu parametre olarak taşır, grup 4'ten az aday verirse tüm sayfalara
// düşülür; başka bir eylemin sayfası kontrol dışı kalır, sağlık-uyarısı
// eylemi hiçbir şeyi dışlamaz ve çakışma saymaz; tarayıcı dışlaması yalnız
// ilk görülmeden sonraki kritik alan değişimini sayar; geçen yıl haftaları
// okunur ve yearAgoCovered kapsamayı yansıtır.

const mocks = vi.hoisted(() => ({
  link: vi.fn(),
  pages: vi.fn(),
  weekly: vi.fn(),
  raw: vi.fn(),
  actions: vi.fn(),
  site: vi.fn(),
  crawled: vi.fn(),
  coverage: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gscSiteLink: { findUnique: mocks.link },
    gscPage: { findMany: mocks.pages },
    gscWeeklyPage: { findMany: mocks.weekly },
    seoAction: { findMany: mocks.actions },
    seoSite: { findUnique: mocks.site },
    seoPage: { findMany: mocks.crawled },
    $queryRaw: mocks.raw,
  },
}));
vi.mock("@/server/seo/store", () => ({ readPeriodCoverage: mocks.coverage }));

const { loadActionSeries } = await import("./series");
const { evaluationWindows, yearAgoWeeks } =
  await import("@/lib/seo/actions/windows");
const { actionViewFixture, proposalFixture } =
  await import("@/lib/seo/actions/test-support");
const { normalizePageUrl } = await import("@/lib/seo/normalize");
const { addWeeks } = await import("@/lib/seo/dates");

const ORIGIN = "https://example.com";
const WINDOWS = evaluationWindows({
  measureFrom: new Date("2026-08-05T12:00:00.000Z"),
  windowDays: 28,
});

type PageRow = { id: string; urlHash: string; pageGroup: string | null };

function pageRow(path: string, group: string | null = "services"): PageRow {
  return {
    id: `page:${path}`,
    urlHash: normalizePageUrl(`${ORIGIN}${path}`)!.hash,
    pageGroup: group,
  };
}

const TREATED = pageRow("/services/a");
const CONTROL_B = pageRow("/services/b");
const CONTROL_C = pageRow("/services/c");
const HOME = pageRow("/", null);
let allPages: PageRow[] = [];
let weeklyByPage: Map<string, number>;
let others: Record<string, unknown>[] = [];
let crawled: Record<string, unknown>[] = [];
let uncovered = new Set<string>();

function weeksBetween(from: string, to: string): string[] {
  const weeks: string[] = [];
  for (let week = from; week <= to; week = addWeeks(week, 1)) weeks.push(week);
  return weeks;
}

// Prisma.sql parçaları iç içe geçer; değerleri düzleştirir.
function flattenValues(values: readonly unknown[]): unknown[] {
  return values.flatMap((value) =>
    value !== null &&
    typeof value === "object" &&
    "strings" in value &&
    "values" in value &&
    Array.isArray((value as { values: unknown }).values)
      ? flattenValues((value as { values: unknown[] }).values)
      : [value],
  );
}

function action(overrides: Parameters<typeof actionViewFixture>[0] = {}) {
  return actionViewFixture({
    id: "action-1",
    kind: "TITLE_META",
    linkId: "link-1",
    pageId: null,
    targetUrl: `${ORIGIN}/services/a`,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  allPages = [TREATED, CONTROL_B, CONTROL_C, HOME];
  weeklyByPage = new Map([
    [TREATED.id, 10],
    [CONTROL_B.id, 12],
    [CONTROL_C.id, 9],
  ]);
  others = [];
  crawled = [];
  uncovered = new Set();
  mocks.link.mockResolvedValue({ id: "link-1", lastWeeklyWeek: "2026-09-07" });
  mocks.pages.mockImplementation(
    async (args: {
      where: {
        OR: ({ id?: { in: string[] } } | { urlHash?: { in: string[] } })[];
      };
    }) =>
      allPages.filter((page) =>
        args.where.OR.some(
          (clause) =>
            ("id" in clause && clause.id?.in.includes(page.id)) ||
            ("urlHash" in clause && clause.urlHash?.in.includes(page.urlHash)),
        ),
      ),
  );
  mocks.weekly.mockImplementation(
    async (args: {
      where: {
        pageId: { in: string[] };
        weekStart: { gte?: Date; lte?: Date; in?: Date[] };
      };
    }) => {
      const filter = args.where.weekStart;
      const weeks = filter.in
        ? filter.in.map((date) => date.toISOString().slice(0, 10))
        : weeksBetween(
            filter.gte!.toISOString().slice(0, 10),
            filter.lte!.toISOString().slice(0, 10),
          );
      return args.where.pageId.in.flatMap((pageId) =>
        weeks.map((week) => ({
          pageId,
          weekStart: new Date(`${week}T00:00:00.000Z`),
          clicks: weeklyByPage.get(pageId) ?? 5,
          impressions: (weeklyByPage.get(pageId) ?? 5) * 10,
          positionWeighted: (weeklyByPage.get(pageId) ?? 5) * 50,
        })),
      );
    },
  );
  mocks.raw.mockResolvedValue([
    { pageId: CONTROL_B.id },
    { pageId: CONTROL_C.id },
    { pageId: "page:/services/d" },
    { pageId: "page:/services/e" },
  ]);
  mocks.actions.mockImplementation(
    async (args: { where: { source?: { not?: string } } }) =>
      others.filter((row) => row.source !== args.where.source?.not),
  );
  mocks.site.mockResolvedValue({ id: "site-1" });
  mocks.crawled.mockImplementation(async () => crawled);
  mocks.coverage.mockImplementation(
    async (
      _link: string,
      _grain: string,
      _key: string,
      from: string,
      to: string,
    ) => ({
      periods: weeksBetween(from, to).filter((week) => !uncovered.has(week)),
      truncated: false,
      rowClicks: 0,
      rowImpressions: 0,
    }),
  );
});

describe("treated page resolution", () => {
  it("resolves the target by normalizePageUrl hash", async () => {
    const result = await loadActionSeries({
      action: action(),
      windows: WINDOWS,
      metric: "ctr_adj",
    });
    if ("missing" in result) throw new Error("beklenmedik");
    expect(result.treated.map((series) => series.pageId)).toEqual([TREATED.id]);
    expect(result.pageGroup).toBe("services");
    expect(result.lastWeeklyWeek).toBe("2026-09-07");
  });

  it("resolves the target by pageId when the url is absent", async () => {
    const result = await loadActionSeries({
      action: action({ targetUrl: null, pageId: CONTROL_B.id }),
      windows: WINDOWS,
      metric: "clicks",
    });
    if ("missing" in result) throw new Error("beklenmedik");
    expect(result.treated.map((series) => series.pageId)).toEqual([
      CONTROL_B.id,
    ]);
  });

  it("sums CONSOLIDATE pages into the treated set", async () => {
    const result = await loadActionSeries({
      action: action({
        kind: "CONSOLIDATE",
        proposal: {
          ...proposalFixture("CONSOLIDATE"),
          kind: "CONSOLIDATE",
          from: [`${ORIGIN}/services/b`],
          to: `${ORIGIN}/services/a`,
          method: "REDIRECT",
        } as never,
      }),
      windows: WINDOWS,
      metric: "clicks",
    });
    if ("missing" in result) throw new Error("beklenmedik");
    expect(result.treated.map((series) => series.pageId).sort()).toEqual(
      [TREATED.id, CONTROL_B.id].sort(),
    );
  });

  it("reports missing link and missing page", async () => {
    expect(
      await loadActionSeries({
        action: action({ linkId: null }),
        windows: WINDOWS,
        metric: "clicks",
      }),
    ).toEqual({ missing: "NO_LINK" });
    mocks.link.mockResolvedValueOnce(null);
    expect(
      await loadActionSeries({
        action: action(),
        windows: WINDOWS,
        metric: "clicks",
      }),
    ).toEqual({ missing: "NO_LINK" });
    expect(
      await loadActionSeries({
        action: action({ targetUrl: `${ORIGIN}/nope` }),
        windows: WINDOWS,
        metric: "clicks",
      }),
    ).toEqual({ missing: "NO_PAGE" });
  });
});

describe("candidate query", () => {
  it("passes the group and the plus/minus 50% band as parameters", async () => {
    await loadActionSeries({
      action: action(),
      windows: WINDOWS,
      metric: "clicks",
    });
    expect(mocks.raw).toHaveBeenCalledTimes(1);
    const values = flattenValues(mocks.raw.mock.calls[0]!.slice(1));
    // Taban: 8 ön hafta × 10 tıklama.
    expect(values).toContain("link-1");
    expect(values).toContain("services");
    expect(values).toContain(40);
    expect(values).toContain(120);
    expect(values).toContain(300);
    expect(values).toContainEqual(WINDOWS.preWeeks);
    // İşlenen sayfa aday havuzundan çıkarılır.
    expect(values).toContainEqual([TREATED.id]);
  });

  it("uses impressions as the basis for the impressions metric", async () => {
    await loadActionSeries({
      action: action(),
      windows: WINDOWS,
      metric: "impressions",
    });
    const values = flattenValues(mocks.raw.mock.calls[0]!.slice(1));
    expect(values).toContain(400);
    expect(values).toContain(1200);
  });

  it("falls back to all pages when the group has fewer than 4 candidates", async () => {
    mocks.raw
      .mockResolvedValueOnce([{ pageId: CONTROL_B.id }])
      .mockResolvedValueOnce([
        { pageId: CONTROL_B.id },
        { pageId: CONTROL_C.id },
      ]);
    const result = await loadActionSeries({
      action: action(),
      windows: WINDOWS,
      metric: "clicks",
    });
    if ("missing" in result) throw new Error("beklenmedik");
    expect(mocks.raw).toHaveBeenCalledTimes(2);
    expect(flattenValues(mocks.raw.mock.calls[0]!.slice(1))).toContain(
      "services",
    );
    expect(flattenValues(mocks.raw.mock.calls[1]!.slice(1))).not.toContain(
      "services",
    );
    expect(result.candidates.map((series) => series.pageId)).toEqual([
      CONTROL_B.id,
      CONTROL_C.id,
    ]);
  });

  it("queries once when the page has no group", async () => {
    allPages = [{ ...TREATED, pageGroup: null }];
    await loadActionSeries({
      action: action(),
      windows: WINDOWS,
      metric: "clicks",
    });
    expect(mocks.raw).toHaveBeenCalledTimes(1);
  });

  it("skips candidates, exclusions and year-ago rows when treatedOnly", async () => {
    const result = await loadActionSeries({
      action: action(),
      windows: WINDOWS,
      metric: "impressions",
      treatedOnly: true,
    });
    if ("missing" in result) throw new Error("beklenmedik");
    expect(mocks.raw).not.toHaveBeenCalled();
    expect(mocks.actions).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
    expect(result.treatedYearAgo).toEqual([]);
  });
});

describe("exclusions", () => {
  const inWindow = new Date("2026-07-20T12:00:00.000Z");

  it("excludes a control page another action targeted", async () => {
    others = [
      {
        source: "FINDING",
        kind: "TITLE_META",
        pageId: null,
        targetUrl: `${ORIGIN}/services/c`,
        proposal: proposalFixture("TITLE_META"),
        appliedAt: inWindow,
      },
    ];
    const result = await loadActionSeries({
      action: action(),
      windows: WINDOWS,
      metric: "ctr_adj",
    });
    if ("missing" in result) throw new Error("beklenmedik");
    expect([...result.excluded]).toEqual([CONTROL_C.id]);
    expect(result.overlappingChange).toBe(false);
  });

  it("excludes CONSOLIDATE source pages of another action", async () => {
    others = [
      {
        source: "FINDING",
        kind: "CONSOLIDATE",
        pageId: null,
        targetUrl: `${ORIGIN}/other`,
        proposal: {
          ...proposalFixture("CONSOLIDATE"),
          from: [`${ORIGIN}/services/b`],
          to: `${ORIGIN}/other`,
        },
        appliedAt: inWindow,
      },
    ];
    const result = await loadActionSeries({
      action: action(),
      windows: WINDOWS,
      metric: "ctr_adj",
    });
    if ("missing" in result) throw new Error("beklenmedik");
    expect(result.excluded.has(CONTROL_B.id)).toBe(true);
  });

  it("ignores health-issue actions: no exclusion, no overlapping change", async () => {
    others = [
      {
        source: "HEALTH_ISSUE",
        kind: "TECH_FIX",
        pageId: HOME.id,
        targetUrl: `${ORIGIN}/`,
        proposal: proposalFixture("TECH_FIX"),
        appliedAt: inWindow,
      },
      {
        source: "HEALTH_ISSUE",
        kind: "SCHEMA",
        pageId: TREATED.id,
        targetUrl: `${ORIGIN}/services/a`,
        proposal: proposalFixture("SCHEMA"),
        appliedAt: inWindow,
      },
    ];
    const result = await loadActionSeries({
      action: action(),
      windows: WINDOWS,
      metric: "ctr_adj",
    });
    if ("missing" in result) throw new Error("beklenmedik");
    expect(result.excluded.size).toBe(0);
    expect(result.overlappingChange).toBe(false);
    const where = mocks.actions.mock.calls[0]![0].where;
    expect(where.source).toEqual({ not: "HEALTH_ISSUE" });
    expect(where.id).toEqual({ not: "action-1" });
  });

  it("never matches through targetUrlHash (crawler hash)", async () => {
    others = [
      {
        source: "FINDING",
        kind: "TITLE_META",
        pageId: null,
        targetUrl: null,
        // Yalnız tarayıcı özeti GscPage.urlHash ile aynı: eşleşmemeli.
        targetUrlHash: CONTROL_B.urlHash,
        proposal: proposalFixture("TITLE_META"),
        appliedAt: inWindow,
      },
    ];
    const result = await loadActionSeries({
      action: action(),
      windows: WINDOWS,
      metric: "ctr_adj",
    });
    if ("missing" in result) throw new Error("beklenmedik");
    expect(result.excluded.size).toBe(0);
  });

  it("matches another action by pageId", async () => {
    others = [
      {
        source: "OPPORTUNITY_DONE",
        kind: "INTERNAL_LINKS",
        pageId: CONTROL_B.id,
        targetUrl: null,
        proposal: proposalFixture("INTERNAL_LINKS"),
        appliedAt: inWindow,
      },
    ];
    const result = await loadActionSeries({
      action: action(),
      windows: WINDOWS,
      metric: "ctr_adj",
    });
    if ("missing" in result) throw new Error("beklenmedik");
    expect(result.excluded.has(CONTROL_B.id)).toBe(true);
  });

  it("flags an overlapping change on the treated page inside the lookback", async () => {
    others = [
      {
        source: "FINDING",
        kind: "INTERNAL_LINKS",
        pageId: null,
        targetUrl: `${ORIGIN}/services/a`,
        proposal: proposalFixture("INTERNAL_LINKS"),
        appliedAt: inWindow,
      },
    ];
    const result = await loadActionSeries({
      action: action(),
      windows: WINDOWS,
      metric: "ctr_adj",
    });
    if ("missing" in result) throw new Error("beklenmedik");
    expect(result.overlappingChange).toBe(true);
    // İşlenen sayfa kontrol dışı kümesinde görünmez.
    expect(result.excluded.has(TREATED.id)).toBe(false);
  });

  it("does not flag a change on the treated page before the lookback", async () => {
    others = [
      {
        source: "FINDING",
        kind: "INTERNAL_LINKS",
        pageId: null,
        targetUrl: `${ORIGIN}/services/a`,
        proposal: proposalFixture("INTERNAL_LINKS"),
        // overlapFrom = 2026-07-08; ön pencere içinde ama daha eski.
        appliedAt: new Date("2026-06-20T12:00:00.000Z"),
      },
    ];
    const result = await loadActionSeries({
      action: action(),
      windows: WINDOWS,
      metric: "ctr_adj",
    });
    if ("missing" in result) throw new Error("beklenmedik");
    expect(result.overlappingChange).toBe(false);
  });

  it("excludes pages the crawler saw change critically, not first-seen or text-only", async () => {
    const firstSeen = new Date("2026-06-01T12:00:00.000Z");
    crawled = [
      {
        // Kritik alan değişti (başlık).
        url: `${ORIGIN}/services/b`,
        title: "New title",
        canonical: null,
        noindex: false,
        status: 200,
        previous: {
          title: "Old title",
          canonical: null,
          noindex: false,
          status: 200,
        },
        lastChangedAt: inWindow,
        firstSeenAt: firstSeen,
      },
      {
        // İlk görülme: lastChangedAt ≤ firstSeenAt + 1 gün.
        url: `${ORIGIN}/services/c`,
        title: "T",
        canonical: null,
        noindex: false,
        status: 200,
        previous: {
          title: "Other",
          canonical: null,
          noindex: false,
          status: 200,
        },
        lastChangedAt: new Date("2026-07-20T18:00:00.000Z"),
        firstSeenAt: new Date("2026-07-20T12:00:00.000Z"),
      },
      {
        // Yalnız metin değişti: kritik alanlar aynı.
        url: `${ORIGIN}/`,
        title: "Home",
        canonical: null,
        noindex: false,
        status: 200,
        previous: {
          title: "Home",
          canonical: null,
          noindex: false,
          status: 200,
        },
        lastChangedAt: inWindow,
        firstSeenAt: firstSeen,
      },
    ];
    const result = await loadActionSeries({
      action: action(),
      windows: WINDOWS,
      metric: "ctr_adj",
    });
    if ("missing" in result) throw new Error("beklenmedik");
    expect([...result.excluded]).toEqual([CONTROL_B.id]);
  });

  it("does not query crawler pages when the project has no site", async () => {
    mocks.site.mockResolvedValueOnce(null);
    const result = await loadActionSeries({
      action: action(),
      windows: WINDOWS,
      metric: "ctr_adj",
    });
    if ("missing" in result) throw new Error("beklenmedik");
    expect(mocks.crawled).not.toHaveBeenCalled();
    expect(result.excluded.size).toBe(0);
  });
});

describe("coverage and year-ago", () => {
  it("loads year-ago weeks and reports yearAgoCovered", async () => {
    const result = await loadActionSeries({
      action: action(),
      windows: WINDOWS,
      metric: "ctr_adj",
    });
    if ("missing" in result) throw new Error("beklenmedik");
    const expected = yearAgoWeeks([...WINDOWS.preWeeks, ...WINDOWS.postWeeks]);
    expect(result.yearAgoCovered).toBe(true);
    expect(result.treatedYearAgo).toHaveLength(1);
    expect(
      result.treatedYearAgo[0]!.weeks.map((week) => week.weekStart),
    ).toEqual(expected);
    expect(result.coveredWeeks.has(WINDOWS.preWeeks[0]!)).toBe(true);
  });

  it("is not year-ago covered when one year-ago week is missing", async () => {
    const missing = yearAgoWeeks(WINDOWS.preWeeks)[2]!;
    uncovered = new Set([missing]);
    const result = await loadActionSeries({
      action: action(),
      windows: WINDOWS,
      metric: "ctr_adj",
    });
    if ("missing" in result) throw new Error("beklenmedik");
    expect(result.yearAgoCovered).toBe(false);
  });

  it("reports coverage gaps and truncation of the window", async () => {
    uncovered = new Set([WINDOWS.preWeeks[0]!]);
    mocks.coverage.mockImplementationOnce(async () => ({
      periods: WINDOWS.preWeeks.slice(1),
      truncated: true,
      rowClicks: 0,
      rowImpressions: 0,
    }));
    const result = await loadActionSeries({
      action: action(),
      windows: WINDOWS,
      metric: "ctr_adj",
    });
    if ("missing" in result) throw new Error("beklenmedik");
    expect(result.truncated).toBe(true);
    expect(result.coveredWeeks.has(WINDOWS.preWeeks[0]!)).toBe(false);
  });
});
