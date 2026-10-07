import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { SearchLinkInfo } from "@/server/seo/report";

// Bu dosyanın kanıtladığı: Connectors'taki Search Console ambar kartı kesin
// günü PT etiketiyle, geçmiş yüklenirken notu, arşiv metnini, yalnız
// yöneticilere arşiv ve "Delete stored data" düğmelerini, yalnız sayfa
// açıkken rapor bağlantısını ve marka terimleri formunu gösterir; bağ yokken
// bekleme metni çıkar. Saklama uyarısı silme hakkını söyler.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/server/actions/search-analytics-actions", () => ({
  refreshSearchAnalyticsAction: vi.fn(),
  saveBrandTermsAction: vi.fn(),
  setSearchArchiveAction: vi.fn(),
  deleteSearchDataAction: vi.fn(),
}));

const { SearchConsoleWarehouseCard, SEARCH_CONSOLE_RETENTION_NOTICE } =
  await import("./search-console-warehouse-card");

const INFO: SearchLinkInfo = {
  siteUrl: "sc-domain:example.com",
  siteLabel: "example.com",
  propertyType: "DOMAIN",
  permissionLevel: "siteOwner",
  domainMatch: true,
  health: "OK",
  healthReason: null,
  dataThrough: "2026-10-05",
  finalThrough: "2026-10-03",
  earliest: "2025-06-06",
  googleWindowStart: "2025-06-06",
  backfillDone: true,
  archive: true,
  brandTerms: ["acme"],
  brandSplit: "ready",
  isMock: false,
};

const render = (
  props: Partial<{
    info: SearchLinkInfo | null;
    searchHref: string | null;
    canManage: boolean;
  }> = {},
) =>
  renderToStaticMarkup(
    createElement(SearchConsoleWarehouseCard, {
      projectId: "proj-1",
      info: INFO,
      searchHref: null,
      canManage: false,
      ...props,
    }),
  );

describe("SearchConsoleWarehouseCard", () => {
  it("shows the final-data day with the Pacific Time label and the property type", () => {
    const html = render();
    expect(html).toContain("Final data through Oct 3");
    expect(html).toContain("Search Console days (Pacific Time)");
    expect(html).toContain("Domain property");
    expect(html).not.toContain("older history loading");
  });

  it("says older history is loading while backfilling", () => {
    const html = render({
      info: { ...INFO, backfillDone: false, propertyType: "URL_PREFIX" },
    });
    expect(html).toContain("Final data through Oct 3 · older history loading");
    expect(html).toContain("URL-prefix property");
  });

  it("describes the archive setting either way", () => {
    expect(render()).toContain(
      "Keeps history older than the 16 months Google keeps.",
    );
    expect(render({ info: { ...INFO, archive: false } })).toContain(
      "Keeps the last 16 months, like Google.",
    );
  });

  it("shows the archive and delete controls only to managers", () => {
    const member = render();
    expect(member).not.toContain("Keep only 16 months");
    expect(member).not.toContain("Delete stored data");

    const manager = render({ canManage: true });
    expect(manager).toContain("Keep only 16 months");
    expect(manager).toContain('name="archive" value="false"');
    // Arşivi kapatmak geri dönüşsüz siler: önce açıklama, düğme içeride.
    const confirm = manager.slice(manager.indexOf("data-archive-off-confirm"));
    expect(confirm).toContain(
      "Search Console data older than 16 months will be deleted now and can&#x27;t be loaded again.",
    );
    expect(confirm.indexOf("<summary")).toBeLessThan(
      confirm.indexOf('name="archive" value="false"'),
    );
    expect(confirm).toContain("Delete older data");
    expect(manager).toContain("Delete stored data");
    expect(manager).toContain(
      "This deletes the Search Console history Agentelse stored for this project",
    );
    const off = render({ canManage: true, info: { ...INFO, archive: false } });
    expect(off).toContain("Keep full history");
    expect(off).toContain('name="archive" value="true"');
  });

  it("mentions the measured SEO results in the delete text only with SEO_ACTIONS and the crawler on", () => {
    const keys = ["SEO_ACTIONS", "SEO_HEALTH", "SEO_CRAWL"] as const;
    const saved = keys.map((key) => process.env[key]);
    try {
      for (const key of keys) delete process.env[key];
      expect(render({ canManage: true })).not.toContain("Measured results of SEO changes");
      for (const key of keys) process.env[key] = "true";
      expect(render({ canManage: true })).toContain(
        "Measured results of SEO changes and what Agentelse learned from them are deleted too and don&#x27;t come back.",
      );
    } finally {
      keys.forEach((key, index) => {
        const value = saved[index];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }
  });

  it("links the Search report only when the page is on", () => {
    expect(render()).not.toContain("Open Search report");
    const html = render({ searchHref: "/projects/proj-1/arama" });
    expect(html).toContain("Open Search report");
    expect(html).toContain('href="/projects/proj-1/arama"');
  });

  it("carries the brand terms form, collapsed when the split is ready", () => {
    const html = render();
    expect(html).toContain("Brand terms");
    expect(html).toContain('name="terms"');
    expect(html).toContain("Save brand terms");
    expect(html).not.toMatch(/<details[^>]*open=""[^>]*data-brand-terms/);
    expect(
      render({ info: { ...INFO, brandSplit: "none", brandTerms: [] } }),
    ).toMatch(/<details[^>]*open=""[^>]*data-brand-terms="none"/);
  });

  it("says data is on its way without link info", () => {
    const html = render({ info: null, canManage: true });
    expect(html).toContain(
      "Search Console data is on its way. The first numbers usually arrive within a few minutes.",
    );
    expect(html).not.toContain("Delete stored data");
  });

  it("the retention notice says it can be deleted anytime", () => {
    expect(
      SEARCH_CONSOLE_RETENTION_NOTICE.endsWith("You can delete it anytime."),
    ).toBe(true);
  });
});
