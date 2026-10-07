import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SeoReportView } from "@/lib/seo/reports/types";

// Bu dosyanın kanıtladığı: SEARCH çizicisi SEO_REPORTS kapalıyken, PULSE için
// ve başka projenin raporu için null döner; okuyucuyu forShare: true ile
// çağırır; findingStatus / searchHref / chatHref / projectId boşaltılır, yani
// çıktıda Accept / Dismiss ve uygulama bağlantısı yoktur.

const mocks = vi.hoisted(() => ({
  readSeoReportView: vi.fn(),
  seoReportsOn: vi.fn(),
  register: vi.fn(),
}));

vi.mock("@/server/seo/reports/store", () => ({
  readSeoReportView: mocks.readSeoReportView,
}));
vi.mock("@/lib/seo/reports/flags", () => ({
  seoReportsOn: mocks.seoReportsOn,
}));
vi.mock("./renderers", () => ({ registerShareRenderer: mocks.register }));
// Gövde sınanmaz: aldığı görünümü işaretleyen ince bir çizici.
vi.mock("@/components/search-reports/seo-report-body", () => ({
  SeoReportBody: ({ view }: { view: SeoReportView }) =>
    createElement("div", {
      "data-report": view.id,
      "data-project": view.projectId,
      "data-finding": String(view.findingStatus),
      "data-search": String(view.searchHref),
      "data-chat": String(view.chatHref),
      "data-live": String(view.contentPlanLive),
    }),
}));

import type { ShareRenderer } from "./renderers";
import "./search-renderer";

function renderer(): ShareRenderer {
  const call = mocks.register.mock.calls[0];
  if (!call) throw new Error("renderer not registered");
  return call[1] as ShareRenderer;
}

const BRANDING = {
  displayName: "Acme",
  accent: "slate" as const,
  footer: null,
  logoAssetId: null,
};

function view(overrides: Partial<SeoReportView> = {}): SeoReportView {
  return {
    id: "rep1",
    projectId: "p1",
    kind: "WEEKLY",
    title: "Weekly report",
    periodKey: "W:2026-09-28",
    createdAt: "2026-10-05T00:00:00.000Z",
    language: "en",
    snapshot: {
      v: 1,
      kind: "WEEKLY",
      title: "Weekly report",
      periodKey: "W:2026-09-28",
      period: { from: "2026-09-28", to: "2026-10-04", label: "Sep 28 - Oct 4" },
      compare: null,
      yearAgo: null,
      site: { label: "example.com", isMock: false },
      finalThrough: "2026-10-04",
      brandSplit: false,
      anonymousShare: null,
      sections: [],
      notes: [],
    },
    narrative: null,
    narrativeNote: null,
    isMock: false,
    searchHref: "/projects/p1/arama?report=rep1#reports",
    chatHref: "/projects/p1?chat=1",
    findingStatus: { f1: "OPEN" },
    contentPlanLive: true,
    ...overrides,
  };
}

const SHARE = { projectId: "p1", reportId: "rep1", branding: BRANDING };

beforeEach(() => {
  mocks.readSeoReportView.mockReset();
  mocks.seoReportsOn.mockReturnValue(true);
});

describe("SEARCH share renderer", () => {
  it("registers the SEARCH kind", () => {
    expect(mocks.register.mock.calls[0]?.[0]).toBe("SEARCH");
  });

  it("returns null when SEO reports are off, without reading", async () => {
    mocks.seoReportsOn.mockReturnValue(false);
    expect(await renderer()(SHARE)).toBeNull();
    expect(mocks.readSeoReportView).not.toHaveBeenCalled();
  });

  it("returns null for a missing report, a PULSE report and another project's report", async () => {
    mocks.readSeoReportView.mockResolvedValueOnce(null);
    expect(await renderer()(SHARE)).toBeNull();
    mocks.readSeoReportView.mockResolvedValueOnce(view({ kind: "PULSE" }));
    expect(await renderer()(SHARE)).toBeNull();
    mocks.readSeoReportView.mockResolvedValueOnce(view({ projectId: "other" }));
    expect(await renderer()(SHARE)).toBeNull();
  });

  it("reads with forShare true and strips live and app-link fields", async () => {
    mocks.readSeoReportView.mockResolvedValue(view());
    const result = await renderer()(SHARE);
    expect(mocks.readSeoReportView).toHaveBeenCalledWith("p1", "rep1", {
      forShare: true,
    });
    expect(result?.title).toBe("Weekly report");
    expect(result?.periodLabel).toBe("Sep 28 - Oct 4");
    const element = result?.node as ReactElement<{ view: SeoReportView }>;
    expect(element.props.view).toMatchObject({
      projectId: "",
      findingStatus: null,
      searchHref: null,
      chatHref: null,
      contentPlanLive: false,
    });
    const html = renderToStaticMarkup(element);
    expect(html).toContain('data-finding="null"');
    expect(html).toContain('data-search="null"');
    expect(html).toContain('data-chat="null"');
    expect(html).toContain('data-project=""');
    expect(html).not.toMatch(/Accept|Dismiss/);
    expect(html).not.toContain("/projects/");
  });

  it("does not touch the caller's view object", async () => {
    const original = view();
    mocks.readSeoReportView.mockResolvedValue(original);
    await renderer()(SHARE);
    expect(original.findingStatus).toEqual({ f1: "OPEN" });
    expect(original.projectId).toBe("p1");
  });
});
