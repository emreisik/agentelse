import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WEBSITE_REPORT_COPY } from "@/lib/website-analytics/reports/copy";
import {
  sampleMonthlyCard,
  samplePlanCard,
  sampleWeeklyCard,
} from "@/lib/website-analytics/reports/test-fixtures";
import type {
  WebsiteReportArchiveItem,
  WebsiteReportCardData,
} from "@/lib/website-analytics/reports/types";

// Bu dosyanın kanıtladığı: arşiv satırı Weekly / Monthly / Plan çipini, başlığı,
// dönemi ve "Open in chat" bağlantısını basar; boş arşiv boş durum metnini
// gösterir. Dışa aktarma düğmeleri istemci tarafı olduğundan taklit edilir.

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const { WebsiteReportArchive } = await import("./website-report-archive");

function item(
  variant: WebsiteReportArchiveItem["variant"],
  card: WebsiteReportCardData,
): WebsiteReportArchiveItem {
  return {
    commandId: `garep_${variant}_proj-1_x`,
    variant,
    title: card.title,
    periodLabel: card.periodLabel,
    builtAt: card.builtAt,
    chatHref: "/projects/proj-1?work=wkga_proj-1",
    card,
  };
}

const render = (items: WebsiteReportArchiveItem[]) =>
  renderToStaticMarkup(
    createElement(WebsiteReportArchive, { projectId: "proj-1", items }),
  );

describe("WebsiteReportArchive", () => {
  it("prints a chip, the title and the chat link per row", () => {
    const weekly = sampleWeeklyCard();
    const monthly = sampleMonthlyCard();
    const plan = samplePlanCard();
    const html = render([
      item("weekly", weekly),
      item("monthly", monthly),
      item("plan", plan),
    ]);
    expect(html).toContain('id="reports"');
    expect(html).toContain(">Reports<");
    expect(html).toContain(">Weekly<");
    expect(html).toContain(">Monthly<");
    expect(html).toContain(">Plan<");
    expect(html).toContain(weekly.periodLabel);
    expect(html).toContain(weekly.title.replace(/&/g, "&amp;"));
    expect(html).toContain("/projects/proj-1?work=wkga_proj-1");
    expect(html.match(/Open in chat/g)).toHaveLength(3);
  });

  it("offers the exports for each row", () => {
    const html = render([item("weekly", sampleWeeklyCard())]);
    expect(html).toContain("Copy");
    expect(html).toContain("Markdown");
    expect(html).toContain("Print / PDF");
  });

  it("shows the empty state", () => {
    const html = render([]);
    expect(html).toContain(
      WEBSITE_REPORT_COPY.archiveEmpty.replace(/'/g, "&#x27;"),
    );
    expect(html).not.toContain("Open in chat");
  });
});
