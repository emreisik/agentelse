import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_PAGE_GROUP_RULES } from "@/lib/seo/agency/page-groups";
import type { ProjectSiteView, ViewedSite } from "@/lib/seo/agency/types";
import type { BqSourceView } from "@/server/seo/agency/bq/source";

// Bu dosyanın kanıtladığı (SC-F9 Search sayfası ajans bölümü): bayrak
// kapalıyken hiçbir kardeş modül çağrılmadan null döner; birincil görünümde
// Sites / Page groups / Split tests kartları çizilir; BigQuery kartı yalnız
// GSC_BIGQUERY açıkken (ve o zaman okunur); ikincil görünümde not ve "Make
// primary" çıkar, müşteri raporları okunmaz; BigQuery kartı kaynak yokken,
// mülk sahibiyken ve haftalık tablolar kesilmişken açık gelir; bir okuma
// hatası bölümü düşürmez.

const mocks = vi.hoisted(() => ({
  agencyActive: vi.fn(),
  bigQueryActive: vi.fn(),
  seoReportsActive: vi.fn(),
  reportShareOn: vi.fn(),
  candidates: vi.fn(),
  readGroups: vi.fn(),
  listGroups: vi.fn(),
  loadBq: vi.fn(),
  listTests: vi.fn(),
  applyReady: vi.fn(),
  listReports: vi.fn(),
  listShares: vi.fn(),
  getBranding: vi.fn(),
  access: vi.fn(),
  coverage: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/seo/agency/flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seo/agency/flags")>()),
  gscAgencyActiveFor: mocks.agencyActive,
  gscBigQueryActiveFor: mocks.bigQueryActive,
}));
vi.mock("@/lib/seo/reports/flags", () => ({
  seoReportsActiveFor: mocks.seoReportsActive,
}));
vi.mock("@/lib/report-share/flags", () => ({
  reportShareOn: mocks.reportShareOn,
}));
vi.mock("@/server/seo/agency/sites", () => ({
  GscSites: { candidates: mocks.candidates },
}));
vi.mock("@/server/seo/agency/page-groups", () => ({
  GscPageGroups: { read: mocks.readGroups, listGroups: mocks.listGroups },
}));
vi.mock("@/server/seo/agency/bq/source", () => ({
  loadBqSourceView: mocks.loadBq,
}));
vi.mock("@/server/seo/agency/split/store", () => ({
  GscSplitTests: { list: mocks.listTests },
}));
vi.mock("@/server/seo/apply/offers", () => ({
  loadApplyReady: mocks.applyReady,
}));
vi.mock("@/server/seo/reports/store", () => ({
  listSeoReports: mocks.listReports,
}));
vi.mock("@/server/report-share/store", () => ({
  ReportShares: { listForProject: mocks.listShares },
}));
vi.mock("@/server/report-share/branding", () => ({
  ReportBrandings: { get: mocks.getBranding },
}));
vi.mock("@/server/security/tenant-context", () => ({
  requireProjectAccess: mocks.access,
}));
vi.mock("@/server/seo/store", () => ({
  readPeriodCoverage: mocks.coverage,
}));
vi.mock("@/server/actions/gsc-sites-actions", () => ({
  addSecondarySiteAction: vi.fn(),
  removeSecondarySiteAction: vi.fn(),
  makePrimarySiteAction: vi.fn(),
  savePageGroupRulesAction: vi.fn(),
  previewPageGroupRulesAction: vi.fn(),
}));
vi.mock("@/server/actions/gsc-bigquery-actions", () => ({
  saveBigQuerySourceAction: vi.fn(),
  verifyBigQuerySourceAction: vi.fn(),
  setBigQueryStateAction: vi.fn(),
}));
vi.mock("@/server/actions/gsc-split-test-actions", () => ({
  previewSplitPopulationAction: vi.fn(),
  createSplitTestAction: vi.fn(),
  markSplitTestAppliedAction: vi.fn(),
  applySplitTestViaCmsAction: vi.fn(),
  cancelSplitTestAction: vi.fn(),
  checkSplitTestNowAction: vi.fn(),
}));
vi.mock("@/server/actions/report-share-actions", () => ({
  saveReportBrandingAction: vi.fn(),
  createReportShareAction: vi.fn(),
  revokeReportShareAction: vi.fn(),
}));

