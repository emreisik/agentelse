import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { seoReportCard } from "@/lib/seo/reports/card";
import { sampleView } from "@/lib/seo/reports/test-support";
import type { SeoReportView } from "@/lib/seo/reports/types";

import type { SeoReportCardState } from "./seo-report-card";

// Bu dosyanın kanıtladığı (SC-F5 sohbet kartı): bekleme/yükleniyor iskeleti,
// silinmiş rapor ve hata metinleri, hazır durumda kompakt gövde + dışa aktarma
// + "Show full report"; "Sample data" etiketi yalnız örnek veride; "Open in
// Search" yalnız searchHref varken; ilk çizim yükleniyor iskeletidir.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/search-opportunity-actions", () => ({
  acceptOpportunityAction: vi.fn(),
  dismissOpportunityAction: vi.fn(),
}));
// SC-F7: yol haritasındaki canlı plan bloğu plan eylemlerini içe aktarır.
vi.mock("@/server/actions/seo-apply-actions", () => ({
  proposePublishArticleAction: vi.fn(),
  proposeMakeLiveAction: vi.fn(),
  decideSeoChangeAction: vi.fn(),
  undoSeoChangeAction: vi.fn(),
}));
vi.mock("@/server/actions/seo-content-plan-actions", () => ({
  planThisMonthAction: vi.fn(),
  refreshPlanAction: vi.fn(),
  replaceSlotAction: vi.fn(),
  skipSlotAction: vi.fn(),
  moveSlotAction: vi.fn(),
  savePlanSettingsAction: vi.fn(),
}));

const { SeoReportCard, SeoReportCardView } = await import("./seo-report-card");

const card = seoReportCard({
  reportId: "report_1",
  kind: "WEEKLY",
  periodLabel: "Sep 28 – Oct 4",
});

function view(state: SeoReportCardState): string {
  return renderToStaticMarkup(
    createElement(SeoReportCardView, { card, projectId: "project_1", state }),
  );
}

function ready(overrides: Partial<SeoReportView> = {}): string {
  return view({ state: "ready", view: sampleView("WEEKLY", overrides) });
}

describe("SeoReportCardView", () => {
  it("başlık ve dönem etiketini her durumda gösterir", () => {
    for (const state of [
      { state: "idle" },
      { state: "loading" },
      { state: "removed" },
      { state: "error" },
    ] as const) {
      const html = view(state);
      expect(html).toContain("Weekly SEO report");
      expect(html).toContain("Sep 28 – Oct 4");
    }
  });

  it("idle ve loading iskeleti gösterir", () => {
    expect(view({ state: "idle" })).toContain("Loading report…");
    expect(view({ state: "loading" })).toContain("Loading report…");
    expect(view({ state: "loading" })).toContain('aria-busy="true"');
  });

  it("silinmiş raporu açıklar", () => {
    const html = view({ state: "removed" });
    expect(html).toContain("This report is no longer stored.");
    expect(html).toContain("Search Console was disconnected");
  });

  it("hatayı gösterir", () => {
    expect(view({ state: "error" })).toContain("The report could not be loaded.");
  });

  it("hazır durumda kompakt gövde, dışa aktarma ve tam rapor düğmesi çizer", () => {
    const html = ready();
    expect(html).toContain("Non-brand clicks fell while positions slipped.");
    expect(html).toContain("Show full report");
    expect(html).toContain("Copy Markdown");
    expect(html).toContain("Download .md");
    expect(html).toContain("Print / PDF");
    expect((html.match(/data-kpi="/g) ?? []).length).toBe(3);
  });

  it("Sample data etiketi yalnız örnek veride çıkar", () => {
    expect(ready({ isMock: true })).toContain("Sample data");
    expect(ready({ isMock: false })).not.toContain("Sample data");
  });

  it("Open in Search yalnız searchHref varken çıkar", () => {
    const withLink = ready({ searchHref: "/projects/project_1/arama" });
    expect(withLink).toContain("Open in Search");
    expect(withLink).toContain('href="/projects/project_1/arama"');
    expect(ready({ searchHref: null })).not.toContain("Open in Search");
  });
});

describe("SeoReportCard", () => {
  it("ilk çizim yükleniyor iskeletidir (rapor henüz çekilmedi)", () => {
    const html = renderToStaticMarkup(
      createElement(SeoReportCard, {
        card,
        projectId: "project_1",
        commandId: "seoweekly_link_1_2026-09-28",
      }),
    );
    expect(html).toContain("Loading report…");
    expect(html).toContain('data-card-id="seoweekly_link_1_2026-09-28"');
    expect(html).not.toContain("Non-brand clicks");
  });
});
