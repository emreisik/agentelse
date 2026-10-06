import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  SEO_REPORT_COPY,
  TABLE_TITLE,
} from "@/lib/seo/reports/text";
import { sampleSnapshot, sampleView } from "@/lib/seo/reports/test-support";
import type {
  SeoReportKind,
  SeoReportSection,
  SeoReportView,
} from "@/lib/seo/reports/types";

// Bu dosyanın kanıtladığı (SC-F5 rapor gövdesi): her bölüm türü kendi
// başlığıyla çizilir; teşhis iki Search Console ekranını ve "−30%" değişimini
// gösterir; anlatı yokken not görünür; sorgudaki "<script>" kaçırılır;
// kompakt kipte en çok 3 KPI kutusu vardır; Accept/Dismiss yalnız CANLI durumu
// OPEN olan bulguda çıkar.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/search-opportunity-actions", () => ({
  acceptOpportunityAction: vi.fn(),
  dismissOpportunityAction: vi.fn(),
}));

const { SeoReportBody } = await import("./seo-report-body");

function render(view: SeoReportView, compact = false): string {
  return renderToStaticMarkup(createElement(SeoReportBody, { view, compact }));
}

describe("SeoReportBody bölümleri", () => {
  it("haftalık raporda her bölüm başlığı çizilir", () => {
    const html = render(sampleView("WEEKLY"));
    for (const title of Object.values(TABLE_TITLE)) {
      expect(html).toContain(title);
    }
    expect(html).toContain(SEO_REPORT_COPY.healthHeading);
    expect(html).toContain(SEO_REPORT_COPY.opportunitiesHeading);
    expect(html).toContain(SEO_REPORT_COPY.actionsHeading);
    expect(html).toContain(SEO_REPORT_COPY.updatesHeading);
    expect(html).toContain(SEO_REPORT_COPY.diagnosisHeading);
    expect(html).toContain("Non-brand clicks");
    expect(html).toContain("~91% (88–94%)");
  });

  it("aylık raporda hedef, tahmin ve içerik bölümleri çizilir", () => {
    const html = render(sampleView("MONTHLY"));
    expect(html).toContain(SEO_REPORT_COPY.goalsHeading);
    expect(html).toContain("Target 1,200 · Now 840");
    expect(html).toContain("At risk");
    expect(html).toContain(SEO_REPORT_COPY.forecastHeading);
    expect(html).toContain("About");
    expect(html).toContain("3,600");
    expect(html).toContain("October 2026");
    expect(html).toContain("(3,060–4,140)");
    expect(html).toContain("Directional");
    expect(html).toContain("Planned SEO articles");
    expect(html).toContain("How to choose trail shoes");
  });

  it("yol haritasında numaralı adımlar ve teknik liste çizilir", () => {
    const html = render(sampleView("ROADMAP"));
    expect(html).toContain(SEO_REPORT_COPY.roadmapActionsHeading);
    expect(html).toContain(SEO_REPORT_COPY.roadmapDebtHeading);
    expect(html).toContain("<ol");
    expect(html).toContain("Fix the robots.txt block on /shop");
    expect(html).toContain("Pages without a title");
    expect(html).toContain("7 affected");
  });

  it("nabızda değişimi orandan çevirir", () => {
    const html = render(sampleView("PULSE"));
    expect(html).toContain(SEO_REPORT_COPY.pulseHeading);
    expect(html).toContain("+50%");
  });

  it("notlar altbilgisini çizer", () => {
    const view = sampleView("WEEKLY");
    const html = render(view);
    for (const note of view.snapshot.notes) {
      expect(html).toContain(note.replace(/'/g, "&#x27;"));
    }
  });

  it.each<SeoReportKind>(["PULSE", "WEEKLY", "MONTHLY", "ROADMAP"])(
    "%s örnek görünümü hatasız çizilir",
    (kind) => {
      expect(render(sampleView(kind)).length).toBeGreaterThan(50);
    },
  );
});

describe("SeoReportBody teşhis", () => {
  it("iki Search Console ekranını ve −30% değişimini gösterir", () => {
    const html = render(sampleView("WEEKLY"));
    expect(html).toContain(SEO_REPORT_COPY.checkInSearchConsole);
    expect(html).toContain("Manual actions");
    expect(html).toContain("Security issues");
    expect(html).toContain("−30%");
    // sekiz adımın hepsi
    expect((html.match(/data-step="/g) ?? []).length).toBe(8);
    expect(html).toContain('data-verdict="yes"');
    expect(html).toContain("Most likely cause");
  });
});

describe("SeoReportBody anlatı", () => {
  it("anlatı varken başlığı ve satırları gösterir", () => {
    const html = render(sampleView("WEEKLY"));
    expect(html).toContain("Non-brand clicks fell while positions slipped.");
    expect(html).toContain(SEO_REPORT_COPY.highlights);
    expect(html).toContain(SEO_REPORT_COPY.nextSteps);
  });

  it("anlatı yokken nedenini gösterir", () => {
    const html = render(
      sampleView("WEEKLY", {
        narrative: null,
        narrativeNote: "AI summary isn't available with sample data.",
      }),
    );
    expect(html).toContain("AI summary isn&#x27;t available with sample data.");
    expect(html).not.toContain(SEO_REPORT_COPY.highlights);
  });
});

describe("SeoReportBody güvenlik", () => {
  it("sorgudaki <script> kaçırılır", () => {
    const snapshot = sampleSnapshot("WEEKLY");
    const sections: SeoReportSection[] = snapshot.sections.map((section) =>
      section.type === "table" && section.table.key === "winning_queries"
        ? {
            type: "table",
            table: {
              ...section.table,
              rows: [
                {
                  ...section.table.rows[0]!,
                  label: "<script>alert(1)</script>",
                },
              ],
            },
          }
        : section,
    );
    const html = render(sampleView("WEEKLY", { snapshot: { ...snapshot, sections } }));
    // React'in form yeniden oynatma betiği ayrı bir <script> koyar; kaçırılan
    // sorgu metni ise düz metin olarak kalır.
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("javascript: adresli bağlantı çizmez", () => {
    const snapshot = sampleSnapshot("WEEKLY");
    const sections: SeoReportSection[] = snapshot.sections.map((section) =>
      section.type === "updates"
        ? {
            type: "updates",
            items: [{ ...section.items[0]!, url: "javascript:alert(1)" }],
          }
        : section,
    );
    const html = render(sampleView("WEEKLY", { snapshot: { ...snapshot, sections } }));
    expect(html).not.toMatch(/<a [^>]*href="javascript:/);
  });
});

describe("SeoReportBody kompakt kip", () => {
  it("en çok 3 KPI kutusu, başlık ve ana satırlar gösterir", () => {
    const html = render(sampleView("WEEKLY"), true);
    expect((html.match(/data-kpi="/g) ?? []).length).toBe(3);
    expect(html).toContain("Non-brand clicks fell while positions slipped.");
    expect(html).not.toContain(SEO_REPORT_COPY.diagnosisHeading);
    expect(html).not.toContain(TABLE_TITLE.winning_queries);
  });

  it("tam kipte tüm KPI kutuları çizilir", () => {
    const html = render(sampleView("WEEKLY"), false);
    expect((html.match(/data-kpi="/g) ?? []).length).toBe(6);
  });

  it("anlatısız yol haritasında ilk adımlar ana satır olur", () => {
    const html = render(sampleView("ROADMAP"), true);
    expect(html).toContain("Improve the title of the trail shoes page");
    expect(html).not.toContain(SEO_REPORT_COPY.roadmapDebtHeading);
  });
});

describe("SeoReportBody Accept / Dismiss", () => {
  it("canlı durumu OPEN olan fırsatta iki düğme çıkar", () => {
    const html = render(
      sampleView("WEEKLY", { findingStatus: { finding_1: "OPEN" } }),
    );
    expect(html).toContain(">Accept<");
    expect(html).toContain(">Dismiss<");
    expect(html).toContain('name="findingId" value="finding_1"');
    expect(html).toContain('name="projectId" value="project_1"');
    expect(html).not.toContain('value="finding_2"');
  });

  it("ACCEPTED bulguda düğme çıkmaz, durum etiketi görünür", () => {
    const html = render(
      sampleView("WEEKLY", {
        findingStatus: { finding_1: "ACCEPTED", finding_2: "ACCEPTED" },
      }),
    );
    expect(html).not.toContain(">Accept<");
    expect(html).not.toContain(">Dismiss<");
    expect(html).toContain("Accepted");
  });

  it("findingStatus null ise düğme çıkmaz", () => {
    const html = render(sampleView("WEEKLY", { findingStatus: null }));
    expect(html).not.toContain(">Accept<");
  });

  it("yol haritasında yalnız fırsat satırı karar düğmesi taşır", () => {
    const html = render(
      sampleView("ROADMAP", { findingStatus: { finding_1: "OPEN" } }),
    );
    expect((html.match(/>Accept</g) ?? []).length).toBe(1);
  });
});