const { SearchAgencySection } = await import("./search-agency-section");

const GIB = 1024 ** 3;

function site(overrides: Partial<ProjectSiteView> = {}): ProjectSiteView {
  return {
    linkId: "l1",
    siteUrl: "https://a.example/",
    siteLabel: "a.example",
    role: "PRIMARY",
    isMock: false,
    health: "OK",
    lastFinalDate: "2026-10-03",
    backfillDone: true,
    bigQuery: "OFF",
    isOwner: true,
    ...overrides,
  };
}

const primary = site();
const secondary = site({
  linkId: "l2",
  siteUrl: "https://b.example/",
  siteLabel: "b.example",
  role: "SECONDARY",
});

function viewedSite(viewed: ProjectSiteView): ViewedSite {
  return {
    agency: true,
    sites: [primary, secondary],
    viewed,
    isPrimaryView: viewed.role === "PRIMARY",
  };
}

function bqView(overrides: Partial<BqSourceView> = {}): BqSourceView {
  return {
    linkId: "l1",
    siteUrl: "https://a.example/",
    status: "OFF",
    configured: true,
    isOwner: true,
    serviceAccountEmail: "reader@agentelse.iam.gserviceaccount.com",
    bqProjectId: null,
    dataset: null,
    location: null,
    exportStart: null,
    exportedThrough: null,
    importAll: false,
    maxBytesPerQuery: 10 * GIB,
    monthlyBudgetBytes: 300 * GIB,
    usedBytesMonth: 0,
    queriesMonth: 0,
    lastVerifiedAt: null,
    lastSyncAt: null,
    lastError: null,
    errorText: null,
    imported: { weeks: 0, months: 0, lastWeek: null },
    completeWeeks: 0,
    reconcile: null,
    ...overrides,
  };
}

async function render(
  viewed: ViewedSite,
  isManager = true,
): Promise<string | null> {
  const element = await SearchAgencySection({
    projectId: "p1",
    viewed,
    isManager,
    userId: "u1",
  });
  return element ? renderToStaticMarkup(element) : null;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.agencyActive.mockReturnValue(true);
  mocks.bigQueryActive.mockReturnValue(false);
  mocks.seoReportsActive.mockReturnValue(false);
  mocks.reportShareOn.mockReturnValue(false);
  mocks.candidates.mockResolvedValue([]);
  mocks.readGroups.mockResolvedValue({
    rules: EMPTY_PAGE_GROUP_RULES,
    version: 0,
    appliedVersion: 0,
    applying: false,
    appliedWeek: null,
  });
  mocks.listGroups.mockResolvedValue([{ group: "/blog", pages: 300 }]);
  mocks.listTests.mockResolvedValue([]);
  mocks.applyReady.mockResolvedValue(false);
  mocks.coverage.mockResolvedValue({
    periods: [],
    truncated: false,
    rowClicks: 0,
    rowImpressions: 0,
  });
  mocks.access.mockResolvedValue({ workspaceId: "w1", projectId: "p1" });
  mocks.listReports.mockResolvedValue([]);
  mocks.listShares.mockResolvedValue({});
  mocks.getBranding.mockResolvedValue({
    displayName: "Acme",
    accent: "slate",
    footer: null,
    logoAssetId: null,
  });
});

describe("bayrak kapalıyken", () => {
  it("null döner ve hiçbir kardeş modül çağrılmaz", async () => {
    mocks.agencyActive.mockReturnValue(false);
    const element = SearchAgencySection({
      projectId: "p1",
      viewed: { agency: false, sites: [], viewed: null, isPrimaryView: true },
      isManager: true,
      userId: "u1",
    });
    await expect(element).resolves.toBeNull();
    expect(mocks.agencyActive).toHaveBeenCalledWith("p1");
    for (const [name, mock] of Object.entries(mocks)) {
      if (name === "agencyActive") continue;
      expect(mock, name).not.toHaveBeenCalled();
    }
  });
});

