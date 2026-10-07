import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SeoApplyCounters } from "@/server/seo/apply/counters";

import { SeoApplyCountersCard } from "./apply-counters-card";

// Bu dosyanın kanıtladığı (/health "Website changes" kartı): yalnız sayılar ve
// sabit etiketler çizilir; bozuk site sayısı sağlıklıdan hesaplanır; tür ve hata
// kodu dökümü yalnız sıfırdan büyükse çıkar; proje adı, adres ya da içerik yok.

function counters(overrides: Partial<SeoApplyCounters> = {}): SeoApplyCounters {
  return {
    sites: 4,
    healthy: 3,
    pendingApprovals: 2,
    last30d: {
      proposed: 11,
      verified: 7,
      failed: 1,
      undone: 1,
      rejected: 2,
      expired: 0,
    },
    byKind30d: { TITLE_META: 6, PUBLISH_ARTICLE: 5, INTERNAL_LINKS: 0 },
    failedByCode: { page_changed: 1 },
    indexNow: { projects: 2, sent30d: 9, failed30d: 0 },
    linkedActions: 5,
    ...overrides,
  };
}

function html(model: SeoApplyCounters): string {
  return renderToStaticMarkup(
    createElement(SeoApplyCountersCard, { counters: model }),
  );
}

describe("SeoApplyCountersCard", () => {
  it("renders the numbers with fixed labels", () => {
    const markup = html(counters());
    for (const label of [
      "Website changes",
      "Connected sites",
      "Unhealthy sites",
      "Waiting for approval",
      "Proposed (30d)",
      "Done and checked (30d)",
      "Failed (30d)",
      "IndexNow sent (30d)",
      "Linked to actions",
    ]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain(">11<");
    expect(markup).toContain(">9<");
    expect(markup).toContain("Counters only. Customer data is never shown here.");
  });

  it("derives unhealthy sites and lists only non-zero breakdowns", () => {
    const markup = html(counters());
    expect(markup).toMatch(/Unhealthy sites<\/p><p class="[^"]*">1</);
    expect(markup).toContain("TITLE_META 6");
    expect(markup).toContain("PUBLISH_ARTICLE 5");
    expect(markup).not.toContain("INTERNAL_LINKS 0");
    expect(markup).toContain("page_changed 1");
  });

  it("omits the breakdowns when there is nothing to show", () => {
    const markup = html(counters({ byKind30d: {}, failedByCode: {} }));
    expect(markup).not.toContain("By kind (30d)");
    expect(markup).not.toContain("Failed by reason (30d)");
  });

  it("shows no links, addresses or free text", () => {
    const markup = html(counters());
    expect(markup).not.toContain("href=");
    // SVG ad alanı dışında adres yok.
    expect(markup).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });
});