describe("birincil görünüm", () => {
  it("Sites, Page groups ve Split tests kartlarını çizer, ikincil not yok", async () => {
    const html = await render(viewedSite(primary));
    expect(html).toContain('id="agency"');
    expect(html).toContain('data-card="agency-sites"');
    expect(html).toContain('data-card="agency-page-groups"');
    expect(html).toContain('data-card="agency-split-tests"');
    expect(html).not.toContain('data-note="secondary-view"');
    expect(mocks.readGroups).toHaveBeenCalledWith("p1", "https://a.example/");
    expect(mocks.listGroups).toHaveBeenCalledWith("l1");
    expect(mocks.listTests).toHaveBeenCalledWith("p1", "l1");
  });

  it("GSC_BIGQUERY kapalıyken BigQuery kartı yok ve kaynak okunmaz", async () => {
    const html = await render(viewedSite(primary));
    expect(html).not.toContain('data-card="agency-bigquery"');
    expect(mocks.loadBq).not.toHaveBeenCalled();
  });

  it("aday listesi yalnız yöneticiye okunur", async () => {
    await render(viewedSite(primary), false);
    expect(mocks.candidates).not.toHaveBeenCalled();
    await render(viewedSite(primary), true);
    expect(mocks.candidates).toHaveBeenCalledWith("p1");
  });

  it("görüntülenen site yoksa yalnız Sites kartı çizilir", async () => {
    const html = await render({
      agency: true,
      sites: [],
      viewed: null,
      isPrimaryView: true,
    });
    expect(html).toContain('data-card="agency-sites"');
    expect(html).not.toContain('data-card="agency-page-groups"');
    expect(html).not.toContain('data-card="agency-split-tests"');
    expect(mocks.readGroups).not.toHaveBeenCalled();
  });

  it("CMS hazırlığı yalnız yönetici ve CMS'e uygun taslak testte okunur", async () => {
    await render(viewedSite(primary));
    expect(mocks.applyReady).not.toHaveBeenCalled();
    mocks.listTests.mockResolvedValue([
      { id: "t1", status: "DRAFT", canApplyViaCms: true },
    ]);
    // Kart gerçek bir görünüm ister; yalnız okuma sırasını sınamak için çizim
    // hatası yutulur.
    await render(viewedSite(primary), true).catch(() => null);
    expect(mocks.applyReady).toHaveBeenCalledWith("p1");
  });
});

describe("BigQuery kartı", () => {
  beforeEach(() => {
    mocks.bigQueryActive.mockReturnValue(true);
  });

  it("açıkken kartı çizer", async () => {
    mocks.loadBq.mockResolvedValue(
      bqView({ status: "ACTIVE", bqProjectId: "my-project-1", dataset: "searchconsole" }),
    );
    const html = await render(viewedSite(primary));
    expect(html).toContain('data-card="agency-bigquery"');
    expect(mocks.loadBq).toHaveBeenCalledWith("p1", "l1");
  });

  it("kaynak yok + mülk sahibi + kesilmiş haftalar: açık gelir", async () => {
    mocks.loadBq.mockResolvedValue(bqView());
    mocks.coverage.mockResolvedValue({
      periods: ["2026-09-21"],
      truncated: true,
      rowClicks: 0,
      rowImpressions: 0,
    });
    const html = await render(viewedSite(primary));
    expect(html).toMatch(/<details[^>]*data-card="agency-bigquery"[^>]*\sopen=""/);
    expect(mocks.coverage).toHaveBeenCalledTimes(1);
    expect(mocks.coverage.mock.calls[0]?.slice(0, 3)).toEqual(["l1", "WEEK", "query"]);
  });

  it("kesilme yoksa ya da mülk sahibi değilse kapalı gelir", async () => {
    mocks.loadBq.mockResolvedValue(bqView());
    const closed = await render(viewedSite(primary));
    expect(closed).not.toMatch(/data-card="agency-bigquery"[^>]*\sopen=""/);
    mocks.coverage.mockResolvedValue({ periods: [], truncated: true, rowClicks: 0, rowImpressions: 0 });
    mocks.loadBq.mockResolvedValue(bqView({ isOwner: false }));
    const notOwner = await render(
      viewedSite(site({ isOwner: false })),
    );
    expect(notOwner).not.toMatch(/data-card="agency-bigquery"[^>]*\sopen=""/);
  });

  it("kaynak okuma hatası kartı düşürür ama bölümü değil", async () => {
    mocks.loadBq.mockRejectedValue(new Error("db"));
    const html = await render(viewedSite(primary));
    expect(html).toContain('data-card="agency-sites"');
    expect(html).not.toContain('data-card="agency-bigquery"');
  });
});

describe("ikincil görünüm", () => {
  it("not ve Make primary çıkar; yönetmeyene düğme çıkmaz", async () => {
    const manager = await render(viewedSite(secondary), true);
    expect(manager).toContain('data-note="secondary-view"');
    expect(manager).toContain(
      "Secondary sites sync their Search Console numbers.",
    );
    expect(manager).toContain("Make primary");
    expect(manager).toContain("Health checks, opportunities, reports and alerts move");
    const member = await render(viewedSite(secondary), false);
    expect(member).toContain('data-note="secondary-view"');
    expect(member).not.toContain("Make primary");
  });

  it("müşteri raporları ikincil görünümde okunmaz", async () => {
    mocks.seoReportsActive.mockReturnValue(true);
    mocks.reportShareOn.mockReturnValue(true);
    const html = await render(viewedSite(secondary));
    expect(html).not.toContain('data-card="agency-client-reports"');
    expect(mocks.listReports).not.toHaveBeenCalled();
  });
});

describe("müşteri raporları", () => {
  beforeEach(() => {
    mocks.seoReportsActive.mockReturnValue(true);
    mocks.reportShareOn.mockReturnValue(true);
    mocks.listReports.mockResolvedValue([
      {
        id: "r1",
        kind: "WEEKLY",
        title: "Weekly",
        periodLabel: "Sep 28 - Oct 4",
        periodKey: "2026-W40",
        createdAt: "2026-10-05T00:00:00.000Z",
        isMock: false,
      },
    ]);
  });

  it("iki bayrak da açıkken kart çizilir ve doğru okumalar yapılır", async () => {
    const html = await render(viewedSite(primary));
    expect(html).toContain('data-card="agency-client-reports"');
    expect(mocks.listReports).toHaveBeenCalledWith("p1", {
      kinds: ["WEEKLY", "MONTHLY"],
      limit: 10,
    });
    expect(mocks.listShares).toHaveBeenCalledWith("p1", "SEARCH", ["r1"]);
    expect(mocks.getBranding).toHaveBeenCalledWith("w1");
  });

  it("yönetmeyen kullanıcı için paylaşımlar okunmaz", async () => {
    const html = await render(viewedSite(primary), false);
    expect(html).toContain('data-card="agency-client-reports"');
    expect(mocks.listShares).not.toHaveBeenCalled();
  });

  it("raporlar ya da paylaşım bayrağı kapalıysa kart yok", async () => {
    mocks.reportShareOn.mockReturnValue(false);
    expect(await render(viewedSite(primary))).not.toContain(
      'data-card="agency-client-reports"',
    );
    mocks.reportShareOn.mockReturnValue(true);
    mocks.seoReportsActive.mockReturnValue(false);
    expect(await render(viewedSite(primary))).not.toContain(
      'data-card="agency-client-reports"',
    );
  });

  it("rapor okuma hatası kartı düşürür ama bölümü değil", async () => {
    mocks.listReports.mockRejectedValue(new Error("db"));
    const html = await render(viewedSite(primary));
    expect(html).toContain('data-card="agency-sites"');
    expect(html).not.toContain('data-card="agency-client-reports"');
  });
});

describe("okuma hataları", () => {
  it("sayfa grubu okuma hatası bölümü düşürmez", async () => {
    mocks.readGroups.mockRejectedValue(new Error("db"));
    mocks.listGroups.mockRejectedValue(new Error("db"));
    mocks.listTests.mockRejectedValue(new Error("db"));
    const html = await render(viewedSite(primary));
    expect(html).toContain('data-card="agency-page-groups"');
    expect(html).toContain("No split tests yet.");
  });
});
